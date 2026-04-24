// ESM 環境から pdf-parse (CJS) を使うためのラッパー
// Node.js 22 の package exports 制限を .cjs 経由で回避する
"use strict";
const pdfParse = require("pdf-parse");
module.exports = typeof pdfParse === "function" ? pdfParse : (pdfParse.default || pdfParse);
