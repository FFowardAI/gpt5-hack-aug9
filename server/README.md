## AI Tester Server

Local Node.js server exposing three endpoints to integrate with MCP and Maestro.

### Endpoints

- POST `/api/generate`
  - Input: `{ cursorTask?: { instructions: string, filesEdited?: string[], context?: object }, flow: { title?: string, description?: string, steps: string[] } }`
  - Output: `{ jobId: string, flowPath: string }`
  - Writes a Maestro flow YAML to `maestro-flows/<jobId>.yaml`.

- POST `/api/run`
  - Input: `{ jobId: string }`
  - Output: `{ ok: true, message: 'Maestro started' }`
  - Spawns `maestro test <flowPath>` in background, stores logs in memory.

- POST `/api/maestro/callback`
  - Input: `{ jobId: string, success: boolean, summary?: string, details?: object }`
  - Output: `{ ok: true }`
  - Updates job and forwards a notification to MCP webhook if configured.

- GET `/api/jobs/:jobId`
  - Fetch job status and logs.

- GET `/api/health`
  - Healthcheck.

### Environment

- `PORT` (default `5055`)
- `MAESTRO_BIN` (default `maestro`)
- `MAESTRO_WORKSPACE` (default repo root)
- `MAESTRO_FLOW_DIR` (default `<workspace>/maestro-flows`)
- `MCP_WEBHOOK_URL` (optional, if set server POSTs results to MCP)

### Development

```
cd server
pnpm i # or npm i / yarn
pnpm dev
```

### Example

1) Generate flow

```
curl -X POST http://localhost:5055/api/generate \
  -H 'Content-Type: application/json' \
  -d '{
    "cursorTask": { "instructions": "Verify login", "filesEdited": ["web/src/app/page.tsx"] },
    "flow": {
      "title": "Login Flow",
      "steps": [
        "launchApp",
        "tapOn: \"Login\"",
        "inputText: \"user@example.com\"",
        "assertVisible: \"Home\""
      ]
    }
  }'
```

2) Run Maestro

```
curl -X POST http://localhost:5055/api/run \
  -H 'Content-Type: application/json' \
  -d '{"jobId": "<jobId-from-previous-step>"}'
```

3) Callback (if not using auto-notify)

```
curl -X POST http://localhost:5055/api/maestro/callback \
  -H 'Content-Type: application/json' \
  -d '{"jobId": "<jobId>", "success": true, "summary": "All good"}'
```

