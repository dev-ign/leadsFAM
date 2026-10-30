# Phase 02 performance measurements

Final run after clean reset: 2026-10-30T15:43:41.585Z. Raw samples, global row counts, relation sizes, PostgreSQL settings and query plans are preserved beside this file.

macOS 26.5.2, Apple M1 Pro (8 logical CPUs), 32 GiB host RAM; Docker Engine 29.9.2, 8 CPUs/~7.75 GiB container VM RAM; PostgreSQL 17.11, shared_buffers 128 MiB, work_mem 4 MiB, JIT on; Node 26.13.0/pnpm 12.16.1. Local Docker services and builds were already warm. Other full test suites were stopped during the final timed run.

Fastify injection includes routing, opaque-cookie/session SQL, real Supabase Auth verification, user-JWT PostgREST, response parsing and schema validation. It excludes browser rendering and client TCP/TLS. Four independently signed-in users issue four concurrent reads: four warmups and twelve measured requests per operation. With only twelve samples, nearest-rank p95 is the maximum; these are diagnostic measurements, not a statistically robust production SLO.

Each target organization has approximately 1k, 10k or 50k leads, two leads per contact, 40/30/20/10 percent new/in-progress/qualified/closed-won, 5% archived, 10/80/10 low/normal/high priority, one-third assigned to the owner, eight sources and ten campaigns. Dates span 365 days; 20% company contacts, 80% have an email, 40% a synthetic phone. Each lead has two events, each contact one event. Three admin users have no assigned leads; `mine` filtering therefore mixes one owner result and three empty results.

Each size also adds a foreign 1k-lead tenant. Earlier stages and their 700 imported leads remain during subsequent stages; actual global lead/contact/activity counts before the import samples are 2,000/1,000/5,000; 13,700/7,200/33,900; and 65,400/33,400/162,800. The fixture cleanup removes only its own organizations/users after all stages.

Read p95 in milliseconds (25-item pages):

| Operation               | 1k target | 10k target |      50k target |
| ----------------------- | --------: | ---------: | --------------: |
| Newest leads            |     196.6 |       69.1 |            67.5 |
| Recent activity order   |     191.4 |       76.7 |            72.4 |
| Contact email prefix    |      23.0 |       19.0 |            19.0 |
| Lead title prefix       |      44.6 |       94.0 |           377.2 |
| Status + source + mine  |      75.4 |      242.7 |          1085.4 |
| Lead detail             |      17.1 |       19.3 |            16.4 |
| Lead timeline           |      18.7 |       20.3 |            15.5 |
| Broad contains anywhere |     278.9 |    2,629.1 | **503 timeout** |

The 50k substring case failed all four warmups and twelve measured requests at the five-second transport deadline (recorded p95 5,064.3 ms). It is a known resource/performance limitation, not a successful five-second response. Other final cases returned 200. The initial 300 ms target is **not met** by the 50k title-prefix case (377.2 ms), combined filter (1,085.4 ms), or broad substring workloads. No security check was removed to reach a number. Broad prefixes can also return many candidates; use selective terms and filters.

100-row imports use three sequential new jobs and one four-job concurrent burst per size. Each explicitly creates distinct synthetic contacts; no matching ambiguity is hidden. Times below are max/nearest-rank p95 for these small samples:

| Batch                        | 1k target | 10k target | 50k target |
| ---------------------------- | --------: | ---------: | ---------: |
| One 100-row job              |  580.9 ms |   574.2 ms |   598.4 ms |
| Four concurrent 100-row jobs | 2008.1 ms |  2005.7 ms |  2103.0 ms |

The initial three-second batch target was met in the final run, including the burst; a prior comparison had a 3.09-second burst. Local scheduling, planner choices, autovacuum, cache state and dataset skew cause variance. No p99, cold-cache, sustained load, remote latency or production capacity claim is made.

## Investigation and index evidence

The initial implementation had a 100-row import 503 at only 1k and slow substring search. Explicit create-distinct choices no longer run needless matching; a dedicated nested condition guarantees the skip. Parameter-bound dynamic SQL gives optional filters parameter-specific plans. Search now offers a default prefix mode using generated normalized name/title columns and native SP-GiST indexes; broad contains remains explicit. Candidate UUIDs and source IDs use joins rather than expensive residual/subquery scans. A single selected assignee generation is resolved under the organization SHARE lock; volatile per-row RLS/session checks are unchanged. All function owners/grants and Phase 01 policies remain unchanged.

Plans include wrapper RPC timings and ordinary-role relational access paths, not administrator-only timings. Prefix-email plans show `contact_emails_prefix_idx` followed by the tenant/contact unique index. Title-prefix plans use `leads_prefix_idx`; normal lists use `leads_created_idx`. The contact shape uses channel PKs, `leads_contact_idx` and attribution PKs for first touch. The old residual `ILIKE` plan scans authorized rows; its cost explains the retained substring limitation. A trigram extension alone would not justify relaxing non-leakproof/RLS ordering, so none was installed.

## Artifacts and follow-up

[Final raw results](results.json), [1k plans](1000-plans.json), [10k plans](10000-plans.json), [50k plans](50000-plans.json). Earlier initial, scaled, prefix/join and optimization comparisons are retained in sibling directories. The earliest run aborted at the first import failure; its observations explicitly record that no import elapsed sample was retained.

Repeat with the version-controlled `tests/performance/crm.mjs` as documented in the manual guide. Before a customer rollout, profile broad search/combined filters against expected real distributions and sustained concurrency; select a bounded search/product policy or separately review further indexing/query improvements. Do not solve the timeout by bypassing RLS, caching authorization across requests or silently extending unbounded work.
