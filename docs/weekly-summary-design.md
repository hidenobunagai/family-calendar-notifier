# Weekly Summary Feature Design

## Goal
家族が翌週の予定を把握できるように、明日から始まる今後7日間の予定ダイジェストを送信します。配信スケジュールはデフォルトで毎週日曜日の夕方（設定により変更可能）です。

## Implementation

### 1. Function: `sendWeeklySummary()`
- 通常のポーリングトリガーとは別の週次トリガーで実行
- Google カレンダーから明日以降の7日間の予定を取得
- サマリーメッセージを整形
- 設定されている通知先（Discord / LINE）へ送信（両方設定時は両方へ送信）
- `WEEKLY_SUMMARY_ENABLED === "false"` の場合のみスキップ（デフォルトで有効）
- 同日の重複送信を防止（`WEEKLY_SUMMARY_LAST_SENT` を確認・更新）

### 2. Message Format
ダイジェストの対象期間は明日 00:00 から 8 日目 00:00 までの完全な 7 日間（終了日時は排他的）です。予定が 0 件の場合でもサマリーメッセージが送信されます。

メッセージ構成:
- ヘッダー: `📅 今週の予定 (Weekly Plan)` + 改行 + `yyyy/MM/dd - yyyy/MM/dd` + 改行 + 区切り線（`━━━━━━━━━━━━━━━━━━━━━━━━`）
- 各曜日の見出し: `【X曜日】`
- 通常の予定: `• HH:mm - title`
- 終日予定: `• 終日 - title`
- 場所情報（設定時のみ）: `  📍 location`
- 予定のない日: `• 予定なし`（※ `なし` ではなく `• 予定なし`）
- フッター: 区切り線（`━━━━━━━━━━━━━━━━━━━━━━━━`） + 改行 + `合計: N件の予定`

サンプル（開始日が月曜日の場合。開始曜日は実行日に依存する）:
```
📅 今週の予定 (Weekly Plan)
2026/08/31 - 2026/09/06
━━━━━━━━━━━━━━━━━━━━━━━━

【月曜日】
• 18:00 - 家族会議
  📍 自宅

【火曜日】
• 予定なし

【水曜日】
• 終日 - 終日イベント
• 19:00 - レストラン予約
• 20:30 - ヨガ教室

【木曜日】
• 予定なし

【金曜日】
• 予定なし

【土曜日】
• 予定なし

【日曜日】
• 予定なし

━━━━━━━━━━━━━━━━━━━━━━━━
合計: 4件の予定
```

### 3. Configuration
- `WEEKLY_SUMMARY_ENABLED`: 有効化フラグ（デフォルト: `true`、無効化する場合は `"false"` を設定）
- `WEEKLY_SUMMARY_DAY`: 送信曜日（デフォルト: `0` = 日曜日、0=日曜、1=月曜...）
- `WEEKLY_SUMMARY_HOUR`: 送信時（24時間表記、デフォルト: `18`）
- `WEEKLY_SUMMARY_MINUTE`: 送信分（0〜59、デフォルト: `0`）
- `WEEKLY_SUMMARY_LAST_SENT`: 自動管理プロパティ（同日の重複送信防止用タイムスタンプ、手動設定不要）

### 4. Trigger Setup
- `installWeeklySummaryTrigger()`: 設定された曜日（day）、時（hour）、分（minute）を反映した週次タイムベーストリガーを作成（既存のサマリートリガーがあれば削除して再作成）
- `uninstallWeeklySummaryTrigger()`: 登録されている週次サマリートリガーを削除
- 通常のカレンダーポーリングトリガー（5分間隔）とは独立して動作

## Benefits
- 家族があらかじめ1週間の予定を把握可能
- 毎日の通知ノイズを削減し、週単位の概要を提供

## Next Steps
- [x] Implement `sendWeeklySummary()` function: `gas/WeeklySummary.gs` に実装完了（Google カレンダーから翌7日間の予定を取得して整形・送信）
- [x] Add configuration properties: `gas/WeeklySummary.gs` に `WEEKLY_SUMMARY_PROP_KEYS`（enabled, dayOfWeek, hour, minute, lastSentAt）を定義完了
- [x] Set up weekly trigger: `gas/WeeklySummary.gs` に設定値（曜日・時・分）を反映する `installWeeklySummaryTrigger()` / `uninstallWeeklySummaryTrigger()` を実装完了
- [x] Test with sample data: 見出し 7 日分の一致と予定 0 件時の送信経路を確認済み（リポジトリ内に自動テストは無く、検証はリポジトリ外の使い捨てスタブで実施）
- [x] Update README with setup instructions: `README.md` の「Weekly Summary Feature」セクションにセットアップ手順およびプロパティ説明を記載完了
