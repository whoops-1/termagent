import { TermAgentClient, TermAgentError } from './web-assets/client/client.js';

/* TermAgent Web View, production browser client.
 * The v4 prototype's layout is preserved. This layer projects the canonical
 * HTTP/SSE protocol; it does not run the agent or create a parallel state store.
 */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = (name, extra = '') => `<svg class="i ${extra}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const localStore = {
  get(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch {} },
};
const mobilePointer = matchMedia('(pointer: coarse)');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const state = {
  client: null, token: '', info: null, runtimeStatus: null,
  sessions: [], sessionTitleById: new Map(), runningById: new Set(),
  activeId: localStore.get('termagent:webview:session', ''),
  meta: null, messages: [], pendingInteractions: [], todos: [], queue: [],
  tasks: [], checkpoints: [], context: null, diff: null,
  subagentPollTimer: null, subagentStreamAbort: null, subagentView: null, subagentRootId: '', subagentTaskId: '', subagentRequestKey: 0,
  cursor: 0, historyEvents: [], activity: [], activityIds: new Set(),
  toolLifecycle: new Map(), readFiles: new Map(), expandedTools: new Set(),
  streamAbort: null, wasConnected: false, connectionLost: false, lastHeartbeat: 0,
  streamState: 'connecting', streamProbeAt: 0, streamProbeBusy: false,
  promptStreamActive: false, promptStreamSuppressUntil: 0,
  status: null, pendingPrompt: '', liveText: '', liveReasoning: '', liveStreamId: '',
  localRunning: false, runHasState: false, runState: 'idle', runStartedAt: 0,
  runEndedAt: 0, runLabel: 'Working', runPhase: '', mode: 'Build',
  focus: localStore.get('termagent:webview:focus', '0') === '1',
  theme: localStore.get('termagent:theme', 'dark'),
  refreshTimer: null, busyRefresh: false, refreshEpoch: 0, toastTimer: null, tickTimer: null,
  slashItems: [], slashIndex: 0, lastPrompt: '', workflow: null, queueUpdate: null, stopRequested: false,
};

const layout = $('#layout');
const feed = $('#feed');
const feedInner = $('#feedInner');
const sheet = $('#sheet');
sheet.setAttribute('aria-hidden', 'true');
sheet.tabIndex = -1;
const sheetScrim = $('#sheetScrim');
const toastEl = $('#toast');
const slashEl = $('#slash');
let returnFocus = null;
let lastRenderSession = '';

function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.add('is-on');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 2600);
}

function setBanner(message, kind = 'live') {
  const banner = $('#banner');
  if (!message) { banner.hidden = true; banner.textContent = ''; return; }
  banner.hidden = false;
  banner.dataset.s = kind;
  banner.textContent = message;
}

function applyTheme() {
  const systemLight = matchMedia('(prefers-color-scheme: light)').matches;
  const theme = state.theme === 'system' ? (systemLight ? 'light' : 'dark') : state.theme;
  document.documentElement.dataset.theme = theme;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'light' ? '#ffffff' : '#000000';
  $$('[data-theme-choice]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.themeChoice === state.theme)));
}
matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (state.theme === 'system') applyTheme(); });
applyTheme();

document.body.classList.toggle('is-focus', state.focus);

function stopSubagentPolling() {
  if (state.subagentPollTimer) clearInterval(state.subagentPollTimer);
  state.subagentPollTimer = null;
  state.subagentStreamAbort?.abort();
  state.subagentStreamAbort = null;
  state.subagentRequestKey += 1;
}
function openSheet(title, html) {
  stopSubagentPolling();
  returnFocus = document.activeElement;
  $('#sheetTitle').textContent = title;
  $('#sheetBody').innerHTML = html;
  sheet.classList.add('is-open');
  sheet.setAttribute('aria-hidden', 'false');
  sheetScrim.classList.add('is-on');
  $('#moreBtn')?.setAttribute('aria-expanded', 'true');
  $('#sheetClose').focus({ preventScroll: true });
}
function closeSheet() {
  stopSubagentPolling();
  if (!sheet.classList.contains('is-open')) return;
  sheet.classList.remove('is-open');
  sheet.setAttribute('aria-hidden', 'true');
sheet.tabIndex = -1;
  sheetScrim.classList.remove('is-on');
  $('#moreBtn')?.setAttribute('aria-expanded', 'false');
  returnFocus?.focus?.({ preventScroll: true });
}
$('#sheetClose').addEventListener('click', closeSheet);
sheetScrim.addEventListener('click', closeSheet);

function setView(view) {
  layout.dataset.view = view;
  $$('.tabs [role="tab"]').forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.view === view)));
  if (view === 'activity') $('#inspector').scrollTop = 0;
  if (view === 'files') renderFiles();
}
$('.tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) setView(tab.dataset.view);
});
$('.tabs').addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = $$('.tabs [role="tab"]').filter((tab) => tab.getClientRects().length);
  const current = tabs.indexOf(document.activeElement);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus();
  setView(tabs[next].dataset.view);
});

const side = $('#side');
const scrim = $('#scrim');
function setDrawer(open) {
  side.classList.toggle('is-open', open);
  scrim.classList.toggle('is-on', open);
  if (open) $('#sessionSearch').focus({ preventScroll: true });
}
$('#menuBtn').addEventListener('click', () => setDrawer(true));
$('#sideClose').addEventListener('click', () => setDrawer(false));
scrim.addEventListener('click', () => setDrawer(false));
$('#inspectorBtn').addEventListener('click', () => {
  const on = layout.dataset.inspector !== 'off';
  layout.dataset.inspector = on ? 'off' : 'on';
  $('#inspectorBtn').setAttribute('aria-pressed', String(!on));
});

function formatAgo(timestamp) {
  const ms = Math.max(0, Date.now() - Number(timestamp || 0));
  if (ms < 45_000) return 'now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}
function formatClock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function activeTitle(messages, meta) {
  const firstUser = (messages || []).find((message) => message.role === 'user' && String(message.content || '').trim());
  const content = String(firstUser?.content || '').replace(/\s+/g, ' ').trim();
  if (content) return content.length > 46 ? `${content.slice(0, 45)}…` : content;
  return meta?.id ? `Session ${String(meta.id).slice(0, 8)}` : 'New session';
}
function setClient(token = '') {
  state.token = token;
  state.client = new TermAgentClient({ baseUrl: location.origin, token: token || undefined });
}
function isUnauthorized(error) { return error instanceof TermAgentError && error.status === 401; }

function showConnectSheet(message = 'Enter the one-time pairing code printed by the TermAgent terminal.') {
  openSheet('Connect to TermAgent', `
    <p class="sheet-note">Enter the one-time pairing code shown in the server terminal. It is exchanged for a workspace-scoped device token held only in this page's memory. Older local servers may still accept their configured runtime token.</p>
    <form class="sheet-form" id="connectForm">
      <label for="tokenField">Pairing code or legacy runtime token</label>
      <input class="sheet-input" id="tokenField" type="password" autocomplete="one-time-code" spellcheck="false" required placeholder="One-time pairing code" />
      <p class="sheet-note" id="connectError">${esc(message)}</p>
      <button class="btn btn-block" type="submit">Connect</button>
    </form>`);
  setTimeout(() => $('#tokenField')?.focus({ preventScroll: true }), 40);
}

async function withAuth(operation) {
  try { return await operation(); }
  catch (error) {
    if (isUnauthorized(error)) showConnectSheet('Token rejected or expired. Check it and reconnect.');
    throw error;
  }
}

async function bootstrap() {
  setClient(state.token);
  $('#runtimeStatus').textContent = 'Connecting live updates…';
  $('#runtimeDot').dataset.s = 'idle';
  try {
    state.info = await state.client.info();
    state.runtimeStatus = await state.client.status().catch(() => null);
    state.sessions = (await state.client.listSessions()).sessions || [];
    state.runningById = new Set(state.runtimeStatus?.runningSessions || []);
    $('#runtimeStatus').textContent = 'Live updates connected';
    $('#runtimeDot').dataset.s = 'done';
    $('#runtimeVersion').textContent = state.info.version ? `v${state.info.version}` : '';
    $('#modelLabel').textContent = `${state.info.provider || 'Provider'} · ${state.info.model || 'Model'}`;
    $('#branchLabel').textContent = compactPath(state.info.cwd || 'Workspace');
    if (!state.sessions.length) {
      const created = await state.client.createSession();
      state.sessions = [created];
    }
    renderSidebar();
    const preferId = state.sessions.some((session) => session.id === state.activeId) ? state.activeId : state.sessions[0]?.id;
    if (preferId) await selectSession(preferId, { persist: true });
    else renderEmptySessionList();
    state.wasConnected = true;
    setBanner('');
  } catch (error) {
    $('#runtimeStatus').textContent = isUnauthorized(error) ? 'Authentication required' : 'Runtime unavailable';
    $('#runtimeDot').dataset.s = 'error';
    if (isUnauthorized(error)) showConnectSheet('This runtime requires a one-time device pairing code or a legacy local runtime token.');
    else {
      setBanner(`Could not connect: ${error.message || error}. Retry from Options → Reconnect.`, 'error');
      renderEmptySessionList();
    }
  }
}

function compactPath(value) {
  const text = String(value || '').replace(/\\/g, '/');
  const parts = text.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : (text || 'Workspace');
}
function renderEmptySessionList() {
  $('#sessions').innerHTML = `<p class="group-label">Sessions</p><p class="empty-note" id="sessionsEmpty">No sessions available.</p>`;
}
function renderSidebar() {
  const nav = $('#sessions');
  if (!state.sessions.length) { renderEmptySessionList(); return; }
  const query = $('#sessionSearch').value.trim().toLowerCase();
  const entries = [...state.sessions].sort((a, b) => Number(b.updated || b.created || 0) - Number(a.updated || a.created || 0));
  const grouped = { Today: [], Earlier: [] };
  for (const meta of entries) {
    const title = state.sessionTitleById.get(meta.id) || `Session ${String(meta.id).slice(0, 8)}`;
    if (query && !title.toLowerCase().includes(query) && !String(meta.id).toLowerCase().includes(query)) continue;
    const recent = Date.now() - Number(meta.updated || meta.created || 0) < 86_400_000;
    grouped[recent ? 'Today' : 'Earlier'].push({ meta, title });
  }
  let html = '';
  for (const group of ['Today', 'Earlier']) {
    if (!grouped[group].length) continue;
    html += `<p class="group-label">${group}</p>`;
    for (const { meta, title } of grouped[group]) {
      const running = state.runningById.has(meta.id) || (meta.id === state.activeId && Boolean(state.status?.running));
      const active = meta.id === state.activeId;
      html += `<button class="session-btn${active ? ' is-active' : ''}" type="button" data-session-id="${esc(meta.id)}" data-title="${esc(title)}" aria-current="${active ? 'page' : 'false'}"><span class="dot" data-s="${running ? 'running' : active ? (state.runState === 'error' ? 'error' : 'done') : 'idle'}"></span><span class="s-copy"><span class="s-title">${esc(title)}</span><span class="s-sub">${running ? 'Working now' : esc(formatAgo(meta.updated || meta.created))}</span></span></button>`;
    }
  }
  if (!html) html = `<p class="empty-note" id="sessionsEmpty">No sessions match.</p>`;
  nav.innerHTML = html;
  $('#taskCount').textContent = String(state.tasks.filter((task) => ['queued', 'running'].includes(task.status)).length);
  $('#checkpointCount').textContent = String(state.checkpoints.length);
}
$('#sessions').addEventListener('click', (event) => {
  const button = event.target.closest('[data-session-id]');
  if (button) void selectSession(button.dataset.sessionId, { persist: true });
});
$('#sessionSearch').addEventListener('input', renderSidebar);
$('#newSession').addEventListener('click', () => void createSession());

async function createSession() {
  if (!state.client) return showConnectSheet();
  try {
    const meta = await state.client.createSession();
    state.sessions = [meta, ...state.sessions.filter((item) => item.id !== meta.id)];
    state.sessionTitleById.set(meta.id, 'New session');
    renderSidebar();
    await selectSession(meta.id, { persist: true });
    setDrawer(false);
    toast('New session created');
  } catch (error) { toast(error.message || 'Could not create session'); }
}

async function loadRecentEvents(id, sequence) {
  const start = Math.max(0, Number(sequence || 0) - 120);
  let after = start;
  const result = [];
  for (let pageNo = 0; pageNo < 5; pageNo++) {
    const page = await state.client.getEvents(id, after);
    result.push(...(page.events || []));
    if (!page.hasMore || !page.events?.length) break;
    after = Number(page.events.at(-1)?.sequence || after);
  }
  state.historyEvents = result;
  state.activityIds = new Set(result.map((event) => event.eventId));
  for (const event of result) observeDurableEvent(event, true);
}

async function selectSession(id, { persist = false } = {}) {
  if (!id || !state.client) return;
  const same = id === state.activeId;
  if (!same) {
    state.streamAbort?.abort();
    state.streamAbort = null;
    state.activeId = id;
    state.cursor = 0;
    state.lastHeartbeat = 0;
    state.wasConnected = false;
    state.connectionLost = false;
    state.streamState = 'connecting';
    state.streamProbeAt = 0;
    state.meta = null;
    state.todos = [];
    state.queue = [];
    state.tasks = [];
    state.checkpoints = [];
    state.context = null;
    state.diff = null;
    state.workflow = null;
    state.queueUpdate = null;
    state.status = null;
    state.pendingPrompt = '';
    state.liveText = '';
    state.liveReasoning = '';
    state.liveStreamId = '';
    state.localRunning = false;
    state.runHasState = false;
    state.runState = 'idle';
    state.runStartedAt = 0;
    state.runEndedAt = 0;
    state.historyEvents = [];
    state.activity = [];
    state.stopRequested = false;
    state.activityIds = new Set();
    state.toolLifecycle = new Map();
    state.readFiles = new Map();
  }
  if (persist) localStore.set('termagent:webview:session', id);
  renderSidebar();
  setDrawer(false);
  if (lastRenderSession !== id) {
    feed.scrollTop = 0;
    lastRenderSession = id;
  }
  try {
    await refreshCurrent({ initial: true });
    startEventStream(id);
  } catch (error) {
    if (isUnauthorized(error)) showConnectSheet('Token rejected or expired.');
    else setBanner(`Session could not be loaded: ${error.message || error}`, 'error');
  }
}

async function refreshCurrent({ initial = false } = {}) {
  if (!state.activeId || !state.client) return;
  const id = state.activeId;
  const epoch = ++state.refreshEpoch;
  state.busyRefresh = true;
  try {
    const snapshot = await state.client.getSnapshot(id);
    if (id !== state.activeId || epoch !== state.refreshEpoch) return;
    const snapshotSequence = Number(snapshot.sequence || 0);
    state.meta = snapshot.state?.meta || state.sessions.find((session) => session.id === id) || null;
    state.messages = Array.isArray(snapshot.state?.messages) ? snapshot.state.messages : [];
    state.pendingInteractions = Array.isArray(snapshot.state?.pendingInteractions) ? snapshot.state.pendingInteractions : [];
    state.context = snapshot.state?.context || null;
    state.cursor = Math.max(state.cursor, snapshotSequence);
    state.status = await state.client.getSessionStatus(id).catch(() => ({ running: false, sequence: snapshotSequence }));
    if (state.status.running) {
      state.localRunning = false;
      state.runHasState = true;
      state.runState = 'running';
      if (!state.runStartedAt) state.runStartedAt = Date.now();
      state.runEndedAt = 0;
    } else if (state.runState === 'running' && !state.localRunning) {
      state.runState = 'done';
      state.runEndedAt = Date.now();
    }
    const parts = await Promise.allSettled([
      state.client.getTodo(id),
      state.client.getQueue(id, false),
      state.client.getContext(id),
      state.client.getDiff(id),
      state.client.listTasks(),
      state.client.listCheckpoints(id),
      state.client.listSubagents(id),
    ]);
    if (id !== state.activeId || epoch !== state.refreshEpoch) return;
    state.todos = unwrap(parts[0], []);
    state.queue = unwrap(parts[1], []);
    state.context = unwrap(parts[2], state.context);
    state.diff = unwrap(parts[3], { text: 'No changes.', files: [] });
    state.tasks = unwrap(parts[4], { tasks: [] })?.tasks || [];
    state.checkpoints = unwrap(parts[5], { checkpoints: [] })?.checkpoints || [];
    const subagents = unwrap(parts[6], { counts: { total: 0, running: 0, queued: 0 } });
    $('#subagentCount').textContent = String(subagents?.counts?.total || 0);
    state.sessionTitleById.set(id, activeTitle(state.messages, state.meta));
    const userMessages = state.messages.filter((message) => message.role === 'user');
    if (state.pendingPrompt && userMessages.some((message) => String(message.content || '').trim() === state.pendingPrompt.trim())) state.pendingPrompt = '';
    if (initial) await loadRecentEvents(id, snapshotSequence).catch(() => {});
    if (id !== state.activeId || epoch !== state.refreshEpoch) return;
    renderAll();
    renderSidebar();
  } finally {
    if (epoch === state.refreshEpoch) state.busyRefresh = false;
  }
}
function unwrap(result, fallback) { return result?.status === 'fulfilled' ? result.value : fallback; }

function startEventStream(id) {
  state.streamAbort?.abort();
  const controller = new AbortController();
  state.streamAbort = controller;
  const from = state.cursor;
  state.streamState = state.wasConnected ? 'reconnecting' : 'connecting';
  void (async () => {
    try {
      for await (const frame of state.client.streamEvents(id, from, {
        signal: controller.signal,
        reconnect: true,
        onConnectionState: (connection, detail) => {
          if (controller.signal.aborted || id !== state.activeId) return;
          state.streamState = connection;
          if (connection === 'reconnecting') {
            state.connectionLost = true;
            $('#runtimeStatus').textContent = 'Live updates reconnecting…';
            $('#runtimeDot').dataset.s = 'warn';
            setBanner(`Live event stream disconnected. Reconnecting from seq ${state.cursor}${detail?.error ? ` · ${detail.error}` : ''}.`, 'warn');
          } else if (connection === 'connecting' && state.wasConnected) {
            $('#runtimeStatus').textContent = 'Live updates reconnecting…';
            $('#runtimeDot').dataset.s = 'warn';
          } else if (connection === 'connecting') {
            $('#runtimeStatus').textContent = 'Connecting live updates…';
            $('#runtimeDot').dataset.s = 'warn';
          }
        },
      })) {
        if (controller.signal.aborted || id !== state.activeId) break;
        state.lastHeartbeat = Date.now();
        if (frame.event === 'ready') {
          const data = frame.data || {};
          if (typeof data.replayAfter === 'number') state.cursor = Math.max(state.cursor, data.replayAfter);
          if (state.connectionLost) {
            setBanner(`Connection restored · replaying after seq ${state.cursor}`, 'done');
            setTimeout(() => { if (state.wasConnected && !state.connectionLost) setBanner(''); }, 3000);
            state.connectionLost = false;
          }
          state.streamState = 'connected';
          state.wasConnected = true;
          $('#runtimeStatus').textContent = 'Live updates connected';
          $('#runtimeDot').dataset.s = 'done';
        } else if (frame.event === 'connection') {
          const payload = frame.data?.payload || frame.data || {};
          if (payload.state === 'connected') {
            $('#runtimeStatus').textContent = 'Live updates connected';
            $('#runtimeDot').dataset.s = 'done';
          }
        } else if (frame.event === 'heartbeat') {
          state.lastHeartbeat = Date.now();
        } else if (frame.event === 'gap') {
          // A gap never advances the durable cursor. Reconcile the full
          // canonical snapshot before continuing from the durable sequence.
          await refreshCurrent().catch(() => {});
          if (id !== state.activeId || controller.signal.aborted) break;
          setBanner('Live updates were coalesced under load. Session state has been reconciled.', 'warn');
        } else if (frame.event === 'live') {
          handleLiveEvent(frame.data);
        } else if (frame.event === 'event') {
          handleDurableEvent(frame.data);
        } else if (frame.event === 'error') {
          const data = frame.data || {};
          if (data.code === 'session-not-found') setBanner('This session is no longer available. Refresh the session list.', 'error');
          else if (data.message) setBanner(data.message, 'error');
        }
      }
    } catch (error) {
      if (controller.signal.aborted) return;
      state.connectionLost = true;
      state.streamState = 'reconnecting';
      $('#runtimeStatus').textContent = 'Live updates reconnecting…';
      $('#runtimeDot').dataset.s = 'warn';
      setBanner(`Live connection failed. The transcript remains saved; reconnecting from seq ${state.cursor}.`, 'warn');
      if (isUnauthorized(error)) showConnectSheet('Authentication expired. Reconnect with a valid token.');
    }
  })();
}

function handleLiveEvent(event) {
  if (!event || event.sessionId !== state.activeId) return;
  // The foreground POST stream is the authoritative live projection for a
  // prompt initiated in this tab. Ignore its parallel EventBus copy to avoid
  // rendering duplicate tokens and tool cards; durable events still reconcile
  // through the session event stream.
  if (state.promptStreamActive || Date.now() < state.promptStreamSuppressUntil) return;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const streamId = String(payload.streamId || '');
  if (event.kind === 'runtime.status.changed') {
    if (payload.state === 'working') {
      state.localRunning = true;
      state.runHasState = true;
      state.runState = 'running';
      state.runStartedAt = Number(payload.startedAt || Date.now());
      state.runEndedAt = 0;
      state.liveStreamId = streamId || state.liveStreamId;
      state.liveText = '';
      state.liveReasoning = '';
      state.runLabel = 'Working';
      state.runPhase = String(payload.phase || 'started');
    } else {
      state.localRunning = false;
      state.runHasState = true;
      state.runState = payload.phase === 'failed' ? 'error' : payload.phase === 'interrupted' ? 'stopped' : 'done';
      state.runEndedAt = Number(payload.endedAt || Date.now());
      state.status = state.status ? { ...state.status, running: false } : state.status;
      if (payload.phase === 'completed') state.liveText = '';
      if (payload.phase !== 'completed') state.liveReasoning = '';
      void refreshCurrent();
    }
    renderRunbar();
    renderFeed();
    renderSidebar();
    return;
  }
  if (streamId && state.liveStreamId && streamId !== state.liveStreamId && (event.kind === 'session.text.delta' || event.kind === 'session.reasoning.delta')) {
    state.liveStreamId = streamId;
    state.liveText = '';
    state.liveReasoning = '';
  } else if (streamId && !state.liveStreamId) state.liveStreamId = streamId;

  if (event.kind === 'session.text.delta') {
    state.liveText += String(payload.delta || '');
    state.runLabel = 'Generating response';
    renderFeed();
  } else if (event.kind === 'session.reasoning.delta') {
    state.liveReasoning += String(payload.delta || '');
    renderFeed();
  } else if (event.kind === 'runtime.activity.changed') {
    state.runLabel = String(payload.activityLabel || payload.message || payload.name || 'Working');
    if (payload.name) {
      state.activity.unshift({ title: String(payload.activityLabel || payload.name), sub: payload.args ? truncate(JSON.stringify(payload.args), 140) : '', at: Number(event.timestamp || Date.now()), s: 'running', eventId: event.eventId });
      state.activity = state.activity.slice(0, 40);
    }
    renderRunbar();
    renderActivity();
  } else if (event.kind === 'session.tool.output.delta') {
    const name = String(payload.name || 'Tool');
    state.activity.unshift({ title: `${name} · result`, sub: truncate(String(payload.output || ''), 140), at: Number(event.timestamp || Date.now()), s: payload.metadata?.toolLifecycle?.state === 'error' ? 'error' : 'done', eventId: event.eventId });
    state.activity = state.activity.slice(0, 40);
    renderActivity();
  }
}

function handleDurableEvent(event) {
  if (!event || event.sessionId !== state.activeId || event.durable !== true) return;
  if (Number.isSafeInteger(Number(event.sequence))) state.cursor = Math.max(state.cursor, Number(event.sequence));
  if (!state.activityIds.has(event.eventId)) {
    state.activityIds.add(event.eventId);
    state.historyEvents.push(event);
    if (state.historyEvents.length > 300) state.historyEvents.shift();
    observeDurableEvent(event, true);
  }
  if (state.runState === 'running' || state.localRunning) {
    if (event.kind === 'session.permission.asked') state.runLabel = 'Waiting for permission';
    else if (event.kind === 'session.question.asked') state.runLabel = 'Waiting for your answer';
    else if (event.kind === 'session.permission.resolved' || event.kind === 'session.question.resolved') state.runLabel = 'Thinking';
    renderRunbar();
  }
  const relevant = new Set([
    'session.message.user', 'session.message.assistant', 'session.message.tool', 'session.message.updated',
    'session.turn.started', 'session.turn.completed', 'session.turn.failed', 'session.turn.interrupted', 'session.tool.called',
    'session.permission.asked', 'session.permission.resolved', 'session.question.asked', 'session.question.resolved',
    'session.todo.updated', 'session.workflow.updated', 'session.queue.updated', 'session.verification.completed',
    'session.diff.updated', 'session.mutation.applied', 'session.compaction.completed', 'session.history.undo',
    'session.history.redo', 'session.checkpoint.created', 'session.checkpoint.restored', 'session.context.checkpoint',
    'session.task.created', 'session.task.updated', 'session.task.notification',
  ]);
  if (relevant.has(event.kind)) scheduleRefresh();
  $('#kvSeq').textContent = `seq ${state.cursor}`;
  renderActivity();
  renderFiles();
}

function observeDurableEvent(event, shouldRender) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  if (event.kind === 'session.tool.called' || event.kind === 'session.tool.started' || event.kind === 'session.tool.completed' || event.kind === 'session.tool.failed') {
    const id = String(payload.callId || payload.id || event.eventId);
    state.toolLifecycle.set(id, { ...state.toolLifecycle.get(id), ...payload, kind: event.kind, timestamp: event.timestamp });
    const name = String(payload.name || payload.tool || 'Tool');
    const args = payload.parsedArguments || payload.arguments || payload.argumentsRaw || {};
    const pathValue = typeof args === 'object' && args ? (args.path || args.file_path || args.filePath) : null;
    if (pathValue) {
      const file = String(pathValue);
      state.readFiles.set(file, { path: file, status: /write|edit|patch|apply/i.test(name) ? 'Changed' : 'Read', time: event.timestamp });
    }
    if (shouldRender) {
      state.activity.unshift({ title: name, sub: truncate(typeof args === 'string' ? args : JSON.stringify(args), 140), at: Number(event.timestamp || Date.now()), s: /failed|error/.test(event.kind) ? 'error' : /completed/.test(event.kind) ? 'done' : 'running', eventId: event.eventId });
      state.activity = state.activity.slice(0, 40);
    }
  } else if (event.kind === 'session.verification.completed') {
    const description = String(payload.command || payload.name || payload.message || 'Workspace verification');
    state.activity.unshift({ title: 'Verification', sub: description, at: Number(event.timestamp || Date.now()), s: payload.ok === false || payload.status === 'failed' ? 'error' : 'done', eventId: event.eventId });
    state.activity = state.activity.slice(0, 40);
  } else if (event.kind === 'session.mutation.applied') {
    const files = Array.isArray(payload.files) ? payload.files : payload.path ? [payload.path] : [];
    for (const file of files) if (typeof file === 'string') state.readFiles.set(file, { path: file, status: 'Changed', time: event.timestamp });
  } else if (event.kind === 'session.workflow.updated') {
    state.workflow = payload;
  } else if (event.kind === 'session.queue.updated') {
    state.queueUpdate = payload;
  }
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    void refreshCurrent().catch((error) => { if (!isUnauthorized(error)) toast(error.message || 'Refresh failed'); });
  }, 160);
}

function renderAll() {
  renderHeader();
  renderRunbar();
  renderFeed();
  renderPlan();
  renderActivity();
  renderEvidence();
  renderQueue();
  renderFiles();
  renderInteractionsSummary();
}
function renderHeader() {
  $('#sessionTitle').textContent = state.activeId ? (state.sessionTitleById.get(state.activeId) || activeTitle(state.messages, state.meta)) : 'TermAgent';
  const model = state.meta?.model || state.info?.model;
  const provider = state.info?.provider;
  $('#modelLabel').textContent = model ? `${provider || 'Runtime'} · ${model}` : 'Runtime connected';
  $('#branchLabel').textContent = compactPath(state.meta?.cwd || state.info?.cwd || 'Workspace');
}

function renderRunbar() {
  const running = Boolean(state.status?.running || state.localRunning || state.runState === 'running');
  const visible = state.runHasState || running;
  const bar = $('#runbar');
  bar.hidden = !visible;
  const kind = running ? 'running' : state.runState === 'error' ? 'error' : state.runState === 'stopped' ? 'warn' : 'done';
  bar.dataset.state = running ? 'running' : state.runState === 'error' ? 'error' : state.runState === 'stopped' ? 'stopped' : 'done';
  $('#runDot').dataset.s = kind;
  $('#runLabel').textContent = running ? (state.runLabel || 'Working') : state.runState === 'error' ? 'Run failed' : state.runState === 'stopped' ? 'Run interrupted' : 'Run complete';
  const total = Math.max(1, state.todos.length);
  const done = state.todos.filter((item) => item.status === 'done').length;
  const active = state.todos.findIndex((item) => item.status === 'in_progress');
  const current = active >= 0 ? active + 1 : Math.min(total, done + 1);
  $('#runStep').textContent = state.todos.length ? `${done} of ${total} steps complete` : running ? 'Live session activity' : 'Ready for the next prompt';
  const elapsed = state.runStartedAt ? (running ? Date.now() - state.runStartedAt : Math.max(0, state.runEndedAt - state.runStartedAt)) : 0;
  $('#runClock').textContent = formatClock(elapsed);
  $('#stopBtn').hidden = !running;
  $('#runProgress').innerHTML = (state.todos.length ? state.todos : [{}, {}, {}]).map((item, index) => {
    const status = item.status === 'done' || (state.todos.length && index < done) ? 'done' : item.status === 'in_progress' || (running && index === current - 1) ? 'active' : '';
    return `<i class="${status}"></i>`;
  }).join('');
  $('#inspTitle').textContent = running ? 'Live run' : state.runHasState ? 'Last run' : 'Session';
  $('#inspSub').textContent = running ? (state.runLabel || 'Working') : state.runState === 'error' ? 'Failed' : state.runState === 'stopped' ? 'Interrupted' : state.runHasState ? 'Complete' : 'No active run';
}

function renderMarkdown(value) {
  const source = String(value ?? '').replace(/\r\n/g, '\n');
  const lines = source.split('\n');
  const blocks = [];
  let paragraph = [];
  let code = [];
  let codeLanguage = '';
  let inCode = false;
  let list = [];
  let listType = 'ul';
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${paragraph.map((line) => inlineMarkdown(line)).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<${listType}>${list.map((line) => `<li>${inlineMarkdown(line)}</li>`).join('')}</${listType}>`);
    list = [];
    listType = 'ul';
  };
  const flushCode = () => {
    blocks.push(`<pre><code${codeLanguage ? ` data-language="${esc(codeLanguage)}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
    code = []; codeLanguage = '';
  };
  const tableCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim().replace(/\\\|/g, '|'));
  const isTableSeparator = (line) => line.includes('|') && tableCells(line).length > 1 && tableCells(line).every((cell) => /^:?-{3,}:?$/.test(cell));
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^\s*```\s*([\w.+-]*)\s*$/);
    if (fence) {
      if (inCode) { flushCode(); inCode = false; }
      else { flushParagraph(); flushList(); inCode = true; codeLanguage = fence[1]; }
      continue;
    }
    if (inCode) { code.push(line); continue; }
    if (i + 1 < lines.length && line.includes('|') && isTableSeparator(lines[i + 1])) {
      flushParagraph(); flushList();
      const headers = tableCells(line);
      i += 2; // consume the table separator as well as the header
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(tableCells(lines[i]));
        i++;
      }
      i--;
      const headerHtml = headers.map((cell) => `<th scope="col">${inlineMarkdown(cell)}</th>`).join('');
      const bodyHtml = rows.map((row) => `<tr>${headers.map((_, index) => `<td>${inlineMarkdown(row[index] || '')}</td>`).join('')}</tr>`).join('');
      blocks.push(`<div class="table-wrap" role="region" aria-label="Markdown table" tabindex="0"><table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table></div>`);
      continue;
    }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^\s{0,3}(#{1,3})\s+(.+)$/);
    if (heading) {
      flushParagraph(); flushList();
      const level = heading[1].length;
      blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
    } else if (/^\s*[-*+]\s+/.test(line)) {
      flushParagraph(); if (list.length && listType !== 'ul') flushList(); listType = 'ul'; list.push(line.replace(/^\s*[-*+]\s+/, ''));
    } else if (/^\s*\d+\.\s+/.test(line)) {
      flushParagraph(); if (list.length && listType !== 'ol') flushList(); listType = 'ol'; list.push(line.replace(/^\s*\d+\.\s+/, ''));
    } else if (/^\s*>\s?/.test(line)) {
      flushParagraph(); flushList(); blocks.push(`<blockquote>${inlineMarkdown(line.replace(/^\s*>\s?/, ''))}</blockquote>`);
    } else {
      flushList(); paragraph.push(line);
    }
  }
  if (inCode) flushCode();
  flushParagraph(); flushList();
  return blocks.join('');
}
function inlineMarkdown(value) {
  let text = esc(value);
  text = text.replace(/\[([^\]]+)\]\((https?:\/\/[^ )]+|mailto:[^ )]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
  return text;
}
function parseArgs(raw) {
  try { return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw ?? {})); }
  catch { return raw || {}; }
}
function toolSummary(name, args) {
  const value = parseArgs(args);
  if (typeof value === 'string') return `${name} ${value}`;
  if (!value || typeof value !== 'object') return name;
  const command = value.command || value.cmd || value.path || value.file_path || value.url || value.query || value.prompt;
  return `${name}${command ? ` · ${String(command)}` : ''}`;
}
function latestLifecycle(callId, name) {
  const exact = state.toolLifecycle.get(String(callId));
  if (exact) return exact;
  const matches = [...state.toolLifecycle.values()].filter((record) => String(record.name || record.tool || '') === String(name));
  return matches.at(-1);
}
function renderToolCard(call, messageIndex, output) {
  const toolName = String(call?.function?.name || call?.name || 'Tool');
  const argsRaw = call?.function?.arguments ?? call?.argumentsRaw ?? call?.arguments ?? '{}';
  const args = parseArgs(argsRaw);
  const callId = String(call?.id || call?.callId || `${messageIndex}:${toolName}`);
  const lifecycle = latestLifecycle(callId, toolName);
  const status = output ? 'done' : /failed|error/.test(String(lifecycle?.kind || lifecycle?.state || '')) ? 'error' : lifecycle?.state === 'running' ? 'running' : state.localRunning ? 'running' : 'done';
  const expanded = state.expandedTools.has(callId);
  const outputText = output?.content ?? lifecycle?.output ?? lifecycle?.result ?? (status === 'running' ? 'Waiting for tool output…' : 'No output was stored for this tool call.');
  return `<article class="tool${expanded ? ' is-open' : ''}" data-state="${status}" data-tool-id="${esc(callId)}">
    <button class="tool-head" type="button" aria-expanded="${expanded}" data-tool-toggle="${esc(callId)}">
      ${icon('terminal', 'tool-ico')}<span class="tool-cmd">${esc(toolSummary(toolName, args))}</span>
      <span class="tool-state">${status === 'running' ? icon('spinner', 'spin') : status === 'error' ? '!' : icon('check')}</span>
      <time class="tool-time">${lifecycle?.durationMs ? esc(`${(Number(lifecycle.durationMs) / 1000).toFixed(1)}s`) : ''}</time>${icon('chevron-down', 'chev')}
    </button>
    <div class="tool-body"><div>
      <p class="tool-desc">${esc(lifecycle?.description || `${toolName} · input and captured output`)}</p>
      <pre class="tool-args">${esc(typeof args === 'string' ? args : JSON.stringify(args, null, 2))}</pre>
      <pre class="term"><code>${esc(String(outputText ?? ''))}</code></pre>
      <div class="tool-foot"><button class="link-btn" type="button" data-copy="${esc(callId)}">Copy output</button></div>
    </div></div>
  </article>`;
}
function renderInteraction(request) {
  const id = String(request.requestId || '');
  if (request.kind === 'permission') {
    return `<section class="interaction" data-interaction="${esc(id)}" tabindex="-1" aria-labelledby="interaction-title-${esc(id)}"><h3 id="interaction-title-${esc(id)}">Permission required</h3><p>TermAgent needs permission to continue this action.</p><p class="interaction-meta">${esc(request.tool)} · ${esc(request.action)}</p>${Array.isArray(request.resources) && request.resources.length ? `<p>${request.resources.map(esc).join('<br>')}</p>` : ''}<div class="decision-actions"><button class="btn" data-action="permission" data-request-id="${esc(id)}" data-decision="once" type="button">Allow once</button><button class="btn" data-action="permission" data-request-id="${esc(id)}" data-decision="always" type="button">Always allow</button><button class="btn btn-danger" data-action="permission" data-request-id="${esc(id)}" data-decision="deny" type="button">Deny</button></div></section>`;
  }
  const questions = Array.isArray(request.questions) ? request.questions : [];
  return `<form class="interaction question-form" data-interaction="${esc(id)}" data-question-form="${esc(id)}" tabindex="-1" aria-labelledby="interaction-title-${esc(id)}"><h3 id="interaction-title-${esc(id)}">TermAgent needs an answer</h3>${questions.map((question, index) => {
    const options = Array.isArray(question.options) ? question.options : [];
    const type = question.multi ? 'checkbox' : 'radio';
    const name = `answer-${id}-${index}`;
    return `<div class="question-item"><p>${esc(question.question || `Question ${index + 1}`)}</p>${options.map((option, optionIndex) => `<label class="answer-option"><input type="${type}" name="${esc(name)}" value="${esc(option.label)}"/><span>${esc(option.label)}${option.description ? `<small> · ${esc(option.description)}</small>` : ''}</span></label>`).join('')}${question.custom || !options.length ? `<input type="text" class="q-custom" data-question-index="${index}" placeholder="${options.length ? 'Other answer…' : 'Your answer…'}" aria-label="Answer ${index + 1}" />` : ''}</div>`;
  }).join('')}<div class="decision-actions"><button class="btn" type="submit">Submit answer</button><button class="btn" data-action="reject-question" data-request-id="${esc(id)}" type="button">Reject</button></div></form>`;
}
function renderFeed() {
  if (!feedInner) return;
  const wasAtBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90;
  const oldTop = feed.scrollTop;
  const outputByCall = new Map();
  for (const message of state.messages) if (message.role === 'tool' && message.tool_call_id) outputByCall.set(message.tool_call_id, message);
  const items = [];
  let toolIndex = 0;
  for (let i = 0; i < state.messages.length; i++) {
    const message = state.messages[i];
    if (!message || message.role === 'system') continue;
    if (message.role === 'user') {
      items.push(`<div class="msg msg-user" data-message-index="${i}">${renderMarkdown(message.content || '')}</div>`);
    } else if (message.role === 'assistant') {
      if (message.content) items.push(`<div class="msg msg-agent" data-message-index="${i}">${renderMarkdown(message.content)}</div>`);
      if (message.reasoning) items.push(`<details class="reasoning"><summary>Reasoning / activity details</summary><div class="reasoning-body">${esc(message.reasoning)}</div></details>`);
      if (Array.isArray(message.tool_calls)) {
        for (const call of message.tool_calls) {
          toolIndex++;
          items.push(renderToolCard(call, i, outputByCall.get(call.id)));
        }
      }
    } else if (message.role === 'tool' && !message.tool_call_id) {
      items.push(renderToolCard({ id: `tool-${i}`, function: { name: message.name || 'Tool', arguments: '{}' } }, i, message));
    }
  }
  if (state.pendingPrompt && !state.messages.some((message) => message.role === 'user' && String(message.content || '').trim() === state.pendingPrompt.trim())) {
    items.push(`<div class="msg msg-user" data-pending-prompt="true">${renderMarkdown(state.pendingPrompt)}</div>`);
  }
  if (state.localRunning || state.status?.running || state.runState === 'running') {
    const stage = state.runLabel || 'Working';
    items.push(`<div class="live-stage" role="status" aria-live="polite"><span class="dot" data-s="running"></span><span>${esc(stage)}</span><small>Live activity</small></div>`);
  }
  if (state.liveReasoning) items.push(`<details class="reasoning"><summary>Live reasoning / activity</summary><div class="reasoning-body">${esc(state.liveReasoning)}<span class="caret" aria-hidden="true"></span></div></details>`);
  if (state.liveText && (state.localRunning || state.status?.running || state.runState === 'running')) items.push(`<div class="msg msg-agent" data-live-response="true">${renderMarkdown(state.liveText)}<span class="caret" aria-hidden="true"></span></div>`);
  const pending = state.pendingInteractions.filter((item) => item.status === 'pending');
  items.push(...pending.map(renderInteraction));
  const proofs = recentProofs();
  if (proofs.length) items.push(`<div class="proofs">${proofs.map((proof) => `<span class="proof" data-s="${proof.ok ? 'success' : 'error'}">${icon(proof.ok ? 'check' : 'x')}${esc(proof.label)}</span>`).join('')}</div>`);
  if (!items.length) {
    $('#feedEmpty').hidden = false;
    feedInner.innerHTML = '<div class="empty empty-transcript" id="feedEmpty"><strong>Start with a prompt</strong><p>TermAgent will show messages, tool activity, permissions and verified changes here.</p></div>';
  } else {
    feedInner.innerHTML = items.join('');
  }
  if (wasAtBottom || lastRenderSession !== state.activeId) feed.scrollTop = feed.scrollHeight;
  else feed.scrollTop = oldTop;
  $('#jump').classList.toggle('is-visible', feed.scrollHeight - feed.scrollTop - feed.clientHeight > 160);
}
function recentProofs() {
  const events = state.historyEvents.filter((event) => event.kind === 'session.verification.completed').slice(-3);
  return events.map((event) => {
    const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
    const ok = payload.ok !== false && payload.status !== 'failed' && payload.status !== 'error';
    const label = payload.command ? truncate(String(payload.command), 48) : payload.message ? truncate(String(payload.message), 48) : ok ? 'Verification complete' : 'Verification failed';
    return { ok, label };
  });
}

feed.addEventListener('scroll', () => {
  const gap = feed.scrollHeight - feed.scrollTop - feed.clientHeight;
  $('#jump').classList.toggle('is-visible', gap > 160);
}, { passive: true });
$('#jump').addEventListener('click', () => feed.scrollTo({ top: feed.scrollHeight, behavior: reducedMotion.matches ? 'auto' : 'smooth' }));
new ResizeObserver(() => {
  if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 90) feed.scrollTop = feed.scrollHeight;
}).observe(feedInner);

feedInner.addEventListener('click', async (event) => {
  const head = event.target.closest('[data-tool-toggle]');
  if (head) {
    const id = head.dataset.toolToggle;
    const card = head.closest('.tool');
    const open = card.classList.toggle('is-open');
    head.setAttribute('aria-expanded', String(open));
    if (open) state.expandedTools.add(id); else state.expandedTools.delete(id);
    return;
  }
  const copy = event.target.closest('[data-copy]');
  if (copy) {
    const card = copy.closest('.tool');
    const output = card?.querySelector('.term code')?.textContent || '';
    try { await navigator.clipboard.writeText(output); toast('Output copied'); }
    catch { toast('Clipboard access is blocked in this browser'); }
    return;
  }
  const permission = event.target.closest('[data-action="permission"]');
  if (permission) {
    permission.disabled = true;
    try {
      await state.client.resolvePermission(state.activeId, permission.dataset.requestId, permission.dataset.decision);
      toast(permission.dataset.decision === 'deny' ? 'Permission denied' : 'Permission resolved');
      await refreshCurrent();
    } catch (error) { toast(error.message || 'Permission response failed'); permission.disabled = false; }
  }
  const reject = event.target.closest('[data-action="reject-question"]');
  if (reject) {
    reject.disabled = true;
    try { await state.client.rejectQuestion(state.activeId, reject.dataset.requestId); await refreshCurrent(); toast('Question rejected'); }
    catch (error) { toast(error.message || 'Could not reject question'); reject.disabled = false; }
  }
});
feedInner.addEventListener('submit', async (event) => {
  const form = event.target.closest('[data-question-form]');
  if (!form) return;
  event.preventDefault();
  const id = form.dataset.questionForm;
  const request = state.pendingInteractions.find((item) => item.requestId === id && item.kind === 'question');
  if (!request) return toast('That question is no longer pending');
  const answers = (request.questions || []).map((question, index) => {
    const name = `answer-${id}-${index}`;
    const selected = $$(`input[name="${CSS.escape(name)}"]:checked`, form).map((input) => input.value);
    const custom = $(`.q-custom[data-question-index="${index}"]`, form)?.value.trim();
    if (custom) selected.push(custom);
    return selected;
  });
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  try { await state.client.answerQuestion(state.activeId, id, answers); await refreshCurrent(); toast('Answer submitted'); }
  catch (error) { toast(error.message || 'Could not submit answer'); submit.disabled = false; }
});

function renderPlan() {
  const list = $('#plan');
  const todos = Array.isArray(state.todos) ? state.todos : [];
  const workflow = state.workflow || {};
  const sorted = [...todos];
  if (!sorted.length) {
    list.innerHTML = `<li data-s="todo"><span class="pi"></span><span>${esc(workflow.summary || workflow.lastProgress || 'No plan recorded for this session yet.')}</span></li>`;
    return;
  }
  list.classList.toggle('is-paused', state.runState === 'stopped');
  list.innerHTML = sorted.map((item) => {
    const status = item.status === 'done' ? 'done' : item.status === 'in_progress' ? 'current' : 'todo';
    return `<li data-s="${status}"><span class="pi">${icon('check')}</span><span>${esc(item.task || item.title || 'Task')}</span></li>`;
  }).join('');
}
function renderActivity() {
  const list = $('#timeline');
  const activities = [...state.activity].slice(0, 18);
  if (!activities.length) {
    list.innerHTML = `<li><span class="dot" data-s="idle"></span><div><strong>No recent activity</strong><small>Live tool and verification events appear here.</small></div></li>`;
    return;
  }
  list.innerHTML = activities.map((item) => {
    const status = item.s === 'error' ? 'error' : item.s === 'running' ? 'running' : item.s === 'warn' ? 'warn' : 'done';
    return `<li><span class="dot" data-s="${status}"></span><div><strong>${esc(item.title)}</strong><small>${esc(item.sub || '')}</small></div><time>${esc(formatAgo(item.at))}</time></li>`;
  }).join('');
}
function renderEvidence() {
  const toolMessages = state.messages.reduce((sum, message) => sum + (Array.isArray(message.tool_calls) ? message.tool_calls.length : 0), 0);
  $('#kvTools').textContent = String(Math.max(toolMessages, state.toolLifecycle.size));
  $('#kvTasks').textContent = `${state.tasks.filter((task) => ['queued', 'running'].includes(task.status)).length} active`;
  $('#kvSeq').textContent = `seq ${state.cursor}`;
  $('#kvWorkspace').textContent = state.diff?.files?.length ? `${state.diff.files.length} changed` : 'No diff';
  const tokens = Number(state.context?.tokens || 0);
  const limit = Number(state.context?.limit || 0);
  $('#kvContext').textContent = limit ? `${formatCompact(tokens)} / ${formatCompact(limit)}` : '—';
  const context = $('#ctx');
  if (limit > 0) {
    const pct = Math.min(100, Math.round(tokens / limit * 100));
    context.title = `${tokens.toLocaleString()} of ${limit.toLocaleString()} estimated tokens`;
    context.innerHTML = `<i style="--p:${pct}%"></i>${pct}%`;
  } else {
    context.title = 'Context usage unavailable';
    context.innerHTML = '<i style="--p:0%"></i>—';
  }
}
function renderQueue() {
  const queue = $('#queue');
  const active = (state.queue || []).filter((item) => ['queued', 'executing'].includes(item.status)).sort((a, b) => a.position - b.position);
  if (!active.length) { queue.hidden = true; queue.innerHTML = ''; return; }
  const first = active[0];
  queue.hidden = false;
  queue.innerHTML = `<span class="q-label">${first.status === 'executing' ? 'Next' : 'Queued'}</span><span class="q-text" title="${esc(first.content)}">${esc(first.content)}</span>${active.length > 1 ? `<span class="q-more">+${active.length - 1}</span>` : ''}<button class="icon-btn" type="button" data-action="cancel-queue" data-queue-id="${esc(first.id)}" aria-label="Remove queued prompt">${icon('x')}</button>`;
}
function renderFiles() {
  const diff = state.diff && typeof state.diff === 'object' ? state.diff : { text: 'No changes.', files: [] };
  const files = Array.isArray(diff.files) ? diff.files : [];
  $('#changesEmpty').hidden = files.length > 0;
  $('#changedFiles').innerHTML = files.map((file) => `<li><svg class="i" aria-hidden="true"><use href="#i-file"/></svg><span class="fpath">${esc(file.path)}</span><span class="tag">+${Number(file.additions || 0)} −${Number(file.deletions || 0)}</span></li>`).join('');
  const text = String(diff.text || 'No changes.');
  const preview = $('#diffPreview');
  preview.hidden = !files.length;
  preview.textContent = text;
  const reads = [...state.readFiles.values()].slice(-24).reverse();
  $('#readFiles').innerHTML = reads.length ? reads.map((file) => `<li><svg class="i" aria-hidden="true"><use href="#i-file"/></svg><span class="fpath">${esc(file.path)}</span><span class="tag">${esc(file.status)}</span></li>`).join('') : '<li><span class="empty">No file paths recorded in recent tool events.</span></li>';
}
function renderInteractionsSummary() {
  const pending = state.pendingInteractions.filter((item) => item.status === 'pending');
  const btn = $('#permBtn');
  const small = $('.row-copy small', btn);
  small.textContent = pending.length ? `${pending.length} waiting for a response` : 'No pending requests';
  btn.setAttribute('aria-label', pending.length ? `${pending.length} pending permissions or questions` : 'No pending permission or question requests');
}
function formatCompact(value) {
  const n = Number(value || 0);
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}k` : String(n);
}
function truncate(value, max = 140) { const text = String(value ?? '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max - 1)}…` : text; }

$('#stopBtn').addEventListener('click', async () => {
  if (!state.activeId || !state.client) return;
  $('#stopBtn').disabled = true;
  state.stopRequested = true;
  try {
    const result = await state.client.abort(state.activeId);
    if (result?.result?.interrupted === false) { state.stopRequested = false; toast('No active run to stop'); }
    else toast('Stop requested');
    setTimeout(() => { $('#stopBtn').disabled = false; }, 800);
  } catch (error) { toast(error.message || 'Stop request failed'); $('#stopBtn').disabled = false; }
});

$('#composer').addEventListener('submit', (event) => { event.preventDefault(); void submitPrompt(); });
const input = $('#input');
const sendButton = $('#send');
function resizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(168, Math.max(48, input.scrollHeight))}px`;
}
input.addEventListener('input', () => {
  sendButton.disabled = !input.value.trim();
  resizeInput();
  updateSlash();
});
input.addEventListener('keydown', (event) => {
  if (!slashEl.hidden && state.slashItems.length) {
    if (event.key === 'ArrowDown') { event.preventDefault(); state.slashIndex = (state.slashIndex + 1) % state.slashItems.length; renderSlash(); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); state.slashIndex = (state.slashIndex - 1 + state.slashItems.length) % state.slashItems.length; renderSlash(); return; }
    if (event.key === 'Escape') { hideSlash(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !mobilePointer.matches) {
      event.preventDefault(); const item = state.slashItems[state.slashIndex]; if (item) { input.value = item.command; hideSlash(); void executeSlash(item.command); } return;
    }
  }
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void submitPrompt(); }
  else if (event.key === 'Enter' && !event.shiftKey && !mobilePointer.matches) { event.preventDefault(); void submitPrompt(); }
});

const SLASH_COMMANDS = [
  { command: '/compact', label: 'Compact context', desc: 'Summarize older conversation context' },
  { command: '/undo', label: 'Undo last turn', desc: 'Restore the previous workspace snapshot' },
  { command: '/redo', label: 'Redo last turn', desc: 'Reapply the reverted turn' },
  { command: '/new', label: 'New session', desc: 'Create a separate session' },
  { command: '/tasks', label: 'Inspect tasks', desc: 'View background and verification tasks' },
  { command: '/checkpoints', label: 'Checkpoints', desc: 'Inspect and restore saved checkpoints' },
  { command: '/context', label: 'Context usage', desc: 'Show token budget and workspace' },
  { command: '/usage', label: 'Provider usage', desc: 'Show durable provider token history for this session' },
  { command: '/theme', label: 'Theme', desc: 'Choose dark, light or system' },
  { command: '/focus', label: 'Focus mode', desc: 'Hide navigation and the inspector' },
  { command: '/help', label: 'Commands', desc: 'Show supported Web View actions' },
];
function updateSlash() {
  const value = input.value;
  if (!value.startsWith('/') || value.includes('\n')) return hideSlash();
  const query = value.toLowerCase();
  state.slashItems = SLASH_COMMANDS.filter((item) => item.command.startsWith(query) || item.label.toLowerCase().includes(query.slice(1)));
  state.slashIndex = 0;
  if (!state.slashItems.length) return hideSlash();
  slashEl.hidden = false;
  renderSlash();
}
function renderSlash() {
  slashEl.hidden = !state.slashItems.length;
  slashEl.innerHTML = state.slashItems.map((item, index) => `<button type="button" role="option" aria-selected="${index === state.slashIndex}" data-slash="${esc(item.command)}"><b>${esc(item.command)}</b><span>${esc(item.desc)}</span></button>`).join('');
}
function hideSlash() { slashEl.hidden = true; state.slashItems = []; }
slashEl.addEventListener('click', (event) => {
  const button = event.target.closest('[data-slash]');
  if (!button) return;
  input.value = button.dataset.slash;
  sendButton.disabled = false;
  hideSlash();
  void executeSlash(input.value);
});

function promptToolActivity(name) {
  const tool = String(name || '').toLowerCase();
  if (['task', 'background_agent', 'parallel_agents'].includes(tool)) return 'Delegating to subagents';
  if (['read_file', 'list_files', 'grep', 'glob', 'repo_map', 'search_files', 'find_files', 'web_search'].includes(tool)) return 'Exploring workspace';
  if (['write_file', 'edit_file', 'apply_patch', 'delete_file'].includes(tool)) return 'Editing files';
  if (tool === 'bash' || tool === 'shell') return 'Running terminal command';
  if (tool.includes('test') || tool === 'verify') return 'Running verification';
  return `Using ${name || 'tool'}`;
}

function handlePromptStreamFrame(frame, sessionId) {
  if (sessionId !== state.activeId || !frame) return;
  const payload = frame.data && typeof frame.data === 'object' ? frame.data : {};
  if (frame.event === 'heartbeat') {
    state.lastHeartbeat = Date.now();
    return;
  }
  if (frame.event === 'status') {
    state.runLabel = String(payload.message || 'Working');
    renderRunbar();
    renderFeed();
    return;
  }
  if (frame.event === 'text') {
    state.liveText += String(payload.delta || '');
    state.runLabel = 'Generating response';
    renderFeed();
    renderRunbar();
    return;
  }
  if (frame.event === 'reasoning') {
    state.liveReasoning += String(payload.delta || '');
    renderFeed();
    return;
  }
  if (frame.event === 'tool_start') {
    const name = String(payload.name || 'Tool');
    const label = promptToolActivity(name);
    state.runLabel = label;
    state.activity.unshift({ title: label, sub: truncate(toolSummary(name, payload.args), 140), at: Date.now(), s: 'running', eventId: String(payload.callId || `live-${Date.now()}`) });
    state.activity = state.activity.slice(0, 40);
    renderActivity();
    renderRunbar();
    renderFeed();
    return;
  }
  if (frame.event === 'tool_end') {
    const name = String(payload.name || 'Tool');
    const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
    const lifecycle = metadata.toolLifecycle && typeof metadata.toolLifecycle === 'object' ? metadata.toolLifecycle : {};
    const output = String(payload.output || '');
    const denied = /permission denied|denied by permission/i.test(output);
    const failed = denied || lifecycle.state === 'error' || Boolean(lifecycle.error);
    state.activity.unshift({
      title: `${name} · ${denied ? 'permission denied' : failed ? 'failed' : 'completed'}`,
      sub: truncate(output, 140), at: Date.now(), s: failed ? 'error' : 'done',
      eventId: String(payload.callId || `result-${Date.now()}`),
    });
    state.activity = state.activity.slice(0, 40);
    if (denied) state.runLabel = `Permission denied for ${name}`;
    else state.runLabel = 'Thinking';
    renderActivity();
    renderRunbar();
    renderFeed();
    return;
  }
  if (frame.event === 'question') {
    state.runLabel = 'Waiting for your answer';
    scheduleRefresh();
    renderRunbar();
    renderFeed();
    return;
  }
  if (frame.event === 'error') {
    throw new Error(String(payload.message || 'Prompt stream failed'));
  }
}

async function submitPrompt() {
  const prompt = input.value.trim();
  if (!prompt || !state.client || !state.activeId) return;
  hideSlash();
  if (prompt.startsWith('/') && SLASH_COMMANDS.some((item) => item.command === prompt.split(/\s+/)[0])) {
    input.value = ''; sendButton.disabled = true; resizeInput();
    return executeSlash(prompt);
  }
  const wasBusy = Boolean(state.status?.running || state.localRunning || state.runState === 'running');
  input.value = ''; sendButton.disabled = true; resizeInput();
  if (wasBusy) {
    try {
      await state.client.enqueue(state.activeId, prompt);
      toast('Added to the session queue');
      await refreshCurrent();
    } catch (error) { toast(error.message || 'Could not queue prompt'); input.value = prompt; sendButton.disabled = false; resizeInput(); }
    return;
  }
  state.pendingPrompt = prompt;
  state.lastPrompt = prompt;
  state.stopRequested = false;
  state.localRunning = true;
  state.runHasState = true;
  state.runState = 'running';
  state.runStartedAt = Date.now();
  state.runEndedAt = 0;
  state.runLabel = 'Preparing workspace context';
  state.liveText = '';
  state.liveReasoning = '';
  state.liveStreamId = '';
  renderAll();
  const promptSessionId = state.activeId;
  let receivedDone = false;
  state.promptStreamActive = true;
  try {
    const mode = state.mode === 'Ask' ? 'explore' : state.mode.toLowerCase();
    for await (const frame of state.client.streamPrompt(promptSessionId, prompt, { mode, autonomous: false })) {
      handlePromptStreamFrame(frame, promptSessionId);
      if (frame.event === 'done') receivedDone = true;
    }
    if (!receivedDone && !state.stopRequested) throw new Error('The prompt stream ended before the run completed.');
    state.localRunning = false;
    state.runState = state.runState === 'running' ? 'done' : state.runState;
    state.runEndedAt = Date.now();
    state.pendingPrompt = '';
    state.liveText = '';
    state.liveReasoning = '';
    await refreshCurrent();
  } catch (error) {
    if (error instanceof TermAgentError && error.status === 409) {
      try {
        await state.client.enqueue(state.activeId, prompt);
        state.localRunning = false;
        state.runState = 'running';
        state.pendingPrompt = '';
        toast('Session is already working. Prompt queued instead.');
        await refreshCurrent();
        return;
      } catch (queueError) { error = queueError; }
    }
    state.localRunning = false;
    state.runState = state.stopRequested ? 'stopped' : 'error';
    state.runEndedAt = Date.now();
    state.pendingPrompt = '';
    await refreshCurrent().catch(() => {});
    toast(state.stopRequested ? 'Run interrupted' : (error.message || 'Prompt failed'));
    state.stopRequested = false;
    renderAll();
  } finally {
    state.promptStreamActive = false;
    state.promptStreamSuppressUntil = Date.now() + 2_000;
  }
}

async function executeSlash(value) {
  const [command, ...args] = String(value).trim().split(/\s+/);
  try {
    switch (command) {
      case '/compact': await state.client.compact(state.activeId); toast('Context compacted'); await refreshCurrent(); break;
      case '/undo': if (!confirm('Undo the last turn and restore its workspace snapshot?')) return; await state.client.undo(state.activeId); toast('Last turn undone'); await refreshCurrent(); break;
      case '/redo': await state.client.redo(state.activeId); toast('Last turn restored'); await refreshCurrent(); break;
      case '/new': await createSession(); break;
      case '/tasks': await openTasks(); break;
      case '/subagents': await openSubagents(); break;
      case '/checkpoints': await openCheckpoints(); break;
      case '/context': openContext(); break;
      case '/usage': openContext({ showUsage: true }); break;
      case '/theme': openTheme(); break;
      case '/focus': toggleFocus(); break;
      case '/help': openHelp(); break;
      default: if (value.trim()) { input.value = value; sendButton.disabled = false; toast('Unknown command. Use /help for supported actions.'); }
    }
  } catch (error) { toast(error.message || `Command ${command} failed`); }
}

$('#modeBtn').addEventListener('click', () => {
  const modes = ['Build', 'Plan', 'Ask'];
  state.mode = modes[(modes.indexOf(state.mode) + 1) % modes.length];
  $('#modeLabel').textContent = state.mode;
  $('#modeBtn').setAttribute('aria-label', `Mode: ${state.mode}. Tap to change.`);
  toast(`Mode: ${state.mode}${state.mode === 'Ask' ? ' · read-only exploration' : ''}`);
});
$('#attachBtn').addEventListener('click', openContext);

function toggleFocus() {
  state.focus = !state.focus;
  localStore.set('termagent:webview:focus', state.focus ? '1' : '0');
  document.body.classList.toggle('is-focus', state.focus);
  toast(state.focus ? 'Focus mode enabled' : 'Focus mode disabled');
}
function openTheme() {
  openSheet('Appearance', `<p class="sheet-note">Choose a theme. The preference is local to this browser.</p><div class="seg" style="grid-template-columns:repeat(3,1fr)"><button type="button" data-theme-choice="dark" aria-pressed="${state.theme === 'dark'}">Dark</button><button type="button" data-theme-choice="light" aria-pressed="${state.theme === 'light'}">Light</button><button type="button" data-theme-choice="system" aria-pressed="${state.theme === 'system'}">System</button></div>`);
}
function openOptions() {
  openSheet('Options', `
    <p class="sheet-group">Session</p>
    <button class="sheet-action" type="button" data-action="compact"><span>Compact context<small>Free context space while preserving recent work</small></span>${icon('chevron-right')}</button>
    <button class="sheet-action" type="button" data-action="undo"><span>Undo last turn<small>Restore the previous workspace snapshot</small></span>${icon('chevron-right')}</button>
    <button class="sheet-action" type="button" data-action="redo"><span>Redo last turn<small>Reapply the last reverted turn</small></span>${icon('chevron-right')}</button>
    <button class="sheet-action" type="button" data-action="checkpoint"><span>Create checkpoint<small>Save a named recovery point</small></span>${icon('chevron-right')}</button>
    <p class="sheet-group">Workspace</p>
    <button class="sheet-action" type="button" data-action="subagents">Subagents<small>Delegated agents, live activity and child conversations</small>${icon('chevron-right')}</button>
    <button class="sheet-action" type="button" data-action="tasks">Tasks and output${icon('chevron-right')}</button>
    <button class="sheet-action" type="button" data-action="checkpoints">Checkpoints${icon('chevron-right')}</button>
    <button class="sheet-action" type="button" data-action="context">Context and runtime${icon('chevron-right')}</button>
    <button class="sheet-action" type="button" data-action="theme">Appearance${icon('chevron-right')}</button>
    <button class="sheet-action" type="button" data-action="focus">${state.focus ? 'Exit focus mode' : 'Focus mode'}${icon('chevron-right')}</button>
    <button class="sheet-action" type="button" data-action="reconnect">Reconnect runtime${icon('replay')}</button>
    <p class="sheet-note">Browser controls issue the same session commands as the terminal. Tokens are not written to browser storage.</p>`);
}
$('#moreBtn').addEventListener('click', openOptions);
$('#permBtn').addEventListener('click', () => {
  const pending = state.pendingInteractions.filter((item) => item.status === 'pending');
  if (!pending.length) return openSheet('Permissions', '<p class="sheet-note">There are no pending permission or question requests for this session.</p>');
  openSheet('Pending requests', pending.map((item) => `<div class="sheet-item"><strong>${item.kind === 'permission' ? `Permission · ${esc(item.tool)} ${esc(item.action)}` : 'Question from TermAgent'}</strong><p>${item.kind === 'permission' ? esc((item.resources || []).join(', ')) : esc((item.questions || []).map((question) => question.question).join(' · '))}</p><small>Request ${esc(item.requestId)}</small><div class="item-actions"><button class="btn" data-action="jump-interaction" data-request-id="${esc(item.requestId)}" type="button">Review in session</button></div></div>`).join(''));
});

function formatDuration(started, ended = Date.now()) {
  const seconds = Math.max(0, Math.floor((Number(ended || Date.now()) - Number(started || Date.now())) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function subagentStatus(status) {
  return ({ queued: 'Queued', running: 'Running', exited: 'Completed', failed: 'Failed', cancelled: 'Cancelled' })[status] || String(status || 'Unknown');
}
function renderSubagentNode(node) {
  const task = node.task;
  const status = task.status;
  const duration = formatDuration(task.started, task.ended || (status === 'running' ? Date.now() : task.updated));
  const role = task.specialistRole || 'general';
  const scopes = task.scopePaths?.length ? task.scopePaths.join(', ') : 'Workspace scope';
  const activity = task.activity ? `<div class="agent-activity"><span class="agent-activity-mark" data-s="${esc(task.activity.outcome || 'running')}"></span><span><strong>${esc(task.activity.label)}</strong></span></div>` : '';
  const stats = [
    `${Number(task.runCount || 0)} ${Number(task.runCount || 0) === 1 ? 'run' : 'runs'}`,
    task.usage ? `${Number(task.usage.totalTokens || 0).toLocaleString()} tokens` : null,
    task.background ? 'background' : null,
    task.coordinated ? 'parallel group' : null,
  ].filter(Boolean).join(' · ');
  return `<article class="agent-card" data-depth="${Math.min(Number(node.depth || 0), 5)}">
    <div class="agent-card-head"><div class="agent-ident"><span class="agent-role">${esc(role)}</span><span class="agent-id">${esc(task.id.slice(0, 12))}</span></div><span class="agent-badge" data-s="${esc(status)}">${esc(subagentStatus(status))}</span></div>
    <p class="agent-prompt">${esc(task.prompt || task.result || 'No prompt recorded')}</p>
    ${activity}
    <div class="agent-meta"><span>${duration}</span><span>${esc(stats || 'No usage reported')}</span></div>
    <div class="agent-scope" title="${esc(scopes)}">${icon('folder')}<span>${esc(scopes)}</span></div>
    <div class="agent-actions"><button class="btn" type="button" data-action="subagent-details" data-task-id="${esc(task.id)}">Details</button>${['queued', 'running'].includes(status) ? `<button class="btn btn-danger" type="button" data-action="subagent-cancel" data-task-id="${esc(task.id)}">Cancel</button>` : ''}</div>
    ${node.children?.length ? `<div class="agent-children">${node.children.map(renderSubagentNode).join('')}</div>` : ''}
  </article>`;
}
function renderSubagentWorkspace(workspace) {
  const counts = workspace.counts || {};
  const summary = `<div class="agent-summary"><div><strong>${Number(counts.total || 0)}</strong><span>Agents</span></div><div><strong>${Number(counts.running || 0)}</strong><span>Running</span></div><div><strong>${Number(counts.queued || 0)}</strong><span>Queued</span></div><div><strong>${Number(counts.completed || 0)}</strong><span>Completed</span></div></div>`;
  const tree = workspace.agents?.length ? `<div class="agent-tree">${workspace.agents.map(renderSubagentNode).join('')}</div>` : '<div class="agent-empty"><strong>No subagents in this session</strong><p>When TermAgent delegates work through task, background_agent or parallel_agents, each child appears here with its role, scope and activity.</p></div>';
  return `${summary}${tree}<p class="sheet-note">This workspace observes the existing agent tasks. Terminal and browser operate on the same task records. Pause is not offered because the worker runtime does not implement a pause state.</p>`;
}
async function openSubagents() {
  const rootId = state.activeId;
  if (!rootId || !state.client) return;
  state.subagentView = 'list';
  state.subagentRootId = rootId;
  state.subagentTaskId = '';
  openSheet('Subagents', '<p class="sheet-note">Loading the delegated agent tree…</p>');
  const requestKey = state.subagentRequestKey;
  let inFlight = false;
  const current = () => requestKey === state.subagentRequestKey && sheet.classList.contains('is-open') && state.subagentView === 'list' && rootId === state.activeId;
  const refresh = async () => {
    if (!current() || inFlight) return;
    inFlight = true;
    try {
      const workspace = await state.client.listSubagents(rootId);
      if (!current()) return;
      $('#subagentCount').textContent = String(workspace.counts?.total || 0);
      $('#sheetBody').innerHTML = renderSubagentWorkspace(workspace);
    } catch (error) {
      if (current()) $('#sheetBody').innerHTML = `<p class="sheet-note">${esc(error.message || 'Could not load subagents')}</p>`;
    } finally {
      inFlight = false;
    }
  };
  await refresh();
  if (current()) state.subagentPollTimer = setInterval(() => void refresh(), 1800);
}
function renderSubagentControls(task) {
  const active = ['queued', 'running'].includes(task.status);
  if (active) return `<form class="sheet-form agent-followup" id="subagentSendForm" data-task-id="${esc(task.id)}"><label for="subagentInstruction">Send an additional instruction</label><textarea class="sheet-input" id="subagentInstruction" rows="3" required placeholder="Add context or redirect the child agent…"></textarea><button class="btn btn-block" type="submit">Send instruction</button><button class="btn btn-danger btn-block" type="button" data-action="subagent-cancel" data-task-id="${esc(task.id)}">Cancel agent</button></form>`;
  return `<form class="sheet-form agent-followup" id="subagentResumeForm" data-task-id="${esc(task.id)}"><label for="subagentResumePrompt">Continue this agent</label><textarea class="sheet-input" id="subagentResumePrompt" rows="3" required placeholder="Continue from the saved child session…"></textarea><button class="btn btn-block" type="submit">Resume agent</button></form>`;
}
function childSessionIdForTask(task) {
  if (task.childSessionId) return task.childSessionId;
  return task.sessionId && task.sessionId !== task.parentSessionId ? task.sessionId : '';
}
function renderSubagentDetailShell(task) {
  const status = task.status;
  const scopes = task.scopePaths?.length ? task.scopePaths.join(', ') : 'Workspace scope';
  const childSessionId = childSessionIdForTask(task);
  const usage = task.usage ? `${Number(task.usage.totalTokens || 0).toLocaleString()} tokens · ${Number(task.usage.inputTokens || 0).toLocaleString()} in / ${Number(task.usage.outputTokens || 0).toLocaleString()} out${task.usage.estimated ? ' · estimated' : ''}` : 'Usage not reported';
  return `<div class="agent-detail" data-task-id="${esc(task.id)}">
    <button class="link-btn" type="button" data-action="subagent-back">${icon('chevron-right')} All subagents</button>
    <div class="agent-detail-title"><div><span class="agent-role">${esc(task.specialistRole || 'general')}</span><h3>${esc((task.prompt || `Subagent ${task.id.slice(0, 10)}`).slice(0, 260))}</h3></div><span id="agentDetailStatus" class="agent-badge" data-s="${esc(status)}">${esc(subagentStatus(status))}</span></div>
    <div class="agent-detail-stats"><div><small>Duration</small><strong id="agentDetailDuration">${formatDuration(task.started, task.ended || Date.now())}</strong></div><div><small>Runs</small><strong id="agentDetailRuns">${Number(task.runCount || 0)}</strong></div><div><small>Output</small><strong id="agentDetailBytes">${Number(task.outputBytes || 0).toLocaleString()} bytes</strong></div></div>
    <section class="agent-detail-section"><h4>Execution</h4><p>Task <code>${esc(task.id)}</code></p><p>Parent <code>${esc(task.parentTaskId || task.parentSessionId || 'root session')}</code></p><p>Child session <code id="agentChildSession">${esc(childSessionId || 'not created')}</code></p><p>Depth ${Number(task.delegationDepth || 0)} · ${esc(scopes)}</p><p id="agentDetailUsage">${esc(usage)}</p><p id="agentDetailActivity" class="agent-activity-text">${task.activity ? esc(task.activity.label) : 'Waiting for activity…'}</p></section>
    <section class="agent-detail-section"><h4>Child conversation</h4><div id="agentTranscript" class="agent-transcript"><p class="sheet-note">Loading child transcript…</p></div></section>
    <section class="agent-detail-section"><h4>Activity timeline</h4><div id="agentTimeline" class="agent-timeline"><p class="sheet-note">Loading lifecycle events…</p></div></section>
    <section class="agent-detail-section"><h4>Task output</h4><pre id="agentOutput" class="agent-output">Loading output…</pre></section>
    <div id="agentDetailControls" data-active="${['queued', 'running'].includes(status) ? 'true' : 'false'}">${renderSubagentControls(task)}</div>
    <p class="sheet-note">The transcript is read from the existing child session. Instructions are delivered through TaskManager; no duplicate agent is created.</p>
  </div>`;
}
function renderChildTranscript(page) {
  const messages = page?.messages || [];
  if (!messages.length) return '<p class="sheet-note">No child messages have been recorded yet.</p>';
  return messages.slice(-14).map((message) => {
    const role = String(message.role || 'message');
    const content = String(message.content || '').trim();
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    return `<article class="agent-message" data-role="${esc(role)}"><div class="agent-message-meta">${esc(role)}</div>${content ? `<p>${esc(content)}</p>` : ''}${calls.length ? `<div class="agent-tool-list">${calls.map((call) => `<span>${esc(call.function?.name || 'tool')}</span>`).join('')}</div>` : ''}</article>`;
  }).join('');
}
function renderTaskTimeline(events) {
  if (!events?.length) return '<p class="sheet-note">No lifecycle events are available yet.</p>';
  return events.slice(-24).reverse().map((item) => {
    const data = item.data && typeof item.data === 'object' ? item.data : {};
    const detail = data.activity?.label || data.name || data.message || data.error || data.outputBytes && `${data.outputBytes} output bytes` || '';
    return `<div class="agent-event"><time>${esc(new Date(Number(item.ts || 0)).toLocaleTimeString())}</time><div><strong>${esc(item.type)}</strong>${detail ? `<small>${esc(String(detail).slice(0, 180))}</small>` : ''}</div></div>`;
  }).join('');
}
async function openSubagentDetail(taskId) {
  stopSubagentPolling();
  state.subagentView = 'detail';
  state.subagentTaskId = taskId;
  const rootId = state.subagentRootId || state.activeId;
  openSheet('Subagent', '<p class="sheet-note">Loading agent details, child session and lifecycle…</p>');
  const requestKey = state.subagentRequestKey;
  let initial = true;
  let inFlight = false;
  let lastEventSequence = 0;
  let queuedRefreshTimer = null;
  const current = () => requestKey === state.subagentRequestKey && sheet.classList.contains('is-open') && state.subagentView === 'detail' && state.subagentTaskId === taskId && rootId === state.activeId;
  const refresh = async () => {
    if (!current() || inFlight || !state.client) return;
    inFlight = true;
    try {
      const [task, events, output] = await Promise.all([
        state.client.getTask(taskId),
        state.client.getTaskEvents(taskId, 120),
        state.client.getTaskOutput(taskId, 24000, true),
      ]);
      const childSessionId = childSessionIdForTask(task);
      let childMessages;
      if (childSessionId) childMessages = await state.client.getMessages(childSessionId, 0, 14, true).catch(() => undefined);
      if (!current()) return;
      lastEventSequence = Math.max(lastEventSequence, Number(events.at(-1)?.seq || 0));
      if (initial) {
        $('#sheetBody').innerHTML = renderSubagentDetailShell(task);
        initial = false;
      }
      const statusNode = $('#agentDetailStatus');
      if (statusNode) { statusNode.dataset.s = task.status; statusNode.textContent = subagentStatus(task.status); }
      const childNode = $('#agentChildSession');
      if (childNode) childNode.textContent = childSessionId || 'not created';
      const durationNode = $('#agentDetailDuration');
      if (durationNode) durationNode.textContent = formatDuration(task.started, task.ended || Date.now());
      const runsNode = $('#agentDetailRuns'); if (runsNode) runsNode.textContent = String(task.runCount || 0);
      const bytesNode = $('#agentDetailBytes'); if (bytesNode) bytesNode.textContent = `${Number(task.outputBytes || 0).toLocaleString()} bytes`;
      const usageNode = $('#agentDetailUsage');
      if (usageNode) usageNode.textContent = task.usage ? `${Number(task.usage.totalTokens || 0).toLocaleString()} tokens · ${Number(task.usage.inputTokens || 0).toLocaleString()} in / ${Number(task.usage.outputTokens || 0).toLocaleString()} out${task.usage.estimated ? ' · estimated' : ''}` : 'Usage not reported';
      const activityNode = $('#agentDetailActivity');
      if (activityNode) activityNode.textContent = task.activity ? task.activity.label : 'Waiting for activity…';
      const controlsNode = $('#agentDetailControls');
      const activeControls = ['queued', 'running'].includes(task.status) ? 'true' : 'false';
      if (controlsNode && controlsNode.dataset.active !== activeControls) {
        controlsNode.dataset.active = activeControls;
        controlsNode.innerHTML = renderSubagentControls(task);
      }
      const transcript = $('#agentTranscript');
      if (transcript) { const scroll = transcript.scrollTop; transcript.innerHTML = renderChildTranscript(childMessages); transcript.scrollTop = scroll; }
      const timeline = $('#agentTimeline');
      if (timeline) { const scroll = timeline.scrollTop; timeline.innerHTML = renderTaskTimeline(events); timeline.scrollTop = scroll; }
      const outputNode = $('#agentOutput');
      if (outputNode) { const scroll = outputNode.scrollTop; outputNode.textContent = output || 'No task output yet.'; outputNode.scrollTop = scroll; }
    } catch (error) {
      if (current() && initial) $('#sheetBody').innerHTML = `<p class="sheet-note">${esc(error.message || 'Could not load subagent details')}</p>`;
    } finally {
      inFlight = false;
    }
  };
  const scheduleRefresh = () => {
    if (queuedRefreshTimer || !current()) return;
    queuedRefreshTimer = setTimeout(() => {
      queuedRefreshTimer = null;
      void refresh();
    }, 180);
  };
  await refresh();
  if (!current()) return;
  const streamAbort = new AbortController();
  state.subagentStreamAbort = streamAbort;
  void (async () => {
    try {
      for await (const frame of state.client.streamTaskEvents(taskId, lastEventSequence, { signal: streamAbort.signal })) {
        if (!current()) return;
        if (frame.event === 'event' && frame.data && typeof frame.data === 'object') {
          const event = frame.data;
          lastEventSequence = Math.max(lastEventSequence, Number(event.seq || 0));
          scheduleRefresh();
        }
      }
    } catch (error) {
      if (current() && error?.status !== 404) console.warn('Subagent event stream disconnected', error);
    }
  })();
  // SSE carries task changes promptly. This slower reconciliation refresh repairs
  // the detail if a proxy or mobile browser drops a stream frame during sleep.
  state.subagentPollTimer = setInterval(() => void refresh(), 7500);
}

async function openTasks() {
  openSheet('Tasks', '<p class="sheet-note">Loading runtime tasks…</p>');
  try {
    const result = await state.client.listTasks();
    state.tasks = result.tasks || [];
    $('#taskCount').textContent = String(state.tasks.filter((task) => ['queued', 'running'].includes(task.status)).length);
    const items = state.tasks.slice().sort((a, b) => Number(b.updated || b.started || 0) - Number(a.updated || a.started || 0));
    $('#sheetBody').innerHTML = items.length ? `<div class="sheet-list">${items.map((task) => `<div class="sheet-item"><strong>${esc(task.command || task.prompt || `${task.kind} task ${task.id}`)}</strong><small>${esc(task.status)} · ${esc(task.cwd || '')} · ${task.pid ? `pid ${task.pid}` : 'no process id'}</small>${task.error ? `<p>${esc(task.error)}</p>` : ''}<div class="item-actions"><button class="btn" data-action="task-output" data-task-id="${esc(task.id)}" type="button">Inspect output</button>${['queued', 'running'].includes(task.status) ? `<button class="btn btn-danger" data-action="task-cancel" data-task-id="${esc(task.id)}" type="button">Cancel</button>` : task.kind === 'agent' && task.sessionId ? `<button class="btn" data-action="task-resume-form" data-task-id="${esc(task.id)}" type="button">Resume</button>` : ''}</div></div>`).join('')}</div>` : '<p class="sheet-note">No tasks have been recorded by this runtime.</p>';
  } catch (error) { $('#sheetBody').innerHTML = `<p class="sheet-note">${esc(error.message || 'Could not load tasks')}</p>`; }
}
async function openCheckpoints() {
  openSheet('Checkpoints', '<p class="sheet-note">Loading checkpoints…</p>');
  try {
    const result = await state.client.listCheckpoints(state.activeId);
    state.checkpoints = result.checkpoints || [];
    $('#checkpointCount').textContent = String(state.checkpoints.length);
    $('#sheetBody').innerHTML = `<button class="btn btn-block" data-action="checkpoint" type="button">Create checkpoint</button>${state.checkpoints.length ? `<div class="sheet-list">${[...state.checkpoints].reverse().map((checkpoint) => `<div class="sheet-item"><strong>${esc(checkpoint.label || 'Checkpoint')}</strong><small>${esc(new Date(Number(checkpoint.ts || 0)).toLocaleString())} · ${Number(checkpoint.messageCount || 0)} messages</small><p>id ${esc(String(checkpoint.id || '').slice(0, 16))}</p><div class="item-actions"><button class="btn" data-action="checkpoint-restore" data-checkpoint-id="${esc(checkpoint.id)}" type="button">Restore</button><button class="btn" data-action="checkpoint-branch" data-checkpoint-id="${esc(checkpoint.id)}" type="button">Branch</button></div></div>`).join('')}</div>` : '<p class="sheet-note">No checkpoints yet. Create one before a risky change to make recovery explicit.</p>'}`;
  } catch (error) { $('#sheetBody').innerHTML = `<p class="sheet-note">${esc(error.message || 'Could not load checkpoints')}</p>`; }
}
function openContext({ showUsage = false } = {}) {
  const context = state.context || {};
  const tokens = Number(context.tokens || 0);
  const limit = Number(context.limit || 0);
  const usage = context.usage || {};
  const usageRoutes = Array.isArray(usage.routes) ? usage.routes : [];
  const count = (value) => Number(value || 0).toLocaleString();
  const usageMarkup = usage.requests
    ? `<div class="sheet-item"><strong>Provider usage history</strong><small>${count(usage.requests)} requests · ${count(usage.providerReportedRequests)} provider-reported · ${count(usage.estimatedRequests)} estimated</small><small>Input ${count(usage.inputTokens)} (${count(usage.nonCachedInputTokens)} uncached) · output ${count(usage.outputTokens)} · total ${count(usage.totalTokens)}</small><small>Cache read ${count(usage.cacheReadTokens)} · cache write ${count(usage.cacheWriteTokens)} · reasoning ${count(usage.reasoningTokens)} · tool-use input ${count(usage.toolUsePromptTokens)}</small>${usage.driftPercent === undefined ? '' : `<small>Estimator drift ${usage.driftPercent > 0 ? '+' : ''}${usage.driftPercent}% across ${count(usage.driftSamples)} measured requests</small>`}${usage.contextSamples ? `<small>Final request context average ${count(usage.averageContextTokens)} · peak ${count(usage.peakContextTokens)}</small>` : ''}${usageRoutes.length ? `<p>By provider / model</p>${usageRoutes.map((route) => `<small>${esc(route.provider)}/${esc(route.model)} · ${count(route.requests)} requests · ${count(route.totalTokens)} tokens</small>`).join('')}` : ''}</div>`
    : '<div class="sheet-item"><strong>Provider usage history</strong><small>No provider usage has been recorded for this session yet.</small></div>' ;
  openSheet(showUsage ? 'Provider usage' : 'Context and runtime', `
    <div class="sheet-item"><strong>Workspace</strong><small>${esc(state.meta?.cwd || state.info?.cwd || 'Not reported')}</small></div>
    <div class="sheet-item"><strong>Provider and model</strong><small>${esc(state.info?.provider || 'Unknown')} · ${esc(state.meta?.model || state.info?.model || 'Unknown')}</small></div>
    <div class="sheet-item"><strong>Context budget</strong><small>${limit ? `${tokens.toLocaleString()} estimated tokens used of ${limit.toLocaleString()} (${Math.round(tokens / limit * 100)}%)` : 'Not reported by this runtime'}</small></div>
    ${usageMarkup}
    <div class="sheet-item"><strong>Durable event cursor</strong><small>seq ${state.cursor} · reconnect replays events after this position</small></div>
    <form class="sheet-form" id="contextPathForm"><label for="contextPath">Focus the next prompt on a path</label><input class="sheet-input" id="contextPath" placeholder="src/server/http.ts"/><button class="btn btn-block" type="submit">Add path to composer</button></form>
    <p class="sheet-note">The runtime gathers workspace context automatically. This control inserts a path hint into the prompt; it does not upload a separate attachment.</p>`);
}
async function openRuntime() {
  const info = state.info || {};
  const auth = await state.client.getDevice().catch(() => null);
  const device = auth?.device;
  const deviceMarkup = device
    ? `<div class="sheet-item"><strong>Paired device</strong><small>${esc(device.name || 'TermAgent Web')} · expires ${esc(new Date(Number(device.expiresAt || 0)).toLocaleString())}</small><small>Device ID: ${esc(device.id || 'unknown')}</small><small>Scopes: ${esc((device.scopes || []).join(', '))}</small></div><button class="sheet-action danger" data-action="revoke-device" type="button">Revoke this device token ${icon('lock')}</button>`
    : `<div class="sheet-item"><strong>Authentication</strong><small>${esc(auth?.authType || 'Not reported')} · ${device ? 'paired' : 'no paired-device record'}</small></div>`;
  openSheet('Runtime', `<div class="sheet-item"><strong>Connection</strong><small>${esc(location.origin)} · ${state.wasConnected ? 'connected' : 'not connected'}</small></div><div class="sheet-item"><strong>Version</strong><small>${esc(info.version || 'Unknown')}</small></div><div class="sheet-item"><strong>Workspace</strong><small>${esc(info.cwd || 'Unknown')}</small></div><div class="sheet-item"><strong>Provider / model</strong><small>${esc(info.provider || 'Unknown')} · ${esc(info.model || 'Unknown')}</small></div>${deviceMarkup}<div class="sheet-item"><strong>Available protocol features</strong><p>${esc((info.features || []).join(', ') || 'Feature list unavailable')}</p></div><button class="sheet-action" data-action="reconnect" type="button">Reconnect runtime ${icon('replay')}</button><button class="sheet-action danger" data-action="disconnect" type="button">Clear in-memory token</button><p class="sheet-note">Device tokens are not written to browser storage. Revoking this device immediately blocks future requests and closes its live streams.</p>`);
}
function openHelp() {
  openSheet('Web View commands', `<div class="sheet-list">${SLASH_COMMANDS.map((item) => `<div class="sheet-item"><strong>${esc(item.command)}</strong><p>${esc(item.desc)}</p></div>`).join('')}</div><p class="sheet-note">Enter sends on desktop. On touch devices, Enter inserts a newline; use the send button or Ctrl/⌘ + Enter.</p>`);
}

$('#subagentsBtn').addEventListener('click', () => void openSubagents());
$('#tasksBtn').addEventListener('click', () => void openTasks());
$('#checkpointsBtn').addEventListener('click', () => void openCheckpoints());
$('#runtimeBtn').addEventListener('click', () => { void openRuntime(); });

document.addEventListener('click', async (event) => {
  const themeButton = event.target.closest('[data-theme-choice]');
  if (themeButton) {
    state.theme = themeButton.dataset.themeChoice;
    localStore.set('termagent:theme', state.theme);
    applyTheme();
    return;
  }
  const actionButton = event.target.closest('[data-action]');
  if (!actionButton) return;
  const action = actionButton.dataset.action;
  try {
    if (action === 'compact') { actionButton.disabled = true; await state.client.compact(state.activeId); closeSheet(); toast('Context compacted'); await refreshCurrent(); }
    else if (action === 'undo') { closeSheet(); if (!confirm('Undo the last turn and restore its workspace snapshot?')) return; await state.client.undo(state.activeId); toast('Last turn undone'); await refreshCurrent(); }
    else if (action === 'redo') { closeSheet(); await state.client.redo(state.activeId); toast('Last turn restored'); await refreshCurrent(); }
    else if (action === 'checkpoint') { await state.client.createCheckpoint(state.activeId, 'web-view'); toast('Checkpoint created'); await refreshCurrent(); await openCheckpoints(); }
    else if (action === 'tasks') await openTasks();
    else if (action === 'subagents') await openSubagents();
    else if (action === 'subagent-details') await openSubagentDetail(actionButton.dataset.taskId);
    else if (action === 'subagent-back') await openSubagents();
    else if (action === 'subagent-cancel') {
      if (!confirm('Cancel this subagent?')) return;
      const id = actionButton.dataset.taskId;
      await state.client.cancelTask(id);
      toast('Subagent cancellation requested');
      if (state.subagentView === 'detail') await openSubagentDetail(id); else await openSubagents();
      await refreshCurrent();
    }
    else if (action === 'checkpoints') await openCheckpoints();
    else if (action === 'context') openContext();
    else if (action === 'theme') openTheme();
    else if (action === 'focus') { closeSheet(); toggleFocus(); }
    else if (action === 'reconnect') { closeSheet(); await bootstrap(); }
    else if (action === 'revoke-device') {
      if (!confirm('Revoke this browser device token? This browser will immediately lose access.')) return;
      await state.client.revokeDevice();
      state.streamAbort?.abort(); state.token = ''; setClient(''); closeSheet();
      showConnectSheet('This browser device token was revoked. Pair again with a fresh one-time code.');
    }
    else if (action === 'disconnect') { state.streamAbort?.abort(); state.token = ''; setClient(''); closeSheet(); await bootstrap(); }
    else if (action === 'cancel-queue') {
      await state.client.cancelQueue(state.activeId, actionButton.dataset.queueId); toast('Queued prompt removed'); await refreshCurrent();
    } else if (action === 'task-output') {
      const id = actionButton.dataset.taskId; const task = await state.client.getTask(id); const output = await state.client.getTaskOutput(id, 50000, true);
      openSheet('Task output', `<div class="sheet-item"><strong>${esc(task.command || task.prompt || task.id)}</strong><small>${esc(task.status)} · ${esc(task.cwd || '')}</small></div><pre class="term">${esc(output)}</pre><div class="sheet-note">Task output is observational. Cancelling a task stops its managed process when supported by the runtime.</div>`);
    } else if (action === 'task-cancel') {
      if (!confirm('Cancel this task?')) return;
      await state.client.cancelTask(actionButton.dataset.taskId); toast('Task cancellation requested'); await openTasks(); await refreshCurrent();
    } else if (action === 'task-resume-form') {
      const id = actionButton.dataset.taskId;
      openSheet('Resume task', `<form class="sheet-form" id="resumeTaskForm" data-task-id="${esc(id)}"><label for="resumePrompt">Continuation prompt</label><textarea class="sheet-input" id="resumePrompt" rows="3" required placeholder="Inspect current state first, then continue from the last verified point."></textarea><button class="btn btn-block" type="submit">Resume task</button><p class="sheet-note">The continuation is sent to the existing task; it does not replay the original prompt automatically.</p></form>`);
    } else if (action === 'checkpoint-restore') {
      if (!confirm('Restore this checkpoint? This changes the workspace.')) return;
      await state.client.restoreCheckpoint(state.activeId, actionButton.dataset.checkpointId); closeSheet(); toast('Checkpoint restored'); await refreshCurrent();
    } else if (action === 'checkpoint-branch') {
      const result = await state.client.branchCheckpoint(state.activeId, actionButton.dataset.checkpointId, false);
      const meta = result?.meta || result?.result || result;
      if (meta?.id) { state.sessions = [meta, ...state.sessions]; await selectSession(meta.id, { persist: true }); }
      toast('Checkpoint branch created'); await refreshCurrent();
    } else if (action === 'jump-interaction') {
      const id = actionButton.dataset.requestId; closeSheet();
      const node = $(`[data-interaction="${CSS.escape(id)}"]`, feedInner);
      node?.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'center' });
      node?.focus?.({ preventScroll: true });
    }
  } catch (error) { toast(error.message || 'Action failed'); }
});

$('#sheetBody').addEventListener('submit', async (event) => {
  const form = event.target;
  if (form.id === 'connectForm') {
    event.preventDefault();
    const credential = $('#tokenField').value.trim();
    const submit = $('button[type="submit"]', form);
    submit.disabled = true;
    try {
      let token = credential;
      const pairingClient = new TermAgentClient({ baseUrl: location.origin });
      try {
        const paired = await pairingClient.pair(credential, `TermAgent Web (${navigator.platform || 'browser'})`);
        token = paired.token;
      } catch (pairError) {
        // Preserve compatibility with older local shared-token servers whose
        // API does not expose the one-time pairing endpoint.
        if (!(pairError instanceof TermAgentError) || !(pairError.status === 404 || (pairError.status === 401 && pairError.message === 'Unauthorized'))) throw pairError;
      }
      setClient(token);
      state.info = await state.client.info();
      closeSheet();
      await bootstrap();
    } catch (error) {
      $('#connectError').textContent = error.message || 'Connection failed';
      submit.disabled = false;
    }
  } else if (form.id === 'contextPathForm') {
    event.preventDefault();
    const path = $('#contextPath').value.trim();
    if (!path) return;
    const prior = input.value.trim();
    input.value = `${prior ? prior + '\n\n' : ''}Please focus on the path "${path}".`;
    sendButton.disabled = !input.value.trim();
    resizeInput(); closeSheet(); input.focus({ preventScroll: true }); toast('Path hint added to the composer');
  } else if (form.id === 'subagentSendForm' || form.id === 'subagentResumeForm') {
    event.preventDefault();
    const id = form.dataset.taskId;
    const field = form.id === 'subagentSendForm' ? $('#subagentInstruction') : $('#subagentResumePrompt');
    const prompt = field.value.trim();
    if (!prompt) return;
    const submit = $('button[type="submit"]', form); submit.disabled = true;
    try {
      if (form.id === 'subagentSendForm') await state.client.sendTask(id, prompt);
      else await state.client.resumeTask(id, prompt);
      toast(form.id === 'subagentSendForm' ? 'Instruction sent to the child agent' : 'Subagent continuation queued');
      await openSubagentDetail(id);
    } catch (error) { toast(error.message || 'Could not send instruction'); submit.disabled = false; }
  } else if (form.id === 'resumeTaskForm') {
    event.preventDefault();
    const id = form.dataset.taskId;
    const prompt = $('#resumePrompt').value.trim();
    if (!prompt) return;
    const submit = $('button[type="submit"]', form); submit.disabled = true;
    try { await state.client.resumeTask(id, prompt); closeSheet(); toast('Task continuation queued'); await openTasks(); }
    catch (error) { toast(error.message || 'Could not resume task'); submit.disabled = false; }
  }
});

$('#sheetBody').addEventListener('click', (event) => {
  // The context/task forms live in an ephemeral sheet; action handling above is
  // delegated once on document so repeated openings do not accumulate listeners.
});

function openContextFromQueue() { return openContext(); }

// Clipboard, keyboard and connection affordances.
document.addEventListener('keydown', (event) => {
  if (sheet.classList.contains('is-open') && event.key === 'Tab') {
    const focusable = [...sheet.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter((node) => node.getClientRects().length && node.getAttribute('aria-hidden') !== 'true');
    if (!focusable.length) { event.preventDefault(); sheet.focus(); return; }
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    return;
  }
  if (event.key === 'Escape') {
    closeSheet(); setDrawer(false); hideSlash();
    return;
  }
  if ((event.altKey && event.shiftKey && event.key.toLowerCase() === 's')) {
    event.preventDefault(); setDrawer(!side.classList.contains('is-open'));
  }
});

const heartbeatTicker = () => {
  if (!state.activeId) return;
  renderRunbar();
  const staleFor = Date.now() - state.lastHeartbeat;
  if (!state.wasConnected || !state.lastHeartbeat || staleFor < 40_000 || state.streamProbeBusy || Date.now() - state.streamProbeAt < 30_000) return;
  const sessionId = state.activeId;
  state.streamProbeBusy = true;
  state.streamProbeAt = Date.now();
  $('#runtimeStatus').textContent = 'Checking server health…';
  void (async () => {
    try {
      // A quiet stream is not proof of a dead server. Confirm server health,
      // then deliberately replace the stale SSE reader from the last durable
      // cursor so a half-open mobile connection cannot remain stuck forever.
      await Promise.race([
        state.client.health(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Runtime health probe timed out')), 5_000)),
      ]);
      if (sessionId !== state.activeId) return;
      state.lastHeartbeat = Date.now();
      state.streamAbort?.abort();
      startEventStream(sessionId);
    } catch {
      if (sessionId !== state.activeId) return;
      state.connectionLost = true;
      state.streamState = 'reconnecting';
      $('#runtimeStatus').textContent = 'Live updates reconnecting…';
      $('#runtimeDot').dataset.s = 'warn';
      setBanner(`Server health check failed. Reconnecting live updates from seq ${state.cursor}; durable history remains available.`, 'warn');
      state.streamAbort?.abort();
      startEventStream(sessionId);
    } finally {
      state.streamProbeBusy = false;
    }
  })();
};
state.tickTimer = setInterval(heartbeatTicker, 1000);
$('#kvSeq').textContent = 'seq 0';

// Do not persist the bearer token. Theme, selected session and local layout are
// presentation preferences only; runtime state is always reconstructed by API.
void bootstrap();
