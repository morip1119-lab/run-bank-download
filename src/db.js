import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

let _db;

export function getDb() {
  if (_db) return _db;
  const dir = path.dirname(config.sqlitePath);
  fs.mkdirSync(dir, { recursive: true });
  _db = new DatabaseSync(config.sqlitePath);
  _db.exec(`
    CREATE TABLE IF NOT EXISTS payment_matches (
      invoice_id   TEXT NOT NULL,
      account_key  TEXT NOT NULL,
      match_date   TEXT,
      match_amount INTEGER,
      match_desc   TEXT,
      matched_at   INTEGER NOT NULL,
      PRIMARY KEY (invoice_id, account_key)
    );

    CREATE TABLE IF NOT EXISTS line_group_messages (
      line_message_id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_user_id TEXT NOT NULL,
      source_group_id TEXT,
      quoted_text TEXT NOT NULL,
      title TEXT,
      start_at TEXT,
      end_at TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      awaiting_correction_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reminders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      remind_at INTEGER NOT NULL,
      message TEXT NOT NULL,
      sent_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_drafts_owner_status
      ON drafts (owner_user_id, status);
    CREATE INDEX IF NOT EXISTS idx_group_messages_group
      ON line_group_messages (group_id);
    CREATE INDEX IF NOT EXISTS idx_reminders_remind_at
      ON reminders (remind_at, sent_at);

    CREATE TABLE IF NOT EXISTS processed_invoice_emails (
      message_id   TEXT PRIMARY KEY,
      vendor_name  TEXT,
      amount       TEXT,
      due_date     TEXT,
      drive_link   TEXT,
      processed_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_date  TEXT NOT NULL,
      description   TEXT NOT NULL,
      amount        INTEGER NOT NULL,
      category      TEXT NOT NULL DEFAULT '未分類',
      sub_category  TEXT,
      memo          TEXT,
      source        TEXT NOT NULL DEFAULT 'manual',
      mf_id         TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expense_budgets (
      category     TEXT PRIMARY KEY,
      monthly_limit INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_expenses_date
      ON expenses (expense_date);
    CREATE INDEX IF NOT EXISTS idx_expenses_category
      ON expenses (category, expense_date);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_mf_id
      ON expenses (mf_id) WHERE mf_id IS NOT NULL;
  `);
  return _db;
}

// ── 入金照合 ──────────────────────────────────────────────────────

/** CSV照合結果を保存（同一請求書は上書き） */
export function savePaymentMatch(invoiceId, accountKey, { date, amount, description }) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO payment_matches (invoice_id, account_key, match_date, match_amount, match_desc, matched_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(String(invoiceId), accountKey, date ?? null, amount ?? null, description ?? null, Date.now());
}

/** 複数の照合結果を一括保存 */
export function savePaymentMatches(matches) {
  const db = getDb();
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO payment_matches (invoice_id, account_key, match_date, match_amount, match_desc, matched_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const now = Date.now();
  for (const { invoiceId, accountKey, date, amount, description } of matches) {
    stmt.run(String(invoiceId), accountKey, date ?? null, amount ?? null, description ?? null, now);
  }
}

/** 指定アカウントの全照合結果を取得 */
export function getPaymentMatches(accountKey) {
  return getDb()
    .prepare(`SELECT * FROM payment_matches WHERE account_key = ?`)
    .all(accountKey);
}

/** 請求書IDの照合結果を取得 */
export function getPaymentMatch(invoiceId, accountKey) {
  return getDb()
    .prepare(`SELECT * FROM payment_matches WHERE invoice_id = ? AND account_key = ?`)
    .get(String(invoiceId), accountKey) ?? null;
}

/** 照合結果を削除 */
export function deletePaymentMatch(invoiceId, accountKey) {
  getDb()
    .prepare(`DELETE FROM payment_matches WHERE invoice_id = ? AND account_key = ?`)
    .run(String(invoiceId), accountKey);
}

/** グループの全テキストを記録（返信元解決用） */
export function saveGroupMessage({ lineMessageId, groupId, userId, text }) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO line_group_messages (line_message_id, group_id, user_id, text, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(lineMessageId, groupId, userId, text, Date.now());
}

export function getGroupMessageText(lineMessageId) {
  const db = getDb();
  const row = db
    .prepare(`SELECT text FROM line_group_messages WHERE line_message_id = ?`)
    .get(lineMessageId);
  return row?.text ?? null;
}

export function cancelActiveDraftsForUser(ownerUserId, exceptId = null) {
  const db = getDb();
  if (exceptId == null) {
    db.prepare(
      `UPDATE drafts SET status = 'cancelled', updated_at = ? WHERE owner_user_id = ? AND status = 'draft'`
    ).run(Date.now(), ownerUserId);
  } else {
    db.prepare(
      `UPDATE drafts SET status = 'cancelled', updated_at = ? WHERE owner_user_id = ? AND status = 'draft' AND id != ?`
    ).run(Date.now(), ownerUserId, exceptId);
  }
}

export function insertDraft({
  ownerUserId,
  sourceGroupId,
  quotedText,
  title,
  startAt,
  endAt,
}) {
  const db = getDb();
  const now = Date.now();
  cancelActiveDraftsForUser(ownerUserId);
  const result = db
    .prepare(
      `INSERT INTO drafts (owner_user_id, source_group_id, quoted_text, title, start_at, end_at, status, awaiting_correction_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', NULL, ?, ?)`
    )
    .run(
      ownerUserId,
      sourceGroupId,
      quotedText,
      title,
      startAt,
      endAt,
      now,
      now
    );
  return result.lastInsertRowid;
}

export function getActiveDraft(ownerUserId) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT * FROM drafts WHERE owner_user_id = ? AND status = 'draft' ORDER BY id DESC LIMIT 1`
    )
    .get(ownerUserId);
  if (
    row &&
    row.awaiting_correction_until != null &&
    row.awaiting_correction_until < Date.now()
  ) {
    db.prepare(
      `UPDATE drafts SET awaiting_correction_until = NULL, updated_at = ? WHERE id = ?`
    ).run(Date.now(), row.id);
    row.awaiting_correction_until = null;
  }
  return row;
}

export function getDraftById(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM drafts WHERE id = ?`).get(id);
}

export function updateDraftTimes(id, { startAt, endAt, title }) {
  const db = getDb();
  const now = Date.now();
  if (title !== undefined) {
    db.prepare(
      `UPDATE drafts SET start_at = ?, end_at = ?, title = ?, updated_at = ? WHERE id = ?`
    ).run(startAt, endAt, title, now, id);
  } else {
    db.prepare(
      `UPDATE drafts SET start_at = ?, end_at = ?, updated_at = ? WHERE id = ?`
    ).run(startAt, endAt, now, id);
  }
}

export function setAwaitingCorrection(draftId, untilEpochMs) {
  const db = getDb();
  db.prepare(
    `UPDATE drafts SET awaiting_correction_until = ?, updated_at = ? WHERE id = ?`
  ).run(untilEpochMs, Date.now(), draftId);
}

export function clearAwaitingCorrection(draftId) {
  const db = getDb();
  db.prepare(
    `UPDATE drafts SET awaiting_correction_until = NULL, updated_at = ? WHERE id = ?`
  ).run(Date.now(), draftId);
}

export function addReminder({ platform, chatId, remindAt, message }) {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO reminders (platform, chat_id, remind_at, message, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(platform, chatId, remindAt, message, Date.now());
  return result.lastInsertRowid;
}

export function getDueReminders() {
  const db = getDb();
  return db
    .prepare(
      `SELECT * FROM reminders WHERE remind_at <= ? AND sent_at IS NULL ORDER BY remind_at ASC`
    )
    .all(Date.now());
}

export function markReminderSent(id) {
  const db = getDb();
  db.prepare(`UPDATE reminders SET sent_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function markDraftConfirmed(id) {
  const db = getDb();
  db.prepare(
    `UPDATE drafts SET status = 'confirmed', awaiting_correction_until = NULL, updated_at = ? WHERE id = ?`
  ).run(Date.now(), id);
}

// ── 支出管理 ──────────────────────────────────────────────────────

/** 支出を1件追加（mf_id が同じ場合は上書き） */
export function upsertExpense({ expenseDate, description, amount, category, subCategory, memo, source, mfId }) {
  const db = getDb();
  if (mfId) {
    db.prepare(
      `INSERT OR REPLACE INTO expenses
         (expense_date, description, amount, category, sub_category, memo, source, mf_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(expenseDate, description, amount, category ?? '未分類', subCategory ?? null, memo ?? null, source ?? 'manual', mfId, Date.now());
  } else {
    db.prepare(
      `INSERT INTO expenses
         (expense_date, description, amount, category, sub_category, memo, source, mf_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`
    ).run(expenseDate, description, amount, category ?? '未分類', subCategory ?? null, memo ?? null, source ?? 'manual', Date.now());
  }
}

/** 指定年月の支出一覧を取得 */
export function getExpensesByMonth(year, month) {
  const db = getDb();
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to   = `${year}-${String(month).padStart(2, '0')}-31`;
  return db.prepare(
    `SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date ASC`
  ).all(from, to);
}

/** 指定年月のカテゴリ別合計を取得 */
export function getExpenseTotalsByCategory(year, month) {
  const db = getDb();
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to   = `${year}-${String(month).padStart(2, '0')}-31`;
  return db.prepare(
    `SELECT category, SUM(amount) AS total, COUNT(*) AS count
     FROM expenses
     WHERE expense_date BETWEEN ? AND ?
     GROUP BY category
     ORDER BY total DESC`
  ).all(from, to);
}

/** 全カテゴリの予算設定を取得 */
export function getAllBudgets() {
  const db = getDb();
  return db.prepare(`SELECT * FROM expense_budgets ORDER BY category`).all();
}

/** カテゴリの予算を設定 */
export function setBudget(category, monthlyLimit) {
  const db = getDb();
  db.prepare(
    `INSERT OR REPLACE INTO expense_budgets (category, monthly_limit, updated_at) VALUES (?, ?, ?)`
  ).run(category, monthlyLimit, Date.now());
}

/** カテゴリの予算を取得 */
export function getBudget(category) {
  const db = getDb();
  return db.prepare(`SELECT * FROM expense_budgets WHERE category = ?`).get(category) ?? null;
}

/** 指定年月の総支出 */
export function getTotalExpense(year, month) {
  const db = getDb();
  const from = `${year}-${String(month).padStart(2, '0')}-01`;
  const to   = `${year}-${String(month).padStart(2, '0')}-31`;
  const row = db.prepare(
    `SELECT SUM(amount) AS total FROM expenses WHERE expense_date BETWEEN ? AND ?`
  ).get(from, to);
  return row?.total ?? 0;
}
