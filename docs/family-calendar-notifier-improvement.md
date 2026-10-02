# Improvement Proposal: Add Configuration Validation (Archived)

> ⚠️ **Archived**: 本ドキュメントは Discord webhook が存在した時点の旧改善提案です。コミット `ef80ff8` により Discord 通知は削除され、LINE 通知へ一本化されました。現在の `validateSetup()`（`gas/Utils.gs`）は Calendar ID と LINE 認証情報を検証します。

## Current State (Historical)
The family-calendar-notifier project lacks robust configuration validation at startup.

## Proposed Change (Historical)
Add a `validateSetup()` function that checks:
1. All required properties are set
2. Calendar ID format is valid
3. Discord webhook URL is valid (Note: Discord support removed in `ef80ff8`)
4. LINE credentials are present

## Benefits
- Prevents runtime errors from missing configuration
- Provides clear error messages for setup issues
- Improves reliability and user experience

## Implementation
1. Add validation logic in gas/Utils.gs
2. Call validateSetup() at the beginning of main handler
3. Add logging for validation failures

## Status
✅ Implemented (Discord support later removed in favor of LINE in `ef80ff8`)
