# Browser Edge Bridge API Specification

Single contract for the generic browser-session edge bridge scaffolding on Cloudflare Workers and Durable Objects.

## Guiding Principles

- **Zero Upstream Credential Leakage**: Upstream tokens and cookies exist only in the user's browser runtime.
- **Fail-Closed Semantics**: If no browser extension or target tab is connected, endpoints fail immediately with explicit error codes (`503`, `422`, `429`).
- **OpenAI-Compatible Envelopes**: All JSON errors match OpenAI API error formatting (`{"error": {"message": "...", "type": "...", "code": "..."}}`).
- **Multi-Provider Session Routing**: Routes requests to configured target origins (e.g., primary provider `https://target.example.local` or secondary provider `https://secondary.example.local`).

## REST Endpoints

### 1. `GET /v1/models`
Returns the list of active models registered by the extension and runtime configuration. Requires authentication (`Authorization: Bearer <CLIENT_API_KEY>` or `x-bridge-token: <BRIDGE_SECRET>`).

- Without credentials: returns `401 invalid_api_key` when worker secrets are configured, or `503 secrets_unconfigured` if `BRIDGE_SECRET` / `CLIENT_API_KEY` are missing. Use `node scripts/verify_deploy.mjs --url <worker-url>` after deploy to verify both health and secret configuration.

**Headers:**
- `Authorization: Bearer <CLIENT_API_KEY>` (or `x-bridge-token: <BRIDGE_SECRET>`)

**Response (200 OK):**
```json
{
  "object": "list",
  "data": [
    {
      "id": "model-example",
      "object": "model",
      "created": 1700000000,
      "owned_by": "custom-provider",
      "kind": "chat"
    }
  ]
}
```

### 2. `POST /v1/chat/completions`
OpenAI-compatible chat completions supporting both streaming SSE and standard JSON responses.

**Headers:**
- `Authorization: Bearer <CLIENT_API_KEY>`
- `Content-Type: application/json`

**Parameters:**
- `model`: string (e.g. `model-example`, `model-fast`, `model-reasoning`)
- `messages`: array of `{"role": "user"|"assistant"|"system", "content": string}`
- `stream`: boolean (optional, default: false)

### 3. `GET /status` and `GET /health`
Public health endpoints returning hub status, extension connectivity, and default model (return `200 OK` even before Worker secrets are configured).

**Response (200 OK):**
```json
{
  "ok": true,
  "service": "browser-edge-bridge",
  "extension": "CONNECTED",
  "extensions": 1,
  "defaultModel": "model-example"
}
```

### 4. `POST /config`
Dynamically update runtime options and default model.

**Headers:**
- `Authorization: Bearer <CLIENT_API_KEY>`

---

## Remote MCP Server (`POST /mcp`)

Conforms to JSON-RPC 2.0 and the Model Context Protocol specification. Requires `Authorization: Bearer <CLIENT_API_KEY>` (or `x-bridge-token: <BRIDGE_SECRET>`).

### Available Tools:

1. **`bridge_chat`**
   - **Parameters**: `prompt` (required), `model` (optional), `attachments` (optional array of `{ type: "image"|"file", data, filename? }`)
   - **Description**: Send a prompt (with optional attachments) through the active browser session.

2. **`bridge_list_models`**
   - **Parameters**: none
   - **Description**: List models discovered from the live browser session.

3. **`bridge_status`**
   - **Parameters**: none
   - **Description**: Return hub status, extension connectivity, and queue metrics.

4. **`web_search`**
   - **Parameters**: `query` (required), `max_results` (optional, default 5, max 10)
   - **Description**: Search the web through the active browser session with source citations.

5. **`summarize`**
   - **Parameters**: `text` (required), `style` (optional: `"short" | "concise" | "detailed" | "bullet"`)
   - **Description**: Summarize text through the active browser session.

---

## Hub ⇄ Extension Protocol

1. `GET /ext/events` (SSE): Extension consumes pending jobs pushed by the hub.
2. `POST /ext/chunk`: Extension pushes streaming text chunks to the hub.
3. `POST /ext/done`: Extension signals job completion.
4. `POST /ext/error`: Extension signals a failed job.

---

## Appendix & Related Documents (ภาคผนวกและเอกสารที่เกี่ยวข้อง)

### Appendix: Error Envelope & Status Matrix

| HTTP Status | `error.code` | Condition |
|---|---|---|
| `401` | `invalid_api_key` | Missing or invalid `Authorization: Bearer` / `x-bridge-token` |
| `422` | `model_unverified` | Requested model is not in the live/configured catalog |
| `429` | `queue_full` | FIFO queue depth reached limit |
| `503` | `secrets_unconfigured` | Neither `BRIDGE_SECRET` nor `CLIENT_API_KEY` is configured |
| `503` | `extension_disconnected` | No active extension or target tab is attached |

### Related Documents

- [README.md](../README.md) — Project overview, architecture diagram, `popup.html` UI gallery, and quickstart (EN/TH)
- [CONFIGURATION.md](CONFIGURATION.md) — Secret precedence, environment variables, and sample config schema
- [DEVELOPMENT.md](DEVELOPMENT.md) — Local testing, adversarial chaos suites, and custom provider adapters
- [RELEASE.md](RELEASE.md) — Reproducible Chrome extension ZIP packaging workflow
- [GUARDRAILS.md](../GUARDRAILS.md) — Security, Fail-Closed (G2), and Zero-Token-Leak (G1) enforcement
- [plan.md](../plan.md) — System architecture blueprint
- [HANDOFF.md](../HANDOFF.md) — Current `v1.0.0` release state and verification results
