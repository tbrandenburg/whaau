# whaau

Github Webhook Agent Automation

## GitHub Webhook Three-Container System

A minimal, reliable system for receiving GitHub webhooks, verifying signatures, and processing events in ephemeral containers.

### Architecture

```
GitHub -> Listener (public:3000) -> Launcher (internal) -> Runner (ephemeral) -> /shared/events.ndjson
```

- **listener**: Public-facing Express service. Verifies GitHub HMAC-SHA256 signatures, normalizes events, forwards to launcher.
- **launcher**: Internal-only Express service. Authenticates requests from listener and spawns one ephemeral runner container per event via the Docker Engine API.
- **runner**: Short-lived container. Reads an event from `EVENT_B64`, appends one NDJSON line to `/shared/events.ndjson`, exits 0.

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

### Logs

```bash
make logs
```
