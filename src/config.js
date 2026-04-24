import dotenv from "dotenv";

dotenv.config();

function required(name) {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required env: ${name}`);
  }
  return v;
}

export const config = {
  port: Number(process.env.PORT || 3000),
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET || "",
  lineChannelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || "",
  /** コマンドを打てる運用者（あなた）の userId */
  allowedLineUserId: process.env.ALLOWED_LINE_USER_ID || "",
  /** Google OAuth トークン保存先 */
  googleTokenPath: process.env.GOOGLE_TOKEN_PATH || "token.json",
  /** Google OAuth クライアントシークレット JSON パス */
  googleClientSecretPath:
    process.env.GOOGLE_CLIENT_SECRET_PATH || "client_secret.json",
  /** カレンダーに入れるタイムゾーン */
  timeZone: process.env.CALENDAR_TIMEZONE || "Asia/Tokyo",
  /** 日時が取れないときのデフォルト会議時間（分） */
  defaultDurationMinutes: Number(process.env.DEFAULT_DURATION_MINUTES || 60),
  /** 修正待ちの有効時間（分） */
  correctionWaitMinutes: Number(process.env.CORRECTION_WAIT_MINUTES || 15),
  sqlitePath: process.env.SQLITE_PATH || "data/app.db",
  /** Chatwork API トークン（秘書Bot アカウント） */
  chatworkApiToken: process.env.CHATWORK_API_TOKEN || "",
  /** Chatwork Webhook 署名検証トークン（任意） */
  chatworkWebhookToken: process.env.CHATWORK_WEBHOOK_TOKEN || "",
  /** Chatwork でコマンドを実行できるアカウント ID（森川さん個人） */
  chatworkAllowedAccountId: process.env.CHATWORK_ALLOWED_ACCOUNT_ID || "",
  /** /cron/remind エンドポイントの認証シークレット（Cloud Scheduler から送る） */
  cronSecret: process.env.CRON_SECRET || "",
  /** Misoca OAuth */
  misocaClientId: process.env.MISOCA_CLIENT_ID || "",
  misocaClientSecret: process.env.MISOCA_CLIENT_SECRET || "",
  misocaTokenPath: process.env.MISOCA_TOKEN_PATH || "misoca_token.json",
  /** 銀行入金通知先 Chatwork ルームID */
  bankNotifyRoomId: process.env.BANK_NOTIFY_ROOM_ID || "",
  /** 支払い管理スプレッドシート ID */
  paymentSheetId: process.env.PAYMENT_SHEET_ID || "",
  /** 受信請求書 PDF をアップロードする Google Drive フォルダ ID */
  keiriDriveFolderId: process.env.KEIRI_DRIVE_FOLDER_ID || "",
  /** 受信請求書チェックの通知先 Chatwork ルームID（任意） */
  invoiceNotifyRoomId: process.env.INVOICE_NOTIFY_ROOM_ID || "",
  /** IMAP 設定（keiri@misokoji.com など独自ドメインメール） */
  imapHost: process.env.IMAP_HOST || "",
  imapPort: Number(process.env.IMAP_PORT || 993),
  imapUser: process.env.IMAP_USER || "",
  imapPass: process.env.IMAP_PASS || "",
};
