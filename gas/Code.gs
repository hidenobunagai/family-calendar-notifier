const PROP_KEYS = {
  lastCheckedAt: 'LAST_CHECKED_AT',
  calendarId: 'CALENDAR_ID',
  webhookUrl: 'DISCORD_WEBHOOK_URL',
};

const DEFAULT_LOOKBACK_MS = 6 * 60 * 60 * 1000; // 6 hours
const SAFETY_OFFSET_MS = 60 * 1000; // rewind by 60 seconds to avoid misses
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';

/**
 * 直近の更新差分を取得して Discord に通知
 */
function pollCalendarAndNotify() {
  const props = PropertiesService.getScriptProperties();
  const calendarId = (props.getProperty(PROP_KEYS.calendarId) || '').trim();
  const webhookUrl = (props.getProperty(PROP_KEYS.webhookUrl) || '').trim();

  if (!calendarId || !webhookUrl) {
    logWarn('Script Properties に CALENDAR_ID / DISCORD_WEBHOOK_URL が未設定です。');
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
    logError('Calendar API 呼び出しに失敗しました。設定や権限を確認してください。', err);
    throw err;
  }

  logInfo(`Calendar diff: ${updates.length} updates since ${lastCheckedIso} -> ${nowIso}`);
  if (updates.length) {
    const tz = Session.getScriptTimeZone() || 'Asia/Tokyo';
    const messages = updates.map(({ kind, ev }) => buildDiscordMessage(kind, ev, tz));
    try {
      postToDiscordInChunks(webhookUrl, messages);
    } catch (err) {
      logError('Discord 送信処理でエラーが発生しました。Webhook URL を確認してください。', err);
      throw err;
    }
  }

  props.setProperty(PROP_KEYS.lastCheckedAt, nowIso);
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

function computeLastCheckedDate(rawValue, now) {
  const fallback = now.getTime() - DEFAULT_LOOKBACK_MS;
  if (!rawValue) {
    return new Date(fallback - SAFETY_OFFSET_MS);
  }

  const parsed = new Date(rawValue);
  const parsedMs = parsed.getTime();
  if (Number.isNaN(parsedMs)) {
    logWarn(`LAST_CHECKED_AT (${rawValue}) が不正だったためリセットします。`);
    return new Date(fallback - SAFETY_OFFSET_MS);
  }

  const rewound = Math.max(parsedMs - SAFETY_OFFSET_MS, 0);
  return new Date(rewound);
}

function listCalendarEvents(calendarId, updatedMin, pageToken) {
  const params = {
    updatedMin,
    showDeleted: 'true',
    singleEvents: 'false',
    maxResults: '2500',
    orderBy: 'updated',
  };
  if (pageToken) params.pageToken = pageToken;

  const query = Object.keys(params)
    .filter((key) => params[key])
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`)
    .join('&');

  const url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events${query ? `?${query}` : ''}`;

  const res = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: `Bearer ${ScriptApp.getOAuthToken()}` },
    muteHttpExceptions: true,
  });

  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code >= 200 && code < 300) {
    return JSON.parse(text || '{}');
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
  throw new Error(message);
}

/**
 * 変更種別の判定
 */
function classifyChange(ev, lastCheckedIso) {
  const lastCheckedMs = new Date(lastCheckedIso).getTime();
  const createdMs = ev.created ? new Date(ev.created).getTime() : 0;
  const updatedMs = ev.updated ? new Date(ev.updated).getTime() : 0;
  if (ev.status === 'cancelled') return 'キャンセル';
  if (createdMs > lastCheckedMs) return '新規';
  if (updatedMs > lastCheckedMs) return '更新';
  return null;
}

/**
 * Discord メッセージを分割送信
 */
function postToDiscordInChunks(webhookUrl, messages) {
  const maxLen = 1800; // 余裕を持って分割
  let buffer = '';
  for (const rawMsg of messages) {
    const msg = normalizeDiscordMessage(rawMsg, maxLen);
    if (!msg) continue;
    if ((buffer + '\n\n' + msg).length > maxLen) {
      if (buffer) postToDiscord(webhookUrl, buffer);
      buffer = msg;
    } else {
      buffer = buffer ? buffer + '\n\n' + msg : msg;
    }
  }
  if (buffer) postToDiscord(webhookUrl, buffer);
}

function normalizeDiscordMessage(message, maxLen) {
  if (!message) return '';
  if (message.length <= maxLen) return message;
  const ellipsis = '…';
  const limit = Math.max(maxLen - ellipsis.length, 0);
  return `${message.slice(0, limit)}${ellipsis}`;
}

/**
 * Discord Webhook へ送信
 */
function postToDiscord(webhookUrl, content) {
  const payload = { content };
  const params = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };
  const res = UrlFetchApp.fetch(webhookUrl, params);
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    const body = res.getContentText();
    const err = new Error(`Discord 送信エラー (${code}): ${body}`);
    logError(err.message);
    throw err;
  }
}

/**
 * 5分毎の時間主導トリガーを作成
 */
function installTrigger() {
  const fn = 'pollCalendarAndNotify';
  const triggers = ScriptApp.getProjectTriggers();
  const exists = triggers.some((t) => t.getHandlerFunction() === fn);
  if (!exists) {
    ScriptApp.newTrigger(fn).timeBased().everyMinutes(5).create();
  }
}

/**
 * トリガーを全削除
 */
function uninstallAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) ScriptApp.deleteTrigger(t);
}

function logInfo(message) {
  safeLog(`INFO: ${message}`);
}

function logWarn(message) {
  safeLog(`WARN: ${message}`);
}

function logError(message, err) {
  let fullMessage = `ERROR: ${message}`;
  if (err) {
    const detail = err.stack || err.message || String(err);
    fullMessage += `\n${detail}`;
  }
  safeLog(fullMessage);
}

function safeLog(message) {
  try {
    Logger.log(message);
  } catch (e) {
    // ignore logging failures
  }
}
