const PROP_KEYS = {
  lastCheckedAt: "LAST_CHECKED_AT",
  calendarId: "CALENDAR_ID",
  webhookUrl: "DISCORD_WEBHOOK_URL",
  lineChannelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
  lineTargetId: "LINE_TARGET_ID",
  notifiedCache: "NOTIFIED_CACHE",
  debugMode: "DEBUG_MODE",
};

const HANDLER = "pollCalendarAndNotify"; // トリガーで実行する関数名

const DEFAULT_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours
const SAFETY_OFFSET_MS = 60 * 1000; // rewind by 60 seconds to avoid misses
const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";
const TRIGGER_INTERVAL_MINUTES = 5;
const MAX_NOTIFIED_CACHE_ENTRIES = 200;
const DISCORD_CHUNK_INTERVAL_MS = 1000; // レート制限対策: チャンク間待機 (ms)
const DISCORD_MAX_RETRIES = 3;
const LOCK_TIMEOUT_MS = 10 * 60 * 1000; // ロックの有効期限 (10分)
const CALENDAR_API_MAX_RETRIES = 3;
// LINE Messaging API 関連 (LINE Notify は 2025/3 廃止のため非採用)
const LINE_PUSH_URL = "https://api.line.me/v2/bot/message/push";
const LINE_MAX_RETRIES = 3;
const LINE_MAX_TEXT_LENGTH = 5000; // 1メッセージあたりの文字数上限
const LINE_MAX_MESSAGES_PER_PUSH = 5; // 1 push あたりのメッセージ数上限
const LINE_CHUNK_INTERVAL_MS = 1000; // レート制限対策: push 間待機 (ms)

/**
 * 直近の更新差分を取得して Discord / LINE に通知
 * - Discord: DISCORD_WEBHOOK_URL が設定されている場合のみ送信
 * - LINE: LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID が両方設定されている場合のみ送信
 * どちらも未設定の場合は警告して中断。いずれか1つでも送信成功すれば通知済みキャッシュに記録。
 */
function pollCalendarAndNotify() {
  const props = PropertiesService.getScriptProperties();

  // 実行ロックを取得（取得できなければスキップ）。標準の LockService を使用。
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_TIMEOUT_MS)) {
    logInfo("前回の実行が継続中のためスキップします。");
    return;
  }

  try {

    // Validate configuration early
    const validation = validateSetup();
    if (!validation.ready) {
      logWarn("Setup validation failed: " + validation.warnings.join(", "));
      return;
    }
    const calendarId = (props.getProperty(PROP_KEYS.calendarId) || "").trim();
    const webhookUrl = (props.getProperty(PROP_KEYS.webhookUrl) || "").trim();
    const lineChannelAccessToken = (
      props.getProperty(PROP_KEYS.lineChannelAccessToken) || ""
    ).trim();
    const lineTargetId = (props.getProperty(PROP_KEYS.lineTargetId) || "").trim();

    const hasDiscord = !!calendarId && !!webhookUrl;
    const hasLine = !!lineChannelAccessToken && !!lineTargetId;

    if (!calendarId) {
      logWarn("Script Properties に CALENDAR_ID が未設定です。");
      return;
    }
    if (!hasDiscord && !hasLine) {
      logWarn(
        "Script Properties に通知先が未設定です。DISCORD_WEBHOOK_URL または LINE_CHANNEL_ACCESS_TOKEN + LINE_TARGET_ID を設定してください。",
      );
      return;
    }

    const now = new Date();
    const nowIso = now.toISOString();
    const lastCheckedDate = computeLastCheckedDate(props.getProperty(PROP_KEYS.lastCheckedAt), now);
    const lastCheckedIso = lastCheckedDate.toISOString();

    let updates;
    try {
      updates = fetchCalendarUpdates(calendarId, lastCheckedIso);
    } catch (err) {
      logError("Calendar API 呼び出しに失敗しました。設定や権限を確認してください。", err);
      // エラー時も時刻を進めて長期間の重複通知を防ぐ
      props.setProperty(PROP_KEYS.lastCheckedAt, nowIso);
      throw err;
    }

    const cache = loadNotifiedCache(props);
    const newUpdates = updates.filter(({ ev }) => !isAlreadyNotified(cache, ev));

    logInfo(
      `Calendar diff: ${updates.length} updates since ${lastCheckedIso} -> ${nowIso} (${newUpdates.length} new)`,
    );
    if (newUpdates.length) {
      const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
      const messages = newUpdates.map(({ kind, ev }) => buildMessage(kind, ev, tz));
      if (isDebugMode(props)) {
        const channels = [];
        if (hasDiscord) channels.push("Discord");
        if (hasLine) channels.push("LINE");
        logInfo(
          `[DRY-RUN] 以下の ${messages.length} 件を ${channels.join(" / ")} へ送信予定（DEBUG_MODE=ON）:\n${messages.join("\n---\n")}`,
        );
        // ドライラン時もキャッシュに記録して重複通知を防ぐ
        newUpdates.forEach(({ ev }) => markNotified(cache, ev));
        saveNotifiedCache(props, cache);
      } else {
        let discordOk = !hasDiscord; // 送信不要なら成功扱い
        let lineOk = !hasLine;

        if (hasDiscord) {
          try {
            postToDiscordInChunks(webhookUrl, messages);
          } catch (err) {
            logError(
              "Discord 送信処理でエラーが発生しました。Webhook URL を確認してください。",
              err,
            );
            discordOk = false;
          }
        }

        if (hasLine) {
          try {
            postToLineInChunks(lineChannelAccessToken, lineTargetId, messages);
          } catch (err) {
            logError(
              "LINE 送信処理でエラーが発生しました。アクセストークン / ターゲット ID を確認してください。",
              err,
            );
            lineOk = false;
          }
        }

        // いずれか一方でも送信成功すれば通知済みとして記録
        if (discordOk || lineOk) {
          newUpdates.forEach(({ ev }) => markNotified(cache, ev));
        }
        // 重複通知防止のため、成否にかかわらずキャッシュを保存
        saveNotifiedCache(props, cache);
        if (!discordOk && !lineOk) {
          logError("Discord / LINE 両方の送信に失敗しました。");
        }
      }
    }

    props.setProperty(PROP_KEYS.lastCheckedAt, nowIso);
  } finally {
    lock.releaseLock();
  }
}

function fetchCalendarUpdates(calendarId, lastCheckedIso) {
  const updates = [];
  let pageToken = null;

  do {
    const res = listCalendarEvents(calendarId, lastCheckedIso, pageToken);
    if (res.items && res.items.length) {
      for (const ev of res.items) {
        const kind = classifyChange(ev, lastCheckedIso);
        if (!kind) continue;
        updates.push({ kind, ev });
      }
    }
    pageToken = res.nextPageToken || null;
  } while (pageToken);

  return updates;
}

function isDebugMode(props) {
  return (props.getProperty(PROP_KEYS.debugMode) || "").toLowerCase() === "true";
}

// ---- Calendar API ----

function computeLastCheckedDate(rawValue, now) {
  // updatedMin が古すぎると Calendar API が 410 を返すため、最大遡り幅を DEFAULT_LOOKBACK_MS でキャップ
  const floorMs = now.getTime() - DEFAULT_LOOKBACK_MS;

  if (!rawValue) {
    return new Date(floorMs);
  }

  const parsed = new Date(rawValue);
  const parsedMs = parsed.getTime();
  if (Number.isNaN(parsedMs)) {
    logWarn(`LAST_CHECKED_AT (${rawValue}) が不正だったためリセットします。`);
    return new Date(floorMs);
  }

  // SAFETY_OFFSET で少し巻き戻しつつ、古すぎる場合は floorMs でキャップ
  const rewound = parsedMs - SAFETY_OFFSET_MS;
  return new Date(Math.max(rewound, floorMs));
}

function listCalendarEvents(calendarId, updatedMin, pageToken) {
  const params = {
    updatedMin,
    showDeleted: "true",
    singleEvents: "false",
    maxResults: "2500",
    orderBy: "updated",
  };
  if (pageToken) params.pageToken = pageToken;

  const query = Object.keys(params)
    .filter((key) => params[key])
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join("&");

  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events${query ? `?${query}` : ""}`;

  let lastError;
  for (let attempt = 1; attempt <= CALENDAR_API_MAX_RETRIES; attempt++) {
    const res = UrlFetchApp.fetch(url, {
      method: "get",
      headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
      muteHttpExceptions: true,
    });

    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code >= 200 && code < 300) {
      return JSON.parse(text || "{}");
    }

    let message = `Calendar API error (status ${code})`;
    try {
      const body = JSON.parse(text);
      if (body && body.error && body.error.message) {
        message += `: ${body.error.message}`;
      }
    } catch (parseErr) {
      message += `: ${text}`;
    }
    lastError = new Error(message);

    if (attempt < CALENDAR_API_MAX_RETRIES) {
      const waitMs = 1000 * attempt;
      logWarn(
        `Calendar API 呼び出し失敗。${waitMs}ms 後にリトライ (${attempt}/${CALENDAR_API_MAX_RETRIES})`,
      );
      Utilities.sleep(waitMs);
    }
  }
  throw lastError;
}

/**
 * 変更種別の判定
 */
function classifyChange(ev, lastCheckedIso) {
  const lastCheckedMs = new Date(lastCheckedIso).getTime();
  const createdMs = ev.created ? new Date(ev.created).getTime() : 0;
  const updatedMs = ev.updated ? new Date(ev.updated).getTime() : 0;
  if (ev.status === "cancelled") return "キャンセル";
  if (createdMs > lastCheckedMs) return "新規";
  if (updatedMs > lastCheckedMs) return "更新";
  return null;
}

/**
 * メッセージを maxLen ごとに分割（sep で結合し、maxLen 超過で新チャンクへ）。
 * 各メッセージは truncateMessage で maxLen に丸める。
 */
function chunkMessages(messages, sep, maxLen) {
  const chunks = [];
  let buffer = "";
  for (const rawMsg of messages) {
    const msg = truncateMessage(rawMsg, maxLen);
    if (!msg) continue;

    const joined = buffer ? buffer + sep + msg : msg;
    if (joined.length > maxLen) {
      if (buffer) chunks.push(buffer);
      buffer = msg;
    } else {
      buffer = joined;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/**
 * Discord メッセージを分割送信
 */
function postToDiscordInChunks(webhookUrl, messages) {
  const chunks = chunkMessages(messages, "\n\n", 1800);
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) Utilities.sleep(DISCORD_CHUNK_INTERVAL_MS);
    postToDiscord(webhookUrl, chunks[i]);
  }
}

/**
 * Discord Webhook へ送信（429 時は Retry-After に従いリトライ）
 */
function postToDiscord(webhookUrl, content) {
  const payload = { content };
  const params = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  for (let attempt = 1; attempt <= DISCORD_MAX_RETRIES; attempt++) {
    const res = UrlFetchApp.fetch(webhookUrl, params);
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return;

    if (code === 429 && attempt < DISCORD_MAX_RETRIES) {
      let waitMs = DISCORD_CHUNK_INTERVAL_MS * attempt;
      try {
        const body = JSON.parse(res.getContentText());
        if (body.retry_after) waitMs = Math.ceil(body.retry_after * 1000);
      } catch (_) {}
      logWarn(
        `Discord レート制限 (429)。${waitMs}ms 後にリトライ (${attempt}/${DISCORD_MAX_RETRIES})`,
      );
      Utilities.sleep(waitMs);
      continue;
    }

    const body = res.getContentText();
    const err = new Error(`Discord 送信エラー (${code}): ${body}`);
    logError(`Discord 送信エラー (${code})`, err);
    throw err;
  }
  throw new Error("Discord 送信エラー: リトライ上限に達しました (429)");
}

/**
 * LINE Messaging API へのメッセージ送信 (push) をチャンク分割で実行
 * @param {string} channelAccessToken LINE_CHANNEL_ACCESS_TOKEN
 * @param {string} targetId LINE_TARGET_ID (ユーザー/グループ/トークルーム ID)
 * @param {string[]} messages 各更新の通知メッセージ配列
 */
function postToLineInChunks(channelAccessToken, targetId, messages) {
  const chunks = chunkMessages(messages, "\n\n", LINE_MAX_TEXT_LENGTH);
  // LINE_MAX_MESSAGES_PER_PUSH 件ずつ 1 push にまとめて送信
  for (let i = 0; i < chunks.length; i += LINE_MAX_MESSAGES_PER_PUSH) {
    if (i > 0) Utilities.sleep(LINE_CHUNK_INTERVAL_MS);
    const batch = chunks.slice(i, i + LINE_MAX_MESSAGES_PER_PUSH);
    postToLine(channelAccessToken, targetId, batch);
  }
}

/**
 * LINE Messaging API の push エンドポイントへ送信（429 時は Retry-After に従いリトライ）
 * @param {string} channelAccessToken
 * @param {string} targetId
 * @param {string[]} messageTexts 1 push に含めるテキストメッセージ配列 (最大 LINE_MAX_MESSAGES_PER_PUSH)
 */
function postToLine(channelAccessToken, targetId, messageTexts) {
  const payload = {
    to: targetId,
    messages: messageTexts.map((text) => ({ type: "text", text })),
  };
  const params = {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${channelAccessToken}` },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  for (let attempt = 1; attempt <= LINE_MAX_RETRIES; attempt++) {
    const res = UrlFetchApp.fetch(LINE_PUSH_URL, params);
    const code = res.getResponseCode();
    if (code >= 200 && code < 300) return;

    // 401 (認証エラー) / 400 (リクエスト不正) はリトライせず即時例外
    if (code === 401 || code === 400) {
      const body = res.getContentText();
      const err = new Error(`LINE 認証/リクエストエラー (${code}): ${body}`);
      logError(`LINE 送信エラー (${code}) - アクセストークン/ターゲットIDを確認してください`, err);
      throw err;
    }

    if (code === 429 && attempt < LINE_MAX_RETRIES) {
      let waitMs = LINE_CHUNK_INTERVAL_MS * attempt;
      const retryAfter = res.getHeaders()["Retry-After"];
      if (retryAfter) {
        const parsed = parseInt(retryAfter, 10);
        if (!Number.isNaN(parsed)) waitMs = parsed * 1000;
      }
      logWarn(`LINE レート制限 (429)。${waitMs}ms 後にリトライ (${attempt}/${LINE_MAX_RETRIES})`);
      Utilities.sleep(waitMs);
      continue;
    }

    const body = res.getContentText();
    const err = new Error(`LINE 送信エラー (${code}): ${body}`);
    logError(`LINE 送信エラー (${code})`, err);
    throw err;
  }
  throw new Error("LINE 送信エラー: リトライ上限に達しました (429)");
}

/**
 * 5分毎の時間主導トリガーを作成
 */
function installTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some((t) => t.getHandlerFunction() === HANDLER);
  if (!exists) {
    ScriptApp.newTrigger(HANDLER).timeBased().everyMinutes(TRIGGER_INTERVAL_MINUTES).create();
  }
}

/**
 * pollCalendarAndNotify のトリガーを削除
 */
function uninstallAllTriggers() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === HANDLER)
    .forEach((t) => ScriptApp.deleteTrigger(t));
}

// ---- 通知済みキャッシュ管理 ----

function loadNotifiedCache(props) {
  try {
    return JSON.parse(props.getProperty(PROP_KEYS.notifiedCache) || "{}");
  } catch (_) {
    return {};
  }
}

function isAlreadyNotified(cache, ev) {
  return Object.prototype.hasOwnProperty.call(cache, ev.id) && cache[ev.id] === ev.updated;
}

function markNotified(cache, ev) {
  cache[ev.id] = ev.updated;
}

function saveNotifiedCache(props, cache) {
  const entries = Object.entries(cache);
  if (entries.length > MAX_NOTIFIED_CACHE_ENTRIES) {
    // updated 昇順ソートで古いエントリを優先削除
    entries.sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    const trimmed = Object.fromEntries(entries.slice(entries.length - MAX_NOTIFIED_CACHE_ENTRIES));
    props.setProperty(PROP_KEYS.notifiedCache, JSON.stringify(trimmed));
  } else {
    props.setProperty(PROP_KEYS.notifiedCache, JSON.stringify(cache));
  }
}

function logInfo(message) {
  Logger.log(`INFO: ${message}`);
}

function logWarn(message) {
  Logger.log(`WARN: ${message}`);
}

function logError(message, err) {
  let fullMessage = `ERROR: ${message}`;
  if (err) {
    const detail = err.stack || err.message || String(err);
    fullMessage += `\n${detail}`;
  }
  Logger.log(fullMessage);
}
