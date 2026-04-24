import { google } from "googleapis";
import { loadOAuthClient } from "./calendar_service.js";

// 支払い管理スプレッドシートのデフォルト列順（ヘッダー行がない場合のフォールバック）
const DEFAULT_COLUMNS = [
  "振込予定日",
  "金額",
  "請求元",
  "金融機関名",
  "支店名",
  "口座種類",
  "口座番号",
  "口座名義",
  "請求番号",
  "摘要",
  "備考",
  "登録番号",
  "ファイルリンク",
];

function getSheets() {
  return google.sheets({ version: "v4", auth: loadOAuthClient() });
}

/**
 * スプレッドシートの最初のシート名を取得する
 */
async function getFirstSheetName(spreadsheetId) {
  const sheets = getSheets();
  try {
    const res = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: "sheets.properties.title",
    });
    return res.data.sheets?.[0]?.properties?.title ?? "Sheet1";
  } catch {
    return "Sheet1";
  }
}

/**
 * スプレッドシートのヘッダー行を取得する
 * 先頭10行をスキャンして、期待列名（振込予定日・金額・請求元）を含む行を探す
 */
async function getHeaders(spreadsheetId, sheetName) {
  const sheets = getSheets();
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!1:10`,
    });
    const rows = res.data.values ?? [];
    const REQUIRED = ["振込予定日", "金額", "請求元"];
    for (const row of rows) {
      const cells = row.map((h) => String(h).trim());
      if (REQUIRED.every((k) => cells.includes(k))) {
        return cells;
      }
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * 支払い管理スプレッドシートに請求書データを1行追記する
 *
 * @param {string} spreadsheetId
 * @param {{
 *   dueDate: string,          // 振込予定日 (YYYY-MM-DD)
 *   amount: string|number,    // 金額
 *   vendorName: string,       // 請求元
 *   bankName: string,         // 金融機関名
 *   branchName: string,       // 支店名
 *   accountType: string,      // 口座種類
 *   accountNumber: string,    // 口座番号
 *   accountHolder: string,    // 口座名義
 *   invoiceNumber: string,    // 請求番号
 *   summary: string,          // 摘要
 *   notes: string,            // 備考
 *   registrationNumber: string, // 登録番号（インボイス番号）
 *   driveLink: string,        // ファイルリンク
 * }} invoiceData
 * @param {string} [sheetName]
 */
export async function appendInvoiceRow(spreadsheetId, invoiceData, sheetName) {
  const sheets = getSheets();
  // シート名が未指定の場合は最初のシートを自動検出
  const resolvedSheetName = sheetName ?? await getFirstSheetName(spreadsheetId);
  const headers = await getHeaders(spreadsheetId, resolvedSheetName);

  const dataMap = {
    "振込予定日":   invoiceData.dueDate        ?? "",
    "金額":         invoiceData.amount         ?? "",
    "請求元":       invoiceData.vendorName      ?? "",
    "金融機関名":   invoiceData.bankName        ?? "",
    "支店名":       invoiceData.branchName      ?? "",
    "口座種類":     invoiceData.accountType     ?? "",
    "口座番号":     invoiceData.accountNumber   ?? "",
    "口座名義":     invoiceData.accountHolder   ?? "",
    "請求番号":     invoiceData.invoiceNumber   ?? "",
    "摘要":         invoiceData.summary         ?? "",
    "備考":         invoiceData.notes           ?? "",
    "登録番号":     invoiceData.registrationNumber ?? "",
    "ファイルリンク": invoiceData.driveLink     ?? "",
  };

  const effectiveHeaders = headers.length > 0 ? headers : DEFAULT_COLUMNS;
  const row = effectiveHeaders.map((h) => dataMap[h] ?? "");

  // シート全体の最終行番号を取得して、その次の行に直接書き込む
  // values.append の自動検出は空白行があるシートで意図しない行に書いてしまうため
  const allValues = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${resolvedSheetName}!A:N`,
  });
  const lastRow = (allValues.data.values ?? []).length;
  const nextRow = lastRow + 1;

  const updateRes = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${resolvedSheetName}!A${nextRow}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [row] },
  });

  const updatedRange = updateRes.data.updatedRange ?? "不明";
  const updatedCells = updateRes.data.updatedCells ?? 0;
  console.log(`[sheets] 追記完了 (${resolvedSheetName}) ${nextRow}行目 → 実際: ${updatedRange} / ${updatedCells}セル: ${invoiceData.vendorName} / ${invoiceData.dueDate} / ¥${invoiceData.amount}`);
}
