# Chess Coach MCP

A multi-user MCP backend for chess analysis and persistent coaching context. It imports public Chess.com Rapid games, analyzes them with a local Stockfish engine, identifies critical positions, and stores classifications, recurring mistakes, notes, goals, and exercises. The connected LLM client handles the coaching conversation.

Node.js 24 LTS · TypeScript · official MCP SDK · PostgreSQL 17 · Drizzle · chess.js · Stockfish · Zod · Vitest.

## Start with Docker Compose

```bash
cp .env.example .env
openssl rand -hex 32
```

In `.env`, set `POSTGRES_PASSWORD`, `PUBLIC_URL=https://chess.your-domain.example`, contact information in `CHESSCOM_USER_AGENT`, and your client's exact callback URI in `OAUTH_REDIRECT_URIS`. PostgreSQL passwords may contain special characters: the application encodes them in the connection URL. Leave `DATABASE_URL` unset when using Compose; otherwise, it takes precedence over `POSTGRES_*` / `DB_HOST`.

```bash
docker compose up -d --build
curl --fail http://127.0.0.1:8080/readyz
```

Compose waits for PostgreSQL, applies migrations, and then starts the application. PostgreSQL uses an internal Docker network and does not publish a host port. HTTP is available at `127.0.0.1:8080`; `APP_PORT` changes the host port. Data persists in `postgres-data`. The application runs as an unprivileged user with a read-only filesystem and CPU/RAM limits.

Create a user without placing the password in process arguments or shell history:

```bash
read -rs -p 'Password (at least 12 characters): ' CHESS_USER_PASSWORD
printf '%s' "$CHESS_USER_PASSWORD" | docker compose exec -T app node dist/cli.js create-user you@example.com
unset CHESS_USER_PASSWORD
```

Repeat with a different email address to create a second user. The command returns the user's UUID. Public HTTP account registration is disabled; the operator creates accounts through the CLI.

Optional seed for the initial development player:

```bash
docker compose exec app node dist/cli.js seed USER_UUID
```

The seed checks that the public `sptm1` player exists, creates an **unverified** association, and saves the Scotch / Dragon / Grünfeld repertoire and a 1200 Rapid rating goal. Other accounts receive no preset coaching state. Running the seed again adds another goal record, so run it once.

## Existing Cloudflare Tunnel and remote MCP

The application listens on **`127.0.0.1:8080`** on the host. Change the host port through `APP_PORT` in `.env`. Point your existing host tunnel at **`http://127.0.0.1:8080`**, or the port selected with `APP_PORT`. Compose manages only the application, migrations, and PostgreSQL.

Set the public origin in `PUBLIC_URL`. The same port serves `/mcp`, `/authorize`, `/consent`, `/token`, `/register`, `/revoke`, and `/.well-known/*`. Route the entire hostname to that port so OAuth endpoints are reachable.

MCP URL for a remote client:

```text
https://chess.your-domain.example/mcp
```

Transport: **Streamable HTTP**, with stateless JSON responses. `POST /` is an alias for the same authenticated handler. Transport `GET`/`DELETE` requests return 405: the server does not require a session or a persistent SSE connection. Discovery is available at `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource`, and `/.well-known/oauth-authorization-server`.

In ChatGPT, create a connection to the MCP URL, select OAuth, copy the **exact callback URI shown in the connection interface** into `OAUTH_REDIRECT_URIS`, recreate the application (`docker compose up -d app`), and sign in with the email and password you created. The server supports DCR for public clients with `token_endpoint_auth_method=none`, Authorization Code + PKCE S256, audience/resource binding, issuer identification, single-use codes, rotating refresh tokens, and token-family revocation on replay. CIMD is not implemented yet; select DCR. See the [OpenAI authorization contract](https://developers.openai.com/plugins/build/auth) and the [MCP specification](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization).

## Exercise the end-to-end flow

Call these tools in sequence through your client:

```json
{"name":"associate_chesscom_username","arguments":{"username":"sptm1"}}
{"name":"sync_games","arguments":{"months":2}}
{"name":"get_sync_status","arguments":{"jobId":"UUID_FROM_SYNC"}}
{"name":"get_recent_games","arguments":{"limit":10}}
{"name":"analyze_recent_games","arguments":{"count":3,"depth":12,"multiPv":3}}
{"name":"get_analysis_status","arguments":{"jobId":"UUID_FROM_ANALYSIS"}}
{"name":"get_player_report","arguments":{}}
{"name":"get_critical_positions","arguments":{"gameId":"GAME_UUID"}}
{"name":"classify_game_positions","arguments":{"gameId":"GAME_UUID","provider":"mock"}}
{"name":"get_mistake_patterns","arguments":{}}
{"name":"create_training_set","arguments":{"count":5}}
{"name":"get_training_position_solution","arguments":{"exerciseId":"EXERCISE_UUID"}}
{"name":"record_training_result","arguments":{"exerciseId":"EXERCISE_UUID","idempotencyKey":"NEW_UUID_FOR_THIS_ATTEMPT","result":"partial"}}
{"name":"set_training_focus","arguments":{"focus":"defensive scan","reason":"Repeated mistakes","durationGames":10}}
{"name":"add_coaching_note","arguments":{"note":"Check opponent checks and captures before committing","reviewAfterGames":10}}
{"name":"get_coaching_context","arguments":{}}
```

`sync_games`, `analyze_game`, `analyze_recent_games`, and `classify_game_positions` return a job ID. Poll the job until its state is `succeeded`, `failed`, or `cancelled`; a nonzero `failed` count indicates partial results even when the job succeeds. `cancel_job` cancels work at the next safe boundary. Repeating a compatible analysis request reuses the result; `retry: true` creates a new job after a failure. Changing depth/MultiPV creates a separate analysis version.

A typical exercise response intentionally omits the solution:

```json
{
  "exerciseId": "opaque-uuid",
  "version": "fingerprint",
  "fen": "...",
  "sideToMove": "white",
  "promptType": "find_best_move",
  "difficulty": "medium"
}
```

Default responses omit full PGNs, complete move arrays, and raw provider responses. `get_game` accepts `includePgn` and `includeMoves`. Game lists use cursors; notes, positions, and history use limit/offset pagination. Reports are capped at 100 games and disclose truncation, incompatible analysis, and unanalyzed games.

The complete catalog of 44 tools is in [src/mcp/tools.ts](src/mcp/tools.ts). Architecture, evaluation conventions, and limitations are documented in [docs/architecture.md](docs/architecture.md).

## Semantic providers

Without API keys, use `REASONER_PROVIDER=disabled`: all objective reports remain available, and explicit classification requests use `MockReasoner` with conservative deterministic rules. Its labels are not random. LLM calls do not run automatically after engine analysis.

To use a remote provider, set `REASONER_PROVIDER=openai` + `OPENAI_API_KEY` + `REASONER_MODEL`, or `gemini` + `GEMINI_API_KEY` + `REASONER_MODEL`. The operator selects the model, not the MCP client.

For Jev directly through TypeSafe, use its [native System One API](https://docs.typesafe.ai/api):

```dotenv
REASONER_PROVIDER=jev
REASONER_MODEL=jev-latest
JEV_API_URL=https://api.typesafe.ai/v1/systemone
JEV_API_KEY=your-typesafe-api-key
```

The Jev model and URL above are defaults; only the provider and key are required. The adapter sends `state` and a typed `choice` question over the taxonomy, then validates `answers.primary`, confidence, and the complete probability distribution. Jev does not generate prose: explanation and evidence are assembled locally from the selected label and engine facts, and secondary labels remain empty. Confidence is the provider's distribution-based confidence, not a validated probability that the chess diagnosis is correct. Raw probabilities and token usage are retained with the classification. Low-confidence and unknown labels remain available to downstream consumers.

`MockReasoner` is always available for comparison. Provider requests are limited to one concurrent operation, have a timeout, and retry once for 429/5xx responses. Cache fingerprints include the context, provider, model, and prompt/schema/taxonomy versions. Raw responses and usage metadata are stored separately and omitted from ordinary MCP responses. Tests do not require real provider credentials.

## Local development without Docker

Install Node.js 24 (Node 22.16+ is also supported), PostgreSQL 17, and Stockfish.

```bash
# Debian/Ubuntu
sudo apt-get install stockfish
# macOS
brew install stockfish postgresql@17
npm ci
cp .env.example .env
# Set DATABASE_URL for your local database and PUBLIC_URL=http://localhost:8080
# macOS: use STOCKFISH_PATH=$(command -v stockfish) and save the absolute path in .env
npm run db:migrate
npm run admin -- create-user you@example.com < /path/to/password-file
npm run dev
```

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm start
npm run db:generate   # After editing schema.ts; review the SQL before applying it
npm run db:migrate
```

Example configuration for a trusted local stdio client. The environment points to a local database, and the user must already exist:

```json
{
  "mcpServers": {
    "chess-coach": {
      "command": "node",
      "args": ["/absolute/path/chess-mcp/dist/index.js", "--stdio"],
      "env": {
        "DATABASE_URL": "postgresql://USER:PASSWORD@localhost/chess",
        "STDIO_USER_ID": "YOUR_USER_UUID",
        "STOCKFISH_PATH": "/usr/games/stockfish",
        "PUBLIC_URL": "http://localhost:8080"
      }
    }
  }
}
```

All logs go to stderr. Stdio trusts the UUID supplied through the environment, **not** tool input, and is intended only for local use. HTTP and stdio cannot currently run simultaneously against the same database: a PostgreSQL advisory lock protects the single worker.

## Tests and live smoke test

Run the full verification suite in an isolated Compose project, without real accounts/API keys or published host ports:

```bash
docker compose -f compose.test.yaml run --build --rm test
docker compose -f compose.test.yaml down
```

The test database uses tmpfs and disappears when its container is removed. Integration tests clear only a database whose name ends in `_test`. **Do not point them at a working database.** Normal tests do not contact Chess.com or LLM providers; integration tests use real Stockfish and local HTTP/OAuth.

The live smoke test downloads public games for `sptm1`, analyzes the three latest Rapid games at depth 10, classifies several positions, and checks exercises, attempts, and coaching context. Everything is stored in the test database, and the temporary internal user is deleted afterward:

```bash
docker compose -f compose.test.yaml run --build --rm -e LIVE_SMOKE=1 test npm run smoke
docker compose -f compose.test.yaml down
```

Without Docker, run `TEST_DATABASE_URL=postgresql://.../chess_coach_test npm run test:integration`; also set `LIVE_SMOKE=1` for the live smoke test. `SMOKE_USERNAME` and `SMOKE_DEPTH` are optional. Recorded verification results are in [docs/validation.md](docs/validation.md).

## Operations

- `/healthz` checks the process; `/readyz` checks database connectivity. Neither exposes operational details.
- Structured logs contain safe error codes and correlation/job IDs. Tokens, passwords, PGNs, and prompts are not logged.
- Do not scale `app` to multiple replicas: the MVP uses one worker with bounded concurrency. Job state is persistent; after a restart, `running` jobs return to the queue and transition to `failed` after three interruptions.
- Shutdown waits for the current safe job boundary. Stockfish has a bounded timeout. A long external request may outlast graceful shutdown; interrupted work is recovered on restart.
- Back up PostgreSQL regularly with `pg_dump` and store backups outside the Docker volume. `docker compose down` preserves the production volume; **`down -v` deletes it**.
- Changing `POSTGRES_PASSWORD` in `.env` does not update an already initialized PostgreSQL role. Update the database password and configuration together.
- Delete an account with `docker compose exec app node dist/cli.js delete-user EMAIL --confirm`. This removes OAuth tokens and personal state while retaining shared public games.

## Troubleshooting

- **Stockfish not found:** check the absolute `STOCKFISH_PATH`, executable permissions, and binary architecture. The container includes `/usr/games/stockfish`.
- **Engine timeout:** reduce depth/MultiPV and check CPU/RAM availability. The next request restarts a failed engine; retry a failed job with `retry: true`.
- **Chess.com 403/429/5xx:** configure a descriptive User-Agent with contact information, wait, and retry synchronization. Partial failures do not advance the archive cache. The initial importer supports only `rules=chess` and `time_class=rapid`.
- **OAuth redirect rejected:** the callback in `OAUTH_REDIRECT_URIS` must match exactly. `PUBLIC_URL` is the public HTTPS origin without a path. Reconnect the client after changing the origin; tokens for the previous audience are rejected.
- **401:** the token has expired or been revoked, or its resource/scope is incorrect. Restart the OAuth flow. PKCE S256 is required.
- **Database unavailable:** when using Compose, do not set `DATABASE_URL` to a localhost address. Check `docker compose ps`, migration status, and the existing database role's password.
- **Another worker holds the lease:** stop the second HTTP/stdio instance. Do not delete jobs or bypass the lock.
