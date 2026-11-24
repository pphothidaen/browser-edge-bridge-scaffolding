# Workspace instructions

## Versioning and Release Notes (Mandatory Rule)

- **Version Bumping**: Whenever any code modifications, new features, bug fixes, or UI changes are made:
  - You MUST bump the version number in `package.json` (and `manifest.json` for Chrome extension releases).
  - Use Semantic Versioning (`MAJOR.MINOR.PATCH`): increment `PATCH` for bug fixes, refinements, and UI updates; `MINOR` for new features or capabilities; `MAJOR` for breaking changes.
  - **Chrome extension source & release must stay synchronized:**
    - `packages/core/browser-bridge/extension/manifest.json` AND the deployed copy `release/chrome-extension/manifest.json` (keep the two folders 100% byte-identical via `npm run release`).
  - If any modification affects the Chrome extension or core packages, update its version and release notes immediately.
- **Release Notes / Changelog**:
  - You MUST add or update release notes in `CHANGELOG.md` (and `packages/core/CHANGELOG.md` when touching `packages/core`) for every modified version.
  - Document all user-facing changes, bug fixes, UI adjustments, and tool enhancements under standard sections (`### Added`, `### Changed`, `### Fixed`, `### Removed`).
  - Never finish a task involving code changes without bumping the version and documenting the changes in the release notes.

## Chrome extension release

- Run `npm run release` (`scripts/release.mjs`) to package the complete directory `packages/core/browser-bridge/extension` without the local Node bridge; produce both a load-unpacked directory (`release/chrome-extension/`) and a versioned credential-free ZIP (`release/browser-edge-bridge-chrome-v<version>.zip`).
- Bump the version in `manifest.json` and document changes in `CHANGELOG.md`.
- Validate `manifest.json`, all referenced scripts/pages, JavaScript syntax, and ZIP integrity before release.

## Pre-Flight Work Audit (Mandatory Before Starting New Work)

- **Audit Completed Work First**: Before starting any new task or feature, agents must:
  1. Review `plan.md` and `HANDOFF.md` to establish an accurate understanding of the latest state and completed work.
  2. Verify that previous work passed tests and has no uncommitted regressions.
  3. Verify CI/CD pipeline status and production worker health (`https://bridge.example.workers.dev/status`).
  4. Ensure `git status` is clean and properly synced.

## Blue Team & Red Team with TDD Governance

- **Test-Driven Development (TDD)**:
  - Write tests first (Red) before writing implementation code for any new feature or bug fix.
  - Implement minimum required code to make tests pass (Green).
  - Refactor while ensuring 100% test pass rate (`npm test` and `npm run test:core`). Never disable or bypass test assertions.
- **Blue Team (Defensive Gates & Hygiene)**:
  - Strict Zero-Token-Leak (GUARDRAILS G1): No hardcoded secrets in source files, docs, or configs.
  - Built extension artifacts with real tokens (`release/*-built*/`) must remain strictly in `.gitignore`.
  - Pass `gitleaks` secret scan and `npm audit --omit=dev --audit-level=high` dependency security checks.
- **Red Team (Offensive Adversarial Gates)**:
  - All changes must pass adversarial suites before release:
    - `packages/core/browser-bridge/test/red-team-chaos.test.mjs` (RED-1 to RED-5b: split-brain, upstream 403 injection, failover, epoch-replay, queue overflow).
    - `packages/core/browser-bridge/test/ssrf.test.mjs` (SSRF and network isolation).
  - CI gates (`smoke`, `blueteam`, `redteam`, `deploy`) must all pass green on GitHub Actions.
