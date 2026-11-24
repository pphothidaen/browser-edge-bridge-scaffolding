---
title: Versioning and Release Notes Mandatory Rule
trigger: always_on
---

# Mandatory Rule: Version Bumping and Release Notes Updates

Whenever any code changes, feature additions, bug fixes, or UI enhancements are made in this repository:

1. **Automatic Version Bumping**:
   - Bump the version in `package.json` (and `packages/core/browser-bridge/extension/manifest.json` + `release/chrome-extension/manifest.json` for Chrome extension releases).
   - Follow Semantic Versioning (`MAJOR.MINOR.PATCH`):
     - `PATCH` (+0.0.1): Bug fixes, UI/UX polish, styling, minor behavior adjustments.
     - `MINOR` (+0.1.0): New features, new commands, new tool support, non-breaking architectural enhancements.
     - `MAJOR` (+1.0.0): Incompatible API changes, major redesigns, breaking protocol shifts.

2. **Mandatory Release Notes / Changelog**:
   - Always update `CHANGELOG.md` (and `packages/core/CHANGELOG.md` when touching `packages/core`).
   - Group changes under clean Markdown headers:
     - `### Added` for new features or capabilities.
     - `### Changed` for modifications to existing behaviors or UI components.
     - `### Fixed` for bug fixes, error recoveries, and edge-case resolutions.
     - `### Removed` for deprecated or deleted features.
   - Ensure the changelog includes the new version header with the ISO date: `## [X.Y.Z] — YYYY-MM-DD`.

3. **Validation & Distribution**:
   - Run tests (`npm test` and `npm run test:core`) and ensure 100% test passing before releasing.
   - Re-package Chrome extension artifacts via `npm run release` (`release/chrome-extension/` + `.zip`) and verify integrity before reporting back to the user.
