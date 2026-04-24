import fs from "node:fs";
import { Firestore } from "@google-cloud/firestore";
import { config } from "./config.js";

const firestore = new Firestore();

const BASE_URL = "https://app.misoca.jp";
const TOKEN_URL = `${BASE_URL}/oauth2/token`;
const API_BASE = `${BASE_URL}/api/v3`;

// ── アカウント名 → 環境変数プレフィックス マッピング ──────────────
// コマンドで「アカウント: みそこうじ」のように指定する
export const ACCOUNT_ALIASES = {
  "burizumu":    "BURIZUMU",
  "Burizumu":    "BURIZUMU",
  "BURIZUMU":    "BURIZUMU",
  "ブリズム":    "BURIZUMU",
  "みそこうじ":  "MISOKOJI",
  "misokoji":    "MISOKOJI",
  "味噌麹":      "MISOKOJI",
  "trynnox":     "TRYNNOX",
  "Trynnox":     "TRYNNOX",
  "TRYNNOX":     "TRYNNOX",
};

/** 表示名 → 環境変数プレフィックスに変換（見つからなければ null） */
export function resolveAccountKey(name) {
  if (!name) return null;
  const n = name.trim();
  return ACCOUNT_ALIASES[n] ?? ACCOUNT_ALIASES[n.toLowerCase()] ?? null;
}

/** 利用可能なアカウント一覧を返す（設定済みのもののみ） */
export function listAvailableAccounts() {
  const keys = [...new Set(Object.values(ACCOUNT_ALIASES))];
  return keys.filter((k) => process.env[`MISOCA_${k}_ACCESS_TOKEN`]?.trim());
}

// ── トークン読み書き ────────────────────────────────────────────
// 優先順位: Firestore（最新リフレッシュ済み） > 環境変数 > ローカルファイル

function envPrefix(accountKey) {
  return accountKey ? `MISOCA_${accountKey}` : "MISOCA";
}

function tokenFilePath(accountKey) {
  if (!accountKey) return config.misocaTokenPath;
  const base = config.misocaTokenPath.replace(/\.json$/, "");
  return `${base}_${accountKey.toLowerCase()}.json`;
}

function firestoreDocId(accountKey) {
  return `misoca_token_${(accountKey || "default").toLowerCase()}`;
}

async function loadTokensFromFirestore(accountKey) {
  try {
    const doc = await firestore.collection("oauth_tokens").doc(firestoreDocId(accountKey)).get();
    if (doc.exists) return doc.data();
  } catch {
    // Firestore 読み込み失敗は無視してフォールバック
  }
  return null;
}

async function saveTokensToFirestore(tokens, accountKey) {
  try {
    await firestore.collection("oauth_tokens").doc(firestoreDocId(accountKey)).set({
      ...tokens,
      updatedAt: new Date().toISOString(),
    });
    console.log(`[misoca] トークンを Firestore に保存しました (${accountKey})`);
  } catch (e) {
    console.warn(`[misoca] Firestore へのトークン保存失敗: ${e.message}`);
  }
}

async function loadTokens(accountKey) {
  // 1. Firestore に最新トークンがあれば優先
  const cached = await loadTokensFromFirestore(accountKey);
  if (cached?.access_token && cached?.refresh_token) {
    return cached;
  }

  // 2. 環境変数
  const prefix = envPrefix(accountKey);
  const accessToken = process.env[`${prefix}_ACCESS_TOKEN`]?.trim();
  const refreshToken = process.env[`${prefix}_REFRESH_TOKEN`]?.trim();
  if (accessToken && refreshToken) {
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Number(process.env[`${prefix}_EXPIRES_AT`] || 0),
    };
  }

  // 3. ローカルファイル
  const path = tokenFilePath(accountKey);
  if (!fs.existsSync(path)) {
    const acctLabel = accountKey || "デフォルト";
    throw new Error(
      `Misoca トークンがありません（アカウント: ${acctLabel}）。\n` +
        `  npm run misoca-auth -- --account ${accountKey ?? "ACCOUNT_KEY"}  を実行してください。`
    );
  }
  return JSON.parse(fs.readFileSync(path, "utf8"));
}

async function saveTokens(tokens, accountKey) {
  // 常に Firestore に保存（Cloud Run でもローカルでも）
  await saveTokensToFirestore(tokens, accountKey);

  // ローカル環境ではファイルにも保存
  const prefix = envPrefix(accountKey);
  if (!process.env[`${prefix}_ACCESS_TOKEN`]?.trim()) {
    fs.writeFileSync(tokenFilePath(accountKey), JSON.stringify(tokens, null, 2));
  }
}

// ── トークンリフレッシュ ───────────────────────────────────────

async function refreshAccessToken(tokens, accountKey) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: config.misocaClientId,
      client_secret: config.misocaClientSecret,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Misoca トークンリフレッシュ失敗 ${res.status}: ${body}`);
  }
  const next = await res.json();
  const merged = { ...tokens, ...next };
  merged.expires_at = Date.now() + (next.expires_in ?? 86400) * 1000;
  await saveTokens(merged, accountKey);
  return merged;
}

// ── 認証済み API リクエスト ────────────────────────────────────

/**
 * @param {string} method
 * @param {string} path
 * @param {object|null} body
 * @param {string|null} accountKey  例: "MISOKOJI" | "TRYNNOX" | "YURAKU"
 */
export async function misocaRequest(method, path, body = null, accountKey = null) {
  let tokens = await loadTokens(accountKey);

  if (!tokens.expires_at || tokens.expires_at - Date.now() < 5 * 60 * 1000) {
    tokens = await refreshAccessToken(tokens, accountKey);
  }

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      "Content-Type": "application/json",
    },
    body: body !== null ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Misoca API ${method} ${path} → ${res.status}: ${err}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── PDF ダウンロード ───────────────────────────────────────────

/**
 * 請求書 PDF を Buffer で返す
 * @param {number|string} invoiceId
 * @param {string|null} accountKey
 * @returns {Promise<Buffer>}
 */
export async function misocaDownloadPdf(invoiceId, accountKey = null) {
  let tokens = await loadTokens(accountKey);
  if (!tokens.expires_at || tokens.expires_at - Date.now() < 5 * 60 * 1000) {
    tokens = await refreshAccessToken(tokens, accountKey);
  }

  const res = await fetch(`${API_BASE}/invoice/${invoiceId}/pdf`, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Misoca PDF ダウンロード失敗 ${res.status}: ${err}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

// ── 初回トークン保存（OAuth setup スクリプトから呼ぶ） ──────────

export async function storeInitialTokens(tokens, accountKey) {
  const data = {
    ...tokens,
    expires_at: Date.now() + (tokens.expires_in ?? 86400) * 1000,
  };
  await saveTokens(data, accountKey);
  const path = tokenFilePath(accountKey);
  console.log(`Misoca トークンを保存しました: ${path}`);
  if (accountKey) {
    console.log(`\n次の環境変数を Cloud Run に設定してください:`);
    console.log(`  MISOCA_${accountKey}_ACCESS_TOKEN=${data.access_token}`);
    console.log(`  MISOCA_${accountKey}_REFRESH_TOKEN=${data.refresh_token}`);
    console.log(`  MISOCA_${accountKey}_EXPIRES_AT=${data.expires_at}`);
  }
}
