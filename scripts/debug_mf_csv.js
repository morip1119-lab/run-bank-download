/**
 * マネーフォワードCSVの中身を確認するデバッグスクリプト
 * 使い方: node scripts/debug_mf_csv.js
 */
import "dotenv/config";
import { fetchMoneyForwardCsvByAccount } from "../src/moneyforward_scraper.js";
import { parseBankCsv } from "../src/payment_service.js";

// headless: false にしてブラウザを表示（何が起きているか目視確認）
const csvByAccount = await fetchMoneyForwardCsvByAccount({
  from: "2026-03-01",
  to:   "2026-04-30",
  accountGroupMap: { BURIZUMU: process.env.MF_GROUP_BURIZUMU || "BURIZUMU" },
  headless: true,
});

const csvText = csvByAccount.BURIZUMU ?? csvByAccount.TRYNNOX;
if (!csvText) {
  console.error("❌ CSV取得失敗");
  process.exit(1);
}

console.log("\n=== 先頭5行 ===");
console.log(csvText.split("\n").slice(0, 5).join("\n"));

console.log("\n=== parseBankCsv 結果 ===");
const txs = parseBankCsv(csvText);
console.log(`取引件数: ${txs.length}`);
if (txs.length > 0) {
  console.log("先頭3件:", JSON.stringify(txs.slice(0, 3), null, 2));
} else {
  console.log("⚠️ 0件でした。ヘッダー確認が必要です。");
  // ヘッダー行を表示
  const firstLine = csvText.split("\n")[0];
  console.log("ヘッダー行:", firstLine);
  console.log("ヘッダー各カラム:", firstLine.split(",").map((h, i) => `[${i}] ${h}`).join("\n"));
}
