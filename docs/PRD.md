# BenefitBridge — Product Requirements Document (PRD)

**Version:** 1.0 | **Date:** 23 November 2026 | **Status:** Approved product direction; implementation not started  
**Audience:** Product owner, software engineer, AI coding agent, reviewers  
**Companion:** [SYSTEM_DESIGN.md](SYSTEM_DESIGN.md)

## 1. Executive summary

BenefitBridge is an independent, non-government, MERN-based discovery platform that helps people in India **find government schemes they may not know exist**. It allows anonymous, goal-first searches, shows relevant scheme information, and offers an optional side-panel questionnaire to make results more personally relevant. Users may create accounts to save profiles and bookmarks, and opt into in-app and email updates. Applications, document verification, final eligibility determinations, and payments take place on official government portals, **not** on BenefitBridge.

The project is designed to demonstrate production-oriented architecture for a large catalogue, but an initial portfolio release can run locally with a small authorized real dataset and a physically separate synthetic load-testing dataset.

**Product promise:** *Discover the benefits you might be missing.*  
**Accuracy principle:** Present source-backed information and uncertainty clearly; never represent potential matching as official eligibility or approval.

## 2. Problem, audience, differentiation

### 2.1 Problem
- People may not know which government schemes relate to their goals or circumstances.
- Scheme descriptions vary in terminology, structure, and update frequency.
- Users may need to visit multiple official pages to understand requirements and application procedures.

### 2.2 Target audience
Individuals across India, including students, households, farmers, entrepreneurs, and other beneficiaries. **This is a broad product audience, not a commitment to full nationwide scheme coverage at MVP launch.**

### 2.3 Differentiation hypothesis
Compared with a conventional scheme directory, BenefitBridge will emphasize goal-first discovery, optional non-blocking personalization, evidence-aware matching, bookmarks, and proactive discovery of potentially relevant new schemes. Existing government portals such as myScheme already provide substantial discovery functionality, so differentiation remains a **hypothesis to validate**, not a proven claim.

## 3. Product principles and constraints

1. **Discovery before questionnaires:** A visitor sees results without completing forms or logging in.
2. **Awareness over adjudication:** Show what exists, how it relates to users, and where to apply; never promise eligibility or approval.
3. **Explain uncertainty:** Clearly distinguish potential match, insufficient information, and known unmet conditions.
4. **Accessible without an account:** Guest users can search and personalize in the current session.
5. **Privacy by default:** Collect only relevant answers, avoid Aadhaar numbers, bank details, and document uploads, and require consent for stored profiles and notifications.
6. **Authoritative links and traceability:** Scheme pages link to the appropriate official sources and expose freshness and verification status.
7. **No unauthorized scraping:** Only use data providers and retention methods with appropriate access/usage permission.
8. **Large-scale architecture, staged implementation:** Demonstrate performance with isolated synthetic data rather than pretending the test records are actual benefits.
9. **Not affiliated with government:** The UI must clearly identify BenefitBridge as an independent informational project.

## 4. Target user journeys

### Journey J1 — Goal-first guest discovery
1. Visitor opens the homepage and searches for a goal, e.g., “install rooftop solar.”
2. Search returns matching schemes promptly, with sorting and filters for category, state, authority, benefit type, and availability when reliable metadata exists.
3. Visitor opens a scheme page showing description, benefits, eligibility text, required documents (if available), source, status, and official application link.
4. Visitor may leave for the government application portal without signing up.

### Journey J2 — Optional personalization via side panel
1. Visitor opens **Filters & Personalize** beside search results.
2. Ordinary filters remain separate from the optional **Personalize** questionnaire.
3. The questionnaire asks only questions supported by verified structured criteria for the currently relevant schemes; previous answers are reused during the session.
4. Results remain discoverable and are grouped/ranked as **Potential match**, **More information needed**, and **Known conditions not met**.
5. Visitor can clear answers and revert to unpersonalized results immediately.
6. Following a search, visitor sees the optional prompt **“Discover benefits you might be missing”** to explore beyond their original goal. This may request further information with explicit consent.

### Journey J3 — Optional account and saving
1. Visitor signs up with email/password or signs in with Google.
2. Account holder may bookmark schemes and explicitly save a reusable profile.
3. Users can update or delete their profiles, bookmarks, and account.
4. Unregistered users retain access to basic discovery and in-session personalization.

### Journey J4 — Notifications
1. Account holder explicitly enables **in-app** and/or **email** notifications.
2. Relevant verified changes to bookmarked schemes create notifications.
3. In a later release, newly imported/updated schemes that potentially match opted-in saved profiles also generate notifications.
4. Material conflicts or unverified source data **pause affected notifications**.
5. Users can mute categories, unsubscribe from email, and manage notification settings.

### Journey J5 — Data review (administrator)
1. Authorized ingestion produces candidate records/changes.
2. Automatic validation checks allowed format, source provenance, consistency, and duplicate hints.
3. Ambiguous or disputed changes enter a review queue.
4. Administrator approves, rejects, or defers the affected change with a reason and audit trail.
5. Only approved/policy-compliant information becomes publicly published; unverified fields display warnings rather than invented facts.

## 5. Functional requirements

Priority labels: **MUST (MVP)**, **SHOULD (post-MVP)**, **LATER (advanced)**.

| ID | Requirement | Priority | Acceptance evidence |
|---|---|---|---|
| FR-01 | Public goal-first search without login | MUST | A guest enters a goal and receives paginated scheme results |
| FR-02 | Search by title, description, keywords/goals | MUST | Expected fixture schemes appear for known queries |
| FR-03 | Filters by available category, state, benefit type, issuer | MUST | Filtering narrows results and can be cleared |
| FR-04 | Scheme detail page with official source/application links | MUST | Every publicly listed real scheme has provenance and at least one authoritative link |
| FR-05 | Show last-checked and verification/status labels | MUST | Uncertain, stale, disputed, and closed information is visibly differentiated |
| FR-06 | Optional side-panel questionnaire | MUST | Guest can personalize without authentication and reset answers |
| FR-07 | Rank/group potential, unknown, and known-unmet matches without hiding the latter | MUST | All relevant scheme groups remain accessible; no fabricated eligibility percentage |
| FR-08 | Email/password registration, verification and login | MUST | Registered user can sign in securely and reset password |
| FR-09 | Google sign-in using OpenID Connect | MUST | Google identity validated server-side; safe account linking |
| FR-10 | Bookmarks and saved reusable profile | MUST | Only owner can view/change personal data; saved only with explicit action |
| FR-11 | In-app notification centre and opt-in email delivery | MUST | Verified bookmark update fixture produces in-app alert and opted-in test email |
| FR-12 | Basic admin review/approval for imported data | MUST | Disputed update cannot silently replace verified public data |
| FR-13 | Pluggable one-source authorized import with basic provenance | MUST | Repeat import is idempotent; synthetic records cannot enter public catalogue |
| FR-14 | Cross-category “benefits you might be missing” flow | SHOULD | Explicit opt-in initiates a broader match, discloses additional data needed |
| FR-15 | New potentially matching scheme notifications | SHOULD | Matching users notified only with consent and verified source evidence |
| FR-16 | Incremental sync, checkpointing, retries, snapshot fallback, reconciliation | SHOULD | Simulated failures recover without data loss or duplicate publication |
| FR-17 | Parent schemes, verified variants, supplement/related relationships | SHOULD | Similar names do not automatically merge independent schemes |
| FR-18 | Scheme/rule version timeline and field-level conflicts | SHOULD | Old verified version recoverable; conflict warnings identify affected fields |
| FR-19 | AI-assisted extraction of candidate eligibility criteria/questions | LATER | Human/automated validation gate; AI-generated data never auto-published solely because schema is valid |
| FR-20 | Advanced relevance tuning, multilingual features, email digests | LATER | Evaluated against defined quality and usability tests |
| FR-21 | Performance/load testing on isolated synthetic catalogue | SHOULD | Reproducible test report includes environment, volume, p50/p95, and failures |

### Requirement clarifications
- **Eligibility source:** Official source text/structured eligibility fields are authoritative inputs; BenefitBridge only interprets them for *potential* matching when sufficiently structured and verified.
- **No structured rules:** Scheme stays discoverable with “Eligibility information requires verification”; do not silently exclude it.
- **Conflicts:** Keep a credible scheme visible, flag disputed fields and pause alerts depending on those fields. Quarantine records whose authenticity cannot be established.
- **Missing records:** Absence from an incremental feed is not deletion. Only a sufficiently complete reconciliation can flag records as missing. Explicit source-confirmed closure may mark a scheme closed.
- **Variants:** Verified state-specific variants link to a common parent, but maintain **independent versioned** eligibility rules. State top-up programs may be related but distinct schemes.

## 6. Initial release scope versus later phases

### MVP — demonstrable end-to-end product
- Responsive modern/minimal React UI: homepage, results, side filters, optional questionnaire, scheme details, account/profile, bookmarks, notifications.
- Node/Express REST API and indexed MongoDB catalogue.
- Email/password and Google account login, secure session handling.
- Basic data import from **one authorized source** (or explicitly permitted hand-curated sample) with normalizing/verification checks; no assumed myScheme access.
- Deterministic matching using *available verified structured attributes*; schemes without structured criteria remain visible.
- A basic reviewer screen for uncertain changes; provenance and update timestamps.
- In-app notifications and email delivery for **verified bookmarked-scheme changes**, using local test events and a permitted email provider or mail sandbox.
- Synthetic data in a **separate test database/environment** for load testing.

### Phase 2 — robust ingestion and matching
- Incremental polling where supported; scheduled snapshots and periodic reconciliation.
- Versioned eligibility rules and state variants; audit trail, review workflows, retries, idempotent jobs.
- “Benefits you might be missing” recommendations and **new matching scheme alerts** from saved profiles.
- Queue-backed jobs, delivery retries, notification batching/deduplication, error monitoring.

### Phase 3 — AI and advanced capability
- AI-assisted extraction of structured criteria and reusable questionnaire questions from authorized source records.
- Validation/review of extracted rule candidates; model evaluations and error analysis.
- Additional data sources (only as legally permitted), improved search relevance, multilingual UX, operational hardening.

## 7. Business rules and ranking

- A scheme can be **discoverable** without being **machine-matchable**.
- Default ranking prioritizes goal/text relevance and verified status; if personalized, known potential matches appear before unknown and known-unmet cases, but all relevant groups remain accessible.
- Do not express eligibility as arbitrary percentages; a failed mandatory condition cannot be averaged away.
- “Potential match” is informational, not legal/government approval.
- Closed schemes may remain accessible in an archival/explicitly filtered view but must not be presented as open applications.
- No automatic merging of similarly named schemes; evidence-backed relationship types are `variant_of`, `supplement_to`, `related_to`.
- A verified parent's change must not automatically overwrite a variant's independent rules.
- Notifications require both an opted-in user and a meaningful, verified, relevant event.

## 8. Non-functional requirements and quality goals

| Area | Goal / engineering rule |
|---|---|
| Accessibility | Responsive, keyboard-accessible controls; meaningful labels, contrast and focus states; target WCAG 2.2 AA practices |
| Availability | Search should continue from last verified local data during external API outage, with freshness warnings |
| Security | Server-side authorization; input validation, login throttling, hashed passwords, secure cookies, CSRF protection as appropriate |
| Privacy | No Aadhaar/bank/document collection in MVP; ephemeral guest answers; explicit opt-in for persistent profile and email |
| Maintainability | Modular monolith initially; source adapter and background worker boundaries for later extraction |
| Data integrity | Unique source IDs, immutable provenance, idempotent imports, review gate, version history for material changes |
| Testing | Unit, API integration, auth/security, ingestion failure, consent, accessibility and reproducible load tests |
| Performance | **Target to test, not claim:** for a 50k-record synthetic catalogue, indexed simple search/filter p95 < 750 ms on a documented test machine and workload; revise after baseline |
| Cost | Local-first and free/open-source where practicable; paid cloud, API, or AI usage requires explicit choice |

## 9. Success criteria and demo scenarios

### Product acceptance
1. Guest finds a relevant scheme without login.
2. Side questionnaire changes ranking, not catalogue visibility.
3. Scheme details show official links, status, source and dates.
4. User can register/login via email or Google, bookmark a scheme, and explicitly save profile answers.
5. An admin-approved bookmark change creates an in-app alert and, if enabled, a test email.
6. Disputed changes do not overwrite published data or trigger related notifications.
7. A closed or uncertain scheme never silently appears as an open, verified offer.

### Engineering demonstration
- Import the same record twice without duplication.
- Simulate API outage, malformed payload, old update, changed identifier and missing record.
- Show synthetic 50k+ record search benchmarks with methodology and measured results.
- Show source-to-publication provenance and a previously published version.

## 10. Assumptions, dependencies and risks

| Item | Status | Mitigation / next step |
|---|---|---|
| Access to a comprehensive scheme catalogue API | **Unverified / external dependency** | Investigate myScheme/API Setu publisher access and permitted data.gov.in resources; never scrape without authorization |
| Complete structured eligibility criteria available in APIs | **Not established** | Match only validated structured fields, otherwise show informational scheme detail |
| Source update semantics/checkpoints | **Provider-dependent** | Adapter capabilities declare incremental, snapshot, deletions, rate limits, retention |
| Government data freshness | **Inherent risk** | Verification dates, stale warnings, safe last-known-good versions, review queue |
| Privacy/data processing requirements | **Requires jurisdiction-specific review before public deployment** | Minimize fields, consent, account deletion, data-retention documentation |
| Email sending and Google OAuth credentials | **Configuration dependency** | Local email sandbox + Google test credentials; protect secrets |
| AI extraction cost/accuracy | **Deferred** | Keep optional provider boundary and evaluation plan; no AI dependency for MVP |
| Full national coverage | **Not guaranteed** | Describe catalogue coverage honestly and expose data-source limitations |
| Project status | **Not deployed; implementation not started** | Measure actual outcomes, do not claim planned performance as achieved |

## 11. Delivery milestones and exit criteria

1. **M0 — Specifications:** PRD and design reviewed; unresolved dependencies recorded; no code generated yet.
2. **M1 — Foundation:** MERN setup, schemas/indexes, fixture import, basic public search and details.
3. **M2 — Personalization:** Dynamic question selection from verified structured fields; three-state ranking; clear/reset.
4. **M3 — Identity and saving:** Email/password, Google login, bookmark/profile lifecycle and authorization tests.
5. **M4 — Change and alerts:** Review workflow, versioned update fixture, in-app/email notification, consent/unsubscribe.
6. **M5 — Scale demonstration:** Source adapter refinements, isolated synthetic imports, performance/failure testing and technical report.
7. **M6 — Advanced backlog:** Incremental reconciliation, new-match alerts, AI-assisted extraction after validating necessity and affordability.

## 12. Decisions carried forward

- General-purpose audience; goal-first scheme discovery.
- Optional side-filter personalization; no mandatory questionnaire.
- Follow-up “Discover benefits you might be missing.”
- Optional accounts; bookmarks, reusable profiles, opted-in in-app/email alerts.
- Potential matching is not government eligibility determination.
- Data-driven catalogue, one authorized provider initially; source-independent adapter; synthetic tests isolated.
- Incremental sync when available, reconciliation/snapshot fallback later.
- Hybrid verification, conflict review, missing-record review, traceability and versions.
- Parent schemes with verified state variants; independently versioned variant rules.
- AI-assisted question extraction deferred until core functionality works.
- Modern minimal service-oriented interface.

## 13. External documentation (access constraints, not API commitments)

- myScheme Terms of Use: https://search.myscheme.gov.in/terms-of-use
- API Setu: https://docs.apisetu.gov.in/document-central/explore-apisetu/Overview.html
- API Setu access process: https://docs.apisetu.gov.in/document-central/explore-apisetu/Partners.html
- Open Government Data Platform India: https://data.gov.in/
- Google OpenID Connect: https://developers.google.com/identity/openid-connect/openid-connect

*No application code is included in this PRD.*
