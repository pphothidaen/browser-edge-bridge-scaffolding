# Contributing Guidelines

We welcome contributions to the generic browser-edge-bridge scaffolding.

## Development Workflow

1. **Keep Core Dependency-Free**: The core relay server, extension, and CLIs maintain zero external runtime dependencies.
2. **Run Tests**:
   ```bash
   npm test
   ```
   Ensure 100% test pass rate across all suites.
3. **Cross-Platform Compatibility**: Test paths and commands across POSIX and Windows environments.
4. **Security & Zero-Token-Leak**: Never commit hardcoded tokens, passwords, or personal credentials.

## Pull Requests

- Keep pull requests focused and self-contained.
- Provide clear descriptions of changes and verification steps.
- Ensure all automated checks pass.
