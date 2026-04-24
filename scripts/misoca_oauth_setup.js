/**
 * 初回のみ実行: Misoca OAuth 認証
 *
 *   npm run misoca-auth
 *
 * ブラウザが開くので Misoca にログインして許可してください。
 * 完了後 misoca_token.json が作成されます。
 */
import http from "node:http";
import { exec } from "node:child_process";
import { storeInitialTokens } from "../src/misoca_client.js";
import { config } from "../src/config.js";

// --account KEY で指定（例: node scripts/misoca_oauth_setup.js --account MISOKOJI）
const accountArg = process.argv.indexOf("--account");
const ACCOUNT_KEY = accountArg !== -1 ? process.argv[accountArg + 1]?.toUpperCase() : null;

const CLIENT_ID = config.misocaClientId;
const CLIENT_SECRET = config.misocaClientSecret;
const REDIRECT_URI = "http://127.0.0.1:8765/misoca_callback";
const PORT = 8765;

const AUTH_URL =
  `https://app.misoca.jp/oauth2/authorize` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=write`;

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url.replace(/"/g, '\\"')}"`
      : process.platform === "darwin"
        ? `open "${url.replace(/"/g, '\\"')}"`
        : `xdg-open "${url.replace(/"/g, '\\"')}"`;
  exec(cmd, () => {});
}

async function exchangeCode(code) {
  const res = await fetch("https://app.misoca.jp/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`トークン取得失敗 ${res.status}: ${body}`);
  }
  return res.json();
}

async function main() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://127.0.0.1:${PORT}`);
    if (!url.pathname.includes("misoca_callback")) {
      res.writeHead(404).end();
      return;
    }

    const err = url.searchParams.get("error");
    const code = url.searchParams.get("code");

    if (err) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<p>エラー: ${err}</p>`);
      server.close();
      process.exit(1);
      return;
    }
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end("<p>code がありません</p>");
      return;
    }

    try {
      const tokens = await exchangeCode(code);
      await storeInitialTokens(tokens, ACCOUNT_KEY);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      const label = ACCOUNT_KEY ? ` (${ACCOUNT_KEY})` : "";
      res.end(
        `<html><body><p>Misoca 認証に成功しました${label}。このタブを閉じて、ターミナルに戻ってください。</p></body></html>`
      );
      console.log(`認証完了！${ACCOUNT_KEY ? ` アカウント: ${ACCOUNT_KEY}` : ""}`);
      server.close();
      process.exit(0);
    } catch (e) {
      console.error(e);
      res.writeHead(500, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<p>エラー: ${e.message}</p>`);
      server.close();
      process.exit(1);
    }
  });

  await new Promise((resolve, reject) => {
    server.listen(PORT, "127.0.0.1", resolve);
    server.on("error", reject);
  });

  const label = ACCOUNT_KEY ? ` [${ACCOUNT_KEY}]` : "";
  console.log(`ブラウザで Misoca 認証ページを開きます${label}...`);
  console.log("（開かない場合は次の URL を手動で開いてください）");
  console.log(AUTH_URL);
  openBrowser(AUTH_URL);

  setTimeout(() => {
    console.error("タイムアウト（10分）");
    server.close();
    process.exit(1);
  }, 10 * 60 * 1000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
