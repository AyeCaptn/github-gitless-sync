import { EventRef, Plugin, WorkspaceLeaf, Notice } from "obsidian";
import { GitHubSyncSettings, DEFAULT_SETTINGS } from "./settings/settings";
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

  async onload() {
    await this.loadSettings();

    this.logger = new Logger(this.app.vault, this.settings.enableLogging);
    this.logger.init();

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

    if (this.settings.syncStrategy == "interval") {
      this.restartSyncInterval();
    }

    this.app.workspace.onLayoutReady(async () => {
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
    });

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
      callback: this.sync.bind(this),
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

  async sync() {
    if (
      this.settings.githubToken === "" ||
      this.settings.githubOwner === "" ||
      this.settings.githubRepo === "" ||
      this.settings.githubBranch === ""
    ) {
      new Notice("Sync plugin not configured");
      return;
    }
    if (this.settings.firstSync) {
      const notice = new Notice("Syncing...");
      try {
        await this.syncManager.firstSync();
        this.settings.firstSync = false;
        await this.saveSettings();
        // Shown only if sync doesn't fail
        new Notice("Sync successful", 5000);
      } catch (err) {
        // Show the error to the user, it's not automatically dismissed to make sure
        // the user sees it.
        new Notice(`Error syncing. ${err}`);
      }
      notice.hide();
    } else {
      await this.syncManager.sync();
    }
    this.updateStatusBarItem();
    this.refreshExplorerBadges();
  }

  async onunload() {
    this.stopSyncInterval();
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
      this.sync.bind(this),
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
    return await new Promise(async (resolve) => {
      this.conflictsResolver = resolve;
      await this.activateView();
      this.getConflictsView()?.setConflictFiles(conflicts);
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
      new SyncStatusModal(this.app, status).open();
    } catch (err) {
      new Notice(`Error loading sync status. ${err}`);
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

  // Proxy methods from sync manager to ease handling the interval
  // when settings are changed
  startSyncInterval() {
    const intervalID = this.syncManager.startSyncInterval(
      this.settings.syncInterval,
    );
    this.registerInterval(intervalID);
  }

  stopSyncInterval() {
    this.syncManager.stopSyncInterval();
  }

  restartSyncInterval() {
    this.syncManager.stopSyncInterval();
    this.syncManager.startSyncInterval(this.settings.syncInterval);
  }

  async reset() {
    this.settings = { ...DEFAULT_SETTINGS };
    window.localStorage.removeItem(this.getTokenStorageKey());
    await this.saveSettings();
    await this.syncManager.resetMetadata();
  }
}
