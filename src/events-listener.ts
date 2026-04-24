import { Vault, TAbstractFile, TFolder } from "obsidian";
import MetadataStore from "./metadata-store";
import { GitHubSyncSettings } from "./settings/settings";
import Logger from "./logger";
import GitHubSyncPlugin from "./main";
import SyncPathFilter from "./sync-path-filter";

/**
 * Tracks changes to local sync directory and updates files metadata.
 */
export default class EventsListener {
  constructor(
    private vault: Vault,
    private metadataStore: MetadataStore,
    private settings: GitHubSyncSettings,
    private logger: Logger,
    private syncPathFilter: SyncPathFilter,
  ) {}

  start(plugin: GitHubSyncPlugin) {
    // We need to register all the events we subscribe to so they can
    // be correctly detached when the plugin is unloaded too.
    // If we don't they might be left hanging and cause issues.
    plugin.registerEvent(this.vault.on("create", this.onCreate.bind(this)));
    plugin.registerEvent(this.vault.on("delete", this.onDelete.bind(this)));
    plugin.registerEvent(this.vault.on("modify", this.onModify.bind(this)));
    plugin.registerEvent(this.vault.on("rename", this.onRename.bind(this)));
  }

  private async onCreate(file: TAbstractFile) {
    await this.refreshSyncPathFilterIfNeeded(file.path);
    await this.logger.info("Received create event", file.path);
    if (!this.isSyncable(file.path)) {
      // The file has not been created in directory that we're syncing with GitHub
      await this.removeFromMetadata(file.path);
      await this.logger.info("Skipped created file", file.path);
      return;
    }
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }

    const data = this.metadataStore.data.files[file.path];
    if (data && data.justDownloaded) {
      // This file was just downloaded and not created by the user.
      // It's enough to mark it as non just downloaded.
      this.metadataStore.data.files[file.path].justDownloaded = false;
      await this.metadataStore.save();
      await this.logger.info("Updated just downloaded created file", file.path);
      return;
    }

    this.metadataStore.data.files[file.path] = {
      path: file.path,
      sha: null,
      dirty: true,
      // This file has been created by the user
      justDownloaded: false,
      lastModified: Date.now(),
    };
    await this.metadataStore.save();
    await this.logger.info("Updated created file", file.path);
  }

  private async onDelete(file: TAbstractFile | string) {
    const filePath = file instanceof TAbstractFile ? file.path : file;
    await this.refreshSyncPathFilterIfNeeded(filePath);
    await this.logger.info("Received delete event", filePath);
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }
    if (!this.isSyncable(filePath)) {
      // The file was not in directory that we're syncing with GitHub
      await this.removeFromMetadata(filePath);
      return;
    }

    const data = this.metadataStore.data.files[filePath];
    if (!data) {
      return;
    }

    data.deleted = true;
    data.deletedAt = Date.now();
    await this.metadataStore.save();
    await this.logger.info("Updated deleted file", filePath);
  }

  private async onModify(file: TAbstractFile) {
    await this.refreshSyncPathFilterIfNeeded(file.path);
    await this.logger.info("Received modify event", file.path);
    if (!this.isSyncable(file.path)) {
      // The file has not been create in directory that we're syncing with GitHub
      await this.removeFromMetadata(file.path);
      await this.logger.info("Skipped modified file", file.path);
      return;
    }
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }
    const data = this.metadataStore.data.files[file.path];
    if (data && data.justDownloaded) {
      // This file was just downloaded and not modified by the user.
      // It's enough to makr it as non just downloaded.
      this.metadataStore.data.files[file.path].justDownloaded = false;
      await this.metadataStore.save();
      await this.logger.info(
        "Updated just downloaded modified file",
        file.path,
      );
      return;
    }

    if (!data) {
      this.metadataStore.data.files[file.path] = {
        path: file.path,
        sha: null,
        dirty: true,
        justDownloaded: false,
        lastModified: Date.now(),
      };
    } else {
      data.lastModified = Date.now();
      data.dirty = true;
    }

    await this.metadataStore.save();
    await this.logger.info("Updated modified file", file.path);
  }

  private async onRename(file: TAbstractFile, oldPath: string) {
    await this.refreshSyncPathFilterIfNeeded(file.path, oldPath);
    await this.logger.info("Received rename event", file.path);
    if (file instanceof TFolder) {
      // Skip folders
      return;
    }
    if (!this.isSyncable(file.path) && !this.isSyncable(oldPath)) {
      // Both are not in directory that we're syncing with GitHub
      await Promise.all([
        this.removeFromMetadata(file.path),
        this.removeFromMetadata(oldPath),
      ]);
      return;
    }

    if (this.isSyncable(file.path) && this.isSyncable(oldPath)) {
      // Both files are in the synced directory
      // First create the new one
      await this.onCreate(file);
      // Then delete the old one
      await this.onDelete(oldPath);
      return;
    } else if (this.isSyncable(file.path)) {
      // Only the new file is in the local directory
      await this.onCreate(file);
      return;
    } else if (this.isSyncable(oldPath)) {
      // Only the old file was in the local directory
      await this.onDelete(oldPath);
      return;
    }
  }

  private isSyncable(filePath: string) {
    return this.syncPathFilter.shouldSyncPath(filePath);
  }

  private async refreshSyncPathFilterIfNeeded(...filePaths: string[]) {
    if (!filePaths.some((filePath) => this.syncPathFilter.isGitIgnorePath(filePath))) {
      return;
    }

    await this.syncPathFilter.refresh();
    await this.pruneIgnoredMetadata();
  }

  private async pruneIgnoredMetadata() {
    const { files, removedPaths } = this.syncPathFilter.pruneMetadata(
      this.metadataStore.data.files,
    );

    if (removedPaths.length === 0) {
      return;
    }

    this.metadataStore.data.files = files;
    await this.metadataStore.save();
    await this.logger.info("Pruned ignored files from metadata", removedPaths);
  }

  private async removeFromMetadata(filePath: string) {
    if (!this.metadataStore.data.files[filePath]) {
      return;
    }

    delete this.metadataStore.data.files[filePath];
    await this.metadataStore.save();
  }
}
