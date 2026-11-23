# BenefitBridge

BenefitBridge is an independent, guest-first catalogue for discovering government scheme information. It provides search, optional anonymous matching, and accounts with saved questionnaire profiles and bookmarks. The product requirements and system design are in [docs](docs/).

## Run locally

Use Node.js 22.12+ on the 22.x line or a supported newer LTS and npm. For either application mode, start MongoDB Community Server on `127.0.0.1:27017`. On Windows, start the **MongoDB** service if you installed it as a service. For a standalone installation with `mongod` on your `PATH`, run these commands in a separate PowerShell terminal from the project directory:

```powershell
New-Item -ItemType Directory -Force .local/mongo-data
mongod --dbpath .local/mongo-data --bind_ip 127.0.0.1 --port 27017
```

From the project directory, install the locked dependencies:

```sh
npm ci
```

### Synthetic demo

With MongoDB running, seed the fixtures and start the API and web app in separate terminals:

```sh
npm run seed:demo
npm run demo:api
npm run demo:web
```

Open [the synthetic demo](http://127.0.0.1:5174). Search for **solar**, select **Maharashtra**, then open **Home Energy Upgrade Rebate**. The nationwide result remains visible with the state filter. Clear the search and filters to try pagination, or select **Closed** under Availability for an archived example.

To try all three matching outcomes, leave the search blank and open **Personalize Results** beside the filters. Enter age **27**, select **No** for studying and home ownership, and select **Yes** for homeowner permission. Apply personalization and expand **Why this result?** on a few cards. The home energy example has an alternative pathway for permission, other listings have incomplete eligibility information, and the learning grant has a known unmet condition. **Reset personalization** clears your answers and restores ordinary ranking. Rerun `npm run seed:demo` on an existing Phase 1 database to attach the fictional rules while preserving the original schemes and their versions.

The demo uses the dedicated `benefitbridge_demo` database and loopback API port 4001. Its fixtures use reserved `.invalid` source references and the UI labels the catalogue as fictional. Repeat seeding skips unchanged records. The regular app rejects both the demo database name and synthetic API responses. If your local MongoDB port differs, copy `api/.env.demo.example` to `api/.env.demo` and adjust `DEMO_MONGODB_URI`. The demo connection accepts a loopback address with a port.

### Regular development

Use separate terminals:

```sh
npm run dev:api
npm run dev:web
```

Open [the regular catalogue](http://127.0.0.1:5173). It starts empty and uses `benefitbridge_dev` with API port 4000. To configure MongoDB, copy `api/.env.example` to `api/.env` and supply your server-only connection settings. If you override the API port, update the matching proxy target in `web/vite.config.js` too.

For an authorized dataset, supply a JSON file with `dataset: "authorized"`, source metadata and permissions, retrieval timestamp, and records with stable source IDs and source references. The [fixture validator](api/src/modules/ingestion/file-adapter.js) defines the format. Confirm usage and retention permissions and check the evidence before import. Run:

```sh
npm run seed:authorized -- "D:/path/to/authorized-catalogue.json"
```

This legacy seed command is for an initial dataset that the operator has already verified. It writes immutable initial versions and skips identical records. Use the M5 workflow below for updates to published records and authoritative closures. The application reads the published MongoDB catalogue directly.

## How guest matching works

- The questionnaire requests questions for the scheme IDs on the current results page. The API uses only supported, verified criteria tied to the published version and a listed source reference. A shared question is asked once even when several schemes use it.
- Within one eligibility pathway, all listed conditions must pass. A verified alternative pathway can satisfy the rules on its own. Missing answers, incomplete pathways, and uncertain sources are explained on the affected card.
- Matching ranks potential matches first, then schemes needing information, then schemes with known unmet conditions. Ordinary relevance decides the order within each group. Every result stays available, and each page is ranked independently.
- Answers live in React memory for the current tab and travel in the JSON body of the evaluation request. The server uses them in memory and returns a response with caching disabled. Resetting or reloading clears them.
- The optional fixture `eligibility` object supports `status: "verified"`, `evidenceUrl` from the record’s `sourceRefs`, `pathsExhaustive`, and `paths`. Each pathway declares `complete` and an array of conditions with `attribute`, `operator`, and `value`. Supported attributes are `age`, `currentlyStudying`, `ownsHome`, and `hasOwnerPermission`. Boolean conditions use `eq`. Integer age can also use `atLeast` and `atMost`. Record verification must come from checked source evidence. [Eligibility schema](api/src/modules/matching/criteria.js)

## Accounts on Windows

With MongoDB running, install dependencies and seed the demo from the repository root:

```powershell
npm.cmd ci
npm.cmd run seed:demo
```

Run `npm.cmd run demo:api` and `npm.cmd run demo:web` in separate terminals. Open [the demo account page](http://127.0.0.1:5174/account), create a test account with a password of at least 12 characters, and sign in. Open a scheme detail and select **Bookmark scheme**. The **Account** page lists bookmarks and lets you remove them. Enter profile answers, check the consent box, and select **Save profile**. **Use saved answers in search** explicitly applies the saved values to the current tab. Regular development uses `npm.cmd run dev:api` and `npm.cmd run dev:web` with [the regular account page](http://127.0.0.1:5173/account).

### Google sign-in

1. In a Google Cloud project, open **Google Auth Platform**. Configure **Branding** with the app name and support email. Select the appropriate **Audience** and, if using External testing, add the Google accounts that will test the app.
2. Under **Clients**, create an OAuth client with type **Web application**. Add the exact URI for the environment you are configuring to **Authorized redirect URIs**.

   | Environment | Authorized redirect URI |
   | --- | --- |
   | Regular development | `http://127.0.0.1:5173/api/v1/auth/google/callback` |
   | Synthetic demo | `http://127.0.0.1:5174/api/v1/auth/google/callback` |

3. For regular development, run `Copy-Item api/.env.example api/.env` if the destination is absent. Enter the ID and secret in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. For the demo, copy `api/.env.demo.example` to `api/.env.demo` and set `DEMO_GOOGLE_CLIENT_ID` and `DEMO_GOOGLE_CLIENT_SECRET`. These files are ignored by Git.
4. Restart the API and open the account page on the same host and port as the configured redirect URI. Select **Continue with Google**. An existing password account keeps its original sign-in method even if Google returns the same email. [Google Auth Platform setup](https://support.google.com/cloud/answer/15544987) · [Google OpenID Connect web server flow](https://developers.google.com/identity/openid-connect/openid-connect)

If BenefitBridge says **This email already has a sign-in method**, Google returned a verified email already used by a different BenefitBridge sign-in identity. Sign out of BenefitBridge, add a different Google account under **Google Auth Platform → Audience → Test users** if the OAuth app uses External testing, and select that account from Google's chooser. Use an email that has never been registered with a password in the demo. A separate browser profile or private window can make the choice easier. Existing accounts retain their original sign-in method. [Google test users](https://support.google.com/cloud/answer/15549945) · [Google account chooser](https://developers.google.com/identity/openid-connect/openid-connect)

### Email verification and password recovery

Phase 4 uses in-app alerts only. Live SMTP, password-reset email delivery, email verification delivery and scheme notification emails are deferred. Leave SMTP settings blank for the in-app demo. The existing local sandbox instructions below apply when testing the earlier identity email flow separately.

Loopback development without SMTP supports local test registration and displays those accounts as unverified. To exercise verification and recovery, start a local SMTP test inbox, set `SMTP_URL=smtp://127.0.0.1:1025` and `MAIL_FROM=noreply@example.test` in `api/.env`, or use the corresponding `DEMO_` settings in `api/.env.demo`. Restart the API. Register, then open the verification link from the inbox. Use **Forgot password?** on the sign-in screen to test recovery. Existing unverified local accounts can use **Resend verification email** once SMTP is configured. A non-loopback SMTP server uses TLS.

### Sessions and consent

The browser receives a random session ID in an HttpOnly cookie. MongoDB stores its hash and a seven-day expiry. The API checks the session and derives the owner for all profile and bookmark operations. Sign-in rotates the session, logout revokes it, and password reset invalidates every previous session for that account. Account writes require the configured same-origin frontend. HTTPS origins use Secure host-only cookies. Local loopback HTTP is for development.

Saving a profile requires an explicit consent checkbox and an account request. Copying current answers into the profile form leaves them as a draft until saved. Signing out clears questionnaire answers in the current tab. Account and profile data live in the selected MongoDB database, so configure database access controls, encrypted storage and backups for a public deployment. Rate limiting is currently per API process. Deploy with an HTTPS reverse proxy and keep API and frontend on one origin.

## In-app notification demo

1. Start MongoDB, run `npm.cmd run seed:demo`, and run `npm.cmd run demo:api` and `npm.cmd run demo:web` in separate terminals.
2. Sign in at the [demo account page](http://127.0.0.1:5174/account). Bookmark **Learning Materials Grant** on its scheme page. In **Account**, save a profile with age **27** and **Yes** for currently studying. Check the consent box before saving.
3. Open **Notifications**, enable both preferences, and save. Preferences start off. Enable them and save the profile before publishing, since older publications do not trigger catch-up alerts.
4. From the project root, publish both synthetic fixtures and process the queue.

   ```powershell
   npm.cmd run publish:demo -- update
   npm.cmd run publish:demo -- new
   npm.cmd run notifications:demo -- --once
   ```

5. Select **Refresh notifications**. Expect **Verified scheme update** for the learning grant and **Potential profile match** for **Demo Campus Materials Award**. Mark either notification read or unread. Rerun the worker or the publication commands to check that the inbox does not gain duplicates.

Run `npm.cmd run notifications:demo` without `--once` to process the demo queue continuously, or `npm.cmd run notifications` for the regular database. Each synthetic fixture publishes once per demo database. A fresh isolated demo MongoDB instance gives you a repeatable first-publication test while preserving an existing demo database and its accounts. The worker waits for the exact version to be published and verified, and holds disputed versions. Profile alerts require an active scheme with a verified rule yielding a potential match and separate notification consent. The synthetic update exercises an immutable revision and preserves the original catalogue version. Category-level preferences and email delivery remain deferred.

## M5 synchronization and review

### Windows demo

1. Start MongoDB, `npm.cmd run demo:api`, and `npm.cmd run demo:web`. Register a demo account. From a repository-root PowerShell terminal with trusted database access, grant that account administrator access in the demo database.

   ```powershell
   npm.cmd run sync:demo -- grant-admin reviewer@example.test
   npm.cmd run sync:demo -- snapshot
   ```

2. Open [Catalogue administration](http://127.0.0.1:5174/admin) with that account. If already signed in, reload to refresh the navigation. Inspect the source, successful job and staged evidence. Approve `m5-study` with a review reason, run `npm.cmd run sync:demo -- once`, then approve `m5-study-mh` and run the worker once more. Open the parent scheme to see the linked Maharashtra variant. A regular account receives HTTP 403 on the administration routes.
3. To simulate an update, point the worker at the second fictional snapshot. The existing benefit remains visible with an under-review message until approval. The changed benefit and deadline appear after the worker publishes the reviewed version.

   ```powershell
   $env:DEMO_INGEST_SOURCE_FILE = (Resolve-Path .\api\test\fixtures\synthetic\sync-update.json).Path
   npm.cmd run sync:demo -- snapshot
   # Approve the pending parent change in the administration screen.
   npm.cmd run sync:demo -- once
   npm.cmd run notifications:demo -- --once
   ```

4. Optionally bookmark the parent and enable update alerts before step 3. A user with a consented profile containing age 27 and opted-in profile alerts can test the newly published variant in step 2. Use a fresh synthetic database to repeat first-publication alerts.

`npm.cmd run sync:demo -- watch` processes queued jobs and reviews continuously. `snapshot` and `incremental` enqueue a job and perform one worker pass. `once` processes a ready job and pending decisions for the configured source. `revoke-admin` removes the role using the same operator-only command. In regular development use `npm.cmd run sync -- watch` and the same commands without the `:demo` suffix. The administrator UI queues work and records decisions. Ingestion and publication run in the worker process.

### Source configuration

- File mode uses an absolute `INGEST_SOURCE_FILE` (or `DEMO_INGEST_SOURCE_FILE`). The [synthetic snapshot](api/test/fixtures/synthetic/sync-snapshot.json) shows both forms of a record. A plain record can include `sourceUpdatedAt` and otherwise uses the file's `retrievedAt`. The envelope uses `record`, `updatedAt`, optional `authenticity: "uncertain"`, `relationships`, and `closureEvidence`. Use a genuinely reliable per-record source timestamp when the provider supplies one.
- HTTPS mode uses `INGEST_ENDPOINT`, `INGEST_SOURCE_METADATA` (JSON with `id`, `name`, `baseUrl`, `accessPermissions`, `retentionPolicy`, and `evidenceOrigins`), optional `INGEST_AUTHORIZATION`, and `INGEST_INCREMENTAL=true` when supported. Use only a verified and permitted endpoint. There is currently no live government provider configured or verified. A provider with a different payload needs a mapper implementing the same adapter contract.
- The contract is `page({ mode, cursor, checkpoint })`. A response supplies `records` in envelope form and `nextCursor` (null on the final page). Snapshot pages carry a stable `snapshotKey` and the final page must explicitly report `complete: true`. Incremental runs return an opaque checkpoint on the final page. A snapshot may supply a checkpoint if the provider defines it in the same checkpoint stream. Configure `INGEST_POLL_MS` and `INGEST_RECONCILE_MS` to adjust the 15-minute polling and 24-hour reconciliation defaults. File-only feeds run snapshots.
- `reference_only` keeps source URLs and normalized evidence. `permitted_original` also retains valid original envelopes up to 256 KB when the provider permits it. Evidence links, including official closure evidence and application links, must be within configured evidence origins. An absent record creates a review only after a complete snapshot with no invalid rows. Source-confirmed closure requires explicit evidence and reviewer approval. Similar names keep separate source identities.

### MongoDB and recovery

| Collection | Purpose |
| --- | --- |
| `sources`, `source_records` | Provider permissions and retained evidence with source ID, record ID, hash and retrieval time |
| `sync_sources`, `sync_jobs` | Committed checkpoints, per-source worker leases, attempts, results and safe error codes |
| `source_membership` | Last observed source timestamp and complete-snapshot membership |
| `review_cases` | Staged normalized data, affected fields, source evidence, decision history and approval errors |
| `schemes`, `scheme_versions`, `scheme_rule_versions` | Published catalogue, immutable source-backed revisions and independent eligibility for each variant |
| `change_events` | Durable handoff to the existing notification worker |

A retry starts from the job's original committed checkpoint. Staging uses deterministic source identities and hashes, so the worker can replay a page. The checkpoint moves only after the final page is processed. Reviews from an interrupted run require a completed observation before approval. Publication creates the immutable version and any applicable change event before switching the live scheme pointer. A retry uses the original decision and checks that the live version and source evidence still agree. This permits standalone MongoDB and keeps partial revisions out of search. Users continue to see the last published information during a review or source interruption.

The live catalogue groups a state variant under its verified central parent and supports explicit supplement and related links. Each variant keeps its own rules. A reviewer must resolve an evidence conflict before publication. New, unconfirmed records stay outside the public catalogue until approval. An approved change triggers a bookmark alert only when tracked benefit, eligibility, application or lifecycle fields change. Newly published schemes still require a verified rule and an opted-in saved profile to generate a match alert.

### Scale checks

```powershell
npm.cmd run benchmark -- 10000
npm.cmd run benchmark -- 50000
# The same generator accepts up to 100000.
```

The runner creates a temporary standalone MongoDB process with a dedicated `benefitbridge_loadtest` database. Synthetic benchmark approval is enabled only in that database. The workload uses the same ranked list and count queries as the catalogue. It reports search percentiles, failures, index plans, ingestion and incremental throughput, database size, and hardware. See the [measured benchmark report](docs/M5_BENCHMARK.md).

## Checks

```sh
npm.cmd test
npm.cmd run build
```

API integration tests start a temporary MongoDB instance. On the first run they download a MongoDB binary into the ignored `.local/mongodb` cache. To use an existing local binary, set `MONGOMS_SYSTEM_BINARY` to the full path to `mongod` or `mongod.exe`. The web tests use a simulated DOM. The production frontend build is written to `web/dist`. Hosting it requires SPA route fallback and an API proxy on the same origin.

## API

- `GET /api/v1/health` checks API and database readiness.
- `GET /api/v1/schemes` browses published records. Use `q`, `goal`, `state`, `category`, `benefitType`, `issuer`, `governmentLevel`, `lifecycleStatus`, `page`, and `limit` as needed. Closed records appear in lists when explicitly requested and retain their detail URLs.
- `GET /api/v1/facets` provides filter choices from the catalogue.
- `GET /api/v1/schemes/:schemeId` returns scheme details and source provenance.
- `GET /api/v1/questions?schemeIds=id1,id2` selects applicable verified questions for up to 50 published schemes.
- `POST /api/v1/matches/evaluate` accepts JSON with `schemeIds` and an `answers` object. It returns ranked outcomes and condition explanations without storing the answers.
- `/api/v1/auth` provides password registration, login, logout, Google sign-in, email verification, and password reset.
- `GET /api/v1/me`, `GET/PUT/DELETE /api/v1/me/profile`, and the `/api/v1/me/bookmarks` list, create, lookup and delete routes require a valid session.
- `GET /api/v1/me/notifications`, `PATCH /api/v1/me/notifications/:notificationId`, and `GET/PUT /api/v1/me/notification-preferences` require a valid session and scope operations to the current account.
