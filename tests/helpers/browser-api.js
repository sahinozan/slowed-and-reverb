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
}

function createBrowserApi(options = {}) {
  const events = {
    command: createEvent(),
    runtimeMessage: createEvent(),
    tabActivated: createEvent(),
    tabRemoved: createEvent(),
    tabUpdated: createEvent()
  };
  const local = new StorageArea(options.local);
  const session = new StorageArea(options.session);
  const calls = {
    executeScript: [],
    icons: [],
    runtimeMessages: [],
    tabMessages: []
  };

  const api = {
    action: {
      async setIcon(details) {
        calls.icons.push(clone(details));
      }
    },
    commands: { onCommand: events.command },
    runtime: {
      onMessage: events.runtimeMessage,
      async sendMessage(message) {
        calls.runtimeMessages.push(clone(message));
        return options.onRuntimeMessage?.(message) ?? null;
      }
    },
    scripting: {
      async executeScript(details) {
        calls.executeScript.push(clone(details));
        if (options.executeScriptError) throw options.executeScriptError;
      }
    },
    storage: { local, session },
    tabs: {
      onActivated: events.tabActivated,
      onRemoved: events.tabRemoved,
      onUpdated: events.tabUpdated,
      async query() {
        return options.activeTab ? [clone(options.activeTab)] : [];
      },
      async sendMessage(tabId, message) {
        calls.tabMessages.push({ tabId, message: clone(message) });
        if (options.onTabMessage) return options.onTabMessage(tabId, message);
        return null;
      }
    }
  };

  return { api, calls, events, local, session };
}

async function dispatchRuntimeMessage(event, message, sender = {}) {
  let response;
  let responded = false;

  for (const listener of event.listeners) {
    const result = listener(message, sender, (value) => {
      response = value;
      responded = true;
    });

    if (result && typeof result.then === 'function') await result;
    if (result === true && !responded) {
      for (let attempt = 0; attempt < 10 && !responded; attempt++) await flushPromises();
    }
  }

  return response;
}

async function flushPromises() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

module.exports = { createBrowserApi, dispatchRuntimeMessage, flushPromises };
