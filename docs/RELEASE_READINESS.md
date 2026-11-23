# BenefitBridge release-readiness review

**23 November 2026. Ready for a synthetic public portfolio demonstration once the deployment prerequisites below are met.** The review covered the repository and an isolated local environment. A production host, live Google sign-in, SMTP delivery, and live Gemini extraction were outside this test run.

## Performance

The existing M5 50,000-record benchmark measured 1,615 ms p95 at 50 clients in a direct Mongoose workload. The release benchmark uses Express over local HTTP and adds browse, page 30, mixed state/category terms, questionnaire selection, and personalized ranking. The two workloads have different mixes and should be reported separately. [M5 baseline methodology](M5_BENCHMARK.md)

Run `node scripts/benchmark-http.mjs 50000` from the project root. It bulk-seeds an isolated standalone MongoDB with fictional data and attaches ten synthetic eligibility rules. A warm-up precedes 160 requests at each level. The 50-client level runs twice. Requests use the normal API routes and rate limiters. The host was Windows build 26300, Ryzen 5 7535U, 12 logical processors, 15.21 GiB RAM, Node.js 22.17.0, and MongoDB 7.0.24. This tests short bursts on one machine with warmed data. It excludes ingestion overlap, remote latency, geography, and browser rendering.

| Clients | Baseline p50 / p95 / p99 ms | Revised p50 / p95 / p99 ms | Baseline → revised req/s |
| ---: | ---: | ---: | ---: |
| 1 | 43 / 208 / 304 | 54 / 114 / 154 | 18 → 20 |
| 10 | 74 / 364 / 413 | 56 / 125 / 148 | 82 → 147 |
| 50, run 1 | 452 / 779 / 987 | 261 / 335 / 404 | 87 → 169 |
| 50, run 2 | 489 / 795 / 921 | 242 / 339 / 381 | 82 → 179 |

Zero HTTP or transport failures in 640 measured requests per version. All revised catalogue workloads stayed below the PRD's 750 ms p95 test target. Per-route samples are small.

| Workload at 50 clients | Baseline p95 across runs | Revised p95 across runs |
| --- | ---: | ---: |
| Text search | 440–469 ms | 248–298 ms |
| State filter | 676–691 ms | 280–314 ms |
| Category plus state | 600–625 ms | 258–311 ms |
| Category pagination, page 30 | 597–618 ms | 250–301 ms |
| Browse | 921–987 ms | 297–344 ms |
| Mixed state and category terms | 572–622 ms | 297–330 ms |
| Question selection | 624–794 ms | 335–339 ms |
| Personalized ranking | 645–691 ms | 348–354 ms |

The browse count previously fetched all 50,000 documents. The lifecycle index now scans about 47,827 keys and fetches zero documents for that count. The category and sort index removes the blocking sort in the measured category-plus-state list and lowers documents examined from 7,143 to 17. Page 30 drops from 7,143 to 314. Concurrent requests for identical filters share an in-flight exact count. The result is discarded when it finishes, so a later request counts again. Page order, filters, and pagination response fields are unchanged.

The driver uses a shared connection and its default maximum pool size of 100. Checkout p95 at 50 clients dropped from 66–132 ms to 22–33 ms, with zero checkout failures. This points to query work and concurrent database demand as contributors and supports keeping the current pool size for the tested workload. Broad state counts still fetch about 13,636 documents and deep offsets still scan skipped rows. Startup creates the new indexes. Upgraded databases keep the earlier category index, so inspect their winning plans before retiring a redundant index. [MongoDB connection pool documentation](https://www.mongodb.com/docs/drivers/node/current/connect/connection-options/connection-pools/)

## Security and isolation

| Area | Finding and disposition |
| --- | --- |
| Reverse proxy and rate limits | Behind a same-host proxy, Express initially grouped requests under the proxy's IP. `TRUST_LOOPBACK_PROXY` and `DEMO_TRUST_LOOPBACK_PROXY` now allow opt-in trust for loopback only. The trusted proxy must overwrite the client IP header and be the only public route to the API. Limits still use per-process memory. [Express proxy guide](https://expressjs.com/en/guide/behind-proxies/) |
| Password recovery | Password reset now checks for an unexpired, indexed recovery record before starting Argon2id. The final update still atomically consumes the token and invalidates previous sessions. The regression test confirms that reuse skips hashing. |
| Sessions and Google OAuth | Reviewed random opaque session tokens, hashed storage, TTL and request-time expiry, login rotation, logout, secure cookie configuration, and reset revocation. OAuth uses state, PKCE, nonce, verified claims, and a one-time attempt. Email collisions still require the original sign-in method. OAuth and mail tests used mocks. |
| CSRF, ownership, admin access and input | Mutations require the configured origin, and account actions derive ownership from the authenticated session. Review endpoints require administrator privileges. Validated scalars and strict JSON schemas feed fixed database query structures. Existing tests cover access denial, wrong origins, cross-user behavior, malformed requests, and review/publication gates. |
| XSS and information exposure | React renders scheme text as text. Importers restrict links to HTTP(S) and reject embedded URL credentials. API errors omit stack traces and the normal API path uses `Cache-Control: no-store`. A filename-only scan found no common Google-key or private-key markers in tracked source or the bundles. Git history had no tracked `api/.env` or `api/.env.demo` path. This was a targeted check. |
| Dataset separation | Fixture validation, dedicated database names, catalogue query scoping, and frontend dataset checks keep synthetic and authorized records apart. The release benchmarks, browser audit, and tests used isolated databases. |
| Gemini | The server-side worker reads the key and accepts only configured sources. Personalization never calls Gemini. The durable ledger defaults to 10 requests per UTC day, and the manual evaluator caps a run at five. The worker honors cooldowns and bounded retries, and approved publication remains a separate process. Use the same ledger for workers sharing a Google project. No live Gemini calls were made. |
| Dependencies and runtimes | `npm audit --json` reported zero advisories across the locked npm graph, so there were no package findings to triage for reachability. The benchmark Node and MongoDB versions predate vendor security releases and should stay confined to local testing. See the runtime prerequisite below. |

## Accessibility and release checks

- axe-core 4.14.1 reported zero violations for the WCAG A/AA rules it ran on the desktop and mobile catalogue, questionnaire, scheme detail, sign-in, signed-in profile, notifications, and admin landing page in Edge. Two contrast checks required manual review. Both flagged decorative glyphs use foreground `#1c347f` on white, a contrast ratio of 11.37:1. [axe-core](https://github.com/dequelabs/axe-core) · [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- The Edge smoke run checked layout widths down to 320 px, mobile filter expansion, dialog focus and Escape restoration, fictional disclosures, local sign-in, bookmarking, and signed-in routes. Screen-reader testing, a full manual WCAG conformance audit, and other browsers remain outside the verified scope.
- `npm.cmd test` passed 72 tests. The regular and demo-mode Vite production builds passed. Build the synthetic frontend in `demo` mode so it expects the synthetic API dataset.

## Deployment prerequisites

1. **Patch the runtimes.** Use a supported LTS release of Node.js with current security patches and a maintained MongoDB release with current security patches. At this review the Node 22 security release was 22.23.5, and MongoDB's 7.0 notes listed security fixes in 7.0.45. Keep MongoDB private, authenticated, and backed up. [Node.js security releases](https://nodejs.org/en/blog/vulnerability/november-2026-security-releases) · [MongoDB 7.0 release notes](https://www.mongodb.com/docs/manual/release-notes/7.0/)
2. **Serve one HTTPS origin.** Serve the built frontend and proxy `/api/v1` to the loopback API. Set `NODE_ENV=production` and the exact HTTPS `APP_ORIGIN` or `DEMO_APP_ORIGIN`. Enable the matching loopback proxy setting only when the local reverse proxy replaces `X-Forwarded-For` with the actual client address. Apply HSTS and a frontend CSP at the HTTPS host. Verify a direct load of a scheme or account route uses the SPA entry point.
3. **Deploy the demo in isolation.** Use the demo database and synthetic frontend build. The demo MongoDB URI requires loopback. Keep credentials server-side, use a demo-only administrator account, restrict admin access, and leave ingestion and Gemini off unless the demonstration needs them. Keep the demo offline from the authorized catalogue. Set up exact redirect URLs for Google or configure SMTP if demonstrating account creation at the HTTPS origin. Never enable local unverified email registration for the public host. If public registration is enabled, establish how real account and profile data will be handled and retained.
4. **Verify the real host before sharing it.** Check browser login/logout, response cookies and headers, rate limiting through the proxy, and host health after starting the API and workers that the demo uses. Keep logs free of personal data and secrets. Use the current single-process rate-limit behavior for a small demo. A replicated deployment requires shared limits or equivalent enforcement at the edge.
