import fs from "node:fs";
import path from "node:path";

const GAS_DIR = fs.existsSync("gas") ? "gas" : "src";
const files = fs
  .readdirSync(GAS_DIR)
  .filter((f) => f.endsWith(".gs"))
  .sort();

console.log(`Checking ${files.length} GAS files in ${GAS_DIR}/: ${files.join(", ")}`);

let hasError = false;
const declaredFunctions = new Set();
const declaredVariables = new Set();

// 1. 各ファイルの構文検査 & トップレベル宣言の収集
for (const file of files) {
  const filePath = path.join(GAS_DIR, file);
  const code = fs.readFileSync(filePath, "utf-8");

  // 単体構文チェック
  try {
    new Function(code);
  } catch (err) {
    console.error(`Syntax error in ${filePath}:`, err.message);
    hasError = true;
  }

  // トップレベル関数と変数宣言の収集
  const fnMatches = code.matchAll(/^function\s+([a-zA-Z0-9_$]+)\s*\(/gm);
  for (const m of fnMatches) {
    const fnName = m[1];
    if (declaredFunctions.has(fnName)) {
      console.error(`Duplicate function declaration: "${fnName}" in ${filePath}`);
      hasError = true;
    }
    declaredFunctions.add(fnName);
  }

  const varMatches = code.matchAll(/^(?:const|let|var)\s+([a-zA-Z0-9_$]+)\s*=/gm);
  for (const m of varMatches) {
    const varName = m[1];
    if (declaredVariables.has(varName)) {
      console.error(`Duplicate variable declaration: "${varName}" in ${filePath}`);
      hasError = true;
    }
    declaredVariables.add(varName);
  }
}

// 2. 連結した全体の構文チェック (GAS はプロジェクト内の全 .gs が同一グローバルスコープで共有される)
const combinedCode = files
  .map((f) => fs.readFileSync(path.join(GAS_DIR, f), "utf-8"))
  .join("\n\n");

try {
  new Function(combinedCode);
} catch (err) {
  console.error("Syntax error in combined GAS files:", err.message);
  hasError = true;
}

// 3. 呼び出し箇所の静的未定義検査
const KNOWN_GLOBALS = new Set([
  "Logger",
  "PropertiesService",
  "Utilities",
  "UrlFetchApp",
  "ScriptApp",
  "Session",
  "LockService",
  "CalendarApp",
  "DriveApp",
  "GmailApp",
  "SpreadsheetApp",
  "DocumentApp",
  "Maps",
  "LanguageApp",
  "CacheService",
  "ContentService",
  "HtmlService",
  "XmlService",
  "JSON",
  "Math",
  "Date",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "RegExp",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "Map",
  "Set",
  "Promise",
  "console",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "undefined",
  "NaN",
  "Infinity",
  "Intl",
  "setTimeout",
  "clearTimeout",
  "BigInt",
  "Symbol",
  "eval",
  "globalThis",
]);

const callMatches = combinedCode.matchAll(/\b([a-zA-Z0-9_$]+)\s*\(/g);
const unknownCalls = new Set();
for (const m of callMatches) {
  const name = m[1];
  if (
    [
      "if",
      "for",
      "while",
      "switch",
      "catch",
      "function",
      "return",
      "typeof",
      "delete",
      "throw",
      "import",
      "export",
      "new",
    ].includes(name)
  ) {
    continue;
  }
  if (!declaredFunctions.has(name) && !declaredVariables.has(name) && !KNOWN_GLOBALS.has(name)) {
    const idx = m.index;
    if (idx > 0 && combinedCode[idx - 1] === ".") {
      continue;
    }
    unknownCalls.add(name);
  }
}

if (unknownCalls.size > 0) {
  console.warn(`Warning: Potential undeclared function calls: ${[...unknownCalls].join(", ")}`);
}

// 4. スクリプトプロパティ名の doc ↔ 実装ドリフト検査
// PROP_KEYS / WEEKLY_SUMMARY_PROP_KEYS の値とドキュメント中の `ALL_CAPS` 名を突き合わせる。
// 実装に無い名前がドキュメントに残ると死んだ行になる（例: 廃止済みの `LOCK`）。
const PROP_KEY_CONSTS = ["PROP_KEYS", "WEEKLY_SUMMARY_PROP_KEYS"]; // JS の定数名はプロパティ名ではないので除外
const implementedKeys = new Set();
for (const m of combinedCode.matchAll(
  /^const\s+(?:PROP_KEYS|WEEKLY_SUMMARY_PROP_KEYS)\s*=\s*\{([^}]*)\}/gm,
)) {
  for (const v of m[1].matchAll(/"([A-Z][A-Z0-9_]*)"/g)) implementedKeys.add(v[1]);
}

// README は全プロパティ、design doc は WEEKLY_SUMMARY_* のみ必須（現行スコープ）。
// 新しいドキュメントがプロパティを書き始めたら、この表に 1 行足す。
const DOC_SCOPES = [
  { file: "README.md", required: () => true },
  { file: "docs/weekly-summary-design.md", required: (key) => key.startsWith("WEEKLY_SUMMARY_") },
];

for (const { file, required } of DOC_SCOPES) {
  if (!fs.existsSync(file)) continue;
  const documented = new Set(
    [...fs.readFileSync(file, "utf-8").matchAll(/`([A-Z][A-Z0-9_]*)`/g)]
      .map((m) => m[1])
      .filter((name) => !PROP_KEY_CONSTS.includes(name)),
  );

  for (const key of implementedKeys) {
    if (required(key) && !documented.has(key)) {
      console.error(`Undocumented script property: "${key}" is missing from ${file}`);
      hasError = true;
    }
  }
  for (const name of documented) {
    if (!implementedKeys.has(name)) {
      console.error(`Unknown script property: "${name}" in ${file} is not defined in gas/*.gs`);
      hasError = true;
    }
  }
}

if (hasError) {
  console.error("GAS check failed.");
  process.exit(1);
} else {
  console.log(
    `GAS check passed: ${declaredFunctions.size} functions, ${declaredVariables.size} top-level variables, ` +
      `${implementedKeys.size} script properties documented.`,
  );
}
