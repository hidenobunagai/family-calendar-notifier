# Weekly Summary Feature Design

## Goal
Send a digest of upcoming events for the next week every Sunday evening to help family plan the week.

## Proposed Implementation

### 1. New Function: `sendWeeklySummary()`
- Runs on a separate weekly trigger (Sunday 18:00 JST)
- Queries Google Calendar for events in the next 7 days
- Formats a summary message
- Sends to both Discord and LINE (if configured)

### 2. Message Format
```
📅 今週の予定 (Weekly Plan)
2026/09/01 (月) - 2026/09/07 (日)

【月曜日】
18:00 - 家族会議

【火曜日】
なし

【水曜日】
19:00 - レストラン予約
20:30 - ヨガ教室

... (remaining days)

合計: 5件の予定
```

### 3. Configuration
- Add `WEEKLY_SUMMARY_ENABLED` property (default: true)
- Add `WEEKLY_SUMMARY_DAY` property (default: 0 = Sunday)
- Add `WEEKLY_SUMMARY_HOUR` property (default: 18)

### 4. Trigger Setup
- Separate from the regular polling trigger
- Uses time-based trigger with weekly frequency

## Benefits
- Helps family plan ahead
- Reduces daily notification noise
- Provides a weekly overview

## Next Steps
- [ ] Implement `sendWeeklySummary()` function
- [ ] Add configuration properties
- [ ] Set up weekly trigger
- [ ] Test with sample data
- [ ] Update README with setup instructions
