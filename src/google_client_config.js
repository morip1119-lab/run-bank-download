import fs from "node:fs";
import dotenv from "dotenv";

dotenv.config();

export const googleClientSecretPath =
  process.env.GOOGLE_CLIENT_SECRET_PATH || "client_secret.json";

/** `npm run google-auth` とトークン更新で共通のリダイレクト先 */
export const GOOGLE_OAUTH_REDIRECT_URI =
  process.env.GOOGLE_OAUTH_REDIRECT_URI || "http://127.0.0.1:8765/";

function parseInstalledOrWeb(json) {
  if (json.installed) {
    return {
      client_id: json.installed.client_id,
      client_secret: json.installed.client_secret,
      redirect_uris: json.installed.redirect_uris || [],
    };
  }
  if (json.web) {
    return {
      client_id: json.web.client_id,
      client_secret: json.web.client_secret,
      redirect_uris: json.web.redirect_uris || [],
    };
  }
  throw new Error(
    "client_secret に 'installed' または 'web' がありません。Google Cloud から JSON を取り直してください。"
  );
}

/**
 * client_secret.json は次のどちらか:
 * - デスクトップアプリ: { "installed": { ... } }
 * - ウェブアプリ: { "web": { ... } }
 *
 * 優先: 環境変数 GOOGLE_CLIENT_SECRET_JSON → ファイルパス
 */
export function readClientCredentials() {
  /** モジュール先頭で固定しない（Cloud Run のシークレット注入とのタイミング対策） */
  const raw = process.env.GOOGLE_CLIENT_SECRET_JSON?.trim();
  if (raw) {
    try {
      const json = JSON.parse(raw);
      return parseInstalledOrWeb(json);
    } catch (e) {
      throw new Error(
        `GOOGLE_CLIENT_SECRET_JSON のパースに失敗しました: ${e.message}`
      );
    }
  }

  if (!fs.existsSync(googleClientSecretPath)) {
    throw new Error(
      `Google クライアント秘密鍵がありません。次のいずれかを設定してください:\n` +
        `- 環境変数 GOOGLE_CLIENT_SECRET_JSON（client_secret.json と同じ内容）\n` +
        `- ファイル ${googleClientSecretPath}`
    );
  }
  const json = JSON.parse(fs.readFileSync(googleClientSecretPath, "utf8"));
  return parseInstalledOrWeb(json);
}
