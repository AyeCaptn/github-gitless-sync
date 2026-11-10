import {
  EventRef,
  Plugin,
  WorkspaceLeaf,
  Notice,
  apiVersion,
  requireApiVersion,
} from "obsidian";
import {
  GitHubSyncSettings,
  DEFAULT_SETTINGS,
  normalizeSyncInterval,
} from "./settings/settings";
import GitHubSyncSettingsTab from "./settings/tab";
import SyncManager, { ConflictFile, ConflictResolution } from "./sync-manager";
import SyncStatusModal from "./views/sync-status-modal";
import FileExplorerBadges from "./file-explorer-badges";
import Logger from "./logger";
import {
  ConflictsResolutionView,
  CONFLICTS_RESOLUTION_VIEW_TYPE,
} from "./views/conflicts-resolution/view";

export default class GitHubSyncPlugin extends Plugin {
  settings: GitHubSyncSettings;
  syncManager: SyncManager;
  logger: Logger;
  fileExplorerBadges: FileExplorerBadges;

  statusBarItem: HTMLElement | null = null;
  syncRibbonIcon: HTMLElement | null = null;
  conflictsRibbonIcon: HTMLElement | null = null;

  activeLeafChangeListener: EventRef | null = null;
  vaultCreateListener: EventRef | null = null;
  vaultModifyListener: EventRef | null = null;

  // Called in ConflictResolutionView when the user solves all the conflicts.
  // This is initialized every time we open the view to set new conflicts so
  // we can notify the SyncManager that everything has been resolved and the sync
  // process can continue on.
  conflictsResolver: ((resolutions: ConflictResolution[]) => void) | null =
    null;

  // We keep track of the sync conflicts in here too in case the
  // conflicts view must be rebuilt, or the user closes the view
  // and it gets destroyed.
  // By keeping them here we can recreate it easily.
  private conflicts: ConflictFile[] = [];
  private syncInProgress = false;
  private backgroundSync = false;
  private rejectConflicts: ((error: Error) => void) | null = null;
  private layoutReady = false;
  private unloaded = false;
  private syncIntervalId: number | null = null;
  private lastAutomaticSync = 0;

  async onUserEnable() {
    if (
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    ) {
      new Notice("Go to settings to configure syncing");
    }
  }

  getConflictsView(): ConflictsResolutionView | null {
    const leaves = this.app.workspace.getLeavesOfType(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
    );
    if (leaves.length === 0) {
      return null;
    }
    return leaves[0].view as ConflictsResolutionView;
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(CONFLICTS_RESOLUTION_VIEW_TYPE);
    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getLeaf(false)!;
      await leaf.setViewState({
        type: CONFLICTS_RESOLUTION_VIEW_TYPE,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
  }

  private normalizeVersion(version: string | null | undefined) {
    if (!version) {
      return null;
    }

    const match = version.match(/\d+(?:\.\d+)+/);
    return match?.[0] || null;
  }

  private compareVersions(left: string, right: string) {
    const leftParts = left.split(".").map((part) => parseInt(part, 10) || 0);
    const rightParts = right.split(".").map((part) => parseInt(part, 10) || 0);
    const length = Math.max(leftParts.length, rightParts.length);

    for (let i = 0; i < length; i++) {
      const leftPart = leftParts[i] || 0;
      const rightPart = rightParts[i] || 0;
      if (leftPart > rightPart) {
        return 1;
      }
      if (leftPart < rightPart) {
        return -1;
      }
    }

    return 0;
  }

  private getCurrentAppVersion() {
    const appVersion = this.normalizeVersion(
      (this.app as unknown as { version?: string; appVersion?: string }).version ||
        (this.app as unknown as { version?: string; appVersion?: string }).appVersion,
    );
    if (appVersion) {
      return appVersion;
    }

    return this.normalizeVersion(apiVersion);
  }

  private isAppVersionSupported() {
    const minimumVersion = this.normalizeVersion(this.manifest.minAppVersion);
    if (!minimumVersion) {
      return true;
    }

    try {
      if (requireApiVersion(minimumVersion)) {
        return true;
      }
    } catch {
      // Fall back to manual comparison below.
    }

    const currentVersion = this.getCurrentAppVersion();
    if (!currentVersion) {
      return false;
    }

    return this.compareVersions(currentVersion, minimumVersion) >= 0;
  }

  async onload() {
    await this.loadSettings();

    if (!this.isAppVersionSupported()) {
      new Notice(
        `GitHub Gitless Sync requires Obsidian ${this.manifest.minAppVersion} or newer. Please update this device before syncing.`,
        10000,
      );
    }

    this.logger = new Logger(this.app.vault, this.settings.enableLogging);
    await this.logger.init();

    this.registerView(
      CONFLICTS_RESOLUTION_VIEW_TYPE,
      (leaf) => new ConflictsResolutionView(leaf, this, this.conflicts),
    );

    this.addSettingTab(new GitHubSyncSettingsTab(this.app, this));

    this.syncManager = new SyncManager(
      this.app.vault,
      this.settings,
      this.onConflicts.bind(this),
      this.logger,
    );
    this.fileExplorerBadges = new FileExplorerBadges(this.syncManager);
    await this.syncManager.loadMetadata();

    this.app.workspace.onLayoutReady(async () => {
      if (this.unloaded) return;
      this.layoutReady = true;
      // Create the events handling only after tha layout is ready to avoid
      // getting spammed with create events.
      // See the official Obsidian docs:
      // https://docs.obsidian.md/Reference/TypeScript+API/Vault/on('create')
      this.syncManager.startEventsListener(this);

      // Load the ribbons after layout is ready so they're shown after the core
      // buttons
      if (this.settings.showStatusBarItem) {
        this.showStatusBarItem();
      }

      if (this.settings.showConflictsRibbonButton) {
        this.showConflictsRibbonIcon();
      }

      if (this.settings.showSyncRibbonButton) {
        this.showSyncRibbonIcon();
      }

      if (this.settings.showFileExplorerBadges) {
        this.showFileExplorerBadges();
      }

      this.lastAutomaticSync = Date.now();
      this.restartSyncInterval();
      if (this.settings.syncOnStartup) {
        void this.sync(true);
      }
    });

    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "visible") void this.runAutomaticSync();
    });
    this.registerDomEvent(window, "focus", () => void this.runAutomaticSync());
    this.registerDomEvent(window, "online", () => void this.runAutomaticSync(true));

    this.registerEvent(
      this.app.vault.on("delete", () => this.refreshExplorerBadges()),
    );
    this.registerEvent(
      this.app.vault.on("rename", () => this.refreshExplorerBadges()),
    );
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.refreshExplorerBadges()),
    );

    this.addCommand({
      id: "sync-files",
      name: "Sync with GitHub",
      repeatable: false,
      icon: "refresh-cw",
      callback: () => void this.sync(),
    });

    this.addCommand({
      id: "merge",
      name: "Open sync conflicts view",
      repeatable: false,
      icon: "refresh-cw",
      callback: this.openConflictsView.bind(this),
    });

    this.addCommand({
      id: "show-sync-status",
      name: "Show sync status",
      repeatable: false,
      icon: "list",
      callback: this.showSyncStatus.bind(this),
    });
  }

  async sync(background = false): Promise<boolean> {
    if (this.unloaded || this.syncInProgress) return false;
    if (!this.isAppVersionSupported()) {
      if (!background) {
        new Notice(
          `Please update Obsidian on this device to ${this.manifest.minAppVersion} or newer before syncing.`,
        );
      }
      return false;
    }
    if (
      !this.settings.githubToken ||
      !this.settings.githubOwner ||
      !this.settings.githubRepo ||
      !this.settings.githubBranch
    ) {
      if (!background) new Notice("Sync plugin not configured");
      return false;
    }

    this.syncInProgress = true;
    this.backgroundSync = background;
    const notice = !background && this.settings.firstSync
      ? new Notice("Syncing...")
      : null;
    try {
      if (this.settings.firstSync) {
        const completed = await this.syncManager.firstSync();
        if (!completed) return false;
        this.settings.firstSync = false;
        await this.saveSettings();
        if (!background) new Notice("Sync successful", 5000);
      } else {
        return await this.syncManager.sync({ silent: background });
      }
      return true;
    } catch (err) {
      new Notice(`Error syncing. ${err}`);
      return false;
    } finally {
      this.syncInProgress = false;
      this.backgroundSync = false;
      notice?.hide();
      void this.updateStatusBarItem();
      this.refreshExplorerBadges();
    }
  }

  private async runAutomaticSync(force = false) {
    if (!this.layoutReady || this.unloaded || this.syncInProgress) return;
    if (this.settings.syncStrategy !== "interval") return;
    const now = Date.now();
    if (!force && now - this.lastAutomaticSync < this.settings.syncInterval * 60_000) {
      return;
    }
    this.lastAutomaticSync = now;
    await this.sync(true);
  }

  async onunload() {
    this.unloaded = true;
    this.stopSyncInterval();
    // Release a manual conflict wait so it cannot block an unloaded plugin.
    this.rejectConflicts?.(
      new Error("Plugin unloaded while waiting for conflict resolution"),
    );
    this.rejectConflicts = null;
    this.conflictsResolver = null;
    this.hideFileExplorerBadges();
  }

  showStatusBarItem() {
    if (this.statusBarItem) {
      return;
    }
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.classList.add("mod-clickable");
    this.statusBarItem.setAttribute("aria-label", "Show GitHub sync status");
    this.statusBarItem.setAttribute("title", "Click to show GitHub sync status");
    this.statusBarItem.addEventListener("click", () => {
      void this.showSyncStatus();
    });

    if (!this.activeLeafChangeListener) {
      this.activeLeafChangeListener = this.app.workspace.on(
        "active-leaf-change",
        () => {
          this.updateStatusBarItem();
          this.refreshExplorerBadges();
        },
      );
    }
    if (!this.vaultCreateListener) {
      this.vaultCreateListener = this.app.vault.on("create", () => {
        this.updateStatusBarItem();
        this.refreshExplorerBadges();
      });
    }
    if (!this.vaultModifyListener) {
      this.vaultModifyListener = this.app.vault.on("modify", () => {
        this.updateStatusBarItem();
        this.refreshExplorerBadges();
      });
    }

    void this.updateStatusBarItem();
  }

  hideStatusBarItem() {
    this.statusBarItem?.remove();
    this.statusBarItem = null;
  }

  async updateStatusBarItem() {
    if (!this.statusBarItem) {
      return;
    }
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      this.statusBarItem.setText("GitHub: Ready");
      return;
    }

    const state = await this.syncManager.getLocalFileSyncState(activeFile.path);
    this.statusBarItem.setText(`GitHub: ${state}`);
    this.statusBarItem.setAttribute(
      "title",
      `${activeFile.path}\n${state}\nClick to show GitHub sync status`,
    );
  }

  showFileExplorerBadges() {
    this.fileExplorerBadges.start();
  }

  hideFileExplorerBadges() {
    this.fileExplorerBadges.stop();
  }

  refreshExplorerBadges() {
    if (!this.settings.showFileExplorerBadges) {
      return;
    }
    this.fileExplorerBadges.refresh();
  }

  showSyncRibbonIcon() {
    if (this.syncRibbonIcon) {
      return;
    }
    this.syncRibbonIcon = this.addRibbonIcon(
      "refresh-cw",
      "Sync with GitHub",
      () => void this.sync(),
    );
  }

  hideSyncRibbonIcon() {
    this.syncRibbonIcon?.remove();
    this.syncRibbonIcon = null;
  }

  showConflictsRibbonIcon() {
    if (this.conflictsRibbonIcon) {
      return;
    }
    this.conflictsRibbonIcon = this.addRibbonIcon(
      "merge",
      "Open sync conflicts view",
      this.openConflictsView.bind(this),
    );
  }

  hideConflictsRibbonIcon() {
    this.conflictsRibbonIcon?.remove();
    this.conflictsRibbonIcon = null;
  }

  async openConflictsView() {
    await this.activateView();
    this.getConflictsView()?.setConflictFiles(this.conflicts);
  }

  async onConflicts(conflicts: ConflictFile[]): Promise<ConflictResolution[]> {
    this.conflicts = conflicts;
    if (this.backgroundSync || this.unloaded) {
      throw new Error(
        "Conflicting edits need review. Run Sync with GitHub to resolve them; both versions have been kept.",
      );
    }
    return await new Promise((resolve, reject) => {
      this.rejectConflicts = reject;
      this.conflictsResolver = (resolutions) => {
        this.rejectConflicts = null;
        this.conflictsResolver = null;
        resolve(resolutions);
      };
      void this.activateView().then(() => {
        this.getConflictsView()?.setConflictFiles(conflicts);
      }).catch((error) => {
        this.conflictsResolver = null;
        this.rejectConflicts = null;
        reject(error);
      });
    });
  }

  async showSyncStatus() {
    if (
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    ) {
      new Notice("Sync plugin not configured");
      return;
    }

    const loadingNotice = new Notice("Loading sync status...");
    try {
      const status = await this.syncManager.getSyncStatus();
      new SyncStatusModal(this.app, status, this.logger).open();
    } catch (err) {
      new SyncStatusModal(this.app, null, this.logger, String(err)).open();
    } finally {
      loadingNotice.hide();
    }
  }

  private getTokenStorageKey() {
    return `${this.manifest.id}:${this.app.vault.getName()}:githubToken`;
  }

  async loadSettings() {
    const savedSettings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData(),
    ) as GitHubSyncSettings;
    savedSettings.syncInterval = normalizeSyncInterval(savedSettings.syncInterval);
    let token = window.localStorage.getItem(this.getTokenStorageKey()) || "";

    if (savedSettings.githubToken !== "") {
      token = savedSettings.githubToken;
      window.localStorage.setItem(this.getTokenStorageKey(), token);
      savedSettings.githubToken = "";
      await this.saveData(savedSettings);
    }

    this.settings = {
      ...savedSettings,
      githubToken: token,
    };
  }

  async saveSettings() {
    if (this.settings.githubToken === "") {
      window.localStorage.removeItem(this.getTokenStorageKey());
    } else {
      window.localStorage.setItem(
        this.getTokenStorageKey(),
        this.settings.githubToken,
      );
    }
    await this.saveData({
      ...this.settings,
      githubToken: "",
    });
  }

  startSyncInterval() {
    this.restartSyncInterval();
  }

  stopSyncInterval() {
    if (this.syncIntervalId !== null) {
      window.clearInterval(this.syncIntervalId);
      this.syncIntervalId = null;
    }
  }

  restartSyncInterval() {
    this.stopSyncInterval();
    if (!this.layoutReady || this.unloaded || this.settings.syncStrategy !== "interval") return;
    this.syncIntervalId = window.setInterval(
      () => void this.runAutomaticSync(),
      this.settings.syncInterval * 60_000,
    );
  }

  async reset() {
    Object.assign(this.settings, DEFAULT_SETTINGS);
    this.restartSyncInterval();
    window.localStorage.removeItem(this.getTokenStorageKey());
    await this.saveSettings();
    await this.syncManager.resetMetadata();
  }
}
