# Validation — 2026-09-19

The repository started empty. All implementation files are new and uncommitted.

Verified in isolated Docker projects, with no production data or external publication:

- Node.js 24.21.0, PostgreSQL 17, Stockfish 15.1 from Debian Bookworm.
- Reproducible `npm ci`; `npm audit` and `npm audit --omit=dev`: **0 vulnerabilities**.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed.
- Unit suite: **20 passed**. PGN/clock/increment/variation parsing, FEN/move normalization, fingerprints, opening/phase heuristics, CP/player perspective, explicit mate-zero winner, grouped sequences, deterministic features/classification, taxonomy validation, evidence/trends, answer projection and MCP limits; process tests cover UCI reuse, serialization, timeout/restart and crashes.
- PostgreSQL integration suite: **11 passed**, including clean stdio protocol and EOF shutdown. migrations, immutable shared games, conditional incremental sync, compatible analysis reuse and separate versions, actual UCI analysis, classifications, patterns, period comparison, training persistence/idempotency, composite owner constraints, coaching/job isolation, interrupted-job recovery, association deletion, actual HTTP OAuth/PKCE/token rotation/replay and MCP SDK client calls.
- Production Dockerfile/Compose chain tested with a temporary override and separate tmpfs database: PostgreSQL healthy → migration exit 0 → app healthy. `/readyz` returned 200; unauthenticated `/mcp` returned 401 with protected-resource discovery challenge. Application bound only to `127.0.0.1:18876` for this test; PostgreSQL had no published host port.
- Cloudflare Tunnel is managed separately on the host. Compose exposes the application on `127.0.0.1:${APP_PORT:-8080}`; no tunnel container or token is configured here. The external route was not exercised.

## Real-data smoke

Command (explicit network opt-in, isolated test DB):

```bash
docker compose -f compose.test.yaml run --rm -e LIVE_SMOKE=1 test npm run smoke
```

Live Chess.com request for `sptm1` succeeded. Imported **879 standard Rapid games** from nine available archives within the requested 12-month window, **0 failed imports**. Analyzed **3 latest games** using **Stockfish 15.1, depth 10, MultiPV 3**. Created **3 exercises**, retrieved a solution separately, recorded an append-only attempt and retrieved a coaching context containing a saved note/focus. Semantic classification used the deterministic reasoner; no paid provider calls were made. The temporary internal smoke user was removed afterward.

The measured mean CPL was 60.94 for this three-game smoke sample. This is a test observation, not a reliable player assessment; the response correctly reported a small sample, an at-most-100-game report window and unanalyzed games.

## Practical limits of this verification

No real ChatGPT UI connection, public Cloudflare route, HA deployment or load test was exercised. The OAuth contract was verified by HTTP and the official MCP client. External provider verification is limited to the Jev smoke below. The shipped service is a working initial vertical slice; optional/advanced gaps are recorded in `architecture.md`.

The host runs Node 23.7.0, outside the supported LTS versions. Sandbox process behavior also suppressed spawned Node output during a local mock-engine test; Docker/Node 24 is the authoritative test environment. npm 10 hit `edgesOut` while upgrading Vitest; regenerating the lockfile in an isolated directory with npm 11 and then running ordinary `npm ci` resolved it. Vitest is pinned to 4.1.11; the dev esbuild override is validated by migration generation, tests and build.

## Native Jev follow-up

Replaced the assumed Chat Completions gateway with the documented TypeSafe System One contract at `https://api.typesafe.ai/v1/systemone`. Local typecheck, lint, build and **31 unit tests** passed after the change. New tests cover native request/response mapping, defaults, required credentials, unknown labels, confidence, rounded probability distributions, invalid responses, bounded overload retry and non-retried authentication failures. The database integration suite and container deployment were not rerun for this adapter/configuration change.

Live requests with a synthetic Fool's Mate position and fixture engine facts returned HTTP 200. `jev-latest` resolved to `jev-1.13.0`; the final adapter call returned `engine_only` at confidence `0.67`, with 2,358 input tokens and 505 output tokens. Live probabilities were rounded and did not sum to exactly one, so validation allows the rounding bound per option while retaining the original values. This verifies authentication and protocol compatibility, not chess classification accuracy or confidence calibration. No user games or database writes were involved.

The operator's environment passed configuration parsing and Compose resolution: private database credentials agree and the application publishes host loopback port 6799. Secrets were not printed or committed. No running services were restarted.
