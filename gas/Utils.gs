/**
 * 通知メッセージを構築 (Discord / LINE 共通)
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
