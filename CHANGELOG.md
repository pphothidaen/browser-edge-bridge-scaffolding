# Changelog

All notable changes to **Browser Edge Bridge Scaffolding** are documented here.

## [1.0.0] — 2026-11-24

### Added
- **P0–P3 Security & Reliability Hardening**:
  - **Client-IP Rate Limiting on Edge Worker**: Cloudflare Workers Rate Limiting binding (`env.RATE_LIMITER`) and sliding-window fallback on `/v1/chat/completions` returning `429 rate_limit_exceeded` with `Retry-After: 60`.
  - **Cloudflare KV Model Catalog Cache (`env.MODELS_KV`)**: Pre-warms and caches model catalogs with a 5-minute (300s) TTL to eliminate extension round-trips on cold starts.
  - **Proactive Tab Health Keepalive**: Chrome extension background script proactively pings attached primary and secondary tabs (`probeTabHealth`) every 30s to detect frozen or unresponsive DOM sessions before job execution.
  - **ExtHub Monotonic SessionEpoch Tracking & Replay Rejection (`409 conflict`)**: Increments `sessionEpoch` per extension connection and rejects stale wire messages and completion results.
  - **FIFO Request Queue with Backpressure (`429 queue_full`)**: Limits concurrent in-flight requests (`QUEUE_MAX_SIZE`, default 10) and handles timeouts (`QUEUE_TIMEOUT_MS`, default 60000ms).
  - **AbortSignal Cancellation Support**: Emits `event: abort` to the Chrome extension when a client aborts an in-flight stream and frees queued jobs.
  - **Constant-Time Secret Comparison**: Implemented `timingSafeEquals` using Web Crypto SHA-256 digest comparisons to prevent timing attacks.
  - **Authenticated `/registry` Route**: Enforces `CLIENT_API_KEY` token validation on `/registry` and `/registry/models` to prevent unauthenticated schema and endpoint discovery.
  - **Scoped Extension Permissions**: Scoped Chrome extension `host_permissions` and `content_scripts` to configured target origins without wildcard `<all_urls>`.
  - **Secondary Provider Fail-Closed Behavior**: Strict DOM checking and fail-closed error signaling for secondary providers without mock data fabrication.
  - **Separated Dual-Role Authentication & Popup UI**: Extension popup features a dedicated `Client API key` field (`CLIENT_API_KEY`) alongside `Bridge token` (`BRIDGE_SECRET`), properly dispatching `Authorization: Bearer` and `X-Bridge-Token` headers.
- **Read-Only Post-Deploy Verification Tool**: Added `scripts/verify_deploy.mjs` (`npm run verify:deploy`) and `test/test-verify-deploy.test.mjs` for validating deployment health, routes, and auth enforcement without mutating Durable Object state.
- **Bilingual Documentation**: Fully translated inline English and Thai documentation across `README.md` with complete architectural appendices and cross-links.
- **Automated Popup Screenshots**: Headless Chromium screenshot generation in `scripts/render_screenshots.mjs` rendering 2x retina captures of both standard and advanced popup states.
- **Expanded Test Coverage**: 73 root tests, 167 core tests (including RED-1 through RED-5b adversarial chaos suites and SSRF boundary defense), and 74 Python tests with 0 skipped and 0 warnings. Cloudflare Worker coverage exceeds the gate with 91.02% line coverage and 79.39% branch coverage.

### Changed
- **First Major Scaffolding Release (`v1.0.0`)**: Re-baselined and unified all workspace packages (`browser-edge-bridge-scaffolding`, `browser-edge-bridge-core`, `browser-bridge`, and Chrome extension) cleanly to `1.0.0` as the standalone production-ready scaffolding baseline.
- **Streamlined Packaging & Verification**: Updated `scripts/release.mjs` and CI workflows to validate and package the Chrome extension (`release/chrome-extension/` and `release/browser-edge-bridge-chrome-v1.0.0.zip`) with 100% byte-parity against source.

### Removed
- **Discontinued VS Code Extension Scope**: Completely removed `packages/vscode-extension/`, `packages/shared/`, `release/vscode-extension/`, `.vscode/`, and all `.vsix` build scripts, packaging configurations, CI steps, and documentation references.

## [0.8.0] — 2026-11-23

### Added
- Generic Project Scaffolding: Generic browser-session to OpenAI-compatible API and remote MCP relay scaffolding on Cloudflare Workers and Durable Objects.
- Dual-role authentication (`X-Bridge-Auth-Token` and `X-Hermes-Auth-Token`) with fail-closed security and timing-safe comparison.
- OpenAI-compatible endpoints (`/v1/chat/completions`, `/v1/models`) supporting streaming SSE and standard JSON responses.
- Remote MCP relay supporting `tools/list` and `tools/call` for `bridge_chat`, `bridge_list_models`, and `bridge_status`.
- Browser extension background, content, and page scripts supporting multi-provider tab routing and session isolation.
- Externalized configuration templates (`bridge.config.example.json`, `.env.example`, `cloudflare/wrangler.toml`).
- Automated verification, fallback strategies, and self-healing agent loop in middle gateway (`secretary.py`).

### Changed
- Domain-neutral symbol, route, and tool naming across worker, extension, agent scripts, and test suites.
- Generic placeholders used throughout configs, docs, and test fixtures (`https://bridge.example.workers.dev`, `https://target.example.local`).
- Hardened adversarial chaos test suites (RED-1 through RED-5b) and SSRF boundary defense suites.
