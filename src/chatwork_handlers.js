import { config } from "./config.js";
import {
  isDraftCommand,
  isConfirmCommand,
  parseFixCommand,
  parseAvailabilityCommand,
  parseDirectCalendarCommand,
  parseDirectCalendarDeleteCommand,
  parseReminderCommand,
  parseInvoiceCommand,
  parseDriveSaveCommand,
} from "./commands.js";
import * as db from "./db.js";
import {
  createDraftFromQuote,
  formatDraftMessage,
  applyCorrectionInstruction,
} from "./draft_service.js";
import {
  insertPrimaryCalendarEvent,
  getFreeSlots,
  registerDirectCalendarEvent,
  deleteDirectCalendarEvent,
  buildCalendarTemplateUrl,
} from "./calendar_service.js";
import { createInvoice } from "./invoice_service.js";
import { saveToDrive, resolveCompanyKey, resolveYearMonth, listDriveCompanies } from "./drive_service.js";
import { sendMessage, parseChatworkBody } from "./chatwork_client.js";
import { parseDateTimeRange } from "./datetime_parse.js";
import { addReminder } from "./reminder_store.js";

/** Chatwork の accountId を DB 用の userId に変換（LINE ID と衝突しないよう prefix） */
function cwUserId(accountId) {
  return `cw:${accountId}`;
}

/** Chatwork の roomId を DB 用の groupId に変換 */
function cwGroupId(roomId) {
  return `cw:${roomId}`;
}

/**
 * Chatwork Webhook の message_created イベントを処理する
 * @param {object} event  webhook_event オブジェクト
 */
export async function handleChatworkMessage(event) {
  // mention_to_me は from_account_id、message_created は account_id
  const { room_id: roomId, body } = event;
  const accountId = event.from_account_id ?? event.account_id;

  if (!config.chatworkAllowedAccountId) return;
  
  if (String(accountId) !== String(config.chatworkAllowedAccountId)) {
    return;
  }

  const { quotedText, commandText } = parseChatworkBody(body);
  const userId = cwUserId(accountId);
  const groupId = cwGroupId(roomId);
  console.log("[cw] accountId=%s allowed=%s body=%s commandText=%s",
    accountId, config.chatworkAllowedAccountId,
    JSON.stringify(body.slice(0, 120)),
    JSON.stringify(commandText.slice(0, 80))
  );

  // ─── カレンダー登録 ───────────────────────────────────────────
  if (isConfirmCommand(commandText)) {
    await handleConfirm(roomId, userId, groupId);
    return;
  }

  // ─── Drive 保存 ───────────────────────────────────────────────
  const driveCmd = parseDriveSaveCommand(commandText);
  if (driveCmd) {
    await handleCwDriveSave(event, roomId, driveCmd);
    return;
  }

  // ─── 請求書作成 ───────────────────────────────────────────────
  const invoiceCmd = parseInvoiceCommand(commandText);
  if (invoiceCmd) {
    const result = await createInvoice(invoiceCmd).catch((e) => ({ ok: false, message: `請求書作成に失敗しました: ${e.message}` }));
    await sendMessage(roomId, result.message);
    return;
  }

  // ─── リマインド設定 ───────────────────────────────────────────
  const reminderCmd = parseReminderCommand(commandText);
  if (reminderCmd) {
    const range = parseDateTimeRange(reminderCmd.datetimeText, new Date());
    if (!range) {
      await sendMessage(roomId, "日時を読み取れませんでした。例：４月２２日２０時");
      return;
    }
    await addReminder({ platform: "chatwork", chatId: String(roomId), remindAt: range.start.getTime(), message: reminderCmd.message });
    const fmt = new Intl.DateTimeFormat("ja-JP", {
      timeZone: config.timeZone || "Asia/Tokyo",
      month: "long", day: "numeric", weekday: "short",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });
    await sendMessage(roomId, `⏰ ${fmt.format(range.start)} に「${reminderCmd.message}」のリマインドを設定しました`);
    return;
  }

  // ─── ダイレクトカレンダー削除／登録 ─────────────────────────
  const delCal = parseDirectCalendarDeleteCommand(commandText);
  if (delCal) {
    const result = await deleteDirectCalendarEvent(delCal);
    await sendMessage(roomId, result.message);
    return;
  }

  const direct = parseDirectCalendarCommand(commandText);
  if (direct) {
    const result = await registerDirectCalendarEvent(direct);
    await sendMessage(roomId, result.message);
    return;
  }

  // ─── 空きスケジュール ─────────────────────────────────────────
  const avail = parseAvailabilityCommand(commandText);
  if (avail) {
    try {
      const msg = await getFreeSlots({ period: avail.period });
      await sendMessage(roomId, msg);
    } catch (e) {
      await sendMessage(roomId, `空きスケジュールの取得に失敗しました: ${e.message}`);
    }
    return;
  }

  // ─── 修正（wait_next） ────────────────────────────────────────
  const fix = parseFixCommand(commandText);
  if (fix?.kind === "wait_next") {
    const draft = db.getActiveDraft(userId);
    if (!draft || draft.source_group_id !== groupId) {
      await sendMessage(roomId, "このルームで有効な下書きがありません。先に対象メッセージを引用して「下書きを作成する」を送ってください。");
      return;
    }
    const until = Date.now() + config.correctionWaitMinutes * 60 * 1000;
    db.setAwaitingCorrection(draft.id, until);
    await sendMessage(roomId, `修正内容を送ってください（${config.correctionWaitMinutes}分以内）。例：４月２０日２０時にして`);
    return;
  }

  // ─── 修正（apply） ────────────────────────────────────────────
  if (fix?.kind === "apply") {
    const draft = db.getActiveDraft(userId);
    if (!draft || draft.source_group_id !== groupId) {
      await sendMessage(roomId, "このルームで有効な下書きがありません。");
      return;
    }
    const result = applyCorrectionInstruction(draft, fix.instruction);
    if (!result.ok) {
      await sendMessage(roomId, "日時を読み取れませんでした。もう一度、日付と時刻をはっきり書いて送ってください。");
      return;
    }
    await sendMessage(roomId, formatDraftMessage(result.draft));
    return;
  }

  // ─── 修正待ち中のフリーテキスト ──────────────────────────────
  const draftForCorrection = db.getActiveDraft(userId);
  if (
    draftForCorrection?.source_group_id === groupId &&
    draftForCorrection?.awaiting_correction_until &&
    draftForCorrection.awaiting_correction_until > Date.now()
  ) {
    const result = applyCorrectionInstruction(draftForCorrection, commandText);
    if (!result.ok) {
      await sendMessage(roomId, "日時を読み取れませんでした。もう一度送るか、「修正」からやり直してください。");
      return;
    }
    await sendMessage(roomId, formatDraftMessage(result.draft));
    return;
  }

  // ─── 下書き作成（引用返信） ───────────────────────────────────
  if (isDraftCommand(commandText)) {
    if (!quotedText) {
      await sendMessage(roomId, "対象メッセージを引用（返信）した上で「下書きを作成する」を送ってください。");
      return;
    }
    const { text: draftMsg } = createDraftFromQuote({
      ownerUserId: userId,
      sourceGroupId: groupId,
      quotedText,
    });
    await sendMessage(roomId, draftMsg);
    return;
  }
}

async function handleConfirm(roomId, userId, groupId) {
  const draft = db.getActiveDraft(userId);
  if (!draft) {
    await sendMessage(roomId, "登録できる下書きがありません。");
    return;
  }

  if (draft.source_group_id && draft.source_group_id !== groupId) {
    await sendMessage(roomId, "このルームで作成した下書きではありません。下書きを作ったルームで「カレンダー登録する」を送ってください。");
    return;
  }

  if (!draft.start_at || !draft.end_at) {
    await sendMessage(roomId, "開始・終了時刻が未設定です。「修正」で日時を指定してから、もう一度「カレンダー登録する」を送ってください。");
    return;
  }

  try {
    const title = draft.title || "打合せ";
    const start = new Date(draft.start_at);
    const end = new Date(draft.end_at);
    await insertPrimaryCalendarEvent({
      summary: title,
      description: [`元メッセージ:`, draft.quoted_text].join("\n"),
      start,
      end,
    });
    db.markDraftConfirmed(draft.id);
    const addLink = buildCalendarTemplateUrl(title, start, end);
    await sendMessage(
      roomId,
      [
        "Google カレンダーに登録しました。",
        `件名: ${title}`,
        `ご自身のGoogleカレンダーにも保存する: ${addLink}`,
      ].join("\n")
    );
  } catch (e) {
    console.error(e);
    await sendMessage(roomId, `カレンダー登録に失敗しました: ${e.message || e}`);
  }
}

// ─── Drive 保存ハンドラ ────────────────────────────────────────

async function handleCwDriveSave(event, roomId, { company, month }) {
  const companyKey = resolveCompanyKey(company);
  if (!companyKey) {
    await sendMessage(roomId,
      `「${company}」は登録されていない会社名です。\n使用可能: ${listDriveCompanies().join(" / ")}`
    );
    return;
  }

  // [rp] タグから返信元ルームID・メッセージIDを取得
  const { body } = event;
  const replyMatch = body.match(/\[rp\s[^\]]*to=(\d+)-(\d+)/);
  if (!replyMatch) {
    await sendMessage(roomId, "ファイルが含まれるメッセージに返信して「[会社名] ドライブ保存して [月]」と送ってください。");
    return;
  }
  const originalRoomId = replyMatch[1];  // [rp] タグ内のルームID
  const originalMsgId  = replyMatch[2];  // [rp] タグ内のメッセージID

  const cwToken = config.chatworkApiToken;

  // 返信元メッセージを取得してファイル名・送信時刻を抽出
  const origMsgRes = await fetch(
    `https://api.chatwork.com/v2/rooms/${originalRoomId}/messages/${originalMsgId}`,
    { headers: { "x-chatworktoken": cwToken } }
  );
  if (!origMsgRes.ok) {
    await sendMessage(roomId, `返信元メッセージの取得に失敗しました (room:${originalRoomId} msg:${originalMsgId}): ${origMsgRes.status}`);
    return;
  }
  const origMsg = await origMsgRes.json();
  const sendTime = origMsg.send_time; // Unix 秒

  // メッセージ本文の [title]ファイル名[/title] を抽出
  const titleMatches = [...(origMsg.body || "").matchAll(/\[title\]([\s\S]*?)\[\/title\]/g)];
  const attachedFilenames = titleMatches.map((m) => m[1].trim());

  // ルームのファイル一覧を取得（100件）
  const filesRes = await fetch(
    `https://api.chatwork.com/v2/rooms/${originalRoomId}/files?count=100`,
    { headers: { "x-chatworktoken": cwToken } }
  );
  if (!filesRes.ok) {
    await sendMessage(roomId, `ファイル一覧の取得に失敗しました: ${filesRes.status}`);
    return;
  }
  const files = await filesRes.json();

  // 1. ファイル名で照合（最優先）
  let fileInfo = null;
  for (const fname of attachedFilenames) {
    fileInfo = files.find((f) => f.filename === fname);
    if (fileInfo) break;
  }

  // 2. 送信時刻の近さで照合（±5分以内の最近傍）
  if (!fileInfo && sendTime) {
    const nearby = files
      .filter((f) => Math.abs(f.upload_time - sendTime) < 300)
      .sort((a, b) => Math.abs(a.upload_time - sendTime) - Math.abs(b.upload_time - sendTime));
    fileInfo = nearby[0] || null;
  }

  // 3. どちらでも見つからない場合はデバッグ情報を返す
  if (!fileInfo) {
    await sendMessage(roomId,
      `返信元メッセージにファイルが見つかりませんでした。\n` +
      `本文から検出したファイル名: ${attachedFilenames.join(", ") || "(なし)"}\n` +
      `送信時刻: ${sendTime}\n` +
      `ファイル件数: ${files.length}`
    );
    return;
  }

  // ファイルのダウンロード URL を取得
  const fileDetailRes = await fetch(
    `https://api.chatwork.com/v2/rooms/${originalRoomId}/files/${fileInfo.file_id}?create_download_url=1`,
    { headers: { "x-chatworktoken": cwToken } }
  );
  if (!fileDetailRes.ok) {
    await sendMessage(roomId, `ファイルURLの取得に失敗しました: ${fileDetailRes.status}`);
    return;
  }
  const fileDetail = await fileDetailRes.json();
  const downloadUrl = fileDetail.download_url;
  if (!downloadUrl) {
    await sendMessage(roomId, "ダウンロード URL が取得できませんでした。");
    return;
  }

  // ファイルをダウンロード
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) {
    await sendMessage(roomId, `ファイルのダウンロードに失敗しました: ${dlRes.status}`);
    return;
  }
  const buffer = Buffer.from(await dlRes.arrayBuffer());
  const mimeType = dlRes.headers.get("content-type") || "application/octet-stream";

  // Drive に保存
  const { year, month: resolvedMonth } = resolveYearMonth(month);
  try {
    const link = await saveToDrive({
      companyKey,
      year,
      month: resolvedMonth,
      filename: fileInfo.filename,
      buffer,
      mimeType,
    });
    await sendMessage(roomId,
      [
        `📁 Google Drive に保存しました。`,
        `会社: ${company}`,
        `フォルダ: ${year}年${resolvedMonth}月`,
        `ファイル: ${fileInfo.filename}`,
        `リンク: ${link}`,
      ].join("\n")
    );
  } catch (e) {
    await sendMessage(roomId, `Drive への保存に失敗しました: ${e.message}`);
  }
}
