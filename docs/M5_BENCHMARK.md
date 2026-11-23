# M5 synthetic benchmark results

## Environment and workload

- Windows build 26300, AMD Ryzen 5 7535U, 12 logical processors, 15.21 GiB RAM.
- Node.js 22.17.0 and MongoDB 7.0.24. Node and standalone MongoDB ran on the same machine, in an isolated temporary database. Other local development processes were active.
- The deterministic generator creates fictional records with repeated names, category and state variation, optional benefit data, and a sparse solar keyword. The initial snapshot includes staging, verified synthetic publication, reconciliation and the change-event writes. The incremental job changes and publishes 50 records.
- Search measurements use the same Mongoose queries as the catalogue list, including the total count. They cycle through the first page of a text query, a state filter, and a category-plus-state filter. Explain plans warm the queries before measurement. Each level sends 150 requests. Ten-way searches overlap with incremental synchronization and a batch from the notification worker. The benchmark contains no profile data.
- Run `npm.cmd run benchmark -- 10000` or pass another size between 1 and 100000. Timings include local driver scheduling and database execution. They exclude HTTP, browser rendering and remote network latency.

## Import and database size

| Records | Snapshot seconds | Records/sec | 50-record delta ms | Logical data bytes | Allocated data bytes | Index bytes |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 13.77 | 72.61 | 1241.03 | 5,800,774 | 69,632 | 237,568 |
| 10,000 | 110.86 | 90.2 | 1268.77 | 56,299,955 | 5,636,096 | 4,407,296 |
| 50,000 | 521.81 | 95.82 | 1367.06 | 283,292,539 | 53,620,736 | 33,607,680 |

Database size covers all collections and indexes after the delta. The 1,000- and 10,000-record runs used the earlier per-record reconciliation adoption pass. Their allocated size figures were read from MongoDB's current storage stats without an explicit flush. Compare logical data sizes when evaluating those two runs. The 50,000-record run used batched adoption and flushed the temporary database before measuring size. Its ingestion timing predates the final safeguard for allocating a new version after an interrupted publication.

## Query latency and throughput

| Records | Concurrent clients | p50 ms | p95 ms | p99 ms | Requests/sec | Errors |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 1 | 3.58 | 5.32 | 11.29 | 267.18 | 0/150 |
| 1,000 | 10 | 24.47 | 44.74 | 90.22 | 341.42 | 0/150 |
| 1,000 | 50 | 78.31 | 104.84 | 154.9 | 575.37 | 0/150 |
| 10,000 | 1 | 12.84 | 23.32 | 58.16 | 80.13 | 0/150 |
| 10,000 | 10 | 36.06 | 72.87 | 93.85 | 223.65 | 0/150 |
| 10,000 | 50 | 107.87 | 171.59 | 209.28 | 412.12 | 0/150 |
| 50,000 | 1 | 38.29 | 73.21 | 226.68 | 26.26 | 0/150 |
| 50,000 | 10 | 87.91 | 151.72 | 178.03 | 113.13 | 0/150 |
| 50,000 | 50 | 563.51 | 1614.94 | 1922.51 | 68.47 | 0/150 |

The incremental job was still running when the ten-way search sample finished in each run. The notification worker processed 18, 19 and 19 events respectively, with zero failures. At 50,000 records, p95 stayed below the PRD's 750 ms target at one and ten clients and exceeded the target at 50 clients.

## Execution plans

At 10,000 records, the **solar text search** used the text index and examined 77 keys and 154 documents for 10 returned rows. The **Maharashtra filter** used the published-name sort index and examined 13 keys and 13 documents for 10 rows. **Education plus Maharashtra** used the published-category index and sorted results after examining 1,429 keys and 1,429 documents for 10 rows. These are list-query plans. The latency table includes the separate count query.

At 50,000 records, those same list plans examined 382 keys and 764 documents for text search, 18 keys and 18 documents for state alone, and 7,143 keys and 7,143 documents for category plus state. Each returned 10 rows. Category-plus-state filtering adds a sort after the category index scan. The current workload also pays for a separate result count on each request.

## Scope of the results

These local measurements cover a generated catalogue and a fixed workload. Real provider latency, production traffic, deep pagination, cold-cache behavior and notification delivery to large opt-in populations each require their own measurement.
