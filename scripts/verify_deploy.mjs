#!/usr/bin/env node
/**
 * verify_deploy.mjs — Read-only post-deploy & local verification gate for Browser Edge Bridge Worker.
 *
 * Verifies public health AND protected auth boundaries without mutating Durable Object state:
 *   1. GET /status                     -> 200 { ok: true }
 *   2. GET /health                     -> 200 { ok: true }
 *   3. GET /v1/models (no token)       -> 401 invalid_api_key (diagnoses 503 secrets_unconfigured)
 *   4. GET /v1/models (invalid token)  -> 401 invalid_api_key
 *   5. GET /v1/models (CLIENT_API_KEY) -> 200 { object: "list", data: [...] } (when key provided)
 *   6. POST /mcp tools/list            -> 200 with required bridge tools (when key provided)
 *   7. POST /v1/chat/completions       -> 503 unavailable/extension_disconnected when /status is ok & disconnected
 *   8. GET /bridge/message (BRIDGE_SECRET) -> 200 { ok: true, protocolVersion: 2 } (read-only, when secret provided)
 */
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const REQUIRED_MCP_TOOLS = ['bridge_chat', 'bridge_list_models', 'bridge_status'];
// Must exceed cloudflare/worker.js refreshModels() 10s loader fallback timeout
// so connected extensions without a warm model cache do not race client aborts.
const DEFAULT_TIMEOUT_MS = 15000;

async function requestJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await fetch(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, json, text, networkError: null };
  } catch (err) {
    return { status: 0, json: null, text: '', networkError: err instanceof Error ? err.message : String(err) };
  }
}

function normalizeBaseUrl(raw) {
  const trimmed = String(raw || '').trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('baseUrl is required (pass --url or set BRIDGE_URL / BRIDGE_BASE_URL)');
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`baseUrl must be a valid http(s) URL, got: ${trimmed}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`baseUrl must be a valid http(s) URL, got protocol: ${parsed.protocol}`);
  }
  return trimmed;
}

export async function verifyDeploy({
  baseUrl,
  clientApiKey = '',
  bridgeSecret = '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const root = normalizeBaseUrl(baseUrl);
  const safeTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  const checks = [];

  // 1. GET /status
  const statusRes = await requestJson(`${root}/status`, { method: 'GET' }, safeTimeoutMs);
  const statusOk = statusRes.status === 200 && statusRes.json?.ok === true;
  checks.push({
    name: 'GET /status',
    ok: statusOk,
    status: statusRes.status,
    detail: statusOk
      ? `ok=true extension=${statusRes.json?.extension ?? 'unknown'}`
      : statusRes.networkError || `expected 200 { ok: true }, got ${statusRes.status}`,
  });

  // 2. GET /health
  const healthRes = await requestJson(`${root}/health`, { method: 'GET' }, safeTimeoutMs);
  const healthOk = healthRes.status === 200 && healthRes.json?.ok === true;
  checks.push({
    name: 'GET /health',
    ok: healthOk,
    status: healthRes.status,
    detail: healthOk
      ? 'ok=true'
      : healthRes.networkError || `expected 200 { ok: true }, got ${healthRes.status}`,
  });

  // 3. GET /v1/models (no token) -> MUST be 401 invalid_api_key (not 503 secrets_unconfigured, not 200)
  const unauthRes = await requestJson(`${root}/v1/models`, { method: 'GET' }, safeTimeoutMs);
  const unauthCode = unauthRes.json?.error?.code;
  const unauthOk = unauthRes.status === 401 && unauthCode === 'invalid_api_key';
  let unauthDetail = '401 invalid_api_key';
  if (!unauthOk) {
    if (unauthRes.networkError) {
      unauthDetail = unauthRes.networkError;
    } else if (unauthRes.status === 503 && unauthCode === 'secrets_unconfigured') {
      unauthDetail = '503 secrets_unconfigured: Worker secrets BRIDGE_SECRET / CLIENT_API_KEY are NOT configured on Cloudflare Worker';
    } else if (unauthRes.status === 200) {
      unauthDetail = 'Auth bypass detected: GET /v1/models returned 200 without credentials';
    } else {
      unauthDetail = `expected 401 invalid_api_key, got ${unauthRes.status} (${unauthCode ?? 'no error.code'})`;
    }
  }
  checks.push({
    name: 'GET /v1/models (unauthenticated -> 401)',
    ok: unauthOk,
    status: unauthRes.status,
    detail: unauthDetail,
  });

  // 4. GET /v1/models (wrong token) -> MUST be 401 invalid_api_key
  const badProbeToken = `invalid-probe-${crypto.randomUUID()}`;
  const badTokRes = await requestJson(
    `${root}/v1/models`,
    { method: 'GET', headers: { authorization: `Bearer ${badProbeToken}` } },
    safeTimeoutMs,
  );
  const badTokCode = badTokRes.json?.error?.code;
  const badTokOk = badTokRes.status === 401 && badTokCode === 'invalid_api_key';
  let badTokDetail = '401 invalid_api_key';
  if (!badTokOk) {
    if (badTokRes.networkError) {
      badTokDetail = badTokRes.networkError;
    } else if (badTokRes.status === 503 && badTokCode === 'secrets_unconfigured') {
      badTokDetail = '503 secrets_unconfigured: Worker secrets BRIDGE_SECRET / CLIENT_API_KEY are NOT configured on Cloudflare Worker';
    } else {
      badTokDetail = `expected 401 invalid_api_key, got ${badTokRes.status} (${badTokCode ?? 'no error.code'})`;
    }
  }
  checks.push({
    name: 'GET /v1/models (invalid token -> 401)',
    ok: badTokOk,
    status: badTokRes.status,
    detail: badTokDetail,
  });

  // 5-7. Authenticated client checks (when CLIENT_API_KEY provided)
  if (clientApiKey) {
    const authHeaders = {
      authorization: `Bearer ${clientApiKey}`,
      'content-type': 'application/json',
    };

    const modelsRes = await requestJson(`${root}/v1/models`, { method: 'GET', headers: authHeaders }, safeTimeoutMs);
    const modelsCode = modelsRes.json?.error?.code;
    const modelsOk =
      modelsRes.status === 200 &&
      modelsRes.json?.object === 'list' &&
      Array.isArray(modelsRes.json?.data) &&
      modelsRes.json.data.length > 0;
    checks.push({
      name: 'GET /v1/models (valid CLIENT_API_KEY -> 200)',
      ok: modelsOk,
      status: modelsRes.status,
      detail: modelsOk
        ? `models=${modelsRes.json.data.length}`
        : modelsRes.networkError || `expected 200 non-empty model list, got ${modelsRes.status}${modelsCode ? ` (${modelsCode})` : ''}`,
    });

    const mcpRes = await requestJson(
      `${root}/mcp`,
      {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      },
      safeTimeoutMs,
    );
    const rpcError = mcpRes.json?.error;
    const returnedTools = Array.isArray(mcpRes.json?.result?.tools)
      ? mcpRes.json.result.tools.map((t) => t?.name).filter(Boolean)
      : [];
    const missingTools = REQUIRED_MCP_TOOLS.filter((name) => !returnedTools.includes(name));
    const mcpOk = mcpRes.status === 200 && !rpcError && missingTools.length === 0;
    let mcpDetail = `tools=${returnedTools.join(',')}`;
    if (!mcpOk) {
      if (mcpRes.networkError) {
        mcpDetail = mcpRes.networkError;
      } else if (rpcError) {
        mcpDetail = `JSON-RPC error (${rpcError.code ?? 'unknown'}): ${rpcError.message ?? 'unknown error'}`;
      } else if (mcpRes.status !== 200) {
        mcpDetail = `expected 200, got ${mcpRes.status}`;
      } else {
        mcpDetail = `missing required MCP tools: ${missingTools.join(', ')}`;
      }
    }
    checks.push({
      name: 'POST /mcp tools/list (valid CLIENT_API_KEY -> 200)',
      ok: mcpOk,
      status: mcpRes.status,
      detail: mcpDetail,
    });

    // Fail-closed check only when /status succeeded AND reports extension disconnected
    const isConnected =
      String(statusRes.json?.extension ?? '').toUpperCase() === 'CONNECTED' ||
      Number(statusRes.json?.extensions) > 0;
    if (statusOk && !isConnected) {
      const probeModel =
        modelsRes.json?.data?.[0]?.id || statusRes.json?.defaultModel || 'model-example';
      const chatRes = await requestJson(
        `${root}/v1/chat/completions`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({
            model: probeModel,
            messages: [{ role: 'user', content: 'verify fail-closed probe' }],
          }),
        },
        safeTimeoutMs,
      );
      const chatCode = chatRes.json?.error?.code;
      const chatOk =
        chatRes.status === 503 &&
        (chatCode === 'unavailable' || chatCode === 'extension_disconnected');
      checks.push({
        name: 'POST /v1/chat/completions (fail-closed disconnected -> 503)',
        ok: chatOk,
        status: chatRes.status,
        detail: chatOk
          ? `503 ${chatCode} (fail-closed verified)`
          : chatRes.networkError || `expected 503 unavailable/extension_disconnected, got ${chatRes.status} (${chatCode ?? 'no error.code'})`,
      });
    }
  }

  // 8. Authenticated read-only extension channel check (when BRIDGE_SECRET provided)
  if (bridgeSecret) {
    const extRes = await requestJson(
      `${root}/bridge/message`,
      {
        method: 'GET',
        headers: {
          'x-bridge-token': bridgeSecret,
        },
      },
      safeTimeoutMs,
    );
    const extCode = extRes.json?.error?.code;
    const extOk = extRes.status === 200 && extRes.json?.ok === true;
    checks.push({
      name: 'GET /bridge/message (valid BRIDGE_SECRET -> 200)',
      ok: extOk,
      status: extRes.status,
      detail: extOk
        ? `ok=true protocolVersion=${extRes.json?.protocolVersion ?? 'unknown'}`
        : extRes.networkError || `expected 200 { ok: true }, got ${extRes.status}${extCode ? ` (${extCode})` : ''}`,
    });
  }

  return {
    ok: checks.every((c) => c.ok),
    baseUrl: root,
    checks,
  };
}

export function parseArgs(argv, env = process.env) {
  const opts = {
    baseUrl: env.BRIDGE_URL || env.BRIDGE_BASE_URL || '',
    clientApiKey: env.CLIENT_API_KEY || env.BRIDGE_API_KEY || '',
    bridgeSecret: env.BRIDGE_SECRET || env.BRIDGE_AUTH_TOKEN || '',
    timeoutMs: Number(env.VERIFY_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    json: false,
    help: false,
  };

  const valueFlags = new Set(['--url', '--api-key', '--bridge-secret', '--timeout-ms']);

  for (let i = 0; i < argv.length; i += 1) {
    const rawArg = argv[i];
    if (rawArg === '--json') {
      opts.json = true;
      continue;
    }
    if (rawArg === '--help' || rawArg === '-h') {
      opts.help = true;
      continue;
    }

    let flag = rawArg;
    let value;
    const eqIndex = rawArg.indexOf('=');
    if (eqIndex !== -1) {
      flag = rawArg.slice(0, eqIndex);
      value = rawArg.slice(eqIndex + 1);
      if (!valueFlags.has(flag)) {
        throw new Error(`Unknown argument: ${rawArg}`);
      }
      if (!value) {
        throw new Error(`Missing value for ${flag}`);
      }
    } else if (valueFlags.has(flag)) {
      const next = argv[i + 1];
      if (next === undefined || next === '' || next.startsWith('-')) {
        throw new Error(`Missing value for ${flag}`);
      }
      value = next;
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${rawArg}`);
    }

    if (flag === '--url') opts.baseUrl = value;
    else if (flag === '--api-key') opts.clientApiKey = value;
    else if (flag === '--bridge-secret') opts.bridgeSecret = value;
    else if (flag === '--timeout-ms') {
      const parsedTimeout = Number(value);
      if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
        throw new Error(`Invalid --timeout-ms value: ${value}`);
      }
      opts.timeoutMs = parsedTimeout;
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/verify_deploy.mjs --url <worker-url> [--api-key <key>] [--bridge-secret <secret>] [--timeout-ms <ms>] [--json]');
    process.exit(0);
  }
  const report = await verifyDeploy(opts);
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`=== Worker Deploy Verification: ${report.baseUrl} ===`);
    for (const c of report.checks) {
      const icon = c.ok ? 'PASS' : 'FAIL';
      console.log(`[${icon}] ${c.name} (HTTP ${c.status}) — ${c.detail}`);
    }
    console.log(`OVERALL: ${report.ok ? 'PASS' : 'FAIL'}`);
  }
  process.exit(report.ok ? 0 : 1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((err) => {
    console.error(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
