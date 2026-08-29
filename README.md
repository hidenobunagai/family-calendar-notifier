# Family Calendar Notifier (GAS + clasp)

共有カレンダーの新規・更新・キャンセルを定期ポーリングで検知し、Discord の Webhook と LINE Messaging API に投稿する Google Apps Script プロジェクトです。Google Calendar API (v3) の REST エンドポイントを直接呼び出します。Discord / LINE はそれぞれ個別に有効化でき、両方同時にも送信可能です。

## 構成

- `gas/appsscript.json`: マニフェスト（スコープ定義 / タイムゾーン）
- `gas/Code.gs`: 差分取得・Discord / LINE 送信・トリガー
- `gas/Utils.gs`: メッセージ整形ユーティリティ

## .clasp.json について（重要）

- `.clasp.json` はローカル用設定ファイルのため、Git には含めません（`.gitignore` 済み）。
- 代わりに `.clasp.example.json` を同梱し、フォーマットを公開しています。
- 初回セットアップ手順:
  1. コピー: macOS/Linux `cp .clasp.example.json .clasp.json`、Windows `copy .clasp.example.json .clasp.json`
  2. `scriptId` をご自身の Apps Script の ID に置き換える
  3. `rootDir` は `"gas"` のままで OK
- `scriptId` の確認方法: Apps Script エディタ →「プロジェクトの設定」→「スクリプト ID」。

## 前提

1. Node.js（最新版推奨、clasp の実行に必要）
2. `bun add -g @google/clasp` でインストール
3. `clasp login` で認証
4. Discord 側で Webhook を作成し URL を控える（Discord を使わない場合は不要）
5. 対象 Google カレンダーの ID を控える（カレンダーの設定 → カレンダーの統合）
6. （LINE 通知を使う場合）LINE 公式アカウントを作成し、Messaging API チャネルの「チャネルアクセストークン」と送信先のユーザー / グループ / トークルーム ID を控える

## セットアップとデプロイ

`.clasp.json` を用意済みなら、以下でプロジェクトへ反映できます。

```sh
clasp push
clasp open
```

新規に別スクリプトへ作成したい場合は以下（任意）。

```sh
clasp create --title "Family Calendar Notifier" --type standalone --rootDir ./gas
clasp push
clasp open
```

## Google Calendar API 有効化

- Apps Script エディタ右上の「プロジェクトの設定」→「Google Cloud プロジェクトを表示」で紐づく Cloud プロジェクトを開き、Google Calendar API を有効化してください。
- 既存のプロジェクトにリンクしていない場合は、同画面の「Google Cloud プロジェクトを変更」から任意のプロジェクトに関連付けて API を有効化します。

## Script Properties（必須 / 任意）

- `CALENDAR_ID`: 対象のカレンダー ID（必須）
- `DISCORD_WEBHOOK_URL`: Discord Webhook URL（Discord 通知を使う場合）
- `LINE_CHANNEL_ACCESS_TOKEN`: LINE Messaging API のチャネルアクセストークン（LINE 通知を使う場合）
- `LINE_TARGET_ID`: LINE の送信先 ID（ユーザー / グループ / トークルーム ID。LINE 通知を使う場合）
- `LAST_CHECKED_AT`: 任意（初回取りこぼし防止。未設定時は現在時刻から 6 時間巻き戻し）
- `NOTIFIED_CACHE`: 自動管理（重複通知防止キャッシュ。手動設定不要）
- `DEBUG_MODE`: 任意（`true` にすると各チャネルへの実際の投稿をスキップし、ログのみ出力。デプロイ前の動作確認用）
- `LOCK`: 自動管理（トリガー重複実行防止用ロック。手動設定不要）

通知先の有効条件:

- Discord: `DISCORD_WEBHOOK_URL` が設定されていれば送信
- LINE: `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_TARGET_ID` が両方設定されていれば送信
- どちらも未設定の場合は警告ログを出力して中断します。両方設定すれば Discord / LINE に同時送信されます。

設定は Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」から行うか、任意の一時関数で `PropertiesService.getScriptProperties().setProperty(key, value)` を実行してください。

## 使い方

1. `pollCalendarAndNotify()` を一度手動実行して権限承認
2. `installTrigger()` を実行して 5 分間隔のトリガーを作成
3. 以後、自動で差分検知 →Discord / LINE 投稿が行われます

## 動作の要点

- 実行ロック: 前回の実行が継続中の場合、重複実行をスキップ（10分で自動解除）
- 差分取得: `updatedMin` を使用し、前回チェック時刻から 60 秒巻き戻して取得
- Calendar API リトライ: 一時的なエラー時に最大 3 回のリトライ
- 変更判定: 新規/更新/キャンセルを分類
- Discord 投稿: 2000 文字制限に配慮して分割送信、429 レート制限時は `Retry-After` に従いリトライ
- LINE 投稿: 1 メッセージあたり 5000 文字制限に配慮して分割し、1 push につき最大 5 メッセージまでまとめて送信。429 時は `Retry-After` ヘッダに従いリトライ、401/400 は即時例外
- 通知済みキャッシュ: Discord / LINE いずれか一方でも送信成功すれば記録し、次回以降の重複通知を防止
- タイムゾーン: `Asia/Tokyo`（`appsscript.json` で変更可）

## ドライランモード

`DEBUG_MODE` スクリプトプロパティを `true` に設定すると、各チャネルへの実際の投稿を行わず、送信予定のメッセージをログに出力します。

- 設定: スクリプトプロパティ `DEBUG_MODE` = `true`
- 動作: カレンダーの差分取得・キャッシュ更新は通常通り行い、Discord / LINE 投稿のみスキップ
- 用途: デプロイ前の動作確認や、通知を一時的に止めたい場合
- 元に戻す: `DEBUG_MODE` を削除するか `false` に設定

## LINE Messaging API のセットアップ

> **注意**: 旧来の LINE Notify は 2025/3 に廃止されたため、本プロジェクトでは LINE Messaging API（公式アカウント経由の push メッセージ）を使用します。

1. [LINE Developers](https://developers.line.biz/) でプロバイダーと Messaging API チャネルを作成
2. チャネルの「Messaging API 設定」で「チャネルアクセストークン」を発行し、控える
3. 通知を受け取りたい LINE アカウント（自分自身や家族グループ）を公式アカウントと友だち追加
4. 送信先 ID を確認:
   - 個別ユーザー: LINE Developers の「 Messaging API 設定 → グループ / トークルーム ID」や、公式アカウントにメッセージを送って `webhook` で取得する `userId` など
   - グループ / トークルーム: 公式アカウントをグループに招待した後に同ページの「グループ / トークルーム ID」を参照
5. Apps Script のスクリプトプロパティに `LINE_CHANNEL_ACCESS_TOKEN` と `LINE_TARGET_ID` を設定
6. （必要なら）`DEBUG_MODE=true` でドライラン確認 → 本番運用

### LINE の注意点

- 無料枠（Light Plan）では月 1,000 メッセージまで。超過分は従量課金または送信制限されるため、通知頻度に注意
- `push` API は友だち追加済みの相手にのみ届く。未追加ユーザーへの送信は失敗する
- グループ / トークルームへ送る場合は公式アカウントをその部屋に招待しておく
- アクセストークンは定期的にローテーション推奨（漏洩時は即時再発行）

## トラブルシュート

- 承認で止まる: GCP の OAuth 同意画面で実行アカウントをテストユーザーに追加
- `Calendar API error (...)`: Cloud プロジェクトで Google Calendar API が有効か確認し、必要なら再承認
- 403（スコープ不足）: `appsscript.json` に `calendar.readonly` と `script.external_request` が含まれているか確認し、手動実行で再承認
- 投稿されない: トリガー実行履歴とログ（`Calendar diff: ...`）を確認。`DEBUG_MODE` が `true` になっていないか、Discord / LINE のプロパティが未設定でないかも確認
- **Discord 429**: サーバー側のレート制限。しばらく待つか `Retry-After` の指示に従う
- **Discord 投稿が途切れる**: 2000 文字制限で分割送信されるため、長いメッセージは複数に分かれる（仕様）
- **LINE 401 Unauthorized**: チャネルアクセストークンが不正または期限切れ。再発行して `LINE_CHANNEL_ACCESS_TOKEN` を更新
- **LINE 400 Bad Request**: `LINE_TARGET_ID` が不正、または公式アカウントと友だち追加されていない。ID の種類（ユーザー / グループ / トークルーム）と友だち追加状態を確認
- **LINE で届かない（エラーなし）**: 無料枠（Light Plan）の月 1,000 メッセージ上限に達していないか確認。公式アカウントをグループに招待済みかも確認
- **両チャネルとも送信されない**: `DISCORD_WEBHOOK_URL` と `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_TARGET_ID` が両方未設定の場合、警告ログを出して中断する。少なくとも一方は設定すること

## Weekly Summary Feature

A new feature has been added to send a weekly summary of upcoming events every Sunday evening (or configurable day).

### Setup

1. **Enable the feature**: Set the script property `WEEKLY_SUMMARY_ENABLED` to `true`.
2. **Configure schedule** (optional):
   - `WEEKLY_SUMMARY_DAY`: 0 for Sunday (default), 1 for Monday, etc.
   - `WEEKLY_SUMMARY_HOUR`: Hour in 24h format (default: 18 for 6 PM).
   - `WEEKLY_SUMMARY_MINUTE`: Minute of the hour (0-59, default: 0).
3. **Install the trigger**: Run the `installWeeklySummaryTrigger()` function once to set up the weekly trigger.

### Functions

- `sendWeeklySummary()`: The main function that generates and sends the weekly summary.
- `installWeeklySummaryTrigger()`: Sets up the weekly trigger based on configured day and hour.
- `uninstallWeeklySummaryTrigger()`: Removes the weekly summary trigger.

### Customization

The summary message can be customized by modifying the `sendWeeklySummary()` function in `gas/WeeklySummary.gs`.
