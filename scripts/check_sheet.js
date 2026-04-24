import { google } from "googleapis";
import { loadOAuthClient } from "../src/calendar_service.js";

const SHEET_ID = "17P1cKSdSmHQV_eSKGvFbktBWvWEjVXoj1ENgfEVumVc";

const sheets = google.sheets({ version: "v4", auth: loadOAuthClient() });

const meta = await sheets.spreadsheets.get({
  spreadsheetId: SHEET_ID,
  fields: "sheets.properties.title",
});
const sheetName = meta.data.sheets?.[0]?.properties?.title ?? "Sheet1";
console.log("シート名:", sheetName);

const res = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: `${sheetName}!A1:N50`,
});

const rows = res.data.values ?? [];
console.log(`全 ${rows.length} 行`);
rows.forEach((r, i) => {
  console.log(`\n--- ${i + 1} 行目 ---`);
  r.forEach((cell, j) => {
    if (cell) console.log(`  [${j + 1}] ${cell}`);
  });
});
