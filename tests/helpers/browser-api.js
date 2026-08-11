'use strict';

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function createEvent() {
  const listeners = [];

  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    },
    async emit(...args) {
      for (const listener of listeners) await listener(...args);
    }
  };
}

class StorageArea {
  constructor(initial = {}) {
    this.data = clone(initial);
    this.writes = [];
  }

  async get(query = null) {
    if (query === null) return clone(this.data);

    if (typeof query === 'string') {
      return query in this.data ? { [query]: clone(this.data[query]) } : {};
    }

    if (Array.isArray(query)) {
      return Object.fromEntries(
        query.filter((key) => key in this.data).map((key) => [key, clone(this.data[key])])
      );
    }

    const result = clone(query);
    for (const key of Object.keys(query)) {
      if (key in this.data) result[key] = clone(this.data[key]);
    }
    return result;
  }

  async set(values) {
    const snapshot = clone(values);
    this.writes.push(snapshot);
    Object.assign(this.data, snapshot);
  }

  async remove(keys) {
    for (const key of Array.isArray(keys) ? keys : [keys]) delete this.data[key];
  }
}

function createBrowserApi(options = {}) {
  const events = {
    command: createEvent(),
    installed: createEvent(),
    startup: createEvent(),
    permissionAdded: createEvent(),
    permissionRemoved: createEvent(),
    runtimeMessage: createEvent(),
    tabActivated: createEvent(),
    tabRemoved: createEvent(),
    tabUpdated: createEvent()
  };
  const local = new StorageArea(options.local);
  const session = new StorageArea(options.session);
  const calls = {
    order: [],
    executeScript: [],
    icons: [],
    permissionRequests: [],
    registeredContentScripts: [],
    reloadedTabs: [],
    runtimeMessages: [],
    tabMessages: []
  };
  const grantedOrigins = new Set(options.grantedOrigins ?? []);
  const registeredContentScripts = new Map();

  const api = {
    action: {
      async setIcon(details) {
        calls.icons.push(clone(details));
      }
    },
    commands: { onCommand: events.command },
    runtime: {
      onInstalled: events.installed,
      onMessage: events.runtimeMessage,
      onStartup: events.startup,
      async sendMessage(message) {
        calls.runtimeMessages.push(clone(message));
        if (options.onRuntimeMessage) return options.onRuntimeMessage(message);
        return dispatchRuntimeMessage(events.runtimeMessage, message, options.runtimeSender);
      }
    },
    scripting: {
      async executeScript(details) {
        calls.executeScript.push(clone(details));
        if (options.executeScriptError) throw options.executeScriptError;
      },
      async getRegisteredContentScripts(filter = {}) {
        const ids = filter.ids ? new Set(filter.ids) : null;
        return [...registeredContentScripts.values()]
          .filter(({ id }) => !ids || ids.has(id))
          .map(clone);
      },
      async registerContentScripts(scripts) {
        calls.registeredContentScripts.push(clone(scripts));
        for (const script of scripts) registeredContentScripts.set(script.id, clone(script));
      },
      async unregisterContentScripts({ ids }) {
        for (const id of ids) registeredContentScripts.delete(id);
      }
    },
    permissions: {
      onAdded: events.permissionAdded,
      onRemoved: events.permissionRemoved,
      async contains({ origins = [] }) {
        return origins.every((origin) => grantedOrigins.has(origin));
      },
      async request({ origins = [] }) {
        calls.order.push('permissions.request');
        calls.permissionRequests.push(clone(origins));
        if (options.permissionRequestResult === false) return false;
        for (const origin of origins) grantedOrigins.add(origin);
        await events.permissionAdded.emit({ origins: clone(origins) });
        return true;
      },
      async remove({ origins = [] }) {
        for (const origin of origins) grantedOrigins.delete(origin);
        await events.permissionRemoved.emit({ origins: clone(origins) });
        return true;
      }
    },
    storage: { local, session },
    tabs: {
      onActivated: events.tabActivated,
      onRemoved: events.tabRemoved,
      onUpdated: events.tabUpdated,
      async query() {
        calls.order.push('tabs.query');
        return options.activeTab ? [clone(options.activeTab)] : [];
      },
      async get(tabId) {
        if (options.activeTab?.id === tabId) return clone(options.activeTab);
        return { id: tabId };
      },
      async reload(tabId) {
        calls.reloadedTabs.push(tabId);
        if (options.completeReload !== false) {
          const tab = clone(options.activeTab ?? { id: tabId });
          await events.tabUpdated.emit(tabId, { status: 'loading' }, tab);
          await events.tabUpdated.emit(tabId, { status: 'complete' }, tab);
        }
      },
      async sendMessage(tabId, message) {
        calls.tabMessages.push({ tabId, message: clone(message) });
        if (options.onTabMessage) return options.onTabMessage(tabId, message);
        return null;
      }
    }
  };

  return { api, calls, events, grantedOrigins, local, registeredContentScripts, session };
}

async function dispatchRuntimeMessage(event, message, sender = {}) {
  let response;
  let responded = false;

  for (const listener of event.listeners) {
    let finishResponse;
    const responseReady = new Promise((resolve) => {
      finishResponse = resolve;
    });
    const result = listener(message, sender, (value) => {
      response = value;
      responded = true;
      finishResponse();
    });

    if (result && typeof result.then === 'function') await result;
    if (result === true && !responded) {
      let responseTimeout;
      await Promise.race([
        responseReady,
        new Promise((resolve) => {
          responseTimeout = setTimeout(resolve, 500);
        })
      ]);
      clearTimeout(responseTimeout);
    }
  }

  return response;
}

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

module.exports = { createBrowserApi, dispatchRuntimeMessage, flushPromises };
