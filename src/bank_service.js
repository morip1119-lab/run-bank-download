import { google } from "googleapis";
import { DateTime } from "luxon";
import { loadOAuthClient } from "./calendar_service.js";

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

// ── 昨日の入金メールを検索して対象金額のみ返す ──────────────

export async function checkYesterdayBankDeposits() {
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

// ── Chatwork 通達メッセージを生成 ───────────────────────────

export function buildDepositMessage(deposits) {
  const lines = ["[toall]", "💰 入金通知（住信SBIネット銀行）", ""];
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
