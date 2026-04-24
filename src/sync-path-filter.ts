import { normalizePath, Vault } from "obsidian";
import type { FileMetadata } from "./metadata-store";
import { MANIFEST_FILE_NAME } from "./metadata-store";
import { GitHubSyncSettings } from "./settings/settings";
import { LOG_FILE_NAME } from "./logger";

interface GitIgnoreRule {
  negated: boolean;
  regex: RegExp;
}

function escapeRegex(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function compileGitIgnorePattern(
  pattern: string,
  {
    anchored,
    directoryOnly,
  }: { anchored: boolean; directoryOnly: boolean },
) {
  let regexBody = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];

    if (character === "*") {
      if (pattern[index + 1] === "*") {
        while (pattern[index + 1] === "*") {
          index += 1;
        }
        regexBody += ".*";
      } else {
        regexBody += "[^/]*";
      }
      continue;
    }

    if (character === "?") {
      regexBody += "[^/]";
      continue;
    }

    regexBody += escapeRegex(character);
  }

  const hasSlash = pattern.includes("/");
  const prefix = anchored ? "^" : "(?:^|.*/)";
  const suffix = directoryOnly || !hasSlash ? "(?:/.*)?$" : "$";

  return new RegExp(`${prefix}${regexBody}${suffix}`);
}

export function parseGitIgnoreContent(content: string): GitIgnoreRule[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .reduce((rules: GitIgnoreRule[], line: string) => {
      if (line.startsWith("\\#") || line.startsWith("\\!")) {
        line = line.slice(1);
      } else if (line.startsWith("#")) {
        return rules;
      }

      let negated = false;
      if (line.startsWith("!")) {
        negated = true;
        line = line.slice(1);
      }

      if (line === "") {
        return rules;
      }

      const directoryOnly = line.endsWith("/");
      if (directoryOnly) {
        line = line.replace(/\/+$/, "");
      }

      const anchored = line.startsWith("/");
      if (anchored) {
        line = line.slice(1);
      }

      if (line === "") {
        return rules;
      }

      rules.push({
        negated,
        regex: compileGitIgnorePattern(line, {
          anchored,
          directoryOnly,
        }),
      });
      return rules;
    }, []);
}

export default class SyncPathFilter {
  private rules: GitIgnoreRule[] = [];
  private readonly gitIgnorePath = normalizePath(".gitignore");

  constructor(
    private vault: Vault,
    private settings: GitHubSyncSettings,
  ) {}

  static fromGitIgnoreContent(
    vault: Vault,
    settings: GitHubSyncSettings,
    content: string,
  ) {
    const filter = new SyncPathFilter(vault, settings);
    filter.setGitIgnoreContent(content);
    return filter;
  }

  async refresh() {
    const exists = await this.vault.adapter.exists(this.gitIgnorePath);
    const content = exists
      ? await this.vault.adapter.read(this.gitIgnorePath)
      : "";
    this.setGitIgnoreContent(content);
  }

  isGitIgnorePath(filePath: string) {
    return normalizePath(filePath) === this.gitIgnorePath;
  }

  shouldSyncPath(
    filePath: string,
    { includeManifest = true } = {},
  ): boolean {
    const normalizedPath = normalizePath(filePath);
    const manifestPath = `${this.vault.configDir}/${MANIFEST_FILE_NAME}`;

    if (normalizedPath === manifestPath) {
      return includeManifest;
    }

    if (
      normalizedPath === `${this.vault.configDir}/workspace.json` ||
      normalizedPath === `${this.vault.configDir}/workspace-mobile.json` ||
      normalizedPath === `${this.vault.configDir}/${LOG_FILE_NAME}`
    ) {
      return false;
    }

    if (
      !this.settings.syncConfigDir &&
      this.isInConfigDir(normalizedPath)
    ) {
      return false;
    }

    return !this.matchesGitIgnore(normalizedPath);
  }

  filterRecord<T>(
    items: { [key: string]: T },
    { includeManifest = true } = {},
  ) {
    return Object.keys(items)
      .filter((filePath: string) =>
        this.shouldSyncPath(filePath, { includeManifest }),
      )
      .reduce(
        (acc: { [key: string]: T }, filePath: string) => ({
          ...acc,
          [filePath]: items[filePath],
        }),
        {},
      );
  }

  pruneMetadata(
    files: { [key: string]: FileMetadata },
    { includeManifest = true } = {},
  ) {
    const removedPaths: string[] = [];
    const filteredFiles = Object.keys(files)
      .filter((filePath: string) => {
        const shouldKeep = this.shouldSyncPath(filePath, { includeManifest });
        if (!shouldKeep) {
          removedPaths.push(filePath);
        }
        return shouldKeep;
      })
      .reduce(
        (acc: { [key: string]: FileMetadata }, filePath: string) => ({
          ...acc,
          [filePath]: files[filePath],
        }),
        {},
      );

    return {
      files: filteredFiles,
      removedPaths,
    };
  }

  private setGitIgnoreContent(content: string) {
    this.rules = parseGitIgnoreContent(content);
  }

  private matchesGitIgnore(filePath: string) {
    let ignored = false;

    for (const rule of this.rules) {
      if (rule.regex.test(filePath)) {
        ignored = !rule.negated;
      }
    }

    return ignored;
  }

  private isInConfigDir(filePath: string) {
    return (
      filePath === this.vault.configDir ||
      filePath.startsWith(`${this.vault.configDir}/`)
    );
  }
}
