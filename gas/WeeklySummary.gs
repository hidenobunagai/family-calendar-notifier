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
  const webhookUrl = (props.getProperty(PROP_KEYS.webhookUrl) || "").trim();
  const lineChannelAccessToken = (props.getProperty(PROP_KEYS.lineChannelAccessToken) || "").trim();
  const lineTargetId = (props.getProperty(PROP_KEYS.lineTargetId) || "").trim();
  
  const hasDiscord = !!calendarId && !!webhookUrl;
  const hasLine = !!lineChannelAccessToken && !!lineTargetId;
  
  if (!calendarId) {
    logWarn("Weekly summary: CALENDAR_ID not set. Skipping.");
    return;
  }
  if (!hasDiscord && !hasLine) {
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
  
  // Fetch events for the next 7 days
  const startDate = new Date(now.getTime() + 60 * 1000); // Start from now + 1 minute
  const endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days ahead
  
  let events;
  try {
    events = fetchEventsForRange(calendarId, startDate.toISOString(), endDate.toISOString());
  } catch (err) {
    logError("Weekly summary: Failed to fetch calendar events.", err);
    return;
  }
  
  if (events.length === 0) {
    logInfo("Weekly summary: No upcoming events found.");
    return;
  }
  
  // Format the summary
  const tz = Session.getScriptTimeZone() || "Asia/Tokyo";
  const summary = formatWeeklySummary(events, startDate, endDate, tz);
  
  // Send to configured channels
  const messages = [summary];
  
  if (hasDiscord) {
    try {
      postToDiscord(webhookUrl, messages);
      logInfo("Weekly summary sent to Discord.");
    } catch (err) {
      logError("Weekly summary: Discord send failed.", err);
    }
  }
  
  if (hasLine) {
    try {
      postToLine(lineChannelAccessToken, lineTargetId, messages);
      logInfo("Weekly summary sent to LINE.");
    } catch (err) {
      logError("Weekly summary: LINE send failed.", err);
    }
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
  const props = PropertiesService.getScriptProperties();
  const accessToken = getAccessToken(props);
  
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
// New version that includes all days, showing 予定なし for empty days
function formatWeeklySummary(events, startDate, endDate, tz) {
  const dayNames = ['日', '月', '火', '水', '木', '金', '土'];
  
  // Group events by date
  const eventsByDate = {};
  events.forEach(ev => {
    const start = ev.start.dateTime || ev.start.date;
    const date = new Date(start);
    const dateStr = Utilities.formatDate(date, tz, 'yyyy-MM-dd');
    if (!eventsByDate[dateStr]) {
      eventsByDate[dateStr] = [];
    }
    eventsByDate[dateStr].push(ev);
  });
  
  // Build header
  const startStr = Utilities.formatDate(startDate, tz, 'yyyy/MM/dd');
  const endStr = Utilities.formatDate(endDate, tz, 'yyyy/MM/dd');
  let summary = `📅 今週の予定 (Weekly Plan)\n`;
  summary += `${startStr} - ${endStr}\n`;
  summary += '━━━━━━━━━━━━━━━━━━━━━━━━\n';
  
  // Generate all dates in the range
  let eventCount = 0;
  const current = new Date(startDate);
  while (current <= endDate) {
    const dateStr = Utilities.formatDate(current, tz, 'yyyy-MM-dd');
    const dayOfWeek = current.getDay();
    
    summary += `\n【${dayNames[dayOfWeek]}曜日】\n`;
    
    if (eventsByDate[dateStr] && eventsByDate[dateStr].length > 0) {
      eventsByDate[dateStr].forEach(ev => {
        const start = ev.start.dateTime || ev.start.date;
        const time = ev.start.dateTime ? 
          Utilities.formatDate(new Date(start), tz, 'HH:mm') : 
          '終日';
        const summary_text = ev.summary || '(タイトルなし)';
        summary += `• ${time} - ${summary_text}\n`;
        
        if (ev.location) {
          summary += `  📍 ${ev.location}\n`;
        }
        eventCount++;
      });
    } else {
      summary += `• 予定なし\n`;
    }
    
    current.setDate(current.getDate() + 1);
  }
  
  // Footer
  summary += '\n━━━━━━━━━━━━━━━━━━━━━━━━\n';
  summary += `合計: ${eventCount}件の予定`;
  
  return summary;
}
function installWeeklySummaryTrigger() {
  const props = PropertiesService.getScriptProperties();
  
  // Default to Sunday at 18:00 if not configured
  const dayOfWeek = parseInt(props.getProperty(WEEKLY_SUMMARY_PROP_KEYS.dayOfWeek) || "0", 10);
  const hour = parseInt(props.getProperty(WEEKLY_SUMMARY_PROP_KEYS.hour) || "18", 10);
  const minute = parseInt(props.getProperty(WEEKLY_SUMMARY_PROP_KEYS.minute) || "0", 10);
  
  // Remove existing weekly summary triggers
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === WEEKLY_SUMMARY_HANDLER) {
      ScriptApp.deleteTrigger(trigger);
    }
  });
  
  // Create new weekly trigger
  ScriptApp.newTrigger(WEEKLY_SUMMARY_HANDLER)
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.SUNDAY)
    .atHour(hour)
    .atMinute(minute)
    .create();
  
  logInfo(`Weekly summary trigger installed: Sundays at ${hour}:${minute}`);
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
