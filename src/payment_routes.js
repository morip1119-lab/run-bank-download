import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import multer from "multer";
import {
  fetchAllInvoices,
  markInvoicePaid,
  parseBankCsv,
  matchInvoicesWithTransactions,
} from "./payment_service.js";
import {
  fetchMoneyForwardCsvByAccount,
} from "./moneyforward_scraper.js";
import {
  ACCOUNT_CONFIG,
  requireAuth,
  createSession,
  deleteSession,
  setSessionCookie,
  clearSessionCookie,
  parseCookies,
} from "./payment_auth.js";
import {
  savePaymentMatches,
  getPaymentMatches,
  deletePaymentMatch,
} from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
});

// ── /payment → /payment/burizumu にリダイレクト ──────────────────
router.get("/", (_req, res) => {
  res.redirect("/payment/burizumu");
});

// ── アカウント別ルートを動的生成 ─────────────────────────────────
for (const acc of Object.values(ACCOUNT_CONFIG)) {
  buildAccountRouter(acc);
}

/**
 * DB に保存された照合結果を請求書リストにマージする
 * invoice.csvMatch = { date, amount, description, matchedAt } | null
 */
function mergeDbMatches(invoices, accountKey) {
  const rows = getPaymentMatches(accountKey);
  const matchMap = new Map(rows.map((r) => [r.invoice_id, r]));
  return invoices.map((inv) => {
    const row = matchMap.get(String(inv.id));
    return {
      ...inv,
      csvMatch: row
        ? {
            date: row.match_date,
            amount: row.match_amount,
            description: row.match_desc,
            matchedAt: row.matched_at,
          }
        : null,
    };
  });
}

/**
 * matchInvoicesWithTransactions の結果から DB に保存すべきマッチを抽出して保存
 * matched の各要素は { ...invoiceProps, csvMatches: [...] } の形（invoice はネストしない）
 */
function persistMatches(matched, accountKey) {
  const toSave = [];
  for (const item of matched) {
    if (item.csvMatches?.length > 0) {
      const best = item.csvMatches[0];
      toSave.push({
        invoiceId: item.id,
        accountKey,
        date: best.date,
        amount: best.amount,
        description: best.description,
      });
    }
  }
  if (toSave.length > 0) savePaymentMatches(toSave);
  return toSave.length;
}

function buildAccountRouter(acc) {
  const accountPath = acc.path; // "burizumu" | "trynnox"
  const auth = requireAuth(acc);

  // ── ログイン ────────────────────────────────────────────────────
  router.post(`/${accountPath}/login`, express.urlencoded({ extended: false }), (req, res) => {
    const { password } = req.body ?? {};
    if (!password || password !== acc.password()) {
      res.redirect(`/payment/${accountPath}?error=1`);
      return;
    }
    const token = createSession(acc.key);
    setSessionCookie(res, token, accountPath);
    res.redirect(`/payment/${accountPath}`);
  });

  // ── ログアウト ──────────────────────────────────────────────────
  router.post(`/${accountPath}/logout`, (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[`pm_session_${accountPath}`];
    if (token) deleteSession(token);
    clearSessionCookie(res, accountPath);
    res.redirect(`/payment/${accountPath}`);
  });

  // ── ダッシュボード HTML ─────────────────────────────────────────
  router.get(`/${accountPath}`, auth, (_req, res) => {
    const htmlPath = path.join(__dirname, "../public/payment/index.html");
    const html = fs.readFileSync(htmlPath, "utf8").replace(
      "/* __ACCOUNT_INJECT__ */",
      `window.PAYMENT_ACCOUNT       = ${JSON.stringify(acc.key)};
       window.PAYMENT_ACCOUNT_LABEL = ${JSON.stringify(acc.label)};
       window.PAYMENT_ACCOUNT_ICON  = ${JSON.stringify(acc.icon)};
       window.PAYMENT_ACCOUNT_COLOR = ${JSON.stringify(acc.color)};
       window.PAYMENT_ACCOUNT_PATH  = ${JSON.stringify(accountPath)};`
    );
    res.type("html").send(html);
  });

  // ── 請求書一覧 API（DB保存済みCSV照合も含む） ─────────────────
  router.get(`/${accountPath}/api/invoices`, auth, async (_req, res) => {
    try {
      const invoices = await fetchAllInvoices([acc.key]);
      const withMatches = mergeDbMatches(invoices, acc.key);
      res.json({ ok: true, invoices: withMatches });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── 入金済みに更新 API ──────────────────────────────────────────
  router.post(`/${accountPath}/api/mark-paid`, auth, express.json(), async (req, res) => {
    const { invoiceId, paidOn } = req.body ?? {};
    if (!invoiceId) {
      res.status(400).json({ ok: false, error: "invoiceId が必要です" });
      return;
    }
    try {
      // Misoca に入金済みを反映（paidOn があれば paid_on として送信）
      const result = await markInvoicePaid(invoiceId, acc.key, paidOn || null);
      console.log(`[payment] mark-paid ${invoiceId} paidOn=${paidOn} → full:`, JSON.stringify(result).slice(0, 300));
      // DB の照合データも削除
      deletePaymentMatch(invoiceId, acc.key);
      res.json({ ok: true, paidOn: result?.paid_on || paidOn || null });
    } catch (e) {
      console.error(`[payment] mark-paid error ${invoiceId}:`, e.message);
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // ── CSV アップロード & 照合 API ────────────────────────────────
  router.post(
    `/${accountPath}/api/upload-csv`,
    auth,
    upload.single("csv"),
    async (req, res) => {
      if (!req.file) {
        res.status(400).json({ ok: false, error: "CSV ファイルが必要です" });
        return;
      }
      try {
        const encoding = req.file.mimetype.includes("shift") ? "shift_jis" : "utf8";
        const csvText = new TextDecoder(encoding).decode(req.file.buffer);
        const [invoices, transactions] = await Promise.all([
          fetchAllInvoices([acc.key]),
          Promise.resolve(parseBankCsv(csvText)),
        ]);
        const matched = matchInvoicesWithTransactions(invoices, transactions);
        const savedCount = persistMatches(matched, acc.key);
        // DB マッチ込みで請求書を返す
        const withMatches = mergeDbMatches(invoices, acc.key);
        res.json({ ok: true, transactions, matched, savedCount, invoices: withMatches });
      } catch (e) {
        res.status(500).json({ ok: false, error: e.message });
      }
    }
  );

  // ── MoneyForward 自動取得 API ────────────────────────────────
  router.post(`/${accountPath}/api/fetch-mf`, auth, express.json(), async (req, res) => {
    const { from, to } = req.body ?? {};
    if (!process.env.MONEYFORWARD_EMAIL || !process.env.MONEYFORWARD_PASSWORD) {
      res.status(400).json({
        ok: false,
        error: "MONEYFORWARD_EMAIL / MONEYFORWARD_PASSWORD が .env に設定されていません",
      });
      return;
    }
    try {
      const csvByAccount = await fetchMoneyForwardCsvByAccount({
        from,
        to,
        accountGroupMap: { [acc.key]: acc.mfGroup() },
      });

      const csvText      = csvByAccount[acc.key];
      const invoices     = await fetchAllInvoices([acc.key]);
      const transactions = csvText ? parseBankCsv(csvText) : [];
      const matched      = matchInvoicesWithTransactions(invoices, transactions);

      // 照合結果を DB に永続保存
      const savedCount = csvText ? persistMatches(matched, acc.key) : 0;
      const matchCount = matched.filter((m) => m.csvMatches.length > 0).length;

      // DB マッチ込みで請求書を返す
      const withMatches = mergeDbMatches(invoices, acc.key);

      res.json({
        ok: true,
        transactions,
        matched,
        invoices: withMatches,
        savedCount,
        groupResult: csvText
          ? { groupName: acc.mfGroup(), transactions: transactions.length, matchCount, savedCount }
          : { error: "CSV取得失敗" },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
}

export default router;
