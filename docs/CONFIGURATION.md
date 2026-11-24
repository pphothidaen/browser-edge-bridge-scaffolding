# Browser Edge Bridge Configuration

Unified configuration precedence and runtime options for the browser edge bridge scaffolding.

## Configuration Precedence

1. **Doppler / Secret Manager** (production runtime secrets)
2. **Cloudflare Worker Environment Variables / Secrets** (`wrangler.toml` and `wrangler secret`)
3. **Local `.env` file** (local development overrides)
4. **Defaults in code** (`config.example.json` / code fallbacks)

## Environment Variables & Secrets

| Variable | Scope | Description | Default |
|:---|:---|:---|:---|
| `BRIDGE_SECRET` | Worker / Extension | Dual-role authentication secret for extension communication (`x-bridge-token`) | Required |
| `CLIENT_API_KEY` | Worker / API | Bearer token for API and MCP clients | Required |
| `BRIDGE_URL` | Client / Scripts | Target worker endpoint URL | `https://bridge.example.workers.dev` |
| `TARGET_ORIGIN` | Extension | Primary target application origin | `https://target.example.local` |
| `SECONDARY_ORIGIN` | Extension | Secondary target application origin | `https://secondary.example.local` |
| `DEFAULT_MODEL` | Worker / Extension | Fallback model ID when none is specified | `model-example` |
| `QUEUE_TIMEOUT_MS` | Worker | Maximum wait time for jobs in queue | `120000` |
| `QUEUE_MAX_SIZE` | Worker | Maximum pending queue depth before returning 429 | `10` |

## Sample Configuration (`config.example.json`)

```json
{
  "bridgeUrl": "https://bridge.example.workers.dev",
  "defaultModel": "model-example",
  "providers": {
    "primary": {
      "origin": "https://target.example.local",
      "modelPrefix": "primary/"
    },
    "secondary": {
      "origin": "https://secondary.example.local",
      "modelPrefix": "secondary/"
    }
  },
  "limits": {
    "queueDepth": 10,
    "chatTimeoutSeconds": 120,
    "defaultTimeoutSeconds": 30
  }
}
```

---

## Appendix & Related Documents (ภาคผนวกและเอกสารที่เกี่ยวข้อง)

### Appendix: Template & Config File Locations

| File | Tracked in Git | Purpose |
|---|---|---|
| [`bridge.config.example.json`](../bridge.config.example.json) | Yes | Neutral example for origins, providers, and queue limits |
| [`.env.example`](../.env.example) | Yes | Local development environment variable template |
| [`cloudflare/wrangler.toml`](../cloudflare/wrangler.toml) | Yes | Cloudflare Worker & Durable Object deployment config (`[vars]`) |
| `.env` / `cloudflare/.dev.vars` | No (`.gitignore`) | Local runtime secrets & dummy tokens for `wrangler dev` |

### Related Documents

- [README.md](../README.md) — Project overview, `popup.html` UI screenshots, and quickstart (EN/TH)
- [API-SPEC.md](API-SPEC.md) — REST & Remote MCP contract and authentication headers
- [DEVELOPMENT.md](DEVELOPMENT.md) — Local test execution and provider adapter integration
- [RELEASE.md](RELEASE.md) — Credential-free Chrome extension packaging
- [GUARDRAILS.md](../GUARDRAILS.md) — Zero-Token-Leak (G1) and build-time injection rules
- [HANDOFF.md](../HANDOFF.md) — Current `v1.0.0` release status and artifact inventory
