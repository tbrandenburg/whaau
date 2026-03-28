# Implementation Plan: Three-Container GitHub Webhook Listener System

Source spec: `docs/github-webhook-three-container-spec.md`

---

## Instructions

Each of the following steps have to be done by the most appropriate subagents (fallback to build/general)

---

## Step 1 — Project Scaffolding and Repository Baseline

### Step title
Scaffold project structure, `.gitignore`, and `.env.example`

### Objective
Create the exact directory layout mandated by the spec so all downstream subagents can place files in the correct locations without conflict. Establishes the `.env.example` and augments `.gitignore` with entries specific to this project.

### Owner
**Subagent 1** (Scaffolding)
Deliverable: repository tree matching the required file structure, with empty placeholder files where needed, `.env.example` populated, `.gitignore` updated.

### Dependencies
- Clean repository checkout.
- No upstream steps required.

### Scope of work
- New directories: `listener/`, `launcher/`, `runner/`, `test/`, `test/output/`
- New files: `.env.example`, `test/output/.gitkeep`
- Modified files: `.gitignore`
- No code logic in this step — only structure.

### Task breakdown
1. Create `listener/`, `launcher/`, `runner/` directories.
2. Create `test/` and `test/output/` directories.
3. Add `test/output/.gitkeep` so the directory is tracked but its contents are not.
4. Write `.env.example` with the four required variables.
5. Append to `.gitignore`:
   - `test/output/`
   - `.env`
   - `*.env` (guard against accidental commits)
   - Confirm `!.env.example` already present in existing `.gitignore` (it is — line 71).
6. Create empty placeholder files in each service directory so subagents have valid targets:
   - `listener/Dockerfile`, `listener/.dockerignore`, `listener/package.json`, `listener/index.js`
   - `launcher/Dockerfile`, `launcher/.dockerignore`, `launcher/package.json`, `launcher/index.js`
   - `runner/Dockerfile`, `runner/.dockerignore`, `runner/package.json`, `runner/index.js`
7. Create empty `docker-compose.yml` and `test/e2e.sh` as placeholders.

### Code changes to apply

**`.env.example`**
```dotenv
WEBHOOK_SECRET=replace-with-github-webhook-secret
LAUNCHER_TOKEN=replace-with-long-random-internal-token
SHARED_VOLUME_NAME=webhook-shared
RUNNER_NETWORK=webhook-internal
```

**`.gitignore` additions** (append to existing file)
```gitignore
# Project-specific
test/output/
```
Note: `.env` and `!.env.example` are already present in the existing `.gitignore`.

### Verification
- Run `ls -R` from project root and confirm all directories and placeholder files exist.
- Run `cat .env.example` and confirm four variables present.
- Run `git status` and confirm `test/output/events.ndjson` would not be tracked.

### Validation
- Tree matches spec `Required files and folders` exactly.
- `.env` is gitignored; `.env.example` is not.
- `test/output/` directory exists but its contents are gitignored.

### Acceptance criteria
- PASS: `ls listener/ launcher/ runner/ test/output/` returns without error.
- PASS: `.gitignore` causes `test/output/events.ndjson` to be ignored.
- PASS: `.env.example` contains all four required variables with placeholder values.
- FAIL: any required directory missing.

### Definition of done
- All directories and placeholder files present.
- `.env.example` committed with placeholder values only.
- `.gitignore` updated.
- No secrets in any committed file.

### Known gotchas
- The existing `.gitignore` has `.env.*` ignoring all env files — confirm `!.env.example` exception line is present (it is, line 71) before appending.
- Do not create a real `.env` file in this step.

### Outputs for orchestrator
- Updated `.gitignore`
- `.env.example`
- Full directory skeleton
- List of all placeholder files created

---

## Step 2 — Runner Service Implementation

### Step title
Implement runner: NDJSON writer job container

### Objective
Build the short-lived runner container that decodes `EVENT_B64`, appends one NDJSON line to `OUTPUT_FILE`, and exits 0. This is the innermost component and has no runtime dependencies on listener or launcher, making it safe to build and validate first.

### Owner
**Subagent 2** (Runner)
Deliverable: `runner/` directory fully implemented and buildable; image produces correct NDJSON output when run with env vars.

### Dependencies
- Step 1 complete (directory structure exists).
- Docker available on build machine.

### Scope of work
- `runner/package.json`
- `runner/index.js`
- `runner/Dockerfile`
- `runner/.dockerignore`

### Task breakdown
1. Write `runner/package.json` with `"type": "module"` or CommonJS (pick one consistently; CommonJS recommended for Node 20 compatibility without transpilation).
2. Write `runner/index.js`:
   a. Read `process.env.EVENT_B64` — exit 1 with error log if missing.
   b. Decode base64 → UTF-8 string.
   c. Parse JSON — exit 1 with error log if parse fails.
   d. Read `process.env.OUTPUT_FILE` — default to `/shared/events.ndjson`.
   e. Ensure parent directory exists (`fs.mkdirSync(dir, { recursive: true })`).
   f. Append one newline-terminated JSON line using `fs.appendFileSync`.
   g. Log success message to stdout.
   h. Process exits naturally (exit 0).
3. Write `runner/Dockerfile` as two-stage build.
4. Write `runner/.dockerignore`.

### Code changes to apply

**`runner/package.json`**
```json
{
  "name": "runner",
  "version": "1.0.0",
  "description": "Short-lived webhook event writer",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {}
}
```

**`runner/index.js`**
```js
'use strict';

const fs = require('fs');
const path = require('path');

const eventB64 = process.env.EVENT_B64;
const outputFile = process.env.OUTPUT_FILE || '/shared/events.ndjson';

if (!eventB64) {
  console.error('FATAL: EVENT_B64 is not set');
  process.exit(1);
}

let event;
try {
  event = JSON.parse(Buffer.from(eventB64, 'base64').toString('utf8'));
} catch (err) {
  console.error('FATAL: Failed to decode/parse EVENT_B64:', err.message);
  process.exit(1);
}

try {
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.appendFileSync(outputFile, JSON.stringify(event) + '\n');
  console.log('Runner: wrote event to', outputFile, '| delivery_id:', event.delivery_id);
} catch (err) {
  console.error('FATAL: Failed to write output file:', err.message);
  process.exit(1);
}
```

**`runner/Dockerfile`**
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS final
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY index.js ./
USER node
CMD ["node", "index.js"]
```

**`runner/.dockerignore`**
```
node_modules
.env
```

### Verification
1. Build image locally:
   ```bash
   docker build -t local/webhook-runner:latest ./runner
   ```
2. Test with a known event:
   ```bash
   mkdir -p /tmp/shared-test
   EVENT='{"received_at":"2026-01-01T00:00:00.000Z","delivery_id":"test-001","event_name":"push","repository":"my-org/my-repo","action":null,"payload":{}}'
   EVENT_B64=$(echo "$EVENT" | base64 -w0)
   docker run --rm \
     -e EVENT_B64="$EVENT_B64" \
     -e OUTPUT_FILE=/shared/events.ndjson \
     -v /tmp/shared-test:/shared \
     local/webhook-runner:latest
   cat /tmp/shared-test/events.ndjson
   ```
3. Assert output file contains the event JSON on one line.

### Validation
- Output line is valid JSON parseable by `jq`.
- `event_name`, `delivery_id`, `repository` fields present in output.
- Container exits 0.
- Running twice produces two lines (append, not overwrite).
- Missing `EVENT_B64`: container exits 1 with error to stderr.
- Malformed base64: container exits 1 with error to stderr.

### Acceptance criteria
- PASS: `docker run` with valid `EVENT_B64` exits 0 and writes one NDJSON line.
- PASS: Container runs as non-root (`USER node`).
- PASS: Missing `EVENT_B64` causes exit 1 with diagnostic log.
- PASS: Output file is newline-terminated.
- FAIL: Any server process running; container must exit.

### Definition of done
- `runner/` contains four files: `Dockerfile`, `.dockerignore`, `package.json`, `index.js`.
- `docker build -t local/webhook-runner:latest ./runner` succeeds.
- Manual smoke test produces correct NDJSON output.
- No exposed ports.
- No Docker socket access.

### Known gotchas
- `base64 -w0` flag needed on Linux to suppress line-wrapping; macOS uses `base64` without `-w0` — the test script must handle this.
- `fs.appendFileSync` is synchronous and sufficient here; do not introduce async complexity.
- Ensure the Dockerfile `CMD` is `["node", "index.js"]` (exec form), not shell form, so the process receives signals correctly.

### Outputs for orchestrator
- `runner/` directory (4 files)
- `docker build` success evidence
- Manual smoke test output showing correct NDJSON

---

## Step 3 — Launcher Service Implementation

### Step title
Implement launcher: private Docker-spawning HTTP service

### Objective
Build the internal-only HTTP service that authenticates the listener's requests and spawns one runner container per event using the Docker Engine API via `dockerode`.

### Owner
**Subagent 3** (Launcher)
Deliverable: `launcher/` directory fully implemented; service starts, healthcheck passes, `/run` endpoint spawns runner containers with correct config.

### Dependencies
- Step 1 complete (directory structure).
- Step 2 complete (runner image `local/webhook-runner:latest` must exist for integration smoke test).
- Docker available with socket access.

### Scope of work
- `launcher/package.json`
- `launcher/index.js`
- `launcher/Dockerfile`
- `launcher/.dockerignore`

### Task breakdown
1. Write `launcher/package.json` with `express` and `dockerode` as dependencies.
2. Write `launcher/index.js`:
   a. Import `express`, `dockerode`.
   b. Read env vars: `PORT`, `LAUNCHER_TOKEN`, `RUNNER_IMAGE`, `SHARED_VOLUME_NAME`, `RUNNER_NETWORK`.
   c. Validate all required env vars at startup — fail fast if any missing.
   d. Instantiate `new Dockerode()` (uses default socket path `/var/run/docker.sock`).
   e. Mount `express.json({ limit: '1mb' })` body parser.
   f. `GET /healthz`: return 200 `ok`.
   g. `POST /run`:
      - Check `Authorization` header is `Bearer <LAUNCHER_TOKEN>` — return 401 if not.
      - Check `Content-Type: application/json` — return 400 if not.
      - Check body is a non-null object — return 400 if not.
      - Encode event body as base64: `Buffer.from(JSON.stringify(req.body)).toString('base64')`.
      - Call `docker.createContainer(...)` with required settings.
      - Call `container.start()`.
      - Return 202.
      - Log container ID and delivery_id.
   h. Start server and log start message.
3. Write `launcher/Dockerfile` as two-stage build.
4. Write `launcher/.dockerignore`.

### Code changes to apply

**`launcher/package.json`**
```json
{
  "name": "launcher",
  "version": "1.0.0",
  "description": "Internal webhook runner launcher",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "dockerode": "^4.0.2",
    "express": "^4.18.2"
  }
}
```

**`launcher/index.js`**
```js
'use strict';

const express = require('express');
const Dockerode = require('dockerode');

const PORT = process.env.PORT || 8080;
const LAUNCHER_TOKEN = process.env.LAUNCHER_TOKEN;
const RUNNER_IMAGE = process.env.RUNNER_IMAGE || 'local/webhook-runner:latest';
const SHARED_VOLUME_NAME = process.env.SHARED_VOLUME_NAME || 'webhook-shared';
const RUNNER_NETWORK = process.env.RUNNER_NETWORK || 'webhook-internal';

if (!LAUNCHER_TOKEN) {
  console.error('FATAL: LAUNCHER_TOKEN is not set');
  process.exit(1);
}

const docker = new Dockerode();
const app = express();

app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

app.post('/run', async (req, res) => {
  const auth = req.headers['authorization'];
  if (!auth || auth !== `Bearer ${LAUNCHER_TOKEN}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({ error: 'invalid body' });
  }

  const eventB64 = Buffer.from(JSON.stringify(req.body)).toString('base64');
  const deliveryId = req.body.delivery_id || 'unknown';

  console.log(`Launcher: spawning runner for delivery_id=${deliveryId}`);

  try {
    const container = await docker.createContainer({
      Image: RUNNER_IMAGE,
      Env: [
        `EVENT_B64=${eventB64}`,
        `OUTPUT_FILE=/shared/events.ndjson`,
      ],
      HostConfig: {
        AutoRemove: true,
        Binds: [`${SHARED_VOLUME_NAME}:/shared`],
        NetworkMode: RUNNER_NETWORK,
      },
    });

    await container.start();
    console.log(`Launcher: started container ${container.id} for delivery_id=${deliveryId}`);
    return res.status(202).json({ status: 'accepted', container: container.id });
  } catch (err) {
    console.error(`Launcher: failed to start runner for delivery_id=${deliveryId}:`, err.message);
    return res.status(500).json({ error: 'runner launch failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Launcher: listening on port ${PORT}`);
});
```

**`launcher/Dockerfile`**
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS final
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY index.js ./
USER node
EXPOSE 8080
CMD ["node", "index.js"]
```

**`launcher/.dockerignore`**
```
node_modules
.env
*.test.js
test/
```

### Verification
1. Build image: `docker build -t launcher-test ./launcher`
2. Start launcher with Docker socket:
   ```bash
   docker run --rm -d \
     -e LAUNCHER_TOKEN=testtoken \
     -e RUNNER_IMAGE=local/webhook-runner:latest \
     -e SHARED_VOLUME_NAME=webhook-shared \
     -e RUNNER_NETWORK=bridge \
     -v /var/run/docker.sock:/var/run/docker.sock \
     -p 8080:8080 \
     --name launcher-test \
     launcher-test
   ```
3. Health check: `curl -s http://localhost:8080/healthz` → `ok`
4. Unauthorized request: `curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:8080/run` → `401`
5. Valid request (runner image must exist):
   ```bash
   docker volume create webhook-shared
   curl -s -X POST http://localhost:8080/run \
     -H "Authorization: Bearer testtoken" \
     -H "Content-Type: application/json" \
     -d '{"received_at":"2026-01-01T00:00:00Z","delivery_id":"manual-001","event_name":"push","repository":"my-org/my-repo","action":null,"payload":{}}'
   ```
6. Check `docker volume inspect webhook-shared` and read file content via a temp container.

### Validation
- 401 on missing/wrong token.
- 400 on missing/malformed body.
- 202 on valid request.
- Runner container is ephemeral (auto-removed after completion).
- Volume contains the written event.
- `RUNNER_IMAGE`, `SHARED_VOLUME_NAME`, `RUNNER_NETWORK` are not sourced from the request body.

### Acceptance criteria
- PASS: `GET /healthz` returns 200.
- PASS: `POST /run` with wrong token returns 401.
- PASS: `POST /run` with oversized body (>1MB) is rejected.
- PASS: `POST /run` with valid token and body starts a runner and returns 202.
- PASS: Runner container is auto-removed after writing.
- PASS: No host port exposed in final Compose config.
- FAIL: Any request body field used to choose image name or command.

### Definition of done
- `launcher/` contains four files.
- Image builds without error.
- `/healthz` and `/run` endpoints behave as specified.
- Auth rejection verified.
- At least one runner successfully spawned and NDJSON verified.

### Known gotchas
- `USER node` in the Dockerfile means the container's user is non-root, but the Docker socket bind-mount permissions may require the container user to be in the `docker` group on the host — this is a host-level concern. In most setups, the socket is world-writable or owned by a `docker` group; if launcher fails with permission denied on socket, note this as an operational requirement.
- `cap_drop: ALL` in Compose is compatible with socket access — no capabilities are needed to use a Unix socket.
- `dockerode` v4 uses promises natively; do not mix callback and promise patterns.
- The `RUNNER_NETWORK` must be the network's actual Docker name (`webhook-internal`), not the Compose service name. This is why the spec mandates `name: webhook-internal` on the network.
- `AutoRemove: true` and `container.start()` — the container may finish and be removed before the `start()` promise resolves; this is acceptable — do not treat a "no such container" post-start error as a failure.

### Outputs for orchestrator
- `launcher/` directory (4 files)
- `docker build` success evidence
- `curl` test outputs showing 401, 400, 202 responses
- Evidence of runner being spawned and NDJSON written

---

## Step 4 — Listener Service Implementation

### Step title
Implement listener: public-facing GitHub webhook verifier and forwarder

### Objective
Build the public HTTP service that verifies GitHub HMAC signatures using `@octokit/webhooks`, normalizes the event, and forwards it to the launcher. This is the only publicly exposed component.

### Owner
**Subagent 4** (Listener)
Deliverable: `listener/` directory fully implemented; signature verification works; `/webhooks/github` forwards to launcher; `/healthz` responds.

### Dependencies
- Step 1 complete (directory structure).
- A running launcher endpoint is needed only for integration smoke test (Steps 3 and 5 are upstream for full wiring; this step can implement and unit-verify the listener independently against a stub).

### Scope of work
- `listener/package.json`
- `listener/index.js`
- `listener/Dockerfile`
- `listener/.dockerignore`

### Task breakdown
1. Write `listener/package.json` with `@octokit/webhooks`, `express`, and `node-fetch` (or built-in `fetch` for Node 20) as dependencies.
2. Write `listener/index.js`:
   a. Import `express`, `@octokit/webhooks`, and fetch.
   b. Read env vars: `PORT`, `WEBHOOK_SECRET`, `LAUNCHER_URL`, `LAUNCHER_TOKEN`.
   c. Validate all required env vars at startup — fail fast if missing.
   d. Create `new Webhooks({ secret: WEBHOOK_SECRET })`.
   e. **Critical**: Use `express.raw({ type: 'application/json' })` to buffer raw body — do NOT use `express.json()` for this route. The signature must be verified against raw bytes.
   f. `GET /healthz`: return 200 `ok`.
   g. `POST /webhooks/github`:
      - Extract raw body buffer.
      - Read `x-hub-signature-256`, `x-github-event`, `x-github-delivery` headers.
      - Verify signature using `webhooks.verify(rawBody, signature)` or equivalent — return 401 if invalid.
      - Parse JSON from the raw buffer after successful verification.
      - Build normalized event object.
      - POST event to `LAUNCHER_URL` with `Authorization: Bearer <LAUNCHER_TOKEN>`.
      - Return 202 on launcher success; log error but still return 202 if launcher fails (listener should not block on launcher failure — spec says "log the error").
   h. Start server and log start message.
3. Write `listener/Dockerfile` as two-stage build.
4. Write `listener/.dockerignore`.

### Code changes to apply

**`listener/package.json`**
```json
{
  "name": "listener",
  "version": "1.0.0",
  "description": "Public-facing GitHub webhook listener",
  "main": "index.js",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {
    "@octokit/webhooks": "^13.2.7",
    "express": "^4.18.2"
  }
}
```

**`listener/index.js`**
```js
'use strict';

const express = require('express');
const { Webhooks } = require('@octokit/webhooks');

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const LAUNCHER_URL = process.env.LAUNCHER_URL;
const LAUNCHER_TOKEN = process.env.LAUNCHER_TOKEN;

if (!WEBHOOK_SECRET || !LAUNCHER_URL || !LAUNCHER_TOKEN) {
  console.error('FATAL: WEBHOOK_SECRET, LAUNCHER_URL, and LAUNCHER_TOKEN must be set');
  process.exit(1);
}

const webhooks = new Webhooks({ secret: WEBHOOK_SECRET });
const app = express();

app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// IMPORTANT: raw body required for HMAC verification
app.post('/webhooks/github', express.raw({ type: 'application/json' }), async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const eventName = req.headers['x-github-event'];
  const deliveryId = req.headers['x-github-delivery'];

  if (!signature || !eventName || !deliveryId) {
    return res.status(400).json({ error: 'missing required github headers' });
  }

  const rawBody = req.body; // Buffer
  const isValid = await webhooks.verify(rawBody, signature);

  if (!isValid) {
    console.warn(`Listener: invalid signature for delivery ${deliveryId}`);
    return res.status(401).json({ error: 'invalid signature' });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'invalid json payload' });
  }

  const event = {
    received_at: new Date().toISOString(),
    delivery_id: deliveryId,
    event_name: eventName,
    repository: payload.repository ? payload.repository.full_name : null,
    action: payload.action || null,
    payload,
  };

  console.log(`Listener: accepted delivery_id=${deliveryId} event=${eventName} repo=${event.repository}`);

  try {
    const response = await fetch(LAUNCHER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${LAUNCHER_TOKEN}`,
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      console.error(`Listener: launcher returned ${response.status} for delivery_id=${deliveryId}`);
    }
  } catch (err) {
    console.error(`Listener: failed to reach launcher for delivery_id=${deliveryId}:`, err.message);
  }

  return res.status(202).json({ status: 'accepted' });
});

app.listen(PORT, () => {
  console.log(`Listener: listening on port ${PORT}`);
});
```

**`listener/Dockerfile`**
```dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS final
WORKDIR /app
ENV NODE_ENV=production
COPY --from=builder /app/node_modules ./node_modules
COPY index.js ./
USER node
EXPOSE 3000
CMD ["node", "index.js"]
```

**`listener/.dockerignore`**
```
node_modules
.env
*.test.js
test/
```

### Verification
1. Build image: `docker build -t listener-test ./listener`
2. Start with a test secret:
   ```bash
   docker run --rm -d \
     -e WEBHOOK_SECRET=testsecret \
     -e LAUNCHER_URL=http://localhost:9999/run \
     -e LAUNCHER_TOKEN=testtoken \
     -p 3000:3000 \
     --name listener-test \
     listener-test
   ```
3. Health check: `curl -s http://localhost:3000/healthz` → `ok`
4. Invalid signature:
   ```bash
   curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:3000/webhooks/github \
     -H "Content-Type: application/json" \
     -H "X-GitHub-Event: push" \
     -H "X-GitHub-Delivery: test-001" \
     -H "X-Hub-Signature-256: sha256=invalidsignature" \
     -d '{"ref":"refs/heads/main"}'
   ```
   Expected: `401`
5. Valid signature (compute HMAC with `openssl`):
   ```bash
   PAYLOAD='{"ref":"refs/heads/main","repository":{"full_name":"my-org/my-repo"},"after":"abc123"}'
   SIG="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac 'testsecret' | awk '{print $2}')"
   curl -s -X POST http://localhost:3000/webhooks/github \
     -H "Content-Type: application/json" \
     -H "X-GitHub-Event: push" \
     -H "X-GitHub-Delivery: test-001" \
     -H "X-Hub-Signature-256: $SIG" \
     -d "$PAYLOAD"
   ```
   Expected: `202` (launcher call will fail/log since launcher is not running — that is acceptable in isolation).

### Validation
- Invalid/missing signature returns 401.
- Valid signature returns 202.
- Launcher failure does not cause listener to return non-2xx.
- `express.raw()` is used — not `express.json()` — for the webhook route.
- No Docker socket in listener container.

### Acceptance criteria
- PASS: `GET /healthz` returns 200.
- PASS: Invalid signature returns 401.
- PASS: Missing GitHub headers return 400.
- PASS: Valid signature and payload returns 202.
- PASS: Listener does not mount `docker.sock`.
- FAIL: Listener processes JSON with `express.json()` before HMAC check (would break signature verification).

### Definition of done
- `listener/` contains four files.
- Image builds without error.
- Signature verification tested both positive and negative.
- No Docker socket access.

### Known gotchas
- `@octokit/webhooks` `verify()` is async — must `await` it.
- Node 20 has built-in `fetch` — no need to add `node-fetch` as a dependency if targeting Node 20 exclusively. Confirm this in `Dockerfile` base image tag.
- `express.raw({ type: 'application/json' })` must be applied **per-route** or before `express.json()` globally. Do not register `express.json()` as global middleware or it will consume the body stream before `express.raw()` can buffer it.
- The `webhooks.verify()` method from `@octokit/webhooks` v13 takes `(body: string | Buffer, signature: string)` — pass the raw Buffer directly.
- Return 202 regardless of launcher outcome to avoid GitHub webhook retries on launcher transient failures.

### Outputs for orchestrator
- `listener/` directory (4 files)
- `docker build` success evidence
- `curl` test outputs showing 401 (invalid sig), 400 (missing headers), 202 (valid sig)

---

## Step 5 — Docker Compose Configuration

### Step title
Write `docker-compose.yml` wiring all three services with correct networks, volumes, and healthchecks

### Objective
Define the complete Compose file that binds the three services together, enforces the security model (no listener Docker socket, no exposed launcher port), establishes stable network and volume names, and makes the stack startable with a single command.

### Owner
**Subagent 5** (Compose Config)
Deliverable: `docker-compose.yml` matching the spec exactly; `docker compose up --build` starts listener and launcher; healthchecks pass.

### Dependencies
- Step 1 complete (directory structure).
- Steps 2, 3, 4 complete (service source code exists for build contexts).
- Docker Compose v2 available.

### Scope of work
- `docker-compose.yml` (primary deliverable)
- No application code changes.

### Task breakdown
1. Define `networks` block with `internal` network named `webhook-internal`.
2. Define `volumes` block with `webhook-shared` named `webhook-shared`.
3. Define `listener` service per spec.
4. Define `launcher` service per spec.
5. Define `runner` service with `profiles: [runner]` and `image: local/webhook-runner:latest`.
6. Verify: no `ports` on launcher or runner.
7. Verify: `security_opt` and `cap_drop` on listener and launcher.
8. Verify: `depends_on` on listener uses `condition: service_healthy`.
9. Add a test-friendly bind-mount consideration: the spec requires `./test/output` bound to `/shared` for the e2e test. This can be done via a `docker-compose.test.yml` override (Step 6 will handle). The base Compose file uses the named volume only.

### Code changes to apply

**`docker-compose.yml`**
```yaml
version: "3.8"

networks:
  internal:
    driver: bridge
    name: webhook-internal

volumes:
  webhook-shared:
    name: webhook-shared

services:
  listener:
    build: ./listener
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      PORT: "3000"
      WEBHOOK_SECRET: ${WEBHOOK_SECRET}
      LAUNCHER_URL: "http://launcher:8080/run"
      LAUNCHER_TOKEN: ${LAUNCHER_TOKEN}
    networks:
      - internal
    depends_on:
      launcher:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/healthz"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

  launcher:
    build: ./launcher
    restart: unless-stopped
    expose:
      - "8080"
    environment:
      PORT: "8080"
      LAUNCHER_TOKEN: ${LAUNCHER_TOKEN}
      RUNNER_IMAGE: "local/webhook-runner:latest"
      SHARED_VOLUME_NAME: "webhook-shared"
      RUNNER_NETWORK: "webhook-internal"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    networks:
      - internal
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:8080/healthz"]
      interval: 10s
      timeout: 3s
      retries: 3
      start_period: 5s
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL

  runner:
    build: ./runner
    image: local/webhook-runner:latest
    profiles:
      - runner
    networks:
      - internal
```

Notes:
- `wget` is used in healthchecks because `curl` is not installed on `node:20-alpine` by default; `wget` is.
- Alternatively, install `curl` in Dockerfiles and use `curl -f`.
- The `launcher` service has `volumes:` for the Docker socket. The named volume `webhook-shared` is not mounted into the launcher directly — the launcher passes the volume name to Dockerode, which mounts it into the runner. The launcher itself does not need `/shared` mounted.
- The `listener` does **not** have Docker socket access — no `volumes` entry with `docker.sock`.

### Verification
1. `docker compose config` — validates YAML syntax.
2. Build runner: `docker compose --profile runner build runner`
3. Start stack: `WEBHOOK_SECRET=testsecret LAUNCHER_TOKEN=testtoken docker compose up --build -d`
4. Check services healthy: `docker compose ps`
5. Listener health: `curl -s http://localhost:3000/healthz`
6. Launcher health (via internal network, not host): verify via `docker compose logs launcher`
7. Verify launcher has no host port: `docker compose port launcher 8080` should return empty/error.
8. Verify listener has no Docker socket: `docker compose exec listener ls /var/run/docker.sock 2>&1` should fail.

### Validation
- `docker compose ps` shows listener and launcher healthy.
- Launcher has no host-side port binding.
- Listener has no Docker socket.
- Runner service does not start with `docker compose up` (profile gate).
- Network name is `webhook-internal` (not a Compose-generated name).
- Volume name is `webhook-shared` (not a Compose-generated name).

### Acceptance criteria
- PASS: `docker compose --profile runner build runner` builds runner image tagged `local/webhook-runner:latest`.
- PASS: `docker compose up --build` starts listener and launcher; both show healthy.
- PASS: `docker compose port launcher 8080` returns no host binding.
- PASS: `docker inspect <listener-container>` shows no Docker socket mount.
- PASS: `docker network ls` shows `webhook-internal`.
- PASS: `docker volume ls` shows `webhook-shared`.
- FAIL: Runner auto-starts without `--profile runner`.

### Definition of done
- `docker-compose.yml` committed.
- Stack starts cleanly from a fresh environment.
- All healthchecks pass.
- Security constraints confirmed.

### Known gotchas
- `wget` vs `curl` in healthcheck: `node:20-alpine` ships with `wget` but not `curl`. Use `wget -qO- --spider` or `wget -qO-` for healthcheck; or install `curl` in the Dockerfile (`RUN apk add --no-cache curl`). Choose one and be consistent.
- `version: "3.8"` may show a deprecation warning in newer Compose V2; acceptable for this version.
- The `launcher` does not need the named volume mounted into itself — it passes the volume name as a string to Dockerode. Do not mount `webhook-shared` into the launcher service.
- Network `name:` must match exactly what is passed via `RUNNER_NETWORK` env var. Double-check both are `webhook-internal`.
- `cap_drop: ALL` does not remove file permission access — Docker socket is accessible via file system permissions.

### Outputs for orchestrator
- `docker-compose.yml`
- `docker compose config` output (no errors)
- `docker compose ps` output showing both services healthy
- Evidence that launcher has no host port and listener has no Docker socket

---

## Step 6 — End-to-End Test Script

### Step title
Write and validate `test/e2e.sh`: full-chain black-box end-to-end test

### Objective
Implement the single high-signal e2e test that proves the full chain from signed HTTP webhook to NDJSON file write. The test must be runnable from a clean checkout, must use real services (no mocks), and must exit non-zero on any failure.

### Owner
**Subagent 6** (E2E Test)
Deliverable: `test/e2e.sh` that passes from a clean environment against the stack defined by the other steps.

### Dependencies
- Steps 1–5 complete (all services implemented and Compose file present).
- `openssl` available on host.
- `curl` available on host.
- Docker and Docker Compose v2 available on host.

### Scope of work
- `test/e2e.sh`
- `docker-compose.test.yml` override (adds bind-mount of `./test/output` to allow host-side file assertion)
- `test/output/` directory (already created in Step 1, gitignored)

### Task breakdown
1. Write `docker-compose.test.yml` override:
   - Override launcher service to add bind-mount `./test/output:/shared` in addition to (or replacing) the named volume, so the runner writes to a host-accessible path.
   - This override merges with `docker-compose.yml` via `-f` flag.
2. Write `test/e2e.sh`:
   a. Set `set -euo pipefail`.
   b. Define constants: `WEBHOOK_SECRET`, `URL`, `OUTPUT_FILE`, `PAYLOAD`.
   c. Register `trap 'docker compose -f docker-compose.yml -f docker-compose.test.yml down -v' EXIT`.
   d. Build runner: `docker compose --profile runner build runner`.
   e. Start stack: `docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build`.
   f. Wait for listener healthz with timeout loop (max 30s).
   g. Truncate/clear `OUTPUT_FILE`.
   h. Compute HMAC-SHA256 signature using `openssl`.
   i. Send webhook POST with `curl`.
   j. Poll for non-empty `OUTPUT_FILE` with timeout loop (max 30s).
   k. Assert `event_name`, `repository`, `delivery_id` in output file.
   l. Print PASS message.
3. Make `test/e2e.sh` executable (`chmod +x test/e2e.sh`).

### Code changes to apply

**`docker-compose.test.yml`**
```yaml
version: "3.8"

services:
  launcher:
    volumes:
      - ./test/output:/shared

  runner:
    volumes:
      - ./test/output:/shared
```

This override replaces the named volume for the launcher and runner during tests with a host bind-mount, allowing the test script to read the output file directly.

**`test/e2e.sh`**
```bash
#!/usr/bin/env bash
set -euo pipefail

WEBHOOK_SECRET="${WEBHOOK_SECRET:-testsecret}"
LAUNCHER_TOKEN="${LAUNCHER_TOKEN:-testtoken}"
URL="http://localhost:3000/webhooks/github"
OUTPUT_FILE="./test/output/events.ndjson"
PAYLOAD='{"ref":"refs/heads/main","repository":{"full_name":"my-org/my-repo"},"after":"abc123"}'
DELIVERY_ID="test-delivery-001"
EVENT_NAME="push"
COMPOSE_FILES="-f docker-compose.yml -f docker-compose.test.yml"

echo "=== E2E Test: GitHub Webhook Three-Container Chain ==="

trap "echo '--- Cleaning up ---'; docker compose ${COMPOSE_FILES} down -v" EXIT

echo "[1/8] Building runner image..."
docker compose --profile runner build runner

echo "[2/8] Starting stack..."
WEBHOOK_SECRET="$WEBHOOK_SECRET" LAUNCHER_TOKEN="$LAUNCHER_TOKEN" \
  docker compose ${COMPOSE_FILES} up -d --build

echo "[3/8] Waiting for listener /healthz..."
TIMEOUT=30
ELAPSED=0
until curl -sf http://localhost:3000/healthz > /dev/null 2>&1; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "TIMEOUT: listener /healthz did not respond after ${TIMEOUT}s" >&2
    exit 1
  fi
done
echo "    Listener is healthy."

echo "[4/8] Clearing output file..."
mkdir -p ./test/output
: > "$OUTPUT_FILE"

echo "[5/8] Computing HMAC signature..."
SIG="sha256=$(printf '%s' "$PAYLOAD" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" | awk '{print $NF}')"
echo "    Signature: ${SIG:0:30}..."

echo "[6/8] Sending webhook POST..."
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$URL" \
  -H "Content-Type: application/json" \
  -H "X-GitHub-Event: ${EVENT_NAME}" \
  -H "X-GitHub-Delivery: ${DELIVERY_ID}" \
  -H "X-Hub-Signature-256: ${SIG}" \
  -d "$PAYLOAD")

if [ "$HTTP_STATUS" != "202" ]; then
  echo "FAIL: Expected HTTP 202, got ${HTTP_STATUS}" >&2
  exit 1
fi
echo "    Listener responded 202."

echo "[7/8] Waiting for runner to write output file..."
TIMEOUT=30
ELAPSED=0
while [ ! -s "$OUTPUT_FILE" ]; do
  sleep 1
  ELAPSED=$((ELAPSED + 1))
  if [ "$ELAPSED" -ge "$TIMEOUT" ]; then
    echo "TIMEOUT: ${OUTPUT_FILE} not written after ${TIMEOUT}s" >&2
    echo "--- Stack logs ---" >&2
    docker compose ${COMPOSE_FILES} logs >&2
    exit 1
  fi
done
echo "    Output file written."

echo "[8/8] Asserting output content..."
CONTENT=$(cat "$OUTPUT_FILE")
echo "    Content: $CONTENT"

assert_contains() {
  local label="$1"
  local needle="$2"
  if echo "$CONTENT" | grep -q "$needle"; then
    echo "    PASS: $label"
  else
    echo "    FAIL: $label — expected to find: $needle" >&2
    exit 1
  fi
}

assert_contains "event_name=push"             '"event_name":"push"'
assert_contains "repository=my-org/my-repo"  '"repository":"my-org/my-repo"'
assert_contains "delivery_id=test-delivery-001" '"delivery_id":"test-delivery-001"'

echo ""
echo "=== ALL ASSERTIONS PASSED ==="
```

### Verification
1. `chmod +x test/e2e.sh`
2. Run from project root:
   ```bash
   WEBHOOK_SECRET=testsecret LAUNCHER_TOKEN=testtoken bash test/e2e.sh
   ```
3. Expected: all 8 steps complete, "ALL ASSERTIONS PASSED" printed, exit 0.
4. Verify cleanup: after script exits, `docker compose ps` shows no running containers.

### Validation
- Test passes end-to-end from clean state.
- Test fails (exits non-zero) if: invalid signature sent, runner never writes, assertions not met.
- Volume and containers are torn down on exit (including failure paths).
- No `docker exec` used to read the file — only host bind-mount.

### Acceptance criteria
- PASS: `bash test/e2e.sh` exits 0 from a clean checkout.
- PASS: Output file contains all three required fields.
- PASS: Stack is torn down after test (both pass and fail cases).
- PASS: Timeout loop enforced (not a fixed `sleep 30`).
- FAIL: Test uses mocks for any core behavior.
- FAIL: Test passes if signature is invalid.

### Definition of done
- `test/e2e.sh` is executable and runnable.
- `docker-compose.test.yml` exists and correctly overrides volume binding.
- Test passes from a freshly cloned repo (with Docker available).
- Test output clearly shows pass/fail.

### Known gotchas
- `openssl dgst` output format differs between OpenSSL 1.x (`(stdin)= <hash>`) and 3.x (`SHA2-256(stdin)= <hash>`) — use `awk '{print $NF}'` to extract the last field robustly.
- `base64 -w0` on Linux vs `base64` on macOS: the e2e test does not use base64 directly (that is the launcher's job internally) — but if any intermediate steps do, be aware of this difference.
- On macOS, `printf '%s'` works correctly; ensure no trailing newline is added to the payload before HMAC computation. `echo "$PAYLOAD"` adds a newline — use `printf '%s'` instead.
- The `docker-compose.test.yml` override adds `./test/output:/shared` to both launcher and runner. The launcher itself does not use `/shared` — it passes the volume name to Dockerode. However, during testing the runner is spawned by the launcher using the `SHARED_VOLUME_NAME` env var. Since the test override replaces the named volume binding in the runner profile, but the runner is spawned by the launcher using the volume name `webhook-shared` — **this is a conflict**. The launched (Dockerode-spawned) runner will still use the named volume `webhook-shared`, not the bind-mount.
  
  **Resolution**: The bind-mount approach requires a `docker-compose.test.yml` that overrides `SHARED_VOLUME_NAME` in the launcher service to a host path instead. However, Dockerode `Binds` takes volume-name strings, not host paths directly for named volumes — it supports `host-path:/container-path` format too.
  
  **Correct approach**: Override `SHARED_VOLUME_NAME` in the launcher to a host absolute path during testing:
  ```yaml
  # docker-compose.test.yml
  services:
    launcher:
      environment:
        SHARED_VOLUME_NAME: "${PWD}/test/output"
  ```
  Then in `launcher/index.js`, the `Binds` entry becomes:
  ```js
  Binds: [`${SHARED_VOLUME_NAME}:/shared`],
  ```
  When `SHARED_VOLUME_NAME` is a named volume like `webhook-shared`, Dockerode treats it as a named volume. When it is an absolute path like `/home/user/project/test/output`, Dockerode treats it as a bind-mount. This is the correct mechanism.
  
  The `test/e2e.sh` must export `PWD`-based path:
  ```bash
  SHARED_VOLUME_NAME="$(pwd)/test/output" docker compose ...
  ```
  This is a **critical integration detail** — the orchestrator must reconcile this across Steps 3, 5, and 6.

### Outputs for orchestrator
- `test/e2e.sh` (executable)
- `docker-compose.test.yml`
- Full test run output showing PASS
- Evidence of stack teardown after test

---

## Step 7 — Final Integration and `.gitignore` Hardening

### Step title
Integration hardening: cross-service wiring verification, `.gitignore` completeness, and Makefile convenience targets

### Objective
Perform the final integration pass: verify all components connect correctly end-to-end, add a `Makefile` for standardized commands, and ensure the repo is clean with no accidental file tracking.

### Owner
**Subagent 7** (Integration)
Deliverable: `Makefile` with standard targets; full e2e test passing; clean `git status`; README updated.

### Dependencies
- Steps 1–6 all complete.

### Scope of work
- `Makefile` (new file)
- `README.md` (update with usage instructions)
- `.gitignore` (verify completeness)
- Run `test/e2e.sh` end-to-end as final proof

### Task breakdown
1. Write `Makefile` with targets:
   - `build`: builds all images including runner profile
   - `up`: starts listener and launcher
   - `down`: stops and removes containers and volumes
   - `test`: runs `test/e2e.sh`
   - `logs`: tails Compose logs
2. Update `README.md` with:
   - Prerequisites (Docker, Docker Compose v2, openssl, curl)
   - Setup instructions (copy `.env.example` to `.env`, fill in values)
   - Build and run instructions
   - Test instructions
   - Architecture summary (one paragraph)
3. Verify `.gitignore` covers:
   - `test/output/`
   - `.env` (not `.env.example`)
   - `node_modules/` (all subdirectories)
4. Run `git status` from clean state — no unexpected tracked files.
5. Run `test/e2e.sh` and confirm passing.

### Code changes to apply

**`Makefile`**
```makefile
.PHONY: build up down test logs

build:
	docker compose --profile runner build runner
	docker compose build

up:
	docker compose up -d --build

down:
	docker compose down -v

test:
	bash test/e2e.sh

logs:
	docker compose logs -f
```

**`README.md`** update (preserve existing content, add sections):
```markdown
## GitHub Webhook Three-Container System

A minimal, reliable system for receiving GitHub webhooks, verifying signatures, and processing events in ephemeral containers.

### Architecture

```
GitHub -> Listener (public:3000) -> Launcher (internal) -> Runner (ephemeral) -> /shared/events.ndjson
```

### Prerequisites
- Docker Engine 24+
- Docker Compose V2
- `openssl` (for e2e test)
- `curl` (for e2e test)

### Setup
```bash
cp .env.example .env
# Edit .env with your WEBHOOK_SECRET and LAUNCHER_TOKEN
```

### Build and run
```bash
make build
make up
```

### Run end-to-end test
```bash
WEBHOOK_SECRET=testsecret LAUNCHER_TOKEN=testtoken make test
```

### Stop
```bash
make down
```
```

### Verification
1. `git status` shows no untracked/unexpected files.
2. `make build` completes without error.
3. `make test` exits 0.

### Validation
- `git ls-files test/output/` returns empty (directory not tracked except `.gitkeep`).
- All service images build successfully.
- E2E test passes.
- README accurately describes setup.

### Acceptance criteria
- PASS: `make test` exits 0.
- PASS: `git status` is clean after running `make test`.
- PASS: `Makefile` targets work without errors.
- FAIL: Any sensitive value in a tracked file.

### Definition of done
- `Makefile` committed.
- `README.md` updated.
- E2E test green with evidence.
- Repo is clean.

### Known gotchas
- `make` requires tab indentation for recipe lines — not spaces.
- `docker compose down -v` removes named volumes including `webhook-shared` — this is correct for a clean teardown.

### Outputs for orchestrator
- `Makefile`
- Updated `README.md`
- Final `make test` run output showing PASS
- `git status` output confirming clean repo

---

## A. Execution Order

```
Step 1 (Scaffolding)
    │
    ├──> Step 2 (Runner)      ─┐
    ├──> Step 3 (Launcher)     │ PARALLEL
    ├──> Step 4 (Listener)     │
    └──> Step 5 (Compose)     ─┘
              │
         Step 6 (E2E Test)
              │
         Step 7 (Integration)
```

**Sequential constraints:**
- Step 1 must complete before Steps 2, 3, 4, 5 can start.
- Steps 2, 3, 4, 5 can run in parallel after Step 1.
- Step 6 must wait for Steps 2, 3, 4, and 5 to complete.
- Step 7 must wait for Step 6 to complete.

**Parallel opportunities:**
- Steps 2, 3, 4, and 5 are fully independent of each other and can be assigned to four separate subagents running simultaneously.

---

## B. Integration Responsibilities of the Orchestrator

The orchestrator must:

1. **Volume name consistency**: Confirm `SHARED_VOLUME_NAME=webhook-shared` matches the `name: webhook-shared` in `docker-compose.yml` volumes block. Any mismatch causes runner containers to create an anonymous volume instead of using the named one.

2. **Network name consistency**: Confirm `RUNNER_NETWORK=webhook-internal` matches the `name: webhook-internal` in `docker-compose.yml` networks block. The launcher uses this name when calling Dockerode — if they do not match, runner containers will fail to attach to the network.

3. **Runner image tag consistency**: Confirm `RUNNER_IMAGE=local/webhook-runner:latest` in launcher env matches the `image: local/webhook-runner:latest` in the runner Compose service. These must be identical.

4. **Test volume override reconciliation**: The critical cross-step integration concern (detailed in Step 6 Known Gotchas) — the `SHARED_VOLUME_NAME` must be overridden to a host absolute path in `docker-compose.test.yml` so Dockerode-spawned runners write to the bind-mounted host directory. The orchestrator must verify this is implemented in both `docker-compose.test.yml` and that `launcher/index.js` uses `${SHARED_VOLUME_NAME}:/shared` as the bind format (which works for both named volumes and absolute paths in Dockerode).

5. **Healthcheck tool**: Both Dockerfiles use `node:20-alpine` which has `wget` but not `curl`. The `healthcheck` in `docker-compose.yml` must use `wget`, not `curl`. If any Dockerfile adds `curl` via `RUN apk add --no-cache curl`, the healthcheck must be updated to match. Orchestrator must verify consistency.

6. **`express.raw()` verification**: The orchestrator must independently verify that `listener/index.js` uses `express.raw({ type: 'application/json' })` on the webhook route and not `express.json()`. This is the most common integration failure and will silently break HMAC verification in production while potentially passing in some test scenarios.

7. **`cap_drop: ALL` + Docker socket**: Verify launcher starts and socket is accessible with `cap_drop: ALL`. This should work in standard Docker setups but must be verified empirically.

8. **`docker-compose.test.yml` scope**: Confirm the test override does not affect production (`docker compose up`) — it must only be applied when explicitly passed via `-f docker-compose.test.yml`.

9. **Environment variable injection**: In `test/e2e.sh`, `WEBHOOK_SECRET` and `LAUNCHER_TOKEN` must be exported to the Compose environment. Verify the script exports them correctly via the Compose `-e` flag or inline env prefix.

10. **End-to-end flow tracing**: After integration, trace one full request manually:
    - `curl` → listener logs show `accepted delivery_id=X`
    - launcher logs show `spawning runner for delivery_id=X`
    - launcher logs show `started container <id>`
    - `docker logs <runner-container>` (before auto-remove) shows `Runner: wrote event to /shared/events.ndjson`
    - Host file `test/output/events.ndjson` contains the event.

---

## C. End-to-End Test Strategy

### Happy path (primary)
Executed by `test/e2e.sh`:
1. Stack starts clean.
2. Listener healthz responds.
3. HMAC-signed webhook POST sent with `push` event.
4. Listener returns 202.
5. Runner writes NDJSON line within 30 seconds.
6. File contains `event_name`, `repository`, `delivery_id`.

### Failure modes to test manually

| Scenario | How to test | Expected outcome |
|---|---|---|
| Invalid HMAC signature | Send wrong `X-Hub-Signature-256` | Listener returns 401 |
| Missing signature header | Omit `X-Hub-Signature-256` | Listener returns 400 |
| Missing event header | Omit `X-GitHub-Event` | Listener returns 400 |
| Wrong launcher token | Start launcher with different token | Listener logs error; still returns 202 to GitHub |
| Runner image not found | Remove `local/webhook-runner:latest` | Launcher logs error; 500 from launcher; listener logs launcher error |
| Oversized body | Send >1MB payload | Launcher returns 413 |
| Launcher down | Stop launcher, send webhook | Listener logs error; returns 202 |
| Concurrent events | Send 3 webhooks in rapid succession | 3 NDJSON lines written |

### Regression coverage
- After any code change to `listener/index.js`, re-run `test/e2e.sh`.
- After any change to `launcher/index.js`, re-run `test/e2e.sh`.
- After any change to `runner/index.js`, re-run `test/e2e.sh` (also rebuild runner image first).
- After any change to `docker-compose.yml`, run `docker compose config` and re-run `test/e2e.sh`.

### Edge cases
- Empty payload body: listener should reject with 400.
- Payload with no `repository` field: listener should set `repository: null` in normalized event (do not crash).
- Payload with no `action` field: normalized event should have `action: null`.
- Very large `payload` field (within 1MB limit): should process normally.

---

## D. Final Release Readiness Checklist

### Deployment readiness
- [ ] `.env` file created from `.env.example` with real secrets on target host
- [ ] `WEBHOOK_SECRET` matches the value configured in GitHub webhook settings
- [ ] `LAUNCHER_TOKEN` is a cryptographically random value (use `openssl rand -hex 32`)
- [ ] Host port 3000 is reachable from GitHub's webhook delivery IPs (or routed via reverse proxy)
- [ ] Docker socket exists at `/var/run/docker.sock` on the host
- [ ] `local/webhook-runner:latest` image built before `docker compose up`

### Security
- [ ] Listener has no Docker socket mount (verified via `docker inspect`)
- [ ] Launcher has no host port binding (verified via `docker compose port`)
- [ ] `security_opt: no-new-privileges:true` on listener and launcher
- [ ] `cap_drop: ALL` on listener and launcher
- [ ] `LAUNCHER_TOKEN` is not logged anywhere in application code
- [ ] `WEBHOOK_SECRET` is not logged anywhere in application code
- [ ] `.env` is in `.gitignore` and not committed

### Observability
- [ ] Listener logs: start, accepted/forwarded events, launcher failures
- [ ] Launcher logs: start, container launch attempts, launch failures
- [ ] Runner logs visible via `docker logs <container>` before auto-remove (or use `AutoRemove: false` temporarily for debugging)
- [ ] `GET /healthz` on listener responds 200
- [ ] `GET /healthz` on launcher responds 200 (via internal network)

### Documentation
- [ ] `README.md` includes setup, build, run, and test instructions
- [ ] `.env.example` committed with all required variables
- [ ] Spec (`docs/github-webhook-three-container-spec.md`) preserved

### Migrations
- None required — first version, no existing state.

### Operational runbook notes
- To rebuild runner after code change: `docker compose --profile runner build runner && docker compose restart launcher` (launcher does not need restart but runner image is now updated for next spawn)
- To inspect shared file: `docker run --rm -v webhook-shared:/shared alpine cat /shared/events.ndjson`
- To rotate `LAUNCHER_TOKEN`: update `.env`, `docker compose up -d` (both listener and launcher will restart)
- To rotate `WEBHOOK_SECRET`: update `.env` and GitHub webhook settings simultaneously; update order matters (update GitHub first to avoid gap)

### Post-release monitoring
- [ ] Monitor listener response codes (expect all 2xx for valid GitHub events)
- [ ] Monitor launcher logs for runner spawn failures
- [ ] Monitor `webhook-shared` volume growth (no built-in rotation in this version)
- [ ] Confirm `test/e2e.sh` passes after deployment to new environment

---

## E. Open Questions and Assumptions

### Assumptions made

1. **Node.js fetch availability**: `listener/index.js` uses the built-in `fetch` API (available in Node 20+). If the team targets Node 18, `node-fetch` must be added as a dependency.

2. **`wget` in alpine health checks**: Assumed `wget` is available in `node:20-alpine`. This is true as of Node 20 Alpine images — `wget` is included. If a future base image drops it, switch to `curl` with `RUN apk add --no-cache curl` in Dockerfiles.

3. **Dockerode v4 API**: `launcher/index.js` uses the promise-based API of `dockerode` v4. If pinned to v3, the callback API must be promisified manually.

4. **`SHARED_VOLUME_NAME` as bind path**: The test override sets `SHARED_VOLUME_NAME` to a host absolute path. Dockerode's `Binds` format accepts both `volume-name:/path` and `/host/path:/path` — this is standard Docker behavior and assumed to work correctly.

5. **`@octokit/webhooks` v13 API**: `webhooks.verify(body, signature)` returns a Promise<boolean> in v13. If using v11 or v12, the API signature differs.

6. **Single-host deployment**: This spec describes a single-host Docker Compose deployment. No Kubernetes, Swarm, or multi-host networking is addressed.

7. **GitHub webhook IP range**: Assumed the host has a public IP and port 3000 (or a reverse proxy in front of it) is reachable from GitHub's webhook delivery service.

### Open questions requiring clarification before production

1. **Reverse proxy**: Is there a reverse proxy (nginx, Caddy, Traefik) in front of the listener? If yes, TLS termination and `X-Forwarded-For` handling must be addressed. The spec does not mention HTTPS, but production deployment to `https://your-domain.com` implies TLS.

2. **Runner image update strategy**: After changes to `runner/index.js`, what is the operational procedure to update the running stack? The runner is ephemeral but the image is pinned to `local/webhook-runner:latest`. A documented rebuild-and-restart procedure is needed.

3. **Volume rotation**: `events.ndjson` grows unboundedly. Is there a rotation or archival requirement for the file? The spec explicitly defers this, but production deployments will need to address it.

4. **Concurrent event throughput**: The spec does not specify expected event volume. Dockerode's `createContainer` is async but the launcher does not queue or throttle. Under high load, many containers could spawn simultaneously. Is this acceptable?

5. **Docker socket security on host**: Granting Docker socket access to the launcher effectively grants root-equivalent access to the host. The spec acknowledges this. Confirm this is acceptable in the target environment or whether Docker-in-Docker, Podman, or a privileged namespace is preferred instead.

6. **Runner image registry**: For multi-host or CI/CD deployments, `local/webhook-runner:latest` cannot be assumed present. A registry push step would be required. Noted as a future concern.

7. **`@octokit/webhooks` exact version**: The spec mandates this library but not a version. Pin to a specific major version to avoid breaking API changes between installs.

### Missing spec information

- No specified error response body format (JSON vs plain text). Assumed JSON throughout.
- No rate limiting specified for the listener. Not implemented in this version.
- No `Content-Type` validation on the listener endpoint specified (beyond `express.raw`). Implemented defensively as 400 check.
- No timeout specified for listener→launcher HTTP call. A reasonable default (e.g., 5 seconds) should be implemented.
