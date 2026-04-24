/**
 * 初回のみ: client_secret.json をプロジェクト直下に置いて実行。
 *
 * npm run google-auth
 *
 * ローカルで http://127.0.0.1:8765/ を一時的に待ち受けます。
 *
 * ▼ リダイレクト URI の登録（重要）
 * 「デスクトップ」クライアントには URI 欄が出ないことがあります。
 * その場合は「ウェブアプリケーション」の OAuth クライアントを新規作成し、
 * 「承認済みのリダイレクト URI」に次を追加してから、JSON をダウンロードして
 * client_secret.json にしてください。
 *   http://127.0.0.1:8765/
 *   http://localhost:8765/
 */
import fs from "node:fs";
import http from "node:http";
import { exec } from "node:child_process";
import { google } from "googleapis";
import {
  readClientCredentials,
  GOOGLE_OAUTH_REDIRECT_URI,
} from "../src/google_client_config.js";

const SECRET_PATH = process.env.GOOGLE_CLIENT_SECRET_PATH || "client_secret.json";
const TOKEN_PATH = process.env.GOOGLE_TOKEN_PATH || "token.json";
const PORT = Number(process.env.GOOGLE_OAUTH_LOCAL_PORT || 8765);

const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/spreadsheets",
];

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url.replace(/"/g, '\\"')}"`
      : process.platform === "darwin"
        ? `open "${url.replace(/"/g, '\\"')}"`
        : `xdg-open "${url.replace(/"/g, '\\"')}"`;
  exec(cmd, () => {});
}

async function main() {
  let hangTimer;

  if (!fs.existsSync(SECRET_PATH)) {
    console.error(`見つかりません: ${SECRET_PATH}`);
    process.exit(1);
  }

  const { client_id, client_secret } = readClientCredentials();

  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    GOOGLE_OAUTH_REDIRECT_URI
  );

  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
    redirect_uri: GOOGLE_OAUTH_REDIRECT_URI,
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (err) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<p>エラー: ${err}</p><p>このウィンドウを閉じて、ターミナルを確認してください。</p>`
        );
        console.error("OAuth error:", err);
        clearTimeout(hangTimer);
        server.close();
        process.exit(1);
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end("<p>code がありません。</p>");
        return;
      }

      const { tokens } = await oAuth2Client.getToken(code);
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<html><body><p>認証に成功しました。このタブを閉じて、ターミナルに戻ってください。</p></body></html>"
      );
      console.log("");
      console.log(`保存しました: ${TOKEN_PATH}`);
      clearTimeout(hangTimer);
      server.close();
      process.exit(0);
    } catch (e) {
      console.error(e);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<p>サーバー側でエラーが発生しました。ターミナルを確認してください。</p>");
      clearTimeout(hangTimer);
      server.close();
      process.exit(1);
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(PORT, "127.0.0.1", () => resolve());
    server.on("error", reject);
  });

  console.log("");
  console.log("このリダイレクト URI を Google Cloud の OAuth クライアントに登録してください:");
  console.log(`  ${GOOGLE_OAUTH_REDIRECT_URI}`);
  console.log(`  （ウェブアプリケーション用クライアントの「承認済みのリダイレクト URI」欄）`);
  console.log("");
  console.log("ブラウザで認証ページを開きます…");
  console.log("（開かない場合は次の URL を手動で開いてください）");
  console.log(authUrl);
  console.log("");

  openBrowser(authUrl);

  hangTimer = setTimeout(() => {
    console.error(
      "タイムアウト（10分）: ブラウザで許可し、リダイレクトまで完了したか確認してください。"
    );
    try {
      server.close();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }, 10 * 60 * 1000);

  server.on("close", () => clearTimeout(hangTimer));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
