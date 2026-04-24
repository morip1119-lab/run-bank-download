/**
 * 入金管理ダッシュボード 認証モジュール
 *
 * 環境変数:
 *   PAYMENT_BURIZUMU_PASSWORD  - BURIZUMU ページのパスワード
 *   PAYMENT_TRYNNOX_PASSWORD   - TRYNNOX ページのパスワード
 *
 * パスワード未設定の場合はそのアカウントのページにアクセス不可
 */

import { randomUUID } from "node:crypto";

// アカウント定義
export const ACCOUNT_CONFIG = {
  BURIZUMU: {
    key:      "BURIZUMU",
    label:    "BURIZUMU",
    icon:     "🟣",
    color:    "#7c3aed",
    bgColor:  "#ede9fe",
    mfGroup:  () => process.env.MF_GROUP_BURIZUMU || "BURIZUMU",
    password: () => process.env.PAYMENT_BURIZUMU_PASSWORD || "",
    path:     "burizumu",
  },
  TRYNNOX: {
    key:      "TRYNNOX",
    label:    "Trynnox",
    icon:     "🔵",
    color:    "#0891b2",
    bgColor:  "#e0f2fe",
    mfGroup:  () => process.env.MF_GROUP_TRYNNOX || "Trynnox",
    password: () => process.env.PAYMENT_TRYNNOX_PASSWORD || "",
    path:     "trynnox",
  },
};

// ── インメモリセッション ───────────────────────────────────────────
// サーバー再起動でセッションはリセットされる（再ログインが必要）

const sessions = new Map(); // token → { accountKey, expiresAt }
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24時間
const COOKIE_NAME = "pm_session";

export function createSession(accountKey) {
  const token = randomUUID();
  sessions.set(token, {
    accountKey,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return s;
}

export function deleteSession(token) {
  sessions.delete(token);
}

// ── Cookie ヘルパー ───────────────────────────────────────────────

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header.split(";").map((c) => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), decodeURIComponent(v.join("="))];
    })
  );
}

export function setSessionCookie(res, token, path) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}_${path}=${token}; Path=/payment/${path}; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

export function clearSessionCookie(res, path) {
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}_${path}=; Path=/payment/${path}; HttpOnly; SameSite=Lax; Max-Age=0`
  );
}

// ── 認証ミドルウェア ──────────────────────────────────────────────

/**
 * 指定アカウントの認証チェックミドルウェアを生成する
 * 未認証の場合はログイン画面を返す（APIリクエストは401）
 */
export function requireAuth(accountConfig) {
  return (req, res, next) => {
    // パスワード未設定なら503
    if (!accountConfig.password()) {
      res.status(503).send(
        `<h2>⚠️ ${accountConfig.label} のパスワードが設定されていません</h2>` +
        `<p>.env に PAYMENT_${accountConfig.key}_PASSWORD を設定してください</p>`
      );
      return;
    }

    const cookies = parseCookies(req);
    const token   = cookies[`${COOKIE_NAME}_${accountConfig.path}`];
    const session = getSession(token);

    if (session && session.accountKey === accountConfig.key) {
      req.accountKey = accountConfig.key;
      next();
      return;
    }

    // API リクエストには 401 を返す
    if (req.path.startsWith("/api/")) {
      res.status(401).json({ ok: false, error: "認証が必要です" });
      return;
    }

    // HTML リクエストにはログイン画面を返す
    res.status(401).send(buildLoginHtml(accountConfig));
  };
}

// ── ログイン画面 HTML ─────────────────────────────────────────────

function buildLoginHtml(acc) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${acc.label} – 入金管理 ログイン</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f0f2f5;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      padding: 40px 36px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 4px 24px rgba(0,0,0,.1);
      text-align: center;
    }
    .icon { font-size: 48px; margin-bottom: 12px; }
    h1 { font-size: 20px; font-weight: 700; color: #1a202c; margin-bottom: 4px; }
    .sub { font-size: 13px; color: #718096; margin-bottom: 28px; }
    input[type="password"] {
      width: 100%;
      padding: 12px 14px;
      border: 1.5px solid #e2e8f0;
      border-radius: 10px;
      font-size: 16px;
      outline: none;
      letter-spacing: 2px;
      margin-bottom: 14px;
      transition: border-color .15s;
    }
    input[type="password"]:focus { border-color: ${acc.color}; }
    button {
      width: 100%;
      padding: 12px;
      background: ${acc.color};
      color: #fff;
      border: none;
      border-radius: 10px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity .15s;
    }
    button:hover { opacity: .88; }
    .error {
      margin-top: 12px;
      font-size: 13px;
      color: #dc2626;
      min-height: 18px;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">${acc.icon}</div>
    <h1>${acc.label}</h1>
    <div class="sub">入金管理ダッシュボード</div>
    <form method="POST" action="/payment/${acc.path}/login">
      <input type="password" name="password" placeholder="パスワードを入力" autofocus>
      <button type="submit">ログイン</button>
      <div class="error" id="err"></div>
    </form>
  </div>
  <script>
    const params = new URLSearchParams(location.search);
    if (params.get("error")) {
      document.getElementById("err").textContent = "パスワードが違います";
    }
  </script>
</body>
</html>`;
}
