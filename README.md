# Google Calendar → Discord 通知 (GAS + clasp)

共有カレンダーの新規・更新・キャンセルを定期ポーリングで検知し、Discord の Webhook に投稿する Google Apps Script プロジェクトです。Google Calendar API (v3) の REST エンドポイントを直接呼び出します。

## 構成

- `gas/appsscript.json`: マニフェスト（スコープ定義 / タイムゾーン）
- `gas/Code.gs`: 差分取得・Discord 送信・トリガー
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

1. Node.js（最新版推奨）
2. `bun add -g @google/clasp` でインストール
3. `clasp login` で認証
4. Discord 側で Webhook を作成し URL を控える
5. 対象 Google カレンダーの ID を控える（カレンダーの設定 → カレンダーの統合）

## セットアップとデプロイ

`.clasp.json` を用意済みなら、以下でプロジェクトへ反映できます。

```sh
clasp push
clasp open
```

新規に別スクリプトへ作成したい場合は以下（任意）。

```sh
clasp create --title "Family Calendar Discord Bot" --type standalone --rootDir ./gas
clasp push
clasp open
```

## Google Calendar API 有効化

- Apps Script エディタ右上の「プロジェクトの設定」→「Google Cloud プロジェクトを表示」で紐づく Cloud プロジェクトを開き、Google Calendar API を有効化してください。
- 既存のプロジェクトにリンクしていない場合は、同画面の「Google Cloud プロジェクトを変更」から任意のプロジェクトに関連付けて API を有効化します。

## Script Properties（必須）

- `CALENDAR_ID`: 対象のカレンダー ID
- `DISCORD_WEBHOOK_URL`: Discord Webhook URL
- `LAST_CHECKED_AT`: 任意（初回取りこぼし防止。未設定時は現在時刻から 6 時間巻き戻し）
- `NOTIFIED_CACHE`: 自動管理（重複通知防止キャッシュ。手動設定不要）

設定は Apps Script の「プロジェクトの設定」→「スクリプト プロパティ」から行うか、任意の一時関数で `PropertiesService.getScriptProperties().setProperty(key, value)` を実行してください。

## 使い方

1. `pollCalendarAndNotify()` を一度手動実行して権限承認
2. `installTrigger()` を実行して 5 分間隔のトリガーを作成
3. 以後、自動で差分検知 →Discord 投稿が行われます

## 動作の要点

- 差分取得: `updatedMin` を使用し、前回チェック時刻から 60 秒巻き戻して取得
- 変更判定: 新規/更新/キャンセルを分類
- Discord 投稿: 2000 文字制限に配慮して分割送信
- タイムゾーン: `Asia/Tokyo`（`appsscript.json` で変更可）

## トラブルシュート

- 承認で止まる: GCP の OAuth 同意画面で実行アカウントをテストユーザーに追加
- `Calendar API error (...)`: Cloud プロジェクトで Google Calendar API が有効か確認し、必要なら再承認
- 403（スコープ不足）: `appsscript.json` に `calendar.readonly` と `script.external_request` が含まれているか確認し、手動実行で再承認
- 投稿されない: トリガー実行履歴とログ（`Calendar diff: ...`）を確認
