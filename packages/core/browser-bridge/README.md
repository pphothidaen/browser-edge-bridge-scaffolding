# Browser Bridge Core

A lightweight, zero-dependency Node.js bridge and Chromium extension that exposes an authenticated browser tab session as an OpenAI-compatible HTTP service.

```text
client ──HTTP──▶ bridge server (Node.js, zero external dependencies)
                    │  SSE: jobs out, POST: deltas back
                    ▼
                 extension service worker
                    │  chrome.runtime
                    ▼
                 target session tab (e.g. https://target.example.local)
```

## Security & Isolation

- **Zero Credential Relaying**: Requests execute directly within the page context using the browser's existing authenticated cookies. The bridge server never handles or stores upstream session credentials.
- **Fail-Closed Operations**: When an extension or tab is disconnected, the server fails closed with standard HTTP errors (`503`, `422`, `429`).
- **Sanitized Payloads**: Automatic neutralization of edge WAF regex signatures and strict path-traversal guards.

## Quick Start

```bash
# Start local bridge server
npm start

# Run unit tests and chaos test suites
npm test
```

## Extensions Setup

1. Open `chrome://extensions` in Chromium.
2. Enable **Developer mode**.
3. Click **Load unpacked** and select `extension/`.
4. Open the target session tab in the browser (e.g. `https://target.example.local`).
5. Verify the extension popup shows **Connected**.

## Assistant Setup

Set the assistant instructions (max 1000 characters — this is 958):

```
You help the user work on a code project on their computer. You cannot open the files; the user runs each action you write and pastes the result back. Never say you lack tools or ask them to paste files — just write actions.

Write actions on their own lines, exactly like this:

NEED dir .
NEED file src/app.ts
SEARCH text to find anywhere in the project
EDIT src/app.ts
FIND
the exact current lines
NEW
the replacement
END
CREATE notes.md
file contents
END
DONE one sentence summary when finished

Rules. Write prose in the user's language; keep action lines exactly as shown. Every reply needs an action or DONE. Never ask questions — pick a reasonable reading and begin. SEARCH to find where something is instead of reading every file; read a file before you EDIT it. Line numbers on the left are display only — never put them in FIND, copy the code exactly. Keep shortened hostnames like LCLHST as written. Write DONE only at the end, never with a NEED.
```

## Testing

```bash
node scripts/test.mjs
```

## License

MIT

---

## Appendix & Related Documents (ภาคผนวกและเอกสารที่เกี่ยวข้อง)

- [Root README.md](../../../README.md) — Full scaffolding overview, `popup.html` screenshots, and bilingual quickstart (EN/TH)
- [Core README.md](../README.md) — Core workspace overview and directory structure
- [docs/API-SPEC.md](../../../docs/API-SPEC.md) — OpenAI REST & Remote MCP specification
- [docs/CONFIGURATION.md](../../../docs/CONFIGURATION.md) — Configuration precedence and environment templates
- [docs/DEVELOPMENT.md](../../../docs/DEVELOPMENT.md) — Custom provider adapters and adversarial test suites
- [docs/RELEASE.md](../../../docs/RELEASE.md) — Chrome extension packaging and integrity checks
- [GUARDRAILS.md](../../../GUARDRAILS.md) — Zero-Token-Leak (G1) and Fail-Closed (G2) guardrails
