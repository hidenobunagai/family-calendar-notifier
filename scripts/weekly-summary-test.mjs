// 週次サマリの純関数の検証ハーネス。node:vm で gas/*.gs を読み込み、
// GAS API は全部スタブする（PropertiesService / ScriptApp / Session / Utilities）。
// UrlFetchApp と postToLine は 1 度も呼ばない（stan ivil にすら無い）ので外部送信は発生しない。
// タイムゾーンは docs/weekly-summary-design.md のサンプルが前提とする Asia/Tokyo に固定する。
// formatWeeklySummary は曜日の見出しにローカルの getDay() を使うため、実行時計も
// Asia/Tokyo であって初めて Utilities.formatDate(..., "Asia/Tokyo", ...) と一致する。
process.env.TZ = "Asia/Tokyo";

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import assert from "node:assert/strict";

const root = path.join(import.meta.dirname, "..");
const gasDir = path.join(root, "gas");
const TZ = "Asia/Tokyo";
const DAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];

/** Script Properties をメモリに持つだけのスタブ */
function propsStub(initial = {}) {
  const store = { ...initial };
  return {
    getProperty: (k) => (k in store ? store[k] : null),
    setProperty: (k, v) => void (store[k] = String(v)),
    deleteProperty: (k) => void delete store[k],
  };
}

/**
 * 曜日を観測する ScriptApp。installWeeklySummaryTrigger() が onWeekDay() に渡した
 * 曜日番号（0..6）は `stub.day` に残る。トリガーは実際には作らない。
 */
function scriptAppStub() {
  const builder = {};
  for (const m of ["timeBased", "atHour", "nearMinute"]) {
    builder[m] = () => builder;
  }
  builder.onWeekDay = (d) => ((stub.day = d), builder);
  builder.create = () => ({ getHandlerFunction: () => "sendWeeklySummary" });

  const stub = {
    WeekDay: Object.fromEntries(DAY_NAMES.map((n, i) => [n, i])),
    newTrigger: () => builder,
    getProjectTriggers: () => [],
    deleteTrigger: () => {},
    getOAuthToken: () => "stub-token",
    day: null,
  };
  return stub;
}

/** Utilities.formatDate の必要範囲だけ。GAS と同じ SimpleDateFormat パターン。 */
const utilitiesStub = {
  formatDate(date, tz, fmt) {
    const parts = {};
    for (const { type, value } of new Intl.DateTimeFormat("en-US", {
      timeZone: tz || TZ,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(date)) parts[type] = value;
    return fmt.replace(/y+|M+|d+|H+|h+|m+/g, (tok) => ({
      y: parts.year,
      M: tok.length === 2 ? parts.month : String(Number(parts.month)),
      d: tok.length === 2 ? parts.day : String(Number(parts.day)),
      H: parts.hour,
      h: String(Number(parts.hour) % 12 || 12),
      m: parts.minute,
    })[tok[0]]);
  },
  sleep: () => {},
};

/** gas/*.gs を連結して 1 つの vm コンテキストとして評価する */
function loadGas(props) {
  const source = fs
    .readdirSync(gasDir)
    .filter((f) => f.endsWith(".gs"))
    .sort()
    .map((f) => fs.readFileSync(path.join(gasDir, f), "utf-8"))
    .join("\n\n");
  const context = {
    PropertiesService: { getScriptProperties: () => props },
    ScriptApp: scriptAppStub(),
    Session: { getScriptTimeZone: () => TZ },
    Utilities: utilitiesStub,
    console: { log() {}, warn() {}, error() {} },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: "gas/*.gs" });
  return context;
}

/** installWeeklySummaryTrigger() が onWeekDay() に渡した曜日番号（0..6）を返す */
function installTriggerDay(initial) {
  const ctx = loadGas(propsStub(initial));
  ctx.installWeeklySummaryTrigger();
  return ctx.ScriptApp.day;
}

let failed = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n       ${err.message.split("\n")[0]}`);
  }
};

// --- ① WEEKLY_SUMMARY_DAY がトリガーの曜日に反映される ----------------------
for (const [value, expected] of [["3", 3], ["0", 0], ["6", 6], [undefined, 0]]) {
  const label = value === undefined ? "未設定" : `"${value}"`;
  check(`WEEKLY_SUMMARY_DAY=${label} -> ${DAY_NAMES[expected]}`, () => {
    assert.equal(installTriggerDay(value === undefined ? {} : { WEEKLY_SUMMARY_DAY: value }), expected);
  });
}

// --- ② 範囲外・非数値のフォールバック ---------------------------------------
for (const value of ["9", "-1", "abc", ""]) {
  check(`WEEKLY_SUMMARY_DAY="${value}" -> SUNDAY にフォールバック`, () => {
    assert.equal(installTriggerDay({ WEEKLY_SUMMARY_DAY: value }), 0);
  });
}

// --- ③ formatWeeklySummary の出力が design doc のサンプルとバイト一致 -------
// サンプルは "📅 今週の予定" で始まる fenced コードブロック。
const [, docSample = ""] =
  fs
    .readFileSync(path.join(root, "docs/weekly-summary-design.md"), "utf-8")
    .match(/```\n(📅 今週の予定[\s\S]*?)\n```/) ?? [];

check("formatWeeklySummary == docs/weekly-summary-design.md のサンプル", () => {
  const ctx = loadGas(propsStub());
  const events = [
    {
      summary: "家族会議", location: "自宅",
      start: { dateTime: "2026-08-31T18:00:00+09:00" },
      end: { dateTime: "2026-08-31T19:00:00+09:00" },
    },
    {
      summary: "終日イベント",
      start: { date: "2026-09-02" },
      end: { date: "2026-09-03" },
    },
    {
      summary: "レストラン予約",
      start: { dateTime: "2026-09-02T19:00:00+09:00" },
      end: { dateTime: "2026-09-02T20:00:00+09:00" },
    },
    {
      summary: "ヨガ教室",
      start: { dateTime: "2026-09-02T20:30:00+09:00" },
      end: { dateTime: "2026-09-02T21:30:00+09:00" },
    },
  ];
  const got = ctx.formatWeeklySummary(
    events,
    new Date("2026-08-31T00:00:00+09:00"), // 2026-08-31 00:00（ローカル = Asia/Tokyo）
    new Date("2026-09-07T00:00:00+09:00"), //  2026-09-07 00:00（終了日時は排他的）
    TZ,
  );
  assert.equal(got, docSample);
});

if (failed > 0) {
  console.error(`${failed} test(s) failed.`);
  process.exit(1);
}
console.log("Weekly summary tests passed.");