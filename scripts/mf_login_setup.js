/**
 * MoneyForward ME 手動ログインセットアップ
 *
 * 2FA（2段階認証）が設定されている場合や、初回ログイン時に実行してください。
 * ブラウザが開くので手動でログインするとセッションが保存されます。
 *
 * 使い方:
 *   node scripts/mf_login_setup.js
 */

import { manualLoginAndSaveSession } from "../src/moneyforward_scraper.js";

await manualLoginAndSaveSession();
process.exit(0);
