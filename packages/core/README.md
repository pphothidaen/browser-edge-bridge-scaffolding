# Browser Edge Bridge Scaffolding - Core

A generic, domain-neutral bridge scaffolding that relays authenticated browser tab sessions to OpenAI-compatible HTTP APIs and MCP JSON-RPC services.

## Overview

```text
client ──HTTP / MCP──▶ bridge server (Node.js) ──SSE / HTTP──▶ browser extension ──DOM / page──▶ authenticated web session
```

- **OpenAI-Compatible Endpoints**: `/v1/chat/completions`, `/v1/models`.
- **Remote MCP Relay**: Model Context Protocol JSON-RPC endpoints for agent orchestration.
- **Fail-Closed Operations**: Strict error propagation (`503`, `422`, `429`) when sessions disconnect.
- **Zero Credential Relaying**: Operates directly inside browser tabs using existing session state. No passwords or bearer tokens are stored or extracted.
- **Security & Hygiene**: Loopback host verification, sanitized WAF payloads, path-traversal prevention.

## Quick Start

```bash
# Start local bridge server
npm start

# Run test suite
npm test
```

## Structure

- `browser-bridge/`: Core relay server, CLI clients, and Chromium extension.
- `browser-bridge/extension/`: Browser extension manifest and content/background scripts.
- `browser-bridge/bridge/`: Node.js server, FIFO queue, Durable Object adapter, and model router.

## License

MIT

---

## Appendix & Related Documents (ภาคผนวกและเอกสารที่เกี่ยวข้อง)

- [Root README.md](../../README.md) — Full project overview, architecture, `popup.html` UI gallery, and quickstart (EN/TH)
- [browser-bridge/README.md](browser-bridge/README.md) — Local Node bridge, CLI assistant setup, and Chromium extension details
- [CHANGELOG.md](CHANGELOG.md) — Core package release history (`v1.0.0` + `v0.3.1`)
- [docs/API-SPEC.md](../../docs/API-SPEC.md) — OpenAI REST & Remote MCP contract
- [docs/DEVELOPMENT.md](../../docs/DEVELOPMENT.md) — Running core chaos (`RED-1`–`RED-5b`) and SSRF test suites
- [GUARDRAILS.md](../../GUARDRAILS.md) — Security, Fail-Closed, and Zero-Token-Leak rules
