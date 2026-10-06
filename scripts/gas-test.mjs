// 週次サマリの純関数の検証ハーネス。node:vm で gas/*.gs を読み込み、
// GAS API は全部スタブする（PropertiesService / ScriptApp / Session / Utilities / UrlFetchApp）。
// UrlFetchApp もスタブなので外部送信は発生しない（LINE push は回数だけ数える）。
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

/** new Date()（引数なし）だけ固定時刻を返す Date。引数ありの new Date(...) は素通し。 */
function pinnedDateClass(fixedMs) {
  class PinnedDate extends Date {
    constructor(...args) {
      return args.length === 0 ? new Date(fixedMs) : new Date(...args);
    }
    static now() {
      return fixedMs;
    }
  }
  return PinnedDate;
}

/**
 * gas/*.gs を連結して 1 つの vm コンテキストとして評価する。
 * lineStatus は LINE push の応答コード。数値、または push の本文 (payload) から
 * コードを返す関数（例: サマリー本文だけ 500 を返す = 一時的な送信障害の模擬）。
 * Calendar API は 200 + 予定 (calendarItems) を返す。送信件数は counter で数えるだけ。
 */
function loadGas(props, { dateMs = null, counter = null, lineStatus = 200, calendarItems = [] } = {}) {
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
    LockService: {
      getScriptLock: () => ({
        tryLock: () => true,
        releaseLock: () => {},
      }),
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        const payload = String((options && options.payload) || "");
        const isLine = url.includes("line.me");
        const code = isLine
          ? typeof lineStatus === "function"
            ? lineStatus(payload)
            : lineStatus
          : 200;
        // 届いた数を数える（200 応答のみ。失敗した push は delivery に数えない）
        if (isLine && counter && code === 200) {
          // 週次サマリー本文、差分通知本文、失敗通知本文を区別して数える
          if (payload.includes("📅 今週の予定")) counter.sends = (counter.sends || 0) + 1;
          else if (payload.includes("【Googleカレンダー更新】")) counter.polls = (counter.polls || 0) + 1;
          else if (payload.includes("家族カレンダー通知の実行に失敗")) counter.warnings = (counter.warnings || 0) + 1;
        }
        if (code !== 200) {
          return {
            getResponseCode: () => code,
            getContentText: () => '{"message":"stub failure"}',
            getHeaders: () => ({}),
          };
        }
        const items = typeof calendarItems === "function" ? calendarItems(url) : calendarItems;
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({ items }),
          getHeaders: () => ({}),
        };
      },
    },
    console: { log() {}, warn() {}, error() {} },
  };
  if (dateMs !== null) context.Date = pinnedDateClass(dateMs);
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

// --- ④ 同日の二重送信防止（WEEKLY_SUMMARY_LAST_SENT のタイムゾーン不一致） -------
// 保存値と判定の基準がズレると、ローカル 00:00-08:59 の実行では
// 「前日の UTC 日付」と比較して today に一致せず、同じ日に何回も送ってしまう。
// 00:00 / 02:00 / 08:59 と、既存の正常系 18:00 を同じハーネスで通す。
const SEND_PROPS = {
  CALENDAR_ID: "cal@example.com",
  LINE_CHANNEL_ACCESS_TOKEN: "token",
  LINE_TARGET_ID: "Uxxxx",
};

/** 指定した JST 時刻で sendWeeklySummary() を 2 回走らせ、送信回数を数える */
function countSends(clockTimes, initial = {}, lineStatus = 200) {
  const props = propsStub({ ...SEND_PROPS, ...initial });
  const counter = { sends: 0, warnings: 0 };
  for (const iso of clockTimes) {
    loadGas(props, { dateMs: new Date(iso).getTime(), counter, lineStatus }).sendWeeklySummary();
  }
  return {
    sends: counter.sends,
    warnings: counter.warnings,
    lastSent: props.getProperty("WEEKLY_SUMMARY_LAST_SENT"),
    failureNotifiedAt: props.getProperty("LAST_FAILURE_NOTIFIED_AT"),
  };
}

for (const [label, t1, t2] of [
  ["JST 18:00 (既存)", "2026-09-18T18:00:00+09:00", "2026-09-18T18:10:00+09:00"],
  ["JST 00:00", "2026-09-18T00:00:00+09:00", "2026-09-18T00:10:00+09:00"],
  ["JST 02:00", "2026-09-18T02:00:00+09:00", "2026-09-18T02:10:00+09:00"],
  ["JST 08:59", "2026-09-18T08:59:00+09:00", "2026-09-18T08:59:30+09:00"],
]) {
  check(`${label}: 2 回目は送信しない`, () => {
    assert.equal(countSends([t1, t2]).sends, 1);
  });
}

// 旧形式（UTC ISO）で保存された値も当日分として認識される
for (const saved of [
  "2026-09-17T17:00:00.000Z", // JST 2026-09-18 02:00 に保存された旧値
  "2026-09-18T09:00:00.000Z", // JST 2026-09-18 18:00 に保存された旧値
]) {
  check(`旧形式の保存値 ${saved} を当日分としてスキップ`, () => {
    const { sends } = countSends(["2026-09-18T18:00:00+09:00"], { WEEKLY_SUMMARY_LAST_SENT: saved });
    assert.equal(sends, 0);
  });
}

// 前日に保存された値なら送り直す（ガードを緩めすぎない）
check("前日の保存値なら送信する", () => {
  assert.equal(countSends(["2026-09-18T18:00:00+09:00"], {
    WEEKLY_SUMMARY_LAST_SENT: "2026-09-16T09:00:00.000Z", // JST 2026-09-16 18:00
  }).sends, 1);
});

// --- ⑤ 送信失敗を記録しない（復旧後の同日再送） --------------------------------
// WEEKLY_SUMMARY_LAST_SENT は実際の送信成功だけを「送信済み」とみなす。
// 全チャネルが失敗した日を記録すると、復旧後に当日中の再送が
// 「already sent today」で永久に弾かれる。
// 障害の模擬は「週次サマリー本文だけ 500、失敗通知は 200」で行う。
// これにより (a) 本体の失敗でも (b) 失敗通知自体も落ちるケースでも
// 「送信 0 件 -> LAST_SENT を立てない -> 復旧後に送信」を観測できる。
const isSummary = (p) => p.includes("📅 今週の予定");
const summaryFails = (p) => (isSummary(p) ? 500 : 200);

check("送信失敗時は WEEKLY_SUMMARY_LAST_SENT を立てない", () => {
  const r = countSends(["2026-09-20T18:00:00+09:00"], {}, summaryFails);
  assert.equal(r.sends, 0);
  assert.equal(r.lastSent, null);
});

// 失敗通知も 500 = 本体も警告も届かない最悪ケース。記録も残らない
check("全チャネルが 500: 何も記録しない", () => {
  const r = countSends(["2026-09-20T18:00:00+09:00"], {}, () => 500);
  assert.equal(r.sends, 0);
  assert.equal(r.warnings, 0);
  assert.equal(r.lastSent, null);
  assert.equal(r.failureNotifiedAt, null);
});

check("全チャネル失敗 -> 復旧 -> 同日再実行で送信される", () => {
  const t = (hhmm) => `2026-09-20T${hhmm}:00+09:00`;
  const props = propsStub({ ...SEND_PROPS });
  const counter = { sends: 0, warnings: 0 };
  const run = (hhmm, lineStatus = summaryFails) =>
    loadGas(props, { dateMs: new Date(t(hhmm)).getTime(), counter, lineStatus }).sendWeeklySummary();

  // 18:00 と 18:05: 両方とも送信失敗。失敗通知は 1 通だけ（成功后まで再送しない既存仕様）
  run("18:00");
  assert.equal(counter.sends, 0);
  assert.equal(counter.warnings, 1);
  assert.ok(props.getProperty("LAST_FAILURE_NOTIFIED_AT"), "失敗通知を記録する");
  assert.equal(props.getProperty("WEEKLY_SUMMARY_LAST_SENT"), null, "失敗した日は記録しない");

  run("18:05");
  assert.equal(counter.sends, 0);
  assert.equal(counter.warnings, 1, "失敗通知は再送しない");
  assert.equal(props.getProperty("WEEKLY_SUMMARY_LAST_SENT"), null);

  // 19:00: チャネル復旧後の同日再実行。送られ、送信済みとなり、警告フラグも消える
  run("19:00", 200);
  assert.equal(counter.sends, 1);
  assert.equal(props.getProperty("WEEKLY_SUMMARY_LAST_SENT"), "2026-09-20");
  assert.equal(props.getProperty("LAST_FAILURE_NOTIFIED_AT"), null, "成功で警告フラグを消す");

  // 19:30: 送信後の再実行。1 日 1 回への丸め（既存仕様）に従って
  // 本体も警告も一切再送しない。記録も上書きしない。
  run("19:30");
  assert.equal(counter.sends, 1, "成功した日は再送しない");
  assert.equal(counter.warnings, 1, "送信済みの日は警告も再送しない");
  assert.equal(props.getProperty("WEEKLY_SUMMARY_LAST_SENT"), "2026-09-20");
});

// --- ⑥ 差分ポーリング -------------------------------------------------------

// 1. 正常系: created が LAST_CHECKED_AT より新しい予定を 1 件、LINE は 200 で返す
check("差分ポーリング: 正常系（polls=1, LAST_CHECKED_AT 進む, キャッシュ記録）", () => {
  const initialLastChecked = "2026-09-20T17:50:00.000Z";
  const nowIso = "2026-09-20T18:00:00.000Z";
  const ev = {
    id: "event-1",
    summary: "新しい予定",
    created: "2026-09-20T17:55:00.000Z",
    updated: "2026-09-20T17:55:00.000Z",
    start: { dateTime: "2026-09-21T10:00:00+09:00" },
    end: { dateTime: "2026-09-21T11:00:00+09:00" },
  };
  const props = propsStub({ ...SEND_PROPS, LAST_CHECKED_AT: initialLastChecked });
  const counter = { sends: 0, warnings: 0, polls: 0 };
  loadGas(props, {
    dateMs: new Date(nowIso).getTime(),
    counter,
    calendarItems: [ev],
    lineStatus: 200,
  }).pollCalendarAndNotify();

  assert.equal(counter.polls, 1);
  assert.equal(props.getProperty("LAST_CHECKED_AT"), nowIso);
  const cache = JSON.parse(props.getProperty("NOTIFIED_CACHE") || "{}");
  assert.equal(cache["event-1"], ev.updated);
});

// 2〜4 は連続したシナリオ（LINE 500 失敗 -> 復旧再送 -> 3回目重複防止）
const retryScenario = {
  initialLastChecked: "2026-09-20T17:50:00.000Z",
  ev: {
    id: "event-retry",
    summary: "再送対象の予定",
    created: "2026-09-20T17:55:00.000Z",
    updated: "2026-09-20T17:55:00.000Z",
    start: { dateTime: "2026-09-21T10:00:00+09:00" },
    end: { dateTime: "2026-09-21T11:00:00+09:00" },
  },
  props: null,
  counter: null,
};

// 2. LINE 500 のとき（不具合の再現）
check("差分ポーリング: LINE 500 失敗時に LAST_CHECKED_AT を進めずキャッシュ未記録", () => {
  retryScenario.props = propsStub({ ...SEND_PROPS, LAST_CHECKED_AT: retryScenario.initialLastChecked });
  retryScenario.counter = { sends: 0, warnings: 0, polls: 0 };
  const pollFails = (p) => (p.includes("【Googleカレンダー更新】") ? 500 : 200);

  loadGas(retryScenario.props, {
    dateMs: new Date("2026-09-20T18:00:00.000Z").getTime(),
    counter: retryScenario.counter,
    calendarItems: [retryScenario.ev],
    lineStatus: pollFails,
  }).pollCalendarAndNotify();

  assert.equal(retryScenario.counter.polls, 0);
  assert.equal(retryScenario.counter.warnings, 1);
  assert.equal(retryScenario.props.getProperty("LAST_CHECKED_AT"), retryScenario.initialLastChecked, "失敗時は LAST_CHECKED_AT を進めない");
  const cache = JSON.parse(retryScenario.props.getProperty("NOTIFIED_CACHE") || "{}");
  assert.equal(cache[retryScenario.ev.id], undefined, "失敗時は NOTIFIED_CACHE に記録しない");
});

// 3. 失敗から復旧したあとの再送
check("差分ポーリング: 復旧後の再送で未送信の変更が届き、LAST_CHECKED_AT が進む", () => {
  loadGas(retryScenario.props, {
    dateMs: new Date("2026-09-20T18:05:00.000Z").getTime(),
    counter: retryScenario.counter,
    calendarItems: [retryScenario.ev],
    lineStatus: 200,
  }).pollCalendarAndNotify();

  assert.equal(retryScenario.counter.polls, 1, "復旧後に失敗した回の変更が届く");
  assert.equal(retryScenario.props.getProperty("LAST_CHECKED_AT"), "2026-09-20T18:05:00.000Z", "成功で LAST_CHECKED_AT が進む");
  assert.equal(retryScenario.props.getProperty("LAST_FAILURE_NOTIFIED_AT"), null, "成功で失敗通知がクリアされる");
});

// 4. 復旧後の 3 回目の実行
check("差分ポーリング: 復旧後の3回目実行で重複送信されない（NOTIFIED_CACHE）", () => {
  loadGas(retryScenario.props, {
    dateMs: new Date("2026-09-20T18:10:00.000Z").getTime(),
    counter: retryScenario.counter,
    calendarItems: [retryScenario.ev],
    lineStatus: 200,
  }).pollCalendarAndNotify();

  assert.equal(retryScenario.counter.polls, 1, "同じ予定は重複通知されない");
});

// 5. DEBUG_MODE=true のとき
check("差分ポーリング: DEBUG_MODE=true のときは LINE 送信せず LAST_CHECKED_AT は進む", () => {
  const initialLastChecked = "2026-09-20T17:50:00.000Z";
  const nowIso = "2026-09-20T18:00:00.000Z";
  const ev = {
    id: "event-debug",
    summary: "ドライラン予定",
    created: "2026-09-20T17:55:00.000Z",
    updated: "2026-09-20T17:55:00.000Z",
    start: { dateTime: "2026-09-21T10:00:00+09:00" },
    end: { dateTime: "2026-09-21T11:00:00+09:00" },
  };
  const props = propsStub({ ...SEND_PROPS, LAST_CHECKED_AT: initialLastChecked, DEBUG_MODE: "true" });
  const counter = { sends: 0, warnings: 0, polls: 0 };
  loadGas(props, {
    dateMs: new Date(nowIso).getTime(),
    counter,
    calendarItems: [ev],
    lineStatus: 200,
  }).pollCalendarAndNotify();

  assert.equal(counter.polls, 0);
  assert.equal(props.getProperty("LAST_CHECKED_AT"), nowIso);
  const cache = JSON.parse(props.getProperty("NOTIFIED_CACHE") || "{}");
  assert.equal(cache["event-debug"], ev.updated);
});

// 6. classifyChange の単体テスト
check("classifyChange: 変更種別判定（キャンセル / 新規 / 更新 / null）", () => {
  const ctx = loadGas(propsStub());
  const lastCheckedIso = "2026-09-20T18:00:00.000Z";

  // status: "cancelled" なら キャンセル
  assert.equal(
    ctx.classifyChange(
      { status: "cancelled", created: "2026-09-20T17:00:00.000Z", updated: "2026-09-20T17:00:00.000Z" },
      lastCheckedIso,
    ),
    "キャンセル",
  );

  // created > lastChecked なら 新規
  assert.equal(
    ctx.classifyChange(
      { created: "2026-09-20T18:05:00.000Z", updated: "2026-09-20T18:05:00.000Z" },
      lastCheckedIso,
    ),
    "新規",
  );

  // updated だけが新しければ 更新
  assert.equal(
    ctx.classifyChange(
      { created: "2026-09-20T17:50:00.000Z", updated: "2026-09-20T18:05:00.000Z" },
      lastCheckedIso,
    ),
    "更新",
  );

  // どちらも古ければ null
  assert.equal(
    ctx.classifyChange(
      { created: "2026-09-20T17:50:00.000Z", updated: "2026-09-20T17:55:00.000Z" },
      lastCheckedIso,
    ),
    null,
  );
});

// 7. computeLastCheckedDate の単体テスト
check("computeLastCheckedDate: 未設定・不正値・上限キャップの計算", () => {
  const ctx = loadGas(propsStub());
  const now = new Date("2026-09-20T18:00:00.000Z");
  const sixHoursMs = 6 * 60 * 60 * 1000;
  const safetyOffsetMs = 60 * 1000;

  // 未設定: 6 時間前の時刻を返し、droppedMs は 0
  const resNull = ctx.computeLastCheckedDate(null, now);
  assert.equal(resNull.date.getTime(), now.getTime() - sixHoursMs);
  assert.equal(resNull.droppedMs, 0);

  // 不正値: 6 時間前の時刻を返し、droppedMs は 0
  const resInvalid = ctx.computeLastCheckedDate("not-a-valid-date", now);
  assert.equal(resInvalid.date.getTime(), now.getTime() - sixHoursMs);
  assert.equal(resInvalid.droppedMs, 0);

  // 10 時間前の値: droppedMs が約 4 時間（から 60 秒を引いた値、または巻き戻し差分）
  const tenHoursAgo = new Date(now.getTime() - 10 * 60 * 60 * 1000).toISOString();
  const res10h = ctx.computeLastCheckedDate(tenHoursAgo, now);
  assert.equal(res10h.date.getTime(), now.getTime() - sixHoursMs);
  const expectedDroppedMs = (now.getTime() - sixHoursMs) - (new Date(tenHoursAgo).getTime() - safetyOffsetMs);
  assert.equal(res10h.droppedMs, expectedDroppedMs);
});

if (failed > 0) {
  console.error(`${failed} test(s) failed.`);
  process.exit(1);
}
console.log("GAS tests passed.");