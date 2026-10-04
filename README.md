# Family Calendar Notifier (GAS + clasp)

A Google Apps Script project that detects new, updated, and cancelled events on a shared calendar by polling periodically, and posts them to the LINE Messaging API. It calls the Google Calendar API (v3) REST endpoints directly.

## Structure

- `gas/appsscript.json`: Manifest (scope definitions / time zone)
- `gas/Code.gs`: Diff fetching, LINE sending, triggers
- `gas/Utils.gs`: Message formatting utilities
- `gas/WeeklySummary.gs`: Weekly summary notifications and trigger

## About .clasp.json (important)

- `.clasp.json` is a local configuration file, so it is not included in Git (already in `.gitignore`).
- Instead, `.clasp.example.json` is bundled and the format is published.
- Initial setup steps:
  1. Copy: macOS/Linux `cp .clasp.example.json .clasp.json`, Windows `copy .clasp.example.json .clasp.json`
  2. Replace `scriptId` with your own Apps Script ID
  3. `rootDir` can stay as `"gas"`
- How to find `scriptId`: Apps Script editor → "Project Settings" → "Script ID".

## Prerequisites

1. Node.js (latest version recommended, required to run clasp)
2. Install with `bun add -g @google/clasp`
3. Authenticate with `clasp login`
4. Note the ID of the target Google Calendar (Calendar settings → Integrate calendar)
5. (If using LINE notifications) Create a LINE Official Account and note the "Channel access token" of the Messaging API channel and the destination user / group / room ID

## Setup and deployment

If `.clasp.json` is ready, you can apply the changes to the project with the following.

```sh
clasp push
clasp open
```

If you want to create a new, separate script, use the following (optional).

```sh
clasp create --title "Family Calendar Notifier" --type standalone --rootDir ./gas
clasp push
clasp open
```

## Verification (static checks and tests)

You can run syntax checks on the GAS code, duplicate top-level identifier checks, and a simple check for undefined global references.

```sh
bun run check
```

The weekly summary pure functions (trigger weekday resolution and the output of `formatWeeklySummary`) are verified by loading `gas/*.gs` with `node:vm` and stubbing every GAS API. A byte-for-byte match with the documented sample is also checked. No external requests are made.

```sh
bun run test
```

## Enabling the Google Calendar API

- Open the Cloud project linked to the script from "Project Settings" → "View Google Cloud project" at the top right of the Apps Script editor, and enable the Google Calendar API.
- If it is not linked to an existing project, use "Change Google Cloud project" on the same screen to associate it with a project of your choice, then enable the API.

## Script Properties (required / optional)

- `CALENDAR_ID`: The target calendar ID (required)
- `LINE_CHANNEL_ACCESS_TOKEN`: The channel access token of the LINE Messaging API (required)
- `LINE_TARGET_ID`: The LINE destination ID (user / group / room ID; required)
- `LAST_CHECKED_AT`: Optional (prevents missing events on the first run. When unset, it starts 6 hours back from the current time. Values older than 6 hours are rounded to 6 hours ago)
- `NOTIFIED_CACHE`: Auto-managed (cache to prevent duplicate notifications; no manual setup needed)
- `LAST_FAILURE_NOTIFIED_AT`: Auto-managed (timestamp used to send the execution failure warning only once; automatically deleted on the next success. No manual setup needed)
- `DEBUG_MODE`: Optional (when set to `true`, actual posting is skipped and only logs are output. For pre-deployment testing)

Conditions for notification destinations:

- LINE: sent when both `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_TARGET_ID` are set
- If they are not set, a warning is logged and the run aborts.

Configure these from "Project Settings" → "Script Properties" in Apps Script, or by running `PropertiesService.getScriptProperties().setProperty(key, value)` in any temporary function.

## Usage

1. Run `pollCalendarAndNotify()` manually once to approve permissions
2. Run `installTrigger()` to create a trigger at 5-minute intervals
3. After that, diff detection → LINE posting happens automatically

## How it works

- Execution lock: if the previous run is still in progress, duplicate runs are skipped (automatically released after 10 minutes)
- Diff fetching: uses `updatedMin` and looks back 60 seconds from the last check time. Because the Calendar API returns 410 when `updatedMin` is too old, the look-back window is capped at 6 hours; if the recorded `LAST_CHECKED_AT` is older than that (for example when triggers have stopped), it is rounded to 6 hours ago and the discarded period is made explicit in a WARN log and a one-line note in the next notification
- Calendar API retries: up to 3 retries on transient errors
- Change classification: classifies events as new / updated / cancelled
- LINE posting: messages are split to respect the 5,000-character limit per message, and up to 5 messages are sent together per push. On 429 it retries according to the `Retry-After` header; 401/400 raise immediately
- Notified cache: recorded when a LINE send succeeds, preventing duplicate notifications afterwards
- Time zone: `Asia/Tokyo` (changeable in `appsscript.json`)

## Dry-run mode

Setting the `DEBUG_MODE` script property to `true` skips actual posting to each channel and logs the messages that would be sent instead.

- Setting: script property `DEBUG_MODE` = `true`
- Behavior: calendar diff fetching and cache updates proceed as usual; only LINE posting is skipped
- Use cases: pre-deployment testing, or temporarily stopping notifications
- Reverting: delete `DEBUG_MODE` or set it to `false`

## LINE Messaging API setup

> **Note**: The legacy LINE Notify was discontinued in March 2025, so this project uses the LINE Messaging API (push messages via an official account).

1. Create a provider and a Messaging API channel on [LINE Developers](https://developers.line.biz/)
2. Issue a "Channel access token" under the channel's "Messaging API settings" and note it
3. Add the LINE account that should receive notifications (yourself or a family group) as a friend of the official account
4. Check the destination ID:
   - Individual user: from "Messaging API settings → Group / room ID" in LINE Developers, or the `userId` obtained via `webhook` by sending a message to the official account
   - Group / room: invite the official account to the group, then refer to "Group / room ID" on the same page
5. Set `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_TARGET_ID` in the Apps Script script properties
6. (If needed) verify with `DEBUG_MODE=true` as a dry run → then go into production

### LINE notes

- The free tier (Light Plan) allows up to 1,000 messages per month. Excess usage is billed or blocked, so watch the notification frequency
- The `push` API only reaches users who have added the account as a friend. Sending to users who have not added it fails
- To send to a group / room, invite the official account to that room beforehand
- Rotating the access token regularly is recommended (reissue immediately if it leaks)

## Troubleshooting

- Stuck on authorization: add the executing account as a test user on the GCP OAuth consent screen
- `Calendar API error (...)`: check whether the Google Calendar API is enabled in the Cloud project, and re-authorize if necessary
- 403 (insufficient scope): check that `appsscript.json` includes `calendar.readonly` and `script.external_request`, then re-authorize by running manually
- Not posted: check the trigger execution history and the logs (`Calendar diff: ...`). Also check whether `DEBUG_MODE` is `true` or the LINE properties are unset
- **LINE 401 Unauthorized**: the channel access token is invalid or expired. Reissue it and update `LINE_CHANNEL_ACCESS_TOKEN`
- **LINE 400 Bad Request**: `LINE_TARGET_ID` is invalid, or the recipient has not added the official account as a friend. Check the ID type (user / group / room) and the friend status
- **Not delivered on LINE (no error)**: check whether the free tier (Light Plan) monthly limit of 1,000 messages has been reached. Also check whether the official account has been invited to the group
- **Not sent**: when `LINE_CHANNEL_ACCESS_TOKEN` + `LINE_TARGET_ID` are unset, a warning is logged and the run aborts. Configure them

## Weekly Summary Feature

A new feature has been added to send a weekly summary of upcoming events every Sunday evening (or configurable day).

### Setup

1. **Enable / disable**: The feature is enabled by default. To disable it, set the script property `WEEKLY_SUMMARY_ENABLED` to `false` (no need to set `true`).
2. **Configure schedule** (optional):
   - `WEEKLY_SUMMARY_DAY`: 0 for Sunday (default), 1 for Monday, etc.
   - `WEEKLY_SUMMARY_HOUR`: Hour in 24h format (default: 18 for 6 PM). Out-of-range values are clamped to 0-23.
   - `WEEKLY_SUMMARY_MINUTE`: Minute of the hour (0-59, default: 0). Out-of-range values are clamped to 0-59.
3. **Install the trigger**: Run the `installWeeklySummaryTrigger()` function once to set up the weekly trigger.

`WEEKLY_SUMMARY_LAST_SENT` is auto-managed to prevent duplicate sends; no manual setup is needed.

### Functions

- `sendWeeklySummary()`: The main function that generates and sends the weekly summary.
- `installWeeklySummaryTrigger()`: Sets up the weekly trigger based on configured day and hour.
- `uninstallWeeklySummaryTrigger()`: Removes the weekly summary trigger.

### Customization

The summary message can be customized by modifying the `sendWeeklySummary()` function in `gas/WeeklySummary.gs`.
