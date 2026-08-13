# feature-flag-service

A self-hosted feature flag / percentage-rollout service with a low-latency SDK
(local cache + push-based invalidation over a websocket) and a full,
immutable audit log with instant rollback.

## Problem

Third-party flag services are expensive at scale and put an external call on
your hot path. The usual self-hosted fallback is worse in a different way:
either you hit the database on every single flag check (latency + load that
scales with traffic), or you cache flags with no invalidation and now a flag
you just turned off keeps affecting users for however long the cache TTL is.
Neither is acceptable for something as latency- and correctness-sensitive as
"is this user in the rollout."

This project's answer: the SDK holds every flag in memory and evaluates
against that cache — no network call per check — while the service pushes
the *new* flag state to every connected SDK the instant something changes,
so the cache is never more than one network round-trip stale. Rollout
membership is a deterministic hash of `(flag key, user id)`, not a random
roll, so the same user gets the same answer on every request and after every
restart. Every change is recorded as an immutable, attributed entry, and
rolling back is instant because it's just "restore a prior snapshot and
record that as a new entry" — history is never edited.

## Architecture

```
                 ┌──────────────────────────┐
                 │      NestJS service       │
                 │                            │
  REST  ───────► │  FlagsController           │
                 │       │                     │
                 │       ▼                     │
                 │  FlagsService  ── writes ──►│  SQLite (flags, audit_log)
                 │       │                     │
                 │       ▼                     │
                 │  FlagsGateway (Socket.IO)   │
                 └───────┬────────────────────┘
                         │ push: flag:updated (full flag payload)
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
     SDK instance   SDK instance   SDK instance   ...
     (local cache,  (local cache,  (local cache,
      sync evaluate) sync evaluate) sync evaluate)

     Next.js dashboard ──REST──► NestJS service
     (flag list, audit history, rollback button)
```

**Service** (`service/`, NestJS): owns flag definitions and the audit log,
exposes a small REST API, and pushes changes over a Socket.IO gateway.

**SDK** (`sdk/`, TypeScript): on `connect()`, does one REST pull to warm an
in-memory cache, then opens a socket and applies pushed updates to that
cache directly. `evaluate()` never makes a network call — it reads the
cache and runs the same deterministic hash the service uses, which is what
gets evaluation down to sub-millisecond, purely-local latency.

**Dashboard** (`dashboard/`, Next.js): a small client-rendered app — flag
list, audit history for the selected flag, and a rollback button that hits
the real service.

**Python client** (`python-client/`): a ~100-line illustrative client
showing the same FNV-1a hash and REST-pull-and-cache pattern in a second
language, to demonstrate the "polyglot SDK" claim is a property of the
*algorithm*, not the TypeScript implementation. It polls rather than
streaming invalidation (no `python-socketio` dependency) — noted as the one
thing intentionally left out of the Python side; a production client SDK for
Python would add that.

### Design decisions and rejected tradeoffs

- **Deterministic hash bucketing, not random-per-request.** Rollout
  membership is `FNV-1a32("<flagKey>:<userId>") % 100 < rolloutPercentage`.
  FNV-1a has no seed and touches no process state, so it's provably stable
  across requests, across SDK instances, and across restarts. Rejected:
  `Math.random()` per evaluation — it's what most naive implementations do,
  and it means a user can be "in" a rollout on one request and "out" on the
  next, which breaks any feature that needs a consistent per-user
  experience (which is most of them).

- **Push-based invalidation over a real websocket, not polling.** The
  service holds a Socket.IO connection open per SDK instance and emits the
  full new flag object the instant a change commits. Rejected: polling
  REST on an interval — it trades propagation latency directly for request
  volume (poll faster = fresher but more load; poll slower = less load but
  stale for longer), and this project's whole premise is not accepting that
  tradeoff. The propagation-latency test below measures this directly
  instead of asserting it.

- **SQLite instead of Postgres.** There's no live Postgres in this
  environment, and SQLite (via `better-sqlite3`, synchronous, no driver
  connection pool to reason about) is a faithful stand-in for a relational
  store: `service/src/db/database.service.ts` is two `CREATE TABLE`
  statements plus a synchronous handle. Swapping to Postgres means
  replacing that one file with a `pg` pool and translating `INTEGER`
  booleans / `TEXT` timestamps to `BOOLEAN` / `TIMESTAMPTZ` — nothing else
  in the service touches SQL directly.

- **Single-instance websocket fan-out, with LISTEN/NOTIFY or Redis pub/sub
  documented as the production swap.** `FlagsGateway.broadcastFlagChanged`
  currently does `this.server.emit(...)`, which reaches every socket
  connected to *this* process. That's correct for one instance but wrong
  behind a load balancer with N instances, where a write on instance A
  needs to reach SDKs connected to instance B. The real-world fix is small:
  publish the changed flag to a shared channel (Postgres `LISTEN/NOTIFY` if
  Postgres is already the system of record and you don't want another
  moving part, or Redis pub/sub for lower latency and simpler payload
  limits) and have every instance also subscribe once at boot and re-emit
  to its own local sockets. Not built here because there's exactly one
  service instance in this environment and building fan-out logic with no
  second instance to test it against would be exactly the kind of
  unverified code these instructions ask to avoid.

- **Immutable audit log with append-only rollback.** `flags` is a
  current-state table (one row per flag); `audit_log` is insert-only.
  Rollback reads a target entry's `new_state` snapshot, writes it back as
  the current row, and appends a *new* `rollback` entry — it never UPDATEs
  or DELETEs a prior entry. Rejected: mutating the flag row and calling it
  done without a matching audit entry (loses the "who/when/why" trail that
  is the entire point of an audit log), and "restore by replaying deltas"
  (unnecessary complexity when every entry already stores the full
  resulting state, not a diff).

- **Fail-safe cache, not fail-open or fail-closed.** The SDK's cache is
  only ever written on a successful REST sync or a pushed update — it's
  never cleared on disconnect. So when the service goes down, `evaluate()`
  keeps returning whatever was last known-good, with no special-casing
  required. The configurable default is used exclusively for flag keys
  that were *never* cached (a cold SDK talking to a service that's already
  down) — not as a response to a mid-session outage. This is exercised for
  real in `service/test/failsafe.e2e.spec.ts`, which spawns the compiled
  service as a separate OS process and `SIGKILL`s it mid-test.

## Repo layout

```
service/         NestJS service (flags API, evaluation, audit/rollback, websocket gateway)
sdk/              TypeScript SDK (local cache + push invalidation + local evaluation)
dashboard/        Next.js admin dashboard (flag list, audit history, rollback)
python-client/    Illustrative Python client (same hash, REST pull, no streaming)
```

`service/` and `sdk/` are npm workspaces (see the root `package.json`) so the
service's tests can import the real, compiled SDK package directly instead
of a stub.

## Setup

Requires Node 18+ (developed and tested on Node 23) and Python 3.9+ for the
optional client. Everything below works from a clean clone.

```bash
git clone <this-repo>
cd feature-flag-service
npm install                 # installs service + sdk workspaces
npm run build                # builds sdk, then service (dist/ for both)
npm test                     # sdk tests, then service tests (builds first)
```

### Run the service

```bash
cd service
npm run start:dev            # http://localhost:3000, SQLite at service/data/flags.sqlite
# or, after `npm run build` from the repo root:
npm start
```

### Run the dashboard

```bash
cd dashboard
npm install
cp .env.example .env.local    # NEXT_PUBLIC_API_URL=http://localhost:3000
npm run dev                   # http://localhost:3001
```

Open `http://localhost:3001` with the service running — it lists real flags
pulled from the service, shows the selected flag's audit history, and
"Roll back to this" performs a real rollback via the service's REST API.

## Usage examples (real output)

Create a flag and evaluate it for a user:

```bash
$ curl -s -X POST http://localhost:3000/flags -H 'Content-Type: application/json' \
    -d '{"key":"new-checkout","name":"New Checkout","enabled":true,"rolloutPercentage":30,"actor":"alice"}'
{"key":"new-checkout","name":"New Checkout","description":"","enabled":true,"rolloutPercentage":30,"createdAt":"2026-08-13T08:59:13.267Z","updatedAt":"2026-08-13T08:59:13.267Z"}

$ curl -s "http://localhost:3000/flags/new-checkout/evaluate?userId=user-42"
{"value":true,"bucket":26,"flagFound":true}
```

The same user always lands in the same bucket — verified across a real
process restart, and cross-checked against an independent Python
implementation of the same hash:

```bash
$ curl -s "http://localhost:3012/flags/checkout-v2/evaluate?userId=user-42"
{"value":true,"bucket":10,"flagFound":true}

$ python3 python-client/flag_client.py http://localhost:3012 checkout-v2 user-42
flag=checkout-v2 user=user-42 bucket=10 value=True
```

Update a flag, inspect the audit trail, and roll back:

```bash
$ curl -s -X PATCH http://localhost:3000/flags/checkout-v2 -H 'Content-Type: application/json' \
    -d '{"rolloutPercentage":50,"actor":"ops"}'
{"key":"checkout-v2", ..., "rolloutPercentage":50, ...}

$ curl -s http://localhost:3000/flags/checkout-v2/audit
[
  {"id":"...", "action":"update", "actor":"ops",  "newState": {"rolloutPercentage":50, ...}, "rollbackOf": null, ...},
  {"id":"2d566092-...", "action":"create", "actor":"seed", "newState": {"rolloutPercentage":20, ...}, "rollbackOf": null, ...}
]

$ curl -s -X POST http://localhost:3000/flags/checkout-v2/rollback/2d566092-... -H 'Content-Type: application/json' -d '{"actor":"dana"}'
{"key":"checkout-v2", ..., "rolloutPercentage":20, ...}   # restored; a new "rollback" entry was appended, nothing was edited
```

This exact flow (list → select → audit history → click "Roll back to
this") was driven end-to-end through a real headless-Chrome session against
the running dashboard + service; the rollback button's click reduced the
live flag's rollout from 50% back to 20% and the audit table grew by one
row (`rollback (of 2d566092)`), confirming the dashboard talks to the real
API rather than mock data.

## Testing

```bash
npm test
```

Real output from this repo:

```
> feature-flag-sdk@1.0.0 test
PASS test/hash.spec.ts
  rollout hash
    ✓ always returns a bucket in [0, 99]
    ✓ is deterministic: repeated calls for the same (flag, user) pair always agree
    ✓ spreads users across the bucket space rather than collapsing to one value
    ✓ respects rollout percentage boundaries
    ✓ agrees with the bucket boundary: in rollout iff bucket < percentage
    ✓ different inputs produce different raw hashes (sanity check)
Tests: 6 passed, 6 total

> service@1.0.0 test
PASS test/failsafe.e2e.spec.ts
PASS test/propagation.e2e.spec.ts
  console.log
    [propagation-latency] change -> observed by 3 SDK instances (ms): 2, 2, 2
PASS test/determinism.spec.ts
PASS test/audit-rollback.e2e.spec.ts
Tests: 6 passed, 6 total
```

What each required test actually does:

- **Determinism, across a real restart** (`service/test/determinism.spec.ts`):
  computes buckets in-process, then shells out to two independent `node`
  processes that `require()` the *compiled* hash module and compares —
  a fresh V8 isolate each time, nothing shared, closest a unit test gets to
  "restart the service."
- **Propagation latency** (`service/test/propagation.e2e.spec.ts`): connects
  3 real SDK instances (real sockets) to a running service, updates a flag,
  and measures wall-clock time from the REST write to each SDK's `update`
  event firing. Also cross-checks that the SDK's local evaluation agrees
  with the server's for the same user.
- **Fail-safe** (`service/test/failsafe.e2e.spec.ts`): spawns the compiled
  service as a real child OS process, connects an SDK, `SIGKILL`s the
  process mid-test, and asserts the SDK keeps returning the same cached
  value — plus that a never-cached key falls back to the configured
  default.
- **Audit/rollback correctness** (`service/test/audit-rollback.e2e.spec.ts`):
  creates a flag, updates it twice, rolls back to the first update, and
  asserts the pre-existing audit entries are byte-for-byte unchanged while
  a new `rollback` entry (with `rollbackOf` pointing at the restored entry)
  was appended.

## What's cut from scope

- The websocket gateway fans out to sockets on a single process. Multi-
  instance fan-out (Postgres `LISTEN/NOTIFY` or Redis pub/sub) is designed
  above but not implemented — there's no second instance or Redis/Postgres
  in this environment to verify it against.
- The Python client is illustrative: REST pull + local evaluation, no
  streaming invalidation. A full Python SDK would add a `python-socketio`
  listener mirroring `sdk/src/client.ts`.
- The dashboard is intentionally minimal (flag list, audit history,
  rollback) with no flag-creation form, auth, or pagination — flag
  creation/updates are exercised via the REST API in the tests and usage
  examples above.

## License

MIT — see [LICENSE](./LICENSE).
