import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
import test from 'node:test';

import { parseArgs, verifyDeploy } from '../scripts/verify_deploy.mjs';

const execFileAsync = promisify(execFile);

function startMockServer(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const bodyText = Buffer.concat(chunks).toString('utf8');
      try {
        const result = await handler(req, bodyText);
        res.writeHead(result.status ?? 200, { 'content-type': 'application/json', ...(result.headers ?? {}) });
        res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function createWorkerLikeHandler({
  bridgeSecret = 'dummy-bridge-secret-token',
  clientApiKey = 'dummy-client-api-key',
  extensionConnected = false,
  bypassAuth = false,
  statusOk = true,
  healthOk = true,
  mcpTools = ['bridge_chat', 'bridge_list_models', 'bridge_status', 'web_search', 'summarize'],
  mcpError = null,
  chatFailClosed = true,
  tracker = null,
} = {}) {
  return (req, bodyText) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const p = url.pathname;
    if (tracker) tracker.requests.push(`${req.method} ${p}`);
    if (req.method === 'GET' && p === '/status') {
      return {
        status: statusOk ? 200 : 500,
        body: { ok: statusOk, service: 'browser-edge-bridge', extension: extensionConnected ? 'CONNECTED' : 'OFFLINE', extensions: extensionConnected ? 1 : 0 },
      };
    }
    if (req.method === 'GET' && p === '/health') {
      return {
        status: healthOk ? 200 : 500,
        body: { ok: healthOk, service: 'browser-edge-bridge' },
      };
    }

    const allowed = [bridgeSecret, clientApiKey].filter(Boolean);
    const provided =
      (req.headers['x-bridge-token'] || '').trim() ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();

    if (!bypassAuth) {
      if (!allowed.length) {
        return {
          status: 503,
          body: { error: { message: 'Bridge secrets are not configured', type: 'bridge_error', code: 'secrets_unconfigured' } },
        };
      }
      if (!provided || !allowed.includes(provided)) {
        return {
          status: 401,
          body: { error: { message: 'Invalid or missing API key', type: 'invalid_request_error', code: 'invalid_api_key' } },
        };
      }
    }

    if (req.method === 'GET' && p === '/v1/models') {
      return {
        status: 200,
        body: { object: 'list', data: [{ id: 'model-example', object: 'model' }] },
      };
    }
    if (req.method === 'POST' && p === '/mcp') {
      const payload = JSON.parse(bodyText || '{}');
      if (mcpError) {
        return {
          status: 200,
          body: { jsonrpc: '2.0', id: payload.id ?? 1, error: mcpError },
        };
      }
      return {
        status: 200,
        body: { jsonrpc: '2.0', id: payload.id ?? 1, result: { tools: mcpTools.map((name) => ({ name })) } },
      };
    }
    if (p === '/bridge/message' || p === '/bridge/msg') {
      return { status: 200, body: { ok: true, protocolVersion: 2 } };
    }
    if (req.method === 'POST' && p === '/ext/tab') {
      if (tracker) tracker.extTabMutations += 1;
      return { status: 200, body: { ok: true } };
    }
    if (req.method === 'POST' && p === '/v1/chat/completions') {
      if (tracker) tracker.chatCalls += 1;
      if (!extensionConnected && chatFailClosed) {
        return {
          status: 503,
          body: { error: { message: 'no extension connected to the cloud hub', code: 'unavailable' } },
        };
      }
      return { status: 200, body: { choices: [{ message: { content: 'mock response' } }] } };
    }
    return { status: 404, body: { error: { code: 'not_found' } } };
  };
}

test('verifyDeploy passes full read-only check suite without mutating /ext/tab', async () => {
  const tracker = { requests: [], extTabMutations: 0, chatCalls: 0 };
  const srv = await startMockServer(createWorkerLikeHandler({ tracker }));
  try {
    const report = await verifyDeploy({
      baseUrl: srv.url,
      clientApiKey: 'dummy-client-api-key',
      bridgeSecret: 'dummy-bridge-secret-token',
    });
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(tracker.extTabMutations, 0, 'verifyDeploy must not mutate Durable Object lastDispatchedTab via POST /ext/tab');
    const names = report.checks.map((c) => c.name);
    assert.ok(names.includes('GET /status'));
    assert.ok(names.includes('GET /health'));
    assert.ok(names.includes('GET /v1/models (unauthenticated -> 401)'));
    assert.ok(names.includes('GET /v1/models (invalid token -> 401)'));
    assert.ok(names.includes('GET /v1/models (valid CLIENT_API_KEY -> 200)'));
    assert.ok(names.includes('POST /mcp tools/list (valid CLIENT_API_KEY -> 200)'));
    assert.ok(names.includes('POST /v1/chat/completions (fail-closed disconnected -> 503)'));
    assert.ok(names.includes('GET /bridge/message (valid BRIDGE_SECRET -> 200)'));
  } finally {
    await srv.close();
  }
});

test('verifyDeploy passes unauthenticated post-deploy mode when secrets are configured', async () => {
  const srv = await startMockServer(createWorkerLikeHandler());
  try {
    const report = await verifyDeploy({ baseUrl: srv.url });
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.checks.length, 4);
  } finally {
    await srv.close();
  }
});

test('verifyDeploy explicitly diagnoses 503 secrets_unconfigured even when /status and /health return 200', async () => {
  const srv = await startMockServer(createWorkerLikeHandler({ bridgeSecret: '', clientApiKey: '' }));
  try {
    const report = await verifyDeploy({ baseUrl: srv.url });
    assert.equal(report.ok, false);
    const modelsCheck = report.checks.find((c) => c.name.includes('unauthenticated'));
    assert.equal(modelsCheck.ok, false);
    assert.match(modelsCheck.detail, /secrets_unconfigured/i);
    assert.match(modelsCheck.detail, /BRIDGE_SECRET|CLIENT_API_KEY/);
  } finally {
    await srv.close();
  }
});

test('verifyDeploy fails on auth bypass when /v1/models returns 200 without credentials', async () => {
  const srv = await startMockServer(createWorkerLikeHandler({ bypassAuth: true }));
  try {
    const report = await verifyDeploy({ baseUrl: srv.url });
    assert.equal(report.ok, false);
    const modelsCheck = report.checks.find((c) => c.name.includes('unauthenticated'));
    assert.equal(modelsCheck.ok, false);
    assert.match(modelsCheck.detail, /auth bypass|200/i);
  } finally {
    await srv.close();
  }
});

test('verifyDeploy fails when /status or /health is unhealthy', async () => {
  const srv = await startMockServer(createWorkerLikeHandler({ healthOk: false }));
  try {
    const report = await verifyDeploy({ baseUrl: srv.url });
    assert.equal(report.ok, false);
    const healthCheck = report.checks.find((c) => c.name === 'GET /health');
    assert.equal(healthCheck.ok, false);
  } finally {
    await srv.close();
  }
});

test('verifyDeploy fails when disconnected chat endpoint fabricates 200 instead of 503 fail-closed', async () => {
  const srv = await startMockServer(createWorkerLikeHandler({ extensionConnected: false, chatFailClosed: false }));
  try {
    const report = await verifyDeploy({
      baseUrl: srv.url,
      clientApiKey: 'dummy-client-api-key',
    });
    assert.equal(report.ok, false);
    const chatCheck = report.checks.find((c) => c.name.includes('/v1/chat/completions'));
    assert.equal(chatCheck.ok, false);
  } finally {
    await srv.close();
  }
});

test('verifyDeploy fails when /mcp tools/list omits required bridge tools', async () => {
  const srv = await startMockServer(createWorkerLikeHandler({ mcpTools: ['bridge_status'] }));
  try {
    const report = await verifyDeploy({
      baseUrl: srv.url,
      clientApiKey: 'dummy-client-api-key',
    });
    assert.equal(report.ok, false);
    const mcpCheck = report.checks.find((c) => c.name.includes('/mcp'));
    assert.equal(mcpCheck.ok, false);
    assert.match(mcpCheck.detail, /bridge_chat/);
  } finally {
    await srv.close();
  }
});

test('verifyDeploy skips disconnected chat fail-closed check when status reports lowercase connected', async () => {
  const baseHandler = createWorkerLikeHandler({ extensionConnected: true });
  const srv = await startMockServer((req, bodyText) => {
    if (req.method === 'GET' && req.url === '/status') {
      return { status: 200, body: { ok: true, service: 'browser-edge-bridge', extension: 'connected', extensions: '1' } };
    }
    return baseHandler(req, bodyText);
  });
  try {
    const report = await verifyDeploy({
      baseUrl: srv.url,
      clientApiKey: 'dummy-client-api-key',
      bridgeSecret: 'dummy-bridge-secret-token',
    });
    assert.equal(report.ok, true, JSON.stringify(report, null, 2));
    assert.equal(report.checks.some((c) => c.name.includes('/v1/chat/completions')), false);
  } finally {
    await srv.close();
  }
});

test('verifyDeploy never leaks credential values in its report and tolerates invalid timeoutMs', async () => {
  const srv = await startMockServer(createWorkerLikeHandler());
  try {
    const secretClient = 'dummy-client-unique-998877';
    const secretBridge = 'dummy-bridge-unique-665544';
    const report = await verifyDeploy({
      baseUrl: `${srv.url}/`,
      clientApiKey: secretClient,
      bridgeSecret: secretBridge,
      timeoutMs: Number.NaN,
    });
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(secretClient), false);
    assert.equal(serialized.includes(secretBridge), false);
    assert.equal(report.ok, false); // tokens did not match mock server defaults
  } finally {
    await srv.close();
  }
});

test('verifyDeploy skips chat probe when /status is unhealthy and surfaces JSON-RPC errors on /mcp', async () => {
  const tracker = { requests: [], extTabMutations: 0, chatCalls: 0 };
  const srv = await startMockServer(createWorkerLikeHandler({
    statusOk: false,
    mcpError: { code: -32601, message: 'method not found' },
    tracker,
  }));
  try {
    const report = await verifyDeploy({
      baseUrl: srv.url,
      clientApiKey: 'dummy-client-api-key',
    });
    assert.equal(report.ok, false);
    assert.equal(tracker.chatCalls, 0, 'should not send chat probe when /status failed');
    const mcpCheck = report.checks.find((c) => c.name.includes('/mcp'));
    assert.equal(mcpCheck.ok, false);
    assert.match(mcpCheck.detail, /method not found|-32601/i);
  } finally {
    await srv.close();
  }
});

test('verifyDeploy rejects malformed or non-HTTP base URLs before sending requests', async () => {
  await assert.rejects(() => verifyDeploy({ baseUrl: 'not-a-valid-url' }), /valid http/i);
  await assert.rejects(() => verifyDeploy({ baseUrl: 'ftp://example.com' }), /valid http/i);
});

test('parseArgs supports --flag=value and rejects missing values and unknown flags', async () => {
  assert.ok(parseArgs([], {}).timeoutMs >= 15000, 'default timeoutMs must exceed worker 10s refreshModels loader timeout');
  const parsed = parseArgs([
    '--url=https://bridge.example.workers.dev/',
    '--api-key=dummy-client-api-key',
    '--bridge-secret=dummy-bridge-secret-token',
    '--timeout-ms=5000',
    '--json',
  ], {});
  assert.equal(parsed.baseUrl, 'https://bridge.example.workers.dev/');
  assert.equal(parsed.clientApiKey, 'dummy-client-api-key');
  assert.equal(parsed.bridgeSecret, 'dummy-bridge-secret-token');
  assert.equal(parsed.timeoutMs, 5000);
  assert.equal(parsed.json, true);

  assert.throws(() => parseArgs(['--url', '--json'], {}), /missing value for --url/i);
  assert.throws(() => parseArgs(['--url'], {}), /missing value for --url/i);
  assert.throws(() => parseArgs(['--bogus-flag'], {}), /unknown argument/i);

  // Also test real CLI invocation rejects --url --json without making HTTP requests
  await assert.rejects(
    execFileAsync(process.execPath, ['scripts/verify_deploy.mjs', '--url', '--json'], { env: { PATH: process.env.PATH } }),
    (err) => err.code !== 0 && /missing value for --url/i.test(err.stderr),
  );
});
