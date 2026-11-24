// Cloudflare Worker: Browser Edge Bridge Cloud Hub (Durable Object Relay)
// Generic scaffolding for relaying browser sessions to OpenAI-compatible API & Remote MCP.

const MODEL_FALLBACK = ["model-example", "model-fast", "model-reasoning"];

// Models list loader (same-origin .data route the web UI itself uses).
const MODELS_LOADER_URL = "/loaders/list-models.data?_routes=routes%2Floaders%2Flist-models";
const CONVERSATIONS_LOADER_URL = "/loaders/list-conversations.data?_routes=routes%2Floaders%2Flist-converstaions";

// Native feature flag
const NATIVE_ENABLED = (globalThis.NATIVE_ENABLED ?? "true") === "true";

// ── Model classification ─────────────────────────────────────────────────────
const KIND_IDS = {
  image: ["model-image-example", "mock-remote-image"],
  video: ["model-video-example", "mock-remote-video"],
  music: ["model-music-example", "mock-remote-music"],
  research: ["model-research-example", "deep-research-example"],
};
const KIND_BY_ID = new Map(Object.entries(KIND_IDS).flatMap(([kind, ids]) => ids.map((id) => [id, kind])));
const KIND_PATTERNS = [
  ["image", /image|-image$|image-preview/i],
  ["video", /video|^video-|^anim/i],
  ["music", /music|audio/i],
  ["research", /deep-research|research/i],
];
const kindOf = (id) => KIND_BY_ID.get(id) ?? KIND_PATTERNS.find(([, re]) => re.test(id))?.[0] ?? "chat";

// ── Model skill classification ───────────────────────────────────────────────
const SKILL_RULES = [
  [/fast|lite|free/i, { tier: "free", use_case: "General tasks, chat, summarization — fast and free tier, default selection" }],
  [/research/i, { tier: "paid", use_case: "Deep research across multiple sources with citations" }],
  [/reason|complex|pro|large/i, { tier: "paid", use_case: "Complex reasoning, coding, and architecture planning" }],
];
const skillFor = (id) => {
  const hit = SKILL_RULES.find(([re]) => re.test(id));
  if (hit) return { tier: hit[1].tier, use_case: hit[1].use_case };
  return { tier: "paid", use_case: "Standard chat model" };
};

// Ported from the local bridge: walk the decoded catalog pool and collect
// ready+selectable chat/media models.
function extractModels(decoded) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) return v.forEach(walk);
    if (!v || typeof v !== "object") return;
    const id = v.id ?? v.modelId;
    if (typeof id === "string" && id && !out.some((m) => m.id === id)) {
      const kind = kindOf(id);
      out.push({
        id,
        name: v.displayName ?? v.name ?? id,
        provider: v.providerName ?? v.provider ?? null,
        description: v.description ?? null,
        kind,
        free: v.isFreeCredit === true,
        ready: v.ready !== false,
        selectable: v.selectable !== false,
        isDefault: v.isDefault === true,
      });
    }
    Object.values(v).forEach(walk);
  };
  walk(decoded);
  return out.filter((m) => m.ready && m.selectable);
}

// Ported from the local bridge: data loaders answer with a flat
// reference pool (turbo-stream encoding); decode back to a plain object tree.
function decodeTurboStream(text) {
  const flat = JSON.parse(text);
  const seen = new Map();
  const resolve = (ref) => {
    if (typeof ref !== "number") return ref;
    if (ref < 0) return null;
    if (seen.has(ref)) return seen.get(ref);
    const v = flat[ref];
    if (Array.isArray(v)) {
      const out = [];
      seen.set(ref, out);
      for (const e of v) out.push(resolve(e));
      return out;
    }
    if (v && typeof v === "object") {
      const out = {};
      seen.set(ref, out);
      for (const [k, valueRef] of Object.entries(v)) out[resolve(Number(k.slice(1)))] = resolve(valueRef);
      return out;
    }
    seen.set(ref, v);
    return v;
  };
  return resolve(0);
}

function findValue(node, key) {
  if (Array.isArray(node)) {
    for (const v of node) { const hit = findValue(v, key); if (hit != null) return hit; }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (typeof node[key] === "string") return node[key];
  for (const v of Object.values(node)) { const hit = findValue(v, key); if (hit != null) return hit; }
  return null;
}

export { decodeTurboStream, findValue, extractModels, kindOf, timingSafeEquals };

function parsePositiveInt(val, fallback) {
  const n = Number.parseInt(String(val ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function extractMessageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).filter(Boolean).join("\n");
  }
  return content == null ? "" : String(content);
}

function formatMessagesPrompt(messages) {
  if (!Array.isArray(messages) || !messages.length) return "Hello";
  const systemParts = messages
    .filter((m) => m?.role === "system")
    .map((m) => extractMessageText(m.content))
    .filter(Boolean);
  const nonSystemParts = messages
    .filter((m) => m?.role !== "system")
    .map((m) => {
      const txt = extractMessageText(m?.content);
      if (!txt) return "";
      return m?.role === "assistant" ? `Assistant: ${txt}` : txt;
    })
    .filter(Boolean);
  const blocks = [];
  if (systemParts.length) blocks.push(`System: ${systemParts.join("\n")}`);
  if (nonSystemParts.length) blocks.push(nonSystemParts.join("\n"));
  return blocks.join("\n\n") || "Hello";
}

function isSecondaryModelId(modelId) {
  if (!modelId) return false;
  const mid = String(modelId).toLowerCase();
  return mid === "secondary-session-model" || /(?:^|[:/])secondary|secondary-model/i.test(mid);
}

async function timingSafeEquals(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b) return false;
  const enc = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const viewA = new Uint8Array(hashA);
  const viewB = new Uint8Array(hashB);
  if (typeof crypto?.subtle?.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(viewA, viewB);
  }
  let diff = 0;
  for (let i = 0; i < viewA.length; i++) diff |= viewA[i] ^ viewB[i];
  return diff === 0;
}

export class ExtHub {
  constructor(state, env) {
    this.env = env || {};
    this.extWriter = null;      // SSE writer currently held for the extension
    this.extReady = false;      // extension sent its `ready` event
    this.sessionEpoch = 0;
    this.jobs = new Map();      // jobId -> {chunks: [], resolve, reject, timer}
    this.models = MODEL_FALLBACK;
    const envDefaultModel = typeof this.env?.DEFAULT_MODEL === "string" && this.env.DEFAULT_MODEL.trim()
      ? this.env.DEFAULT_MODEL.trim()
      : null;
    this.envDefaultModel = envDefaultModel;
    this.defaultModel = envDefaultModel || MODEL_FALLBACK[0];
    this.lastExtSeen = 0;
    this.tabsReported = false;
    this.attachedTabs = { primary: false, secondary: false };
    this.queueMaxSize = parsePositiveInt(this.env?.QUEUE_MAX_SIZE, 10);
    this.queueTimeoutMs = parsePositiveInt(this.env?.QUEUE_TIMEOUT_MS, 60000);
    this.requestQueue = [];
    this.requestBusy = false;
    // T1 latency: reuse one temporary conversation per DO instead of minting
    // a fresh one for every chat (saves a full create round-trip per call).
    this.conversationCache = null;
    // T2 dynamic model catalog from the extension session (TTL 60s).
    this.modelCatalog = [];
    this.modelCatalogAt = 0;
    this.modelRefresh = null;
    this.catalogRevision = 0;
    // T1 measured chat latency (last successful chat, ms).
    this.lastChatLatencyMs = null;
  }

  // ---------- helpers ----------
  sseLine(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  get isExtConnected() {
    return this.extWriter !== null && this.extReady;
  }

  isTabReadyForModel(modelId) {
    if (!this.isExtConnected) return false;
    if (!this.tabsReported) return true;
    if (isSecondaryModelId(modelId)) return Boolean(this.attachedTabs.secondary);
    return Boolean(this.attachedTabs.primary || this.attachedTabs.secondary);
  }

  async enqueueRequest(signal = null) {
    if (signal?.aborted) {
      const err = new Error("request aborted");
      err.code = "request_aborted";
      throw err;
    }
    if (!this.requestBusy) {
      this.requestBusy = true;
      return () => this.releaseRequest();
    }
    if (this.requestQueue.length >= this.queueMaxSize) {
      const err = new Error(`Request queue full (max ${this.queueMaxSize} pending)`);
      err.code = "queue_full";
      err.status = 429;
      throw err;
    }
    await new Promise((resolve, reject) => {
      const entry = { resolve: null, reject: null, timer: null, aborted: false };
      const onAbort = () => {
        entry.aborted = true;
        clearTimeout(entry.timer);
        const idx = this.requestQueue.indexOf(entry);
        if (idx !== -1) this.requestQueue.splice(idx, 1);
        const err = new Error("request aborted");
        err.code = "request_aborted";
        reject(err);
      };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      entry.resolve = () => {
        if (signal) signal.removeEventListener("abort", onAbort);
        clearTimeout(entry.timer);
        resolve();
      };
      entry.reject = (err) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        clearTimeout(entry.timer);
        reject(err);
      };
      entry.timer = setTimeout(() => {
        const idx = this.requestQueue.indexOf(entry);
        if (idx !== -1) this.requestQueue.splice(idx, 1);
        const err = new Error(`queue wait timeout after ${this.queueTimeoutMs}ms`);
        err.code = "queue_timeout";
        err.status = 504;
        entry.reject(err);
      }, this.queueTimeoutMs);
      this.requestQueue.push(entry);
    });
    return () => this.releaseRequest();
  }

  releaseRequest() {
    while (this.requestQueue.length) {
      const next = this.requestQueue.shift();
      if (!next.aborted) {
        next.resolve();
        return;
      }
    }
    this.requestBusy = false;
  }

  // ---------- extension channel (same paths as the local bridge) ----------
  async extEvents(request) {
    // SSE hold — same as bridge server.mjs extEvents()
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    if (this.extWriter) {
      try { this.extWriter.close(); } catch {}
    }
    this.extWriter = writer;
    this.sessionEpoch = Math.max((this.sessionEpoch || 0) + 1, Date.now());
    this.extReady = true;
    this.lastExtSeen = Date.now();
    this.extConnectedAt = Date.now();
    const enc = new TextEncoder();

    // Greet exactly like the local bridge does (carries monotonic sessionEpoch)
    writer.write(enc.encode(this.sseLine("ready", {
      clientId: "cf-hub",
      sessionEpoch: this.sessionEpoch,
    }))).catch(() => {});

    // T1/T2 pre-warm: refresh the model catalog and mint a reusable temporary
    // conversation right after the extension connects, so the first chat has
    // zero bootstrap latency. Fire-and-forget — never block the stream.
    setTimeout(() => {
      if (this.extWriter === writer) {
        this.refreshModels().catch(() => {});
        this.resolveConversation(this.defaultModel).catch(() => {});
      }
    }, 100);

    // Heartbeat comment keeps intermediaries from closing the stream
    const ping = setInterval(() => {
      writer.write(enc.encode(": ping\n\n")).catch(() => clearInterval(ping));
    }, 15000);

    // Extension reconnects every ~4 min (Chrome service-worker ceiling);
    // clean up when the stream cancels — ONLY if this is still the active writer.
    request.signal.addEventListener("abort", () => {
      clearInterval(ping);
      if (this.extWriter === writer) {
        this.extWriter = null;
        this.extReady = false;
        this.tabsReported = false;
        this.attachedTabs = { primary: false, secondary: false };
        for (const [jobId, job] of this.jobs) {
          clearTimeout(job.timer);
          job.reject(new Error("extension disconnected"));
          this.jobs.delete(jobId);
        }
        while (this.requestQueue.length) {
          const queued = this.requestQueue.shift();
          queued.reject(new Error("extension disconnected"));
        }
        this.requestBusy = false;
      }
    });

    return new Response(readable, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "access-control-allow-origin": "*",
      },
    });
  }

  async extPost(request, kind) {
    const body = await request.json().catch(() => ({}));
    if (body?.sessionEpoch != null && this.sessionEpoch > 0 && Number(body.sessionEpoch) !== this.sessionEpoch) {
      return json({
        error: {
          message: `Stale sessionEpoch ${body.sessionEpoch} rejected (active ${this.sessionEpoch})`,
          type: "invalid_request_error",
          code: "session_epoch_mismatch",
        },
      }, 409);
    }
    this.lastPost = { kind, at: Date.now(), message: body?.message || null, jobId: body?.jobId || null };
    const job = this.jobs.get(body.jobId);
    if (!job) return json({ ok: true, note: "unknown jobId (probably reconnected)" });

    if (kind === "chunk") {
      job.chunks.push(...(body.parts || []));
      if (job.onChunk) for (const p of (body.parts || [])) job.onChunk(p?.text ?? "");
    } else if (kind === "done") {
      clearTimeout(job.timer);
      this.jobs.delete(body.jobId);
      job.resolve({ chunks: job.chunks, finishReason: body.finishReason || "stop" });
    } else if (kind === "loader") {
      clearTimeout(job.timer);
      this.jobs.delete(body.jobId);
      if (body.message) job.reject(new Error(body.message));
      else job.resolve({ raw: body.raw || "" });
    } else if (kind === "error") {
      clearTimeout(job.timer);
      this.jobs.delete(body.jobId);
      this.lastError = body.message || "extension error";
      job.reject(new Error(body.message || "extension error"));
    }
    return json({ ok: true });
  }

  // ---------- client API ----------
  // ---------- chat job runner (shared by OpenAI API and MCP tools) ----------
  // Dispatches a job to the connected extension and awaits completion.
  // onChunk(deltaText) is invoked per extension chunk for SSE streaming.
  runJob(payload, onChunk = null, signal = null) {
    if (!this.isExtConnected) {
      return Promise.reject(new Error("no extension connected to the cloud hub"));
    }
    if (signal?.aborted) {
      return Promise.reject(new Error("request aborted"));
    }
    const jobId = crypto.randomUUID();
    const timeoutMs = (payload.kind === "chat" || payload.kind === "create") ? 120000 : 30000;
    const job = { chunks: [], resolve: null, reject: null, timer: null, onChunk, kind: payload.kind };
    const result = new Promise((resolve, reject) => {
      job.resolve = resolve;
      job.reject = reject;
    });
    const onAbort = () => {
      clearTimeout(job.timer);
      if (this.jobs.delete(jobId)) {
        if (this.extWriter) {
          this.extWriter.write(new TextEncoder().encode(this.sseLine("abort", { jobId }))).catch(() => {});
        }
        job.reject(new Error("request aborted"));
      }
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const cleanupSignal = () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const wrappedResult = result.finally(cleanupSignal);

    this.jobs.set(jobId, job);
    this.lastJob = { jobId, kind: payload.kind, at: Date.now() };
    job.timer = setTimeout(() => {
      this.jobs.delete(jobId);
      job.reject(new Error(`timeout waiting for extension (${timeoutMs / 1000}s)`));
    }, timeoutMs);

    // Same event shape the local bridge sends over SSE
    const envelope = {
      jobId,
      ...(this.sessionEpoch > 0 ? { sessionEpoch: this.sessionEpoch } : {}),
      ...payload,
    };
    this.extWriter.write(new TextEncoder().encode(
      this.sseLine("job", envelope)
    )).catch(err => {
      clearTimeout(job.timer);
      this.jobs.delete(jobId);
      job.reject(err);
    });
    return wrappedResult;
  }

  runChatJob(text, modelId, conversationId, onChunk = null, parts = null, signal = null) {
    return this.runJob({
      kind: "chat", modelId, text, conversationId,
      ...(parts && parts.length ? { parts } : {}),
    }, onChunk, signal);
  }

  // Pull existing conversations from the active browser session
  async loadConversations() {
    let timer;
    try {
      const raw = await Promise.race([
        this.runLoaderJob(CONVERSATIONS_LOADER_URL),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("conversations timeout")), 25000); }),
      ]);
      clearTimeout(timer);
      const decoded = decodeTurboStream(raw);
      const list = [];
      const walk = (v) => {
        if (Array.isArray(v)) return v.forEach(walk);
        if (!v || typeof v !== "object") return;
        if (typeof v.id === "string" && typeof v.updatedAt === "string") list.push(v);
        Object.values(v).forEach(walk);
      };
      walk(decoded);
      list.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
      return list;
    } catch (err) {
      clearTimeout(timer);
      console.warn("[hub] loadConversations error:", err?.message || err);
      return [];
    }
  }

  // Resolve conversation: prefer reusing an active one from the session,
  // or mint a fresh temporary conversation.
  async resolveConversation(modelId) {
    if (modelId === "secondary-session-model" || modelId?.includes("secondary") || modelId?.includes("direct")) {
      return "secondary-provider-session";
    }
    if (this.conversationCache) return this.conversationCache;
    const list = await this.loadConversations();
    if (list.length && list[0]?.id) {
      this.conversationCache = list[0].id;
      return list[0].id;
    }
    return this.createConversation(modelId);
  }

  async createConversation(modelId) {
    if (this.conversationCache) return this.conversationCache;
    const raw = await this.runCreateJob(modelId);
    const id = findValue(decodeTurboStream(raw), "conversationId")
      ?? findValue(decodeTurboStream(raw), "id");
    if (!id) throw new Error("could not read a conversation id from create-conversation response");
    this.conversationCache = id;
    return id;
  }

  // T2: dynamic model catalog — pull the live model list from the page via a
  // loader job, decode the turbo-stream pool, classify, TTL-cache 60s.
  async refreshModels(force = false) {
    if (!force && this.modelCatalog.length && Date.now() - this.modelCatalogAt < 60_000) {
      return this.modelCatalog;
    }
    // KV Cache: On cold start or if in-memory catalog is empty, attempt reading from Cloudflare KV
    if (!this.modelCatalog.length && this.env?.MODELS_KV && typeof this.env.MODELS_KV.get === "function") {
      try {
        const cached = await this.env.MODELS_KV.get("model_catalog", "json");
        if (cached && Array.isArray(cached.models) && cached.models.length) {
          this.modelCatalog = cached.models;
          this.models = cached.models.map((m) => m.id);
          this.modelCatalogAt = cached.timestamp || Date.now();
          if (cached.defaultModel) this.defaultModel = cached.defaultModel;
          if (!force) return this.modelCatalog;
        }
      } catch (err) {
        console.warn("[hub] MODELS_KV get error:", err?.message || err);
      }
    }
    if (this.modelRefresh) return this.modelRefresh;
    this.modelRefresh = (async () => {
      let timer;
      try {
        const raw = await Promise.race([
          this.runLoaderJob(MODELS_LOADER_URL),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("loader timeout")), 10000); }),
        ]);
        clearTimeout(timer);
        const models = extractModels(decodeTurboStream(raw));
        if (models.length) {
          this.modelCatalog = models;
          this.modelCatalogAt = Date.now();
          this.catalogRevision++;
          const free = models.filter((m) => m.free).map((m) => m.id);
          if (this.envDefaultModel && models.some((m) => m.id === this.envDefaultModel)) {
            this.defaultModel = this.envDefaultModel;
          } else if (free.includes(this.defaultModel)) {
            // Keep active default
          } else if (free.length) {
            this.defaultModel = free[0];
          } else if (models.length) {
            this.defaultModel = models[0].id;
          }
          // Persist to Cloudflare KV cache with a 5-minute (300s) TTL
          if (this.env?.MODELS_KV && typeof this.env.MODELS_KV.put === "function") {
            this.env.MODELS_KV.put(
              "model_catalog",
              JSON.stringify({
                models,
                defaultModel: this.defaultModel,
                timestamp: this.modelCatalogAt,
              }),
              { expirationTtl: 300 }
            ).catch((err) => console.warn("[hub] MODELS_KV put error:", err?.message || err));
          }
        }
      } catch {
        clearTimeout(timer);
      }
      finally { this.modelRefresh = null; }
      return this.modelsList();
    })();
    return this.modelRefresh;
  }

  modelsList() {
    if (!this.modelCatalog.length) {
      return MODEL_FALLBACK.map((id) => ({
        id, name: id, provider: null, free: id.includes("fast") || id.includes("lite") || id.includes("free"),
        kind: kindOf(id), ...skillFor(id), description: null,
      }));
    }
    return this.modelCatalog.map((m) => ({ ...m, ...skillFor(m.id) }));
  }

  runCreateJob(modelId) {
    const result = this.runJob({
      kind: "create", modelId,
      message: "Hello",
      requestId: crypto.randomUUID(),
      temporary: true,
    });
    return result.then(r => r.raw);
  }

  runLoaderJob(url) {
    const result = this.runJob({ kind: "loader", url });
    return result.then(r => r.raw);
  }

  async chatCompletions(request) {
    const body = await request.json().catch(() => ({}));
    const modelId = body.model || this.defaultModel;

    if (!this.isExtConnected || !this.isTabReadyForModel(modelId)) {
      return jsonOpenAI(request, 503, {
        error: {
          message: "no extension or attached target tab connected to the cloud hub",
          type: "bridge_error",
          code: "extension_disconnected",
        },
      });
    }

    const availableIds = this.modelCatalog.map((m) => m.id);
    if (body.model && availableIds.length && !availableIds.includes(body.model)) {
      return jsonOpenAI(request, 422, {
        error: {
          message: `Model '${body.model}' is not verified in the active model catalog`,
          type: "invalid_request_error",
          code: "model_unverified",
        },
      });
    }

    let release;
    try {
      release = await this.enqueueRequest(request.signal);
    } catch (err) {
      if (err?.code === "queue_full") {
        return jsonOpenAI(request, 429, {
          error: { message: err.message, type: "rate_limit_error", code: "queue_full" },
        });
      }
      return jsonOpenAI(request, err?.status || 504, {
        error: { message: String(err?.message || err), type: "bridge_error", code: err?.code || "queue_timeout" },
      });
    }

    if (!this.isExtConnected || !this.isTabReadyForModel(modelId)) {
      release();
      return jsonOpenAI(request, 503, {
        error: {
          message: "no extension or attached target tab connected to the cloud hub",
          type: "bridge_error",
          code: "extension_disconnected",
        },
      });
    }

    const text = formatMessagesPrompt(body.messages);
    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${crypto.randomUUID().slice(0, 24)}`;

    if (body.stream) {
      // OpenAI-compatible SSE: deltas as the extension reports chunks.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const frame = (obj) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const sseHeaders = {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "access-control-allow-origin": "*",
      };

      (async () => {
        try {
          frame({ id, object: "chat.completion.chunk", created, model: modelId,
                  choices: [{ index: 0, delta: { role: "assistant" } }] });
          const conversationId = await this.resolveConversation(modelId);
          const { finishReason } = await this.runChatJob(text, modelId, conversationId, (delta) => {
            if (delta) frame({ id, object: "chat.completion.chunk", created, model: modelId,
                               choices: [{ index: 0, delta: { content: delta } }] });
          }, body.attachments, request.signal);
          frame({ id, object: "chat.completion.chunk", created, model: modelId,
                  choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop" }] });
          writer.write(enc.encode("data: [DONE]\n\n"));
          writer.close();
        } catch (err) {
          // Conversation expired mid-session (temporary chats age out): drop the
          // cached id, mint a fresh one, retry the chat exactly once.
          if (/conversation not found|404|403|deleted|unauthorized/i.test(String(err.message || err))) {
            try {
              this.conversationCache = null;
              const conversationId = await this.resolveConversation(modelId);
              const { finishReason } = await this.runChatJob(text, modelId, conversationId, (delta) => {
                if (delta) frame({ id, object: "chat.completion.chunk", created, model: modelId,
                                   choices: [{ index: 0, delta: { content: delta } }] });
              }, body.attachments, request.signal);
              frame({ id, object: "chat.completion.chunk", created, model: modelId,
                      choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop" }] });
              writer.write(enc.encode("data: [DONE]\n\n"));
              return writer.close();
            } catch (retryErr) {
              frame({ id, object: "chat.completion.chunk", created, model: modelId,
                      choices: [{ index: 0, delta: {} }], error: { message: String(retryErr.message || retryErr) } });
              writer.write(enc.encode("data: [DONE]\n\n"));
              return writer.close();
            }
          }
          frame({ id, object: "chat.completion.chunk", created, model: modelId,
                  choices: [{ index: 0, delta: {} }], error: { message: String(err.message || err) } });
          writer.write(enc.encode("data: [DONE]\n\n"));
          writer.close();
        } finally {
          release();
        }
      })();

      return new Response(readable, { status: 200, headers: sseHeaders });
    }

    const started = Date.now();
    try {
      const conversationId = await this.resolveConversation(modelId);
      let chat;
      try {
        chat = await this.runChatJob(text, modelId, conversationId, null, body.attachments, request.signal);
      } catch (err) {
        // Temporary conversation expired → recreate once and retry.
        if (!/conversation not found|404|403|deleted|unauthorized/i.test(String(err.message || err))) throw err;
        this.conversationCache = null;
        const fresh = await this.resolveConversation(modelId);
        chat = await this.runChatJob(text, modelId, fresh, null, body.attachments, request.signal);
      }
      const out = chat.chunks.map(p => p?.text ?? "").join("");
      this.lastChatLatencyMs = Date.now() - started;
      return jsonOpenAI(request, 200, {
        id, object: "chat.completion", created, model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: out }, finish_reason: chat.finishReason }],
        usage: {
          prompt_tokens: Math.ceil(text.length / 4),
          completion_tokens: Math.ceil(out.length / 4),
          total_tokens: Math.ceil((text.length + out.length) / 4),
        },
        latency_ms: this.lastChatLatencyMs,
      });
    } catch (err) {
      return jsonOpenAI(request, 502, {
        error: { message: String(err.message || err), type: "bridge_error", code: "upstream_error" },
      });
    } finally {
      release();
    }
  }

  // ─── Native Direct Endpoints (preserves capabilities, grounding, etc.) ───
  
  async nativeChatCompletions(request) {
    const body = await request.json().catch(() => ({}));
    const modelId = body.model || this.defaultModel;

    if (!this.isExtConnected || !this.isTabReadyForModel(modelId)) {
      return jsonOpenAI(request, 503, {
        error: {
          message: "no extension or attached target tab connected to the cloud hub",
          type: "bridge_error",
          code: "extension_disconnected",
        },
      });
    }

    let release;
    try {
      release = await this.enqueueRequest(request.signal);
    } catch (err) {
      if (err?.code === "queue_full") {
        return jsonOpenAI(request, 429, {
          error: { message: err.message, type: "rate_limit_error", code: "queue_full" },
        });
      }
      return jsonOpenAI(request, err?.status || 504, {
        error: { message: String(err?.message || err), type: "bridge_error", code: err?.code || "queue_timeout" },
      });
    }

    const created = Math.floor(Date.now() / 1000);
    const id = `chatcmpl-${crypto.randomUUID().slice(0, 24)}`;

    if (body.stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const enc = new TextEncoder();
      const frame = (obj) => writer.write(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
      const sseHeaders = {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        "access-control-allow-origin": "*",
      };

      (async () => {
        try {
          frame({ id, object: "chat.completion.chunk", created, model: modelId,
                  choices: [{ index: 0, delta: { role: "assistant" } }] });
          
          const conversationId = await this.resolveConversation(modelId);
          
          const { finishReason, groundingMetadata } = await this.runNativeJob(body, conversationId, (delta) => {
            if (delta) frame({ id, object: "chat.completion.chunk", created, model: modelId,
                               choices: [{ index: 0, delta: { content: delta } }] });
          }, request.signal);
          
          // Include grounding_metadata in final chunk if present
          if (groundingMetadata) {
            frame({ id, object: "chat.completion.chunk", created, model: modelId,
                    choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop", grounding_metadata: groundingMetadata }] });
          } else {
            frame({ id, object: "chat.completion.chunk", created, model: modelId,
                    choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop" }] });
          }
          writer.write(enc.encode("data: [DONE]\n\n"));
          writer.close();
        } catch (err) {
          if (/conversation not found|404/i.test(String(err.message || err))) {
            try {
              this.conversationCache = null;
              const conversationId = await this.resolveConversation(modelId);
              const { finishReason, groundingMetadata } = await this.runNativeJob(body, conversationId, (delta) => {
                if (delta) frame({ id, object: "chat.completion.chunk", created, model: modelId,
                                   choices: [{ index: 0, delta: { content: delta } }] });
              }, request.signal);
              if (groundingMetadata) {
                frame({ id, object: "chat.completion.chunk", created, model: modelId,
                        choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop", grounding_metadata: groundingMetadata }] });
              } else {
                frame({ id, object: "chat.completion.chunk", created, model: modelId,
                        choices: [{ index: 0, delta: {}, finish_reason: finishReason || "stop" }] });
              }
              writer.write(enc.encode("data: [DONE]\n\n"));
              return writer.close();
            } catch (retryErr) {
              frame({ id, object: "chat.completion.chunk", created, model: modelId,
                      choices: [{ index: 0, delta: {} }], error: { message: String(retryErr.message || retryErr) } });
              writer.write(enc.encode("data: [DONE]\n\n"));
              return writer.close();
            }
          }
          frame({ id, object: "chat.completion.chunk", created, model: modelId,
                  choices: [{ index: 0, delta: {} }], error: { message: String(err.message || err) } });
          writer.write(enc.encode("data: [DONE]\n\n"));
          writer.close();
        } finally {
          release();
        }
      })();

      return new Response(readable, { status: 200, headers: sseHeaders });
    }

    // Non-streaming
    const started = Date.now();
    try {
      const conversationId = await this.resolveConversation(modelId);
      let result;
      try {
        result = await this.runNativeJob(body, conversationId, null, request.signal);
      } catch (err) {
        if (!/conversation not found|404/i.test(String(err.message || err))) throw err;
        this.conversationCache = null;
        const fresh = await this.resolveConversation(modelId);
        result = await this.runNativeJob(body, fresh, null, request.signal);
      }
      const out = result.chunks.map(p => p?.text ?? "").join("");
      this.lastChatLatencyMs = Date.now() - started;
      return jsonOpenAI(request, 200, {
        id, object: "chat.completion", created, model: modelId,
        choices: [{ index: 0, message: { role: "assistant", content: out }, finish_reason: result.finishReason }],
        usage: {
          prompt_tokens: Math.ceil(JSON.stringify(body).length / 4),
          completion_tokens: Math.ceil(out.length / 4),
          total_tokens: Math.ceil((JSON.stringify(body).length + out.length) / 4),
        },
        latency_ms: this.lastChatLatencyMs,
        ...(result.groundingMetadata && { grounding_metadata: result.groundingMetadata }),
      });
    } catch (err) {
      return jsonOpenAI(request, 502, {
        error: { message: String(err.message || err), type: "bridge_error", code: "upstream_error" },
      });
    } finally {
      release();
    }
  }

  runNativeJob(body, conversationId, onChunk = null, signal = null) {
    return this.runJob({
      kind: "native",
      payload: body,
      conversationId,
    }, onChunk, signal);
  }

  async nativeModels() {
    const created = Math.floor(Date.now() / 1000);
    return json({
      object: "list",
      data: [
        { 
          id: "model-example", 
          object: "model", 
          created,
          owned_by: "custom-provider", 
          capabilities: { grounding: true, thinking: false },
          name: "Default Example Model",
          free: true,
          kind: "chat"
        },
        { 
          id: "model-fast", 
          object: "model", 
          created,
          owned_by: "custom-provider", 
          capabilities: { grounding: true, thinking: true },
          name: "Fast Example Model",
          free: false,
          kind: "chat"
        }
      ]
    });
  }

  // ---------- Remote MCP server (JSON-RPC 2.0) ----------
  mcpTools() {
    return [
      {
        name: "bridge_chat",
        description: "Send prompt (with optional attachments) to be processed via active browser session",
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Prompt text or instructions" },
            model: { type: "string", description: "Model ID (optional — defaults to active default model)" },
            attachments: {
              type: "array",
              description: "Optional attachments (up to 10MB per file, base64 data URI)",
              items: {
                type: "object",
                properties: {
                  type: { type: "string", enum: ["image", "file"], description: "Attachment type" },
                  data: { type: "string", description: "Data URI, e.g. data:image/png;base64,..." },
                  filename: { type: "string", description: "Optional filename" }
                },
                required: ["type", "data"]
              }
            }
          },
          required: ["prompt"]
        }
      },
      {
        name: "bridge_list_models",
        description: "List dynamic models from active browser session with capabilities and pricing tier",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "bridge_status",
        description: "Status of bridge cloud hub: extension connectivity, default model, and latency",
        inputSchema: { type: "object", properties: {} }
      },
      {
        name: "web_search",
        description: "Search web through browser session capability with source citations",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            max_results: { type: "number", description: "Maximum results count (default: 5, max: 10)" }
          },
          required: ["query"]
        }
      },
      {
        name: "summarize",
        description: "Summarize long text concisely via browser session model",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "Text content to summarize" },
            style: {
              type: "string",
              enum: ["short", "concise", "detailed", "bullet"],
              description: "Summary style (default: 'concise')"
            }
          },
          required: ["text"]
        }
      }
    ];
  }

  async handleMcp(request) {
    let rpc;
    try { rpc = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
    const { id, method, params } = rpc || {};
    const mcpHeaders = { "content-type": "application/json", "access-control-allow-origin": "*" };

    if (method === "initialize") {
      return json({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: params?.protocolVersion || "2024-11-05",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "browser-edge-bridge", version: "1.0.0" }
        }
      }, 200, mcpHeaders);
    }
    if (method === "notifications/initialized") {
      return new Response(null, { status: 200, headers: mcpHeaders });
    }
    if (method === "tools/list") {
      return json({ jsonrpc: "2.0", id, result: { tools: this.mcpTools() } }, 200, mcpHeaders);
    }
    if (method === "tools/call") {
      const name = params?.name;
      const args = params?.arguments || {};
      let text;
      try {
        if (name === "bridge_chat") {
          const modelId = args.model || this.defaultModel;
          if (!this.isExtConnected || !this.isTabReadyForModel(modelId)) {
            throw new Error("extension offline (fail-fast, no mock)");
          }
          if (args.model && this.modelCatalog.length && !this.modelCatalog.some((m) => m.id === args.model)) {
            throw new Error(`model_unverified: '${args.model}' is not in the active catalog`);
          }
          const release = await this.enqueueRequest(request.signal);
          try {
            const started = Date.now();
            const conversationId = await this.resolveConversation(modelId);
            const parts = Array.isArray(args.attachments) ? args.attachments : null;
            let chunks;
            try {
              ({ chunks } = await this.runChatJob(args.prompt || "Hello", modelId, conversationId, null, parts, request.signal));
            } catch (err) {
              // Temporary conversation expired → recreate once and retry.
              if (!/conversation not found|404/i.test(String(err.message || err))) throw err;
              this.conversationCache = null;
              const fresh = await this.resolveConversation(modelId);
              ({ chunks } = await this.runChatJob(args.prompt || "Hello", modelId, fresh, null, parts, request.signal));
            }
            this.lastChatLatencyMs = Date.now() - started;
            text = chunks.map(p => p?.text ?? "").join("");
          } finally {
            release();
          }
        } else if (name === "bridge_list_models") {
          const models = await this.refreshModels();
          const free = models.filter((m) => m.free);
          text = JSON.stringify({
            default_model: this.defaultModel,
            note: "Free models recommended as default tier; paid models for complex workflows",
            free_models: free.map(m => m.id),
            total: models.length,
            models: models.map(m => ({
              id: m.id, name: m.name, kind: m.kind, free: m.free,
              tier: m.tier, use_case: m.use_case,
            })),
          }, null, 2);
        } else if (name === "bridge_status") {
          text = JSON.stringify({
            extension: this.isExtConnected ? "CONNECTED" : "OFFLINE",
            defaultModel: this.defaultModel,
            activeJobs: this.jobs.size,
            queuedRequestsCount: this.requestQueue.length,
            model_catalog: { revision: this.catalogRevision, count: this.modelCatalog.length },
            last_chat_latency_ms: this.lastChatLatencyMs,
            conversation_cached: Boolean(this.conversationCache),
          }, null, 2);
        } else if (name === "web_search") {
          const query = args.query || "hello";
          const maxResults = Math.min(args.max_results || 5, 10);
          const searchPrompt = `Search information about "${query}" on the web thoroughly with sources (URLs) up to ${maxResults} results`;
          const modelId = this.defaultModel;
          if (!this.isExtConnected || !this.isTabReadyForModel(modelId)) {
            throw new Error("extension offline (fail-fast, no mock)");
          }
          const release = await this.enqueueRequest(request.signal);
          try {
            const conversationId = await this.resolveConversation(modelId);
            const { chunks } = await this.runChatJob(searchPrompt, modelId, conversationId, null, null, request.signal);
            text = chunks.map(p => p?.text ?? "").join("");
          } finally {
            release();
          }
        } else if (name === "summarize") {
          const textContent = args.text || "";
          const style = args.style || "concise";
          const stylePrompt = style === "bullet" ? "Summarize as bullet points" :
                             style === "detailed" ? "Summarize comprehensively" :
                             style === "short" ? "Summarize concisely in 2-3 sentences" :
                             "Summarize concisely in 3-5 key points";
          const summarizePrompt = `${stylePrompt} while preserving all key points:\n\n${textContent}`;
          const modelId = this.defaultModel;
          if (!this.isExtConnected || !this.isTabReadyForModel(modelId)) {
            throw new Error("extension offline (fail-fast, no mock)");
          }
          const release = await this.enqueueRequest(request.signal);
          try {
            const conversationId = await this.resolveConversation(modelId);
            const { chunks } = await this.runChatJob(summarizePrompt, modelId, conversationId, null, null, request.signal);
            text = chunks.map(p => p?.text ?? "").join("");
          } finally {
            release();
          }
        } else {
          return json({ jsonrpc: "2.0", id,
                        error: { code: -32601, message: `unknown tool: ${name}` } }, 200, mcpHeaders);
        }
        return json({ jsonrpc: "2.0", id,
                      result: { content: [{ type: "text", text }] } }, 200, mcpHeaders);
      } catch (err) {
        return json({ jsonrpc: "2.0", id,
                      result: { content: [{ type: "text", text: `ERROR: ${String(err.message || err)}` }],
                                isError: true } }, 200, mcpHeaders);
      }
    }
    return json({ jsonrpc: "2.0", id: id ?? null,
                  error: { code: -32601, message: `method not found: ${method}` } }, 200, mcpHeaders);
  }

  async status(host) {
    return json({
      ok: true,
      service: "browser-edge-bridge",
      architecture: "Cloudflare Worker + Durable Object (SSE relay hub)",
      extension: this.isExtConnected ? "CONNECTED" : "OFFLINE",
      extensions: this.isExtConnected ? 1 : 0,
      extConnectedAt: this.extConnectedAt ? new Date(this.extConnectedAt).toISOString() : null,
      pendingJobsCount: this.jobs.size,
      queuedRequestsCount: this.requestQueue.length,
      tabsAttached: this.tabsReported ? { ...this.attachedTabs } : null,
      defaultModel: this.defaultModel,
      models: this.modelCatalog.length
        ? this.modelCatalog.map(m => ({ id: m.id, kind: m.kind, free: m.free }))
        : this.models.map(id => ({ id })),
      model_catalog: { revision: this.catalogRevision, count: this.modelCatalog.length },
      credits: null, // quota figures flow with the extension session; extend when needed
      last_chat_latency_ms: this.lastChatLatencyMs,
      conversation_cached: Boolean(this.conversationCache),
      mcp_endpoint: `https://${host}/mcp`,
      openai_endpoint: `https://${host}/v1`,
      native_endpoint: `https://${host}/v1/native`,
      clients: "Any OpenAI-compatible client, any MCP client",
    });
  }

  async registry(host) {
    const models = await this.refreshModels();
    const created = this.modelCatalogAt ? Math.floor(this.modelCatalogAt / 1000) : Math.floor(Date.now() / 1000);
    return json({
      ok: true,
      service: "browser-edge-bridge",
      registry: {
        version: "1.0.0",
        catalogRevision: this.catalogRevision,
        default_model: this.defaultModel,
        models_count: models.length,
        models: models.map((m) => m.id),
        endpoints: {
          status: `https://${host}/status`,
          models: `https://${host}/v1/models`,
          chat: `https://${host}/v1/chat/completions`,
          native_models: `https://${host}/v1/native/models`,
          native_chat: `https://${host}/v1/native/chat/completions`,
          mcp: `https://${host}/mcp`,
          registry: `https://${host}/registry`,
        },
      },
      data: models.map((m) => ({
        id: m.id, object: "model", created, owned_by: m.provider ?? "browser-edge-bridge",
        name: m.name, free: m.free, free_credit: m.free, kind: m.kind,
        description: m.description, tier: m.tier, use_case: m.use_case,
      })),
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/^\/+|\/+$/g, "");

    if (request.method === "OPTIONS") {
      // CORS preflight — must carry the CORS headers or the browser rejects
      // the preflight and the real request (SSE/fetch) never fires.
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization, x-bridge-token",
          "access-control-max-age": "86400",
        },
      });
    }

    if (p === "ext/events" || p === "bridge") return this.extEvents(request);
    if (p === "ext/chunk") return this.extPost(request, "chunk");
    if (p === "ext/done") return this.extPost(request, "done");
    if (p === "ext/loader") return this.extPost(request, "loader");
    if (p === "ext/error") return this.extPost(request, "error");
    if (p === "ext/models/refresh" && request.method === "POST") {
      const models = await this.refreshModels(true);
      return json({ ok: true, count: models.length, defaultModel: this.defaultModel });
    }
    if (p === "ext/tab") {
      const body = await request.json().catch(() => ({}));
      if (body?.pages && typeof body.pages === "object") {
        this.tabsReported = true;
        this.attachedTabs = {
          primary: Boolean(body.pages.primary?.online),
          secondary: Boolean(body.pages.secondary?.online),
        };
      } else if (body?.tabId != null) {
        this.lastDispatchedTab = body;
      }
      return json({ ok: true });
    }
    if (p === "ext/reload" || p === "reload") {
      if (!this.extWriter) return json({ ok: false, error: "extension not connected" }, 503);
      this.extWriter.write(new TextEncoder().encode(this.sseLine("reload_extension", {}))).catch(() => {});
      return json({ ok: true, message: "reload_extension sent to connected extension" });
    }
    if (p === "ext/reload-tab") {
      if (!this.extWriter) return json({ ok: false, error: "extension not connected" }, 503);
      this.extWriter.write(new TextEncoder().encode(this.sseLine("reload_tab", {}))).catch(() => {});
      return json({ ok: true, message: "reload_tab sent to connected extension" });
    }
    if (p === "bridge/message" || p === "bridge/msg") return json({ ok: true, protocolVersion: 2 });

    if (p === "mcp" && request.method === "POST") return this.handleMcp(request);

    if (p === "status" || p === "health") return this.status(url.host);
    if (p === "config" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      if (typeof body.defaultModel === "string" && body.defaultModel.trim()) {
        this.defaultModel = body.defaultModel.trim();
        this.conversationCache = null;
      }
      return json({ ok: true, defaultModel: this.defaultModel });
    }
    if (p === "registry" || p === "registry/status") return this.registry(url.host);
    if (p === "registry/models") {
      const models = await this.refreshModels();
      const created = this.modelCatalogAt ? Math.floor(this.modelCatalogAt / 1000) : Math.floor(Date.now() / 1000);
      return json({
        object: "list",
        catalogRevision: this.catalogRevision,
        default_model: this.defaultModel,
        data: models.map((m) => ({
          id: m.id, object: "model", created, owned_by: m.provider ?? "browser-edge-bridge",
          name: m.name, free: m.free, free_credit: m.free, kind: m.kind,
          description: m.description, tier: m.tier, use_case: m.use_case,
        })),
      });
    }
    if (p === "" && request.method === "GET") return this.status(url.host);
    // Chatbox AI compatibility: also accept /models and /chat/completions (no /v1 prefix)
    if (p === "v1/models" || p === "models") {
      const force = url.searchParams.get("refresh") === "1";
      const models = await this.refreshModels(force);
      const created = this.modelCatalogAt ? Math.floor(this.modelCatalogAt / 1000) : Math.floor(Date.now() / 1000);
      return json({
        object: "list",
        catalogRevision: this.catalogRevision,
        default_model: this.defaultModel,
        data: models.map((m) => ({
          id: m.id, object: "model", created, owned_by: m.provider ?? "browser-edge-bridge",
          name: m.name, free: m.free, free_credit: m.free, kind: m.kind,
          description: m.description, tier: m.tier, use_case: m.use_case,
        })),
      });
    }
    if ((p === "v1/chat/completions" || p === "chat/completions") && request.method === "POST") {
      return this.chatCompletions(request);
    }
    // Native direct endpoints (feature-gated)
    if (p === "v1/native/models" && request.method === "GET") {
      if (!this.isNativeEnabled()) {
        return json({ error: { message: "Native endpoints disabled", code: "disabled" } }, 404);
      }
      return this.nativeModels();
    }
    if ((p === "v1/native/chat/completions" || p === "native/chat/completions") && request.method === "POST") {
      if (!this.isNativeEnabled()) {
        return json({ error: { message: "Native endpoints disabled", code: "disabled" } }, 404);
      }
      return this.nativeChatCompletions(request);
    }

    return json({ error: { message: `no route for ${request.method} ${p}`, code: "not_found" } }, 404);
  }

  isNativeEnabled() {
    return this.env?.NATIVE_ENABLED === "true" || this.env?.NATIVE_ENABLED === true;
  }
}

// ---------- edge worker: auth + route everything into the single DO ----------

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*", ...headers },
  });
}

function jsonOpenAI(request, status, obj) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight must be handled at the edge BEFORE auth — browsers never
    // send custom headers (x-bridge-token) on preflight, so auth would 401 it
    // and the real GET/POST would never fire.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "content-type, authorization, x-bridge-token",
          "access-control-max-age": "86400",
        },
      });
    }

    // Token auth — strictly separated dual roles:
    //   BRIDGE_SECRET  → Chrome extension channel (/ext/*, /bridge/*, /reload)
    //   CLIENT_API_KEY → API & MCP clients (/v1/*, /models, /chat/completions, /mcp, /config, /registry*)
    // A single shared token may be configured via BRIDGE_TOKEN as fallback for both.
    // Query parameter ?token= is explicitly disallowed (prevents token leaks in URL logs).
    // Public endpoints: GET /, /status, /health only.
    const extToken = env.BRIDGE_SECRET || env.BRIDGE_TOKEN;
    const apiToken = env.CLIENT_API_KEY || env.BRIDGE_TOKEN;
    const pathNormalized = url.pathname.replace(/^\/+|\/+$/g, "");

    const isPublicHealth = (request.method === "GET" || request.method === "HEAD") &&
      (url.pathname === "/" || url.pathname === "/status" || url.pathname === "/health");

    if (!isPublicHealth) {
      const provided =
        (request.headers.get("x-bridge-token") || "").trim() ||
        (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();

      const isExtRoute = pathNormalized === "bridge" || pathNormalized === "reload"
        || pathNormalized.startsWith("ext/") || pathNormalized.startsWith("bridge/");
      const expectedToken = isExtRoute ? extToken : apiToken;

      if (!expectedToken) {
        // Fail fast, never fabricate: missing role secret means no access.
        return json({
          error: {
            message: isExtRoute
              ? "BRIDGE_SECRET is not configured on this worker."
              : "CLIENT_API_KEY is not configured on this worker.",
            type: "bridge_error",
            code: "secrets_unconfigured",
          },
        }, 503);
      }

      if (!provided || !(await timingSafeEquals(provided, expectedToken))) {
        return json({
          error: {
            message: "Invalid or missing API key. Provide the proper role token via header.",
            type: "invalid_request_error",
            code: "invalid_api_key",
          },
        }, 401);
      }
    }

    // Edge Rate Limiting on chat endpoints (/v1/chat/completions, /chat/completions, /v1/native/chat/completions)
    const isChatEndpoint = request.method === "POST" && (
      pathNormalized === "v1/chat/completions" ||
      pathNormalized === "chat/completions" ||
      pathNormalized === "v1/native/chat/completions" ||
      pathNormalized === "native/chat/completions"
    );

    if (isChatEndpoint) {
      const clientIp = request.headers.get("cf-connecting-ip") ||
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "127.0.0.1";

      // 1. Cloudflare Workers Rate Limiting binding
      if (env.RATE_LIMITER && typeof env.RATE_LIMITER.limit === "function") {
        const { success } = await env.RATE_LIMITER.limit({ key: clientIp });
        if (!success) {
          return json({
            error: {
              message: "Rate limit exceeded for client IP",
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
            },
          }, 429, { "retry-after": "60" });
        }
      } else if (env.CLIENT_RATE_LIMIT_MAX) {
        // 2. Sliding-window in-memory fallback rate limiter
        const limitMax = Number.parseInt(String(env.CLIENT_RATE_LIMIT_MAX), 10) || 60;
        const windowMs = (Number.parseInt(String(env.CLIENT_RATE_LIMIT_WINDOW_SECONDS), 10) || 60) * 1000;
        if (!globalThis.__edgeRateLimiter) {
          globalThis.__edgeRateLimiter = new Map();
        }
        const now = Date.now();
        const timestamps = (globalThis.__edgeRateLimiter.get(clientIp) || []).filter((t) => now - t < windowMs);
        if (timestamps.length >= limitMax) {
          return json({
            error: {
              message: "Rate limit exceeded for client IP",
              type: "rate_limit_error",
              code: "rate_limit_exceeded",
            },
          }, 429, { "retry-after": "60" });
        }
        timestamps.push(now);
        globalThis.__edgeRateLimiter.set(clientIp, timestamps);
      }
    }

    // For public health checks without Durable Object binding (local dev),
    // return directly without accessing Durable Object which may not exist.
    if (isPublicHealth && !env.EXT_HUB) {
      return json({ ok: true, service: "browser-edge-bridge", environment: "local-dev" });
    }

    const id = env.EXT_HUB.idFromName("singleton");
    const stub = env.EXT_HUB.get(id);
    return stub.fetch(request);
  },
};
