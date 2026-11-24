# ===============================================================
# Middle Gateway / Secretary — files
# ===============================================================
# Components:
#   packages/secretary.py         — core routing + consultant + execution + self-heal
#   packages/secretary-agent      — CLI wrapper for run / dry-run / skill commands
#   skills/                       — stored successful plans (gitignored recommended)

# Enable with:
#   python3 packages/secretary-agent run "<request>"
#   python3 packages/secretary-agent dry-run "<request>"
#   python3 packages/secretary-agent skills list
#   python3 packages/secretary-agent skills show <hash>

---

## Appendix & Related Documents (ภาคผนวกและเอกสารที่เกี่ยวข้อง)

- [Root README.md](../README.md) — Project overview, `popup.html` UI gallery, and bilingual quickstart (EN/TH)
- [docs/API-SPEC.md](../docs/API-SPEC.md) — OpenAI REST & Remote MCP endpoints consumed by the gateway
- [docs/CONFIGURATION.md](../docs/CONFIGURATION.md) — Environment variables and configuration precedence
- [GUARDRAILS.md](../GUARDRAILS.md) — Hybrid & fallback governance (G5) and Zero-Token-Leak (G1)
- [HANDOFF.md](../HANDOFF.md) — Current `v1.0.0` release status and Python test results
