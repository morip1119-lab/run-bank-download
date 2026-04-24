import fs from "node:fs";
import { google } from "googleapis";
import { DateTime } from "luxon";
import { config } from "./config.js";
import { parseDateTimeRange, formatRangeJa } from "./datetime_parse.js";
import {
  readClientCredentials,
  GOOGLE_OAUTH_REDIRECT_URI,
} from "./google_client_config.js";

const BUSY_KEYWORDS = [
  "打合せ", "会食", "食事", "移動", "ごはん", "ご飯", "定例", "MTG",
  "仏法讃嘆", "会合", "顧問相談", "銀行", "打ち合わせ", "訪問", "撮影",
  "講義", "Zoom", "歯科", "眉毛", "ヘア", "美容室", "イベント",
  "二千畳", "Ｑ＆Ａ", "Q&A", "講演",
];

const AVAIL_START = 11;
const AVAIL_END = 23;

const WD_JA = { 1: "月", 2: "火", 3: "水", 4: "木", 5: "金", 6: "土", 7: "日" };

function isBusyEvent(summary = "") {
  return BUSY_KEYWORDS.some((kw) => summary.includes(kw));
}

function periodToDates(period, tz) {
  const today = DateTime.now().setZone(tz).startOf("day");
  if (period === "today") {
    return { start: today, end: today.plus({ days: 1 }) };
  }
  if (period === "tomorrow") {
    const tmr = today.plus({ days: 1 });
    return { start: tmr, end: tmr.plus({ days: 1 }) };
  }
  if (period === "this_week") {
    const mon = today.set({ weekday: 1 });
    return { start: mon, end: mon.plus({ weeks: 1 }) };
  }
  if (period === "next_week") {
    const nextMon = today.set({ weekday: 1 }).plus({ weeks: 1 });
    return { start: nextMon, end: nextMon.plus({ weeks: 1 }) };
  }
  // default: 今日から7日
  return { start: today, end: today.plus({ days: 7 }) };
}

/**
 * 空きスケジュールを取得して整形済み文字列を返す
 * @param {object} p
 * @param {"today"|"tomorrow"|"this_week"|"next_week"|"default"} p.period
 */
export async function getFreeSlots({ period = "default" } = {}) {
  let auth;
  try {
    auth = loadOAuthClient();
  } catch (e) {
    throw new Error(`Google 認証の準備に失敗: ${e.message}`);
  }

  const cal = google.calendar({ version: "v3", auth });
  const tz = config.timeZone;
  const { start: rangeStart, end: rangeEnd } = periodToDates(period, tz);

  const res = await cal.events.list({
    calendarId: "primary",
    timeMin: rangeStart.toISO(),
    timeMax: rangeEnd.toISO(),
    singleEvents: true,
    orderBy: "startTime",
  });

  const events = res.data.items ?? [];
  const busyEvents = events.filter(
    (ev) => isBusyEvent(ev.summary) && ev.start?.dateTime
  );

  const days = Math.round(rangeEnd.diff(rangeStart, "days").days);
  const dayResults = [];

  for (let d = 0; d < days; d++) {
    const day = rangeStart.plus({ days: d });
    const winStart = day.set({ hour: AVAIL_START, minute: 0, second: 0, millisecond: 0 });
    const winEnd = day.set({ hour: AVAIL_END, minute: 0, second: 0, millisecond: 0 });

    const busyHours = new Set();
    for (const ev of busyEvents) {
      const evStart = DateTime.fromISO(ev.start.dateTime).setZone(tz);
      const evEnd = DateTime.fromISO(ev.end.dateTime).setZone(tz);
      if (evEnd <= winStart || evStart >= winEnd) continue;
      for (let h = AVAIL_START; h < AVAIL_END; h++) {
        const slotS = day.set({ hour: h, minute: 0, second: 0, millisecond: 0 });
        const slotE = slotS.plus({ hours: 1 });
        if (evStart < slotE && evEnd > slotS) busyHours.add(h);
      }
    }

    const freeHours = [];
    for (let h = AVAIL_START; h < AVAIL_END; h++) {
      if (!busyHours.has(h)) freeHours.push(h);
    }

    // 連続する時間帯をまとめる
    const ranges = [];
    for (const h of freeHours) {
      if (ranges.length > 0 && ranges[ranges.length - 1].end === h) {
        ranges[ranges.length - 1].end = h + 1;
      } else {
        ranges.push({ start: h, end: h + 1 });
      }
    }

    if (ranges.length > 0) {
      dayResults.push({ day, ranges });
    }
  }

  if (dayResults.length === 0) {
    const label = period === "next_week" ? "来週" : period === "this_week" ? "今週" : "指定期間";
    return `【空きスケジュール】\n${label}は空き時間がありませんでした。`;
  }

  const lines = ["【空きスケジュール】"];
  for (const { day, ranges } of dayResults) {
    lines.push(`\n${day.month}月${day.day}日(${WD_JA[day.weekday]})`);
    for (const r of ranges) {
      lines.push(`・${r.start}:00〜${r.end}:00`);
    }
  }
  return lines.join("\n");
}

/**
 * 誰でも自分の Google カレンダーに追加できるテンプレートリンクを生成する
 * @param {string} summary
 * @param {Date} start
 * @param {Date} end
 * @param {string} [description]
 */
export function buildCalendarTemplateUrl(summary, start, end, description = "") {
  const fmt = (d) =>
    new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: summary,
    dates: `${fmt(start)}/${fmt(end)}`,
  });
  if (description) params.set("details", description);
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function loadTokenObject() {
  const raw = process.env.GOOGLE_TOKEN_JSON?.trim();
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch (e) {
      throw new Error(
        `GOOGLE_TOKEN_JSON のパースに失敗しました: ${e.message}`
      );
    }
  }
  if (!fs.existsSync(config.googleTokenPath)) {
    throw new Error(
      `OAuth トークンがありません。次のいずれかを設定してください:\n` +
        `- 環境変数 GOOGLE_TOKEN_JSON（token.json と同じ内容）\n` +
        `- ファイル ${config.googleTokenPath}\n` +
        `ローカルなら npm run google-auth で token.json を作成。`
    );
  }
  return JSON.parse(fs.readFileSync(config.googleTokenPath, "utf8"));
}

export function loadOAuthClient() {
  const { client_id, client_secret } = readClientCredentials();
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    GOOGLE_OAUTH_REDIRECT_URI
  );

  const tokens = loadTokenObject();
  oAuth2Client.setCredentials(tokens);

  oAuth2Client.on("tokens", (t) => {
    if (t.refresh_token) {
      tokens.refresh_token = t.refresh_token;
    }
    Object.assign(tokens, t);
    if (process.env.GOOGLE_TOKEN_JSON?.trim()) {
      console.warn(
        "[google] トークンが更新されました。環境変数 GOOGLE_TOKEN_JSON 運用ではディスクに保存していません。必要なら Secret Manager を手動更新してください。"
      );
      return;
    }
    try {
      fs.writeFileSync(
        config.googleTokenPath,
        JSON.stringify(tokens, null, 2)
      );
    } catch (e) {
      console.warn("[google] token.json への保存をスキップ:", e.message);
    }
  });

  return oAuth2Client;
}

/**
 * タイトルと日時テキストから直接カレンダーに登録する
 * @param {object} p
 * @param {string} p.title
 * @param {string} p.datetimeText
 * @returns {{ ok: true, message: string } | { ok: false, message: string }}
 */
export async function registerDirectCalendarEvent({ title, datetimeText }) {
  const range = parseDateTimeRange(datetimeText, new Date());
  if (!range) {
    return { ok: false, message: "日時を読み取れませんでした。例：４月２２日２０時〜２１時" };
  }
  const tz = config.timeZone;
  try {
    await insertPrimaryCalendarEvent({
      summary: title,
      start: range.start,
      end: range.end,
    });
    const when = formatRangeJa(range.start, range.end, tz);
    const addLink = buildCalendarTemplateUrl(title, range.start, range.end);
    return {
      ok: true,
      message: [
        "Google カレンダーに登録しました。",
        `件名: ${title}`,
        `日時: ${when}`,
        `ご自身のGoogleカレンダーにも保存する: ${addLink}`,
      ].join("\n"),
    };
  } catch (e) {
    return { ok: false, message: `カレンダー登録に失敗しました: ${e.message || e}` };
  }
}

/**
 * @param {object} p
 * @param {string} p.summary
 * @param {string} [p.description]
 * @param {Date} p.start
 * @param {Date} p.end
 */
export async function insertPrimaryCalendarEvent({
  summary,
  description,
  start,
  end,
}) {
  let auth;
  try {
    auth = loadOAuthClient();
  } catch (e) {
    throw new Error(`Google 認証の準備に失敗: ${e.message}`);
  }

  const cal = google.calendar({ version: "v3", auth });
  const timeZone = config.timeZone;

  try {
    const res = await cal.events.insert({
      calendarId: "primary",
      requestBody: {
        summary,
        description: description || "",
        start: {
          dateTime: start.toISOString(),
          timeZone,
        },
        end: {
          dateTime: end.toISOString(),
          timeZone,
        },
      },
    });
    return res.data;
  } catch (e) {
    const msg = e?.message || String(e);
    const code = e?.code || e?.response?.data?.error;
    if (
      msg.includes("invalid_grant") ||
      msg.includes("Invalid grant")
    ) {
      throw new Error(
        "Google のトークンが無効です。手元で npm run google-auth をやり直し、token.json を Secret Manager の google-token-json に入れ直してください。"
      );
    }
    if (msg.includes("403") || code === 403) {
      throw new Error(
        "Calendar API が拒否されました。GCP で Google Calendar API が有効か、OAuth のスコープに calendar.events があるか確認してください。"
      );
    }
    throw new Error(`Calendar API エラー: ${msg}`);
  }
}
