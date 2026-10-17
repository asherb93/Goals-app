# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running

Plain HTML/CSS/JS with no build step and no dependencies. Open `index.html` directly in a browser (`open index.html`). Scripts are classic `<script>` tags, not ES modules, because modules don't load over `file://`. Keep it that way unless a dev server is introduced. Script order in `index.html` matters: format → backends → store → charts → app → topics → `App.start()`.

There is no test suite. `node --check js/*.js js/topics/*.js` catches syntax errors. `apps-script/Code.gs` is Apps Script (V8) and can't run locally without mocks.

## Architecture

- **People and storage.** `js/backends.js` has two interchangeable async backends with the same API (`listUsers`, `createUser`, `login`, `me`, `loadData`, `saveData`, `getSharing`, `setViewers`, `loadUserData`):
  - `local`: localStorage key `goals:local:v2` (`{users, data, shares}`), for one device only.
  - `sheets(url)`: POSTs `{action, ...}` as text/plain to a Google Apps Script web app (`apps-script/Code.gs`, setup in `apps-script/SETUP.md`). The script runs as the sheet owner and enforces auth (HMAC tokens, hashed passcodes, lockout) and view-only sharing server-side.
- **Store** (`js/store.js`). Holds the signed-in person's data blob `{version: 2, settings: {currency}, topics: {<topic-id>: {...}}}` in memory, mirrored to `goals:cache:<mode>:<userId>`. `Store.changed()` saves immediately for local and debounces for Sheets, with retry and a `sendBeacon` on page hide. Device-level state (theme, backend choice, session) lives in `goals:device`.
- **Topics.** Each topic is a file in `js/topics/` that calls `App.register({id, title, renderInput(el, ctx), renderDashboard(el, ctx), exportRows?(topicData)})`. Topics never touch Store directly; they get a `ctx`:
  - `ctx.data` is the topic's slice of the blob, someone else's when viewing a shared dashboard.
  - `ctx.isMe` / `ctx.readOnly` and `ctx.owner` identify whose data it is.
  - `ctx.ui` is per-device view state (e.g. the selected month), not synced.
  - `ctx.changed()` and `ctx.rerender()`.
  - `exportRows` returns `{SheetName: {headers, rows}}`, which the Sheets backend writes as readable per-person tabs.
- **Routing** (`js/app.js`). `#/<topic>/<input|dashboard>[/<personId>]`. A person id shows that person's dashboard read-only, and only if they shared it with you. App also owns the sign-in screen, people switcher, and the Sharing/Settings/Storage dialogs.
- **Charts** (`js/charts.js`). HTML/SVG string builders: `stackBar`, `barList`, `donut`, `columns`, `legend`, `table`. Any element with `data-tip`/`data-tip-sub` gets the shared tooltip.
- `Fmt.esc` must wrap user text interpolated into `innerHTML`. App calls `Fmt.setCurrency` with the owner's currency before each render.

### Monthly Balance (`js/topics/monthlyBalance.js`)

Topic data: `{categories: [{id, name}], months: {"YYYY-MM": {salary, expenses: [{id, name, category, amount}], allocations: [{id, name, mode: "amount"|"percent", value}]}}}`. `compute()` derives everything: percent allocations take a share of `max(left, 0)`. Empty months are deleted. The Input view renders once and updates figures in place, so fields keep focus.

## Colors

Chart colors are the dataviz skill's validated reference palette, defined as CSS variables (`--s1`…`--s8`, `--neutral`, `--other`) with separate light and dark values in `css/styles.css`. Gradients and badges are UI decoration only. Fixed roles in Monthly Balance:
- Expenses are `--s2` (orange) and money left is `--s3` (aqua).
- Leftover destinations use `ALLOC_COLORS` in an order validated for adjacent CVD separation after orange.
- A category's color follows its position in the category list (first 8; the rest are gray).

The donut folds to 5 slices plus "Other". Keep labels in ink tokens, pair warnings (`--critical`) with ⚠ and text, and give every chart a legend and a "Show as table" fallback.
