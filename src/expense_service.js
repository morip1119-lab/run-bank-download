/**
 * 個人支出管理サービス
 *
 * - MoneyForward ME の CSV をパースして SQLite に取り込む
 * - カテゴリ別の集計・予算チェック
 * - LINE への報告メッセージ生成
 *
 * MF CSV の列（Shift-JIS で配信される）:
 *   計算対象, 日付, 内容, 金額（円）, 保有金融機関, 大項目, 中項目, メモ, 振替, ID
 */

import { DateTime } from "luxon";
import { fetchMoneyForwardCsv } from "./moneyforward_scraper.js";
import {
  upsertExpense,
  getExpenseTotalsByCategory,
  getExpensesByMonth,
  getAllBudgets,
  getBudget,
  setBudget,
  getTotalExpense,
} from "./db.js";
import { config } from "./config.js";

const TZ = "Asia/Tokyo";

// ── MF CSV パース ─────────────────────────────────────────────────

/**
 * MoneyForward の CSV 文字列をパースして支出レコード配列を返す
 * 振替（振替=1）と収入（金額 > 0）はスキップ
 */
export function parseMoneyForwardCsv(csvText) {
  const lines = csvText.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];

  // ヘッダー行を特定（「日付」が含まれる最初の行）
  let headerIdx = lines.findIndex((l) => /日付/.test(l));
  if (headerIdx === -1) headerIdx = 0;

  const headers = parseCsvLine(lines[headerIdx]).map((h) => h.trim());
  const colIdx = (names) => {
    for (const n of names) {
      const i = headers.findIndex((h) => h.includes(n));
      if (i !== -1) return i;
    }
    return -1;
  };

  const idxCalc     = colIdx(["計算対象"]);
  const idxDate     = colIdx(["日付"]);
  const idxContent  = colIdx(["内容"]);
  const idxAmount   = colIdx(["金額"]);
  const idxMajor    = colIdx(["大項目"]);
  const idxMinor    = colIdx(["中項目"]);
  const idxMemo     = colIdx(["メモ"]);
  const idxTransfer = colIdx(["振替"]);
  const idxId       = colIdx(["ID"]);

  const records = [];

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (cols.length < 4) continue;

    const transfer = idxTransfer >= 0 ? cols[idxTransfer]?.trim() : "0";
    if (transfer === "1") continue;

    const calcTarget = idxCalc >= 0 ? cols[idxCalc]?.trim() : "1";
    if (calcTarget === "0") continue;

    const rawAmount = cols[idxAmount]?.trim().replace(/,/g, "").replace(/[^\d\-]/g, "");
    const amount = parseInt(rawAmount, 10);
    if (isNaN(amount) || amount >= 0) continue;

    const rawDate = cols[idxDate]?.trim().replace(/\//g, "-");
    if (!rawDate || !/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) continue;

    records.push({
      expenseDate: rawDate,
      description: cols[idxContent]?.trim() || "不明",
      amount: Math.abs(amount),
      category: cols[idxMajor]?.trim() || "未分類",
      subCategory: cols[idxMinor]?.trim() || null,
      memo: cols[idxMemo]?.trim() || null,
      mfId: cols[idxId]?.trim() || null,
    });
  }

  return records;
}

function parseCsvLine(line) {
  const cols = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuote = !inQuote;
      }
    } else if (ch === "," && !inQuote) {
      cols.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols;
}

// ── MF 同期 ───────────────────────────────────────────────────────

/**
 * MoneyForward ME から当月+先月の支出を取得して SQLite に保存する
 * @returns {{ imported: number, skipped: number, error: string|null }}
 */
export async function syncMoneyForwardExpenses({ headless = true } = {}) {
  const now = DateTime.now().setZone(TZ);
  const from = now.minus({ months: 1 }).startOf("month").toISODate();
  const to = now.toISODate();

  let csvText;
  try {
    csvText = await fetchMoneyForwardCsv({ from, to, headless });
  } catch (e) {
    return { imported: 0, skipped: 0, error: e.message };
  }

  if (!csvText) {
    return { imported: 0, skipped: 0, error: "CSVが取得できませんでした" };
  }

  const records = parseMoneyForwardCsv(csvText);
  let imported = 0;
  let skipped = 0;

  for (const rec of records) {
    try {
      upsertExpense({ ...rec, source: "moneyforward" });
      imported++;
    } catch {
      skipped++;
    }
  }

  return { imported, skipped, error: null };
}

// ── 予算チェック ──────────────────────────────────────────────────

/**
 * 今月の各カテゴリ支出が予算に対して何%かを返す
 * @returns {Array<{ category, spent, budget, ratio, over }>}
 */
export function checkBudgetStatus(year, month) {
  const totals = getExpenseTotalsByCategory(year, month);
  const budgets = getAllBudgets();
  const budgetMap = Object.fromEntries(budgets.map((b) => [b.category, b.monthly_limit]));

  const results = [];

  for (const t of totals) {
    const budget = budgetMap[t.category];
    if (budget) {
      const ratio = Math.round((t.total / budget) * 100);
      results.push({
        category: t.category,
        spent: t.total,
        budget,
        ratio,
        over: t.total > budget,
      });
    }
  }

  return results.sort((a, b) => b.ratio - a.ratio);
}

/**
 * 予算超過・警告（80%以上）のカテゴリを返す
 */
export function getAlertCategories(year, month) {
  const status = checkBudgetStatus(year, month);
  return status.filter((s) => s.ratio >= 80);
}

// ── メッセージ生成 ────────────────────────────────────────────────

/**
 * 今月の支出サマリーメッセージを生成する
 */
export function buildMonthlySummaryMessage(year, month) {
  const totals = getExpenseTotalsByCategory(year, month);
  const budgets = getAllBudgets();
  const budgetMap = Object.fromEntries(budgets.map((b) => [b.category, b.monthly_limit]));
  const grandTotal = getTotalExpense(year, month);

  if (totals.length === 0) {
    return `📊 ${year}年${month}月の支出データはまだありません。\n\n「MF同期」でMoneyForwardからデータを取り込めます。`;
  }

  const lines = [`📊 ${year}年${month}月の支出サマリー`, ""];

  for (const t of totals) {
    const budget = budgetMap[t.category];
    if (budget) {
      const ratio = Math.round((t.total / budget) * 100);
      const bar = buildRatioBar(ratio);
      const status = ratio >= 100 ? "🔴" : ratio >= 80 ? "🟡" : "🟢";
      lines.push(`${status} ${t.category}`);
      lines.push(`   ${formatYen(t.total)} / ${formatYen(budget)} (${ratio}%)`);
      lines.push(`   ${bar}`);
    } else {
      lines.push(`⚪ ${t.category}`);
      lines.push(`   ${formatYen(t.total)}`);
    }
  }

  lines.push("");
  lines.push(`💰 合計支出: ${formatYen(grandTotal)}`);

  const budgetTotal = budgets.reduce((sum, b) => sum + b.monthly_limit, 0);
  if (budgetTotal > 0) {
    const overallRatio = Math.round((grandTotal / budgetTotal) * 100);
    lines.push(`📅 予算合計: ${formatYen(budgetTotal)} (${overallRatio}%消化)`);
  }

  return lines.join("\n");
}

/**
 * 予算アラートメッセージを生成する（80%以上のカテゴリのみ）
 */
export function buildAlertMessage(year, month) {
  const alerts = getAlertCategories(year, month);
  if (alerts.length === 0) return null;

  const lines = [`⚠️ ${year}年${month}月 予算アラート`, ""];
  for (const a of alerts) {
    const icon = a.over ? "🔴 超過！" : "🟡 注意";
    lines.push(`${icon} ${a.category}: ${formatYen(a.spent)} / ${formatYen(a.budget)} (${a.ratio}%)`);
  }
  lines.push("");
  lines.push("「支出確認」で詳細を確認できます。");
  return lines.join("\n");
}

/**
 * 予算設定一覧メッセージ
 */
export function buildBudgetListMessage() {
  const budgets = getAllBudgets();
  if (budgets.length === 0) {
    return "予算が設定されていません。\n\n設定方法:\n予算設定\n食費 30000\n交通費 15000";
  }
  const now = DateTime.now().setZone(TZ);
  const totals = getExpenseTotalsByCategory(now.year, now.month);
  const totalMap = Object.fromEntries(totals.map((t) => [t.category, t.total]));
  const budgetTotal = budgets.reduce((sum, b) => sum + b.monthly_limit, 0);

  const lines = ["💰 月間予算設定", ""];
  for (const b of budgets) {
    const spent = totalMap[b.category] ?? 0;
    const ratio = Math.round((spent / b.monthly_limit) * 100);
    const bar = buildRatioBar(ratio);
    const status = ratio >= 100 ? "🔴" : ratio >= 80 ? "🟡" : "🟢";
    lines.push(`${status} ${b.category}: ${formatYen(b.monthly_limit)}/月`);
    lines.push(`   今月: ${formatYen(spent)} (${ratio}%)`);
    lines.push(`   ${bar}`);
  }
  lines.push("");
  lines.push(`合計予算: ${formatYen(budgetTotal)}/月`);
  return lines.join("\n");
}

/**
 * 手動入力した支出の確認メッセージ
 */
export function buildExpenseAddedMessage({ description, amount, category }) {
  const now = DateTime.now().setZone(TZ);
  const budget = getBudget(category);
  const spent = getTotalExpense(now.year, now.month);

  const lines = [
    `✅ 支出を記録しました`,
    `内容: ${description}`,
    `金額: ${formatYen(amount)}`,
    `カテゴリ: ${category}`,
    "",
    `今月の合計支出: ${formatYen(spent)}`,
  ];

  if (budget) {
    const catSpent = getExpenseTotalsByCategory(now.year, now.month)
      .find((t) => t.category === category)?.total ?? amount;
    const ratio = Math.round((catSpent / budget.monthly_limit) * 100);
    lines.push(`${category}予算: ${formatYen(catSpent)} / ${formatYen(budget.monthly_limit)} (${ratio}%)`);
    if (ratio >= 100) {
      lines.push(`🔴 ${category}の予算を超過しています！`);
    } else if (ratio >= 80) {
      lines.push(`🟡 ${category}の予算が残り ${formatYen(budget.monthly_limit - catSpent)} です`);
    }
  }

  return lines.join("\n");
}

// ── ユーティリティ ────────────────────────────────────────────────

function formatYen(amount) {
  return `¥${Number(amount).toLocaleString("ja-JP")}`;
}

function buildRatioBar(ratio) {
  const filled = Math.min(10, Math.round(ratio / 10));
  return "█".repeat(filled) + "░".repeat(10 - filled) + ` ${ratio}%`;
}
