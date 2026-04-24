/**
 * 受信請求書の自動処理サービス
 *
 * 処理フロー:
 *  1. IMAP で keiri@misokoji.com のメールボックスから PDF 添付メールを取得
 *  2. 未処理のメールのみ対象（Google Sheets の処理済みシートで管理）
 *  3. PDF テキストを抽出して請求書データをパース
 *  4. 支払い管理スプレッドシートに行を追記
 *  5. PDF を Google Drive の「支払い月フォルダ」にアップロード
 *  6. 処理済みとしてスプレッドシートに記録
 */

import { fileURLToPath } from "node:url";
import { ImapFlow } from "imapflow";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import { google } from "googleapis";
import { DateTime } from "luxon";
import iconv from "iconv-lite";
import { loadOAuthClient } from "./calendar_service.js";
import { appendInvoiceRow } from "./sheets_service.js";
import { config } from "./config.js";

const TZ = "Asia/Tokyo";

// ── Drive ────────────────────────────────────────────────────────────

function getDrive() {
  return google.drive({ version: "v3", auth: loadOAuthClient() });
}

// ── 処理済みメールの管理（Google Sheets で永続化） ──────────────────
// Cloud Run はコンテナ再起動のたびにメモリがリセットされるため
// SQLite ではなく Google Sheets のシートに記録して再処理を防ぐ。

const PROCESSED_SHEET = "処理済み請求書";

function getSheetsClient() {
  return google.sheets({ version: "v4", auth: loadOAuthClient() });
}

let _processedUids = null; // セッション内キャッシュ

async function loadProcessedUids(spreadsheetId) {
  if (_processedUids) return _processedUids;
  const sheets = getSheetsClient();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${PROCESSED_SHEET}!A:A`,
    });
    _processedUids = new Set((res.data.values ?? []).flat().map(String));
  } catch {
    // シートが存在しない場合は空セットで続行（シートは初回書き込み時に作成）
    _processedUids = new Set();
  }
  return _processedUids;
}

async function isProcessed(uid, spreadsheetId) {
  const uids = await loadProcessedUids(spreadsheetId);
  return uids.has(String(uid));
}

async function markProcessed(uid, invoiceData, spreadsheetId) {
  const sheets = getSheetsClient();
  const now = DateTime.now().setZone(TZ).toISO();
  // 処理済みシートが存在しなければ作成
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${PROCESSED_SHEET}!A:E`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          String(uid),
          invoiceData.vendorName ?? "",
          String(invoiceData.amount ?? ""),
          invoiceData.dueDate ?? "",
          now,
        ]],
      },
    });
  } catch (e) {
    if (String(e.message).includes("Unable to parse range")) {
      // シートが存在しない → 作成してリトライ
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [{ addSheet: { properties: { title: PROCESSED_SHEET, hidden: true } } }],
        },
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${PROCESSED_SHEET}!A:E`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [["uid", "vendor", "amount", "dueDate", "processedAt"]],
        },
      });
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${PROCESSED_SHEET}!A:E`,
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: {
          values: [[
            String(uid),
            invoiceData.vendorName ?? "",
            String(invoiceData.amount ?? ""),
            invoiceData.dueDate ?? "",
            now,
          ]],
        },
      });
    } else {
      throw e;
    }
  }
  // キャッシュを更新
  if (_processedUids) _processedUids.add(String(uid));
}

// ── IMAP 接続設定 ────────────────────────────────────────────────────

function createImapClient() {
  const host = config.imapHost;
  const port = config.imapPort;
  const user = config.imapUser;
  const pass = config.imapPass;

  if (!host || !user || !pass) {
    throw new Error("IMAP_HOST / IMAP_USER / IMAP_PASS が設定されていません");
  }

  return new ImapFlow({
    host,
    port: Number(port) || 993,
    secure: true,          // SSL/TLS（ポート993）
    auth: { user, pass },
    logger: false,         // imapflow の詳細ログを抑制
    tls: {
      rejectUnauthorized: false,  // 自己署名証明書を許可（xserverなど）
    },
  });
}

// ── IMAP からメールを取得 ─────────────────────────────────────────────

/**
 * INBOX から PDF 添付のある未処理メールを取得する
 * @returns {Promise<Array<{ uid: string, from: string, subject: string, emailText: string, attachments: Array<{buffer: Buffer, filename: string}> }>>}
 */
async function fetchUnprocessedInvoiceEmails(sheetId) {
  const client = createImapClient();
  const results = [];

  try {
    await client.connect();
    console.log("[invoice] IMAP 接続成功");

    await client.mailboxOpen("INBOX");

    // 過去 30 日以内の未読/既読問わず全メールを対象
    const since = DateTime.now().setZone(TZ).minus({ days: 30 }).toJSDate();
    const uids = await client.search({ since }, { uid: true });
    console.log(`[invoice] IMAP 検索結果: ${uids.length} 件`);

    for (const uid of uids) {
      const uidStr = String(uid);
      if (await isProcessed(uidStr, sheetId ?? config.paymentSheetId)) continue;

      try {
        const msg = await client.fetchOne(String(uid), {
          uid: true,
          envelope: true,
          bodyStructure: true,
          source: true,
        }, { uid: true });

        if (!msg) continue;

        // メール全体のソースから From / Subject を取得
        const rawSource = msg.source?.toString("utf8") ?? "";
        const fromMatch = rawSource.match(/^From:\s*(.+)/im);
        const subjectMatch = rawSource.match(/^Subject:\s*(.+)/im);
        const from = decodeMimeWord(fromMatch?.[1]?.trim() ?? "");
        const subject = decodeMimeWord(subjectMatch?.[1]?.trim() ?? "");

        // PDF 添付を抽出
        const attachments = extractPdfPartsFromStructure(msg.bodyStructure);
        if (attachments.length === 0) {
          // PDF 添付なし → スキップ（記録しない）
          continue;
        }

        // 各 PDF のバイナリを取得
        const pdfBuffers = [];
        for (const att of attachments) {
          const section = att.part ? `${att.part}` : "1";
          try {
            const partData = await client.fetchOne(String(uid), {
              bodyParts: [section],
            }, { uid: true });
            const raw = partData?.bodyParts?.get(section);
            if (raw) {
              const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
              // PDF は通常 base64 エンコードされている
              const decoded = att.encoding === "base64"
                ? Buffer.from(buf.toString(), "base64")
                : buf;
              pdfBuffers.push({
                buffer: decoded,
                filename: att.filename || "invoice.pdf",
              });
            }
          } catch (e) {
            console.warn(`[invoice] パート取得失敗 uid=${uid} part=${section}:`, e.message);
          }
        }

        if (pdfBuffers.length === 0) continue;

        // プレーンテキストボディを取得（あれば）
        const textPart = findTextPart(msg.bodyStructure);
        let emailText = "";
        if (textPart) {
          try {
            const textData = await client.fetchOne(String(uid), {
              bodyParts: [textPart.part || "1"],
            }, { uid: true });
            const raw = textData?.bodyParts?.get(textPart.part || "1");
            if (raw) {
              emailText = raw.toString("utf8");
            }
          } catch {
            // テキスト取得失敗は無視
          }
        }

        results.push({
          uid: uidStr,
          from,
          subject,
          emailText,
          attachments: pdfBuffers,
        });
      } catch (e) {
        console.warn(`[invoice] メール取得エラー uid=${uid}:`, e.message);
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  console.log(`[invoice] 未処理の PDF 添付メール: ${results.length} 件`);
  return results;
}

// ── bodyStructure から PDF パーツを再帰探索 ──────────────────────────

function extractPdfPartsFromStructure(part, parentPart = "") {
  if (!part) return [];
  const results = [];
  const currentPart = parentPart || part.part || "1";

  const mime = `${part.type ?? ""}/${part.subtype ?? ""}`.toLowerCase();
  const filename = part.dispositionParameters?.filename
    ?? part.parameters?.name
    ?? "";

  if (mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
    results.push({
      part: currentPart,
      filename,
      encoding: (part.encoding ?? "").toLowerCase(),
    });
  }

  for (const child of part.childNodes ?? []) {
    results.push(...extractPdfPartsFromStructure(child, child.part));
  }
  return results;
}

function findTextPart(part, parentPart = "") {
  if (!part) return null;
  const currentPart = parentPart || part.part || "1";
  const mime = `${part.type ?? ""}/${part.subtype ?? ""}`.toLowerCase();

  if (mime === "text/plain") return { part: currentPart };

  for (const child of part.childNodes ?? []) {
    const found = findTextPart(child, child.part);
    if (found) return found;
  }
  return null;
}

// ── MIME エンコード文字列のデコード（=?UTF-8?B?...?= / =?iso-2022-jp?B?...?=） ──

function decodeMimeWord(raw) {
  if (!raw) return "";
  return raw.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, charset, encoding, encoded) => {
    try {
      const enc = encoding.toUpperCase();
      if (enc === "B") {
        const buf = Buffer.from(encoded, "base64");
        // iconv-lite で正確にデコード（UTF-8 / ISO-2022-JP / Shift_JIS など）
        if (iconv.encodingExists(charset)) return iconv.decode(buf, charset);
        return buf.toString("utf8");
      }
      if (enc === "Q") {
        const bytes = Buffer.from(
          encoded.replace(/_/g, " ")
            .replace(/=([0-9A-Fa-f]{2})/g, (__, hex) => String.fromCharCode(parseInt(hex, 16))),
          "binary",
        );
        if (iconv.encodingExists(charset)) return iconv.decode(bytes, charset);
        return bytes.toString("utf8");
      }
    } catch {
      // ignore
    }
    return raw;
  });
}

// ── PDF テキスト抽出（pdfjs-dist） ───────────────────────────────────

async function extractTextFromPdf(buffer) {
  try {
    const data = new Uint8Array(buffer);
    const loadingTask = pdfjsLib.getDocument({ data });
    const doc = await loadingTask.promise;
    const pageTexts = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ");
      pageTexts.push(pageText);
    }
    return pageTexts.join("\n");
  } catch (e) {
    console.warn("[invoice] PDF テキスト抽出失敗:", e.message);
    return "";
  }
}

// ── 請求書データのパース ─────────────────────────────────────────────

function parseInvoiceData(pdfText, emailText, senderRaw, subject) {
  const text = `${pdfText}\n${emailText}`;

  return {
    dueDate:            extractDueDate(text),
    amount:             extractAmount(text),
    vendorName:         extractVendorName(text, senderRaw),
    bankName:           extractBankName(text),
    branchName:         extractBranchName(text),
    accountType:        extractAccountType(text),
    accountNumber:      extractAccountNumber(text),
    accountHolder:      extractAccountHolder(text),
    invoiceNumber:      extractInvoiceNumber(text),
    summary:            extractSummary(text) || subject.substring(0, 100),
    notes:              "",
    registrationNumber: extractRegistrationNumber(text),
    driveLink:          "",
  };
}

// ── 各フィールドの抽出 ────────────────────────────────────────────────

function extractDueDate(text) {
  const DUE_LABEL = "(?:お?支払[いい]?期[限日]|振込期[限日]|お振込[みみ]?期[限日])";
  // pdfjs は「2026 年 04 月 30 日」のように年月日の前後にスペースを入れることがある
  const DATE_WITH_SPACE = "(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月\\s*(\\d{1,2})\\s*日?";
  const DATE_SLASH     = "(\\d{4})[\\s\\/\\-](\\d{1,2})[\\s\\/\\-](\\d{1,2})";
  const DATE_COMPACT   = "(20\\d{2})(\\d{2})(\\d{2})";

  const patterns = [
    new RegExp(`${DUE_LABEL}[^\\d]*${DATE_WITH_SPACE}`),
    new RegExp(`${DUE_LABEL}[^\\d]*${DATE_SLASH}`),
    new RegExp(`${DUE_LABEL}[^\\d]*${DATE_COMPACT}`),
    /(?:due\s*date|payment\s*due)[^\d]*(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const y = m[1].padStart(4, "0");
      const mo = m[2].padStart(2, "0");
      const d = m[3].padStart(2, "0");
      return `${y}-${mo}-${d}`;
    }
  }
  return "";
}

function extractAmount(text) {
  const patterns = [
    // 「ご請求金額」「合計金額」「お支払い金額」の直後の金額（金額を明示的に要求）
    /(?:ご?請求金額|合計金額|税込合計|お支払[いい]?金額)[^\d¥￥]*[¥￥]?\s*([\d,，]+)\s*円?/,
    // ¥ 50,000 - や ¥50,000円 のような通貨記号付き（末尾に - または 円）
    /[¥￥]\s*([\d,，]{3,})\s*(?:円|[-－])/,
    // 念のためフォールバック（金額ラベルゆるめ）
    /(?:ご?請求|合計)[^\d¥￥]{0,10}[¥￥]?\s*([\d,，]+)\s*円/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) {
      const n = parseInt(m[1].replace(/[,，]/g, ""), 10);
      // 8桁以上はYYYYMMDD日付の誤認識として除外
      if (!isNaN(n) && n > 0 && String(n).length <= 7) return n;
    }
  }
  return "";
}

function extractVendorName(text, senderRaw) {
  // "山田太郎 <info@example.com>" → "山田太郎"
  if (senderRaw) {
    const m = senderRaw.match(/^"?([^"<]+)"?\s*</);
    if (m) return m[1].trim();
    if (!senderRaw.includes("@")) return senderRaw.trim();
  }
  const patterns = [
    /(?:請求元|発行者|会社名|商号)[：:]\s*(.+)/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1].trim().split(/[\r\n]/)[0];
  }
  return senderRaw ?? "";
}

function extractBankName(text) {
  // 全角英数（ＵＦＪ等 U+FF00-FF60）も含めた1文字クラス
  const BC = "[\\u3000-\\u9FFF\\u30A0-\\u30FF\\uFF00-\\uFF60a-zA-Z0-9]";
  const BANK_SUFFIX = "(?:銀行|信用金庫|信用組合|農協|労働金庫)";
  // コンテキストラベルの直後を優先して探す
  const contextPat = new RegExp(
    `(?:振込先|金融機関名?|お振込先|銀行名)[：:\\s　]*(${BC}+${BANK_SUFFIX})`,
    "u",
  );
  // フォールバック：スペース・記号・行頭の直後、かつ12文字以内のプレフィックスのみ許容
  const fallbackPat = new RegExp(
    `(?:^|[\\s　（(「【])(${BC}{1,12}${BANK_SUFFIX})`,
    "mu",
  );
  const cm = text.match(contextPat);
  if (cm) return cm[1].trim().replace(/[\s　]+/g, "");
  const fm = text.match(fallbackPat);
  return fm ? fm[1].trim().replace(/[\s　]+/g, "") : "";
}

function extractBranchName(text) {
  const m = text.match(/([^\s\n　]{1,20})\s*支店/);
  return m ? m[1].trim() + "支店" : "";
}

function extractAccountType(text) {
  if (/当座/.test(text)) return "当座";
  if (/貯蓄/.test(text)) return "貯蓄";
  if (/普通/.test(text)) return "普通";
  return "";
}

function extractAccountNumber(text) {
  const patterns = [
    /口座番号[：:\s]*(\d{5,8})/,
    /(?:普通|当座|貯蓄)\s*(\d{5,8})/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1];
  }
  return "";
}

function extractAccountHolder(text) {
  const patterns = [
    /口座名義(?:人)?[（(]?(?:カナ)?[）)]?[：:]\s*(.+)/,
    /預金者名?[：:]\s*(.+)/,
    /名義(?:人)?[：:]\s*(.+)/,
    // MISOCA 形式: 口座番号の後ろにカタカナ名義（例: 4388810 モリカワ タカノリ）
    /\d{5,8}\s+([\u30A0-\u30FF　\s]{2,30})/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1].trim().split(/[\r\n]/)[0].replace(/\s+/g, " ").trim();
  }
  return "";
}

function extractInvoiceNumber(text) {
  const patterns = [
    /請求書番号[：:\s]*([A-Za-z0-9\-_]+)/,
    /請求No[．.：:\s]*([A-Za-z0-9\-_]+)/,
    /Invoice\s*No[.：:\s]*([A-Za-z0-9\-_]+)/i,
    /No[.：:\s]+([A-Za-z0-9\-_]{3,})/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1].trim();
  }
  return "";
}

function extractSummary(text) {
  const patterns = [
    // コロン前後にスペースが入るケース（pdfjs: "件名 ： 2026年3月業務委託費"）も対応
    /(?:件名|摘要|ご利用内容|サービス内容)\s*[：:]\s*([^\n\r]{1,60})/,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (!m) continue;
    // 「。」「2スペース以上」「下記」「ご請求申し」などで終端して件名部分だけ残す
    const raw = m[1]
      .split(/。|[ 　]{2,}|下記(?:の)|ご請求申し/)[0]
      .replace(/\s+/g, " ")
      .trim();
    if (raw && raw.length >= 2) return raw.substring(0, 40);
  }
  return "";
}

function extractRegistrationNumber(text) {
  const m = text.match(/T[-－](\d{13})/);
  if (m) return `T-${m[1]}`;
  const m2 = text.match(/登録番号[：:\s]*([T][-－]?\d{13})/);
  if (m2) return m2[1].replace("－", "-");
  return "";
}

function normalizeDate(str) {
  if (!str) return "";
  const ja = str.match(/(\d{4})年(\d{1,2})月(\d{1,2})日?/);
  if (ja) return `${ja[1]}-${ja[2].padStart(2, "0")}-${ja[3].padStart(2, "0")}`;
  const sl = str.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (sl) return `${sl[1]}-${sl[2].padStart(2, "0")}-${sl[3].padStart(2, "0")}`;
  // pdfjs が年月日の漢字を除去して YYYYMMDD になるケース
  const compact = str.match(/^(20\d{2})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return str;
}

// ── Drive：支払い月フォルダを作成してアップロード ─────────────────────

async function uploadToDrivePaymentFolder(rootFolderId, filename, buffer, paymentDate) {
  const drive = getDrive();
  const now = DateTime.now().setZone(TZ);
  let year = now.year;
  let month = now.month;
  if (paymentDate) {
    const dt = DateTime.fromISO(paymentDate, { zone: TZ });
    if (dt.isValid) { year = dt.year; month = dt.month; }
  }

  const folderName = `${year}年${month}月支払`;
  const folderId = await findOrCreatePaymentFolder(drive, rootFolderId, folderName);

  const { Readable } = await import("node:stream");
  const res = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: "application/pdf", body: Readable.from(buffer) },
    fields: "id,webViewLink",
    supportsAllDrives: true,
  });

  console.log(`[invoice] Drive アップロード完了: ${filename} → ${res.data.webViewLink}`);
  return res.data.webViewLink ?? "";
}

async function findOrCreatePaymentFolder(drive, rootFolderId, folderName) {
  const res = await drive.files.list({
    q: `'${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
    fields: "files(id,name)",
    spaces: "drive",
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (res.data.files?.length > 0) {
    console.log(`[invoice] Drive フォルダ既存: ${folderName}`);
    return res.data.files[0].id;
  }
  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [rootFolderId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  console.log(`[invoice] Drive フォルダ作成: ${folderName}`);
  return created.data.id;
}

// ── メイン処理 ───────────────────────────────────────────────────────

/**
 * 未処理の受信請求書を一括処理する
 * @returns {Promise<{ processed: number, skipped: number, errors: number }>}
 */
export async function processIncomingInvoices() {
  const sheetId = config.paymentSheetId;
  const driveFolderId = config.keiriDriveFolderId;

  if (!sheetId) throw new Error("PAYMENT_SHEET_ID が設定されていません");
  if (!driveFolderId) throw new Error("KEIRI_DRIVE_FOLDER_ID が設定されていません");

  // 処理済みUIDを先読み（Google Sheetsから永続ロード）
  await loadProcessedUids(sheetId);
  const messages = await fetchUnprocessedInvoiceEmails(sheetId);

  let processed = 0, skipped = 0, errors = 0;

  for (const { uid, from, subject, emailText, attachments } of messages) {
    console.log(`[invoice] 処理中: uid=${uid} from=${from}`);
    try {
      let lastInvoiceData = {};

      for (const { buffer, filename } of attachments) {
        console.log(`[invoice] PDF 処理: ${filename}`);

        const pdfText = await extractTextFromPdf(buffer);
        console.log(`[invoice] PDF テキスト長: ${pdfText.length} 文字`);

        const invoiceData = parseInvoiceData(pdfText, emailText, from, subject);
        console.log("[invoice] パース結果:", JSON.stringify({
          dueDate: invoiceData.dueDate,
          amount: invoiceData.amount,
          vendor: invoiceData.vendorName,
          bank: invoiceData.bankName,
          regNo: invoiceData.registrationNumber,
        }));

        const safeFilename = filename.replace(/[/\\:*?"<>|]/g, "_") || "invoice.pdf";
        const driveLink = await uploadToDrivePaymentFolder(
          driveFolderId,
          safeFilename,
          buffer,
          invoiceData.dueDate
        );
        invoiceData.driveLink = driveLink;

        await appendInvoiceRow(sheetId, invoiceData);
        lastInvoiceData = invoiceData;
      }

      await markProcessed(uid, lastInvoiceData, sheetId);
      processed++;
    } catch (e) {
      console.error(`[invoice] エラー uid=${uid}:`, e.message);
      errors++;
    }
  }

  console.log(`[invoice] 完了: 処理済=${processed}, スキップ=${skipped}, エラー=${errors}`);
  return { processed, skipped, errors };
}
