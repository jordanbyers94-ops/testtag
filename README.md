# Aus Air Electrical — Test & Tag Register

Standalone app (same pattern as Aus Air Job Capture): Node/Express + PostgreSQL, deployed on Railway via GitHub.

Schema is built directly off a real client register (Holy Spirit Primary School, Test Tag Items tab), not a guess:

| Column | Notes |
|---|---|
| Site | Client/school - one Railway DB now holds every site, filterable |
| Location | Area within the site, e.g. "Tuckshop" |
| Appliance | e.g. "Fridge 1" |
| Plant No. | Small sequential number — **unique per site+location, not globally** (Plant No. 3 can exist in two different rooms) |
| Brand / Model No. / Serial No. | From the nameplate |
| Tag No. | The physical test tag sticker — **this is the primary scan key**, since a fresh tag is applied each test cycle |
| Pass/Fail, Test Date, Next Due, Notes | Logged per test, on the `test_records` table (full history kept, not just the latest) |

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

## Things worth deciding next
- **Photo storage** — extracted photos aren't persisted anywhere yet. Flag it if you want them archived per test record.
- **AC's and RCD's tabs** — the same workbook also tracks split-system air conditioners and switchboard/RCD injection testing, which are a different shape (service/cleaning checklist, and location-level RCD counts) and aren't covered by this app. Separate module if you want them digitised too.
- **Model string**: `routes/extract.js` uses `model: "claude-sonnet-5"` — match TouchTrace's exact string if it differs.
