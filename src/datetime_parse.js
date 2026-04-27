import * as chrono from "chrono-node";
import { DateTime } from "luxon";
import { config } from "./config.js";

const jaParse = chrono.ja.parse;
const enParse = chrono.parse;

function zone() {
  return config.timeZone || "Asia/Tokyo";
}

/** 全角数字などを半角に（簡易） */
function toHalfWidthDigits(str) {
  return str.replace(/[０-９]/g, (c) =>
    String.fromCharCode(c.charCodeAt(0) - 0xfee0)
  );
}

/**
 * LINE/IME が挿入するゼロ幅文字を除去（日と時の間に入ると日時パースが null になる）
 */
export function normalizeParseText(str) {
  if (!str) return "";
  return toHalfWidthDigits(str)
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .replace(/\u3000/g, " ")
    .trim();
}

/**
 * 「4月20日 20時」「4/20 20:00」などを解釈。失敗時は null。
 * 解釈の基準タイムゾーンは `config.timeZone`（既定: Asia/Tokyo）。
 */
export function parseDateTimeRange(text, referenceDate = new Date()) {
  const t = normalizeParseText(text);
  if (!t) return null;

  const jp = tryJapanesePattern(t, referenceDate);
  if (jp) return jp;

  const ref = DateTime.fromJSDate(referenceDate).setZone(zone());
  let chronoResult = jaParse(t, ref.toJSDate(), { forwardDate: true });
  if (!chronoResult?.length) {
    chronoResult = enParse(t, ref.toJSDate(), { forwardDate: true });
  }
  if (!chronoResult?.length) {
    return null;
  }

  const startRaw = chronoResult[0].date();
  const start = DateTime.fromJSDate(startRaw).setZone(zone());
  const end = start.plus({ minutes: config.defaultDurationMinutes });
  return { start: start.toJSDate(), end: end.toJSDate() };
}

/**
 * 年月日＋時刻の定番パターン（chrono が弱い場合の補助）
 */
function tryJapanesePattern(text, referenceDate) {
  const t = text;
  const now = DateTime.fromJSDate(referenceDate).setZone(zone());

  let month = null, day = null, yearBase = now.year;

  // 1. 絶対日付「4月23日」「4/23」
  const mdFull = t.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
  if (mdFull) {
    month = Number(mdFull[1]);
    day   = Number(mdFull[2]);
  } else {
    const mdSlash = t.match(/(\d{1,2})\s*\/\s*(\d{1,2})/);
    if (mdSlash) {
      month = Number(mdSlash[1]);
      day   = Number(mdSlash[2]);
    }
  }

  // 2. 相対日付「明後日」「明日」「今日」（JST 基準で解決 → 年加算不要）
  let skipYearAdjust = false;
  if (month == null) {
    let base = null;
    if (/明後日/.test(t))              base = now.plus({ days: 2 });
    else if (/明日|あした|あす/.test(t)) base = now.plus({ days: 1 });
    else if (/今日|本日|きょう/.test(t)) base = now;

    if (base) {
      yearBase       = base.year;
      month          = base.month;
      day            = base.day;
      skipYearAdjust = true;
    }
  }

  // 3. 日付のみ「22日」（月省略 → 当月）
  if (month == null) {
    const mdDay = t.match(/(?:^|[^\d月\/])(\d{1,2})\s*日/);
    if (mdDay) {
      month = now.month;
      day   = Number(mdDay[1]);
    }
  }

  if (month == null || day == null) return null;

  const year = yearBase;

  // HH:MM〜HH:MM（コロン形式・分単位対応）
  const rangeColon = t.match(
    /(\d{1,2})\s*:\s*(\d{2})\s*[-〜~～]\s*(\d{1,2})\s*:\s*(\d{2})/u
  );
  if (rangeColon) {
    const hStart = Number(rangeColon[1]);
    const mStart = Number(rangeColon[2]);
    const hEnd   = Number(rangeColon[3]);
    const mEnd   = Number(rangeColon[4]);
    let y = year;
    let start = DateTime.fromObject(
      { year: y, month, day, hour: hStart, minute: mStart },
      { zone: zone() }
    );
    if (!skipYearAdjust && start < now) {
      y += 1;
      start = DateTime.fromObject(
        { year: y, month, day, hour: hStart, minute: mStart },
        { zone: zone() }
      );
    }
    let end = DateTime.fromObject(
      { year: y, month, day, hour: hEnd, minute: mEnd },
      { zone: zone() }
    );
    if (end <= start) end = end.plus({ days: 1 });
    return { start: start.toJSDate(), end: end.toJSDate() };
  }

  // 「17〜18時」「17時〜18時」「17時30分〜18時30分」は末尾の「◯時」だけ拾うと誤判定するので先に扱う
  const rangeHour = t.match(
    /(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分?)?\s*[-〜~～]\s*(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分?)?/u
  );
  if (rangeHour) {
    const hStart = Number(rangeHour[1]);
    const mStart = rangeHour[2] != null ? Number(rangeHour[2]) : 0;
    const hEnd   = Number(rangeHour[3]);
    const mEnd   = rangeHour[4] != null ? Number(rangeHour[4]) : 0;
    let y = year;
    let start = DateTime.fromObject(
      { year: y, month, day, hour: hStart, minute: mStart },
      { zone: zone() }
    );
    if (!skipYearAdjust && start < now) {
      y += 1;
      start = DateTime.fromObject(
        { year: y, month, day, hour: hStart, minute: mStart },
        { zone: zone() }
      );
    }
    let end = DateTime.fromObject(
      { year: y, month, day, hour: hEnd, minute: mEnd },
      { zone: zone() }
    );
    if (end <= start) end = end.plus({ days: 1 });
    return { start: start.toJSDate(), end: end.toJSDate() };
  }

  let hour = 10;
  let minute = 0;
  const th = t.match(/(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分)?/);
  if (th) {
    hour = Number(th[1]);
    minute = th[2] != null ? Number(th[2]) : 0;
  } else {
    const colon = t.match(/(\d{1,2})\s*:\s*(\d{2})/);
    if (colon) {
      hour = Number(colon[1]);
      minute = Number(colon[2]);
    }
  }

  let y = year;
  let start = DateTime.fromObject(
    { year: y, month, day, hour, minute },
    { zone: zone() }
  );
  if (!skipYearAdjust && start < now) {
    y += 1;
    start = DateTime.fromObject(
      { year: y, month, day, hour, minute },
      { zone: zone() }
    );
  }

  const end = start.plus({ minutes: config.defaultDurationMinutes });
  return { start: start.toJSDate(), end: end.toJSDate() };
}

export function formatRangeJa(start, end, timeZone) {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${fmt.format(start)} 〜 ${fmt.format(end)}`;
}
