import * as assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const require = createRequire(import.meta.url);
(globalThis as { require?: NodeRequire }).require = require;
const proxyquire = require("proxyquire").noCallThru();

class TestLogger {
  async info() {}
  async error() {}
}

const gitCliSyncModule = proxyquire("./git-cli-sync", {
  obsidian: {
    Vault: class {},
    normalizePath: (path: string) => path.replace(/\\/g, "/"),
  },
  "./logger": TestLogger,
  "./metadata-store": {
    MANIFEST_FILE_NAME: "github-sync-metadata.json",
  },
});
const GitCliSync = gitCliSyncModule.default;
const { getGitErrorMessage } = gitCliSyncModule;

function git(cwd: string, args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function configureAuthor(repo: string) {
  git(repo, ["config", "user.name", "Test User"]);
  git(repo, ["config", "user.email", "test@example.com"]);
}

function write(repo: string, path: string, content: string) {
  const target = join(repo, path);
  mkdirSync(join(target, ".."), { recursive: true });
  writeFileSync(target, content, "utf8");
}

test("reports Git output without exposing the authenticated command", () => {
  const token = "secret-token";
  const output = getGitErrorMessage(
    "",
    "CONFLICT (content): Merge conflict in metadata.json\n",
    1,
  );
  const fallback = getGitErrorMessage("", "", 1);

  assert.match(output, /CONFLICT \(content\)/);
  assert.doesNotMatch(output, new RegExp(token));
  assert.equal(fallback, "Git exited with code 1");
});

test("merges divergent branches when only sync metadata conflicts", async () => {
  const root = mkdtempSync(join(tmpdir(), "github-gitless-sync-"));
  const bareRepo = join(root, "remote.git");
  const seedRepo = join(root, "seed");
  const localRepo = join(root, "local");
  const remoteRepo = join(root, "remote-worktree");
  const manifestPath = ".obsidian/github-sync-metadata.json";

  try {
    mkdirSync(bareRepo);
    git(bareRepo, ["init", "--bare", "--initial-branch=master"]);

    mkdirSync(seedRepo);
    git(seedRepo, ["init", "--initial-branch=master"]);
    configureAuthor(seedRepo);
    write(seedRepo, manifestPath, "base metadata\n");
    write(seedRepo, "base.md", "base\n");
    git(seedRepo, ["add", "-A"]);
    git(seedRepo, ["commit", "-m", "base"]);
    git(seedRepo, ["remote", "add", "origin", bareRepo]);
    git(seedRepo, ["push", "-u", "origin", "master"]);

    git(root, ["clone", bareRepo, localRepo]);
    git(root, ["clone", bareRepo, remoteRepo]);
    configureAuthor(remoteRepo);
    write(remoteRepo, manifestPath, "remote metadata\n");
    write(remoteRepo, "remote.md", "remote\n");
    git(remoteRepo, ["add", "-A"]);
    git(remoteRepo, ["commit", "-m", "remote change"]);
    git(remoteRepo, ["push", "origin", "master"]);

    write(localRepo, manifestPath, "local metadata\n");
    write(localRepo, "local.md", "local\n");

    const vault = {
      configDir: ".obsidian",
      adapter: { getBasePath: () => localRepo },
      getRoot: () => ({ path: "" }),
    };
    const sync = new GitCliSync(
      vault,
      {
        githubOwner: "owner",
        githubRepo: "repo",
        githubBranch: "master",
        githubToken: "token",
      },
      new TestLogger(),
    );

    sync.repoDir = localRepo;
    sync.repoPathPrefix = "";
    sync.remoteName = "origin";
    sync.ensureRepoPromise = Promise.resolve();

    await sync.syncBranch("local change");

    assert.equal(git(localRepo, ["status", "--porcelain"]), "");
    assert.equal(readFileSync(join(localRepo, manifestPath), "utf8"), "remote metadata\n");
    assert.equal(readFileSync(join(localRepo, "local.md"), "utf8"), "local\n");
    assert.equal(readFileSync(join(localRepo, "remote.md"), "utf8"), "remote\n");
    assert.equal(
      git(localRepo, ["rev-list", "--parents", "-n", "1", "HEAD"]).split(" ")
        .length,
      3,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
