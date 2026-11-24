// Unit tests for the unified config loader (Doppler → Cloudflare → .env).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, resolveValue, parseWranglerVars } from '../packages/core/browser-bridge/bridge/config.mjs';

const ctx = (over = {}) => ({
  doppler: {}, cloudflare: {}, dotenv: {}, env: {}, ...over,
});

test('doppler layer wins over cloudflare, .env and defaults', async () => {
  const v = await resolveValue('MODEL', { env: 'BRIDGE_MODEL', default: 'fallback' }, ctx({
    doppler: { BRIDGE_MODEL: 'from-doppler' },
    cloudflare: { BRIDGE_MODEL: 'from-cloudflare' },
    dotenv: { BRIDGE_MODEL: 'from-dotenv' },
  }));
  assert.equal(v, 'from-doppler');
});

test('cloudflare layer wins over .env and defaults', async () => {
  const v = await resolveValue('MODEL', { env: 'BRIDGE_MODEL', default: 'fallback' }, ctx({
    cloudflare: { BRIDGE_MODEL: 'from-cloudflare' },
    dotenv: { BRIDGE_MODEL: 'from-dotenv' },
  }));
  assert.equal(v, 'from-cloudflare');
});

test('.env layer wins over defaults but not over doppler/cloudflare', async () => {
  const v = await resolveValue('MODEL', { env: 'BRIDGE_MODEL', default: 'fallback' }, ctx({
    dotenv: { BRIDGE_MODEL: 'from-dotenv' },
  }));
  assert.equal(v, 'from-dotenv');
});

test('default applies when every layer is empty', async () => {
  const v = await resolveValue('MODEL', { env: 'BRIDGE_MODEL', default: 'fallback' }, ctx());
  assert.equal(v, 'fallback');
});

test('number and boolean coercion', async () => {
  const n = await resolveValue('PORT', { env: 'BRIDGE_PORT', type: 'number', default: 8787 }, ctx({
    dotenv: { BRIDGE_PORT: '9000' },
  }));
  assert.equal(n, 9000);
  const b = await resolveValue('ADMIN', { env: 'BRIDGE_ADMIN', type: 'boolean', default: false }, ctx({
    doppler: { BRIDGE_ADMIN: '1' },
  }));
  assert.equal(b, true);
  const bad = await resolveValue('PORT', { env: 'BRIDGE_PORT', type: 'number', default: 8787 }, ctx({
    doppler: { BRIDGE_PORT: 'not-a-number' },
  }));
  assert.equal(bad, 8787);
});

test('missing required value stays undefined (fail fast, no fabrication)', async () => {
  const v = await resolveValue('SECRET', { env: 'BRIDGE_SECRET' }, ctx());
  assert.equal(v, undefined);
});

test('parseWranglerVars reads only the [vars] block, ignoring comments', () => {
  const toml = `
name = "browser-edge-bridge"
[vars]
BRIDGE_MODEL = "model-example"
# BRIDGE_IGNORED = "no"
BRIDGE_PORT = 9000
[other]
BRIDGE_NOT_VAR = "x"
`;
  const vars = parseWranglerVars(toml);
  assert.equal(vars.BRIDGE_MODEL, 'model-example');
  assert.equal(vars.BRIDGE_PORT, '9000');
  assert.equal(vars.BRIDGE_IGNORED, undefined);
  assert.equal(vars.BRIDGE_NOT_VAR, undefined);
});

test('boolean coercion handles explicit booleans, falsey strings, and invalid values', async () => {
  assert.equal(
    await resolveValue('FLAG', { env: 'F', type: 'boolean', default: false }, ctx({ doppler: { F: true } })),
    true,
  );
  assert.equal(
    await resolveValue('FLAG', { env: 'F', type: 'boolean', default: true }, ctx({ doppler: { F: false } })),
    false,
  );
  assert.equal(
    await resolveValue('FLAG', { env: 'F', type: 'boolean', default: true }, ctx({ dotenv: { F: 'off' } })),
    false,
  );
  assert.equal(
    await resolveValue('FLAG', { env: 'F', type: 'boolean', default: true }, ctx({ dotenv: { F: 'invalid-bool' } })),
    true,
  );
  assert.equal(
    await resolveValue('LEGACY', { env: 'PRIMARY_KEY', legacyEnv: 'LEGACY_KEY', default: 'd' }, ctx({
      dotenv: { LEGACY_KEY: 'from-legacy' },
    })),
    'from-legacy',
  );
});

test('loadConfig reads cloudflare/wrangler.toml and .env with proper precedence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-config-test-'));
  try {
    mkdirSync(join(dir, 'cloudflare'), { recursive: true });
    writeFileSync(
      join(dir, 'cloudflare', 'wrangler.toml'),
      [
        'name = "browser-edge-bridge"',
        '[vars]',
        'BRIDGE_MODEL = "cf-model"',
        "BRIDGE_REGION = 'cf-region'",
        'MALFORMED_LINE_WITHOUT_EQUALS',
      ].join('\n'),
    );
    const dotenvPath = join(dir, '.env');
    writeFileSync(
      dotenvPath,
      [
        '# comment line',
        '',
        'MALFORMED_ENV_LINE',
        'BRIDGE_MODEL="dotenv-model"',
        "BRIDGE_TOKEN='quoted-token'",
        'BRIDGE_PORT=9123',
        'BRIDGE_ENABLED=false',
      ].join('\n'),
    );

    const cfg = await loadConfig(
      {
        MODEL: { env: 'BRIDGE_MODEL', default: 'default-model' },
        REGION: { env: 'BRIDGE_REGION', default: 'default-region' },
        TOKEN: { env: 'BRIDGE_TOKEN' },
        PORT: { env: 'BRIDGE_PORT', type: 'number', default: 8787 },
        ENABLED: { env: 'BRIDGE_ENABLED', type: 'boolean', default: true },
        MISSING: { env: 'BRIDGE_MISSING', default: 'fallback' },
      },
      { root: dir, dotenvPath },
    );

    assert.equal(cfg.MODEL, 'cf-model');
    assert.equal(cfg.REGION, 'cf-region');
    assert.equal(cfg.TOKEN, 'quoted-token');
    assert.equal(cfg.PORT, 9123);
    assert.equal(cfg.ENABLED, false);
    assert.equal(cfg.MISSING, 'fallback');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('loadConfig tolerates missing wrangler.toml and .env files and respects inject', async () => {
  const missingDir = join(tmpdir(), `bridge-missing-${Date.now()}`);
  const cfg = await loadConfig(
    {
      MODEL: { env: 'BRIDGE_MODEL', default: 'default-model' },
      PORT: { env: 'BRIDGE_PORT', type: 'number', default: 8787 },
    },
    {
      root: missingDir,
      dotenvPath: join(missingDir, '.env'),
      inject: { doppler: { BRIDGE_MODEL: 'injected-doppler' } },
    },
  );
  assert.equal(cfg.MODEL, 'injected-doppler');
  assert.equal(cfg.PORT, 8787);
});
