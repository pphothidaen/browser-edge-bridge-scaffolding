# Project Scaffolding Plan — Browser Edge Bridge

Generic scaffolding for relaying authenticated browser sessions to OpenAI-compatible API & Remote MCP endpoints on Cloudflare Workers / Durable Objects.

## Architecture
1. **Cloudflare Worker & Durable Objects (`cloudflare/`)**
   - Durable Object (`ExtHub`): Holds job state, SSE connection to the browser extension, dynamic model registry, and runtime config.
   - Dual-role authentication (`CLIENT_API_KEY` for client requests, `BRIDGE_SECRET` for extension bridge).
   - Endpoints:
     - `POST /v1/chat/completions` (OpenAI format with SSE streaming)
     - `GET /v1/models`
     - `POST /mcp` (JSON-RPC MCP relay)
     - `GET /status`, `GET /health`
2. **Browser Extension (`packages/core/browser-bridge/extension/` and `release/chrome-extension/`)**
   - Background service worker: Handles reconnects, lease election, and multi-provider tab routing.
   - Page relay: Injected script communicating with the web application via authenticated session cookies.
   - Popup UI: Displays connection health, active providers, and usable models list.
3. **Core Local Bridge & CLI (`packages/core/browser-bridge/`)**
   - Local HTTP bridge server, streaming CLI (`chat.mjs`), and adversarial chaos / SSRF test harnesses.

---

## Appendix & Related Documents (ภาคผนวกและเอกสารที่เกี่ยวข้อง)

### Appendix: Repository Component Map

| Directory | Responsibility | Primary Documentation |
|---|---|---|
| `cloudflare/` | Cloudflare Worker & `ExtHub` Durable Object | [`docs/API-SPEC.md`](docs/API-SPEC.md) |
| `packages/core/browser-bridge/` | Local Node bridge, CLI, and MV3 Chrome extension | [`packages/core/browser-bridge/README.md`](packages/core/browser-bridge/README.md) |
| `release/` | Validated `v1.0.0` Chrome load-unpacked directory and Chrome ZIP | [`docs/RELEASE.md`](docs/RELEASE.md) |
| `scripts/` | Build, release, CI probe, DoD gate, and read-only deploy verification | [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) |

### Related Documents

- [README.md](README.md) — Project overview, `popup.html` UI screenshots, and quickstart (EN/TH)
- [HANDOFF.md](HANDOFF.md) — Current `v1.0.0` release status and test results
- [CHANGELOG.md](CHANGELOG.md) — Version history (`v1.0.0`)
- [docs/API-SPEC.md](docs/API-SPEC.md) — OpenAI REST & Remote MCP specification
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — Configuration precedence and templates
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — Local test commands and custom adapters
- [docs/RELEASE.md](docs/RELEASE.md) — Packaging and validation guide
- [LEGAL_NOTICE.md](LEGAL_NOTICE.md) — Binding legal notice, non-affiliation disclaimer & safe harbor
- [GUARDRAILS.md](GUARDRAILS.md) — Security and TDD guardrails (G0–G5)
- [GOVERNANCE.md](GOVERNANCE.md) — Definition of Done (DoD) and CI/CD governance
