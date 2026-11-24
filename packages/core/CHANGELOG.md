# Changelog

## 1.0.0 - 2026-11-24

### Changed
- **First Major Scaffolding Release (`v1.0.0`)**: Unified `browser-edge-bridge-core`, local `browser-bridge`, and Chrome extension manifest versions cleanly to `1.0.0`.
- Implemented multi-provider tab isolation, secondary provider fail-closed checking without mock fabrication, monotonic sessionEpoch validation, and proactive tab health probing.
- Streamlined workspace packages alongside the complete removal of the discontinued VS Code extension scope.

## 0.8.0 - 2026-11-23

### Added
- Generic local browser bridge, streaming chat CLI, and adversarial chaos (RED-1 to RED-5b) and SSRF test harnesses.
- Dynamic model listing, style enumeration, and multi-provider tab hooks.
