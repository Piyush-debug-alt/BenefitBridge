# M6 synthetic eligibility extraction evaluation

## Setup

Run `npm.cmd run evaluate:extraction` from the repository root. This evaluates `mock` version `explicit-en-v1` against 13 original fictional English descriptions. Expected condition tuples and review dispositions are maintained in the fixture, independently of the run. The benchmark uses local extraction and evidence validation in Node.js on Windows. It excludes network, database, queue, and reviewer time. No production catalogue or personal data is used.

## Measured results

| Measure | Observed |
| --- | ---: |
| Precision of supported condition proposals | 17/17 (100%) |
| Recall of supported conditions | 17/20 (85%) |
| Unsupported or invented proposals | 0/17 (0%) |
| Schema-valid provider responses | 13/13 |
| Exact AND/OR pathway structure | 11/13 |
| Correct question sets on reviewable cases | 6/6 |
| Cases passing validation and eligible for human approval | 6/13 |
| Cases blocked for manual review | 7/13 |
| Review disposition matched expectations | 13/13 |
| Total local processing time | 23.972 ms |
| p50 and p95 per description | 0.673 ms and 14.477 ms |

Blocked cases generated no active questionnaires. The shape check accepts an empty proposal and can accept contradictory condition tuples. The evidence and rule gates determine whether those responses are safe to review for publication.

The three missed conditions came from two descriptions. The provider declined an alternative that did not explicitly begin with “either” and missed the phrasing “be at least 18 years old.” The evaluator also observed warnings for no eligibility text, contradictory age bounds, an unsupported certificate, tentative language, and an instruction-like source sentence.

## Interpretation

These are results from a small, authored fixture and a deterministic English parser. The mock and evidence validator share an intentionally conservative grammar. The figures do not estimate hosted model quality, resistance to all prompt injection, or extraction accuracy on live government records. Before using a hosted adapter, measure it on a larger independently labeled permitted corpus, including ambiguous and adversarial samples. Review its source-data handling, operating cost and latency separately. The API integration tests cover actual admin authorization, approval, rejection, immutable publication, and provider failures independently of the evaluation script.

## Gemini evaluation status

The earlier live `minimum-age` run passed schema and evidence validation. It returned the expected `age >= 18` in 1.846 seconds using 350 tokens. The subsequent live batch used `gemini-3.1-flash-lite` on the four fixtures at offsets 1–4. The figures below come from that batch, before the fixes for short age-range quotes and unresolved reason codes.

| Measure | Observed in the earlier live batch |
| --- | ---: |
| Proposed condition precision | 9/9 (100%) |
| Proposed condition recall | 9/9 (100%) |
| Schema validity | 3/4 |
| Evidence validation on fixtures expected to pass | 2/3 |
| Exact AND/OR pathways | 3/4 |
| API request failures | 0/4 |
| Median / p95 per response | 3.78 s / 5.92 s |
| Total token usage | 1,886 |

`alternatives` and `income-residency-ownership` passed schema and evidence checks. `age-range-and-study` had the correct conditions but the validator rejected the two age quotes as unrecognized clauses. `ambiguous-minimum` failed the transport schema because its unresolved reason was outside the allowed values. Regression tests cover those failures using mocked responses. The isolated MongoDB integration test also verifies that a valid Gemini proposal stays unpublished until administrator approval and the publication worker runs. Rejecting a replacement leaves the published rule intact. Matching pauses while the underlying source review remains open and resumes on the original rule when that source change is rejected.

The final audit found that the local ledger had reached its 10-request UTC daily limit. The revised pipeline was verified offline. Once at least four requests are available and the project is still on the Free tier, the remaining live check is a single batch from the project root. [Windows setup](../README.md#gemini-free-tier-setup-on-windows)

```powershell
npm.cmd run evaluate:extraction -- --provider=gemini --live --offset=1 --limit=4
```

The manual evaluator stops on the first failed request and reports that failure separately from `responsesEvaluated`. A returned proposal can still fail schema or source-evidence checks. The evaluator compares outputs against frozen labels and writes its quota counters separately from the catalogue. The small English fixture set catches regressions and supports a synthetic demo. Real scheme text may use unsupported phrasing or require manual interpretation, and these results cannot establish production eligibility accuracy.
