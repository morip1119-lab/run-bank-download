import { chromium } from "playwright";
import path from "node:path";
import "dotenv/config";

const profileDir = path.resolve("data/mf_profile");
const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  locale: "ja-JP",
  viewport: { width: 1280, height: 800 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  ignoreDefaultArgs: ["--enable-automation"],
});

const page = await context.newPage();
const res = await page.goto("https://moneyforward.com/cf", { waitUntil: "domcontentloaded", timeout: 30000 });
console.log("status:", res?.status());

// アカウント選択画面を自動処理
let cfReached = false;
for (let i = 0; i < 5; i++) {
  const url = page.url();
  console.log(`試行${i+1}: ${url}`);
  if (url.includes("moneyforward.com/cf")) { cfReached = true; break; }
  if (url.includes("account_selector")) {
    const btn = page.locator('form[action*="/oauth/authorize"] button').first();
    if ((await btn.count()) > 0) {
      await btn.click();
      await page.waitForURL(u => u.hostname === "moneyforward.com", { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
      // /cf にナビゲート
      await page.goto("https://moneyforward.com/cf", { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    }
  } else {
    break;
  }
}

console.log("CF到達:", cfReached, "現在URL:", page.url());
await page.waitForSelector("select, nav", { timeout: 15000 }).catch(() => {});
await page.waitForTimeout(3000);

// グループ select を取得
const groups = await page.evaluate(() => {
  const sel = document.querySelector("select");
  if (sel) return Array.from(sel.options).map(o => o.text.trim()).filter(t => t);
  return null;
});
console.log("グループ:", groups);

await context.close();
