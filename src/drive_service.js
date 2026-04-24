import { Readable } from "node:stream";
import { google } from "googleapis";
import { Firestore } from "@google-cloud/firestore";
import { DateTime } from "luxon";
import { loadOAuthClient } from "./calendar_service.js";

const firestore = new Firestore();

// ── 会社 → Drive ルートフォルダ ID マッピング ───────────────────
const DRIVE_FOLDERS = {
  BURIZUMU: "1zQmI1Z5GyMCFPT3mLCl7CNXyKOg9gOK0",
  TRYNNOX:  "1qF4EO_KFImz5qiSuyqPJK01ASGjWDGSg",
  MISOKOJI: "1_LwNlWtbzuV2xMFkGiuzwIcKKW8pmkI3",
};

// 表示名 → キー
const COMPANY_ALIASES = {
  "burizumu":  "BURIZUMU",
  "BURIZUMU":  "BURIZUMU",
  "ブリズム":  "BURIZUMU",
  "trynnox":   "TRYNNOX",
  "Trynnox":   "TRYNNOX",
  "TRYNNOX":   "TRYNNOX",
  "misokoji":  "MISOKOJI",
  "MISOKOJI":  "MISOKOJI",
  "みそこうじ": "MISOKOJI",
  "味噌麹":    "MISOKOJI",
};

export function resolveCompanyKey(name) {
  if (!name) return null;
  const n = name.trim();
  return COMPANY_ALIASES[n] ?? COMPANY_ALIASES[n.toLowerCase()] ?? null;
}

export function listDriveCompanies() {
  return Object.keys(DRIVE_FOLDERS);
}

function getDrive() {
  const auth = loadOAuthClient();
  return google.drive({ version: "v3", auth });
}

// ── 月フォルダを探す or 作成する ────────────────────────────────

// ── Firestore キャッシュ ───────────────────────────────────────
async function getCachedFolderId(companyKey, year, month) {
  try {
    const doc = await firestore
      .collection("drive_folder_cache")
      .doc(`${companyKey}_${year}_${month}`)
      .get();
    return doc.exists ? doc.data().folderId : null;
  } catch {
    return null;
  }
}

async function setCachedFolderId(companyKey, year, month, folderId) {
  try {
    await firestore
      .collection("drive_folder_cache")
      .doc(`${companyKey}_${year}_${month}`)
      .set({ folderId, updatedAt: new Date().toISOString() });
  } catch (e) {
    console.warn("[drive] Firestore cache write failed:", e.message);
  }
}

async function findOrCreateMonthFolder(rootFolderId, companyKey, year, month) {
  const drive = getDrive();
  const folderName = `${year}年${month}月`;

  // 1. Firestore キャッシュを確認
  const cached = await getCachedFolderId(companyKey, year, month);
  if (cached) {
    console.log(`[drive] cache hit: ${folderName} (${cached})`);
    return cached;
  }

  // 2. Drive 上の子フォルダを全件取得して照合
  const allFolders = [];
  let pageToken;
  do {
    const res = await drive.files.list({
      q: `'${rootFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "nextPageToken,files(id,name)",
      spaces: "drive",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      pageToken,
    });
    allFolders.push(...(res.data.files || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  console.log(`[drive] listing ${allFolders.length} folders under ${rootFolderId}:`, allFolders.map((f) => f.name));

  const existing = allFolders.find((f) => f.name === folderName);
  if (existing) {
    console.log(`[drive] found folder: ${folderName} (${existing.id})`);
    await setCachedFolderId(companyKey, year, month, existing.id);
    return existing.id;
  }

  // 3. 新規作成してキャッシュに保存
  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [rootFolderId],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  console.log(`[drive] created folder: ${folderName} (${created.data.id})`);
  await setCachedFolderId(companyKey, year, month, created.data.id);
  return created.data.id;
}

// ── Drive にファイルをアップロード ─────────────────────────────

async function uploadFile(folderId, filename, buffer, mimeType = "application/pdf") {
  const drive = getDrive();

  const res = await drive.files.create({
    requestBody: {
      name: filename,
      parents: [folderId],
    },
    media: {
      mimeType,
      body: Readable.from(buffer),
    },
    fields: "id,webViewLink",
    supportsAllDrives: true,
  });

  return res.data.webViewLink;
}

// ── メイン: 会社 + 月 + ファイルを指定して Drive に保存 ─────────

/**
 * @param {{
 *   companyKey: string,        // "BURIZUMU" | "TRYNNOX"
 *   year: number,
 *   month: number,
 *   filename: string,
 *   buffer: Buffer,
 *   mimeType?: string,
 * }} p
 * @returns {Promise<string>} webViewLink
 */
export async function saveToDrive({ companyKey, year, month, filename, buffer, mimeType }) {
  const rootFolderId = DRIVE_FOLDERS[companyKey];
  if (!rootFolderId) {
    throw new Error(`会社「${companyKey}」の Drive フォルダが設定されていません`);
  }

  const folderId = await findOrCreateMonthFolder(rootFolderId, companyKey, year, month);
  const link = await uploadFile(folderId, filename, buffer, mimeType);
  console.log(`[drive] uploaded: ${filename} → ${link}`);
  return link;
}

/** コマンドから年月を解決する。月省略時は当月 */
export function resolveYearMonth(monthNum) {
  const now = DateTime.now().setZone("Asia/Tokyo");
  const month = monthNum || now.month;
  let year = now.year;
  // 来月以降が指定された場合は翌年扱い（例：12月に1月指定）
  if (month < now.month - 6) year += 1;
  return { year, month };
}
