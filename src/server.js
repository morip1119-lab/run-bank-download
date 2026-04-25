import express from "express";
import { middleware, messagingApi } from "@line/bot-sdk";
import { config } from "./config.js";
import { handleWebhookEvent } from "./handlers.js";
import { handleChatworkMessage } from "./chatwork_handlers.js";
import { verifyChatworkSignature, sendMessage as cwSendMessage } from "./chatwork_client.js";
import { getDb } from "./db.js";
import { getDueReminders, markReminderSent, markReminderFailed } from "./reminder_store.js";
import { checkYesterdayBankDeposits, buildDepositMessage } from "./bank_service.js";
import { processIncomingInvoices } from "./incoming_invoice_service.js";
import paymentRouter from "./payment_routes.js";
import { syncMoneyForwardExpenses, buildMonthlySummaryMessage, buildAlertMessage } from "./expense_service.js";
import { DateTime } from "luxon";

getDb();

const client = new messagingApi.MessagingApiClient({
  channelAccessToken: config.lineChannelAccessToken,
});

const app = express();

/** どの URL に何が来たか確認用（検証ボタンで POST が届くか見る） */
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.url}`);
  next();
});

app.get("/health", (_req, res) => {
  res.status(200).send("ok");
});

app.use("/payment", paymentRouter);

/** ブラウザで Webhook URL を開いたとき用（LINE 本体は POST） */
app.get(["/callback", "/callback/"], (_req, res) => {
  res
    .status(200)
    .type("text/plain; charset=utf-8")
    .send(
      "この URL は LINE からの POST Webhook 用です。検証は LINE Developers の「検証」ボタンを使ってください。"
    );
});

const lineWebhook = [
  "/callback",
  "/callback/",
];

app.post(
  lineWebhook,
  ...(config.lineChannelSecret
    ? [middleware({ channelSecret: config.lineChannelSecret })]
    : [express.json()]),
  async (req, res) => {
    const events = req.body?.events ?? [];
    if (process.env.LOG_WEBHOOK_EVENTS === "1") {
      console.log("[LINE webhook] raw body:", JSON.stringify(req.body, null, 2));
      for (const ev of events) {
        const uid = ev.source?.userId;
        if (uid) {
          console.log("[LINE webhook] source.userId =", uid);
        }
      }
    }
    try {
      await Promise.all(events.map((ev) => handleWebhookEvent(client, ev)));
    } catch (e) {
      console.error(e);
      res.status(500).end();
      return;
    }
    res.status(200).end();
  }
);

/** Chatwork Webhook - raw body を保持して署名検証に使う */
app.post(
  "/cw/callback",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const rawBody = req.body instanceof Buffer ? req.body.toString("utf8") : "";
    const sig = req.query.chatwork_webhook_signature
      ?? req.headers["x-chatworkwebhooksignature"]
      ?? "";
    if (!verifyChatworkSignature(rawBody, sig)) {
      console.warn("[cw] signature verification failed sig=%s", sig.slice(0, 20));
      res.status(401).end();
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.status(400).end();
      return;
    }
  const { webhook_event_type: eventType, webhook_event: event } = parsed ?? {};
  if ((eventType === "message_created" || eventType === "mention_to_me") && event) {
    try {
      await handleChatworkMessage(event);
    } catch (e) {
      console.error("[cw] handler error:", e);
    }
  }
    res.status(200).end();
  }
);

/** リマインド実行 - Cloud Scheduler から毎分呼ばれる */
app.post("/cron/remind", express.json(), async (req, res) => {
  if (config.cronSecret) {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${config.cronSecret}`) {
      res.status(401).end();
      return;
    }
  }

  let due;
  try {
    due = await getDueReminders();
  } catch (e) {
    console.error("[remind] getDueReminders failed:", e.message);
    res.status(500).end();
    return;
  }

  for (const r of due) {
    try {
      const text = `⏰ リマインド：${r.message}`;
      if (r.platform === "line") {
        await client.pushMessage({ to: r.chatId, messages: [{ type: "text", text }] });
      } else if (r.platform === "chatwork") {
        await cwSendMessage(r.chatId, text);
      }
      await markReminderSent(r.id);
      console.log(`[remind] sent id=${r.id} platform=${r.platform} chat=${r.chatId}`);
    } catch (e) {
      console.error(`[remind] failed id=${r.id}:`, e.message);
      await markReminderFailed(r.id);
    }
  }
  res.status(200).json({ processed: due.length });
});

/** 銀行入金チェック - Cloud Scheduler から毎朝10時に呼ばれる */
app.post("/cron/bank-check", express.json(), async (req, res) => {
  if (config.cronSecret) {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${config.cronSecret}`) {
      res.status(401).end();
      return;
    }
  }
  if (!config.bankNotifyRoomId) {
    res.status(500).json({ ok: false, error: "BANK_NOTIFY_ROOM_ID not set" });
    return;
  }

  try {
    const deposits = await checkYesterdayBankDeposits();
    if (deposits.length > 0) {
      const msg = buildDepositMessage(deposits);
      await cwSendMessage(config.bankNotifyRoomId, msg);
      console.log(`[bank-check] sent ${deposits.length} deposit notification(s)`);
    } else {
      console.log("[bank-check] no matching deposits yesterday");
    }
    res.json({ ok: true, count: deposits.length });
  } catch (e) {
    console.error("[bank-check] error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 受信請求書チェック - Cloud Scheduler から定期的に呼ばれる（例: 1時間ごと） */
app.post("/cron/check-invoices", express.json(), async (req, res) => {
  if (config.cronSecret) {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${config.cronSecret}`) {
      res.status(401).end();
      return;
    }
  }

  if (!config.paymentSheetId || !config.keiriDriveFolderId) {
    res.status(500).json({
      ok: false,
      error: "PAYMENT_SHEET_ID または KEIRI_DRIVE_FOLDER_ID が未設定です",
    });
    return;
  }

  try {
    const result = await processIncomingInvoices();

    // 処理件数が1件以上あれば Chatwork 通知（任意）
    if (result.processed > 0 && config.invoiceNotifyRoomId) {
      const msg = [
        `📄 受信請求書を自動処理しました`,
        `処理: ${result.processed} 件 / スキップ: ${result.skipped} 件 / エラー: ${result.errors} 件`,
        `スプレッドシートと Google Drive を確認してください。`,
      ].join("\n");
      await cwSendMessage(config.invoiceNotifyRoomId, msg);
    }

    res.json({ ok: true, ...result });
  } catch (e) {
    console.error("[check-invoices] error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * 支出同期 + 予算アラート - Cloud Scheduler から毎日呼ばれる（例: 毎朝 8時）
 * POST /cron/expense-sync
 */
app.post("/cron/expense-sync", express.json(), async (req, res) => {
  if (config.cronSecret) {
    const auth = req.headers["authorization"] ?? "";
    if (auth !== `Bearer ${config.cronSecret}`) {
      res.status(401).end();
      return;
    }
  }

  const lineUserId = config.allowedLineUserId;
  if (!lineUserId) {
    res.status(500).json({ ok: false, error: "ALLOWED_LINE_USER_ID が未設定です" });
    return;
  }

  try {
    // MoneyForward から同期
    const result = await syncMoneyForwardExpenses({ headless: true });
    console.log(`[expense-sync] imported=${result.imported} error=${result.error ?? "none"}`);

    const now = DateTime.now().setZone("Asia/Tokyo");

    if (result.error) {
      await client.pushMessage({
        to: lineUserId,
        messages: [{ type: "text", text: `⚠️ MoneyForward同期エラー\n${result.error}` }],
      });
      res.json({ ok: false, error: result.error });
      return;
    }

    // 予算アラートをチェック
    const alertMsg = buildAlertMessage(now.year, now.month);
    if (alertMsg) {
      await client.pushMessage({
        to: lineUserId,
        messages: [{ type: "text", text: alertMsg }],
      });
    }

    // 月初（1日）は月次サマリーも送る
    if (now.day === 1) {
      const last = now.minus({ months: 1 });
      const summaryMsg = buildMonthlySummaryMessage(last.year, last.month);
      await client.pushMessage({
        to: lineUserId,
        messages: [{ type: "text", text: `📊 先月の支出レポート\n\n${summaryMsg}` }],
      });
    }

    res.json({ ok: true, imported: result.imported, alerted: !!alertMsg });
  } catch (e) {
    console.error("[expense-sync] error:", e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

/** 署名エラーなど（404 ではなく 4xx/5xx で返る想定） */
app.use((err, _req, res, _next) => {
  console.error("[webhook error]", err?.message || err);
  if (res.headersSent) return;
  const status = err?.statusCode || 500;
  res.status(status).end();
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`listening on http://127.0.0.1:${config.port} (PORT=${config.port})`);
  console.log(
    "ngrok はこの PORT に合わせてください。例: ngrok http " + config.port
  );
});
