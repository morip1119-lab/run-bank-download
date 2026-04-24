/** 全角スペースを半角1つにし、前後空白除去 */
export function normalizeSpaces(s) {
  return s
    .trim()
    .replace(/\u3000/g, " ")
    .replace(/\s+/g, " ");
}

/**
 * リマインドコマンドのパース
 * 形式:
 *   リマインドして
 *   ＜日時＞
 *   ＜内容＞
 *
 * 戻り値: null | { datetimeText: string, message: string }
 */
export function parseReminderCommand(text) {
  const lines = text
    .trim()
    .replace(/\u3000/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines[0] || !/^リマインドして/.test(lines[0])) return null;

  const firstLineRest = lines[0].replace(/^リマインドして\s*/, "").trim();

  let datetimeText, message;

  if (firstLineRest.length > 0 && lines.length >= 2) {
    datetimeText = firstLineRest;
    message = lines.slice(1).join("\n");
  } else if (lines.length >= 3) {
    datetimeText = lines[1];
    message = lines.slice(2).join("\n");
  } else {
    return null;
  }

  if (!datetimeText || !message) return null;
  return { datetimeText, message };
}

/**
 * ダイレクトカレンダー登録コマンドのパース
 * 形式:
 *   カレンダー登録して
 *   ＜件名＞
 *   ＜日時＞
 *
 * 戻り値: null | { title: string, datetimeText: string }
 */
export function parseDirectCalendarCommand(text) {
  const lines = text
    .trim()
    .replace(/\u3000/g, " ")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (!lines[0] || !/^カレンダー登録して/.test(lines[0])) return null;

  // 1行目の「カレンダー登録して」の後ろに件名が続く場合も考慮
  const firstLineRest = lines[0].replace(/^カレンダー登録して\s*/, "").trim();

  let title, datetimeText;

  if (firstLineRest.length > 0 && lines.length >= 2) {
    // 「カレンダー登録して テスト打ち合わせ\n日時」
    title = firstLineRest;
    datetimeText = lines.slice(1).join(" ");
  } else if (lines.length >= 3) {
    // 「カレンダー登録して\n件名\n日時」
    title = lines[1];
    datetimeText = lines.slice(2).join(" ");
  } else if (lines.length === 2) {
    // 「カレンダー登録して\n件名＋日時」→ 件名なし、日時として扱う
    title = "";
    datetimeText = lines[1];
  } else {
    return null;
  }

  if (!datetimeText) return null;
  return { title: title || "打合せ", datetimeText };
}

/**
 * 請求書作成コマンドのパース
 * 形式:
 *   請求書作って
 *   宛先: ○○
 *   件名: ○○
 *   項目: 品名 / 数量 / 単価
 *   支払期日: ○○
 *
 * 戻り値: null | { contact, subject, items: string[], paymentDue }
 */
export function parseInvoiceCommand(text) {
  const t = text.trim().replace(/\u3000/g, " ");
  if (!/^請求書(作って|を作って|発行して|を発行して)/.test(t)) return null;

  const lines = t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(1);

  const get = (keys) => {
    for (const line of lines) {
      for (const key of keys) {
        const m = line.match(new RegExp(`^${key}\\s*[：:]\s*(.+)`, "u"));
        if (m) return m[1].trim();
      }
    }
    return "";
  };

  const getAll = (keys) => {
    const results = [];
    for (const line of lines) {
      for (const key of keys) {
        if (new RegExp(`^${key}\\s*[：:]`, "u").test(line)) {
          const val = line.replace(new RegExp(`^${key}\\s*[：:]\s*`, "u"), "").trim();
          if (val) results.push(val);
        }
      }
    }
    return results;
  };

  const account = get(["アカウント", "会社", "事業者"]);
  const contact = get(["宛先", "取引先", "相手"]);
  const subject = get(["件名", "タイトル"]);
  const items = getAll(["項目", "品目", "内容"]);
  const paymentDue = get(["支払期日", "支払い期日", "期日"]);

  if (!contact) return null;

  return { account, contact, subject, items, paymentDue };
}

/**
 * ドライブ保存コマンドのパース
 * 形式:「[会社名] ドライブ保存して [月]」
 * 例:「BURIZUMU ドライブ保存して 5月」
 * 戻り値: null | { company: string, month: number|null }
 */
export function parseDriveSaveCommand(text) {
  // 複数行の場合もすべての行を検索する
  const lines = text.split("\n").map((l) =>
    l.trim().replace(/\u3000/g, " ").replace(/[０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0)
    )
  );
  for (const line of lines) {
    const m = line.match(/^(.+?)\s+ドライブ保存して(?:\s+(\d{1,2})月)?/);
    if (m) {
      return {
        company: m[1].trim(),
        month: m[2] ? Number(m[2]) : null,
      };
    }
  }
  return null;
}

const AVAILABILITY_TRIGGERS = [
  "空きスケジュール出して",
  "空き出して",
  "空き時間出して",
  "空きを出して",
];

/**
 * 空きスケジュールコマンドの判定＋期間パース
 * 戻り値: null | { period: "today"|"tomorrow"|"this_week"|"next_week"|"default" }
 */
export function parseAvailabilityCommand(text) {
  const t = normalizeSpaces(text);
  if (!AVAILABILITY_TRIGGERS.some((cmd) => t.includes(cmd))) return null;
  if (t.includes("今日")) return { period: "today" };
  if (t.includes("明日")) return { period: "tomorrow" };
  if (t.includes("来週")) return { period: "next_week" };
  if (t.includes("今週")) return { period: "this_week" };
  return { period: "default" };
}

/** 下書き作成（返信で送る） */
const CMD_DRAFT = "下書きを作成する";

/** カレンダー確定 */
const CMD_CONFIRM = "カレンダー登録する";

export function isDraftCommand(text) {
  return normalizeSpaces(text) === CMD_DRAFT;
}

export function isConfirmCommand(text) {
  return normalizeSpaces(text) === CMD_CONFIRM;
}

/**
 * 修正コマンド
 * - 完全一致「修正」→ 次メッセージ待ち
 * - 「修正」改行＋本文
 * - 「修正」＋同一行に続く（「修正　4月…」）
 */
export function parseFixCommand(text) {
  const raw = text.trim();
  if (raw === "修正") {
    return { kind: "wait_next" };
  }
  const lines = raw.split("\n");
  const first = lines[0].trim();
  if (first === "修正" && lines.length > 1) {
    return { kind: "apply", instruction: lines.slice(1).join("\n").trim() };
  }
  if (first.startsWith("修正")) {
    const rest = first.slice(2).trim();
    if (rest.length > 0) {
      return { kind: "apply", instruction: rest };
    }
  }
  return null;
}

// ── 支出管理コマンド ──────────────────────────────────────────────

/** 全角数字を半角に変換 */
function toHalfWidth(s) {
  return s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
}

/**
 * 支出確認コマンド
 * 「支出確認」「今月の支出」「先月の支出」「支出確認 先月」
 * 戻り値: null | { month: "current" | "last" }
 */
export function parseExpenseCheckCommand(text) {
  const t = normalizeSpaces(text);
  if (
    t === "支出確認" ||
    t === "今月の支出" ||
    t === "今月支出" ||
    t === "支出"
  ) {
    return { month: "current" };
  }
  if (
    t === "先月の支出" ||
    t === "先月支出" ||
    t === "支出確認 先月" ||
    t === "先月の支出確認"
  ) {
    return { month: "last" };
  }
  return null;
}

/**
 * 予算設定コマンド
 * 形式:
 *   予算設定
 *   食費 30000
 *   交通費 15000
 *
 * または 1行で: 「予算設定 食費 30000」
 *
 * 戻り値: null | { entries: Array<{ category: string, amount: number }> }
 */
export function parseBudgetSetCommand(text) {
  const lines = text
    .trim()
    .replace(/\u3000/g, " ")
    .split(/\r?\n/)
    .map((l) => toHalfWidth(l.trim()))
    .filter(Boolean);

  if (!lines[0] || !/^予算設定/.test(lines[0])) return null;

  const firstRest = lines[0].replace(/^予算設定\s*/, "").trim();
  const bodyLines = firstRest.length > 0 ? [firstRest, ...lines.slice(1)] : lines.slice(1);
  if (bodyLines.length === 0) return null;

  const entries = [];
  for (const line of bodyLines) {
    // 「食費 30000」「交通費: 15,000」など
    const m = line.match(/^(.+?)\s+([¥￥]?[\d,，]+)/);
    if (m) {
      const amount = parseInt(m[2].replace(/[¥￥,，]/g, ""), 10);
      if (!isNaN(amount) && amount > 0) {
        entries.push({ category: m[1].trim(), amount });
      }
    }
  }
  if (entries.length === 0) return null;
  return { entries };
}

/**
 * 予算確認コマンド
 * 「予算確認」「予算一覧」「予算」
 */
export function isBudgetCheckCommand(text) {
  const t = normalizeSpaces(text);
  return t === "予算確認" || t === "予算一覧" || t === "予算";
}

/**
 * 手動支出入力コマンド
 * 形式:「支出 [カテゴリ] [金額] [内容]」または「支出 [内容] [金額]」
 * 例:
 *   「支出 コーヒー 500」
 *   「支出 食費 コーヒー 500」
 *   「支出 食費 500 スタバ」
 *
 * 戻り値: null | { description, amount, category }
 */
export function parseManualExpenseCommand(text) {
  const t = normalizeSpaces(toHalfWidth(text.trim())).replace(/[¥￥]/g, "");
  if (!t.startsWith("支出 ")) return null;

  const parts = t.slice(3).trim().split(/\s+/);
  if (parts.length < 2) return null;

  // 金額を探す（数字のみのトークン）
  const amountIdx = parts.findIndex((p) => /^\d[\d,]*$/.test(p));
  if (amountIdx === -1) return null;

  const amount = parseInt(parts[amountIdx].replace(/,/g, ""), 10);
  if (isNaN(amount) || amount <= 0) return null;

  const beforeAmount = parts.slice(0, amountIdx);
  const afterAmount = parts.slice(amountIdx + 1);

  // カテゴリ候補（支出カテゴリらしい語）
  const KNOWN_CATEGORIES = [
    "食費", "外食", "日用品", "交通費", "交際費", "娯楽", "趣味", "服飾",
    "医療", "健康", "美容", "教育", "住居", "水道光熱費", "通信費",
    "保険", "税金", "投資", "その他", "未分類",
  ];

  let category = "未分類";
  let descParts = [...beforeAmount, ...afterAmount];

  if (beforeAmount.length >= 2) {
    // 例: 「食費 コーヒー 500」→ category=食費, description=コーヒー
    if (KNOWN_CATEGORIES.includes(beforeAmount[0])) {
      category = beforeAmount[0];
      descParts = [...beforeAmount.slice(1), ...afterAmount];
    }
  } else if (beforeAmount.length === 1 && KNOWN_CATEGORIES.includes(beforeAmount[0])) {
    // 例: 「食費 500 スタバ」
    category = beforeAmount[0];
    descParts = afterAmount;
  }

  const description = descParts.join(" ") || parts.filter((_, i) => i !== amountIdx).join(" ") || "支出";

  return { description, amount, category };
}

/**
 * MF同期コマンド
 * 「MF同期」「マネーフォワード同期」「支出同期」
 */
export function isMfSyncCommand(text) {
  const t = normalizeSpaces(text);
  return t === "MF同期" || t === "マネーフォワード同期" || t === "支出同期" || t === "MF取込";
}
