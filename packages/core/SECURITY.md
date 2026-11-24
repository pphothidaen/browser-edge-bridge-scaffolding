# Security Policy

This scaffolding relays authenticated browser tab sessions to OpenAI-compatible HTTP endpoints and MCP JSON-RPC services.

## Architecture & Trust Model

1. **Zero Credential Relaying**: The bridge does not intercept, store, or forward login credentials or session tokens. Requests execute within the browser tab context.
2. **Fail-Closed Operations**: Disconnected or invalid sessions fail closed immediately (`503 disconnected`, `422 unprocessable`, `429 queue_full`).
3. **CORS & Host Validation**: By default, CORS is disabled (`BRIDGE_CORS_ORIGIN`). The server validates the HTTP `Host` header against loopback addresses (`127.0.0.1`, `localhost`, `[::1]`) to prevent DNS rebinding attacks.
4. **Administrative Routes**: Container management routes (`/restart`, `/tab/reload`, `/logs`) are disabled unless explicitly enabled via `BRIDGE_ADMIN=1`.
5. **Path Traversal Protection**: File and log paths are strictly sanitized against path traversal attempts.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it privately via GitHub Security Advisories or to the repository maintainers.
