import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
import worker, {
  ExtHub,
  decodeTurboStream,
  findValue,
  extractModels,
  kindOf,
} from "../cloudflare/worker.js";

const CONVERSATIONS_LOADER_URL = "/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-converstaions";
const MODELS_LOADER_URL = "/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models";
const MODEL_FALLBACK = ["model-example", "model-fast", "model-reasoning"];

test("decodeTurboStream: parses turbo-stream flat reference pools correctly", () => {
  const turboPayload = JSON.stringify([
    { _1: 2 },
    "conversationId",
    "conv-test-12345-67890",
  ]);
  const decoded = decodeTurboStream(turboPayload);
  assert.equal(typeof decoded, "object");
  assert.equal(decoded.conversationId, "conv-test-12345-67890");
});

test("findValue: locates nested conversationId and id keys", () => {
  const treeA = { data: { conversationId: "conv-from-create-conv" } };
  assert.equal(findValue(treeA, "conversationId"), "conv-from-create-conv");

  const treeB = { data: { conversation: { id: "conv-from-temp-chat" } } };
  assert.equal(findValue(treeB, "id"), "conv-from-temp-chat");

  assert.equal(findValue(treeB, "nonexistent"), null);
});

test("extractModels: extracts valid selectable models and identifies free models", () => {
  const mockDecoded = [
    {
      id: "model-fast",
      displayName: "Model Fast Example",
      provider: "example-provider",
      selectable: true,
      ready: true,
      isFreeCredit: true,
    },
    {
      id: "model-reasoning",
      displayName: "Model Reasoning Example",
      provider: "example-provider",
      selectable: true,
      ready: true,
      isFreeCredit: false,
    },
    {
      id: "unready-model",
      displayName: "Unready Model",
      selectable: true,
      ready: false,
    },
  ];

  const extracted = extractModels(mockDecoded);
  assert.equal(extracted.length, 2);
  const fast = extracted.find((m) => m.id === "model-fast");
  assert.ok(fast);
  assert.equal(fast.free, true);
  assert.equal(fast.kind, "chat");

  const reasoning = extracted.find((m) => m.id === "model-reasoning");
  assert.ok(reasoning);
  assert.equal(reasoning.free, false);
});

test("ExtHub: disconnected state returns 503 for chat completions", async () => {
  const hub = new ExtHub({}, {});
  assert.equal(hub.isExtConnected, false);

  const req = new Request("https://hub.internal/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "model-example",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  const res = await hub.chatCompletions(req);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, "extension_disconnected");
  assert.equal(body.error.type, "bridge_error");
});

test("ExtHub: connected offscreen extension without any attached target tab returns 503 extension_disconnected", async () => {
  const { hub } = connectedHub();
  // Simulate extension explicitly reporting active tabs = none attached
  await hub.fetch(jsonRequest("/ext/tab", {
    pages: {
      primary: { online: false },
      secondary: { online: false },
    },
  }));
  const res = await hub.chatCompletions(jsonRequest("/v1/chat/completions", {
    model: "model-example",
    messages: [{ role: "user", content: "hello" }],
  }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.error.code, "extension_disconnected");
  assert.equal(body.error.type, "bridge_error");
});

test("ExtHub: resolveConversation uses conversationCache when present", async () => {
  const hub = new ExtHub({}, {});
  hub.conversationCache = "cached-conv-id-999";

  const resolved = await hub.resolveConversation("model-example");
  assert.equal(resolved, "cached-conv-id-999");
});

test("ExtHub: resolveConversation loads existing active conversation from session", async () => {
  const hub = new ExtHub({}, {});

  hub.extWriter = { write: async () => {} };
  hub.extReady = true;

  // Intercept runLoaderJob to simulate returning conversations list
  hub.runLoaderJob = async (url) => {
    assert.equal(url, CONVERSATIONS_LOADER_URL);
    return JSON.stringify([
      [1, 2],
      { _3: 4, _5: 6 },
      { _3: 7, _5: 8 },
      "id", "conv-old",
      "updatedAt", "2026-09-17T10:00:00Z",
      "conv-latest", "2026-09-17T12:00:00Z",
    ]);
  };

  const resolved = await hub.resolveConversation("model-example");
  assert.equal(resolved, "conv-latest");
  assert.equal(hub.conversationCache, "conv-latest");
});

test("ExtHub: resolveConversation falls back to createConversation if no active conversations exist", async () => {
  const hub = new ExtHub({}, {});
  hub.extWriter = { write: async () => {} };
  hub.extReady = true;

  hub.loadConversations = async () => [];

  hub.runCreateJob = async () => {
    return JSON.stringify([
      { _1: 2 },
      "id",
      "fresh-temp-conv-888",
    ]);
  };

  const resolved = await hub.resolveConversation("model-example");
  assert.equal(resolved, "fresh-temp-conv-888");
  assert.equal(hub.conversationCache, "fresh-temp-conv-888");
});

test("ExtHub: runJob dispatches SSE line and handles chunks and done", async () => {
  const hub = new ExtHub({}, {});
  let sentData = null;
  hub.extWriter = {
    write: async (encoded) => {
      sentData = new TextDecoder().decode(encoded);
    },
  };
  hub.extReady = true;

  const collectedChunks = [];
  const jobPromise = hub.runJob(
    { kind: "chat", modelId: "model-example", text: "hi", conversationId: "conv-1" },
    (delta) => collectedChunks.push(delta)
  );

  assert.ok(sentData);
  assert.match(sentData, /event: job/);

  const match = sentData.match(/"jobId":"([^"]+)"/);
  assert.ok(match);
  const jobId = match[1];

  await hub.extPost(
    new Request("https://hub.internal/ext/chunk", {
      method: "POST",
      body: JSON.stringify({ jobId, parts: [{ kind: "text", text: "Hello" }, { kind: "text", text: " World" }] }),
    }),
    "chunk"
  );

  assert.deepEqual(collectedChunks, ["Hello", " World"]);

  await hub.extPost(
    new Request("https://hub.internal/ext/done", {
      method: "POST",
      body: JSON.stringify({ jobId, finishReason: "stop" }),
    }),
    "done"
  );

  const result = await jobPromise;
  assert.equal(result.finishReason, "stop");
  assert.equal(hub.jobs.size, 0);
});

test("ExtHub: chatCompletions returns formatted OpenAI completion", async () => {
  const hub = new ExtHub({}, {});
  hub.conversationCache = "test-conv-123";
  hub.extWriter = { write: async () => {} };
  hub.extReady = true;

  hub.runChatJob = async (text, modelId, conversationId) => {
    return {
      chunks: [{ text: "Hello from test model!" }],
      finishReason: "stop",
    };
  };

  const req = new Request("https://hub.internal/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "model-example",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  const res = await hub.chatCompletions(req);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.object, "chat.completion");
  assert.equal(json.model, "model-example");
  assert.equal(json.choices[0].message.content, "Hello from test model!");
  assert.equal(json.choices[0].finish_reason, "stop");
  assert.ok(json.latency_ms >= 0);
});

test("ExtHub: reload endpoints emit reload_extension and reload_tab SSE events", async () => {
  const hub = new ExtHub({}, {});
  const emittedEvents = [];
  hub.extWriter = {
    write: async (encoded) => {
      emittedEvents.push(new TextDecoder().decode(encoded));
    },
  };

  const reloadRes = await hub.fetch(new Request("https://hub.internal/ext/reload", { method: "POST" }));
  assert.equal(reloadRes.status, 200);
  assert.ok(emittedEvents.some((e) => e.includes("event: reload_extension")));

  const reloadTabRes = await hub.fetch(new Request("https://hub.internal/ext/reload-tab", { method: "POST" }));
  assert.equal(reloadTabRes.status, 200);
  assert.ok(emittedEvents.some((e) => e.includes("event: reload_tab")));
});

test("Chrome Extension: defaults and manifests are properly configured for generic edge bridge", () => {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../package.json"), "utf8"));
  const coreManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/manifest.json"), "utf8"));
  const releaseManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../release/chrome-extension/manifest.json"), "utf8"));

  assert.equal(coreManifest.version, rootPkg.version);
  assert.equal(releaseManifest.version, rootPkg.version);

  const bgSource = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/background.js"), "utf8");
  assert.ok(bgSource.includes("const DEFAULT_BRIDGE = 'https://bridge.example.workers.dev';"));
  assert.ok(bgSource.includes("const DEFAULT_REMOTE_TOKEN = '__BRIDGE_AUTH_TOKEN__';"));

  const popupSource = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/popup.js"), "utf8");
  assert.ok(popupSource.includes("DEFAULT_BRIDGE"));

  const popupHtml = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/popup.html"), "utf8");
  assert.ok(popupHtml.includes("value=\"https://bridge.example.workers.dev\""));

  const extensionFiles = ["background.js", "popup.js", "popup.html", "content.js", "page.js", "offscreen.js", "manifest.json"]
    .map((f) => fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension", f), "utf8"));
  for (const src of extensionFiles) {
    assert.ok(!src.includes("example-legacy-secret-token"), "extension source must not contain old tokens");
  }
});

test("ExtHub: /registry and /registry/models return 200 with registry metadata and models list", async () => {
  const hub = new ExtHub({}, {});
  hub.modelCatalog = [
    { id: "model-example", name: "Model Example", free: true, kind: "chat" },
    { id: "model-fast", name: "Model Fast", free: false, kind: "chat" },
  ];
  hub.defaultModel = "model-example";

  const regReq = new Request("https://hub.internal/registry", { method: "GET" });
  const regRes = await hub.fetch(regReq);
  assert.equal(regRes.status, 200);
  const regJson = await regRes.json();
  assert.equal(regJson.ok, true);
  assert.equal(regJson.service, "browser-edge-bridge");
  assert.ok(regJson.registry);
  assert.ok(Array.isArray(regJson.data));
  assert.equal(regJson.data.length, 2);
  assert.equal(regJson.data[0].id, "model-example");

  const regModelsReq = new Request("https://hub.internal/registry/models", { method: "GET" });
  const regModelsRes = await hub.fetch(regModelsReq);
  assert.equal(regModelsRes.status, 200);
  const regModelsJson = await regModelsRes.json();
  assert.equal(regModelsJson.object, "list");
  assert.equal(regModelsJson.data.length, 2);
});

test("Edge worker fetch: /registry requires CLIENT_API_KEY auth (no unauthenticated schema dump)", async () => {
  const env = {
    BRIDGE_SECRET: "mock-secret-123",
    CLIENT_API_KEY: "mock-key-456",
    EXT_HUB: {
      idFromName: () => "id",
      get: () => ({ fetch: async (req) => new ExtHub({}, {}).fetch(req) }),
    },
  };
  const unauth = await worker.fetch(new Request("https://bridge.example.workers.dev/registry", { method: "GET" }), env);
  assert.equal(unauth.status, 401);
  assert.equal((await unauth.json()).error.code, "invalid_api_key");

  const wrongRole = await worker.fetch(new Request("https://bridge.example.workers.dev/registry", {
    method: "GET",
    headers: { "x-bridge-token": "mock-secret-123" },
  }), env);
  assert.equal(wrongRole.status, 401);

  const authorized = await worker.fetch(new Request("https://bridge.example.workers.dev/registry", {
    method: "GET",
    headers: { authorization: "Bearer mock-key-456" },
  }), env);
  assert.equal(authorized.status, 200);
  const body = await authorized.json();
  assert.equal(body.ok, true);
});

test("Chrome Extension: manifests scope permissions to configured target origins without <all_urls>", () => {
  const coreManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/manifest.json"), "utf8"));
  const releaseManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "../release/chrome-extension/manifest.json"), "utf8"));

  for (const m of [coreManifest, releaseManifest]) {
    assert.ok(!m.host_permissions.includes("<all_urls>"), "host_permissions must not include <all_urls>");
    assert.ok(m.host_permissions.some((p) => p.includes("example.local")));
    for (const cs of m.content_scripts) {
      assert.ok(!cs.matches.includes("<all_urls>"), "content_scripts matches must not include <all_urls>");
      assert.ok(cs.matches.some((p) => p.includes("example.local")));
    }
  }

  const bgSource = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/background.js"), "utf8");
  assert.ok(bgSource.includes("isSecondaryUrl"));
  assert.ok(bgSource.includes("_sender.tab?.id") || bgSource.includes("_sender?.tab?.id"));
});

test("ExtHub: resolveConversation bypasses conversation loader for secondary provider models", async () => {
  const hub = new ExtHub({}, {});
  const convId = await hub.resolveConversation("secondary-session-model");
  assert.equal(convId, "secondary-provider-session");
});

test("Chrome Extension: background.js enforces tab verification & token safety and page.js fails closed without mocks", () => {
  const bgSource = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/background.js"), "utf8");
  assert.ok(bgSource.includes("isSecondaryJob"));
  assert.ok(bgSource.includes("findSecondaryTab"));
  assert.match(bgSource, /if \(val && !isUnresolvedToken\(val\)\)/, "bridgeToken() must ignore unresolved placeholder in storage");
  assert.match(bgSource, /!isUnresolvedToken\(DEFAULT_REMOTE_TOKEN\)/, "initDefaults() must never store unresolved placeholder");
  assert.ok(bgSource.includes("record.tabId"), "from-page handler must verify sender tab matches jobTabs record");

  const pageSource = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/page.js"), "utf8");
  assert.ok(pageSource.includes("flush();"));
  assert.ok(!pageSource.includes("Response processed successfully from target session"), "page.js must not emit canned mock text");
  assert.ok(!pageSource.includes("Target session active and ready"), "page.js must not emit canned mock text");
});

test("Chrome Extension: popup and background support per-page online/offline status and usable models listing", () => {
  const bgSource = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/background.js"), "utf8");
  assert.ok(bgSource.includes("getPagesStatus"));
  assert.ok(bgSource.includes("siteModels"));
  assert.ok(bgSource.includes("pages_status"));

  const popupHtml = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/popup.html"), "utf8");
  assert.ok(popupHtml.includes("id=\"pagePrimary\""));
  assert.ok(popupHtml.includes("id=\"pageSecondary\""));
  assert.ok(popupHtml.includes("id=\"usableSection\""));

  const popupJs = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/popup.js"), "utf8");
  assert.ok(popupJs.includes("renderPages"));
  assert.ok(popupJs.includes("renderUsableModels"));
});

test("Popup UI: default banner and filter pills integrated into usableSection", () => {
  const popupHtml = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/popup.html"), "utf8");
  assert.ok(!popupHtml.includes('<select id="model"'), "popup.html must not contain <select id=\"model\"> dropdown");
  assert.ok(popupHtml.includes('id="currentDefaultName"'), "popup.html must include currentDefaultName banner");
  assert.ok(popupHtml.includes('data-filter="all"'), "popup.html must include all filter");
  assert.ok(popupHtml.includes('data-filter="free"'), "popup.html must include free filter");
  assert.ok(popupHtml.includes('data-filter="primary"'), "popup.html must include primary filter");
  assert.ok(popupHtml.includes('data-filter="secondary"'), "popup.html must include secondary filter");

  const popupJs = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/popup.js"), "utf8");
  assert.ok(popupJs.includes("★ Default"), "popup.js must render ★ Default badge on active model");
  assert.ok(popupJs.includes("/config"), "popup.js must send POST /config when switching default model");
  assert.ok(popupJs.includes("defaultModel"), "popup.js must handle defaultModel");
});

test("Chrome Extension: popup source and release copy have a valid accordion render path", () => {
  const popupPaths = [
    path.join(__dirname, "../packages/core/browser-bridge/extension/popup.js"),
    path.join(__dirname, "../release/chrome-extension/popup.js"),
  ];

  for (const popupPath of popupPaths) {
    const syntax = spawnSync(process.execPath, ["--check", popupPath], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `${popupPath} must pass node --check: ${syntax.stderr}`);

    const popupSource = fs.readFileSync(popupPath, "utf8");
    assert.equal(
      (popupSource.match(/<span class="accordion-count">/g) || []).length,
      1,
      `${popupPath} must render one accordion count template per header`,
    );
  }
});

test("Multi-Provider Tab Isolation & Smart Routing in background.js", () => {
  const bgSource = fs.readFileSync(path.join(__dirname, "../packages/core/browser-bridge/extension/background.js"), "utf8");
  assert.ok(!bgSource.includes("(await findSecondaryTab()) || (await findPrimaryTab())"), "findChatTab must not fall back across providers");

  // tabCoordinator isolation: secondary tabs must not steal leadership
  assert.ok(bgSource.includes("secondaryPorts.has(tabId)"), "tabCoordinator must reject secondary tabs");
  assert.ok(bgSource.includes("secondary_isolated"), "lease requests from secondary tabs must be rejected");

  const siteModelsMatch = bgSource.match(/const siteModels = ({[\s\S]*?});/);
  assert.ok(siteModelsMatch, "siteModels must be defined");

  const funcMatch = bgSource.match(/function getProviderForModel\([\s\S]*?\n\}/);
  const isSecondaryModelMatch = bgSource.match(/function isSecondaryModel\([\s\S]*?\n\}/);
  assert.ok(funcMatch && isSecondaryModelMatch, "routing functions must exist");

  const fnCode = `(function() {
    ${siteModelsMatch[0]}
    ${isSecondaryModelMatch[0]}
    ${funcMatch[0]}
    return { getProviderForModel, isSecondaryModel };
  })()`;
  const { getProviderForModel, isSecondaryModel } = eval(fnCode);

  assert.equal(getProviderForModel("secondary-session-model"), "secondary");
  assert.equal(getProviderForModel("secondary/model-1"), "secondary");
  assert.equal(getProviderForModel("secondary:model-1"), "secondary");
  assert.equal(getProviderForModel("model-example"), "primary");
  assert.equal(getProviderForModel("model-fast"), "primary");
  assert.equal(getProviderForModel("auto"), "primary");
  assert.equal(getProviderForModel(null), "primary");
  assert.equal(getProviderForModel(""), "primary");
});

test("ExtHub: POST /config updates defaultModel dynamically", async () => {
  const hub = new ExtHub({}, {});
  assert.equal(hub.defaultModel, "model-example");

  const req = new Request("https://hub.internal/config", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultModel: "secondary-session-model" }),
  });
  const res = await hub.fetch(req);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.ok, true);
  assert.equal(data.defaultModel, "secondary-session-model");
  assert.equal(hub.defaultModel, "secondary-session-model");
});

// Coverage-focused behavioral tests. These exercise the existing Worker
// contract through its public methods and routes; they do not weaken gates or
// replace production behavior with test-only branches.
function connectedHub() {
  const writes = [];
  const hub = new ExtHub({}, {});
  hub.extWriter = {
    write: async (encoded) => {
      writes.push(new TextDecoder().decode(encoded));
    },
  };
  hub.extReady = true;
  return { hub, writes };
}

function jsonRequest(path, body, method = "POST") {
  return new Request(`https://hub.internal${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rpcRequest(method, params, id = 1) {
  return jsonRequest("/mcp", { jsonrpc: "2.0", id, method, params });
}

async function responseJson(response) {
  return response.json();
}

test("Worker helpers cover recursive arrays, null references, model kinds, and skill defaults", () => {
  assert.deepEqual(decodeTurboStream(JSON.stringify([[-1]])), [null]);
  assert.equal(findValue([{ nested: { id: "array-id" } }], "id"), "array-id");
  assert.equal(findValue("not-an-object", "id"), null);

  assert.equal(kindOf("model-image-example"), "image");
  assert.equal(kindOf("new-image-preview"), "image");
  assert.equal(kindOf("model-video-example"), "video");
  assert.equal(kindOf("anim-preview"), "video");
  assert.equal(kindOf("model-music-example"), "music");
  assert.equal(kindOf("audio-preview"), "music");
  assert.equal(kindOf("model-research-example"), "research");
  assert.equal(kindOf("ordinary-chat"), "chat");

  const models = extractModels({
    models: [
      { modelId: "model-image-example", name: "Image", ready: true, selectable: true },
      { id: "new-video-model", ready: true, selectable: true },
      { id: "model-music-example", ready: true, selectable: true },
      { id: "deep-research-example", ready: true, selectable: true },
      { id: "model-fast", ready: true, selectable: true, isFreeCredit: true },
      { id: "model-fast", ready: true, selectable: true },
      { id: "not-selectable", ready: true, selectable: false },
    ],
  });
  assert.equal(models.length, 5);
  assert.equal(models.find((m) => m.id === "model-fast").name, "model-fast");
});

test("ExtHub: extension SSE handshake sends ready and abort clears jobs", async () => {
  const hub = new ExtHub({}, {});
  hub.refreshModels = async () => [];
  hub.resolveConversation = async () => "prewarmed-conversation";
  let rejected;
  hub.jobs.set("pending", {
    reject: (error) => { rejected = error; },
  });
  const controller = new AbortController();
  const response = await hub.extEvents(new Request("https://hub.internal/ext/events", { signal: controller.signal }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const reader = response.body.getReader();
  const first = await reader.read();
  assert.match(new TextDecoder().decode(first.value), /event: ready/);
  controller.abort();
  await reader.cancel();
  assert.equal(hub.isExtConnected, false);
  assert.match(rejected.message, /extension disconnected/);
});

test("ExtHub: extension posts cover unknown, loader success/error, and extension error", async () => {
  const { hub } = connectedHub();
  const unknown = await hub.extPost(jsonRequest("/ext/chunk", { jobId: "missing" }), "chunk");
  assert.equal((await responseJson(unknown)).ok, true);

  let loaderResolve;
  hub.jobs.set("loader-ok", { timer: null, resolve: (value) => { loaderResolve = value; } });
  const loaderResponse = await hub.extPost(
    jsonRequest("/ext/loader", { jobId: "loader-ok", raw: "payload" }),
    "loader",
  );
  assert.equal((await responseJson(loaderResponse)).ok, true);
  assert.deepEqual(loaderResolve, { raw: "payload" });

  let loaderError;
  hub.jobs.set("loader-error", { timer: null, reject: (error) => { loaderError = error; } });
  await hub.extPost(jsonRequest("/ext/loader", { jobId: "loader-error", message: "loader failed" }), "loader");
  assert.match(loaderError.message, /loader failed/);

  let extensionError;
  hub.jobs.set("extension-error", { timer: null, reject: (error) => { extensionError = error; } });
  await hub.extPost(jsonRequest("/ext/error", { jobId: "extension-error" }), "error");
  assert.match(extensionError.message, /extension error/);

  const malformed = await hub.extPost(new Request("https://hub.internal/ext/chunk", { method: "POST", body: "{" }), "chunk");
  assert.equal((await responseJson(malformed)).ok, true);
  assert.equal(hub.lastPost.kind, "chunk");
});

test("ExtHub: runJob rejects disconnected and writer failures, and loadConversations handles failures", async () => {
  const disconnected = new ExtHub({}, {});
  await assert.rejects(disconnected.runJob({ kind: "loader" }), /no extension connected/);

  const { hub } = connectedHub();
  hub.extWriter.write = async () => { throw new Error("writer failed"); };
  await assert.rejects(hub.runJob({ kind: "loader" }), /writer failed/);

  hub.runLoaderJob = async () => { throw new Error("loader unavailable"); };
  assert.deepEqual(await hub.loadConversations(), []);
});

test("ExtHub: refreshModels covers cache, in-flight, successful catalog, and timeout fallback", async () => {
  const { hub } = connectedHub();
  hub.modelCatalog = [{ id: "cached", name: "Cached", free: true, kind: "chat" }];
  hub.modelCatalogAt = Date.now();
  assert.deepEqual(await hub.refreshModels(), hub.modelCatalog);

  const inflight = Promise.resolve([{ id: "inflight" }]);
  hub.modelRefresh = inflight;
  assert.equal(await hub.refreshModels(true), (await inflight));
  hub.modelRefresh = null;

  let loaderCalls = 0;
  hub.defaultModel = "model-example";
  hub.runLoaderJob = async (url) => {
    loaderCalls++;
    assert.equal(url, MODELS_LOADER_URL);
    return JSON.stringify([[
      { id: "model-example", displayName: "Default", isFreeCredit: true },
      { id: "model-reasoning", displayName: "Reasoning", isFreeCredit: false },
    ]]);
  };
  const refreshed = await hub.refreshModels(true);
  assert.equal(loaderCalls, 1);
  assert.equal(refreshed.length, 2);
  assert.equal(hub.defaultModel, "model-example");
  assert.equal(hub.catalogRevision, 1);

  hub.runLoaderJob = async () => JSON.stringify([[{ id: "model-fast", isFreeCredit: true }]]);
  const freeDefault = await hub.refreshModels(true);
  assert.equal(freeDefault[0].tier, "free");
  assert.equal(hub.defaultModel, "model-fast");

  hub.runLoaderJob = async () => JSON.stringify([[{ id: "model-reasoning" }]]);
  await hub.refreshModels(true);
  assert.equal(hub.defaultModel, "model-reasoning");

  hub.runLoaderJob = async () => { throw new Error("loader timeout"); };
  const fallback = await hub.refreshModels(true);
  assert.ok(Array.isArray(fallback));
  assert.equal(hub.modelRefresh, null);
  assert.ok(hub.modelsList().some((model) => model.tier === "paid"));
});

test("ExtHub: create and loader jobs delegate to runJob", async () => {
  const hub = new ExtHub({}, {});
  const payloads = [];
  hub.runJob = async (payload) => {
    payloads.push(payload);
    return { raw: "raw-loader" };
  };
  assert.equal(await hub.runCreateJob("model-example"), "raw-loader");
  assert.equal(await hub.runLoaderJob("/loader"), "raw-loader");
  assert.equal(payloads[0].kind, "create");
  assert.equal(payloads[0].temporary, true);
  assert.deepEqual(payloads[1], { kind: "loader", url: "/loader" });
});

test("ExtHub: chat completions forward system messages, verify model catalog (422), and retry", async () => {
  const { hub } = connectedHub();
  hub.conversationCache = "conv-chat";
  hub.modelCatalog = [{ id: "model-fast", free: true, kind: "chat" }];
  hub.defaultModel = "model-fast";
  hub.runChatJob = async (text, model, conversation, onChunk, attachments) => {
    assert.match(text, /You are concise/);
    assert.match(text, /hello\nworld/);
    assert.equal(model, "model-fast");
    assert.equal(conversation, "conv-chat");
    assert.deepEqual(attachments, [{ type: "image", data: "data:image/png;base64,AA" }]);
    onChunk?.("part");
    onChunk?.("");
    return { chunks: [{ text: "part" }, { text: " done" }], finishReason: "stop" };
  };
  const stream = await hub.chatCompletions(jsonRequest("/v1/chat/completions", {
    model: "model-fast",
    stream: true,
    messages: [{ role: "system", content: "You are concise" }, { role: "user", content: "hello" }, { role: "user", content: "world" }],
    attachments: [{ type: "image", data: "data:image/png;base64,AA" }],
  }));
  const streamText = await stream.text();
  assert.match(streamText, /chat\.completion\.chunk/);
  assert.match(streamText, /part/);
  assert.match(streamText, /data: \[DONE\]/);

  const unverified = await hub.chatCompletions(jsonRequest("/v1/chat/completions", {
    model: "unknown-model",
    messages: [{ role: "user", content: "hi" }],
  }));
  assert.equal(unverified.status, 422);
  const unverifiedJson = await unverified.json();
  assert.equal(unverifiedJson.error.code, "model_unverified");
  assert.equal(unverifiedJson.error.type, "invalid_request_error");

  let calls = 0;
  hub.conversationCache = "expired";
  hub.resolveConversation = async () => "fresh-conv";
  hub.runChatJob = async (_text, _model, conversation) => {
    calls++;
    if (calls === 1) throw new Error("conversation not found");
    assert.equal(conversation, "fresh-conv");
    return { chunks: [{ text: "retry success" }], finishReason: "stop" };
  };
  const retry = await hub.chatCompletions(jsonRequest("/chat/completions", {
    model: "model-fast", messages: [{ role: "user", content: "retry" }],
  }));
  const retryJson = await responseJson(retry);
  assert.equal(retryJson.choices[0].message.content, "retry success");
  assert.equal(calls, 2);
});

test("ExtHub: chat completion stream and non-stream errors are serialized", async () => {
  const { hub } = connectedHub();
  hub.conversationCache = "conv-error";
  hub.runChatJob = async () => { throw new Error("upstream exploded"); };
  const stream = await hub.chatCompletions(jsonRequest("/v1/chat/completions", {
    stream: true, messages: [{ role: "user", content: "x" }],
  }));
  assert.match(await stream.text(), /upstream exploded/);

  let streamCalls = 0;
  hub.resolveConversation = async () => "retry-conv";
  hub.runChatJob = async () => {
    streamCalls++;
    if (streamCalls === 1) throw new Error("403 unauthorized");
    throw new Error("retry failed");
  };
  const retryStream = await hub.chatCompletions(jsonRequest("/v1/chat/completions", {
    stream: true, messages: [{ role: "user", content: "x" }],
  }));
  assert.match(await retryStream.text(), /retry failed/);

  hub.resolveConversation = async () => "conv-error";
  hub.runChatJob = async () => { throw new Error("ordinary failure"); };
  const ordinary = await hub.chatCompletions(jsonRequest("/v1/chat/completions", {
    messages: [{ role: "user", content: "x" }],
  }));
  assert.equal(ordinary.status, 502);
  assert.match((await responseJson(ordinary)).error.message, /ordinary failure/);
});

test("ExtHub: native endpoints cover models, streaming, grounding, retries, and errors", async () => {
  const disconnected = new ExtHub({}, {});
  const unavailable = await disconnected.nativeChatCompletions(jsonRequest("/v1/native/chat/completions", { messages: [] }));
  assert.equal(unavailable.status, 503);

  const { hub } = connectedHub();
  const models = await hub.nativeModels();
  assert.equal((await responseJson(models)).data.length, 2);
  hub.conversationCache = "native-conv";
  hub.runNativeJob = async (_body, _conversation, onChunk) => {
    onChunk?.("native part");
    return { chunks: [{ text: "native output" }], finishReason: "stop", groundingMetadata: { source: "example" } };
  };
  const nonStream = await hub.nativeChatCompletions(jsonRequest("/v1/native/chat/completions", {
    model: "model-fast", messages: [{ role: "user", content: "hello" }],
  }));
  const nonStreamJson = await responseJson(nonStream);
  assert.equal(nonStreamJson.grounding_metadata.source, "example");

  const stream = await hub.nativeChatCompletions(jsonRequest("/native/chat/completions", {
    stream: true, messages: [{ role: "user", content: "hello" }],
  }));
  const streamText = await stream.text();
  assert.match(streamText, /grounding_metadata/);
  assert.match(streamText, /native part/);

  let calls = 0;
  hub.resolveConversation = async () => "native-fresh";
  hub.runNativeJob = async () => {
    calls++;
    if (calls === 1) throw new Error("404 conversation not found");
    return { chunks: [{ text: "native retry" }], finishReason: "stop" };
  };
  const retry = await hub.nativeChatCompletions(jsonRequest("/v1/native/chat/completions", { messages: [] }));
  assert.equal((await responseJson(retry)).choices[0].message.content, "native retry");

  hub.runNativeJob = async () => { throw new Error("native failure"); };
  const failed = await hub.nativeChatCompletions(jsonRequest("/v1/native/chat/completions", { messages: [] }));
  assert.equal(failed.status, 502);

  const nativeDisconnectedJob = new ExtHub({}, {});
  await assert.rejects(nativeDisconnectedJob.runNativeJob({}, "conv"), /no extension connected/);
});

test("ExtHub: runNativeJob dispatches native payload and resolves through extPost", async () => {
  const { hub, writes } = connectedHub();
  const resultPromise = hub.runNativeJob({ query: "hello" }, "native-conv");
  const event = writes.at(-1);
  const jobId = event.match(/"jobId":"([^"]+)"/)[1];
  await hub.extPost(jsonRequest("/ext/done", { jobId, finishReason: "stop" }), "done");
  const result = await resultPromise;
  assert.equal(result.finishReason, "stop");
  assert.equal(hub.jobs.size, 0);
});

test("ExtHub: MCP protocol methods, tools, success, and unknown requests", async () => {
  const { hub } = connectedHub();
  hub.conversationCache = "mcp-conv";
  hub.modelCatalog = [{ id: "model-fast", name: "Fast", free: true, kind: "chat", tier: "free", use_case: "chat" }];
  hub.runChatJob = async (prompt) => ({ chunks: [{ text: `answer:${prompt}` }], finishReason: "stop" });

  const invalid = await hub.handleMcp(new Request("https://hub.internal/mcp", { method: "POST", body: "not-json" }));
  assert.equal(invalid.status, 400);
  assert.equal((await responseJson(invalid)).error, "invalid JSON");

  const initialize = await hub.handleMcp(rpcRequest("initialize", { protocolVersion: "2025-01-01" }));
  assert.equal((await responseJson(initialize)).result.protocolVersion, "2025-01-01");
  const initialized = await hub.handleMcp(rpcRequest("notifications/initialized"));
  assert.equal(initialized.status, 200);
  const listed = await hub.handleMcp(rpcRequest("tools/list"));
  assert.equal((await responseJson(listed)).result.tools.length, 5);

  const chat = await hub.handleMcp(rpcRequest("tools/call", {
    name: "bridge_chat", arguments: { prompt: "hello", attachments: [] },
  }));
  assert.match((await responseJson(chat)).result.content[0].text, /answer:hello/);

  hub.refreshModels = async () => hub.modelsList();
  const listModels = await hub.handleMcp(rpcRequest("tools/call", { name: "bridge_list_models", arguments: {} }));
  assert.match((await responseJson(listModels)).result.content[0].text, /model-fast/);
  const status = await hub.handleMcp(rpcRequest("tools/call", { name: "bridge_status", arguments: {} }));
  assert.match((await responseJson(status)).result.content[0].text, /CONNECTED/);

  for (const style of ["bullet", "detailed", "short", "concise"]) {
    const summary = await hub.handleMcp(rpcRequest("tools/call", {
      name: "summarize", arguments: { text: "long text", style },
    }));
    assert.match((await responseJson(summary)).result.content[0].text, /answer:/);
  }
  const search = await hub.handleMcp(rpcRequest("tools/call", {
    name: "web_search", arguments: { query: "bridge", max_results: 99 },
  }));
  const searchText = (await responseJson(search)).result.content[0].text;
  assert.match(searchText, /answer:/);
  assert.match(searchText, /"bridge"/);
  assert.match(searchText, /up to 10 results/);

  const unknownTool = await hub.handleMcp(rpcRequest("tools/call", { name: "missing_tool", arguments: {} }));
  assert.equal((await responseJson(unknownTool)).error.code, -32601);
  const unknownMethod = await hub.handleMcp(rpcRequest("missing", {}));
  assert.equal((await responseJson(unknownMethod)).error.code, -32601);
});

test("ExtHub: MCP errors, offline paths, and conversation retry are returned as protocol content", async () => {
  const offline = new ExtHub({}, {});
  const offlineChat = await offline.handleMcp(rpcRequest("tools/call", { name: "bridge_chat", arguments: { prompt: "x" } }));
  assert.equal((await responseJson(offlineChat)).result.isError, true);
  const offlineSearch = await offline.handleMcp(rpcRequest("tools/call", { name: "web_search", arguments: {} }));
  assert.equal((await responseJson(offlineSearch)).result.isError, true);
  const offlineSummary = await offline.handleMcp(rpcRequest("tools/call", { name: "summarize", arguments: {} }));
  assert.equal((await responseJson(offlineSummary)).result.isError, true);

  const { hub } = connectedHub();
  let calls = 0;
  hub.resolveConversation = async () => `mcp-conv-${calls}`;
  hub.runChatJob = async () => {
    calls++;
    if (calls === 1) throw new Error("conversation not found");
    return { chunks: [{ text: "retried" }] };
  };
  const retry = await hub.handleMcp(rpcRequest("tools/call", { name: "bridge_chat", arguments: { prompt: "retry" } }));
  assert.equal((await responseJson(retry)).result.content[0].text, "retried");

  hub.runChatJob = async () => { throw new Error("mcp upstream failure"); };
  const failed = await hub.handleMcp(rpcRequest("tools/call", { name: "bridge_chat", arguments: { prompt: "fail" } }));
  assert.equal((await responseJson(failed)).result.isError, true);
});

test("ExtHub: status, registry, and route dispatch cover health, CORS, config, and errors", async () => {
  const { hub, writes } = connectedHub();
  hub.extConnectedAt = Date.now();
  hub.lastJob = { jobId: "job", kind: "chat" };
  hub.lastPost = { kind: "done" };
  hub.lastError = "last error";
  hub.lastDispatchedTab = { tabId: 1 };
  hub.modelCatalog = [{ id: "model-fast", provider: "provider", name: "Fast", free: true, kind: "chat", description: "fast" }];
  hub.refreshModels = async () => hub.modelsList();

  const status = await hub.status("hub.internal");
  const statusBody = await responseJson(status);
  assert.equal(statusBody.extension, "CONNECTED");
  assert.equal(statusBody.mcp_endpoint, "https://hub.internal/mcp");
  assert.equal("pendingJobIds" in statusBody, false, "public /status must not leak pendingJobIds");
  assert.equal("lastJob" in statusBody, false, "public /status must not leak lastJob");
  assert.equal("lastPost" in statusBody, false, "public /status must not leak lastPost");
  assert.equal("lastError" in statusBody, false, "public /status must not leak lastError");
  assert.equal("lastDispatchedTab" in statusBody, false, "public /status must not leak lastDispatchedTab");
  assert.equal("cached_conversation_id" in statusBody, false, "public /status must not leak cached_conversation_id");
  const registry = await hub.registry("hub.internal");
  assert.equal((await responseJson(registry)).data[0].id, "model-fast");
  assert.equal(typeof (await responseJson(await hub.fetch(new Request("https://hub.internal/v1/models", { method: "GET" })))).data[0].created, "number", "/v1/models entries must include created timestamp");

  const options = await hub.fetch(new Request("https://hub.internal/status", { method: "OPTIONS" }));
  assert.equal(options.status, 204);
  const tab = await hub.fetch(jsonRequest("/ext/tab", { tabId: 3 }));
  assert.equal((await responseJson(tab)).ok, true);
  const reload = await hub.fetch(new Request("https://hub.internal/reload", { method: "POST" }));
  assert.equal((await responseJson(reload)).ok, true);
  const reloadTab = await hub.fetch(new Request("https://hub.internal/ext/reload-tab", { method: "POST" }));
  assert.equal((await responseJson(reloadTab)).ok, true);
  assert.ok(writes.some((line) => line.includes("reload_extension")));
  assert.ok(writes.some((line) => line.includes("reload_tab")));

  const disconnected = new ExtHub({}, {});
  assert.equal((await responseJson(await disconnected.fetch(new Request("https://hub.internal/reload", { method: "POST" })))).ok, false);
  assert.equal((await responseJson(await disconnected.fetch(new Request("https://hub.internal/ext/reload-tab", { method: "POST" })))).ok, false);

  const message = await hub.fetch(new Request("https://hub.internal/bridge/message", { method: "POST" }));
  assert.equal((await responseJson(message)).protocolVersion, 2);
  const config = await hub.fetch(jsonRequest("/config", { defaultModel: "  configured-model  " }));
  assert.equal((await responseJson(config)).defaultModel, "configured-model");
  const invalidConfig = await hub.fetch(jsonRequest("/config", { defaultModel: " " }));
  assert.equal((await responseJson(invalidConfig)).defaultModel, "configured-model");
  const models = await hub.fetch(new Request("https://hub.internal/models", { method: "GET" }));
  assert.equal((await responseJson(models)).data[0].id, "model-fast");
  const registryModels = await hub.fetch(new Request("https://hub.internal/registry/models", { method: "GET" }));
  assert.equal((await responseJson(registryModels)).data.length, 1);
  const root = await hub.fetch(new Request("https://hub.internal/", { method: "GET" }));
  assert.equal((await responseJson(root)).ok, true);
  const notFound = await hub.fetch(new Request("https://hub.internal/unknown", { method: "GET" }));
  assert.equal(notFound.status, 404);
});

test("Edge worker: CORS, public health, strict dual-role auth, missing secrets, and DO forwarding", async () => {
  const options = await worker.fetch(new Request("https://bridge.example.workers.dev/v1/models", { method: "OPTIONS" }), {});
  assert.equal(options.status, 204);

  const publicRoot = await worker.fetch(new Request("https://bridge.example.workers.dev/", { method: "GET" }), {
    BRIDGE_SECRET: "secret", CLIENT_API_KEY: "key",
  });
  assert.equal((await responseJson(publicRoot)).environment, "local-dev");

  const doEnv = {
    BRIDGE_SECRET: "secret",
    CLIENT_API_KEY: "key",
    EXT_HUB: { idFromName: () => "id", get: () => ({ fetch: async () => new Response("ok") }) },
  };
  const unauthRegistry = await worker.fetch(new Request("https://bridge.example.workers.dev/registry/models", { method: "GET" }), doEnv);
  assert.equal(unauthRegistry.status, 401);

  const unauthorized = await worker.fetch(new Request("https://bridge.example.workers.dev/v1/models", { method: "GET" }), doEnv);
  assert.equal(unauthorized.status, 401);

  const queryTokenRejected = await worker.fetch(new Request("https://bridge.example.workers.dev/v1/models?token=key", { method: "GET" }), doEnv);
  assert.equal(queryTokenRejected.status, 401, "?token= query parameter must never authenticate");

  const bridgeSecretOnClientRoute = await worker.fetch(new Request("https://bridge.example.workers.dev/v1/models", {
    method: "GET", headers: { "x-bridge-token": "secret" },
  }), doEnv);
  assert.equal(bridgeSecretOnClientRoute.status, 401, "BRIDGE_SECRET must not authorize client endpoints");

  const clientKeyOnExtRoute = await worker.fetch(new Request("https://bridge.example.workers.dev/ext/events", {
    method: "GET", headers: { authorization: "Bearer key" },
  }), doEnv);
  assert.equal(clientKeyOnExtRoute.status, 401, "CLIENT_API_KEY must not authorize extension endpoints");

  const bridgeSecretOnExtRoute = await worker.fetch(new Request("https://bridge.example.workers.dev/ext/events", {
    method: "GET", headers: { "x-bridge-token": "secret" },
  }), doEnv);
  assert.equal(bridgeSecretOnExtRoute.status, 200);

  const byHeader = await worker.fetch(new Request("https://bridge.example.workers.dev/v1/models", {
    method: "GET", headers: { authorization: "Bearer key" },
  }), doEnv);
  assert.equal(byHeader.status, 200);
  const noSecrets = await worker.fetch(new Request("https://bridge.example.workers.dev/v1/models", { method: "GET" }), {});
  assert.equal(noSecrets.status, 503);

  let forwarded;
  const stub = { fetch: async (request) => { forwarded = request; return new Response("forwarded", { status: 201 }); } };
  const env = {
    BRIDGE_TOKEN: "shared",
    EXT_HUB: {
      idFromName: (name) => { assert.equal(name, "singleton"); return "id"; },
      get: (id) => { assert.equal(id, "id"); return stub; },
    },
  };
  const forwardedResponse = await worker.fetch(new Request("https://bridge.example.workers.dev/v1/models", {
    method: "GET", headers: { "x-bridge-token": "shared" },
  }), env);
  assert.equal(forwardedResponse.status, 201);
  assert.equal(forwarded.url, "https://bridge.example.workers.dev/v1/models");
});

test("Edge worker: protected authorization accepts single shared BRIDGE_TOKEN fallback for both roles", async () => {
  const calls = [];
  const env = {
    BRIDGE_TOKEN: "shared",
    EXT_HUB: {
      idFromName: () => "singleton",
      get: () => ({ fetch: async (request) => { calls.push(request.url); return new Response("ok"); } }),
    },
  };
  const viaBearer = await worker.fetch(new Request("https://bridge.example.workers.dev/ext/events", {
    method: "GET", headers: { authorization: "Bearer shared" },
  }), env);
  assert.equal(viaBearer.status, 200);
  assert.equal(calls.length, 1);
});

test("ExtHub: FIFO queue processes sequentially and rejects overflow with 429 queue_full", async () => {
  const writes = [];
  const hub = new ExtHub({}, { QUEUE_MAX_SIZE: "2", QUEUE_TIMEOUT_MS: "500" });
  hub.extWriter = { write: async (enc) => { writes.push(new TextDecoder().decode(enc)); } };
  hub.extReady = true;
  hub.conversationCache = "conv-q";

  const order = [];
  let releaseFirst;
  const firstGate = new Promise((r) => { releaseFirst = r; });
  hub.runChatJob = async (text) => {
    order.push(`start:${text}`);
    if (text === "first") await firstGate;
    order.push(`end:${text}`);
    return { chunks: [{ text: `reply:${text}` }], finishReason: "stop" };
  };

  // Request 1 acquires the active execution slot; Requests 2 & 3 fill QUEUE_MAX_SIZE=2.
  const p1 = hub.chatCompletions(jsonRequest("/v1/chat/completions", { messages: [{ role: "user", content: "first" }] }));
  await new Promise((r) => setTimeout(r, 10));
  const p2 = hub.chatCompletions(jsonRequest("/v1/chat/completions", { messages: [{ role: "user", content: "second" }] }));
  const p3 = hub.chatCompletions(jsonRequest("/v1/chat/completions", { messages: [{ role: "user", content: "third" }] }));
  // Request 4 exceeds QUEUE_MAX_SIZE=2 and must immediately return 429 queue_full.
  const overflow = await hub.chatCompletions(jsonRequest("/v1/chat/completions", { messages: [{ role: "user", content: "fourth" }] }));
  assert.equal(overflow.status, 429);
  const overflowBody = await overflow.json();
  assert.equal(overflowBody.error.code, "queue_full");
  assert.equal(overflowBody.error.type, "rate_limit_error");

  releaseFirst();
  const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(r3.status, 200);
  assert.deepEqual(order, ["start:first", "end:first", "start:second", "end:second", "start:third", "end:third"]);
});

test("ExtHub: AbortSignal emits event: abort and cleans up pending job, sessionEpoch rejects stale posts (409)", async () => {
  const { hub, writes } = connectedHub();
  const ctrl1 = new AbortController();
  const sseRes = await hub.extEvents(new Request("https://hub.internal/ext/events", { signal: ctrl1.signal }));
  const reader = sseRes.body.getReader();
  const readyText = new TextDecoder().decode((await reader.read()).value);
  const epochMatch = readyText.match(/"sessionEpoch":(\d+)/);
  assert.ok(epochMatch, "ready event must include numeric sessionEpoch");
  const epoch1 = Number(epochMatch[1]);

  // Swap extWriter to spy on abort event while keeping connected
  const jobWrites = [];
  hub.extWriter = { write: async (enc) => { jobWrites.push(new TextDecoder().decode(enc)); } };
  const clientAbort = new AbortController();
  const jobPromise = hub.runJob({ kind: "chat", modelId: "model-example", text: "cancel me" }, null, clientAbort.signal);
  clientAbort.abort();
  await assert.rejects(jobPromise, /abort/i);
  assert.ok(jobWrites.some((w) => w.includes("event: abort")), "aborting request must send event: abort to extension");
  assert.equal(hub.jobs.size, 0);

  // New extension connection bumps epoch and rejects stale epoch posts with 409
  const ctrl2 = new AbortController();
  const sseRes2 = await hub.extEvents(new Request("https://hub.internal/ext/events", { signal: ctrl2.signal }));
  const reader2 = sseRes2.body.getReader();
  const readyText2 = new TextDecoder().decode((await reader2.read()).value);
  const epoch2 = Number(readyText2.match(/"sessionEpoch":(\d+)/)[1]);
  assert.ok(epoch2 > epoch1, "sessionEpoch must monotonically increase on reconnect");

  const staleRes = await hub.extPost(jsonRequest("/ext/chunk", {
    jobId: "any", sessionEpoch: epoch1, parts: [{ kind: "text", text: "stale" }],
  }), "chunk");
  assert.equal(staleRes.status, 409);
  const staleJson = await staleRes.json();
  assert.equal(staleJson.error.code, "session_epoch_mismatch");

  ctrl1.abort();
  ctrl2.abort();
  await reader.cancel().catch(() => {});
  await reader2.cancel().catch(() => {});
});

test("ExtHub: respects DEFAULT_MODEL from Worker env", () => {
  const hub = new ExtHub({}, { DEFAULT_MODEL: "custom-env-model" });
  assert.equal(hub.defaultModel, "custom-env-model");
});

test("Edge worker: Client-IP rate limiting rejects excessive requests with 429 rate_limit_exceeded", async () => {
  // Test 1: Cloudflare env.RATE_LIMITER binding failure
  const rateLimiterMock = {
    limit: async ({ key }) => ({ success: key !== "blocked-ip" }),
  };
  const envWithBinding = {
    BRIDGE_SECRET: "bridge",
    CLIENT_API_KEY: "client",
    RATE_LIMITER: rateLimiterMock,
    EXT_HUB: {
      idFromName: () => "id",
      get: () => ({ fetch: async () => new Response(JSON.stringify({ ok: true })) }),
    },
  };

  const blockedReq = new Request("https://hub.example/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
      "cf-connecting-ip": "blocked-ip",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const blockedRes = await worker.fetch(blockedReq, envWithBinding);
  assert.equal(blockedRes.status, 429);
  const blockedBody = await blockedRes.json();
  assert.equal(blockedBody.error.code, "rate_limit_exceeded");
  assert.equal(blockedBody.error.type, "rate_limit_error");
  assert.equal(blockedRes.headers.get("retry-after"), "60");

  const allowedReq = new Request("https://hub.example/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
      "cf-connecting-ip": "allowed-ip",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const allowedRes = await worker.fetch(allowedReq, envWithBinding);
  assert.equal(allowedRes.status, 200);

  // Test 2: In-memory sliding-window fallback limiter (CLIENT_RATE_LIMIT_MAX)
  const envWithSlidingWindow = {
    BRIDGE_SECRET: "bridge",
    CLIENT_API_KEY: "client",
    CLIENT_RATE_LIMIT_MAX: "2",
    EXT_HUB: envWithBinding.EXT_HUB,
  };
  const makeReq = () => new Request("https://hub.example/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer client",
      "content-type": "application/json",
      "cf-connecting-ip": "sliding-ip",
    },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  const r1 = await worker.fetch(makeReq(), envWithSlidingWindow);
  assert.equal(r1.status, 200);
  const r2 = await worker.fetch(makeReq(), envWithSlidingWindow);
  assert.equal(r2.status, 200);
  const r3 = await worker.fetch(makeReq(), envWithSlidingWindow);
  assert.equal(r3.status, 429);
  const r3Body = await r3.json();
  assert.equal(r3Body.error.code, "rate_limit_exceeded");
});

test("ExtHub: Cloudflare KV caches model catalog and seeds cold start", async () => {
  const kvStore = new Map();
  const mockKv = {
    get: async (key, type) => {
      const val = kvStore.get(key);
      if (!val) return null;
      return type === "json" ? JSON.parse(val) : val;
    },
    put: async (key, val, options) => {
      kvStore.set(key, val);
    },
  };

  // Seed KV with a cached model catalog
  kvStore.set("model_catalog", JSON.stringify({
    models: [
      { id: "kv-cached-fast", name: "KV Fast", ready: true, selectable: true, free: true, kind: "chat" },
      { id: "kv-cached-reasoning", name: "KV Reasoning", ready: true, selectable: true, free: false, kind: "chat" },
    ],
    defaultModel: "kv-cached-fast",
    timestamp: Date.now() - 5000,
  }));

  // Create a fresh ExtHub with MODELS_KV on cold start
  const hub = new ExtHub({}, { MODELS_KV: mockKv });
  assert.equal(hub.modelCatalog.length, 0);

  // Calling refreshModels() on cold start should load directly from KV cache
  const models = await hub.refreshModels();
  assert.equal(models.length, 2);
  assert.equal(models[0].id, "kv-cached-fast");
  assert.equal(hub.defaultModel, "kv-cached-fast");

  // When loader delivers fresh data, put should update KV
  hub.runLoaderJob = async () => JSON.stringify([
    { conversationId: "c1", id: "fresh-model", ready: true, selectable: true, kind: "chat" },
  ]);
  const freshModels = await hub.refreshModels(true);
  assert.ok(freshModels.length > 0);
  const savedKv = JSON.parse(kvStore.get("model_catalog"));
  assert.ok(savedKv.models.length > 0);
});

test("Chrome Extension: background.js implements periodic tab health probing", () => {
  const bgPath = path.join(__dirname, "../packages/core/browser-bridge/extension/background.js");
  const bg = fs.readFileSync(bgPath, "utf8");
  assert.ok(bg.includes("probeTabHealth"), "background.js must define probeTabHealth");
  assert.ok(bg.includes("startTabHealthProbe"), "background.js must define startTabHealthProbe");
});
