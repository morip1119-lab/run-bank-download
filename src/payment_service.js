import { misocaRequest } from "./misoca_client.js";
import { DateTime } from "luxon";

const TZ = "Asia/Tokyo";
export const PAYMENT_ACCOUNTS = ["BURIZUMU", "TRYNNOX"];

// ── 請求書一覧取得 ────────────────────────────────────────────────

/**
 * 指定アカウントから Misoca の請求書を全件取得して正規化して返す
 * @param {string[]} accounts
 * @returns {Promise<object[]>}
 */
export async function fetchAllInvoices(accounts = PAYMENT_ACCOUNTS) {
  const results = [];

  for (const accountKey of accounts) {
    let page = 1;
    try {
      while (true) {
        const data = await misocaRequest(
          "GET",
          `/invoices?per_page=100&page=${page}`,
          null,
          accountKey
        );
        if (!Array.isArray(data) || data.length === 0) break;
        for (const inv of data) {
          results.push(normalizeInvoice(inv, accountKey));
        }
        if (data.length < 100) break;
        page++;
      }
    } catch (e) {
      console.error(`[payment] fetch error ${accountKey}:`, e.message);
      // エラーでも他アカウントの取得は続ける
    }
  }

  return results;
}

/**
 * Misoca の請求書オブジェクトをダッシュボード用に正規化
 */
function normalizeInvoice(inv, accountKey) {
  const today = DateTime.now().setZone(TZ).toISODate();
  const dueDate = inv.payment_due_on || null;

  // Misoca v3:
  //   payment_status: 0=未入金, 1=入金済み  ← 入金判定はこちら
  //   invoice_status: 0=未送付, 1=送付済み  ← 請求書送付状態（入金とは別）
  const isPaid = inv.payment_status === 1 || inv.payment_status === "1";

  let paymentStatus;
  if (isPaid) {
    paymentStatus = "paid";
  } else if (!dueDate) {
    paymentStatus = "unpaid";
  } else if (dueDate < today) {
    paymentStatus = "overdue";
  } else if (dueDate === today) {
    paymentStatus = "due_today";
  } else {
    paymentStatus = "unpaid";
  }

  const amount = Math.round(
    Number(inv.billing_amount ?? inv.body?.total_amount_including_tax ?? 0)
  );

  const recipient =
    inv.contacts?.[0]?.recipient_name ||
    inv.contacts?.[0]?.name ||
    inv.recipient_name ||
    "（不明）";

  return {
    id: String(inv.id),
    invoiceNumber: inv.invoice_number || "",
    account: accountKey,
    recipientName: recipient,
    subject: inv.title || inv.subject || "",
    issueDate: inv.issue_date || null,
    dueDate,
    paidOn: inv.paid_on || null,
    amount,
    misocaPaymentStatus: inv.payment_status,
    paymentStatus,
    misocaUrl: `https://app.misoca.jp/invoices/${inv.id}`,
  };
}

// ── 入金済みに更新 ────────────────────────────────────────────────

/**
 * Misoca 上の請求書ステータスを入金済みに更新する
 * @param {string} invoiceId
 * @param {string} accountKey  "BURIZUMU" | "TRYNNOX" など
 */
export async function markInvoicePaid(invoiceId, accountKey, paidOn) {
  // Misoca API v3: PUT /invoice/{id}/paid
  // paid_on は省略可（省略時は支払期日が自動セット）
  const body = paidOn ? { paid_on: paidOn } : {};
  return await misocaRequest("PUT", `/invoice/${invoiceId}/paid`, body, accountKey);
}

// ── 銀行CSV パース ────────────────────────────────────────────────

/**
 * マネーフォワード ME / 楽天銀行の CSV を解析して入金リストを返す
 *
 * MF ME 形式A（旧）:
 *   計算対象,日付,内容,金額（支出）,金額（収入）,残高,メモ,未分類,口座名義
 *
 * MF ME 形式B（新）:
 *   計算対象,日付,内容,金額（円）,保有金融機関,大項目,中項目,メモ,振替,ID
 *   ※ 金額（円）はプラス=入金、マイナス=出金
 *
 * 楽天銀行形式:
 *   取引日,入出金(円),残高(円),メモ,メモ２
 *
 * @param {string} csvText
 * @returns {{ date: string, amount: number, description: string }[]}
 */
export function parseBankCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(",").map((h) => h.replace(/"/g, "").trim());
  const transactions = [];

  // MF ME 検出: 「計算対象」か「保有金融機関」を持つ
  const isMfNew = headers.some((h) => h.includes("保有金融機関") || h.includes("計算対象"))
    && headers.some((h) => h.includes("金額（円）"));
  // MF ME 旧形式: 収入・支出が別カラム
  const isMfOld = headers.some((h) => h.includes("金額（収入）"));
  const isRakuten = headers.some((h) => h.includes("入出金"));

  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]);
    if (!cols.length) continue;

    let date = null,
      amount = 0,
      description = "";

    if (isMfNew) {
      const idxDate   = findColIdx(headers, ["日付"]);
      const idxDesc   = findColIdx(headers, ["内容"]);
      const idxAmount = findColIdx(headers, ["金額（円）", "金額"]);
      date        = parseDate(cols[idxDate]);
      description = cols[idxDesc]?.replace(/"/g, "").trim() || "";
      amount      = parseAmount(cols[idxAmount]); // プラスのみ入金として扱う
    } else if (isMfOld) {
      const idxDate   = findColIdx(headers, ["日付"]);
      const idxDesc   = findColIdx(headers, ["内容"]);
      const idxIncome = findColIdx(headers, ["金額（収入）", "収入"]);
      date        = parseDate(cols[idxDate]);
      description = cols[idxDesc]?.replace(/"/g, "").trim() || "";
      amount      = parseAmount(cols[idxIncome]);
    } else if (isRakuten) {
      date        = parseDate(cols[0]);
      amount      = parseAmount(cols[1]);
      description = cols[3]?.replace(/"/g, "").trim() || "";
    } else {
      date        = parseDate(cols[0]);
      amount      = parseAmount(cols[1]);
      description = cols[2]?.replace(/"/g, "").trim() || "";
    }

    if (amount > 0 && date) {
      transactions.push({ date, amount, description });
    }
  }

  return transactions;
}

// ── CSV照合 ───────────────────────────────────────────────────────

/**
 * 未払い請求書と銀行取引履歴を金額ベースで照合する
 * @returns {{ invoice: object, matches: object[] }[]}
 */
export function matchInvoicesWithTransactions(invoices, transactions) {
  const unpaid = invoices.filter(
    (inv) =>
      inv.paymentStatus === "unpaid" ||
      inv.paymentStatus === "overdue" ||
      inv.paymentStatus === "due_today"
  );

  return unpaid.map((inv) => {
    const matches = transactions.filter((t) => {
      if (t.amount !== inv.amount) return false;
      // 請求書発行日以降の取引のみ照合
      if (inv.issueDate && t.date && t.date < inv.issueDate) return false;
      return true;
    });
    return { ...inv, csvMatches: matches };
  });
}

// ── 内部ヘルパー ──────────────────────────────────────────────────

function findColIdx(headers, candidates) {
  for (const c of candidates) {
    const i = headers.findIndex((h) => h.includes(c));
    if (i >= 0) return i;
  }
  return -1;
}

function parseAmount(str) {
  if (!str) return 0;
  const n = Number(str.replace(/"/g, "").replace(/[,，\s]/g, "").trim());
  return isNaN(n) || n < 0 ? 0 : Math.round(n);
}

function parseDate(str) {
  if (!str) return null;
  const s = str.replace(/"/g, "").trim().replace(/\//g, "-");
  const m = s.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}

function splitCsvLine(line) {
  const result = [];
  let cur = "",
    inQuote = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuote = !inQuote;
    } else if (ch === "," && !inQuote) {
      result.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}
