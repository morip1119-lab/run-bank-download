import { google } from "googleapis";
import { DateTime } from "luxon";
import { loadOAuthClient } from "./calendar_service.js";
import { config } from "./config.js";
import { parseBankCsv } from "./payment_service.js";

const BANK_FROM    = "post_master@netbk.co.jp";
const TARGET_AMOUNTS = [12800, 50000];
const TZ = "Asia/Tokyo";

function getGmail() {
  return google.gmail({ version: "v1", auth: loadOAuthClient() });
}

// ── メール本文（text/plain）を取り出す ───────────────────────

function extractPlainText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  for (const part of payload.parts ?? []) {
    const text = extractPlainText(part);
    if (text) return text;
  }
  return "";
}

// ── 入金メールをパースして { amount, depositDate, senderName } を返す ──

function parseDepositEmail(message) {
  const body = extractPlainText(message.payload);
  if (!body) return null;

  // 入金金額：12,800円 / 入金金額：50,000円 など
  const amountMatch = body.match(/入金金額[：:]\s*[¥￥]?([\d,]+)\s*円/);
  if (!amountMatch) return null;
  const amount = parseInt(amountMatch[1].replace(/,/g, ""), 10);

  // 入金日時：2026/04/20 10:30 など
  const dateMatch = body.match(/入金日時[：:]\s*(\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}(?:\s*\d{2}:\d{2})?)/);
  const depositDate = dateMatch ? dateMatch[1].trim() : "不明";

  // 振込名義（人 or カナ）：ヤマダタロウ
  const nameMatch = body.match(/振込名義(?:人)?[（(]?(?:カナ)?[）)]?[：:]\s*(.+)/);
  const senderName = nameMatch ? nameMatch[1].trim().split(/[\r\n]/)[0] : "不明";

  return { amount, depositDate, senderName };
}

// ── 昨日の入金メールを検索して対象金額のみ返す（Gmail） ─────

async function checkYesterdayBankDepositsFromGmail() {
  const gmail = getGmail();
  const yesterday = DateTime.now().setZone(TZ).minus({ days: 1 });

  // Gmail の after:/before: はエポック秒（日付単位で検索）
  const afterEpoch  = Math.floor(yesterday.startOf("day").toSeconds());
  const beforeEpoch = Math.floor(yesterday.endOf("day").toSeconds());

  const query = `from:${BANK_FROM} after:${afterEpoch} before:${beforeEpoch}`;
  console.log("[bank] Gmail query:", query);

  const listRes = await gmail.users.messages.list({ userId: "me", q: query });
  const msgList = listRes.data.messages ?? [];
  console.log(`[bank] found ${msgList.length} bank email(s)`);

  const deposits = [];
  for (const { id } of msgList) {
    const msgRes = await gmail.users.messages.get({ userId: "me", id, format: "full" });
    const dep = parseDepositEmail(msgRes.data);
    if (!dep) continue;
    console.log(`[bank] parsed: ¥${dep.amount} / ${dep.depositDate} / ${dep.senderName}`);
    if (TARGET_AMOUNTS.includes(dep.amount)) {
      deposits.push(dep);
    }
  }

  return deposits;
}

// ── 昨日の MF CSV から対象入金を返す（Playwright 必須） ────────

async function checkYesterdayBankDepositsFromMf() {
  const yesterday = DateTime.now().setZone(TZ).minus({ days: 1 });
  const ymd = yesterday.toISODate();
  console.log(`[bank] MF CSV 取得: ${ymd}（グループ: ${config.bankCheckMfGroup || "（未指定）"})`);

  const { fetchMoneyForwardCsv, fetchMoneyForwardCsvByAccount } = await import(
    "./moneyforward_scraper.js"
  );

  let csvText;
  if (config.bankCheckMfGroup) {
    const byAccount = await fetchMoneyForwardCsvByAccount({
      from: ymd,
      to: ymd,
      headless: true,
      accountGroupMap: { _bank: config.bankCheckMfGroup },
    });
    csvText = byAccount._bank;
  } else {
    csvText = await fetchMoneyForwardCsv({ from: ymd, to: ymd, headless: true });
  }

  if (!csvText || !String(csvText).trim()) {
    console.warn("[bank] MF: CSV が空、または取得失敗");
    return [];
  }

  const rows = parseBankCsv(csvText);
  const deposits = [];
  for (const t of rows) {
    if (t.date !== ymd) continue;
    if (!TARGET_AMOUNTS.includes(t.amount)) continue;
    console.log(
      `[bank] MF row: ¥${t.amount} / ${t.date} / 内容: ${(t.description || "").slice(0, 80)}`
    );
    deposits.push({
      amount: t.amount,
      depositDate: t.date,
      senderName: t.description?.trim() || "（内容のみ・不明）",
    });
  }
  return deposits;
}

/**
 * 昨日の入金（指定金額のみ）を返す
 * `BANK_CHECK_SOURCE=gmail`（既定）: 住信SBIの通知メール
 * `BANK_CHECK_SOURCE=mf`: マネーフォワード ME（CSV スクレイプ）
 */
export async function checkYesterdayBankDeposits() {
  const src = config.bankCheckSource;
  if (src === "mf" || src === "moneyforward" || src === "me") {
    return checkYesterdayBankDepositsFromMf();
  }
  return checkYesterdayBankDepositsFromGmail();
}

// ── Chatwork 通達メッセージを生成 ───────────────────────────

export function buildDepositMessage(deposits) {
  const src = config.bankCheckSource;
  const fromLabel =
    src === "mf" || src === "moneyforward" || src === "me"
      ? "マネーフォワード ME"
      : "住信SBIネット銀行";
  const lines = ["[toall]", `💰 入金通知（${fromLabel}）`, ""];
  for (const dep of deposits) {
    lines.push(
      `【¥${dep.amount.toLocaleString("ja-JP")}】`,
      `入金日時: ${dep.depositDate}`,
      `振込名義: ${dep.senderName}`,
      ""
    );
  }
  return lines.join("\n").trim();
}
