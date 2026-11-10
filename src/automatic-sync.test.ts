import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import test, { TestContext } from "node:test";
import * as sinon from "sinon";
import { DEFAULT_SETTINGS, GitHubSyncSettings, normalizeSyncInterval } from "./settings/settings";

const require = createRequire(import.meta.url);
const proxyquire = require("proxyquire").noCallThru();

async function setup(t: TestContext, settings: Partial<GitHubSyncSettings> = {}) {
  const clock = sinon.useFakeTimers({ now: 1_000_000, toFake: ["Date", "setInterval", "clearInterval"] });
  const storage = new Map<string, string>();
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    setInterval, clearInterval,
    localStorage: {
      getItem: (key: string) => storage.get(key),
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  } });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { visibilityState: "visible" } });
  const events = new Map<string, () => void>();
  const notices: string[] = [];
  const saved: GitHubSyncSettings[] = [];
  let ready: () => void = () => {};
  const manager = {
    loadMetadata: async () => {},
    startEventsListener: sinon.stub(),
    firstSync: sinon.stub().resolves(true),
    sync: sinon.stub().resolves(true),
    resetMetadata: async () => {},
  };
  class Plugin {
    app = {
      vault: { on: () => ({}), getName: () => "vault" },
      workspace: {
        onLayoutReady: (callback: () => void) => { ready = callback; },
        on: () => ({}),
      },
    };
    manifest = { id: "github-gitless-sync", minAppVersion: "1.7.7" };
    loadData = async () => ({
      ...DEFAULT_SETTINGS,
      githubToken: "local-token",
      githubOwner: "owner",
      githubRepo: "repo",
      showStatusBarItem: false,
      showSyncRibbonButton: false,
      showConflictsRibbonButton: false,
      showFileExplorerBadges: false,
      ...settings,
    });
    saveData = async (value: GitHubSyncSettings) => { saved.push({ ...value }); };
    registerView() {}
    addSettingTab() {}
    registerEvent() {}
    addCommand() {}
    registerDomEvent(_target: unknown, event: string, callback: () => void) {
      events.set(event, callback);
    }
  }
  const { default: Main } = proxyquire("./main", {
    obsidian: { Plugin, requireApiVersion: () => true, Notice: class {
      constructor(message: string) { notices.push(message); }
      hide() {}
    } },
    "./settings/tab": class {},
    "./sync-manager": class { constructor() { return manager; } },
    "./logger": class { init = async () => {}; },
    "./file-explorer-badges": class { stop() {} },
    "./views/sync-status-modal": class {},
    "./views/conflicts-resolution/view": { CONFLICTS_RESOLUTION_VIEW_TYPE: "conflicts" },
  });
  const plugin = new Main();
  t.after(async () => {
    await plugin.onunload();
    clock.restore();
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
  });
  await plugin.onload();
  return { plugin, clock, manager, events, notices, saved, ready };
}

test("waits for layout and runs first sync automatically with local-only token persistence", async (t) => {
  const s = await setup(t);
  await s.clock.tickAsync(120_000);
  const beforeReady = s.manager.firstSync.callCount;
  s.ready();
  await s.clock.tickAsync(0);
  assert.deepEqual({ beforeReady, calls: s.manager.firstSync.callCount,
    firstSync: s.plugin.settings.firstSync, persisted: s.saved.at(-1)?.githubToken,
    listenerStarted: s.manager.startEventsListener.calledOnce, notices: s.notices,
  }, { beforeReady: 0, calls: 1, firstSync: false, persisted: "", listenerStarted: true, notices: [] });
});

test("regular intervals use the normal sync lifecycle without success notices", async (t) => {
  const s = await setup(t);
  s.ready();
  await s.clock.tickAsync(120_000);
  assert.deepEqual(s.manager.sync.args, [[{ silent: true }], [{ silent: true }]]);
});

test("keeps first sync pending after failure and retries next interval", async (t) => {
  const s = await setup(t);
  s.manager.firstSync.onFirstCall().rejects(new Error("offline"));
  s.ready();
  await s.clock.tickAsync(0);
  const afterFailure = s.plugin.settings.firstSync;
  await s.clock.tickAsync(60_000);
  assert.deepEqual({ afterFailure, afterRetry: s.plugin.settings.firstSync,
    firstCalls: s.manager.firstSync.callCount, regularCalls: s.manager.sync.callCount,
  }, { afterFailure: true, afterRetry: false, firstCalls: 2, regularCalls: 0 });
});

test("serializes manual sync, interval, focus, and network events during first sync", async (t) => {
  const s = await setup(t);
  let complete!: (value: boolean) => void;
  s.manager.firstSync.returns(new Promise<boolean>((resolve) => { complete = resolve; }));
  s.ready();
  await s.clock.tickAsync(0);
  await s.plugin.sync();
  s.events.get("focus")!();
  s.events.get("online")!();
  await s.clock.tickAsync(120_000);
  complete(true);
  await s.clock.tickAsync(0);
  assert.deepEqual({ firstCalls: s.manager.firstSync.callCount, regularCalls: s.manager.sync.callCount,
    firstSync: s.plugin.settings.firstSync }, { firstCalls: 1, regularCalls: 0, firstSync: false });
});

test("catches up once after suspension when focus and visibility both fire", async (t) => {
  const s = await setup(t, { firstSync: false });
  s.ready();
  await s.clock.tickAsync(0);
  s.clock.setSystemTime(Date.now() + 300_000);
  s.events.get("focus")!();
  s.events.get("visibilitychange")!();
  await s.clock.tickAsync(0);
  assert.equal(s.manager.sync.callCount, 2);
});

test("manual mode remains stopped after interval edits and resume events", async (t) => {
  const s = await setup(t, { syncStrategy: "manual", syncOnStartup: false });
  s.ready();
  s.plugin.restartSyncInterval();
  s.events.get("focus")!();
  s.events.get("online")!();
  await s.clock.tickAsync(120_000);
  assert.equal(s.manager.firstSync.callCount, 0);
});

test("restarting timers replaces the previous interval and unload stops automatic sync", async (t) => {
  const s = await setup(t, { firstSync: false });
  s.ready();
  await s.clock.tickAsync(0);
  s.plugin.restartSyncInterval();
  s.plugin.startSyncInterval();
  await s.clock.tickAsync(60_000);
  await s.plugin.onunload();
  s.events.get("online")!();
  await s.clock.tickAsync(120_000);
  assert.equal(s.manager.sync.callCount, 2);
});

test("defers background conflicts without opening a view or blocking the next attempt", async (t) => {
  const s = await setup(t);
  const activate = sinon.stub(s.plugin, "activateView").resolves();
  s.manager.firstSync.callsFake(() => s.plugin.onConflicts([{ filePath: "note.md" }]));
  s.ready();
  await s.clock.tickAsync(60_000);
  assert.deepEqual({ viewOpened: activate.called, attempts: s.manager.firstSync.callCount,
    firstSync: s.plugin.settings.firstSync }, { viewOpened: false, attempts: 2, firstSync: true });
});

for (const value of [NaN, Infinity, -1, 0, 1441]) {
  test(`normalizes unsafe interval ${value}`, () => {
    assert.equal(normalizeSyncInterval(value), 1);
  });
}

test("startup can stay disabled while interval sync still initializes the vault", async (t) => {
  const s = await setup(t, { syncOnStartup: false });
  s.ready();
  s.events.get("focus")!();
  await s.clock.tickAsync(0);
  const onStartup = s.manager.firstSync.callCount;
  await s.clock.tickAsync(60_000);
  assert.deepEqual({ onStartup, afterInterval: s.manager.firstSync.callCount },
    { onStartup: 0, afterInterval: 1 });
});

test("manual mode syncs only once on startup when enabled", async (t) => {
  const s = await setup(t, { syncStrategy: "manual", syncOnStartup: true });
  s.ready();
  await s.clock.tickAsync(0);
  s.events.get("online")!();
  await s.clock.tickAsync(120_000);
  assert.deepEqual({ first: s.manager.firstSync.callCount, regular: s.manager.sync.callCount },
    { first: 1, regular: 0 });
});

test("an online event retries immediately before the next interval", async (t) => {
  const s = await setup(t);
  s.manager.firstSync.onFirstCall().rejects(new Error("offline"));
  s.ready();
  await s.clock.tickAsync(1000);
  s.events.get("online")!();
  await s.clock.tickAsync(0);
  assert.deepEqual({ calls: s.manager.firstSync.callCount, firstSync: s.plugin.settings.firstSync },
    { calls: 2, firstSync: false });
});

test("unloading before layout is ready prevents a late startup sync", async (t) => {
  const s = await setup(t);
  await s.plugin.onunload();
  s.ready();
  await s.clock.tickAsync(120_000);
  assert.equal(s.manager.firstSync.callCount, 0);
});
