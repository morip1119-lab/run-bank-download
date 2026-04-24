import { config } from "./config.js";
import {
  parseDateTimeRange,
  formatRangeJa,
} from "./datetime_parse.js";
import * as db from "./db.js";

function truncateTitle(t) {
  const s = t.trim();
  if (!s) return "打合せ";
  return s.length > 120 ? `${s.slice(0, 117)}...` : s;
}

/**
 * 日時・時間枠の行か（件名ではなくスケジュール行）
 * 例: 「4月 29日 15:00〜16:00」「4/29 15:00-16:00」「15:00〜16:00」
 */
function looksLikeScheduleLine(line) {
  const s = line.trim();
  if (!s) return false;

  if (/\d{1,2}:\d{2}\s*[〜～~-]\s*\d{1,2}:\d{2}/.test(s)) return true;

  const hasMonthDay =
    /\d{1,2}\s*月\s*\d{1,2}\s*日/.test(s) ||
    /\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日/.test(s) ||
    /^\d{1,2}\s*\/\s*\d{1,2}/.test(s.trimStart());

  if (hasMonthDay) {
    if (/[〜～~-]/.test(s) || /:\d{2}/.test(s) || /\d{1,2}\s*時/.test(s)) {
      return true;
    }
  }

  if (
    /^(明日|明後日|今日|本日)/.test(s) &&
    (/\d{1,2}\s*時/.test(s) || /\d{1,2}:\d{2}/.test(s)) &&
    s.length < 48
  ) {
    return true;
  }

  return false;
}

/**
 * 返信元テキストからカレンダー件名を推定
 * 1行目が日時枠・2行目が実際の用件名、のときは2行目を優先
 */
function titleFromQuoted(quotedText) {
  const lines = quotedText
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return "打合せ";

  if (looksLikeScheduleLine(lines[0])) {
    const titleLine = lines.slice(1).find((l) => !looksLikeScheduleLine(l));
    if (titleLine) return truncateTitle(titleLine);
  }

  return truncateTitle(lines[0]);
}

/**
 * 修正文から件名だけ取り出す（例: 件名を、テスト打ちあわせ にして）
 */
export function parseTitleFromCorrection(text) {
  const t = text.trim();
  if (!t) return null;
  const patterns = [
    /件名を[、,]\s*(.+?)\s*にして/u,
    /件名を\s*「(.+?)」\s*に/u,
    /件名[：:]\s*(.+?)(?:\n|$)/u,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) {
      let s = m[1].trim();
      s = s.replace(/[。．]+$/u, "");
      if (s.length === 0 || s.length > 200) continue;
      return s.length > 120 ? `${s.slice(0, 117)}...` : s;
    }
  }
  return null;
}

/**
 * 返信元テキストから下書きを作成し DB に保存、本文を返す（グループ送信用）
 */
export function createDraftFromQuote({
  ownerUserId,
  sourceGroupId,
  quotedText,
}) {
  const title = titleFromQuoted(quotedText);
  const range = parseDateTimeRange(quotedText, new Date());
  const startAt = range?.start?.toISOString() ?? null;
  const endAt = range?.end?.toISOString() ?? null;

  const id = db.insertDraft({
    ownerUserId,
    sourceGroupId,
    quotedText,
    title,
    startAt,
    endAt,
  });

  return { id, text: formatDraftMessage(db.getDraftById(id)) };
}

export function formatDraftMessage(draft) {
  const tz = config.timeZone;
  let when = "（日時を自動で読み取れませんでした。「修正」で日時を指定してください）";
  if (draft.start_at && draft.end_at) {
    const s = new Date(draft.start_at);
    const e = new Date(draft.end_at);
    when = formatRangeJa(s, e, tz);
  }

  return [
    "【スケジュール下書き】",
    `件名: ${draft.title || "打合せ"}`,
    `日時: ${when}`,
    "",
    "「カレンダー登録する」で確定、「修正」で日時を変更できます。",
  ].join("\n");
}

/**
 * 修正指示テキストを既存下書きに適用
 */
export function applyCorrectionInstruction(draft, instructionText) {
  const title = parseTitleFromCorrection(instructionText);
  // 修正文を先に並べる（古い quoted の「15:00〜」が先頭だと日時パースが誤る）
  const mergedForFallback = `${instructionText.trim()}\n\n【参考・元スレッド】\n${draft.quoted_text}`;
  const range =
    parseDateTimeRange(instructionText.trim(), new Date()) ||
    parseDateTimeRange(mergedForFallback, new Date());

  if (!range) {
    return { ok: false, reason: "no_datetime" };
  }

  const startAt = range.start.toISOString();
  const endAt = range.end.toISOString();

  db.updateDraftTimes(draft.id, {
    startAt,
    endAt,
    ...(title ? { title } : {}),
  });
  db.clearAwaitingCorrection(draft.id);
  return { ok: true, draft: db.getDraftById(draft.id) };
}
