/**
 * 住信SBIネット銀行 入出金明細 CSV 一括ダウンロード
 *
 * 目的別口座を含む全口座の前月分明細を自動でダウンロードし
 * downloads/YYYY-MM/ フォルダに保存します。
 *
 * 使い方:
 *   npm run sumishin-download
 *   または
 *   node scripts/download_sumishin_csv.js
 *
 * 環境変数（.env に設定）:
 *   SUMISHIN_SBI_LOGIN_ID   - ログインID（契約者番号）
 *   SUMISHIN_SBI_PASSWORD   - ログインパスワード
 *   SUMISHIN_DOWNLOAD_DIR   - 保存先フォルダ（省略時: downloads）
 *   SUMISHIN_HEADLESS       - 1 にすると非表示モード（省略時: 0 = ブラウザ表示あり）
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import dotenv from "dotenv";
import { google } from "googleapis";
import { readClientCredentials, GOOGLE_OAUTH_REDIRECT_URI } from "../src/google_client_config.js";

dotenv.config();

const TZ = "Asia/Tokyo";
const LOGIN_URL =
  "https://www.netbk.co.jp/contents/pages/wpl010101E/i010101CT/DI01010240";
const PROFILE_DIR =
  process.env.SUMISHIN_PROFILE_DIR || "data/sumishin_profile";
const DOWNLOAD_BASE = process.env.SUMISHIN_DOWNLOAD_DIR || "downloads";
const HEADLESS = process.env.SUMISHIN_HEADLESS === "1";
const DEBUG_DIR = "data";

// ── 日付範囲計算 ─────────────────────────────────────────────────────

function getPrevMonthRange() {
  const now = DateTime.now().setZone(TZ);
  const start = now.minus({ months: 1 }).startOf("month");
  const end = now.minus({ months: 1 }).endOf("month");
  return {
    from: start,
    to: end,
    label: start.toFormat("yyyy-MM"),
    displayYear: start.year,
    displayMonth: start.month,
  };
}

// ── ブラウザ起動 ─────────────────────────────────────────────────────

async function launchBrowser() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  const context = await chromium.launchPersistentContext(
    path.resolve(PROFILE_DIR),
    {
      headless: HEADLESS,
      locale: "ja-JP",
      timezoneId: TZ,
      viewport: { width: 1280, height: 900 },
      acceptDownloads: true,
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
    }
  );
  return context;
}

// ── ログイン（2ステップ対応） ────────────────────────────────────
// 住信SBIネット銀行の個人口座ログインは
//   ステップ1: ログインID（契約者番号）入力 → 送信
//   ステップ2: パスワード入力 → 送信
// という2ページ構成になっている

async function login(page) {
  const loginId = process.env.SUMISHIN_SBI_LOGIN_ID;
  const password = process.env.SUMISHIN_SBI_PASSWORD;
  if (!loginId || !password) {
    throw new Error(
      "SUMISHIN_SBI_LOGIN_ID / SUMISHIN_SBI_PASSWORD が .env に設定されていません"
    );
  }

  console.log("[sumishin] ログインページへ移動...");
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(2000);

  // ── ステップ1: ログインID入力 ──
  console.log("[sumishin] ステップ1: ログインIDを入力...");

  // ページ内の全 input を JS で検査し、検索バーを除外してログイン欄を特定する
  // （getByLabel や input[type=text] などの広いセレクターは検索バーに誤ヒットするため）
  const loginInputInfo = await page.evaluate(() => {
    const inputs = Array.from(
      document.querySelectorAll('input[type="text"], input[type="email"], input:not([type])')
    );
    const results = inputs
      .filter((el) => el.offsetParent !== null) // 非表示を除く
      .map((el) => ({
        id: el.id,
        name: el.name,
        type: el.type,
        placeholder: el.placeholder,
        value: el.value,
        top: Math.round(el.getBoundingClientRect().top),
      }));
    return results;
  });
  console.log("[sumishin] 画面上の全inputフィールド:", JSON.stringify(loginInputInfo));

  // 検索バー（name=query など）と header 内のフィールドを除外して最初の候補を選ぶ
  const candidate = loginInputInfo.find((f) => {
    const n = (f.name || "").toLowerCase();
    const p = (f.placeholder || "").toLowerCase();
    return (
      !n.includes("query") &&
      !n.includes("search") &&
      !p.includes("検索") &&
      f.top > 100 // ヘッダー（上部100px以内）を除く
    );
  });

  if (!candidate) {
    await debugShot(page, "login_no_id_field");
    throw new Error(
      "ログインID入力欄が特定できません（data/sumishin_debug_login_no_id_field.png を確認）\n" +
      "全フィールド: " + JSON.stringify(loginInputInfo)
    );
  }

  console.log("[sumishin] ログインID入力欄を特定:", candidate);

  // 特定した input を選択
  // ※ Angularカスタムコンポーネント（nb-ren-input-placeholder等）が同じidを持つ場合に
  //   コンポーネント本体を掴まないよう input タグに限定する
  const idSelector = candidate.name
    ? `input[name="${candidate.name}"]`
    : candidate.id
    ? `input#${candidate.id}`
    : `input[type="${candidate.type || "text"}"]`;

  const idInput = page.locator(idSelector).first();
  await idInput.waitFor({ state: "visible", timeout: 10000 });

  // Angularフォームは fill() だと change detection が動かない場合があるため
  // クリックして focused にしてから1文字ずつ入力する
  await idInput.click();
  await page.waitForTimeout(300);
  await idInput.pressSequentially(loginId, { delay: 50 });
  await page.waitForTimeout(800);

  // フォームのバリデーションが走るのを待つ（Angular の ng-valid になるまで）
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return el && !el.classList.contains("ng-invalid");
    },
    idSelector,
    { timeout: 5000 }
  ).catch(() => {
    console.log("[sumishin] ng-validへの変化を確認できず（続行）");
  });

  // ログインボタンをクリック
  // Angular カスタムコンポーネント（nb-ren-button 等）の場合は button タグで見つからないため
  // JS で「ログイン」テキストを持つ全要素を探して最後の1つをクリックする
  console.log("[sumishin] ログインボタンを探索中...");

  const loginBtnInfo = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"));
    return all
      .filter((el) => {
        const text = (el.textContent || "").trim();
        const rect = el.getBoundingClientRect();
        return (
          text === "ログイン" &&
          el.offsetParent !== null &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.top > 100 // ヘッダーを除く
        );
      })
      .map((el) => ({
        tag: el.tagName,
        id: el.id,
        cls: el.className?.toString().slice(0, 60),
        top: Math.round(el.getBoundingClientRect().top),
      }));
  });
  console.log("[sumishin] 「ログイン」テキストを持つ要素:", JSON.stringify(loginBtnInfo));

  // JS で直接クリック（ページ内で最も下にある「ログイン」要素）
  const clicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"));
    const candidates = all.filter((el) => {
      const text = (el.textContent || "").trim();
      const rect = el.getBoundingClientRect();
      return (
        text === "ログイン" &&
        el.offsetParent !== null &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top > 100
      );
    });
    if (candidates.length === 0) return false;
    // 最後の要素（フォーム内のボタン）をクリック
    candidates[candidates.length - 1].click();
    return true;
  });

  if (!clicked) {
    await debugShot(page, "login_no_btn");
    throw new Error(
      "「ログイン」ボタンが見つかりません（data/sumishin_debug_login_no_btn.png を確認）"
    );
  }
  console.log("[sumishin] ログインボタンをクリック完了");

  // ページ遷移を待つ（最大25秒）
  console.log("[sumishin] ページ遷移を待機中...");
  await page
    .waitForURL((url) => !url.toString().includes("DI01010240"), {
      timeout: 25000,
    })
    .catch(() => {
      console.log("[sumishin] URLは変わらず（同一ページにパスワード欄が表示される可能性）");
    });
  await page.waitForTimeout(1500);

  // ── ステップ2: パスワード入力 ──
  // ユーザーネーム入力後、同じページ上にモーダル（「パスワードでログインする」）が開く
  console.log("[sumishin] ステップ2: パスワードモーダルを待機中...");

  // モーダルが開くまで待つ
  await page
    .waitForSelector('[class*="modal"], [class*="overlay"], [class*="dialog"], [class*="popup"]', {
      state: "visible",
      timeout: 10000,
    })
    .catch(() => {
      console.log("[sumishin] モーダルセレクタで未検出（続行）");
    });
  await page.waitForTimeout(1000);

  console.log("[sumishin] ステップ2: パスワード入力欄を探索中... (現在URL:", page.url(), ")");

  // JS でページ内の全 input を走査してパスワード欄を特定
  const pwInputInfo = await page.evaluate(() => {
    const inputs = Array.from(
      document.querySelectorAll('input[type="password"], input[type="text"], input:not([type])')
    );
    return inputs
      .filter((el) => el.offsetParent !== null)
      .map((el) => ({
        id: el.id,
        name: el.name,
        type: el.type,
        placeholder: el.placeholder,
        top: Math.round(el.getBoundingClientRect().top),
      }));
  });
  console.log("[sumishin] パスワードページ全inputフィールド:", JSON.stringify(pwInputInfo));

  // パスワード欄を特定（ユーザーネーム欄・検索バーを除外）
  const pwCandidate = pwInputInfo.find((f) => {
    const n = (f.name || "").toLowerCase();
    return (
      f.type === "password" ||
      (!n.includes("username") && !n.includes("user") && !n.includes("query") && f.top > 200)
    );
  });

  if (!pwCandidate) {
    await debugShot(page, "login_no_pw_field");
    throw new Error(
      "パスワード入力欄が見つかりません。全フィールド: " + JSON.stringify(pwInputInfo)
    );
  }
  console.log("[sumishin] パスワード入力欄を特定:", pwCandidate);

  const pwSelector = pwCandidate.name
    ? `input[name="${pwCandidate.name}"]`
    : pwCandidate.id
    ? `input#${pwCandidate.id}`
    : `input[type="${pwCandidate.type || "text"}"]`;

  const pwInput = page.locator(pwSelector).first();
  await pwInput.waitFor({ state: "visible", timeout: 10000 });
  await pwInput.click();
  await page.waitForTimeout(300);
  await pwInput.pressSequentially(password, { delay: 50 });
  await page.waitForTimeout(800);

  // パスワード送信ボタンをJS で探してクリック（Angular コンポーネント対応）
  console.log("[sumishin] パスワード送信ボタンをクリック...");
  const pwClicked = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("*"));
    const candidates = all.filter((el) => {
      const text = (el.textContent || "").trim();
      const rect = el.getBoundingClientRect();
      return (
        text === "ログイン" &&
        el.offsetParent !== null &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top > 200
      );
    });
    if (candidates.length === 0) return false;
    candidates[candidates.length - 1].click();
    return true;
  });

  if (!pwClicked) {
    await debugShot(page, "login_no_pw_submit");
    throw new Error("パスワード送信ボタンが見つかりません（data/sumishin_debug_login_no_pw_submit.png を確認）");
  }
  console.log("[sumishin] パスワード送信ボタンをクリック完了");

  // パスワード送信後、ページが落ち着くまで待つ
  // URLが変わらない場合もあるため、強制エラーはしない
  await page
    .waitForURL(
      (url) =>
        !url.toString().includes("DI01010240") &&
        !url.toString().includes("DI01000200"),
      { timeout: 15000 }
    )
    .catch(() => {
      console.log("[sumishin] ログイン後のURL遷移を未検出（ログイン済みの可能性あり、続行）");
    });

  await page.waitForTimeout(2000);
  console.log("[sumishin] ログイン処理完了（現在URL）:", page.url());

  // ── セキュリティ確認ページ対応 ──────────────────────────────────
  // GitHub Actions 等の新しいIPからログインすると wpl010301N ページ（新端末通知）が表示される
  // 「確認する」「次へ」「OK」等のボタンを自動クリックしてスキップする
  await handleSecurityPage(page);
}

// ── セキュリティ確認ページ処理 ───────────────────────────────────
// 新しいIPからのログイン時に表示される通知・確認ページを自動スキップする
//
// 既知の中間ページURL:
//   wpl010301N / DI01030100 … 新端末ログイン通知
//   wpl010101F / DI01010250 … ログイン後確認ページ（お知らせ・注意事項等）
//
// 上記以外でも wpl010101 (ログインモジュール) に留まっている場合も対象とする

function isIntermediatePage(url) {
  return (
    url.includes("wpl010301") ||
    url.includes("DI01030") ||
    url.includes("DI01010250") ||
    // ログインモジュール (wpl010101) 内でログイン入力ページ以外に留まっている
    (url.includes("wpl010101") && !url.includes("DI01010240"))
  );
}

async function handleSecurityPage(page, depth = 0) {
  if (depth > 5) {
    console.log("[sumishin] セキュリティページ処理の最大試行回数に達しました");
    return;
  }

  const url = page.url();
  if (!isIntermediatePage(url)) {
    return; // 通常ページなら何もしない
  }

  console.log(`[sumishin] 中間ページを検出 (試行${depth + 1}):`, url);
  await debugShot(page, `security_page_${depth}`);

  // ページ内のボタン・リンクを全取得してクリック候補テキストを優先順に探す
  const clicked = await page.evaluate(() => {
    const keywords = [
      "確認する", "次へ", "OK", "同意する", "続ける",
      "ログインする", "了解", "進む", "ホームへ", "トップへ",
      "マイページへ", "閉じる", "スキップ", "後で行う",
    ];
    const all = Array.from(document.querySelectorAll(
      "a, button, input[type='button'], input[type='submit'], [role='button']"
    ));
    for (const kw of keywords) {
      const el = all.find(e => {
        const t = (e.textContent || e.value || "").trim();
        return t.includes(kw) && e.offsetParent !== null;
      });
      if (el) {
        el.click();
        return kw;
      }
    }
    // フォールバック: 表示中の最初のボタン/リンク（ヘッダー除く）
    const fallback = all.find(e => {
      const rect = e.getBoundingClientRect();
      return e.offsetParent !== null && rect.top > 150 && rect.width > 30;
    });
    if (fallback) {
      fallback.click();
      return `fallback:${(fallback.textContent || fallback.value || "").trim().slice(0, 30)}`;
    }
    return null;
  });

  if (clicked) {
    console.log(`[sumishin] 中間ページ: 「${clicked}」をクリック`);
    await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log("[sumishin] クリック後URL:", page.url());

    // まだ中間ページにいる場合は再帰的に再試行
    if (isIntermediatePage(page.url())) {
      await handleSecurityPage(page, depth + 1);
    }
  } else {
    await debugShot(page, `security_page_no_btn_${depth}`);
    console.log("[sumishin] 中間ページのボタンが見つかりません（スクリーンショット保存、続行）");
  }
}

// ── 対象口座（固定リスト） ────────────────────────────────────────
// 動的取得すると230件のノイズが入るため固定リストを使う

const TARGET_ACCOUNTS = [
  "代表口座",
  "税金",
  "ＦＣ＆税金口座",
  "パートナー＆動画制作",
  "投資用",
  "出版・通販・広告費",
  "役員報酬・社員給料",
  "貯蓄口座",
  "クレジットカード支払",
  "家・馬・マルニナール",
  "クルージング",
];

// ── 前の月へ移動 ──────────────────────────────────────────────────
// 口座選択後ページはデフォルトで当月を表示する。前月分が必要なので1回クリックする

async function navigateToPrevMonth(page) {
  const btn = page.locator('a:has-text("前の月"), button:has-text("前の月")').first();
  await btn.waitFor({ state: "attached", timeout: 8000 }).catch(() => {});
  if ((await btn.count()) === 0) {
    console.log("[sumishin] 前の月ボタンが見つかりません（続行）");
    return;
  }
  console.log("[sumishin] 前の月クリック");
  await btn.click({ force: true });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
  const info = await page.evaluate(() => {
    const trigger = document.querySelector(".ui-selectmenu-text, .ui-selectmenu-button span");
    return { account: trigger?.textContent?.trim() ?? "?" };
  }).catch(() => ({ account: "?" }));
  console.log(`[sumishin] 前月へ移動完了 (口座=${info.account})`);
}

// 月別サマリーリストの「3月 入金... 出金...」リンクを直接クリックして対象月へ移動する。
// 「前の月」ボタンは口座をリセットする副作用があるため、こちらを優先使用する。
async function navigateToMonthByList(page, targetMonth) {
  const monthLabel = `${targetMonth}月`;

  const clicked = await page.evaluate((label) => {
    // 「3月 入金 XXX 出金 YYY」形式のリンクを探す
    const links = Array.from(document.querySelectorAll("a"));
    const target = links.find(el => {
      const text = el.textContent.trim();
      return text.startsWith(label) && text.includes("入金");
    });
    if (target) {
      const preview = target.textContent.trim().slice(0, 30);
      target.click();
      return preview;
    }
    return null;
  }, monthLabel);

  if (!clicked) {
    // フォールバック: 月リストが見つからない場合は「前の月」ボタンを使用
    console.log(`[sumishin] ${monthLabel}リンクが見つかりません。前の月ボタンを使用`);
    await navigateToPrevMonth(page);
    return;
  }

  console.log(`[sumishin] ${monthLabel}へ移動: ${clicked}`);
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);
}

// ── 入出金明細ページへ移動 ────────────────────────────────────────

async function goToMeisai(page) {
  console.log("[sumishin] 入出金明細ページへ移動...");

  // まず中間ページを通過してから遷移する
  await handleSecurityPage(page);

  const meisaiLink = page
    .locator(
      'a:has-text("入出金明細"), ' +
        'a[href*="meisai"], a[href*="history"], a[href*="transaction"], ' +
        'li:has-text("入出金明細") a, nav a:has-text("入出金")'
    )
    .first();

  if ((await meisaiLink.count()) === 0) {
    await debugShot(page, "no_meisai_link");
    throw new Error(
      "入出金明細リンクが見つかりません（data/sumishin_debug_no_meisai_link.png を確認）"
    );
  }

  await meisaiLink.click();
  await page.waitForLoadState("networkidle", { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // クリック後もまだ中間ページにいる場合は再度通過を試みる
  if (isIntermediatePage(page.url())) {
    console.log("[sumishin] 入出金明細リンククリック後も中間ページが残存。再度スキップ試行...");
    await handleSecurityPage(page);
  }
  await page.waitForTimeout(2000);
  console.log("[sumishin] 入出金明細ページ:", page.url());
}

// ── 口座を選択（jQuery UI selectmenu 対応） ──────────────────────
// ページの口座ドロップダウンは jQuery UI selectmenu で実装されている
// - トリガー: <div id="acctBusPdCodeInput" class="ui-selectmenu-button">
// - メニュー: body直下に <ul class="ui-selectmenu-menu"> として展開される

async function selectAccount(page, accountName) {
  console.log(`[sumishin] 口座選択: ${accountName}`);

  // jQuery UI selectmenu のトリガーボタンをクリック
  const triggerClicked = await page.evaluate(() => {
    const btn =
      document.getElementById("acctBusPdCodeInput") ||
      document.querySelector(".ui-selectmenu-button");
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!triggerClicked) {
    console.warn("[sumishin] selectmenuトリガーが見つかりません（続行）");
    return;
  }
  await page.waitForTimeout(600);

  // 展開されたメニューから口座名に一致する li をクリック
  // jQuery UI は body直下の ul.ui-selectmenu-menu 内に li を追加する
  const selected = await page.evaluate((name) => {
    const items = Array.from(
      document.querySelectorAll(
        "ul.ui-selectmenu-menu li, ul.ui-menu li, .ui-selectmenu-open li"
      )
    );
    const item = items.find((el) => el.textContent.trim() === name);
    if (item) { item.click(); return true; }

    // フォールバック: 全 li から部分一致で探す
    const fallback = items.find((el) =>
      el.textContent.trim().includes(name.slice(0, 4))
    );
    if (fallback) { fallback.click(); return `fallback: ${fallback.textContent.trim()}`; }
    return false;
  }, accountName);

  if (!selected) {
    console.warn(`[sumishin] 口座「${accountName}」が選択できませんでした。Escapeで閉じます`);
    await page.keyboard.press("Escape");
  } else {
    console.log(`[sumishin] 口座選択完了: ${selected}`);
  }

  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

// ── CSVをダウンロード ─────────────────────────────────────────────
// ダウンロードパネルはトグル式。前回パネルが開いたまま次の口座に進むと
// クリックでパネルが閉じてしまうため、事前に状態を確認して制御する。
// CSVボタンの click はネットワーク応答をキャプチャしてダウンロードする。

async function downloadCsv(page, context, accountName, monthLabel, outputDir) {
  const CSV_SEL = 'a[aria-label="CSV リンク"]';

  // CSVパネルの可視性チェック関数（offsetWidth/Height で判定）
  const isCsvPanelOpen = () =>
    page.evaluate((sel) => {
      const el = document.querySelector(sel);
      return el ? el.offsetWidth > 0 && el.offsetHeight > 0 : false;
    }, CSV_SEL);

  // パネルが既に開いていれば1回クリックして閉じてからリセット
  const dlLocator = page.locator(
    'a:has-text("ダウンロード"), button:has-text("ダウンロード")'
  ).first();

  if (await isCsvPanelOpen()) {
    console.log("[sumishin] パネルが開いていたので閉じる");
    await dlLocator.click({ force: true });
    await page.waitForTimeout(600);
  }

  // ダウンロードパネルを開く
  console.log(`[sumishin] ダウンロードパネルを開く...`);
  await dlLocator.waitFor({ state: "attached", timeout: 10000 });
  await dlLocator.click({ force: true });
  await page.waitForTimeout(500);

  // CSVリンクが visible になるまで待つ（最大10秒）
  let csvVisible = false;
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(1000);
    csvVisible = await isCsvPanelOpen();
    if (csvVisible) break;
    console.log(`[sumishin]   CSVリンク待機中... (${i + 1}/10)`);
  }

  if (!csvVisible) {
    await debugShot(page, `no_csv_panel_${sanitize(accountName)}`);
    throw new Error(`CSVダウンロードパネルが開きませんでした（口座: ${accountName}）`);
  }
  console.log("[sumishin] CSVパネル開いた");

  // page.route() でのプロキシは CSRF/Referer チェックを壊すため使わない
  // 代わりに page.on("response") で非侵襲的に全レスポンスを観察する
  // ファイル名: 202603_代表口座.csv 形式
  const filePrefix = monthLabel.replace("-", "");
  let capturedBuffer = null;
  let capturedFilename = `${filePrefix}_${sanitize(accountName)}.csv`;

  const SKIP_EXTS = /\.(js|css|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|eot|map)(\?|$)/i;

  const responseHandler = async (response) => {
    const url = response.url();
    if (SKIP_EXTS.test(url)) return;

    try {
      const ct = (response.headers()["content-type"] || "").toLowerCase();
      const cd = response.headers()["content-disposition"] || "";
      const status = response.status();

      // 診断ログ（html/js/css 以外の全応答）
      if (!ct.includes("html") && !ct.includes("javascript") && !ct.includes("css")) {
        console.log(
          `[sumishin] resp ${status} | ${ct} | CD="${cd.slice(0, 60)}" | ${url.slice(0, 80)}`
        );
      }

      // doCSVDownload API は application/json でCSVデータを返す
      const isDownloadApi = url.includes("doCSVDownload");
      const isCsvLike =
        ct.includes("csv") ||
        ct.includes("octet-stream") ||
        cd.toLowerCase().includes("attachment") ||
        cd.toLowerCase().includes(".csv") ||
        (ct.includes("text/plain") && status === 200);

      if ((isCsvLike || isDownloadApi) && !ct.includes("html") && !capturedBuffer) {
        const body = await response.body().catch(() => null);
        if (!body || body.length < 10) return;

        console.log(`[sumishin] ボディ先頭200: ${body.toString("utf8").slice(0, 200)}`);

        if (ct.includes("json") || isDownloadApi) {
          // JSON から Shift-JIS CSV を抽出
          try {
            const json = JSON.parse(body.toString("utf8"));
            const csvBuf = extractCsvBuffer(json);
            if (csvBuf && csvBuf.length > 20) {
              capturedBuffer = csvBuf;
              capturedFilename = `${filePrefix}_${sanitize(accountName)}.csv`;
              console.log(`[sumishin] JSONからCSV抽出（Shift-JIS）: ${capturedBuffer.length}bytes`);
            } else {
              capturedBuffer = body;
              capturedFilename = `${sanitize(accountName)}_debug.json`;
              console.log(`[sumishin] JSON保存（CSV抽出失敗）: ${body.length}bytes`);
            }
          } catch (e) {
            capturedBuffer = body;
            capturedFilename = `${sanitize(accountName)}_debug.bin`;
            console.log(`[sumishin] JSON解析失敗: ${e.message}`);
          }
        } else {
          capturedBuffer = body;
          const fnMatch = cd.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/i);
          if (fnMatch?.[1]) capturedFilename = fnMatch[1].replace(/['"]/g, "").trim() || capturedFilename;
          console.log(`[sumishin] CSV応答キャプチャ: ${ct} | ${cd.slice(0, 60)} | ${body.length}bytes`);
        }
      }
    } catch {
      // ignore
    }
  };

  page.on("response", responseHandler);

  // CSVボタンをJS直接クリック（role="region"の<a>はPlaywrightのclickが効かない場合がある）
  console.log("[sumishin] CSV ボタンをJS クリック...");
  const csvClickResult = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return { found: false };
    const info = {
      found: true,
      tag: el.tagName,
      ariaLabel: el.getAttribute("aria-label"),
      offsetW: el.offsetWidth,
      offsetH: el.offsetHeight,
    };
    el.click();
    return info;
  }, CSV_SEL);
  console.log("[sumishin] CSV要素クリック結果:", JSON.stringify(csvClickResult));

  // capturedBuffer がセットされるまでポーリング（最大8秒、取れたら即抜け）
  // 固定15秒待ちはセッションタイムアウトを引き起こすため使わない
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(1000);
    if (capturedBuffer) break;
    console.log(`[sumishin]   CSV取得待機中... (${i + 1}/8)`);
  }

  page.off("response", responseHandler);

  // パネルを閉じる
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  if (capturedBuffer && capturedBuffer.length > 10) {
    const filePath = path.join(outputDir, capturedFilename);
    fs.writeFileSync(filePath, capturedBuffer);
    const size = fs.statSync(filePath).size;
    console.log(`[sumishin] CSV保存: ${filePath} (${size} bytes)`);
    return;
  }

  await debugShot(page, `dl_failed_${sanitize(accountName)}`);
  throw new Error(`CSVダウンロード失敗: captured=${capturedBuffer?.length ?? 0}bytes`);
}

async function saveFile(download, accountName, outputDir) {
  const ext = path.extname(download.suggestedFilename() || ".csv") || ".csv";
  const fileName = `${sanitize(accountName)}${ext}`;
  const filePath = path.join(outputDir, fileName);
  await download.saveAs(filePath);
  const size = fs.statSync(filePath).size;
  console.log(`[sumishin] ✅ ${accountName} → ${filePath} (${size} bytes)`);
}

// ── doCSVDownload JSON レスポンスから CSV データを抽出 ─────────────
// APIは application/json を返す。
// params.csvData は Java の signed byte array 文字列 "[34, -109, -6, ...]"
// 負数を符号なしバイトに変換（-109 → 147 = 0x93）すると Shift-JIS 形式の CSV になる

function javaByteArrayToCsvBuffer(str) {
  // "[34, -109, -6, ...]" 形式のみ対象
  if (!/^\s*\[[\s\d,\-]+\]\s*$/.test(str)) return null;
  try {
    const signed = str.match(/-?\d+/g).map(Number);
    const unsigned = signed.map((b) => (b < 0 ? b + 256 : b));
    return Buffer.from(unsigned); // Shift-JIS エンコードのバイナリ
  } catch {
    return null;
  }
}

function extractCsvBuffer(json, depth = 0) {
  if (depth > 5) return null;

  // 文字列の場合
  if (typeof json === "string") {
    // Java signed byte array
    const buf = javaByteArrayToCsvBuffer(json);
    if (buf && buf.length > 20) return buf;
    // CSV 直書き
    if (json.includes(",") && json.includes("\n"))
      return Buffer.from(json, "utf8");
    // Base64
    try {
      const dec = Buffer.from(json, "base64");
      const decStr = dec.toString("utf8");
      if (decStr.includes(",") && decStr.includes("\n") && dec.length > 50) return dec;
    } catch {}
    return null;
  }

  // 配列の場合: 行データの配列 → CSV変換
  if (Array.isArray(json) && json.length > 0) {
    const first = json[0];
    if (typeof first === "object" && first !== null) {
      const headers = Object.keys(first);
      const rows = json.map((row) =>
        headers.map((h) => `"${String(row[h] ?? "").replace(/"/g, '""')}"`).join(",")
      );
      return Buffer.from([headers.join(","), ...rows].join("\n"), "utf8");
    }
  }

  // オブジェクトの場合: 既知フィールドを優先して探索
  if (typeof json === "object" && json !== null) {
    for (const key of [
      "csvData", "csv", "params", "data", "content", "body", "result", "text", "value", "rows",
    ]) {
      if (json[key] != null) {
        const found = extractCsvBuffer(json[key], depth + 1);
        if (found && found.length > 20) return found;
      }
    }
    // 全フィールドを長さ順で探索
    const entries = Object.entries(json).sort(
      ([, a], [, b]) => String(b).length - String(a).length
    );
    for (const [, value] of entries) {
      if (typeof value === "string" || typeof value === "object") {
        const found = extractCsvBuffer(value, depth + 1);
        if (found && found.length > 50) return found;
      }
    }
  }

  return null;
}

// ── ユーティリティ ────────────────────────────────────────────────

function sanitize(name) {
  return name.replace(/[\\/:*?"<>|　\s]/g, "_").replace(/_+/g, "_");
}

async function debugShot(page, label) {
  const absDebugDir = path.resolve(DEBUG_DIR);
  fs.mkdirSync(absDebugDir, { recursive: true });
  const p = path.join(absDebugDir, `sumishin_debug_${label}.png`);
  await page.screenshot({ path: p, fullPage: true }).catch((e) => {
    console.warn(`[sumishin] スクリーンショット保存失敗: ${e.message}`);
  });
  console.log(`[sumishin] デバッグスクリーンショット保存: ${p}`);
}

// ── Google Drive アップロード ─────────────────────────────────────
// downloads/YYYY-MM/ の CSV を Drive の親フォルダ内に「YYYY年M月」サブフォルダを
// 作成してアップロードする

const DRIVE_PARENT_FOLDER_ID = "1yWvg-2nb1w4hJ-ITfyFLSWuxVaBMgaPR";

async function buildDriveAuth() {
  const { client_id, client_secret } = readClientCredentials();
  const oAuth2Client = new google.auth.OAuth2(
    client_id, client_secret, GOOGLE_OAUTH_REDIRECT_URI
  );
  // GitHub Actions では GOOGLE_TOKEN_JSON 環境変数から読む、ローカルは token.json
  let tokens;
  if (process.env.GOOGLE_TOKEN_JSON) {
    tokens = JSON.parse(process.env.GOOGLE_TOKEN_JSON);
  } else {
    const tokenPath = process.env.GOOGLE_TOKEN_PATH || "token.json";
    tokens = JSON.parse(fs.readFileSync(tokenPath, "utf8"));
  }
  oAuth2Client.setCredentials(tokens);
  // アクセストークン更新時にローカルの token.json を自動書き換え（クラウド実行時はスキップ）
  if (!process.env.GOOGLE_TOKEN_JSON) {
    const tokenPath = process.env.GOOGLE_TOKEN_PATH || "token.json";
    oAuth2Client.on("tokens", (fresh) => {
      if (fresh.refresh_token) tokens.refresh_token = fresh.refresh_token;
      Object.assign(tokens, fresh);
      fs.writeFileSync(tokenPath, JSON.stringify(tokens, null, 2));
    });
  }
  return oAuth2Client;
}

async function uploadToGoogleDrive(outputDir, displayYear, displayMonth) {
  console.log("\n[drive] Google Drive アップロード開始...");
  const auth = await buildDriveAuth();
  const drive = google.drive({ version: "v3", auth });

  // 「2026年3月」形式のサブフォルダ名
  const folderName = `${displayYear}年${displayMonth}月`;

  // 既存フォルダを検索
  const searchRes = await drive.files.list({
    q: [
      `name = '${folderName}'`,
      `'${DRIVE_PARENT_FOLDER_ID}' in parents`,
      `mimeType = 'application/vnd.google-apps.folder'`,
      `trashed = false`,
    ].join(" and "),
    fields: "files(id, name)",
    spaces: "drive",
  });

  let folderId;
  if (searchRes.data.files.length > 0) {
    folderId = searchRes.data.files[0].id;
    console.log(`[drive] 既存フォルダを使用: ${folderName} (${folderId})`);
  } else {
    const createRes = await drive.files.create({
      requestBody: {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        parents: [DRIVE_PARENT_FOLDER_ID],
      },
      fields: "id",
    });
    folderId = createRes.data.id;
    console.log(`[drive] フォルダ作成: ${folderName} (${folderId})`);
  }

  // アップロード対象 CSV を列挙
  const csvFiles = fs
    .readdirSync(outputDir)
    .filter((f) => f.endsWith(".csv"))
    .sort();

  if (csvFiles.length === 0) {
    console.log("[drive] アップロードする CSV がありません");
    return;
  }

  let uploaded = 0;
  for (const fileName of csvFiles) {
    const filePath = path.join(outputDir, fileName);
    const size = fs.statSync(filePath).size;

    await drive.files.create({
      requestBody: {
        name: fileName,
        parents: [folderId],
      },
      media: {
        mimeType: "text/csv",
        body: fs.createReadStream(filePath),
      },
      fields: "id",
    });

    console.log(`[drive] ✅ ${fileName} (${size} bytes)`);
    uploaded++;
  }

  console.log(`[drive] 計 ${uploaded} 件アップロード完了`);
  console.log(`[drive] フォルダURL: https://drive.google.com/drive/folders/${folderId}`);
}

// ── メイン処理 ────────────────────────────────────────────────────

async function main() {
  const { from, to, label, displayYear, displayMonth } = getPrevMonthRange();
  const outputDir = path.join(DOWNLOAD_BASE, label);
  fs.mkdirSync(outputDir, { recursive: true });

  console.log("━".repeat(50));
  console.log(" 住信SBIネット銀行 CSV 一括ダウンロード");
  console.log("━".repeat(50));
  console.log(`対象期間 : ${from.toFormat("yyyy/MM/dd")} 〜 ${to.toFormat("yyyy/MM/dd")}`);
  console.log(`保存先   : ${path.resolve(outputDir)}`);
  console.log(`表示モード: ${HEADLESS ? "非表示（headless）" : "表示あり"}`);
  console.log("━".repeat(50));

  let context = await launchBrowser();
  let page = await context.newPage();
  const results = { success: [], failed: [] };

  // ブラウザ再起動・再ログインのヘルパー
  const relaunch = async () => {
    await context.close().catch(() => {});
    context = await launchBrowser();
    page = await context.newPage();
    await login(page);
    await goToMeisai(page);
    console.log("[sumishin] 再ログイン完了");
  };

  try {
    // ── ログイン
    await login(page);

    // ── 入出金明細ページへ
    await goToMeisai(page);

    // ── 対象口座（固定リスト）
    const accounts = TARGET_ACCOUNTS;
    console.log(`\n口座数: ${accounts.length} 件`);
    accounts.forEach((a, i) => console.log(`  ${i + 1}. ${a}`));
    console.log("");

    // ── 各口座のCSVをダウンロード
    for (const accountName of accounts) {
      console.log(`\n▶ ${accountName}`);
      try {
        // 口座選択 → 月別サマリーリストから対象月をクリック → CSV取得
        await selectAccount(page, accountName);
        await navigateToMonthByList(page, displayMonth);
        await downloadCsv(page, context, accountName, label, outputDir);
        results.success.push(accountName);
      } catch (e) {
        const isClosed =
          e.message.includes("Target page") ||
          e.message.includes("context or browser has been closed") ||
          e.message.includes("browser has been closed");

        if (isClosed) {
          console.log("[sumishin] ブラウザが閉じられた。再ログインして再試行...");
          try {
            await relaunch();
            await selectAccount(page, accountName);
            await navigateToMonthByList(page, displayMonth);
            await downloadCsv(page, context, accountName, label, outputDir);
            results.success.push(accountName);
          } catch (retryErr) {
            console.error(`  ❌ 再試行エラー: ${retryErr.message}`);
            results.failed.push({ name: accountName, error: retryErr.message });
          }
        } else {
          console.error(`  ❌ エラー: ${e.message}`);
          await debugShot(page, `error_${sanitize(accountName)}`).catch(() => {});
          results.failed.push({ name: accountName, error: e.message });
        }
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  // ── 結果サマリー
  console.log("\n" + "━".repeat(50));
  console.log(" 完了サマリー");
  console.log("━".repeat(50));
  console.log(`✅ 成功: ${results.success.length} 件`);
  results.success.forEach((n) => console.log(`   - ${n}`));
  if (results.failed.length > 0) {
    console.log(`❌ 失敗: ${results.failed.length} 件`);
    results.failed.forEach((f) => console.log(`   - ${f.name}: ${f.error}`));
  }
  console.log(`\n保存先: ${path.resolve(outputDir)}`);
  console.log("━".repeat(50));

  // ── Google Drive へアップロード（成功ファイルがあれば実行）
  if (results.success.length > 0) {
    await uploadToGoogleDrive(outputDir, displayYear, displayMonth);
  }
}

main().catch((e) => {
  console.error("\n[sumishin] 致命的エラー:", e.message);
  process.exit(1);
});
