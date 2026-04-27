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
  parseExpenseCheckCommand,
  parseBudgetSetCommand,
  isBudgetCheckCommand,
  parseManualExpenseCommand,
  isMfSyncCommand,
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
import { parseDateTimeRange, formatRangeJa } from "./datetime_parse.js";
import { addReminder } from "./reminder_store.js";
import { DateTime } from "luxon";
import {
  syncMoneyForwardExpenses,
  buildMonthlySummaryMessage,
  buildBudgetListMessage,
  buildExpenseAddedMessage,
} from "./expense_service.js";

function isTextMessage(event) {
  return event.type === "message" && event.message?.type === "text";
}

/** LINE の userId は U で始まる想定（グループ・ルームは別） */
function isUserChatId(id) {
  return typeof id === "string" && id.startsWith("U");
}

async function pushText(client, to, text) {
  await client.pushMessage({
    to,
    messages: [{ type: "text", text }],
  });
}

async function replyText(client, replyToken, text) {
  if (!replyToken) return;
  await client.replyMessage({
    replyToken,
    messages: [{ type: "text", text }],
  });
}

export async function handleWebhookEvent(client, event) {
  if (!isTextMessage(event)) {
    return;
  }

  const text = event.message.text;
  const messageId = event.message.id;
  const userId = event.source.userId;

  if (event.source.type === "group" || event.source.type === "room") {
    const chatId =
      event.source.type === "group"
        ? event.source.groupId
        : event.source.roomId;
    await handleGroupMessage(client, event, {
      text,
      messageId,
      userId,
      groupId: chatId,
    });
    return;
  }

  if (event.source.type === "user") {
    await handleDirectMessage(client, event, { text, userId });
  }
}

async function handleGroupMessage(
  client,
  event,
  { text, messageId, userId, groupId }
) {
  db.saveGroupMessage({
    lineMessageId: messageId,
    groupId,
    userId,
    text,
  });

  if (userId !== config.allowedLineUserId) {
    return;
  }

  if (isConfirmCommand(text)) {
    await handleConfirm(client, userId, groupId);
    return;
  }

  const avail = parseAvailabilityCommand(text);
  if (avail) {
    await handleAvailability(client, groupId, avail.period);
    return;
  }

  const delCal = parseDirectCalendarDeleteCommand(text);
  if (delCal) {
    const result = await deleteDirectCalendarEvent(delCal);
    await pushText(client, groupId, result.message);
    return;
  }

  const direct = parseDirectCalendarCommand(text);
  if (direct) {
    const result = await registerDirectCalendarEvent(direct);
    await pushText(client, groupId, result.message);
    return;
  }

  const reminder = parseReminderCommand(text);
  if (reminder) {
    await handleSetReminder(client, groupId, "line", reminder);
    return;
  }

  const invoice = parseInvoiceCommand(text);
  if (invoice) {
    const result = await createInvoice(invoice).catch((e) => ({ ok: false, message: `請求書作成に失敗しました: ${e.message}` }));
    await pushText(client, groupId, result.message);
    return;
  }

  const driveCmd = parseDriveSaveCommand(text);
  if (driveCmd) {
    await handleLineDriveSave(client, event, groupId, driveCmd);
    return;
  }

  const expenseCheck = parseExpenseCheckCommand(text);
  if (expenseCheck) {
    await handleExpenseCheck(client, groupId, expenseCheck.month);
    return;
  }

  const budgetSet = parseBudgetSetCommand(text);
  if (budgetSet) {
    await handleBudgetSet(client, groupId, budgetSet.entries);
    return;
  }

  if (isBudgetCheckCommand(text)) {
    await pushText(client, groupId, buildBudgetListMessage());
    return;
  }

  const manualExpense = parseManualExpenseCommand(text);
  if (manualExpense) {
    await handleManualExpense(client, groupId, manualExpense);
    return;
  }

  if (isMfSyncCommand(text)) {
    await handleMfSync(client, groupId);
    return;
  }

  const fix = parseFixCommand(text);
  if (fix?.kind === "wait_next") {
    const draft = db.getActiveDraft(userId);
    if (!draft || draft.source_group_id !== groupId) {
      await replyText(
        client,
        event.replyToken,
        "このグループで有効な下書きがありません。先に返信で「下書きを作成する」を送ってください。"
      );
      return;
    }
    const until = Date.now() + config.correctionWaitMinutes * 60 * 1000;
    db.setAwaitingCorrection(draft.id, until);
    await pushText(
      client,
      groupId,
      `修正内容を送ってください（${config.correctionWaitMinutes}分以内）。例：４月２０日２０時にして`
    );
    return;
  }

  if (fix?.kind === "apply") {
    const draft = db.getActiveDraft(userId);
    if (!draft || draft.source_group_id !== groupId) {
      await replyText(
        client,
        event.replyToken,
        "このグループで有効な下書きがありません。"
      );
      return;
    }
    const result = applyCorrectionInstruction(draft, fix.instruction);
    if (!result.ok) {
      await pushText(
        client,
        groupId,
        "日時を読み取れませんでした。もう一度、日付と時刻をはっきり書いて送ってください。"
      );
      return;
    }
    await pushText(client, groupId, formatDraftMessage(result.draft));
    return;
  }

  const draftForCorrection = db.getActiveDraft(userId);
  if (
    draftForCorrection?.source_group_id === groupId &&
    draftForCorrection?.awaiting_correction_until &&
    draftForCorrection.awaiting_correction_until > Date.now()
  ) {
    const result = applyCorrectionInstruction(
      draftForCorrection,
      text.trim()
    );
    if (!result.ok) {
      await pushText(
        client,
        groupId,
        "日時を読み取れませんでした。もう一度送るか、「修正」からやり直してください。"
      );
      return;
    }
    await pushText(client, groupId, formatDraftMessage(result.draft));
    return;
  }

  if (!isDraftCommand(text)) {
    return;
  }

  const quotedId = event.message.quotedMessageId;
  if (!quotedId) {
    await replyText(
      client,
      event.replyToken,
      "クライアントのメッセージに「返信」で、「下書きを作成する」を送ってください。"
    );
    return;
  }

  const quotedText = db.getGroupMessageText(quotedId);
  if (!quotedText) {
    await replyText(
      client,
      event.replyToken,
      "返信元のメッセージが見つかりません。ボット起動前の古いメッセージの可能性があります。"
    );
    return;
  }

  const { text: draftMsg } = createDraftFromQuote({
    ownerUserId: userId,
    sourceGroupId: groupId,
    quotedText,
  });

  await pushText(client, groupId, draftMsg);
}

async function handleDirectMessage(client, event, { text, userId }) {
  if (userId !== config.allowedLineUserId) {
    return;
  }

  if (isConfirmCommand(text)) {
    await handleConfirm(client, userId, userId);
    return;
  }

  const avail = parseAvailabilityCommand(text);
  if (avail) {
    await handleAvailability(client, userId, avail.period);
    return;
  }

  const delCalDm = parseDirectCalendarDeleteCommand(text);
  if (delCalDm) {
    const result = await deleteDirectCalendarEvent(delCalDm);
    await pushText(client, userId, result.message);
    return;
  }

  const direct = parseDirectCalendarCommand(text);
  if (direct) {
    const result = await registerDirectCalendarEvent(direct);
    await pushText(client, userId, result.message);
    return;
  }

  const reminder = parseReminderCommand(text);
  if (reminder) {
    await handleSetReminder(client, userId, "line", reminder);
    return;
  }

  const invoice = parseInvoiceCommand(text);
  if (invoice) {
    const result = await createInvoice(invoice).catch((e) => ({ ok: false, message: `請求書作成に失敗しました: ${e.message}` }));
    await pushText(client, userId, result.message);
    return;
  }

  const driveCmd = parseDriveSaveCommand(text);
  if (driveCmd) {
    await handleLineDriveSave(client, event, userId, driveCmd);
    return;
  }

  const expenseCheck = parseExpenseCheckCommand(text);
  if (expenseCheck) {
    await handleExpenseCheck(client, userId, expenseCheck.month);
    return;
  }

  const budgetSet = parseBudgetSetCommand(text);
  if (budgetSet) {
    await handleBudgetSet(client, userId, budgetSet.entries);
    return;
  }

  if (isBudgetCheckCommand(text)) {
    await pushText(client, userId, buildBudgetListMessage());
    return;
  }

  const manualExpense = parseManualExpenseCommand(text);
  if (manualExpense) {
    await handleManualExpense(client, userId, manualExpense);
    return;
  }

  if (isMfSyncCommand(text)) {
    await handleMfSync(client, userId);
    return;
  }

  if (isDraftCommand(text)) {
    await pushText(
      client,
      userId,
      "「下書きを作成する」は、クライアントのグループで、対象メッセージに返信して送ってください。"
    );
    return;
  }

  const fix = parseFixCommand(text);
  if (fix?.kind === "wait_next") {
    const draft = db.getActiveDraft(userId);
    if (!draft) {
      await pushText(
        client,
        userId,
        "有効な下書きがありません。先にグループで下書きを作成してください。"
      );
      return;
    }
    const until = Date.now() + config.correctionWaitMinutes * 60 * 1000;
    db.setAwaitingCorrection(draft.id, until);
    await pushText(
      client,
      userId,
      `修正内容を送ってください（${config.correctionWaitMinutes}分以内）。例：４月２０日２０時にして`
    );
    return;
  }

  if (fix?.kind === "apply") {
    const draft = db.getActiveDraft(userId);
    if (!draft) {
      await pushText(client, userId, "有効な下書きがありません。");
      return;
    }
    const result = applyCorrectionInstruction(draft, fix.instruction);
    if (!result.ok) {
      await pushText(
        client,
        userId,
        "日時を読み取れませんでした。もう一度、日付と時刻をはっきり書いて送ってください。"
      );
      return;
    }
    await pushText(client, userId, formatDraftMessage(result.draft));
    return;
  }

  const draft = db.getActiveDraft(userId);
  if (
    draft?.awaiting_correction_until &&
    draft.awaiting_correction_until > Date.now()
  ) {
    const result = applyCorrectionInstruction(draft, text.trim());
    if (!result.ok) {
      await pushText(
        client,
        userId,
        "日時を読み取れませんでした。もう一度送るか、「修正」からやり直してください。"
      );
      return;
    }
    await pushText(client, userId, formatDraftMessage(result.draft));
    return;
  }

  await pushText(
    client,
    userId,
    [
      "使い方:",
      "・グループ: 対象メッセージに返信して「下書きを作成する」→ このグループに下書きが出ます",
      "・グループ: 「カレンダー登録する」で Google カレンダーに登録",
      "・「カレンダー削除して」＋件名＋日時（登録と同じ3行）で予定を削除",
      "・「修正」→ 続けて日時などを送る、または「修正」改行＋内容",
      "",
      "💰 支出管理:",
      "・「支出確認」→ 今月のカテゴリ別支出",
      "・「先月の支出」→ 先月の集計",
      "・「予算確認」→ 予算と進捗",
      "・「予算設定\\n食費 30000\\n交通費 15000」→ 予算を設定",
      "・「支出 コーヒー 500」→ 支出を手動入力",
      "・「支出 食費 コーヒー 500」→ カテゴリ付きで入力",
      "・「MF同期」→ MoneyForwardから取込",
    ].join("\n")
  );
}

async function handleSetReminder(client, chatId, platform, { datetimeText, message }) {
  const range = parseDateTimeRange(datetimeText, new Date());
  if (!range) {
    await pushText(client, chatId, "日時を読み取れませんでした。例：４月２２日２０時");
    return;
  }
  await addReminder({ platform, chatId, remindAt: range.start.getTime(), message });
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: config.timeZone || "Asia/Tokyo",
    month: "long", day: "numeric", weekday: "short",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  await pushText(client, chatId, `⏰ ${fmt.format(range.start)} に「${message}」のリマインドを設定しました`);
}

async function handleAvailability(client, chatId, period) {
  try {
    const msg = await getFreeSlots({ period });
    await pushText(client, chatId, msg);
  } catch (e) {
    console.error(e);
    await pushText(
      client,
      chatId,
      `空きスケジュールの取得に失敗しました: ${e.message || e}`
    );
  }
}

async function handleConfirm(client, userId, chatId) {
  const draft = db.getActiveDraft(userId);
  if (!draft) {
    await pushText(client, chatId, "登録できる下書きがありません。");
    return;
  }

  if (
    !isUserChatId(chatId) &&
    draft.source_group_id &&
    draft.source_group_id !== chatId
  ) {
    await pushText(
      client,
      chatId,
      "このグループで作成した下書きではありません。下書きを作ったグループで「カレンダー登録する」を送ってください。"
    );
    return;
  }

  if (!draft.start_at || !draft.end_at) {
    await pushText(
      client,
      chatId,
      "開始・終了時刻が未設定です。「修正」で日時を指定してから、もう一度「カレンダー登録する」を送ってください。"
    );
    return;
  }

  const start = new Date(draft.start_at);
  const end = new Date(draft.end_at);

  try {
    const ev = await insertPrimaryCalendarEvent({
      summary: draft.title || "打合せ",
      description: [`元メッセージ:`, draft.quoted_text].join("\n"),
      start,
      end,
    });
    db.markDraftConfirmed(draft.id);
    const title = draft.title || "打合せ";
    const addLink = buildCalendarTemplateUrl(title, start, end);
    await pushText(
      client,
      chatId,
      [
        "Google カレンダーに登録しました。",
        `件名: ${title}`,
        `ご自身のGoogleカレンダーにも保存する: ${addLink}`,
      ].join("\n")
    );
  } catch (e) {
    console.error(e);
    await pushText(
      client,
      chatId,
      `カレンダー登録に失敗しました: ${e.message || e}\nGoogle の認証（token.json）を確認してください。`
    );
  }
}

// ─── 支出管理ハンドラ ─────────────────────────────────────────

async function handleExpenseCheck(client, chatId, monthKind) {
  const now = DateTime.now().setZone("Asia/Tokyo");
  let year, month;
  if (monthKind === "last") {
    const last = now.minus({ months: 1 });
    year = last.year;
    month = last.month;
  } else {
    year = now.year;
    month = now.month;
  }
  const msg = buildMonthlySummaryMessage(year, month);
  await pushText(client, chatId, msg);
}

async function handleBudgetSet(client, chatId, entries) {
  for (const { category, amount } of entries) {
    db.setBudget(category, amount);
  }
  const lines = ["✅ 予算を設定しました", ""];
  for (const { category, amount } of entries) {
    lines.push(`${category}: ¥${amount.toLocaleString("ja-JP")}/月`);
  }
  lines.push("", "「予算確認」で一覧を確認できます。");
  await pushText(client, chatId, lines.join("\n"));
}

async function handleManualExpense(client, chatId, { description, amount, category }) {
  const now = DateTime.now().setZone("Asia/Tokyo");
  db.upsertExpense({
    expenseDate: now.toISODate(),
    description,
    amount,
    category,
    source: "manual",
  });
  const msg = buildExpenseAddedMessage({ description, amount, category });
  await pushText(client, chatId, msg);
}

async function handleMfSync(client, chatId) {
  await pushText(client, chatId, "⏳ MoneyForwardからデータを取り込んでいます...\n（1〜2分かかる場合があります）");
  try {
    const result = await syncMoneyForwardExpenses({ headless: true });
    if (result.error) {
      await pushText(client, chatId, `❌ 同期に失敗しました\n${result.error}\n\n「npm run mf-login」で再ログインが必要な場合があります。`);
      return;
    }
    const now = DateTime.now().setZone("Asia/Tokyo");
    const summary = buildMonthlySummaryMessage(now.year, now.month);
    await pushText(
      client,
      chatId,
      `✅ MoneyForward同期完了\n取込: ${result.imported}件\n\n${summary}`
    );
  } catch (e) {
    await pushText(client, chatId, `❌ 同期エラー: ${e.message}`);
  }
}

// ─── LINE: Drive 保存ハンドラ ─────────────────────────────────

async function handleLineDriveSave(client, event, chatId, { company, month }) {
  const companyKey = resolveCompanyKey(company);
  if (!companyKey) {
    await pushText(client, chatId,
      `「${company}」は登録されていない会社名です。\n使用可能: ${listDriveCompanies().join(" / ")}`
    );
    return;
  }

  // 引用返信のファイルメッセージ ID を取得
  const quotedMsgId = event.message?.quotedMessageId;
  if (!quotedMsgId) {
    await pushText(client, chatId,
      "ファイルが含まれるメッセージに返信して「[会社名] ドライブ保存して [月]」と送ってください。"
    );
    return;
  }

  // LINE API からファイルをダウンロード
  let buffer, filename, mimeType;
  try {
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${quotedMsgId}/content`, {
      headers: { Authorization: `Bearer ${config.lineChannelAccessToken}` },
    });
    if (!res.ok) throw new Error(`LINE file fetch: ${res.status}`);
    mimeType = res.headers.get("content-type") || "application/octet-stream";
    const ext = mimeType.includes("pdf") ? ".pdf" : mimeType.includes("image") ? ".jpg" : "";
    filename = `file_${quotedMsgId}${ext}`;
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    await pushText(client, chatId, `ファイルのダウンロードに失敗しました: ${e.message}`);
    return;
  }

  // Drive に保存
  const { year, month: resolvedMonth } = resolveYearMonth(month);
  try {
    const link = await saveToDrive({ companyKey, year, month: resolvedMonth, filename, buffer, mimeType });
    await pushText(client, chatId,
      [
        "📁 Google Drive に保存しました。",
        `会社: ${company}`,
        `フォルダ: ${year}年${resolvedMonth}月`,
        `ファイル: ${filename}`,
        `リンク: ${link}`,
      ].join("\n")
    );
  } catch (e) {
    await pushText(client, chatId, `Drive への保存に失敗しました: ${e.message}`);
  }
}
