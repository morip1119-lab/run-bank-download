/**
 * MoneyForward ME からログインして入出金CSVを自動取得する
 *
 * 環境変数:
 *   MONEYFORWARD_EMAIL     - ログインメールアドレス
 *   MONEYFORWARD_PASSWORD  - ログインパスワード
 *   MF_PROFILE_DIR         - ブラウザプロファイル保存先（省略時: data/mf_profile）
 *
 * ⚠️  初回または2FA が有効な場合は `npm run mf-login` で手動ログインが必要。
 *     プロファイルが保存されれば以降は headless で自動実行できる。
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";

const TZ = "Asia/Tokyo";
const MF_BASE = "https://moneyforward.com";
const LOGIN_URL = "https://id.moneyforward.com/sign_in";

// MisocaアカウントキーとMoneyForwardグループ名のマッピング
export const DEFAULT_ACCOUNT_GROUP_MAP = {
  BURIZUMU: process.env.MF_GROUP_BURIZUMU || "BURIZUMU",
  TRYNNOX:  process.env.MF_GROUP_TRYNNOX  || "Trynnox",
};

function profileDir() {
  const dir = process.env.MF_PROFILE_DIR || "data/mf_profile";
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}

// ── ログイン ─────────────────────────────────────────────────────

async function login(page) {
  const email    = process.env.MONEYFORWARD_EMAIL;
  const password = process.env.MONEYFORWARD_PASSWORD;
  if (!email || !password) {
    throw new Error("MONEYFORWARD_EMAIL / MONEYFORWARD_PASSWORD が設定されていません");
  }

  console.log("[mf] ログインページへ移動...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 20000 });

  // メールアドレス入力
  const emailSelectors = [
    'input[type="email"]',
    'input[name*="email"]',
    'input[id*="email"]',
    'input[placeholder*="メールアドレス"]',
    'input[placeholder*="mail"]',
  ];
  let emailInput = null;
  for (const sel of emailSelectors) {
    const el = page.locator(sel).first();
    if ((await el.count()) > 0) { emailInput = el; break; }
  }
  if (!emailInput) {
    await page.screenshot({ path: "data/mf_login_debug.png" }).catch(() => {});
    throw new Error("メールアドレス入力欄が見つかりません。data/mf_login_debug.png を確認してください");
  }
  await emailInput.fill(email);
  await page.click('input[type="submit"], button[type="submit"], button:has-text("ログイン"), button:has-text("次へ")');

  // パスワード入力
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.fill('input[type="password"]', password);
  await page.click('input[type="submit"], button[type="submit"], button:has-text("ログイン")');

  // ログイン完了待ち
  await page.waitForURL(
    (url) => url.hostname === "moneyforward.com" && !url.pathname.startsWith("/sign"),
    { timeout: 30000 }
  );
  console.log("[mf] ログイン成功");
}

// ── ログイン済み確認 ──────────────────────────────────────────────

/**
 * /cf を開き、必要に応じてアカウント選択・ログインを処理して
 * moneyforward.com/cf にたどり着くまで繰り返す
 */
async function ensureLoggedIn(page) {
  for (let attempt = 0; attempt < 5; attempt++) {
    console.log(`[mf] /cf アクセス試行 ${attempt + 1}...`);
    const response = await page.goto(`${MF_BASE}/cf`, {
      waitUntil: "domcontentloaded",
      timeout: 25000,
    }).catch(() => null);

    const currentUrl = page.url();
    const status = response?.status() ?? 0;
    console.log(`[mf] status=${status}, url=${currentUrl}`);

    // ✅ CF ページに到達
    if (currentUrl.includes("moneyforward.com/cf") && status !== 403) {
      console.log("[mf] /cf 到達");
      return;
    }

    // ── アカウント選択画面 ──
    if (currentUrl.includes("account_selector")) {
      console.log("[mf] アカウント選択画面 → フォームを送信");
      // form[action*="/oauth/authorize"] の中の button をクリックして OAuth 認可を進める
      const submitBtn = page.locator('form[action*="/oauth/authorize"] button').first();
      if ((await submitBtn.count()) > 0) {
        await submitBtn.click();
      } else {
        // フォールバック: 最初のボタンをクリック
        await page.locator('button').first().click().catch(() => {});
      }
      await page.waitForURL(
        (url) => url.hostname === "moneyforward.com",
        { timeout: 20000 }
      ).catch(() => {});
      await page.waitForTimeout(1500);
      continue;
    }

    // ── OAuth 認可画面 ──
    if (currentUrl.includes("/oauth/authorize") || currentUrl.includes("/auth/")) {
      console.log("[mf] OAuth 認可 → 自動リダイレクト待ち");
      await page.waitForURL(
        (url) => url.hostname === "moneyforward.com",
        { timeout: 20000 }
      ).catch(() => {});
      continue;
    }

    // ── ログインページ ──
    if (currentUrl.includes("/sign_in")) {
      console.log("[mf] ログインページ → 自動ログイン");
      await login(page);
      continue;
    }

    // ── 403 ──
    if (status === 403) {
      console.log("[mf] 403 → OAuth フロー再開");
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
      await page.waitForURL(
        (url) => url.hostname === "moneyforward.com",
        { timeout: 15000 }
      ).catch(() => {});
      continue;
    }

    // その他: 少し待って再試行
    console.log("[mf] 予期しない状態 → 2秒後に再試行");
    await page.waitForTimeout(2000);
  }

  const finalUrl = page.url();
  if (!finalUrl.includes("moneyforward.com/cf")) {
    throw new Error(`/cf への到達に失敗しました (url=${finalUrl})`);
  }
}

// ── グループ選択 ──────────────────────────────────────────────────

async function selectGroup(page, groupName) {
  if (!groupName) return;
  console.log(`[mf] グループ選択: "${groupName}"`);

  // ネイティブ <select> 要素
  const selectEl = page.locator("select").filter({
    has: page.locator(`option:has-text("${groupName}")`),
  });
  if ((await selectEl.count()) > 0) {
    await selectEl.first().selectOption({ label: groupName });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    console.log(`[mf] グループ選択完了（select）: "${groupName}"`);
    return;
  }

  // カスタムドロップダウン
  const trigger = page.locator([
    'button:has-text("個人用")',
    'button:has-text("グループ")',
    '[class*="group"][class*="select"]',
    '[class*="group-selector"]',
    '[data-testid*="group"]',
  ].join(", ")).first();
  if ((await trigger.count()) > 0) {
    await trigger.click();
    await page.waitForTimeout(500);
  }

  const option = page.locator(`li:has-text("${groupName}"), a:has-text("${groupName}")`).first();
  if ((await option.count()) > 0) {
    await option.click();
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    console.log(`[mf] グループ選択完了（ドロップダウン）: "${groupName}"`);
    return;
  }

  console.warn(`[mf] グループ "${groupName}" が見つかりませんでした。全取引で取得します`);
}

// ── CSV ダウンロード（単一グループ） ──────────────────────────────

async function fetchCsvForGroup(page, context, groupName, dateFrom, dateTo) {
  console.log(`[mf] CF ページへ移動中...`);

  const response = await page.goto(`${MF_BASE}/cf`, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });

  if (response?.status() === 403) {
    throw new Error("/cf が 403 Forbidden です。`npm run mf-login` でログインし直してください。");
  }

  // SPA 描画待ち
  await page.waitForSelector(
    "table, .cf-calendar, .kakeibo-list, nav, [class*='transaction']",
    { timeout: 15000 }
  ).catch(() => {});
  await page.waitForTimeout(2000);

  // グループ選択
  await selectGroup(page, groupName);
  await page.waitForTimeout(1500);

  // CSV リンクを探してクリックでダウンロード
  const csvLinkLocator = page.locator('a[href*="/cf/csv"], a[href*="/cf/export"]').first();
  const csvLinkCount = await csvLinkLocator.count();

  if (csvLinkCount > 0) {
    const csvHref = await csvLinkLocator.getAttribute("href");
    console.log(`[mf] CSV リンク発見: ${csvHref}`);

    // URL に日付パラメータを付与
    const csvUrl = new URL(csvHref, MF_BASE);
    csvUrl.searchParams.set("from", dateFrom.replaceAll("-", "/"));
    csvUrl.searchParams.set("to", dateTo.replaceAll("-", "/"));
    const finalCsvUrl = csvUrl.toString();
    console.log(`[mf] CSV URL: ${finalCsvUrl}`);

    // ネットワークインターセプトで CSV レスポンスをキャプチャ
    let csvBuffer = null;
    const responseHandler = async (response) => {
      if (response.url().includes("/cf/csv") || response.url().includes("/cf/export")) {
        const ct = response.headers()["content-type"] ?? "";
        if (!ct.includes("html")) {
          try {
            csvBuffer = await response.body();
            console.log(`[mf] CSV レスポンスをキャプチャ (${csvBuffer.length} bytes, ${ct})`);
          } catch {
            // ignore
          }
        }
      }
    };
    page.on("response", responseHandler);

    // まず hidden リンクの href を更新してから JS click
    await page.evaluate(
      ({ from, to }) => {
        const links = Array.from(document.querySelectorAll('a[href*="/cf/csv"], a[href*="/cf/export"]'));
        links.forEach((a) => {
          const url = new URL(a.href, location.origin);
          url.searchParams.set("from", from);
          url.searchParams.set("to", to);
          a.href = url.toString();
        });
      },
      { from: dateFrom.replaceAll("-", "/"), to: dateTo.replaceAll("-", "/") }
    );

    // JS click (download イベントまたはネットワークキャプチャで取得)
    const [download] = await Promise.all([
      context.waitForEvent("download", { timeout: 20000 }).catch(() => null),
      page.evaluate(() => {
        const a = document.querySelector('a[href*="/cf/csv"], a[href*="/cf/export"]');
        if (a) a.click();
      }),
    ]);

    page.off("response", responseHandler);

    if (download) {
      console.log(`[mf] ダウンロードイベントで取得`);
      return decodeMoneyForwardCsv(await streamToBuffer(download));
    }
    if (csvBuffer) {
      console.log(`[mf] ネットワークキャプチャで取得`);
      return decodeMoneyForwardCsv(csvBuffer);
    }

    console.warn("[mf] JS click でも取得不可 → 直接 fetch() を試みます");

    // 最終手段: ページ内 fetch() → ArrayBuffer → base64 でNode.jsに渡す
    const csvBase64 = await page.evaluate(async (url) => {
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) return null;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("html")) return null;
      const buf = await res.arrayBuffer();
      // ArrayBuffer → base64 変換
      const bytes = new Uint8Array(buf);
      let binary = "";
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      return btoa(binary);
    }, finalCsvUrl);

    if (csvBase64) {
      console.log(`[mf] fetch() で取得`);
      return decodeMoneyForwardCsv(Buffer.from(csvBase64, "base64"));
    }
  }

  // フォールバック: すべての CSV 関連ボタン・リンクを検索
  console.log("[mf] /cf/csv リンク未発見 → CSV ボタンを検索");

  const allLinks = await page.evaluate(() =>
    Array.from(document.querySelectorAll("a, button"))
      .filter((el) => el.textContent.trim())
      .map((el) => ({ tag: el.tagName, text: el.textContent.trim().slice(0, 30), href: el.href || "" }))
      .filter((el) => /csv|download|ダウンロード|出力|エクスポート/i.test(el.text + el.href))
  ).catch(() => []);
  console.log("[mf] CSV関連要素:", JSON.stringify(allLinks));

  const csvBtn = page.locator([
    'a:has-text("CSV")',
    'button:has-text("CSV")',
    'a:has-text("ダウンロード")',
    'a:has-text("出力")',
    '[class*="csv"]',
  ].join(", ")).first();

  if ((await csvBtn.count()) === 0) {
    await page.screenshot({ path: "data/mf_debug.png", fullPage: true }).catch(() => {});
    throw new Error(
      `CSVダウンロードボタンが見つかりません（グループ: ${groupName || "なし"}）。` +
      " data/mf_debug.png を確認してください。"
    );
  }

  const [download] = await Promise.all([
    context.waitForEvent("download", { timeout: 40000 }),
    csvBtn.click(),
  ]);
  console.log(`[mf] ダウンロード成功`);
  return decodeMoneyForwardCsv(await streamToBuffer(download));
}

async function streamToBuffer(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ── メイン: 複数グループCSV一括取得 ─────────────────────────────

/**
 * Misocaアカウントとマネーフォワードグループを対応させてCSVを取得する
 *
 * @param {{
 *   from?: string,
 *   to?: string,
 *   accountGroupMap?: Record<string, string>,
 *   headless?: boolean,
 * }} options
 * @returns {Promise<Record<string, string|null>>}
 */
export async function fetchMoneyForwardCsvByAccount({
  from,
  to,
  accountGroupMap = DEFAULT_ACCOUNT_GROUP_MAP,
  headless = true,
} = {}) {
  const now = DateTime.now().setZone(TZ);
  const dateFrom = from || now.minus({ months: 1 }).startOf("month").toISODate();
  const dateTo   = to   || now.toISODate();

  console.log(`[mf] 一括CSV取得: ${dateFrom} 〜 ${dateTo}`);
  console.log(`[mf] 対象グループ:`, accountGroupMap);

  const dir = profileDir();
  console.log(`[mf] ブラウザプロファイル: ${dir}`);

  const context = await chromium.launchPersistentContext(dir, {
    headless,
    locale: "ja-JP",
    timezoneId: TZ,
    viewport: { width: 1280, height: 800 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-infobars",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const page = await context.newPage();
  const results = {};

  try {
    await ensureLoggedIn(page);

    for (const [accountKey, groupName] of Object.entries(accountGroupMap)) {
      try {
        const csv = await fetchCsvForGroup(page, context, groupName, dateFrom, dateTo);
        results[accountKey] = csv;
        console.log(`[mf] ✅ ${accountKey}(${groupName}): CSV取得成功`);
      } catch (e) {
        console.error(`[mf] ❌ ${accountKey}(${groupName}): ${e.message}`);
        results[accountKey] = null;
      }
    }
  } finally {
    await context.close();
  }

  return results;
}

// 後方互換: 旧シグネチャ（グループなし・全取引）
export async function fetchMoneyForwardCsv({ from, to, headless = true } = {}) {
  const now = DateTime.now().setZone(TZ);
  const dateFrom = from || now.startOf("month").toISODate();
  const dateTo   = to   || now.toISODate();

  const dir = profileDir();
  const context = await chromium.launchPersistentContext(dir, {
    headless,
    locale: "ja-JP",
    timezoneId: TZ,
    args: ["--no-sandbox"],
  });
  const page = await context.newPage();
  try {
    await ensureLoggedIn(page);
    return await fetchCsvForGroup(page, context, null, dateFrom, dateTo);
  } finally {
    await context.close();
  }
}

// ── 文字コード変換 ────────────────────────────────────────────────

function decodeMoneyForwardCsv(buffer) {
  if (typeof buffer === "string") return buffer;
  try {
    const sjis = new TextDecoder("shift_jis").decode(buffer);
    if (/[\u3000-\u9FFF]/.test(sjis)) return sjis;
  } catch {
    // ignore
  }
  return new TextDecoder("utf-8").decode(buffer);
}

// ── 手動ログイン補助 ──────────────────────────────────────────────

/**
 * ブラウザを表示して手動でログインし、プロファイルを保存する
 * 2FA が設定されている場合や初回セットアップに使用する
 *
 * 使い方: npm run mf-login
 */
export async function manualLoginAndSaveSession() {
  const dir = profileDir();
  console.log("ブラウザを開きます。マネーフォワード ME にログインしてください...");
  console.log(`ブラウザプロファイル保存先: ${dir}`);

  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    locale: "ja-JP",
    timezoneId: TZ,
    viewport: { width: 1280, height: 800 },
    args: ["--no-sandbox"],
  });

  const page = await context.newPage();
  await page.goto(`${MF_BASE}/cf`, { waitUntil: "domcontentloaded" });

  console.log("ブラウザでマネーフォワード ME にログインしてください。");
  console.log("ログイン後、家計簿ページ (moneyforward.com/cf) が表示されたら自動で保存されます。");

  await new Promise((resolve) => {
    process.stdin.once("data", resolve);
    (async () => {
      try {
        await page.waitForURL(
          (url) => url.hostname === "moneyforward.com" && url.pathname.startsWith("/cf"),
          { timeout: 180000 }
        );
        // ページが描画されるまで待つ
        await page.waitForSelector("nav, header, table, .kakeibo, [class*='cf-']", {
          timeout: 15000,
        }).catch(() => {});
        await page.waitForTimeout(2000);
        resolve();
      } catch {
        resolve();
      }
    })();
  });

  console.log(`✅ ブラウザプロファイルを保存しました: ${dir}`);
  await context.close();
}
