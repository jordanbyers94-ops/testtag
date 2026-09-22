# Aus Air Electrical — Test & Tag Register

Standalone app (same pattern as Aus Air Job Capture): Node/Express + PostgreSQL, deployed on Railway via GitHub.

## What's included

- **Overdue/due-soon dashboard** — a Due tab summarising overdue and due-within-30-days counts per site, tap through to filter the register.
- **Auto-calculated retest due dates** — set an environment category per asset (construction, hostile, commercial kitchen, factory/workshop, office/low-risk, other) and Next Due auto-fills from AS/NZS 3760-typical intervals when left blank. Always editable.
- **Fails/Overdue/Due Soon filters** — one tap to see only failed items, only overdue items, or only items due within 30 days; export just the fail list as its own .xlsx.
- **Offline queueing** — asset saves and test logs made while offline are queued in the browser and flushed automatically on reconnect, including a new item saved *and* tested in the same offline session (the queued test is chained to its queued asset via a client-side temporary ID, then both sync together once you're back online — nothing gets silently dropped). Photo *reading* (the AI extraction) still needs a connection since it's a live API call — the "Enter manually instead" button skips extraction so you can still log an item offline.
- **Test history with edit/delete** — tap any register row to see its full test history, correct a mistyped result/date, or delete a bad test record.
- **Edit/Delete the item itself** — from that same register-row view, "Edit Item" fixes a mistyped appliance/plant no./brand/model/serial/site/location after the fact, and "Delete Item" removes a mistaken entry (duplicate, wrong site) along with its whole test history.
- **Log New Test (quick retest)** — from the register-row view, jump straight to logging a new test against an already-registered item without re-entering its site/location or re-photographing it — the common case, since most test & tag visits are retesting items already on the register.
- **Archived test photos** — the photo used for extraction is now stored against the test record (in Postgres, as a BYTEA column) and viewable from the history view.
- **Site rename/merge** — type a site into the register's site filter and hit "Rename current site filter" to fix a spelling variant across every asset under it in one go.
- **Search** now also matches an item's brand and its most recent tag number, not just appliance/plant no./location/serial no.
- **Generate Report** — on the Register tab, pick a site and a visit date and download a "Test Register" .docx matching Aus Air's existing client-facing report template exactly: cover page, inspection details, a narrative Summary of Results (with Items Passed/Failed/Unfound sections and a Compliance Statement), and the full item-by-item register table (Plant No., Description, Tag No., Pass/Fail, Test Date, Next Due). Only visit dates that actually have logged tests for that site are offered. Items registered at the site with no test logged on the chosen date are reported as "Unfound" rather than silently omitted.
- **Upload Report to Cloud** — once a report's generated (and only when reached via the Audit Tool's domain, with an active Cloud Sync login), an "Upload Report to Cloud" button archives that same .docx centrally, alongside a "View all uploaded Test & Tag reports →" link. These reports live in their own list — a separate page at `/testtag-reports/` on the Audit Tool's domain, and their own "Manage Test & Tag Reports" section on `/admin/` — kept structurally apart from the Audit Tool's own Form 1/RCD/Defects reports, so the two can never get mixed together. See `cloud_pwa/DEPLOYMENT_GUIDE.md`'s "Test & Tag Reports" section for the deploy-side details.
- **Settings tab — My Details** — a dedicated screen (not just the per-test form) showing where the tester's name/licence come from: pulled automatically from the technician's Audit Tool login when there is one (with a note that it's admin-managed there), or editable directly here otherwise, with an explicit "use different details on this device" override for the logged-in case. Built as a small standalone module (`public/technician-profile.js`) so future Aus Air add-on apps can vendor the exact same file/screen in rather than re-building tester prefill logic each time — see "Shared technician profile pattern" below.
- **Full offline mode with cloud upload** — the app is now installable as a PWA (Add to Home Screen), with the whole app shell (HTML/CSS/JS/icon) cached by a service worker so it opens even with no signal at all. The Register is also cached locally (IndexedDB) after every online load, so you can still *browse* it offline, not just queue writes against it — offline items show a clear "showing the last saved copy" notice. Anything saved offline (a new asset, a new test) shows up immediately in the Register with a "Pending sync" badge, rather than only appearing after the next successful sync. The red offline banner now includes an explicit **Upload to Cloud** button once you're back online with items still queued, so you can trigger the sync yourself instead of just waiting for the automatic background flush.

## Shared technician profile pattern

`public/technician-profile.js` is a self-contained, dependency-free module — no build step, just a `<script>` tag — that renders the Settings tab's "My Details" screen and resolves the effective tester name/licence (cloud login vs. local fallback vs. explicit override). It's meant to be copied unchanged into any future Aus Air add-on app under the Audit Tool, the same way this file is a copy of the canonical one at `cloud_pwa/public/shared/technician-profile.js`.

The contract it relies on: the Audit Tool's own login writes `localStorage['cloudTechnicianName']` and `localStorage['cloudTechnicianLicense']` on the shared domain (see `cloud_pwa/sync_source.js`). Any add-on reverse-proxied under that domain (like Test & Tag at `/testtag/`) shares the origin and can read those two keys directly — no extra API call, no separate login screen. A new add-on just needs to: copy the file into its `public/` folder, add `<script src="./technician-profile.js"></script>` before its own app script, pick a short unique prefix (Test & Tag uses `'testTag'`) so its local-fallback keys don't collide with any other add-on's, and call `TechnicianProfile.resolve(prefix)` / `TechnicianProfile.renderSettingsScreen(el, { prefix, onChange })` wherever it needs the tester's details.

## Schema

| Column | Notes |
|---|---|
| Site | Client/school — one Railway DB now holds every site, filterable. Backed by a lightweight `sites` registry table for autocomplete/rename. |
| Location | Area within the site, e.g. "Tuckshop" |
| Appliance | e.g. "Fridge 1" |
| Plant No. | Small sequential number — **unique per site+location, not globally** (Plant No. 3 can exist in two different rooms) |
| Environment category | Drives the auto-filled retest interval |
| Brand / Model No. / Serial No. | From the nameplate |
| Tag No. | The physical test tag sticker — **this is the primary scan key**, since a fresh tag is applied each test cycle |
| Pass/Fail, Test Date, Next Due, Tester, Notes, Photo | Logged per test on `test_records` — full history kept, editable, deletable |

## How the scan flow works
1. Enter the **Site** (autocompletes from what's already in the register) and **Location**.
2. Photograph the tag/nameplate → Claude vision reads Tag No., Plant No., Appliance, Brand, Model No., Serial No., and the tag's own printed date/pass-fail if visible.
3. App looks the item up: first by **Tag No.** (was this tag already logged against an asset?), then by **Site+Location+Plant No.**, then by **Serial No.** — found → shows last test result and lets you log the next one; not found → creates a new asset.
4. Log the test result, including the **new** tag number if the item's been re-tagged this cycle.

## Register export/import
- **Export** — with a site selected, reproduces the original template exactly (site name + "Asset Register - Test and Tag Items" title rows, same column order/headers) so it drops straight back into the same-shaped workbook. Without a site filter, exports a consolidated multi-site sheet with a Site column added.
- **Import** — parses that same template shape (site name in row 1, headers in row 3) to seed the database from an existing register like Holy Spirit Primary's. Also creates a test record from each row's Pass/Fail/Test Date/Next Due if present, so imported history isn't lost.

## Run locally

Needs Node.js 18+ and Docker (for a local Postgres — easiest path, no separate Postgres install).

```bash
cd test-tag-app
cp .env.example .env        # then fill in ANTHROPIC_API_KEY and APP_ACCESS_TOKEN
docker compose up -d        # starts local Postgres on localhost:5432
npm install
npm start
```

Open **http://localhost:3000**. First boot creates the `assets`/`test_records` tables automatically, same `initDb()` as on Railway. Camera capture (`capture="environment"`) needs a real device — on a laptop the file picker still works, it just won't jump straight to a camera.

To stop: `Ctrl+C` the server, `docker compose down` to stop Postgres (add `-v` to also wipe the local data volume and start fresh).

Already have a local Postgres running some other way? Skip `docker compose` and just point `DATABASE_URL` in `.env` at it instead.

## Deploy steps (optional — only if/when you want it on Railway instead)

1. Create a new GitHub repo, upload every file in this folder (your usual drag-and-drop/delete-reupload workflow).
2. New Railway service, "Deploy from GitHub repo".
3. Add or reuse a PostgreSQL database in the same Railway project — this app's tables (`assets`, `test_records`) can share a Postgres instance with TouchTrace/Job Capture.
4. **Link environment variables to the app service** (the step that bit Job Capture before):
   - `DATABASE_URL` → reference the Postgres service
   - `ANTHROPIC_API_KEY` → same key used by TouchTrace
   - `APP_ACCESS_TOKEN` → can reuse the TouchTrace/Job Capture token
5. First deploy creates the tables (`initDb()` runs on boot). If you change the schema later and need a clean rebuild, same rule as before: a table drop needs a manual redeploy to re-trigger `initDb()`.
6. Open the Railway URL, enter the access token when prompted.

## Things still worth deciding
- **AC's and RCD's tabs** — the same workbook also tracks split-system air conditioners and switchboard/RCD injection testing, a different shape (service/cleaning checklist, location-level RCD counts) and not covered by this app. Separate module if you want them digitised too.
- **Model string**: `routes/extract.js` uses `model: "claude-sonnet-5"` — match TouchTrace's exact string if it differs.
- **Merging Site with TouchTrace's upcoming Sites feature** — this app's `sites` table is a natural handoff point, but the actual merge is a bigger conversation once TouchTrace's Sites feature exists.
- **Report branding/wording** — the Generate Report text (Abstract, Summary of Results wording, Compliance Statement) is derived automatically from the register/test data. Worth a once-over against a couple of real reports to make sure the phrasing matches Aus Air's usual tone before it goes to a client.
