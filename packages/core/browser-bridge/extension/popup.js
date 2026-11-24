const $ = (id) => document.getElementById(id);

const DEFAULT_BRIDGE = 'https://bridge.example.workers.dev';
const CHAT_URL = 'https://target.example.local/chat';
let bridge = DEFAULT_BRIDGE;
let modelSignature = '';
let currentAction = null;   // what the hero button does right now
let pollTimer = null;
let currentFilter = 'all';
let lastPages = null;
let lastSrv = null;

/* ------------------------------------------------------------------ helpers */

// Write only when the value actually changed. The popup polls, and blindly
// re-rendering fights the user mid-selection and makes the panel flicker.
function setText(el, value) {
  const v = String(value);
  if (el.textContent !== v) el.textContent = v;
}

function setClass(el, base, variant) {
  const next = `${base} ${variant}`;
  if (el.className !== next) el.className = next;
}

let toastTimer;
function toast(message) {
  const el = $('toast');
  setText(el, message);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1600);
}

const shortId = (id) => (id && id.length > 10 ? `${id.slice(0, 8)}…` : id || '–');

const isUnresolvedToken = (t) => !t || /^__.*__$/.test(t);

async function authHeaders(forClientApi = false) {
  const saved = await chrome.storage.local.get(['bridgeToken', 'clientApiKey']);
  const rawBridge = saved?.bridgeToken ? String(saved.bridgeToken).trim() : '';
  const rawClient = saved?.clientApiKey ? String(saved.clientApiKey).trim() : '';
  const bridgeTok = isUnresolvedToken(rawBridge) ? '' : rawBridge;
  const clientTok = isUnresolvedToken(rawClient) ? '' : rawClient;
  const headers = { 'content-type': 'application/json' };
  if (forClientApi) {
    const token = clientTok || bridgeTok;
    if (token) headers.authorization = `Bearer ${token}`;
  } else if (bridgeTok) {
    headers['x-bridge-token'] = bridgeTok;
  }
  return headers;
}

/* -------------------------------------------------------------- data access */

async function swStatus() {
  try { return await chrome.runtime.sendMessage({ type: 'status' }); }
  catch { return null; }
}

async function bridgeStatus() {
  try {
    const res = await fetch(`${bridge}/status`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- the 3 states */

// Everything the popup shows derives from one of these, so the guidance and the
// action button can never disagree with the indicator.
function derive(sw, srv) {
  if (!sw) {
    return { key: 'bad', label: 'Extension error', pill: 'error',
      hint: 'The extension worker is not responding. Reload it from chrome://extensions.' };
  }
  if (!srv || !sw.connected) {
    return { key: 'bad', label: 'Bridge offline', pill: 'offline',
      hint: 'Nothing is listening on the bridge URL. Start it with `npm run dev`.',
      action: { text: 'Retry connection', run: reconnect } };
  }
  if (!sw.tab) {
    return { key: 'warn', label: 'No target tab', pill: 'waiting',
      hint: 'The bridge is up, but a target tab must stay open for requests to run.',
      action: { text: 'Open target tab', run: openChatTab } };
  }
  if (!srv.extensions) {
    return { key: 'warn', label: 'Tab not linked', pill: 'waiting',
      hint: 'The tab is open but has not attached yet. Reloading it usually fixes this.',
      action: { text: 'Reload the tab', run: reloadChatTab } };
  }
  return { key: 'ok', label: 'Connected', pill: 'ready',
    hint: 'Ready. Point any OpenAI-compatible client at the bridge URL.' };
}

/* ----------------------------------------------------------------- actions */

async function reconnect() {
  await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {});
  toast('Reconnecting…');
  setTimeout(render, 400);
}

async function openChatTab() {
  await chrome.tabs.create({ url: CHAT_URL });
  window.close();
}

async function reloadChatTab() {
  const sw = await swStatus();
  if (sw?.tab) await chrome.tabs.reload(sw.tab.id).catch(() => {});
  toast('Reloading tab…');
  setTimeout(render, 600);
}

/* ------------------------------------------------------------------ render */

// The list now carries image, video and music generators alongside chat models,
// so a flat 30-entry dropdown would be unusable. Group it the way the web UI's
// tabs do — the bridge derives the kind, since the loader sends none.
const KIND_LABELS = {
  chat: 'สนทนา · Chat',
  research: 'ค้นคว้าเชิงลึก · Deep research',
  image: 'สร้างรูปภาพ · Image',
  video: 'สร้างวิดีโอ · Video',
  music: 'สร้างเพลง · Music',
};
const KIND_ORDER = ['chat', 'research', 'image', 'video', 'music'];

function renderModels(models, selected) {
  // Legacy select#model was deduplicated into usable models list
}

// Free models draw no credits; standard models draw from available pool.
function renderCredits(srv) {
  const box = $('creditsBox');
  if (!srv) { box.hidden = true; return; }
  box.hidden = false;

  const credits = srv.credits;
  if (!credits || !credits.limit) {
    const stale = !('credits' in srv);
    $('creditsFill').style.width = '0%';
    setClass($('creditsFill'), 'meter-fill', '');
    setText($('creditsPct'), '');
    setText($('creditsLeft'), '–');
    setText($('creditsOf'), stale ? 'bridge is out of date — restart it' : 'waiting for the tab');
    setText($('creditsReset'), '');
    return;
  }

  const n = (v) => v.toLocaleString('en-US', { maximumFractionDigits: v < 100 ? 1 : 0 });
  const share = Math.max(0, Math.min(1, credits.available / credits.limit));
  const pct = Math.round(share * 100);

  const fill = $('creditsFill');
  fill.style.width = `${Math.max(share * 100, share > 0 ? 2 : 0)}%`;
  setClass(fill, 'meter-fill', pct <= 5 ? 'gone' : pct <= 20 ? 'low' : '');

  setText($('creditsPct'), `(${pct}%)`);
  setText($('creditsLeft'), n(credits.available));
  setText($('creditsOf'), `of ${n(credits.limit)} left`);
  setText($('creditsReset'), credits.periodEndsAt ? `resets ${credits.periodEndsAt.slice(5, 10)}` : '');
}

function renderPages(pages) {
  if (!pages) return;
  lastPages = pages;

  // 1. Primary Target
  const primary = pages.primary;
  const primaryOnline = Boolean(primary?.online);
  setClass($('dotPrimary'), 'page-dot', primaryOnline ? 'dot-online' : 'dot-offline');
  setClass($('badgePrimary'), 'badge-status', primaryOnline ? 'badge-online' : 'badge-offline');
  setText($('badgePrimary'), primaryOnline ? 'Online' : 'Offline');
  setText($('subPrimary'), primaryOnline ? (primary.tabUrl ? shortId(primary.tabUrl) : 'Tab active & ready') : 'Tab offline · Click Open to connect');
  setText($('btnPrimaryAction'), primaryOnline ? 'Switch' : 'Open');

  const chipsPrimary = $('chipsPrimary');
  chipsPrimary.innerHTML = '';
  const primaryModels = primary?.models || [];
  if (primaryModels.length) {
    for (const m of primaryModels.slice(0, 5)) {
      const sp = document.createElement('span');
      sp.className = `chip ${m.free ? 'chip-free' : ''}`;
      sp.textContent = m.name || m.id;
      chipsPrimary.appendChild(sp);
    }
    if (primaryModels.length > 5) {
      const extra = document.createElement('span');
      extra.className = 'chip';
      extra.textContent = `+${primaryModels.length - 5} more`;
      chipsPrimary.appendChild(extra);
    }
  } else {
    const empty = document.createElement('span');
    empty.className = 'chip';
    empty.style.color = 'var(--faint)';
    empty.textContent = primaryOnline ? 'Discovering models…' : 'No tab connected';
    chipsPrimary.appendChild(empty);
  }

  // 2. Secondary Target
  const secondary = pages.secondary;
  const secondaryOnline = Boolean(secondary?.online);
  setClass($('dotSecondary'), 'page-dot', secondaryOnline ? 'dot-online' : 'dot-offline');
  setClass($('badgeSecondary'), 'badge-status', secondaryOnline ? 'badge-online' : 'badge-offline');
  setText($('badgeSecondary'), secondaryOnline ? 'Online' : 'Offline');
  setText($('subSecondary'), secondaryOnline ? (secondary.tabUrl ? shortId(secondary.tabUrl) : 'Tab active & ready') : 'Tab offline · Click Open to connect');
  setText($('btnSecondaryAction'), secondaryOnline ? 'Switch' : 'Open');

  const chipsSecondary = $('chipsSecondary');
  chipsSecondary.innerHTML = '';
  const secondaryModels = secondary?.models || [];
  if (secondaryModels.length) {
    for (const m of secondaryModels) {
      const sp = document.createElement('span');
      sp.className = `chip ${m.free ? 'chip-free' : ''}`;
      sp.textContent = m.name || m.id;
      chipsSecondary.appendChild(sp);
    }
  } else {
    const empty = document.createElement('span');
    empty.className = 'chip';
    empty.style.color = 'var(--faint)';
    empty.textContent = secondaryOnline ? 'Discovering models…' : 'No tab connected';
    chipsSecondary.appendChild(empty);
  }
}

function renderUsableModels(pages, srv, savedDefault = null) {
  const flatContainer = $('usableList');
  const accordionContainer = $('modelAccordion');
  const countEl = $('usableCount');
  if (!flatContainer || !accordionContainer) return;

  const map = new Map();

  // From Secondary if online
  const sec = pages?.secondary;
  if (sec?.online) {
    for (const m of (sec.models || [])) {
      map.set(`secondary:${m.id}`, {
        id: m.id,
        name: m.name || m.id,
        source: 'secondary',
        sourceName: 'Secondary Provider',
        free: Boolean(m.free || m.isFreeCredit),
        tier: 'secondary',
      });
    }
  }

  // From Primary if online
  const pri = pages?.primary;
  if (pri?.online) {
    for (const m of (pri.models || [])) {
      map.set(`primary:${m.id}`, {
        id: m.id,
        name: m.name || m.id,
        source: 'primary',
        sourceName: 'Primary Provider',
        free: Boolean(m.free || m.free_credit),
        tier: m.free ? 'free' : 'standard',
      });
    }
  }

  // From server bridge status
  if (srv?.models && Array.isArray(srv.models)) {
    for (const m of srv.models) {
      const isSec = m.id?.includes('secondary');
      const srcKey = isSec ? 'secondary' : 'primary';
      const key = `${srcKey}:${m.id}`;
      if (!map.has(key)) {
        map.set(key, {
          id: m.id,
          name: m.name || m.id,
          source: srcKey,
          sourceName: isSec ? 'Secondary Provider' : 'Primary Provider',
          free: Boolean(m.free || m.free_credit || m.id?.includes('fast') || m.id === 'auto'),
          tier: (m.free || m.id?.includes('fast') || m.id === 'auto') ? 'free' : 'standard',
        });
      }
    }
  }

  const allUsable = Array.from(map.values());
  // Count reflects the models actually rendered, so it always matches the filter.
  const filtered = allUsable.filter((m) => {
    if (currentFilter === 'free') return m.free;
    if (currentFilter === 'primary') return m.source === 'primary';
    if (currentFilter === 'secondary') return m.source === 'secondary';
    return true;
  });
  setText(countEl, `(${filtered.length})`);

  // Toggle visibility: use accordion view when there are models, keep flat fallback empty.
  if (filtered.length) {
    flatContainer.style.display = 'none';
    accordionContainer.style.display = 'block';
  } else {
    flatContainer.style.display = 'block';
    accordionContainer.style.display = 'none';
    flatContainer.innerHTML = '';
    const empty = document.createElement('div');
    empty.style.color = 'var(--faint)';
    empty.style.fontSize = '11px';
    empty.style.padding = '6px';
    empty.textContent = allUsable.length
      ? 'No models match current filter.'
      : 'Open a target tab to load usable models.';
    flatContainer.appendChild(empty);
    return;
  }

  const defaultModel = srv?.defaultModel || savedDefault || 'model-example';
  const defNameEl = $('currentDefaultName');
  if (defNameEl) setText(defNameEl, defaultModel);

  // Group filtered models by source for accordion headers.
  const groups = new Map();
  for (const m of filtered) {
    if (!groups.has(m.source)) groups.set(m.source, []);
    groups.get(m.source).push(m);
  }

  const sourceLabels = {
    primary: 'Primary Provider',
    secondary: 'Secondary Provider',
  };

  accordionContainer.innerHTML = '';

  for (const [source, models] of groups) {
    const details = document.createElement('details');
    details.className = 'model-item';

    const summary = document.createElement('summary');
    summary.className = 'accordion-header';
    summary.innerHTML = `
      <span>${sourceLabels[source] || source}</span>
      <span class="accordion-count">${models.length} model${models.length !== 1 ? 's' : ''}</span>
    `;
    details.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'details-body';

    for (const m of models) {
      const row = document.createElement('div');
      const isSelected = m.id === defaultModel || (m.source && `${m.source}:${m.id}` === defaultModel);
      row.className = `usable-row ${isSelected ? 'is-default' : ''}`;
      row.title = isSelected ? `Current default model: ${m.id}` : `Click to set ${m.id} as default model`;

      const titleWrap = document.createElement('div');
      titleWrap.className = 'usable-id';
      titleWrap.textContent = m.name || m.id;
      row.appendChild(titleWrap);

      if (isSelected) {
        const defBadge = document.createElement('span');
        defBadge.className = 'badge-tag badge-default';
        defBadge.textContent = '★ Default';
        row.appendChild(defBadge);
      }

      const costBadge = document.createElement('span');
      costBadge.className = `badge-tag ${m.free ? 'badge-free' : 'badge-paid'}`;
      costBadge.textContent = m.free ? 'Free' : (m.tier === 'enterprise' ? 'Enterprise' : 'Credit');

      row.appendChild(costBadge);

      row.addEventListener('click', async () => {
        try {
          if (defNameEl) setText(defNameEl, m.id);
          await chrome.storage.local.set({ defaultModel: m.id });
          if (srv) srv.defaultModel = m.id;

          const res = await fetch(`${bridge}/config`, {
            method: 'POST',
            headers: await authHeaders(true),
            body: JSON.stringify({ defaultModel: m.id }),
          }).catch(() => null);

          if (!res || !res.ok) {
            toast(`Default model: ${m.id} (saved locally)`);
          } else {
            toast(`Default model: ${m.id}`);
          }
          renderUsableModels(lastPages, srv, m.id);
        } catch {
          toast(`Default model: ${m.id}`);
          renderUsableModels(lastPages, srv, m.id);
        }
      });

      body.appendChild(row);
    }

    details.appendChild(body);
    accordionContainer.appendChild(details);
  }
}

async function render() {
  const saved = await chrome.storage.local.get(['bridgeUrl', 'bridgeToken', 'clientApiKey', 'defaultModel']);
  if (saved?.bridgeUrl) {
    bridge = saved.bridgeUrl;
  } else {
    const sw = await swStatus();
    if (sw?.bridgeUrl) bridge = sw.bridgeUrl;
  }
  const sw = await swStatus();
  const srv = sw ? await bridgeStatus() : null;

  const state = derive(sw, srv);

  setClass($('dot'), 'dot', `state-${state.key}`);
  setClass($('pill'), 'pill', `pill-${state.key}`);
  setText($('state'), state.label);
  setText($('pill'), state.pill);

  // lastError is more specific than the generic hint when present.
  setText($('hint'), sw?.lastError && state.key !== 'ok' ? sw.lastError : state.hint);

  const act = $('act');
  const btn = $('actBtn');
  if (state.action) {
    setText(btn, state.action.text);
    currentAction = state.action.run;
    act.classList.add('show');
  } else {
    currentAction = null;
    act.classList.remove('show');
  }

  if (srv) renderModels(srv.models ?? [], srv.defaultModel);
  renderCredits(srv);

  lastPages = sw?.pages || null;
  lastSrv = srv;
  if (lastPages) renderPages(lastPages);
  renderUsableModels(lastPages, srv, saved?.defaultModel);

  // Don't clobber the field while it is being edited.
  if (document.activeElement !== $('url')) {
    $('url').value = bridge || DEFAULT_BRIDGE;
  }
  if (document.activeElement !== $('token')) {
    const rawSaved = saved?.bridgeToken ? String(saved.bridgeToken).trim() : '';
    $('token').value = isUnresolvedToken(rawSaved) ? '' : rawSaved;
    $('token').placeholder = 'token injected at build time (scripts/build-extension.py)';
  }
  if ($('apiKey') && document.activeElement !== $('apiKey')) {
    const rawKey = saved?.clientApiKey ? String(saved.clientApiKey).trim() : '';
    $('apiKey').value = isUnresolvedToken(rawKey) ? '' : rawKey;
  }
}

/* ------------------------------------------------------------------- wiring */

$('actBtn').addEventListener('click', () => currentAction?.());

$('btnPrimaryAction')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'open_page', url: 'https://target.example.local/chat' });
  toast('Opening primary target…');
  setTimeout(render, 500);
});

$('btnSecondaryAction')?.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'open_page', url: 'https://secondary.example.local/' });
  toast('Opening secondary target…');
  setTimeout(render, 500);
});

$('btnScan')?.addEventListener('click', async () => {
  toast('Scanning tabs…');
  await chrome.runtime.sendMessage({ type: 'scan_pages' }).catch(() => {});
  setTimeout(render, 600);
});

document.querySelectorAll('#filterRow button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#filterRow button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter || 'all';
    if (lastPages || lastSrv) renderUsableModels(lastPages, lastSrv);
  });
});

$('save').addEventListener('click', async () => {
  const url = $('url').value.trim().replace(/\/+$/, '') || DEFAULT_BRIDGE;
  if (!/^https?:\/\/.+/i.test(url)) return toast('Enter a full http:// or https:// URL');
  const rawToken = $('token').value.trim();
  const token = isUnresolvedToken(rawToken) ? '' : rawToken;
  const rawApiKey = $('apiKey') ? $('apiKey').value.trim() : '';
  const clientApiKey = isUnresolvedToken(rawApiKey) ? '' : rawApiKey;
  await chrome.storage.local.set({ bridgeUrl: url, bridgeToken: token, clientApiKey, userConfigured: true });
  await chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {});
  bridge = url;
  modelSignature = '';
  toast('Saved');
  setTimeout(render, 400);
});

$('refresh').addEventListener('click', async () => {
  try {
    const headers = await authHeaders(true);
    const res = await fetch(`${bridge}/v1/models?refresh=1`, { cache: 'no-store', headers });
    await fetch(`${bridge}/quota?refresh=1`, { cache: 'no-store', headers }).catch(() => {});
    if (res.status === 401 || res.status === 503) {
      toast(`Refresh auth error (${res.status}) — check Client API key`);
    } else if (!res.ok) {
      toast(`Refresh failed (${res.status})`);
    } else {
      modelSignature = '';
      toast('Refreshed');
    }
  } catch {
    toast('Could not reach the bridge');
  }
  render();
});

// Enter in the URL field saves.
$('url').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('save').click(); });

try { setText($('ver'), `v${chrome.runtime.getManifest().version}`); } catch { /* not in an extension context */ }

render();
pollTimer = setInterval(render, 2000);
window.addEventListener('unload', () => clearInterval(pollTimer));
