import { App, Modal } from "obsidian";
import type { SyncStatus } from "src/sync-manager";

export default class SyncStatusModal extends Modal {
  constructor(
    app: App,
    private status: SyncStatus,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.setTitle("GitHub sync status");

    if (
      this.status.uploads.length === 0 &&
      this.status.downloads.length === 0 &&
      this.status.deleteLocal.length === 0 &&
      this.status.deleteRemote.length === 0 &&
      this.status.conflicts.length === 0 &&
      !this.status.metadataNeedsUpdate
    ) {
      contentEl.createEl("p", {
        text: "Everything is up to date.",
      });
      return;
    }

    if (this.status.metadataNeedsUpdate) {
      const changes = this.status.remoteDriftFiles.length;
      contentEl.createEl("p", {
        text:
          changes > 0
            ? `Detected ${changes} remote change${changes === 1 ? "" : "s"} made outside the plugin. The next sync will reconcile the metadata.`
            : "The remote sync metadata is missing or outdated. The next sync will rebuild it.",
      });
    }

    this.renderSection(
      "Pending uploads",
      this.status.uploads,
      "Local files that will be uploaded to GitHub.",
    );
    this.renderSection(
      "Pending downloads",
      this.status.downloads,
      "Remote files that will be downloaded into this vault.",
    );
    this.renderSection(
      "Pending local deletions",
      this.status.deleteLocal,
      "Local files that will be deleted to match GitHub.",
    );
    this.renderSection(
      "Pending remote deletions",
      this.status.deleteRemote,
      "Remote files that will be deleted on GitHub.",
    );
    this.renderSection(
      "Conflicts",
      this.status.conflicts,
      "Files changed both locally and remotely and requiring conflict handling.",
    );
  }

  private renderSection(title: string, files: string[], description: string) {
    const { contentEl } = this;
    const section = contentEl.createDiv();
    section.createEl("h3", {
      text: `${title} (${files.length})`,
    });
    section.createEl("p", {
      text: description,
    });

    if (files.length === 0) {
      section.createEl("p", {
        text: "None.",
      });
      return;
    }

    const list = section.createEl("ul");
    files.forEach((filePath) => {
      list.createEl("li", {
        text: filePath,
      });
    });
  }
}
