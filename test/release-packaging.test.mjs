import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  cleanTrackedReleaseTargets,
  validateChromeExtension,
  validateReleaseText,
} from '../scripts/release.mjs';

function withTempDir(callback) {
  const directory = mkdtempSync(join(tmpdir(), 'browser-edge-bridge-release-test-'));
  try {
    return callback(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('release validation checks every manifest-referenced Chrome file', () => {
  withTempDir((directory) => {
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      version: '1.0.0',
      background: { service_worker: 'background.js' },
      action: { default_popup: 'popup.html' },
      content_scripts: [{ js: ['content.js'] }],
    }));
    writeFileSync(join(directory, 'background.js'), 'self.background = true;\n');
    writeFileSync(join(directory, 'content.js'), 'self.content = true;\n');
    writeFileSync(join(directory, 'popup.html'), '<!doctype html><script src="popup.js"></script>');
    writeFileSync(join(directory, 'popup.js'), 'self.popup = true;\n');

    assert.doesNotThrow(() => validateChromeExtension(directory, { expectedVersion: '1.0.0' }));
    rmSync(join(directory, 'content.js'));
    assert.throws(() => validateChromeExtension(directory), /content\.js/);
    rmSync(join(directory, 'popup.js'));
    assert.throws(() => validateChromeExtension(directory), /popup\.js/);
  });
});

test('release validation rejects unresolved token placeholders and credential-shaped text', () => {
  assert.throws(() => validateReleaseText('const token = "__BRIDGE_AUTH_TOKEN__";'), /placeholder/i);
  assert.throws(() => validateReleaseText('Authorization: Bearer abcdefghijklmnop'), /credential/i);
  assert.doesNotThrow(() => validateReleaseText('const message = "generic bridge";'));
});

test('Chrome release validation permits only the safe bridge marker', () => {
  withTempDir((directory) => {
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({
      manifest_version: 3,
      version: '1.0.0',
      background: { service_worker: 'background.js' },
    }));
    writeFileSync(join(directory, 'background.js'), "const DEFAULT_REMOTE_TOKEN = '__BRIDGE_AUTH_TOKEN__';\n");

    assert.throws(() => validateChromeExtension(directory), /placeholder/i);
    assert.doesNotThrow(() => validateChromeExtension(directory, { allowBuildPlaceholders: true }));

    writeFileSync(join(directory, 'background.js'), "const DEFAULT_REMOTE_TOKEN = '__BRIDGE_AUTH_TOKEN__';\nconst leaked = 'Bearer abcdefghijklmnop';\n");
    assert.throws(() => validateChromeExtension(directory, { allowBuildPlaceholders: true }), /credential/i);
  });
});

test('cleanTrackedReleaseTargets removes stale release artifacts while preserving gitignored local built extensions', () => {
  withTempDir((directory) => {
    mkdirSync(join(directory, 'chrome-extension'), { recursive: true });
    mkdirSync(join(directory, 'browser-bridge-chrome-built'), { recursive: true });
    writeFileSync(join(directory, 'chrome-extension', 'manifest.json'), '{}');
    writeFileSync(join(directory, 'browser-edge-bridge-chrome-v1.0.0.zip'), 'old-zip');
    writeFileSync(join(directory, 'browser-bridge-chrome-built', 'background.js'), 'dummy-token');
    writeFileSync(join(directory, 'browser-bridge-chrome-built.zip'), 'local-built-zip');

    cleanTrackedReleaseTargets(directory);

    assert.throws(() => readFileSync(join(directory, 'browser-edge-bridge-chrome-v1.0.0.zip')));
    assert.throws(() => readFileSync(join(directory, 'chrome-extension', 'manifest.json')));
    assert.equal(readFileSync(join(directory, 'browser-bridge-chrome-built', 'background.js'), 'utf8'), 'dummy-token');
    assert.equal(readFileSync(join(directory, 'browser-bridge-chrome-built.zip'), 'utf8'), 'local-built-zip');
  });
});
