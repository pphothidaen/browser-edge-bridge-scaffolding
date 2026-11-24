# Developer Guide & Contribution

Guidelines for maintaining and extending the browser edge bridge scaffolding.

## Architecture Guidelines

1. **Zero Upstream Credential Leakage**: Never hardcode, persist, or relay upstream credentials outside the browser runtime.
2. **Fail-Closed Semantics**: When a dependency or session is offline, return explicit standard error codes instead of mock responses.
3. **Dual-Role Token Authentication**: Validate `BRIDGE_SECRET` on extension channels and `CLIENT_API_KEY` on client channels using timing-safe comparisons.

## Running Tests

All changes must pass the full automated test suite before release:

```bash
# 1. Run root unit and integration tests
npm test

# 2. Run core bridge tests, chaos suites (RED-1 to RED-5b), and SSRF defense
npm run test:core

# 3. Run Python unit tests
python3 -m unittest discover -s . -p "test_*.py"
```

## Adding Custom Provider Adapters

To integrate a new provider:
1. Define the origin pattern and model prefix in [`bridge.config.example.json`](../bridge.config.example.json).
2. Add tab matching patterns in `packages/core/browser-bridge/extension/background.js`.
3. Implement DOM or API extraction logic in `packages/core/browser-bridge/extension/page.js`.
4. Ensure new model IDs pass through the edge routing gate in `cloudflare/worker.js`.

---

## Appendix & Related Documents (ภาคผนวกและเอกสารที่เกี่ยวข้อง)

### Appendix: Verification Command Reference

| Check | Command |
|---|---|
| Root unit & packaging tests | `npm test` |
| Worker coverage gate (80% lines / 60% branches) | `node --test --experimental-test-coverage --test-coverage-lines=80 --test-coverage-branches=60 test/test-cf-worker.test.mjs` |
| Core + RED-1..RED-5b chaos + SSRF | `npm run test:core` |
| Python root & `tests/` suites | `python3 -m unittest discover -s . -p "test_*.py" && python3 -m unittest discover -s tests -p "test_*.py"` |
| Read-only deploy probe | `node scripts/verify_deploy.mjs --url <worker-url>` |
| Secret leak scan | `gitleaks detect --source .` |

### Related Documents

- [README.md](../README.md) — Project overview, `popup.html` screenshots, and quickstart (EN/TH)
- [API-SPEC.md](API-SPEC.md) — REST & Remote MCP specification
- [CONFIGURATION.md](CONFIGURATION.md) — Configuration precedence and environment variables
- [RELEASE.md](RELEASE.md) — Reproducible release packaging and integrity gates
- [GUARDRAILS.md](../GUARDRAILS.md) — Blue Team & Red Team TDD guardrails (G0–G5)
- [GOVERNANCE.md](../GOVERNANCE.md) — Definition of Done (DoD) and CI/CD gates
- [packages/core/README.md](../packages/core/README.md) — Core workspace documentation
- [packages/core/browser-bridge/README.md](../packages/core/browser-bridge/README.md) — Local Node bridge & Chromium extension guide
