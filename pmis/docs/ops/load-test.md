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
| `LOAD_OUT` | none | file for the result table |

## Where to run it

The users and the API run in one process against one PostgreSQL, so the client takes CPU from the server. Run it on the production-like host (same
vCPU and RAM as the sizing result, PostgreSQL 16 on the same machine as in the install), with the repository checked out there and a throw-away
PostgreSQL superuser URL for the test databases (`TEST_PG_ADMIN_URL`, the same variable the suite uses). Never run it against the production
database. A run on a small developer box tells you the per-request cost, not whether the target host is big enough.

## Connection pool

The API does not set a pool size. Prisma opens 2 x CPUs + 1 connections by default (3 on a 1 vCPU box, 9 on 4 vCPUs). Set `connection_limit` in the
database URL if the host has few CPUs and many people: a request holds a connection for its whole transaction, so a pool of 3 queues the rest.

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
