---
tags: []
type: document
---

# Spec: Three-Container GitHub Webhook Listener System with High-Signal End-to-End Test

## Goal

Implement a minimal, reliable system that:

1. receives GitHub webhooks on a public HTTP endpoint,
2. verifies the GitHub webhook signature,
3. forwards verified events internally,
4. launches a short-lived runner container per accepted event,
5. writes the event to a shared file,
6. proves the full chain with one high-signal black-box end-to-end test.

This system is intentionally small and biased toward safety and inspectability.

---

## Non-goals

This version does **not** need to:

- use a cloud queue,
- use GitHub Apps,
- persist to a database,
- deduplicate deliveries,
- implement retries beyond container/runtime defaults,
- run arbitrary Docker commands from webhook payloads,
- expose the launcher or runner publicly.

---

## High-level architecture

```text
GitHub
  -> Listener (public)
  -> Launcher (private, internal only)
  -> Runner job container (ephemeral, one per event)
  -> Shared file (NDJSON)
```

### Roles

#### 1) Listener
Public-facing HTTP service.

Responsibilities:
- expose `POST /webhooks/github`,
- verify GitHub webhook HMAC signature,
- extract event metadata,
- package a normalized event object,
- call the launcher over the private Docker network,
- return success quickly.

Must **not**:
- have Docker socket access,
- start containers directly,
- execute shell commands from webhook data.

#### 2) Launcher
Private internal HTTP service.

Responsibilities:
- expose `POST /run` on the private Docker network only,
- authenticate requests from the listener using a shared internal token,
- create one ephemeral runner container per accepted event,
- pass the event into the runner,
- mount the shared volume into the runner,
- auto-remove runner containers after completion.

Must **not**:
- be exposed on a host port,
- accept unauthenticated requests,
- accept arbitrary image names or commands from input.

#### 3) Runner
Short-lived job container.

Responsibilities:
- receive one event,
- append one line of NDJSON to the shared file,
- exit successfully.

Must **not**:
- be long-running,
- expose ports,
- require Docker socket access.

---

## Security model

### Public exposure
Only the **listener** is publicly reachable.

### Authenticity
GitHub webhook authenticity is enforced by verifying:

- `X-Hub-Signature-256`
- over the **raw request body**
- using the configured `WEBHOOK_SECRET`

### Internal trust boundary
The listener talks to the launcher over a private Docker network using:

- `Authorization: Bearer <LAUNCHER_TOKEN>`

### Docker privileges
Only the **launcher** may mount:

- `/var/run/docker.sock:/var/run/docker.sock`

The listener must never receive Docker socket access.

### Shared file access
The launcher and runner share a Docker volume at:

- `/shared`

The output file path is:

- `/shared/events.ndjson`

### Input hardening
The listener and launcher must both:

- accept only `POST` on their main endpoints,
- enforce reasonable body-size limits,
- reject malformed JSON,
- fail closed.

---

## Deployment shape

Use Docker Compose with:

- one internal bridge network,
- one named volume for shared data,
- one exposed listener port,
- no exposed launcher or runner ports.

---

## Required files and folders

```text
project-root/
├── docker-compose.yml
├── .env.example
├── listener/
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── package.json
│   └── index.js
├── launcher/
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── package.json
│   └── index.js
├── runner/
│   ├── Dockerfile
│   ├── .dockerignore
│   ├── package.json
│   └── index.js
├── test/
│   ├── e2e.sh
│   └── output/          ← bind-mount target; gitignored
└── .gitignore
```

---

## Compose spec

## `docker-compose.yml`

The Compose file must define:

### Network
- `internal` bridge network
- declare with an explicit `name: webhook-internal` in the Compose `networks` block so the name is stable regardless of the project directory name
- the launcher uses this name to attach spawned runner containers; it must not rely on Compose-generated names

### Volume
- named volume `webhook-shared` for `/shared`
- declare with an explicit `name: webhook-shared` in the Compose `volumes` block so the name is stable and the launcher can reference it by name when mounting into runner containers

### Listener service
- build from `./listener`
- restart unless stopped
- expose host port `3000:3000`
- environment:
  - `PORT=3000`
  - `WEBHOOK_SECRET`
  - `LAUNCHER_URL=http://launcher:8080/run`
  - `LAUNCHER_TOKEN`
- on `internal` network
- depends on launcher with `condition: service_healthy` (not bare `depends_on`)
- healthcheck: `GET http://localhost:3000/healthz`, interval 10s, timeout 3s, retries 3, start_period 5s
- `security_opt: [no-new-privileges:true]`
- `cap_drop: [ALL]`

### Launcher service
- build from `./launcher`
- restart unless stopped
- no public `ports`
- optional `expose: 8080`
- environment:
  - `PORT=8080`
  - `LAUNCHER_TOKEN`
  - `RUNNER_IMAGE=local/webhook-runner:latest`
  - `SHARED_VOLUME_NAME=webhook-shared`
  - `RUNNER_NETWORK=webhook-internal`
- mount Docker socket: `/var/run/docker.sock:/var/run/docker.sock`
- on `internal` network
- healthcheck: `GET http://localhost:8080/healthz`, interval 10s, timeout 3s, retries 3, start_period 5s
- `security_opt: [no-new-privileges:true]`
- `cap_drop: [ALL]`
- note: `cap_drop: ALL` is compatible with Docker socket access; no capabilities are needed beyond socket file permissions

### Runner image
- add the runner as a Compose service with `profiles: [runner]` so it is buildable via Compose but never auto-started by `docker compose up`
- the service must declare `image: local/webhook-runner:latest` so the tag is consistent with what the launcher references
- before starting the stack, the runner image must be built explicitly:
  ```
  docker compose --profile runner build runner
  ```
- this makes the runner image available to Dockerode without requiring a separate `docker build` invocation outside of Compose

---

## Listener spec

## Runtime
Node.js service using `@octokit/webhooks`.

## Dockerfile
- Base image: `node:20-alpine`
- Use a two-stage build: `node:20-alpine` as builder to install deps (`npm ci --omit=dev`), then copy `node_modules` and source into a clean final stage
- Run as the built-in non-root user: `USER node`
- Set `NODE_ENV=production`
- `.dockerignore` must exclude: `node_modules`, `.env`, `*.test.js`, `test/`

## Dependencies
Minimum:
- `@octokit/webhooks`

## Endpoints

### `POST /webhooks/github`
Behavior:
1. Read the raw body.
2. Verify GitHub webhook signature.
3. Read GitHub event headers:
   - `X-GitHub-Event`
   - `X-GitHub-Delivery`
4. Parse payload JSON only after successful verification.
5. Build a normalized event object.
6. `POST` that event object to the launcher.
7. Return `200` or `202`.

### `GET /healthz`
Return `200 OK` with a small text body such as `ok`.

## Normalized event object
The listener must send JSON to the launcher in this shape:

```json
{
  "received_at": "2026-03-28T12:34:56.000Z",
  "delivery_id": "uuid-or-gh-delivery-id",
  "event_name": "push",
  "repository": "owner/repo",
  "action": null,
  "payload": { "..." : "original github payload" }
}
```

Notes:
- `action` may be `null` if the payload has no `action`.
- `payload` should be preserved as the original parsed GitHub JSON payload.

## Behavior requirements
- The HTTP framework must buffer the **raw request body** before any JSON parsing middleware runs. Signature verification operates on the raw bytes. Any middleware that consumes the body stream or parses JSON first will corrupt the HMAC check. Use `express.raw({ type: 'application/json' })` or equivalent before passing the body to `@octokit/webhooks`.
- Signature verification must happen before forwarding.
- If launcher call fails, log the error.
- Keep the logic small and boring.
- Do not execute any action based on repo/event locally.
- Forward the event as data only.

---

## Launcher spec

## Runtime
Node.js service using Docker Engine API via Node library.

## Dockerfile
- Base image: `node:20-alpine`
- Two-stage build: builder installs deps (`npm ci --omit=dev`), final stage copies artifacts
- Run as `USER node`
- Set `NODE_ENV=production`
- `.dockerignore` must exclude: `node_modules`, `.env`, `*.test.js`, `test/`
- The Docker socket is bind-mounted at runtime; do not bake socket paths into the image

## Dependencies
Minimum:
- `dockerode`

## Endpoints

### `POST /run`
Behavior:
1. Verify `Authorization: Bearer <LAUNCHER_TOKEN>`.
2. Read JSON body with a strict size limit.
3. Start one runner container using the configured runner image.
4. Pass the event into the runner.
5. Mount the shared volume into the runner.
6. Configure runner for auto-removal.
7. Return `202 Accepted`.

### `GET /healthz`
Return `200 OK` with body `ok`.

## Spawning behavior
For each accepted request, the launcher must create a **new** runner container.

This is intentional:
- if no runner is currently running, it starts one,
- if another runner is already running, it still starts a new one,
- each event is handled independently.

## Runner input transport
Pass the normalized event into the runner using:

- `EVENT_B64=<base64 of normalized event JSON>`

Also pass:
- `OUTPUT_FILE=/shared/events.ndjson`

## Required Docker create settings
- image: `RUNNER_IMAGE`
- env vars:
  - `EVENT_B64`
  - `OUTPUT_FILE`
- host config:
  - `AutoRemove: true`
  - bind/mount shared volume to `/shared`
- network:
  - attach to configured internal network

## Constraints
- No arbitrary image names from request body.
- No arbitrary command execution.
- No shell interpolation with payload data.
- Request body max size: 1 MB is enough for this version.

---

## Runner spec

## Runtime
Small Node.js container.

## Dockerfile
- Base image: `node:20-alpine`
- Two-stage build: builder installs deps, final stage copies only what is needed
- Run as `USER node`
- Set `NODE_ENV=production`
- No `CMD` that starts a server; the entry point runs the job and exits
- `.dockerignore` must exclude: `node_modules`, `.env`

## Responsibilities
On startup:
1. read `EVENT_B64`,
2. decode base64 into JSON,
3. ensure output directory exists,
4. append one line of NDJSON to `OUTPUT_FILE`,
5. exit `0` on success.

## Output format
Each processed event must append exactly one line:

```json
{"received_at":"...","delivery_id":"...","event_name":"push","repository":"owner/repo","action":null,"payload":{...}}
```

One JSON object per line, newline-terminated.

## Constraints
- No HTTP server.
- No Docker access.
- No retries.
- No long-running loop.

---

## Environment variables

## `.env.example`

The project must include:

```dotenv
WEBHOOK_SECRET=replace-with-github-webhook-secret
LAUNCHER_TOKEN=replace-with-long-random-internal-token
SHARED_VOLUME_NAME=webhook-shared
RUNNER_NETWORK=webhook-internal
```

The real `.env` file should not be committed.

---

## Health and observability

### Listener logs
Must log:
- start message,
- accepted/forwarded event summary,
- launcher call failures.

### Launcher logs
Must log:
- start message,
- container launch attempts,
- launch failures.

### Runner logs
Must log:
- successful write message,
- fatal decode/write errors.

### Health endpoints
Required on:
- listener
- launcher

Not required on:
- runner

---

## GitHub webhook configuration

Point GitHub webhook deliveries to:

```text
https://your-domain.com/webhooks/github
```

Required webhook settings:
- content type: `application/json`
- secret: same as `WEBHOOK_SECRET`
- choose required events, for example:
  - `push`
  - `workflow_run`

For this version, all verified events may be forwarded unchanged.

---

## High-signal end-to-end test

## Goal
Prove the full happy path:

```text
signed HTTP webhook
-> listener verifies signature
-> listener calls launcher
-> launcher starts runner
-> runner writes one NDJSON line
```

## Philosophy
Only one black-box end-to-end test is required.

That test should:
- avoid mocks for core behavior,
- use a real HTTP request,
- use a real GitHub-style HMAC signature,
- assert on the final shared-file side effect.

### Why this is the right one test
If this test passes, the essential system works.

It exercises:
- HTTP ingress
- signature validation
- internal service-to-service call
- Docker-based runner launch
- volume write
- event serialization

---

## Test setup requirements

### Test script
Provide:

- `test/e2e.sh`

### Expected behavior
The test must:

1. start the stack,
2. wait for `/healthz` on the listener,
3. clear the shared output file,
4. construct a minimal webhook payload,
5. compute a valid GitHub-style `sha256=` signature with `WEBHOOK_SECRET`,
6. send the webhook to `http://localhost:3000/webhooks/github`,
7. wait for the runner to write the file,
8. assert the file contains the expected event metadata,
9. exit non-zero on any failure.

---

## Test payload

Use a minimal GitHub-style payload, for example:

```json
{
  "ref": "refs/heads/main",
  "repository": {
    "full_name": "my-org/my-repo"
  },
  "after": "abc123"
}
```

Headers:
- `X-GitHub-Event: push`
- `X-GitHub-Delivery: test-delivery-001`
- `X-Hub-Signature-256: sha256=<computed hmac>`

---

## Test assertions

The test must assert that the written NDJSON contains at least:

- `"event_name":"push"`
- `"repository":"my-org/my-repo"`
- `"delivery_id":"test-delivery-001"`

Optional stronger assertions:
- `payload.repository.full_name == "my-org/my-repo"`
- file contains exactly one line

---

## Suggested `e2e.sh` behavior outline

```bash
#!/usr/bin/env bash
set -euo pipefail

WEBHOOK_SECRET="${WEBHOOK_SECRET:-testsecret}"
URL="http://localhost:3000/webhooks/github"
OUTPUT_FILE="./test/output/events.ndjson"
PAYLOAD='{"ref":"refs/heads/main","repository":{"full_name":"my-org/my-repo"},"after":"abc123"}'

trap 'docker compose down -v' EXIT

docker compose --profile runner build runner
docker compose up -d --build

# wait for listener /healthz
# clear shared output file (truncate ./test/output/events.ndjson)
# compute HMAC with openssl dgst -sha256 -hmac "$WEBHOOK_SECRET"
# send POST with GitHub headers using curl
# poll with timeout until OUTPUT_FILE is non-empty
# grep/assert expected fields in OUTPUT_FILE
```

Implementation must inspect the shared file via a **bind-mount**:

- mount a host path (`./test/output`) to `/shared` on the launcher service in the Compose file (or via a `docker-compose.test.yml` override)
- the test reads `./test/output/events.ndjson` directly from the host without `docker exec`

The wait loop must poll with an explicit timeout rather than a fixed sleep:

```bash
TIMEOUT=30
ELAPSED=0
while [ ! -s ./test/output/events.ndjson ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "TIMEOUT: events.ndjson not written after ${TIMEOUT}s" >&2
    exit 1
  fi
done
```

The script must register a cleanup trap so the stack is always torn down on exit (already shown in the outline above):

```bash
trap 'docker compose down -v' EXIT
```

This ensures volumes and containers are removed even when the test fails or is interrupted.

---

## Acceptance criteria

The implementation is complete when all of the following are true:

1. The runner image is pre-built with `docker compose --profile runner build runner`, after which `docker compose up --build` starts listener and launcher successfully.
2. The listener exposes:
   - `GET /healthz`
   - `POST /webhooks/github`
3. The launcher exposes:
   - `GET /healthz`
   - `POST /run`
   only on the internal Docker network.
4. The listener rejects invalid GitHub signatures.
5. The listener forwards valid webhooks to the launcher.
6. The launcher starts one ephemeral runner per accepted event.
7. The runner appends one NDJSON line to `/shared/events.ndjson`.
8. The end-to-end test passes from a clean checkout.
9. The listener does **not** mount `docker.sock`.
10. Only the launcher mounts `docker.sock`.

---

## Explicit implementation constraints

Keep the first version disciplined.

### Must do
- use `@octokit/webhooks` in the listener,
- use `dockerode` in the launcher,
- write NDJSON from runner,
- keep runner ephemeral,
- keep launcher private.

### Must not do
- no queue service,
- no database,
- no arbitrary docker command execution,
- no repo-specific branching in the runner,
- no multiple webhook secrets,
- no Access, OTP, or extra auth layers for GitHub delivery,
- no Cloudflare Worker requirement for this version.

---

## Suggested implementation order

1. Build the runner image (`docker compose --profile runner build runner`) and verify it appends a static line to `/shared/events.ndjson`.
2. Implement launcher to spawn the runner and pass a static event.
3. Implement listener with `/healthz`.
4. Add GitHub webhook verification to listener.
5. Wire listener -> launcher.
6. Write the end-to-end test.
7. Run the test until green from a clean environment.

---

## Future extensions

Once this version works, likely next steps are:
- invalid-signature test,
- duplicate-delivery handling,
- per-repo filtering,
- queue instead of file,
- GitHub App-based webhook management,
- stronger audit logging,
- hosted deployment of listener.

Do not implement those yet unless needed.

---

## Summary

This spec intentionally favors:
- one public ingress,
- one private privileged service,
- one short-lived worker role,
- one observable file output,
- one strong end-to-end test.

That is the right level of complexity for a first trustworthy implementation.