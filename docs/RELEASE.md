# Release packaging

Run `npm run release` from the repository root. The release script validates the
Chrome extension source directory, refreshes the load-unpacked copy under
`release/chrome-extension/`, and creates and validates a versioned
credential-free archive at `release/browser-edge-bridge-chrome-v<version>.zip`.

The Chrome packaging path never reads or injects a real credential. The safe
source build marker `__BRIDGE_AUTH_TOKEN__` is preserved byte-for-byte in the
distributable copy; an optional token can still be configured through the
extension's runtime storage or injected locally via `scripts/build-extension.py`
into a gitignored build directory. A release fails before artifacts are
replaced when any referenced manifest file is missing, JavaScript is invalid, an
archive is corrupt, or a credential-shaped value remains.

The script requires `node`, `zip`, and `unzip`. It writes the Chrome directory
to `release/chrome-extension/` and the Chrome archive to
`release/browser-edge-bridge-chrome-v<version>.zip`, while preserving any
gitignored local builds (`release/browser-bridge-chrome-built*`).

---

## Appendix & Related Documents (ภาคผนวกและเอกสารที่เกี่ยวข้อง)

### Appendix: Release Artifact & Version Parity Checklist

| Artifact / Manifest | Expected Path | Sync Requirement |
|---|---|---|
| Root manifest | [`package.json`](../package.json) | Matches Chrome extension version (`1.0.0`) |
| Chrome source & release | `packages/core/browser-bridge/extension/` ⇄ `release/chrome-extension/` | 100% byte-identical (`diff -ru` = 0) |
| Chrome credential-free ZIP | `release/browser-edge-bridge-chrome-v<version>.zip` | Validated by `unzip -tq` & `validateChromeExtension` |
| Local token-injected build | `release/browser-bridge-chrome-built*` | Strictly gitignored (`GUARDRAILS.md` G1.1.4) |

### Related Documents

- [README.md](../README.md) — Project overview, `popup.html` UI gallery, and quickstart (EN/TH)
- [API-SPEC.md](API-SPEC.md) — REST & Remote MCP specification
- [CONFIGURATION.md](CONFIGURATION.md) — Environment variables and secret precedence
- [DEVELOPMENT.md](DEVELOPMENT.md) — Test suites and verification commands
- [CHANGELOG.md](../CHANGELOG.md) — Root release notes (`v1.0.0`)
- [HANDOFF.md](../HANDOFF.md) — Current release state and verification record
- [GUARDRAILS.md](../GUARDRAILS.md) — Zero-Token-Leak (G1) and release security gates
- [GOVERNANCE.md](../GOVERNANCE.md) — Definition of Done (DoD) release checklist
