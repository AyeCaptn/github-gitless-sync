import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import type { GetTreeResponseItem, NewTreeRequestItem } from "./github/client";
import type { ConflictFile, ConflictResolution } from "./sync-manager";
import { DEFAULT_SETTINGS } from "./settings/settings";

const require = createRequire(import.meta.url);
(globalThis as { require?: NodeRequire }).require = require;
const proxyquire = require("proxyquire").noCallThru();

// Obsidian supplies this Array extension in the plugin runtime.
Object.defineProperty(Array.prototype, "contains", {
  value: Array.prototype.includes,
});

function blobSha(content: string) {
  return createHash("sha1")
    .update(`blob ${Buffer.byteLength(content)}\0${content}`)
    .digest("hex");
}

const manifestPath = ".obsidian/github-sync-metadata.json";

function metadataFor(contents: Record<string, string>) {
  return {
    lastSync: 1,
    files: Object.fromEntries(
      Object.entries(contents).map(([path, content]) => [
        path,
        {
          path,
          sha: blobSha(content),
          dirty: false,
          justDownloaded: false,
          lastModified: 1,
        },
      ]),
    ),
  };
}

function createSync({
  base = { "note.md": "base\n" },
  local = { "note.md": "local\n" },
  remote = { "note.md": "base\n" },
  onConflicts = async (conflicts: ConflictFile[]) =>
    conflicts.map((conflict) => ({
      filePath: conflict.filePath,
      content: conflict.localContent,
    })),
}: {
  base?: Record<string, string>;
  local?: Record<string, string>;
  remote?: Record<string, string>;
  onConflicts?: (conflicts: ConflictFile[]) => Promise<ConflictResolution[]>;
} = {}) {
  const notices: string[] = [];
  const errors: string[] = [];
  const localFiles = new Map(Object.entries({
    ...local,
    [manifestPath]: JSON.stringify(metadataFor(base)),
  }));
  const obsidian = {
    normalizePath: (path: string) => path,
    base64ToArrayBuffer: (content: string) => Buffer.from(content, "base64"),
    arrayBufferToBase64: (content: ArrayBuffer) =>
      Buffer.from(content).toString("base64"),
    Notice: class {
      constructor(message: string) {
        notices.push(message);
      }
      hide() {}
    },
  };
  const metadataModule = proxyquire("./metadata-store", { obsidian });
  const filterModule = proxyquire("./sync-path-filter", {
    obsidian,
    "./metadata-store": metadataModule,
    "./logger": { LOG_FILE_NAME: "github-sync.log" },
  });
  const clientModule = proxyquire("./github/client", { obsidian });
  const blobs = new Map<string, string>();
  let remoteFiles: Record<string, GetTreeResponseItem>;
  function setRemote(contents: Record<string, string>) {
    const withManifest = {
      ...contents,
      [manifestPath]: JSON.stringify(metadataFor(contents)),
    };
    remoteFiles = Object.fromEntries(
      Object.entries(withManifest).map(([path, content]) => {
        const sha = blobSha(content);
        blobs.set(sha, content);
        return [
          path,
          { path, sha, mode: "100644", type: "blob", size: content.length, url: "" },
        ];
      }),
    );
  }
  setRemote(remote);
  Object.values(base).forEach((content) => blobs.set(blobSha(content), content));
  let head = "head-1";
  let beforeHeadRead = () => {};
  let beforeUpdate = () => {};
  const snapshots: string[] = [];
  const commits: { parent: string; tree: NewTreeRequestItem[] }[] = [];
  let tree: NewTreeRequestItem[] = [];
  class TestClient {
    async getBranchHeadSha() {
      beforeHeadRead();
      return head;
    }
    async getRepoContent({ ref }: { ref: string }) {
      snapshots.push(ref);
      return { files: { ...remoteFiles }, sha: `tree-${head}` };
    }
    async getBlob({ sha }: { sha: string }) {
      return { content: Buffer.from(blobs.get(sha)!).toString("base64") };
    }
    async createTree({ tree: request }: {
      tree: { tree: NewTreeRequestItem[] };
    }) {
      tree = request.tree;
      return "new-tree";
    }
    async createCommit({ parent }: { parent: string }) {
      commits.push({ parent, tree });
      return "new-commit";
    }
    async updateBranchHead() {
      beforeUpdate();
    }
  }
  const SyncManager = proxyquire("./sync-manager", {
    obsidian,
    "./metadata-store": metadataModule,
    "./sync-path-filter": filterModule,
    "./github/client": { __esModule: true, ...clientModule, default: TestClient },
    "./events-listener": class {},
    "./git-cli-sync": class {
      static async isSupported() {
        return false;
      }
    },
    "./logger": { LOG_FILE_NAME: "github-sync.log" },
    "./utils": proxyquire("./utils", { obsidian }),
  }).default;
  const manager = new SyncManager({
    configDir: ".obsidian",
    getRoot: () => ({ path: "" }),
    adapter: {
      exists: async (path: string) =>
        localFiles.has(path) || path === "" || path === ".obsidian",
      read: async (path: string) => localFiles.get(path)!,
      readBinary: async (path: string) => Buffer.from(localFiles.get(path)!),
      write: async (path: string, content: string) => {
        localFiles.set(path, content);
      },
      writeBinary: async (path: string, content: ArrayBuffer) => {
        localFiles.set(path, Buffer.from(content).toString());
      },
      remove: async (path: string) => {
        localFiles.delete(path);
      },
      mkdir: async () => {},
      list: async () => ({ files: [...localFiles.keys()], folders: [] }),
    },
  }, DEFAULT_SETTINGS, onConflicts, {
    info: async () => {},
    warn: async () => {},
    error: async (message: string) => {
      errors.push(message);
    },
  });
  return {
    manager, notices, errors, snapshots, commits, localFiles,
    moveBranch(contents: Record<string, string> = remote) {
      head = "head-2";
      setRemote(contents);
    },
    onHeadRead(callback: () => void) {
      beforeHeadRead = callback;
    },
    onUpdate(callback: () => void) {
      beforeUpdate = callback;
    },
    branchChanged: () => new clientModule.RemoteBranchChangedError(),
  };
}

for (const raceAtRead of [2, 3]) {
  test(`reconciles a moved branch at head check ${raceAtRead}`, async () => {
    const sync = createSync({
      remote: { "note.md": "base\n", "remote.md": "original\n" },
    });
    let reads = 0;
    sync.onHeadRead(() => {
      if (++reads === raceAtRead) {
        sync.moveBranch({ "note.md": "base\n", "remote.md": "new\n" });
      }
    });
    await sync.manager.loadMetadata();

    await sync.manager.sync();

    assert.deepEqual({
      snapshots: sync.snapshots,
      remoteNote: sync.localFiles.get("remote.md"),
      errors: sync.errors,
    }, {
      snapshots: ["head-1", "head-2"],
      remoteNote: "new\n",
      errors: [],
    });
  });
}

test("rebuilds the commit against the latest head after a non-fast-forward rejection", async () => {
  const sync = createSync();
  let updates = 0;
  sync.onUpdate(() => {
    if (++updates === 1) {
      sync.moveBranch({ "note.md": "base\n", "remote.md": "new\n" });
      throw sync.branchChanged();
    }
  });
  await sync.manager.loadMetadata();

  await sync.manager.sync();

  assert.deepEqual({
    parents: sync.commits.map((commit) => commit.parent),
    remoteNote: sync.localFiles.get("remote.md"),
    errors: sync.errors,
  }, {
    parents: ["head-1", "head-2"],
    remoteNote: "new\n",
    errors: [],
  });
});

test("rechecks conflicts instead of replaying a stale upload", async () => {
  const conflicts: ConflictFile[][] = [];
  const sync = createSync({
    onConflicts: async (files) => {
      conflicts.push(files);
      return [{ filePath: "note.md", content: "resolved\n" }];
    },
  });
  let updates = 0;
  sync.onUpdate(() => {
    if (++updates === 1) {
      sync.moveBranch({ "note.md": "remote edit\n" });
      throw sync.branchChanged();
    }
  });
  await sync.manager.loadMetadata();

  await sync.manager.sync();

  assert.deepEqual(conflicts, [[{
    filePath: "note.md",
    localContent: "local\n",
    remoteContent: "remote edit\n",
  }]]);
});

test("stops after three branch races and keeps local uploads pending", async () => {
  const sync = createSync();
  sync.onUpdate(() => {
    throw sync.branchChanged();
  });
  await sync.manager.loadMetadata();

  await sync.manager.sync();

  assert.deepEqual({
    attempts: sync.commits.length,
    sha: sync.manager.getFileMetadata("note.md").sha,
    content: sync.localFiles.get("note.md"),
    errors: sync.errors,
  }, {
    attempts: 3,
    sha: blobSha("base\n"),
    content: "local\n",
    errors: ["Sync failed"],
  });
});

test("does not retry unrelated update failures", async () => {
  const sync = createSync();
  sync.onUpdate(() => {
    throw new Error("Protected branch update failed");
  });
  await sync.manager.loadMetadata();

  await sync.manager.sync();

  assert.deepEqual({ attempts: sync.commits.length, errors: sync.errors }, {
    attempts: 1,
    errors: ["Sync failed"],
  });
});

test("also retries branch races during first sync", async () => {
  const sync = createSync({
    base: {},
    local: { "local.md": "local\n" },
    remote: {},
  });
  let updates = 0;
  sync.onUpdate(() => {
    if (++updates === 1) {
      sync.moveBranch({ "remote.md": "remote\n" });
      throw sync.branchChanged();
    }
  });
  await sync.manager.loadMetadata();

  await sync.manager.firstSync();

  assert.deepEqual({
    parents: sync.commits.map((commit) => commit.parent),
    local: sync.localFiles.get("local.md"),
    remote: sync.localFiles.get("remote.md"),
    errors: sync.errors,
  }, {
    parents: ["head-1", "head-2"],
    local: "local\n",
    remote: "remote\n",
    errors: [],
  });
});

test("refreshes first-sync downloads without treating them as local edits", async () => {
  const conflicts: ConflictFile[][] = [];
  const sync = createSync({
    base: {},
    local: { "local.md": "local\n" },
    remote: { "remote.md": "original\n" },
    onConflicts: async (files) => {
      conflicts.push(files);
      return [];
    },
  });
  let updates = 0;
  sync.onUpdate(() => {
    if (++updates === 1) {
      sync.moveBranch({ "remote.md": "updated\n" });
      throw sync.branchChanged();
    }
  });
  await sync.manager.loadMetadata();

  await sync.manager.firstSync();

  assert.deepEqual({ content: sync.localFiles.get("remote.md"), conflicts }, {
    content: "updated\n",
    conflicts: [],
  });
});
