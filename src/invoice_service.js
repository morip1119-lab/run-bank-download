import { DateTime } from "luxon";
import { Storage } from "@google-cloud/storage";
import { config } from "./config.js";
import { misocaRequest, misocaDownloadPdf, resolveAccountKey, listAvailableAccounts } from "./misoca_client.js";
import { saveToDrive } from "./drive_service.js";

const GCS_BUCKET = "line-secretary-invoices";
const storage = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT || "chirashi-493513" });

async function uploadPdfToGcs(pdfBuffer, invoiceId, invoiceNumber) {
  const filename = `invoices/${invoiceNumber || invoiceId}.pdf`;
  const file = storage.bucket(GCS_BUCKET).file(filename);
  await file.save(pdfBuffer, { contentType: "application/pdf" });
  return `https://storage.googleapis.com/${GCS_BUCKET}/${filename}`;
}

const TZ = () => config.timeZone || "Asia/Tokyo";

// ── 支払期日パース ─────────────────────────────────────────────

function parsePaymentDue(text) {
  const t = text
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, " ");

  const now = DateTime.now().setZone(TZ());

  // 「月末」
  const monthEnd = t.match(/(\d{1,2})\s*月\s*末/);
  if (monthEnd) {
    let m = Number(monthEnd[1]);
    let y = now.year;
    if (m < now.month || (m === now.month && now.day > 20)) {
      y += m < now.month ? 1 : 0;
    }
    const d = DateTime.fromObject({ year: y, month: m, day: 1 }, { zone: TZ() }).endOf("month");
    return d.toFormat("yyyy/MM/dd");
  }

  // 「M月D日」
  const md = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (md) {
    let y = now.year;
    const m = Number(md[1]);
    const d = Number(md[2]);
    const dt = DateTime.fromObject({ year: y, month: m, day: d }, { zone: TZ() });
    if (dt < now) y += 1;
    return DateTime.fromObject({ year: y, month: m, day: d }, { zone: TZ() }).toFormat("yyyy/MM/dd");
  }

  return null;
}

// ── 品目パース ─────────────────────────────────────────────────
// 形式: 「品名 / 数量+単位 / 金額」 または 「品名 / 単価 / 数量」

function parseItem(text) {
  const parts = text.split(/\s*[\/／]\s*/);
  const clean = (s) =>
    s
      .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
      .replace(/[,，\s]/g, "")
      .replace(/円$/, "")
      .trim();

  if (parts.length === 1) {
    return { name: parts[0].trim(), quantity: 1, unit_price: 0, unit_name: "式", tax_type: "STANDARD_TAX_10" };
  }

  if (parts.length === 2) {
    const price = Number(clean(parts[1]));
    return { name: parts[0].trim(), quantity: 1, unit_price: isNaN(price) ? 0 : price, unit_name: "式", tax_type: "STANDARD_TAX_10" };
  }

  // 3 parts: 品名 / 数量(+単位) / 単価
  const name = parts[0].trim();
  const qStr = clean(parts[1]);
  const pStr = clean(parts[2]);

  // 数量文字列から数値と単位を分離
  const qMatch = qStr.match(/^(\d+(?:\.\d+)?)(.*)/);
  const quantity = qMatch ? Number(qMatch[1]) : 1;
  const unit_name = qMatch?.[2]?.trim() || "式";
  const unit_price = Number(pStr) || 0;

  return { name, quantity, unit_name, unit_price, tax_type: "STANDARD_TAX_10" };
}

// ── 取引先(送り先)を名前で検索 ────────────────────────────────

function searchContact(contacts, recipientName) {
  if (!Array.isArray(contacts) || !contacts.length) return null;

  const normalize = (s) => (s || "").replace(/\s|　/g, "").toLowerCase();
  const query = normalize(recipientName);
  const nameOf = (c) => [c.name, c.recipient_name].filter(Boolean).map(normalize);
  const matches = (c, fn) => nameOf(c).some(fn);

  const exact = contacts.find((c) => matches(c, (n) => n === query));
  if (exact) return exact;
  return contacts.find((c) => matches(c, (n) => n.includes(query) || query.includes(n))) ?? null;
}

// ── メイン: 請求書作成 ─────────────────────────────────────────

/**
 * @param {{ account?: string, contact: string, subject: string, items: string[], paymentDue: string }} p
 * @returns {{ ok: true, message: string } | { ok: false, message: string }}
 */
export async function createInvoice({ account, contact, subject, items, paymentDue }) {
  // アカウント解決
  const accountKey = resolveAccountKey(account);
  if (account && !accountKey) {
    const available = listAvailableAccounts();
    return {
      ok: false,
      message: [
        `「${account}」は登録されていないアカウント名です。`,
        `使用可能: ${available.length ? available.join(" / ") : "（未設定）"}`,
        `正しいアカウント名: BURIZUMU / みそこうじ / Trynnox`,
      ].join("\n"),
    };
  }

  // 取引先検索（contacts を1回取得して使い回す）
  const allContacts = await misocaRequest("GET", "/contacts", null, accountKey);
  console.log(`[invoice] contacts count=${Array.isArray(allContacts) ? allContacts.length : "N/A"} (account=${accountKey})`);
  let contactRecord = searchContact(allContacts, contact);
  if (!contactRecord) {
    // 見つからなければ Misoca に新規登録
    console.log(`[invoice] contact "${contact}" not found → creating new contact`);
    try {
      contactRecord = await misocaRequest("POST", "/contact", { recipient_name: contact }, accountKey);
      console.log(`[invoice] created contact id=${contactRecord?.id} name=${contact}`);
    } catch (e) {
      return {
        ok: false,
        message: `取引先「${contact}」の新規登録に失敗しました: ${e.message}`,
      };
    }
  }

  // 支払期日パース
  const paymentDueOn = parsePaymentDue(paymentDue || "");
  const issueDate = DateTime.now().setZone(TZ()).toFormat("yyyy/MM/dd");

  // 品目
  const parsedItems = items.map(parseItem);

  // 請求書作成
  const invoice = await misocaRequest("POST", "/invoice", {
    issue_date: issueDate,
    subject: subject || "",
    payment_due_on: paymentDueOn || undefined,
    contact_id: contactRecord.id,
    items: parsedItems,
  }, accountKey);

  const invoiceId = invoice?.id;
  const invoiceNumber = invoice?.invoice_number;
  const misocaUrl = invoiceId ? `https://app.misoca.jp/invoices/${invoiceId}` : "";

  const totalLine = invoice?.body?.total_amount_including_tax != null
    ? `合計: ${Math.round(invoice.body.total_amount_including_tax).toLocaleString("ja-JP")}円（税込）`
    : "";

  // PDF を GCS にアップロードして公開 URL を取得 + Drive に保存
  let pdfUrl = "";
  let driveUrl = "";
  if (invoiceId) {
    try {
      const pdfBuffer = await misocaDownloadPdf(invoiceId, accountKey);
      pdfUrl = await uploadPdfToGcs(pdfBuffer, invoiceId, invoiceNumber);
      console.log(`[invoice] PDF uploaded to GCS: ${pdfUrl}`);

      // 支払期日の年月で Drive に格納（例: paymentDueOn = "2026/04/30" → 2026年4月）
      const dueDate = paymentDueOn
        ? DateTime.fromFormat(paymentDueOn, "yyyy/MM/dd", { zone: TZ() })
        : DateTime.now().setZone(TZ());
      const driveYear  = dueDate.year;
      const driveMonth = dueDate.month;
      const filename   = `${invoiceNumber || invoiceId}.pdf`;

      driveUrl = await saveToDrive({
        companyKey: accountKey,
        year:       driveYear,
        month:      driveMonth,
        filename,
        buffer:     pdfBuffer,
        mimeType:   "application/pdf",
      });
      console.log(`[invoice] PDF saved to Drive: ${driveUrl}`);
    } catch (e) {
      console.warn(`[invoice] PDF upload failed: ${e.message}`);
    }
  }

  return {
    ok: true,
    message: [
      "請求書を Misoca に作成しました。",
      accountKey ? `アカウント: ${account}` : "",
      `宛先: ${contactRecord.recipient_name || contactRecord.name}`,
      `件名: ${subject}`,
      paymentDueOn ? `支払期日: ${paymentDueOn}` : "",
      totalLine,
      pdfUrl ? `📄 PDF: ${pdfUrl}` : "",
      misocaUrl ? `Misoca で編集: ${misocaUrl}` : "",
    ].filter(Boolean).join("\n"),
  };
}
