# BenefitBridge

BenefitBridge is an independent, guest-first catalogue for discovering government scheme information. It provides search, filters, pagination, scheme details, and optional anonymous matching. The product requirements and system design are in [docs](docs/).

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

The importer stages an evidence reference and writes one immutable initial version per scheme. It skips identical published records and rejects changes to published records pending a future review workflow. The application reads the published MongoDB catalogue directly.

## How guest matching works

- The questionnaire requests questions for the scheme IDs on the current results page. The API uses only supported, verified criteria tied to the published version and a listed source reference. A shared question is asked once even when several schemes use it.
- Within one eligibility pathway, all listed conditions must pass. A verified alternative pathway can satisfy the rules on its own. Missing answers, incomplete pathways, and uncertain sources are explained on the affected card.
- Matching ranks potential matches first, then schemes needing information, then schemes with known unmet conditions. Ordinary relevance decides the order within each group. Every result stays available, and each page is ranked independently.
- Answers live in React memory for the current tab and travel in the JSON body of the evaluation request. The server uses them in memory and returns a response with caching disabled. Resetting or reloading clears them.
- The optional fixture `eligibility` object supports `status: "verified"`, `evidenceUrl` from the record’s `sourceRefs`, `pathsExhaustive`, and `paths`. Each pathway declares `complete` and an array of conditions with `attribute`, `operator`, and `value`. Supported attributes are `age`, `currentlyStudying`, `ownsHome`, and `hasOwnerPermission`. Boolean conditions use `eq`. Integer age can also use `atLeast` and `atMost`. Record verification must come from checked source evidence. [Eligibility schema](api/src/modules/matching/criteria.js)

## Checks

```sh
npm test
npm run build
```

API integration tests start a temporary MongoDB instance. On the first run they download a MongoDB binary into the ignored `.local/mongodb` cache. To use an existing local binary, set `MONGOMS_SYSTEM_BINARY` to the full path to `mongod` or `mongod.exe`. The web tests use a simulated DOM. The production frontend build is written to `web/dist`. Hosting it requires SPA route fallback and an API proxy on the same origin.

## API

- `GET /api/v1/health` checks API and database readiness.
- `GET /api/v1/schemes` browses published records. Use `q`, `goal`, `state`, `category`, `benefitType`, `issuer`, `governmentLevel`, `lifecycleStatus`, `page`, and `limit` as needed. Closed records appear in lists when explicitly requested and retain their detail URLs.
- `GET /api/v1/facets` provides filter choices from the catalogue.
- `GET /api/v1/schemes/:schemeId` returns scheme details and source provenance.
- `GET /api/v1/questions?schemeIds=id1,id2` selects applicable verified questions for up to 50 published schemes.
- `POST /api/v1/matches/evaluate` accepts JSON with `schemeIds` and an `answers` object. It returns ranked outcomes and condition explanations without storing the answers.
