# Load test (100 users, 1000 sites)

The target is stated in CLAUDE.md and in the sizing tool: 100 people signed in at the same time, 1000 sites, pages under 2 seconds. This page is the
repeatable test for it, how to read it, and the result of the first run.

## Run it

```
cd pmis/apps/api
LOAD_TEST=1 LOAD_OUT=/tmp/load-result.md npm run test:load
```

It is off in the normal suite (it takes minutes). It builds the same 1000-site database as `dashboard-perf.test.ts` (`dash-seed.sql`), creates 100
signed-in users (one in five sees every region, the others two regions), and lets all of them run a mix of the read screens people open all day:
`/dashboard`, `/dashboard/site-map`, `/project-status?group_by=region`, `/sites?limit=50`, `/search?q=PF`, `/me/profile`. It prints p50, p95, p99 and
the maximum per request and for all, counts failures, and fails when any request fails or the 95th percentile is 2 seconds or more.

| Knob | Default | Meaning |
|---|---|---|
| `LOAD_USERS` | 100 | users at the same time |
| `LOAD_ROUNDS` | 20 | requests per user |
| `LOAD_THINK_MS` | 10000 | average pause between two requests of one user; 0 is a stress run (back to back) |
| `LOAD_POOL` | 10 | database connections of the API (`connection_limit`) |
| `LOAD_SITES` | 1000 | synthetic sites |
| `LOAD_LATE_PCT` | 100 | share of sites with late-prone dates; 100 is the original pattern (about a quarter of the tasks late), 20 gives about 5% late, closer to a real project |
| `LOAD_CACHE_MS` | 30000 | the `/dashboard` cache time of the run; 0 turns it off to see the cost without it |
| `LOAD_OUT` | none | file for the result table |

## Where to run it

The users and the API run in one process against one PostgreSQL, so the client takes CPU from the server. Run it on the production-like host (same
vCPU and RAM as the sizing result, PostgreSQL 16 on the same machine as in the install), with the repository checked out there and a throw-away
PostgreSQL superuser URL for the test databases (`TEST_PG_ADMIN_URL`, the same variable the suite uses). Never run it against the production
database. A run on a small developer box tells you the per-request cost, not whether the target host is big enough.

## Connection pool

The API opens `DB_POOL_SIZE` connections (default 10) unless the database URL already names `connection_limit`. Without it Prisma would open 2 x CPUs + 1
(3 on a 1 vCPU box). A request holds a connection for its whole transaction, so a pool of 3 queues the rest. Raise `DB_POOL_SIZE` on a host with more CPUs, and keep
it below PostgreSQL `max_connections` minus what the other services use.

## The `/dashboard` cache

`GET /dashboard` keeps the result of its heavy database call (`dash_overview`, about 0.9 s on 1000 sites) for 30 seconds, in the memory of each API process.
The key holds the caller's dashboard and issues region scope (read live on every request), the filters, the view, the override flag and the site set of a filter
tree, so one scope never receives another scope's figures and a rights change applies on the next request. The right check runs on every request before the cache.
`meta.as_of` is the time the figures were read, so it can be up to 30 seconds old. What this means for users: a task or register change can take up to 30 seconds to show on
the dashboard. A write to settings, goals, weights, workflow, matrix, roles, delegations, regions, imports, data hub, templates, custom fields, list catalogues, delay
periods or a data reset clears the cache at once. `DASHBOARD_CACHE_TTL_MS` changes the time; 0 turns it off. A second API process has its own cache.

## Result of the first run (2026-11-27)

Host: a 2 vCPU, 2 GB developer box that also runs PostgreSQL 16 and the test client. This is below the sizing tool's recommendation, so it is a floor.

One user, back to back (the cost of one request, nothing queued):

| Request | p50 ms | p95 ms |
|---|---|---|
| `/me/profile` | 14 | 18 |
| `/dashboard/site-map` | 102 | 118 |
| `/sites?limit=50` | 189 | 232 |
| `/project-status?group_by=region` | 292 | 300 |
| `/dashboard` | 844 | 932 |
| `/search?q=PF` | 1188 | 1243 |

100 users, think time 8 s, 4 requests each (400 requests, 0 failed): p50 4.1 s, p95 7.7 s, p99 9.9 s, 7.5 requests per second served. The box was
saturated: even `/me/profile` waited about 3 s in the queue. **The 2 second criterion is not met on this box.** Two things follow:

1. The cost of one request is the number to improve first: `/search` (1.2 s for one user on 1000 sites) and `/dashboard` (0.85 s) are the heaviest, and they
   are the ones that queue. The users list had the same kind of problem (fixed in the page-first change); the search over sites is the next candidate.
2. The answer for the real target needs a run on the real host with the knobs above. Record that run here (date, host, table) before go-live.

Back to back with 100 users and a pool of 3 gave 64 of 600 requests failed with a pool timeout, which is the pool note above.

## Result after the search, pool and dashboard-cache changes (2026-11-27)

Same box. The synthetic data here has about 5% of the tasks late (`LOAD_LATE_PCT=20`), which is closer to a real project than the first run's quarter. Changes since the
first run: the task search normalises per definition and per site (single user `/search` 1188 ms to 348 ms), the pool is explicit, and `/dashboard` is cached for 30 seconds.

100 users, think time 8 s, 4 requests each (400 requests, 0 failed):

| Run | p50 ms | p95 ms | p99 ms | requests per second |
|---|---|---|---|---|
| First run (before) | 4100 | 7700 | 9900 | 7.5 |
| Search fix, pool, 5% late, no dashboard cache | 592 | 2300 | 3558 | 9.0 |
| Same with the 30 s dashboard cache (default) | 157 | 744 | 1443 | 10.6 |

The 2 second criterion is met on this box with the cache. Without it the p95 is 2.3 s. One user, first `/dashboard` after the cache is empty: about 0.65 s (5% late) or 0.9 s (quarter late);
a repeat inside 30 seconds answers in a few milliseconds. The delay attribution part of `dash_overview` grows with the number of late tasks. The numbers still come from a developer box
that also runs the test client: record the run on the real host here before go-live.
