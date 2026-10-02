/**
 * Weekly Summary Feature
 * Sends a digest of upcoming events every Sunday evening
 * to help family plan the week ahead.
 */

const WEEKLY_SUMMARY_PROP_KEYS = {
  enabled: "WEEKLY_SUMMARY_ENABLED",
  dayOfWeek: "WEEKLY_SUMMARY_DAY",   // 0=Sunday, 1=Monday, etc.
  hour: "WEEKLY_SUMMARY_HOUR",       // Hour in local timezone (24h format)
  lastSentAt: "WEEKLY_SUMMARY_LAST_SENT",
  minute: "WEEKLY_SUMMARY_MINUTE"
};

const WEEKLY_SUMMARY_HANDLER = "sendWeeklySummary";

const WEEKLY_SUMMARY_WEEKDAYS = [
  ScriptApp.WeekDay.SUNDAY,
  ScriptApp.WeekDay.MONDAY,
  ScriptApp.WeekDay.TUESDAY,
  ScriptApp.WeekDay.WEDNESDAY,
  ScriptApp.WeekDay.THURSDAY,
  ScriptApp.WeekDay.FRIDAY,
  ScriptApp.WeekDay.SATURDAY,
];

/**
 * Main weekly summary function - called by weekly trigger
 */
function sendWeeklySummary() {
  const props = PropertiesService.getScriptProperties();
  
  // Check if enabled
  const enabled = props.getProperty(WEEKLY_SUMMARY_PROP_KEYS.enabled);
  if (enabled === "false") {
    logInfo("Weekly summary is disabled. Skipping.");
    return;
  }
  
  // Validate setup
  const calendarId = (props.getProperty(PROP_KEYS.calendarId) || "").trim();
  const lineChannelAccessToken = (props.getProperty(PROP_KEYS.lineChannelAccessToken) || "").trim();
  const lineTargetId = (props.getProperty(PROP_KEYS.lineTargetId) || "").trim();

  const hasLine = !!lineChannelAccessToken && !!lineTargetId;

  if (!calendarId) {
    logWarn("Weekly summary: CALENDAR_ID not set. Skipping.");
    return;
  }
  if (!hasLine) {
    logWarn("Weekly summary: No notification channel configured. Skipping.");
    return;
  }
  
  // Check if already sent today (prevent duplicates)
  const lastSent = props.getProperty(WEEKLY_SUMMARY_PROP_KEYS.lastSentAt);
  const now = new Date();
  const today = Utilities.formatDate(now, Session.getScriptTimeZone() || "Asia/Tokyo", "yyyy-MM-dd");
  if (lastSent && lastSent.startsWith(today)) {
    logInfo("Weekly summary already sent today. Skipping.");
    return;
  }
  
  logInfo("Generating weekly summary...");
  
  // Fetch events for the next 7 full days: tomorrow 0:00 local up to the 8th day 0:00.
  // endDate is exclusive so the fetch range, the day headings and the header range agree.
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const endDate = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate() + 7);
  
  let events;
  try {
    events = fetchEventsForRange(calendarId, startDate.toISOString(), endDate.toISOString());
  } catch (err) {
    logError("Weekly summary: Failed to fetch calendar events.", err);
    notifyFailureOnce(props, "週次サマリーの予定取得に失敗しました（Calendar API エラー）");
    return;
  }
  
  if (events.length === 0) {
    logInfo("Weekly summary: No upcoming events in the next 7 days. Sending an empty summary.");
  }
  
  // Format the summary
  const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
  const summary = formatWeeklySummary(events, startDate, endDate, tz);
  
  // Send to LINE
  const messages = [summary];
  let lineOk = true;

  if (isDebugMode(props)) {
    logInfo(`[DRY-RUN] 週次サマリーを LINE へ送信予定（DEBUG_MODE=ON）:\n${summary}`);
    logInfo("Weekly summary generation complete (dry run).");
    return;
  }

  try {
    postToLine(lineChannelAccessToken, lineTargetId, messages);
    logInfo("Weekly summary sent to LINE.");
  } catch (err) {
    logError("Weekly summary: LINE send failed.", err);
    lineOk = false;
  }

  const delivered = lineOk;
  if (delivered) {
    clearFailureNotification(props);
  } else {
    notifyFailureOnce(props, "週次サマリーの送信に失敗しました（LINE 送信エラー）");
  }

  // Record that we sent it
  props.setProperty(WEEKLY_SUMMARY_PROP_KEYS.lastSentAt, now.toISOString());
  logInfo("Weekly summary generation complete.");
}

/**
 * Fetch events for a specific date range
 */
function fetchEventsForRange(calendarId, timeMin, timeMax) {
  const allEvents = [];
  let pageToken = null;
  
  do {
    const result = listCalendarEventsRange(calendarId, timeMin, timeMax, pageToken);
    allEvents.push(...result.events);
    pageToken = result.nextPageToken;
  } while (pageToken);
  
  return allEvents;
}

/**
 * List calendar events for a specific time range
 */
function listCalendarEventsRange(calendarId, timeMin, timeMax, pageToken) {
  // 未定義だった getAccessToken を廃止し、Code.gs と同じ ScriptApp.getOAuthToken() を使う
  const accessToken = ScriptApp.getOAuthToken();
  
  let url = `${CALENDAR_API_BASE}/calendars/${encodeURIComponent(calendarId)}/events?` +
    `timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&` +
    `singleEvents=true&orderBy=startTime`;
  
  if (pageToken) {
    url += `&pageToken=${encodeURIComponent(pageToken)}`;
  }
  
  const options = {
    method: "get",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    muteHttpExceptions: true,
  };
  
  let res;
  for (let attempt = 1; attempt <= CALENDAR_API_MAX_RETRIES; attempt++) {
    res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    if (code === 200) {
      const data = JSON.parse(res.getContentText());
      return {
        events: data.items || [],
        nextPageToken: data.nextPageToken || null,
      };
    }
    
    // Handle rate limiting (429)
    if (code === 429) {
      let waitMs = 2000 * attempt;
      try {
        const headers = res.getHeaders();
        waitMs = parseInt(headers["Retry-After"] || "2000", 10) * 1000;
      } catch (_) {}
      logWarn(`Calendar API rate limit (429). Retrying in ${waitMs}ms (${attempt}/${CALENDAR_API_MAX_RETRIES})`);
      Utilities.sleep(waitMs);
      continue;
    }
    
    throw new Error(`Calendar API error (${code}): ${res.getContentText()}`);
  }
  
  throw new Error("Calendar API: Retry limit exceeded");
}

/**
 * Format weekly summary message
 */
/**
 * イベントが対象とする日付文字列 (yyyy-MM-dd) の配列を返す。
 * 複数日にまたがる予定（終日または日時指定）を各日に展開するために使用。
 */
function getEventDates(ev, tz) {
  // 終日イベント (start.date, end.date)
  if (ev.start && ev.start.date) {
    const dates = [];
    const startStr = ev.start.date;
    const endDate = ev.end && ev.end.date ? new Date(ev.end.date) : new Date(startStr);
    const cur = new Date(startStr);
    while (cur < endDate) {
      dates.push(Utilities.formatDate(cur, tz, "yyyy-MM-dd"));
      cur.setDate(cur.getDate() + 1);
    }
    return dates.length ? dates : [startStr];
  }

  // 時間指定イベント (start.dateTime, end.dateTime)
  if (ev.start && ev.start.dateTime) {
    const start = new Date(ev.start.dateTime);
    const end = ev.end && ev.end.dateTime ? new Date(ev.end.dateTime) : start;

    const startDayStr = Utilities.formatDate(start, tz, "yyyy-MM-dd");
    const endDayStr = Utilities.formatDate(end, tz, "yyyy-MM-dd");

    if (startDayStr === endDayStr) {
      return [startDayStr];
    }

    const dates = [];
    const cur = new Date(startDayStr);
    const endDay = new Date(endDayStr);
    const isMidnightEnd = Utilities.formatDate(end, tz, "HH:mm") === "00:00";

    while (cur <= endDay) {
      if (cur.getTime() === endDay.getTime() && isMidnightEnd) {
        break;
      }
      dates.push(Utilities.formatDate(cur, tz, "yyyy-MM-dd"));
      cur.setDate(cur.getDate() + 1);
    }
    return dates.length ? dates : [startDayStr];
  }

  return [];
}

// New version that includes all days, showing 予定なし for empty days
function formatWeeklySummary(events, startDate, endDate, tz) {
  const dayNames = ["日", "月", "火", "水", "木", "金", "土"];

  // Group events by date (supporting multi-day events)
  const eventsByDate = {};
  events.forEach((ev) => {
    const coveredDates = getEventDates(ev, tz);
    const isMultiDay = coveredDates.length > 1;
    coveredDates.forEach((dateStr, idx) => {
      if (!eventsByDate[dateStr]) {
        eventsByDate[dateStr] = [];
      }
      eventsByDate[dateStr].push({
        event: ev,
        dayIndex: idx + 1,
        totalDays: coveredDates.length,
        isMultiDay: isMultiDay,
      });
    });
  });

  // Days covered by the summary. endDate is exclusive, so this is exactly 7 days, and
  // the header and the day headings are both derived from this single list.
  const days = [];
  for (let d = new Date(startDate); d < endDate; d.setDate(d.getDate() + 1)) {
    days.push(new Date(d));
  }

  // Build header
  const startStr = Utilities.formatDate(days[0], tz, "yyyy/MM/dd");
  const endStr = Utilities.formatDate(days[days.length - 1], tz, "yyyy/MM/dd");
  let summary = `📅 今週の予定 (Weekly Plan)\n`;
  summary += `${startStr} - ${endStr}\n`;
  summary += "━━━━━━━━━━━━━━━━━━━━━━━━\n";

  let eventCount = 0;
  days.forEach((day) => {
    const dateStr = Utilities.formatDate(day, tz, "yyyy-MM-dd");
    const dayOfWeek = day.getDay();

    summary += `\n【${dayNames[dayOfWeek]}曜日】\n`;

    if (eventsByDate[dateStr] && eventsByDate[dateStr].length > 0) {
      eventsByDate[dateStr].forEach(({ event: ev, dayIndex, totalDays, isMultiDay }) => {
        let time;
        if (ev.start.dateTime) {
          const evStart = new Date(ev.start.dateTime);
          const evEnd = ev.end && ev.end.dateTime ? new Date(ev.end.dateTime) : null;
          const evStartDateStr = Utilities.formatDate(evStart, tz, "yyyy-MM-dd");
          const evEndDateStr = evEnd ? Utilities.formatDate(evEnd, tz, "yyyy-MM-dd") : evStartDateStr;

          if (isMultiDay) {
            if (dateStr === evStartDateStr) {
              time = `${Utilities.formatDate(evStart, tz, "HH:mm")}〜`;
            } else if (dateStr === evEndDateStr) {
              time = `〜${Utilities.formatDate(evEnd, tz, "HH:mm")}`;
            } else {
              time = "終日";
            }
          } else {
            time = Utilities.formatDate(evStart, tz, "HH:mm");
          }
        } else {
          time = "終日";
        }

        let summary_text = ev.summary || "(タイトルなし)";
        if (isMultiDay) {
          summary_text += ` (${dayIndex}/${totalDays}日目)`;
        }

        summary += `• ${time} - ${summary_text}\n`;

        if (ev.location) {
          summary += `  📍 ${ev.location}\n`;
        }
        eventCount++;
      });
    } else {
      summary += `• 予定なし\n`;
    }
  });

  // Footer
  summary += "\n━━━━━━━━━━━━━━━━━━━━━━━━\n";
  summary += `合計: ${eventCount}件の予定`;

  return summary;
}
/**
 * 時・分のプロパティ値を範囲内に収める。
 * `.atHour()` / `.nearMinute()` は範囲外の値で例外を投げるため、
 * 設定ミス（例: WEEKLY_SUMMARY_HOUR=99）でもトリガーを作れるようクランプする。
 * 非数値は既定値へフォールバックし、どちらの場合も logWarn に残す。
 */
function clampTimeProp(props, key, fallback, min, max) {
  const raw = props.getProperty(key);
  const parsed = parseInt(raw, 10);

  if (Number.isNaN(parsed)) {
    if (raw) logWarn(`${key} ("${raw}") が数値でないため既定値 ${fallback} を使用します。`);
    return fallback;
  }

  const clamped = Math.min(Math.max(parsed, min), max);
  if (clamped !== parsed) {
    logWarn(`${key} (${parsed}) は ${min}-${max} の範囲外のため ${clamped} に丸めました。`);
  }
  return clamped;
}

function installWeeklySummaryTrigger() {
  const props = PropertiesService.getScriptProperties();

  // Default to Sunday at 18:00 if not configured
  const dayOfWeek = parseInt(props.getProperty(WEEKLY_SUMMARY_PROP_KEYS.dayOfWeek) || "0", 10);
  const hour = clampTimeProp(props, WEEKLY_SUMMARY_PROP_KEYS.hour, 18, 0, 23);
  const minute = clampTimeProp(props, WEEKLY_SUMMARY_PROP_KEYS.minute, 0, 0, 59);
  
  // Remove existing weekly summary triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === WEEKLY_SUMMARY_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Create new weekly trigger (invalid dayOfWeek falls back to Sunday)
  const dayIndex = WEEKLY_SUMMARY_WEEKDAYS[dayOfWeek] ? dayOfWeek : 0;
  ScriptApp.newTrigger(WEEKLY_SUMMARY_HANDLER)
    .timeBased()
    .onWeekDay(WEEKLY_SUMMARY_WEEKDAYS[dayIndex])
    .atHour(hour)
    .nearMinute(minute)
    .create();
  
  logInfo(`Weekly summary trigger installed: weekday ${dayIndex} at ${hour}:${minute}`);
}

/**
 * Uninstall weekly summary trigger
 */
function uninstallWeeklySummaryTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === WEEKLY_SUMMARY_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
      logInfo("Weekly summary trigger removed.");
    }
  });
}
