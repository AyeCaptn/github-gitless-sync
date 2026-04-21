import SyncManager from "./sync-manager";

type ExplorerSyncState =
  | "up-to-date"
  | "pending-upload"
  | "pending-deletion"
  | "untracked"
  | null;

const BADGE_CLASS = "github-sync-explorer-badge";
const STATE_ATTRIBUTE = "data-github-sync-state";
const SYNCED_STATE = "up-to-date";

export default class FileExplorerBadges {
  private observer: MutationObserver | null = null;
  private refreshTimeoutId: number | null = null;

  constructor(private syncManager: SyncManager) {}

  start() {
    this.stop();

    this.observer = new MutationObserver((mutations) => {
      if (mutations.every((mutation) => this.isBadgeMutation(mutation))) {
        return;
      }
      this.scheduleRefresh();
    });
    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    this.scheduleRefresh();
  }

  stop() {
    this.observer?.disconnect();
    this.observer = null;

    if (this.refreshTimeoutId !== null) {
      window.clearTimeout(this.refreshTimeoutId);
      this.refreshTimeoutId = null;
    }

    this.clearBadges();
  }

  refresh() {
    const fileTitles = document.querySelectorAll<HTMLElement>(
      ".nav-file-title[data-path]",
    );

    fileTitles.forEach((fileTitle) => {
      const filePath = fileTitle.getAttribute("data-path");
      if (!filePath) {
        return;
      }

      const state = this.syncManager.getExplorerFileSyncState(filePath);
      this.applyBadge(fileTitle, state, filePath);
    });
  }

  private scheduleRefresh() {
    if (this.refreshTimeoutId !== null) {
      window.clearTimeout(this.refreshTimeoutId);
    }
    this.refreshTimeoutId = window.setTimeout(() => {
      this.refreshTimeoutId = null;
      this.refresh();
    }, 100);
  }

  private applyBadge(
    fileTitle: HTMLElement,
    state: ExplorerSyncState,
    filePath: string,
  ) {
    const existingBadge = fileTitle.querySelector<HTMLElement>(`.${BADGE_CLASS}`);

    if (state === null || state === SYNCED_STATE) {
      existingBadge?.remove();
      fileTitle.removeAttribute(STATE_ATTRIBUTE);
      return;
    }

    const badge = existingBadge || this.createBadge(fileTitle);
    fileTitle.setAttribute(STATE_ATTRIBUTE, state);
    badge.setAttribute("aria-label", this.labelForState(state, filePath));
    badge.setAttribute("title", this.labelForState(state, filePath));
  }

  private labelForState(
    state: Exclude<ExplorerSyncState, null>,
    filePath: string,
  ) {
    switch (state) {
      case "up-to-date":
        return `${filePath}: synced`;
      case "pending-upload":
        return `${filePath}: local changes pending upload`;
      case "pending-deletion":
        return `${filePath}: pending deletion`;
      case "untracked":
        return `${filePath}: not tracked by sync`;
    }
  }

  private isBadgeMutation(mutation: MutationRecord) {
    if (!this.nodeIsInsideBadge(mutation.target)) {
      return false;
    }

    return (
      Array.from(mutation.addedNodes).every((node) => this.nodeIsInsideBadge(node)) &&
      Array.from(mutation.removedNodes).every((node) => this.nodeIsInsideBadge(node))
    );
  }

  private nodeIsInsideBadge(node: Node) {
    if (node instanceof Element) {
      return node.classList.contains(BADGE_CLASS) || !!node.closest(`.${BADGE_CLASS}`);
    }
    return !!node.parentElement?.closest(`.${BADGE_CLASS}`);
  }

  private createBadge(fileTitle: HTMLElement) {
    const badge = document.createElement("span");
    badge.className = BADGE_CLASS;
    fileTitle.appendChild(badge);
    return badge;
  }

  private clearBadges() {
    document.querySelectorAll<HTMLElement>(`.${BADGE_CLASS}`).forEach((badge) => {
      badge.remove();
    });
    document
      .querySelectorAll<HTMLElement>(`.nav-file-title[${STATE_ATTRIBUTE}]`)
      .forEach((fileTitle) => {
        fileTitle.removeAttribute(STATE_ATTRIBUTE);
      });
  }
}
