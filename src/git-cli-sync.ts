import { Vault, normalizePath } from "obsidian";
import type {
  BlobFile,
  GetTreeResponseItem,
  RepoContent,
} from "./github/client";
import { GitHubSyncSettings } from "./settings/settings";
import Logger from "./logger";
import { MANIFEST_FILE_NAME } from "./metadata-store";

type NodeRequireFunction = (id: string) => any;

type NodeModules = {
  childProcess: typeof import("child_process");
  crypto: typeof import("crypto");
  fs: typeof import("fs/promises");
  os: typeof import("os");
  path: typeof import("path");
};

type GitCommandOptions = {
  cwd?: string;
  indexFile?: string;
};

function getNodeRequire(): NodeRequireFunction | null {
  try {
    return Function(
      "return typeof require !== 'undefined' ? require : null;",
    )() as NodeRequireFunction | null;
  } catch (_err) {
    return null;
  }
}

function getNodeModules(): NodeModules | null {
  try {
    const req = getNodeRequire();
    if (req === null) {
      return null;
    }

    return {
      childProcess: req("child_process"),
      crypto: req("crypto"),
      fs: req("fs/promises"),
      os: req("os"),
      path: req("path"),
    } as NodeModules;
  } catch (_err) {
    return null;
  }
}

export class GitCliError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
  }
}

export default class GitCliSync {
  private static availabilityPromise: Promise<boolean> | null = null;

  private readonly modules = getNodeModules();
  private readonly vaultPath: string;
  private repoDir: string;
  private repoPathPrefix: string = "";
  private remoteName: string | null = null;
  private ensureRepoPromise: Promise<void> | null = null;

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
    private logger: Logger,
  ) {
    if (this.modules === null) {
      throw new GitCliError("Node modules are not available");
    }

    this.vaultPath = GitCliSync.getVaultBasePath(this.vault);
    this.repoDir = this.vaultPath;
  }

  static async isSupported(): Promise<boolean> {
    if (this.availabilityPromise !== null) {
      return this.availabilityPromise;
    }

    this.availabilityPromise = (async () => {
      const modules = getNodeModules();
      if (modules === null) {
        return false;
      }

      try {
        await new Promise<void>((resolve, reject) => {
          modules.childProcess.execFile(
            "git",
            ["--version"],
            {
              encoding: "utf8",
              env: {
                ...process.env,
                GIT_TERMINAL_PROMPT: "0",
              },
              maxBuffer: 1024 * 1024,
            },
            (error) => {
              if (error) {
                reject(error);
                return;
              }
              resolve();
            },
          );
        });
        return true;
      } catch (_err) {
        return false;
      }
    })();

    return this.availabilityPromise;
  }

  static async isAvailableForVault(vault: Vault): Promise<boolean> {
    if (!(await this.isSupported())) {
      return false;
    }

    const modules = getNodeModules();
    if (modules === null) {
      return false;
    }

    const vaultPath = this.getVaultBasePath(vault);

    try {
      await new Promise<void>((resolve, reject) => {
        modules.childProcess.execFile(
          "git",
          ["rev-parse", "--show-toplevel"],
          {
            cwd: vaultPath,
            encoding: "utf8",
            env: {
              ...process.env,
              GIT_TERMINAL_PROMPT: "0",
            },
            maxBuffer: 1024 * 1024,
          },
          (error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          },
        );
      });

      return true;
    } catch (_err) {
      return false;
    }
  }

  async getRepoContent(): Promise<RepoContent> {
    await this.ensureRepo();
    const branchExists = await this.remoteBranchExists();
    if (!branchExists) {
      throw new GitCliError(
        `Remote branch ${this.settings.githubBranch} does not exist`,
        404,
      );
    }

    await this.fetchRemoteBranch();
    return await this.getRepoContentFromRef(this.remoteTrackingRef());
  }

  async getHeadRepoContent(): Promise<RepoContent> {
    await this.ensureRepo();
    const localHead = await this.getOptionalRefSha(
      `refs/heads/${this.settings.githubBranch}`,
    );

    if (localHead === null) {
      return {
        files: {},
        sha: "",
      };
    }

    return await this.getRepoContentFromRef("HEAD");
  }

  async getBlob({ sha }: { sha: string }): Promise<BlobFile> {
    await this.ensureRepo();
    const content = await this.runGitBuffer(["cat-file", "-p", sha]);

    return {
      sha,
      node_id: "",
      size: content.length,
      url: "",
      content: Buffer.from(content).toString("base64"),
      encoding: "base64",
    };
  }

  async syncBranch(message: string) {
    await this.ensureRepo();
    await this.ensureCheckedOutBranch({ allowUnbornBranch: true });

    const remoteExists = await this.remoteBranchExists();
    if (remoteExists) {
      await this.fetchRemoteBranch();
    }

    await this.commitWorkingTreeChanges(message);

    const localHead = await this.getOptionalRefSha(
      `refs/heads/${this.settings.githubBranch}`,
    );
    const remoteHead = remoteExists
      ? await this.getOptionalRefSha(this.remoteTrackingRef())
      : null;

    if (localHead === null && remoteHead === null) {
      return;
    }

    if (localHead === null && remoteHead !== null) {
      await this.runGit([
        "checkout",
        "-B",
        this.settings.githubBranch,
        this.remoteTrackingRef(),
      ]);
      await this.setBranchUpstream();
      return;
    }

    if (localHead !== null && remoteHead !== null && localHead !== remoteHead) {
      try {
        await this.runGit(["merge", "--ff-only", this.remoteTrackingRef()], false);
      } catch (_err) {
        try {
          await this.runGit(["merge", "--no-edit", this.remoteTrackingRef()], false);
        } catch (mergeErr) {
          const conflictedPaths = await this.getConflictedPaths();
          if (this.onlyManifestIsConflicted(conflictedPaths)) {
            await this.runGit([
              "checkout",
              "--theirs",
              "--",
              this.repoPath(`${this.vault.configDir}/${MANIFEST_FILE_NAME}`),
            ]);
            await this.runGit([
              "add",
              "--",
              this.repoPath(`${this.vault.configDir}/${MANIFEST_FILE_NAME}`),
            ]);
            await this.runGit([
              "-c",
              "user.name=GitHub Gitless Sync",
              "-c",
              "user.email=github-gitless-sync@users.noreply.github.com",
              "commit",
              "--no-edit",
            ]);
          } else {
            await this.runGit(["merge", "--abort"], false).catch(() => undefined);
            throw mergeErr;
          }
        }
      }
    }

    await this.setBranchUpstream();
  }

  async updateMetadataAndPush({
    metadataContent,
    message,
  }: {
    metadataContent: string;
    message: string;
  }) {
    await this.ensureRepo();
    await this.ensureCheckedOutBranch({ allowUnbornBranch: true });

    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const targetPath = this.resolveRepoFilePath(manifestPath);
    const { fs, path } = this.modules as NodeModules;
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, metadataContent, "utf8");

    await this.runGit(["add", "--", this.repoPath(manifestPath)]);

    const manifestStatus = (
      await this.runGitText(["status", "--porcelain", "--", this.repoPath(manifestPath)])
    ).trim();

    if (manifestStatus !== "") {
      await this.commit(message);
    }

    const localHead = await this.getOptionalRefSha(
      `refs/heads/${this.settings.githubBranch}`,
    );
    if (localHead === null) {
      return;
    }

    await this.pushBranch();
    await this.updateRemoteTrackingRef(localHead);
    await this.setBranchUpstream();
  }

  private static getVaultBasePath(vault: Vault) {
    const adapter = vault.adapter as {
      getBasePath?: () => string;
      basePath?: string;
    };

    return adapter.getBasePath?.() || adapter.basePath || vault.getRoot().path || "vault";
  }

  private configuredRepoSlug() {
    return `${this.settings.githubOwner}/${this.settings.githubRepo}`.toLowerCase();
  }

  private normalizeGitHubRepoSlug(url: string) {
    const match = url
      .trim()
      .match(/github\.com(?:[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);

    if (!match) {
      return null;
    }

    return `${match[1]}/${match[2]}`.toLowerCase();
  }

  private remoteUrl() {
    return `https://github.com/${encodeURIComponent(this.settings.githubOwner)}/${encodeURIComponent(this.settings.githubRepo)}.git`;
  }

  private authArgs() {
    const basicAuth = Buffer.from(
      `x-access-token:${this.settings.githubToken}`,
      "utf8",
    ).toString("base64");

    return [
      "-c",
      `http.https://github.com/.extraheader=AUTHORIZATION: basic ${basicAuth}`,
    ];
  }

  private remoteTrackingRef() {
    return `refs/remotes/${this.remoteName}/${this.settings.githubBranch}`;
  }

  private repoPath(filePath: string) {
    const normalizedPath = normalizePath(filePath);
    if (this.repoPathPrefix === "") {
      return normalizedPath;
    }
    return normalizePath(`${this.repoPathPrefix}/${normalizedPath}`);
  }

  private fromRepoPath(repoPath: string) {
    const normalizedRepoPath = normalizePath(repoPath);
    if (this.repoPathPrefix === "") {
      return normalizedRepoPath;
    }
    if (normalizedRepoPath === this.repoPathPrefix) {
      return "";
    }
    const prefix = `${this.repoPathPrefix}/`;
    if (!normalizedRepoPath.startsWith(prefix)) {
      return null;
    }
    return normalizePath(normalizedRepoPath.slice(prefix.length));
  }

  private resolveRepoFilePath(filePath: string) {
    const { path } = this.modules as NodeModules;
    return path.join(this.repoDir, ...this.repoPath(filePath).split("/"));
  }

  private async ensureRepo() {
    if (this.ensureRepoPromise !== null) {
      await this.ensureRepoPromise;
      return;
    }

    this.ensureRepoPromise = (async () => {
      const { path } = this.modules as NodeModules;
      const repoDir = (
        await this.runGitTextAt(this.vaultPath, ["rev-parse", "--show-toplevel"])
      ).trim();
      this.repoDir = repoDir;

      const relativePrefix = path.relative(repoDir, this.vaultPath);
      this.repoPathPrefix =
        relativePrefix === "" ? "" : normalizePath(relativePrefix.replace(/\\/g, "/"));

      const remoteNames = (await this.runGitText(["remote"]))
        .split("\n")
        .map((name) => name.trim())
        .filter((name) => name !== "");

      const configuredRepoSlug = this.configuredRepoSlug();

      for (const remoteName of remoteNames) {
        const remoteUrl = (
          await this.runGitText(["remote", "get-url", remoteName], false)
        ).trim();
        if (this.normalizeGitHubRepoSlug(remoteUrl) === configuredRepoSlug) {
          this.remoteName = remoteName;
          break;
        }
      }

      if (this.remoteName === null) {
        this.remoteName = "github-gitless-sync";
        const hasRemote = remoteNames.includes(this.remoteName);
        if (hasRemote) {
          await this.runGit([
            "remote",
            "set-url",
            this.remoteName,
            this.remoteUrl(),
          ]);
        } else {
          await this.runGit([
            "remote",
            "add",
            this.remoteName,
            this.remoteUrl(),
          ]);
        }
      }
    })();

    try {
      await this.ensureRepoPromise;
    } catch (err) {
      this.ensureRepoPromise = null;
      throw err;
    }
  }

  private async ensureCheckedOutBranch({
    allowUnbornBranch = false,
  }: {
    allowUnbornBranch?: boolean;
  } = {}) {
    const currentBranch = (await this.runGitText(["branch", "--show-current"])).trim();

    if (currentBranch === this.settings.githubBranch) {
      return;
    }

    if (allowUnbornBranch && currentBranch === "") {
      return;
    }

    throw new GitCliError(
      `Git-backed sync requires the checked out branch to be ${this.settings.githubBranch}`,
    );
  }

  private async remoteBranchExists() {
    const output = await this.runGitText([
      "ls-remote",
      "--heads",
      this.remoteName as string,
      this.settings.githubBranch,
    ]);
    return output.trim() !== "";
  }

  private async getRepoContentFromRef(ref: string): Promise<RepoContent> {
    const treeSha = await this.runGitText(["rev-parse", `${ref}^{tree}`]);

    const lsTreeArgs = ["ls-tree", "-r", "-z", "--full-tree", ref];
    if (this.repoPathPrefix !== "") {
      lsTreeArgs.push("--", this.repoPathPrefix);
    }

    const lsTree = await this.runGitText(lsTreeArgs);

    const files = lsTree
      .split("\0")
      .filter((entry) => entry.trim() !== "")
      .map((entry) => {
        const [header, repoPath] = entry.split("\t");
        const [mode, type, sha] = header.split(" ");
        const path = this.fromRepoPath(repoPath);
        if (path === null) {
          return null;
        }
        return {
          path,
          mode,
          type,
          sha,
          size: 0,
          url: "",
        } as GetTreeResponseItem;
      })
      .filter((entry): entry is GetTreeResponseItem => {
        return entry !== null && entry.type === "blob";
      })
      .reduce(
        (
          acc: { [key: string]: GetTreeResponseItem },
          entry: GetTreeResponseItem,
        ) => ({ ...acc, [entry.path]: entry }),
        {},
      );

    return {
      files,
      sha: treeSha.trim(),
    };
  }

  private async fetchRemoteBranch() {
    await this.runGit([
      "fetch",
      this.remoteName as string,
      `${this.settings.githubBranch}:${this.remoteTrackingRef()}`,
    ]);
  }

  private async getConflictedPaths() {
    return (await this.runGitText(["diff", "--name-only", "--diff-filter=U"]))
      .split("\n")
      .map((filePath) => normalizePath(filePath.trim()))
      .filter((filePath) => filePath !== "");
  }

  private onlyManifestIsConflicted(filePaths: string[]) {
    const manifestPath = this.repoPath(
      `${this.vault.configDir}/${MANIFEST_FILE_NAME}`,
    );
    return filePaths.length > 0 && filePaths.every((filePath) => filePath === manifestPath);
  }

  private async commitWorkingTreeChanges(message: string) {
    await this.runGit(["add", "-A"]);
    await this.restoreIgnoredTrackedPaths();
    await this.excludeManifestFromSyncCommit();

    const status = (await this.runGitText(["status", "--porcelain"])).trim();
    if (status === "") {
      return;
    }

    await this.commit(message);
  }

  private async getIgnoredTrackedPaths() {
    return (
      await this.runGitText(
        ["ls-files", "-c", "-i", "--exclude-standard", "-z"],
        false,
      ).catch(() => "")
    )
      .split("\0")
      .map((filePath) => normalizePath(filePath.trim()))
      .filter((filePath) => filePath !== "");
  }

  private async restoreIgnoredTrackedPaths() {
    const localHead = await this.getOptionalRefSha(
      `refs/heads/${this.settings.githubBranch}`,
    );

    if (localHead === null) {
      return;
    }

    const ignoredTrackedPaths = await this.getIgnoredTrackedPaths();
    if (ignoredTrackedPaths.length === 0) {
      return;
    }

    await this.logger.info(
      "Excluding ignored tracked paths from git sync",
      ignoredTrackedPaths,
    );

    for (const filePath of ignoredTrackedPaths) {
      await this.runGit(
        ["restore", "--staged", "--worktree", "--source=HEAD", "--", filePath],
        false,
      ).catch(() => undefined);
    }
  }

  private async excludeManifestFromSyncCommit() {
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;
    const repoManifestPath = this.repoPath(manifestPath);
    const localHead = await this.getOptionalRefSha(
      `refs/heads/${this.settings.githubBranch}`,
    );

    if (localHead === null) {
      await this.runGit(
        ["rm", "--cached", "-f", "--ignore-unmatch", "--", repoManifestPath],
        false,
      ).catch(() => undefined);
      return;
    }

    await this.runGit(
      [
        "restore",
        "--staged",
        "--worktree",
        "--source=HEAD",
        "--",
        repoManifestPath,
      ],
      false,
    ).catch(() => undefined);
  }

  private async getOptionalRefSha(ref: string) {
    const output = await this.runGitText(["rev-parse", "--verify", ref], false).catch(
      () => null,
    );
    return output ? output.trim() : null;
  }

  private async getTreeShaForRef(ref: string) {
    const output = await this.runGitText(["rev-parse", `${ref}^{tree}`]);
    return output.trim();
  }

  private async isAncestor(ancestor: string, descendant: string) {
    await this.runGit(["merge-base", "--is-ancestor", ancestor, descendant], false);
    return true;
  }

  private async determineCommitParents({
    localHead,
    remoteHead,
  }: {
    localHead: string | null;
    remoteHead: string | null;
  }) {
    if (localHead === null && remoteHead === null) {
      return [];
    }

    if (localHead === null) {
      return [remoteHead as string];
    }

    if (remoteHead === null) {
      return [localHead];
    }

    if (localHead === remoteHead) {
      return [localHead];
    }

    if (await this.isAncestor(localHead, remoteHead).catch(() => false)) {
      return [remoteHead];
    }

    if (await this.isAncestor(remoteHead, localHead).catch(() => false)) {
      return [localHead];
    }

    return [localHead, remoteHead];
  }

  private async buildTreeFromEntries(entries: {
    [key: string]: { mode: string; sha: string };
  }) {
    const { crypto, fs, os, path } = this.modules as NodeModules;
    const tempIndexPath = path.join(
      os.tmpdir(),
      "github-gitless-sync-index",
      crypto.randomUUID(),
    );

    await fs.mkdir(path.dirname(tempIndexPath), { recursive: true });
    await fs.writeFile(tempIndexPath, "", "utf8");

    try {
      await this.runGit(["read-tree", "--empty"], true, {
        indexFile: tempIndexPath,
      });

      const sortedPaths = Object.keys(entries).sort();
      for (const filePath of sortedPaths) {
        const entry = entries[filePath];
        await this.runGit(
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `${entry.mode},${entry.sha},${this.repoPath(filePath)}`,
          ],
          true,
          { indexFile: tempIndexPath },
        );
      }

      const treeSha = await this.runGitText(["write-tree"], true, {
        indexFile: tempIndexPath,
      });
      return treeSha.trim();
    } finally {
      await fs.rm(tempIndexPath, { force: true });
    }
  }

  private async hashVaultFile(filePath: string) {
    const absolutePath = this.resolveRepoFilePath(filePath);
    const sha = await this.runGitText(["hash-object", "-w", absolutePath]);
    return sha.trim();
  }

  private async hashTextContent(content: string, filePath: string) {
    const { crypto, fs, os, path } = this.modules as NodeModules;
    const tempPath = path.join(
      os.tmpdir(),
      "github-gitless-sync-blobs",
      crypto.randomUUID(),
    );

    await fs.mkdir(path.dirname(tempPath), { recursive: true });
    await fs.writeFile(tempPath, content, "utf8");

    try {
      const sha = await this.runGitText([
        "hash-object",
        "-w",
        "--path",
        this.repoPath(filePath),
        tempPath,
      ]);
      return sha.trim();
    } finally {
      await fs.rm(tempPath, { force: true });
    }
  }

  private async createCommit({
    treeSha,
    message,
    parents,
  }: {
    treeSha: string;
    message: string;
    parents: string[];
  }) {
    const args = ["commit-tree", treeSha, "-m", message];
    parents.forEach((parent) => {
      args.push("-p", parent);
    });
    const commitSha = await this.runGitText(args);
    return commitSha.trim();
  }

  private async moveCheckedOutBranchToCommit(commitSha: string) {
    await this.runGit(["reset", "--mixed", commitSha]);
  }

  private async commit(message: string) {
    await this.runGit([
      "-c",
      "user.name=GitHub Gitless Sync",
      "-c",
      "user.email=github-gitless-sync@users.noreply.github.com",
      "commit",
      "-m",
      message,
    ]);
  }

  private async pushBranch() {
    await this.runGit([
      "push",
      "-u",
      this.remoteName as string,
      `${this.settings.githubBranch}:refs/heads/${this.settings.githubBranch}`,
    ]);
  }

  private async updateRemoteTrackingRef(commitSha: string) {
    await this.runGit(["update-ref", this.remoteTrackingRef(), commitSha]);
  }

  private async setBranchUpstream() {
    await this.runGit(
      [
        "branch",
        "--set-upstream-to",
        `${this.remoteName}/${this.settings.githubBranch}`,
        this.settings.githubBranch,
      ],
      false,
    ).catch(() => undefined);
  }

  private async runGitText(
    args: string[],
    logErrors = true,
    options: GitCommandOptions = {},
  ) {
    const { stdout } = await this.execGit(args, "utf8", logErrors, options);
    return stdout.toString();
  }

  private async runGitTextAt(cwd: string, args: string[], logErrors = true) {
    const { stdout } = await this.execGit(args, "utf8", logErrors, { cwd });
    return stdout.toString();
  }

  private async runGitBuffer(
    args: string[],
    logErrors = true,
    options: GitCommandOptions = {},
  ) {
    const { stdout } = await this.execGit(args, "buffer", logErrors, options);
    return stdout;
  }

  private async runGit(
    args: string[],
    logErrors = true,
    options: GitCommandOptions = {},
  ) {
    await this.execGit(args, "utf8", logErrors, options);
  }

  private async execGit(
    args: string[],
    encoding: "utf8" | "buffer",
    logErrors = true,
    options: GitCommandOptions = {},
  ): Promise<{ stdout: Buffer | string; stderr: Buffer | string }> {
    const { childProcess } = this.modules as NodeModules;
    const cwd = options.cwd || this.repoDir;

    return await new Promise((resolve, reject) => {
      childProcess.execFile(
        "git",
        [...this.authArgs(), ...args],
        {
          cwd,
          encoding: encoding as any,
          env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
            ...(options.indexFile ? { GIT_INDEX_FILE: options.indexFile } : {}),
          },
          maxBuffer: 20 * 1024 * 1024,
        },
        async (error, stdout, stderr) => {
          if (error) {
            const stderrText = Buffer.isBuffer(stderr)
              ? stderr.toString("utf8")
              : stderr;
            if (logErrors) {
              await this.logger.error("Git command failed", {
                args,
                cwd,
                stderr: stderrText,
              });
            }
            reject(new GitCliError(stderrText || error.message));
            return;
          }
          resolve({ stdout, stderr });
        },
      );
    });
  }
}
