/**
 * 通知メッセージを構築 (LINE 送信用)
 * プレーンテキスト形式のため Markdown 非依存。LINE でもそのまま表示可能。
 */
function buildMessage(kind, ev, tz) {
  const title = ev.summary || "(無題)";
  const htmlLink = ev.htmlLink || "";
  const loc = ev.location ? `\n- 場所: ${ev.location}` : "";
  const desc = ev.description ? `\n- メモ: ${truncateMessage(ev.description, 400)}` : "";

  const timeText = buildTimeText(ev, tz);
  const rid = ev.recurringEventId ? " (繰り返しインスタンス)" : "";

  return [
    `【Googleカレンダー更新】${kind}${rid}`,
    `- タイトル: ${title}`,
    timeText ? `- 時間: ${timeText}` : null,
    loc || null,
    htmlLink ? `- リンク: ${htmlLink}` : null,
    desc || null,
  ]
    .filter(Boolean)
    .join("\n");
}

function buildTimeText(ev, tz) {
  const fmt = (d) => Utilities.formatDate(d, tz, "yyyy/MM/dd(EEE) HH:mm");
  const allDayFmt = (d) => Utilities.formatDate(d, tz, "yyyy/MM/dd(EEE)");

  // キャンセルされた繰り返しインスタンスは start/end を含まず、
  // originalStartTime にのみ日時が入る (Calendar API の仕様)
  if (ev.status === "cancelled" && ev.originalStartTime) {
    const ost = ev.originalStartTime;
    if (ost.date) return `${allDayFmt(new Date(ost.date))} (終日)`;
    if (ost.dateTime) return `${fmt(new Date(ost.dateTime))} 〜`;
    return "";
  }

  if (ev.start && ev.start.date) {
    if (ev.end && ev.end.date) {
      const s = new Date(ev.start.date);
      const e = new Date(new Date(ev.end.date).getTime() - 1);
      if (allDayFmt(s) === allDayFmt(e)) {
        return `${allDayFmt(s)} (終日)`;
      }
      return `${allDayFmt(s)} 〜 ${allDayFmt(e)} (終日)`;
    }
    return `${allDayFmt(new Date(ev.start.date))} (終日)`;
  }

  if (ev.start && ev.start.dateTime) {
    const s = new Date(ev.start.dateTime);
    const e = ev.end && ev.end.dateTime ? new Date(ev.end.dateTime) : null;
    if (!e) return `${fmt(s)} 〜`;
    const sameDay =
      Utilities.formatDate(s, tz, "yyyy/MM/dd") === Utilities.formatDate(e, tz, "yyyy/MM/dd");
    if (sameDay) {
      const sd = Utilities.formatDate(s, tz, "yyyy/MM/dd(EEE)");
      const st = Utilities.formatDate(s, tz, "HH:mm");
      const et = Utilities.formatDate(e, tz, "HH:mm");
      return `${sd} ${st}〜${et}`;
    }
    return `${fmt(s)} 〜 ${fmt(e)}`;
  }

  return "";
}

function truncateMessage(text, maxLen) {
  if (!text) return "";
  if (text.length <= maxLen) return text;
  const limit = Math.max(maxLen - 1, 0); // "…" 分を確保
  return `${text.slice(0, limit)}…`;
}

/**
 * 長いテキストを maxLen 以下の断片に分割する（内容を切り捨てない）。
 *
 * - 改行境界を優先する。分割点になった改行は断片に含めない。
 *   そのため、どの行も maxLen に収まる通常のケースでは、
 *   断片を "\n" で再結合すると原文に一致する。
 * - 単独の行が maxLen を超える場合だけ、その行を maxLen ごとにハード分割する。
 *   分割点が改行ではないため、この場合は "\n" で再結合しても原文には戻らない
 *   （ハード分割が起きると改行を除く本文は欠落せずに残す）。
 * - 空文字は空配列、maxLen 以下のテキストは [text] を返す。
 * - 断片が空文字になることはない（空の行は区切りとして扱う）。
 *
 * @param {string} text 分割対象のテキスト
 * @param {number} maxLen 1 断片あたりの最大文字数
 * @return {string[]} maxLen 以下の断片の配列
 */
function splitLongText(text, maxLen) {
  if (!text) return [];

  const limit = Math.floor(maxLen);
  // 分割できない設定のときはそのまま 1 断片として返す（内容を落とさない）
  if (!Number.isFinite(limit) || limit < 1) return [text];
  if (text.length <= limit) return [text];

  const chunks = [];
  // null は「まだ断片を開始していない」を表す。空の行があるため
  // 真偽値では「開始済み」と区別できない。
  let current = null;

  for (const line of text.split("\n")) {
    if (line.length > limit) {
      // 単独行が上限を超える: maxLen ごとにハード分割する
      if (current !== null) {
        if (current) chunks.push(current);
        current = null;
      }
      let rest = line;
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      // 残った部分を次の断片の開始にする（空文字列なら次の行と "\n" でつながる）
      current = rest;
      continue;
    }

    if (current === null) {
      current = line;
    } else if (current.length + 1 + line.length <= limit) {
      current += "\n" + line;
    } else {
      // この改行で区切って次の断片へ（分割点の改行は消費する）
      if (current) chunks.push(current);
      current = line;
    }
  }

  if (current !== null && current) chunks.push(current);
  return chunks;
}

/**
 * プロパティのセットアップ状態を検証する関数
 * Validate property setup status
 * 
 * 使用者に設定漏れを伝えるためのヘルパー関数。
 * ダッシュボードやログで呼び出して設定状態を確認できる。
 */
function validateSetup() {
  const props = PropertiesService.getScriptProperties();
  const results = {
    calendarId: !!props.getProperty(PROP_KEYS.calendarId),
    lineToken: !!props.getProperty(PROP_KEYS.lineChannelAccessToken),
    lineTarget: !!props.getProperty(PROP_KEYS.lineTargetId),
    lastChecked: props.getProperty(PROP_KEYS.lastCheckedAt) || "never",
  };

  const hasLine = results.lineToken && results.lineTarget;
  const hasCalendar = results.calendarId;

  results.ready = hasCalendar && hasLine;
  results.warnings = [];

  if (!hasCalendar) results.warnings.push("CALENDAR_ID not set");
  if (!hasLine) results.warnings.push("No notification channel configured (set LINE credentials)");
  if (hasLine && !results.lineTarget) results.warnings.push("LINE_CHANNEL_ACCESS_TOKEN set but LINE_TARGET_ID missing");
  
  return results;
}
