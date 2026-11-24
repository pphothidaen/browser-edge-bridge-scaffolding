# Project Scaffolding Handoff — Browser Edge Bridge v1.0.0

Generic scaffolding for relaying authenticated browser sessions to OpenAI-compatible API & Remote MCP endpoints on Cloudflare Workers / Durable Objects.

## Architecture and Context

- **Cloudflare Worker and Durable Objects (`cloudflare/`)**: `ExtHub` holds the browser bridge connection, FIFO request queue with backpressure (`429 queue_full`), monotonic `sessionEpoch` tracking & replay rejection (`409 conflict`), dynamic model registry, AbortSignal cancellation, and runtime config. The worker exposes `/v1/chat/completions`, `/v1/models`, `/mcp`, `/status`, `/health`, and authenticated `/registry`.
- **Browser extension (`packages/core/browser-bridge/extension/` and `release/chrome-extension/`)**: background, content, page, popup, and offscreen scripts handle reconnects, session isolation, scoped origin permissions, fail-closed secondary provider routing, and model discovery.
- **Local bridge and CLI (`packages/core/browser-bridge/`)**: local HTTP bridge, streaming CLI, configuration, deployment helpers, and adversarial test harnesses (RED-1 to RED-5b, SSRF boundary suites).

## Current Release State

- Baseline: **v1.0.0** (clean standalone production release).
- Root package, Chrome manifests (source & release), Core package, and local bridge: **v1.0.0**.
- `packages/vscode-extension`, `packages/shared`, `.vscode/`, and all `.vsix` build/release targets have been completely removed following the cancellation of the VS Code extension scope.
- Chrome source (`packages/core/browser-bridge/extension/`) and release copy (`release/chrome-extension/`) are **100% byte-identical** (`0 diff`), preserving the safe `__BRIDGE_AUTH_TOKEN__` build placeholder.
- Root (`CHANGELOG.md`) and Core (`packages/core/CHANGELOG.md`) changelogs cleanly document `v1.0.0`.

## Completed Milestones

1. **P0–P3 Security, Reliability & Performance Hardening (`v1.0.0`)**:
   - **Monotonic SessionEpoch & Replay Rejection (`409 conflict`)**: Increments `sessionEpoch` on reconnect and rejects stale client/extension frames.
   - **FIFO Request Queue with Backpressure (`429 queue_full`)**: Protects the single browser execution tab from concurrent overload; configurable via `QUEUE_MAX_SIZE` (default 10) and `QUEUE_TIMEOUT_MS` (default 60000ms).
   - **AbortSignal Stream Cancellation**: Forwarding client disconnects to emit `event: abort` to the extension to abort stalled DOM completions.
   - **Constant-Time Secret Comparison**: Implemented `timingSafeEquals` using Web Crypto SHA-256 digest comparisons.
   - **Authenticated `/registry` Route**: Enforces `CLIENT_API_KEY` validation on `/registry` to protect endpoint catalog schema.
   - **Scoped Origin Permissions**: Eliminated wildcard `<all_urls>` from `manifest.json`; permissions strictly limited to designated target endpoints (`https://target.example.local/*`, `https://secondary.example.local/*`, Worker domain, and localhost).
   - **Secondary Provider Fail-Closed Routing**: Eliminates mock text fabrication; fails closed with explicit error diagnostics when DOM target is unavailable.
   - **Separated Dual-Role Authentication**: Popup UI provides explicit inputs for `Bridge token` (`BRIDGE_SECRET`) and `Client API key` (`CLIENT_API_KEY`).
   - **Client-IP Rate Limiting on Edge Worker**: Cloudflare Workers Rate Limiting binding (`env.RATE_LIMITER`) and sliding-window fallback on `/v1/chat/completions` returning `429 rate_limit_exceeded` with `Retry-After: 60`.
   - **Cloudflare KV Model Catalog Cache**: Pre-warms and caches model catalogs via `env.MODELS_KV` with a 5-minute (300s) TTL to reduce extension round-trips on cold starts.
   - **Extension Tab Health Keepalive**: Chrome extension background script proactively pings attached primary and secondary tabs (`probeTabHealth`) every 30s to detect frozen or unresponsive DOM sessions before job execution.
   - **ES Module Specification**: Added `cloudflare/package.json` with `"type": "module"` to eliminate Node typeless package module re-parsing warnings.

2. **VS Code Extension Discontinuation & Clean Workspace**:
   - Completely removed `packages/vscode-extension/`, `packages/shared/`, `release/vscode-extension/`, `.vscode/`, and all VSIX packaging steps.
   - Cleaned root and workspace dependencies, lockfiles, and CI configurations.

3. **Quality Gates & Test Suites (100% Passing, 0 Skipped)**:
   - Worker coverage (`test/test-cf-worker.test.mjs`): **91.02% lines / 79.39% branches** (exceeds 80% / 60% gate).
   - Root tests (`npm test`): **73/73 passing**.
   - Core tests (`npm run test:core`, including RED-1 through RED-5b adversarial chaos and SSRF tests): **167/167 passing**.
   - Python root tests (`python3 -m unittest discover -s . -p "test_*.py"`): **38/38 passing**.
   - Python `tests/` suite (`python3 -m unittest discover -s tests -p "test_*.py"`): **20/20 passing (0 skipped)**.
   - Pytest full suite (`pytest`): **74/74 passing with 0 warnings**.
   - Extension source/release parity (`diff -rq`): **0 diff / 100% byte-identical**.
   - Dependency audits (`npm audit --audit-level=high` & `--omit=dev`): **0 vulnerabilities**.
   - Syntax and smoke checks (`node --check`, `bash -n`, `python3 -m py_compile`): **0 errors / all passing**.

4. **Release Artifacts (`v1.0.0`)**:
   - Chrome extension load-unpacked directory: `release/chrome-extension/`
   - Chrome extension credential-free ZIP: `release/browser-edge-bridge-chrome-v1.0.0.zip`
   - Git baseline tag: `v1.0.0` (production baseline) synchronized with origin.

## Remaining External Actions (Require Owner CLI Login)

1. **GitHub CLI & Actions Secrets**: Run `gh auth login`, then set all 3 secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `BRIDGE_AUTH_TOKEN`), optionally set repository variable `BRIDGE_WORKER_URL`, and verify all 4 CI jobs (`smoke`, `blueteam`, `redteam`, `deploy`) on `v1.0.0`.
2. **Cloudflare Worker Runtime Secrets & Production Verification**: Run `wrangler login`, set `BRIDGE_SECRET` and `CLIENT_API_KEY` via `cd cloudflare && wrangler secret put ...`, deploy, and run `node scripts/verify_deploy.mjs --url <real-worker-url>` to confirm `GET /status` (`200`), `GET /health` (`200`), and unauthenticated `GET /v1/models` (`401 invalid_api_key`, not `503 secrets_unconfigured`).

---

## Appendix & Related Documents (ภาคผนวกและเอกสารที่เกี่ยวข้อง)

- [README.md](README.md) — Bilingual project overview (EN/TH), architecture diagram, and `popup.html` screenshots
- [plan.md](plan.md) — Scaffolding architecture blueprint and component map
- [CHANGELOG.md](CHANGELOG.md) — Root changelog (`v1.0.0`)
- [LEGAL_NOTICE.md](LEGAL_NOTICE.md) — Legal notice, non-affiliation disclaimer & safe harbor
- [packages/core/CHANGELOG.md](packages/core/CHANGELOG.md) — Core package release notes
- [docs/API-SPEC.md](docs/API-SPEC.md) — OpenAI REST & Remote MCP protocol specification
- [docs/CONFIGURATION.md](docs/CONFIGURATION.md) — Configuration precedence & secret matrix
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — Testing, verification commands, and custom adapters
- [docs/RELEASE.md](docs/RELEASE.md) — Packaging & release validation guide
- [GUARDRAILS.md](GUARDRAILS.md) — Security & TDD guardrails (G0–G5)
- [GOVERNANCE.md](GOVERNANCE.md) — Definition of Done (DoD) and CI/CD governance
