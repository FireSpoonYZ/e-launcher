import path from 'node:path';
import { openHost } from './host.js';
import { openHostSettings, normalizeHostSettings } from './host-settings.js';
import { applyCenterModels, parseExecutionOptions } from './runtime-models.js';
import { connectCenter } from './center-client.js';
import { openManagedInstaller } from './managed-install/index.js';
import { openControlServer } from './control-server.js';
import { openDeviceLink } from './device-link.js';
import { assertDeviceToken, parseRelayUrl } from './relay-protocol.js';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,512}$/;
function invalidArgument(message) { return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); }
function offlineError() { return Object.assign(new Error('center is disconnected'), { code: 'CENTER_OFFLINE' }); }

export async function openHostService(options) {
  for (const key of Object.keys(options ?? {})) {
    if (!new Set(['dataRoot', 'token', 'port', 'initialSettings', 'nativeBridge', 'center', 'npmPath']).has(key)) throw invalidArgument(`unknown option: ${key}`);
  }
  const { dataRoot, token, port, initialSettings, nativeBridge, center, npmPath } = options ?? {};
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw invalidArgument('dataRoot must be an absolute path');
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) throw invalidArgument('invalid control token');
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw invalidArgument('invalid port');
  if (nativeBridge !== undefined && typeof nativeBridge !== 'function') throw invalidArgument('nativeBridge must be a function');
  if (npmPath !== undefined && (typeof npmPath !== 'string' || !path.isAbsolute(npmPath))) throw invalidArgument('npmPath must be an absolute path');
  if (!center || typeof center.url !== 'string') throw invalidArgument('center is required');
  assertDeviceToken(center.deviceToken);
  if (center.deviceToken === token) throw invalidArgument('device token must differ from control token');
  if (initialSettings !== undefined) normalizeHostSettings(initialSettings);

  const probe = openHost({ dataRoot });
  const deviceId = probe.deviceId;
  probe.close();
  function readBots() {
    const host = openHost({ dataRoot });
    try { return host.listBots().map((bot) => ({ deviceId, botId: bot.botId, name: bot.role })); }
    finally { host.close(); }
  }

  let settingsStore, control, link, installer, client;
  let phase = 'starting';
  let closed = false;
  let state = { state: 'connecting', centerUrl: center.url, appliedRevision: null, error: null };
  let activeRevision, lastRevision, frozen, timer, deploymentTimer;
  let generation = 0;
  let pendingChange = false;
  let serial = Promise.resolve();
  const enqueue = (fn) => {
    const next = serial.then(fn);
    serial = next.catch(() => {});
    return next;
  };
  function disconnect() {
    generation++;
    const previous = client;
    client = null;
    if (previous) void previous.close();
    state = { ...state, state: 'disconnected', error: { code: 'CENTER_OFFLINE', message: 'center disconnected' } };
    if (control) void control.setCenterOnline(false).catch(() => {});
    if (!closed) scheduleReconnect();
  }
  function scheduleReconnect() {
    if (timer || closed) return;
    timer = setTimeout(() => { timer = null; void enqueue(reconnect).catch(() => { if (!closed) scheduleReconnect(); }); }, 2000);
    timer.unref?.();
  }
  async function connectLink(url) {
    let resolveReady, rejectReady;
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timeout = setTimeout(() => rejectReady(offlineError()), 15000);
    let next;
    try {
      next = await openDeviceLink({ dataRoot, url, token: center.deviceToken, ca: center.ca, control: { url: control.url, token }, onStatus: (status) => {
        if (status.phase === 'online') resolveReady();
        else if (status.phase === 'blocked') rejectReady(offlineError());
      } });
      if (next.getStatus().phase === 'online') resolveReady();
      await ready;
      return next;
    } catch (err) { if (next) await next.close(); throw err; }
    finally { clearTimeout(timeout); }
  }
  async function applyPlans(current) {
    let waiting = false;
    for (const plan of await current.getDeployments()) {
      if (current !== client) throw offlineError();
      const receipt = await installer.apply(plan);
      if (receipt.phase === 'waiting-idle') waiting = true;
      if (receipt.phase === 'failed') throw Object.assign(new Error('deployment failed'), { code: 'DEPLOYMENT_FAILED' });
    }
    clearTimeout(deploymentTimer);
    if (waiting) {
      deploymentTimer = setTimeout(() => {
        deploymentTimer = null;
        void enqueue(async () => {
          if (!client || closed) return;
          try { if (!await applyPlans(client)) await refresh(); }
          catch { disconnect(); }
        });
      }, 5000);
      deploymentTimer.unref?.();
    }
    return waiting;
  }
  async function apply(snapshot, current, gen, { plansApplied = false, resume = false } = {}) {
    if (snapshot.deviceId !== deviceId || snapshot.protocol !== 1) throw invalidArgument('invalid center snapshot');
    if (!plansApplied) await applyPlans(current);
    if (gen !== generation || current !== client) throw offlineError();
    if (snapshot.linkUrl !== linkUrl || link.getStatus().phase !== 'online') {
      parseRelayUrl(snapshot.linkUrl);
      await link.close();
      link = await connectLink(snapshot.linkUrl);
      linkUrl = snapshot.linkUrl;
    }
    await control.applyCenterSnapshot(snapshot);
    if (gen !== generation || current !== client) throw offlineError();
    await control.setCenterOnline(true);
    if (gen !== generation || current !== client) { await control.setCenterOnline(false); throw offlineError(); }
    if (resume) control.resume();
    await current.reportRuntime({ deviceId, revision: snapshot.revision, status: 'applied', error: null });
    if (gen !== generation || current !== client) { await control.setCenterOnline(false); throw offlineError(); }
    state = { state: 'ready', centerUrl: center.url, appliedRevision: snapshot.revision, error: null };
  }
  async function refresh(bootstrap = false) {
    const current = client;
    const gen = generation;
    if (!current) throw offlineError();
    state = { ...state, state: 'connecting' };
    await control.setCenterOnline(false);
    const snapshot = bootstrap ? (await current.bootstrap(readBots())).snapshot : await current.getSnapshot();
    try { await apply(snapshot, current, gen); }
    catch (err) {
      if (current === client) {
        await control.setCenterOnline(false);
        state = { ...state, state: 'disconnected', error: { code: 'CENTER_APPLY_FAILED', message: 'center configuration could not be applied' } };
        await current.reportRuntime({ deviceId, revision: snapshot.revision, status: 'failed', error: state.error }).catch(() => {});
      }
      throw err;
    }
  }
  function changed() {
    generation++;
    pendingChange = true;
    if (control) {
      state = { ...state, state: 'connecting' };
      void control.setCenterOnline(false).catch(() => {});
      void enqueue(async () => {
        if (!pendingChange || !client || closed) return;
        pendingChange = false;
        try { await refresh(); } catch { disconnect(); }
      });
    }
  }
  async function connect() {
    const gen = ++generation;
    const current = await connectCenter({ centerUrl: center.url, deviceId, deviceToken: center.deviceToken, ca: center.ca, onDisconnect: disconnect, onChange: changed });
    if (closed || gen !== generation) { await current.close(); throw offlineError(); }
    client = current;
    return current;
  }
  async function reconnect() {
    if (closed || client) return;
    state = { ...state, state: 'connecting', error: null };
    let current;
    try {
      current = await connect();
      const connectedGeneration = generation;
      const snapshot = (await current.bootstrap(readBots())).snapshot;
      await apply(snapshot, current, connectedGeneration);
      if (pendingChange) changed();
    } catch (err) {
      if (current) await current.close();
      disconnect();
      throw err;
    }
  }
  let linkUrl;
  try {
    settingsStore = openHostSettings({ dataRoot, deviceId, initialSettings });
    const settings = settingsStore.get();
    activeRevision = lastRevision = settings.revision;
    const current = await connect();
    const initialGeneration = generation;
    const snapshot = (await current.bootstrap(readBots())).snapshot;
    if (snapshot.deviceId !== deviceId || snapshot.protocol !== 1) throw invalidArgument('invalid center snapshot');
    parseRelayUrl(snapshot.linkUrl);
    installer = await openManagedInstaller({
      dataRoot, npmPath,
      fetchArtifact: (ref) => { if (!client) throw offlineError(); return client.fetchArtifact(ref); },
      report: (receipt) => { if (!client) throw offlineError(); return client.reportDeployment(receipt); },
      withActivation: async (id, publish) => {
        if (control) return control.withCapabilityActivation(id, publish);
        await publish();
        return true;
      },
    });
    await applyPlans(current);
    const { models } = applyCenterModels(snapshot);
    const execution = parseExecutionOptions(settings.settings.runtime);
    control = await openControlServer({
      dataRoot, token, port, models, ...execution, nativeBridge,
      settings: { store: settingsStore, activeRevision }, getServiceStatus: () => getStatus(),
      deferResume: true,
      centerRuntime: { snapshot, getClient: () => client ?? null, installer },
      onBotsChanged: () => {
        generation++;
        state = { ...state, state: 'connecting' };
        void control.setCenterOnline(false).catch(() => {});
        return enqueue(async () => { try { await refresh(true); } catch (err) { disconnect(); throw err; } });
      },
    });
    if (current !== client) throw offlineError();
    linkUrl = snapshot.linkUrl;
    link = await connectLink(linkUrl);
    await apply(snapshot, current, initialGeneration, { plansApplied: true, resume: true });
    phase = 'running';
    if (pendingChange) changed();
  } catch (err) {
    closed = true;
    clearTimeout(timer);
    clearTimeout(deploymentTimer);
    if (client) await client.close().catch(() => {});
    if (link) await link.close().catch(() => {});
    if (control) await control.close().catch(() => {});
    if (installer) await installer.close().catch(() => {});
    if (settingsStore) settingsStore.close();
    throw err;
  }
  function getStatus() {
    if (frozen) return structuredClone(frozen);
    const revision = settingsStore.get().revision;
    lastRevision = revision;
    return { deviceId, phase, control: { url: control.url, listening: true }, relay: link.getStatus(), activeSettingsRevision: activeRevision, settingsRevision: revision, restartRequired: revision !== activeRevision, center: { ...state } };
  }
  let closePromise;
  return {
    deviceId, url: control.url, getStatus,
    close() {
      return closePromise ??= (async () => {
        closed = true;
        phase = 'closing';
        clearTimeout(timer);
        clearTimeout(deploymentTimer);
        generation++;
        state = { ...state, state: 'disconnected' };
        const errors = [];
        try { await control.setCenterOnline(false); } catch (err) { errors.push(err); }
        try { if (client) await client.close(); } catch (err) { errors.push(err); }
        try { await serial; } catch (err) { errors.push(err); }
        try { await link.close(); } catch (err) { errors.push(err); }
        try { await control.close(); } catch (err) { errors.push(err); }
        try { await installer.close(); } catch (err) { errors.push(err); }
        try { settingsStore.close(); } catch (err) { errors.push(err); }
        frozen = { deviceId, phase: 'closed', control: { url: control.url, listening: false }, relay: link.getStatus(), activeSettingsRevision: activeRevision, settingsRevision: lastRevision, restartRequired: lastRevision !== activeRevision, center: { ...state } };
        if (errors.length) throw new AggregateError(errors, 'host service close failed');
      })();
    },
    previewLegacyImport: (input) => control.previewLegacyImport(input),
    getLegacyImportStatus: (input) => control.getLegacyImportStatus(input),
    importLegacySnapshot: (input) => control.importLegacySnapshot(input),
    readLegacyDraft: (input) => control.readLegacyDraft(input),
  };
}
