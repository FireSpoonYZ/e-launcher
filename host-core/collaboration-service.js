import os from 'node:os';
import { collectBotDirectory } from './bot-directory.js';
import { openRemoteControl } from './remote-control-client.js';

export function createCollaborationService({ host, relay, createLocalBot, scheduleLocalTask, displayName, platform = process.platform }) {
  const fallbackName = displayName?.trim() || (platform !== 'android' && os.hostname().trim()) || `${platform}-${host.deviceId.slice(0, 8)}`;
  let currentName = fallbackName;
  let client = null;
  let connecting = null;
  let connectAbort = null;
  let refreshAbort = null;
  let refresh = null;
  let refreshWait = null;
  let nameFreshUntil = 0;
  let closed = false;

  async function connection() {
    if (closed || !relay) {
      const err = new Error('relay is not connected');
      err.code = 'NOT_CONNECTED';
      err.outcome = 'not-sent';
      throw err;
    }
    if (client) return client;
    if (!connecting) {
      connectAbort = new AbortController();
      connecting = openRemoteControl({ deviceId: host.deviceId, ...relay, signal: connectAbort.signal }).then((opened) => {
        if (closed) {
          opened.close();
          const err = new Error('collaboration service is closed');
          err.code = 'NOT_CONNECTED';
          err.outcome = 'not-sent';
          throw err;
        }
        client = opened;
        return opened;
      }).finally(() => { connecting = null; connectAbort = null; });
    }
    return connecting;
  }

  async function useClient(operation) {
    const active = await connection();
    try {
      return await operation(active);
    } catch (err) {
      if (['NOT_CONNECTED', 'DISCONNECTED', 'BAD_FRAME', 'REVOKED', 'UNAUTHORIZED'].includes(err?.code)) {
        if (client === active) client = null;
        active.close();
      }
      throw err;
    }
  }

  function localDevice() {
    return { deviceId: host.deviceId, displayName: currentName, platform, online: true, controlProtocol: 2, scopeProtocol: 1 };
  }

  async function listBots() {
    if (!relay) {
      return collectBotDirectory({
        listDevices: async () => ({ items: [localDevice()], nextCursor: null }),
        listBots: async () => host.listBots(),
      });
    }
    try {
      const snapshot = await collectBotDirectory({
        listDevices: (options) => useClient((active) => active.listDevices(options)),
        listBots: (deviceId) => deviceId === host.deviceId
          ? host.listBots()
          : useClient((active) => active.call(deviceId, 'listBots', {})),
      });
      const self = snapshot.devices.find((device) => device.deviceId === host.deviceId);
      if (self?.displayName) {
        currentName = self.displayName;
        nameFreshUntil = Date.now() + 5000;
      }
      if (!self || !self.online) {
        const device = self ?? localDevice();
        if (!self) snapshot.devices.push(device);
        snapshot.bots.push(...host.listBots().map((bot) => ({
          ...bot, description: bot.description ?? '', deviceName: currentName, platform, online: device.online,
        })));
      }
      return snapshot;
    } catch (err) {
      const local = await collectBotDirectory({
        listDevices: async () => ({ items: [localDevice()], nextCursor: null }),
        listBots: async () => host.listBots(),
      });
      local.errors.push({ deviceId: host.deviceId, code: err?.code ?? 'INTERNAL', message: 'Relay directory unavailable' });
      return local;
    }
  }

  async function createBot({ deviceId, requestId, name, description, modelRef, cwd }) {
    const input = { requestId, role: name, ...(description !== undefined ? { description } : {}),
      ...(modelRef !== undefined ? { modelRef } : {}), ...(cwd !== undefined ? { cwd } : {}) };
    try {
      return deviceId === host.deviceId
        ? await createLocalBot(input)
        : await useClient((active) => active.call(deviceId, 'createBot', input));
    } catch (err) {
      err.requestId = requestId;
      throw err;
    }
  }

  async function scheduleTask({ deviceId, botId, input, signal }) {
    if (deviceId === host.deviceId) {
      if (typeof scheduleLocalTask === 'function') {
        return scheduleLocalTask(botId, input);
      }
      const err = new Error('local runtime is not available');
      err.code = 'NOT_CONNECTED';
      throw err;
    }
    return useClient((active) => active.call(deviceId, 'scheduleTask', { botId, input }, { signal }));
  }

  async function getCurrentDevice() {
    if (relay && !closed && Date.now() >= nameFreshUntil) {
      if (!refresh) {
        refreshAbort = new AbortController();
        const signal = refreshAbort.signal;
        refresh = (async () => {
          try {
            let cursor = null;
            do {
              const page = await useClient((active) => active.listDevices({ limit: 200, cursor, signal }));
              const self = page.items.find((device) => device.deviceId === host.deviceId);
              if (self) {
                if (!closed && !signal.aborted && self.displayName) currentName = self.displayName;
                if (!closed && !signal.aborted) nameFreshUntil = Date.now() + 5000;
                break;
              }
              cursor = page.nextCursor;
            } while (cursor !== null);
          } catch { /* Keep the last known name when the relay is unavailable. */ }
        })();
        refreshWait = new Promise((resolve) => {
          const timer = setTimeout(resolve, 1000);
          refresh.then(() => { clearTimeout(timer); resolve(); });
        });
        refresh.then(() => { refresh = null; refreshWait = null; refreshAbort = null; });
      }
      await refreshWait;
    }
    return { deviceId: host.deviceId, displayName: currentName, platform, arch: process.arch };
  }

  async function close() {
    closed = true;
    connectAbort?.abort();
    refreshAbort?.abort();
    if (client) {
      client.close();
      client = null;
    }
    if (connecting) {
      try { await connecting; } catch { /* Opening a client is cancelled by closure. */ }
    }
  }

  return { listBots, createBot, scheduleTask, getCurrentDevice, close };
}
