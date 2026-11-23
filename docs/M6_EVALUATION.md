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
