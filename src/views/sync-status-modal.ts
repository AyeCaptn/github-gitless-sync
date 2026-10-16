import { App, Modal, Notice } from "obsidian";
import type Logger from "src/logger";
import type { SyncStatus } from "src/sync-manager";
import { copyToClipboard } from "src/utils";

export default class SyncStatusModal extends Modal {
  constructor(
    app: App,
    private status: SyncStatus | null,
    private logger: Logger,
    private statusError?: string,
  ) {
    super(app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();

    this.setTitle("GitHub sync status");

    if (this.status) {
      this.renderStatus(this.status);
    } else {
      contentEl.createEl("p", {
        text: `Unable to load current sync status. ${this.statusError}`,
      });
    }

    await this.renderErrors();
  }

  private renderStatus(status: SyncStatus) {
    const { contentEl } = this;
    if (
      status.uploads.length === 0 &&
      status.downloads.length === 0 &&
      status.deleteLocal.length === 0 &&
      status.deleteRemote.length === 0 &&
      status.conflicts.length === 0 &&
      !status.metadataNeedsUpdate
    ) {
      contentEl.createEl("p", {
        text: "Everything is up to date.",
      });
      return;
    }

    if (status.metadataNeedsUpdate) {
      const changes = status.remoteDriftFiles.length;
      contentEl.createEl("p", {
        text:
          changes > 0
            ? `Detected ${changes} remote change${changes === 1 ? "" : "s"} made outside the plugin. The next sync will reconcile the metadata.`
            : "The remote sync metadata is missing or outdated. The next sync will rebuild it.",
      });
    }

    this.renderSection(
      "Pending uploads",
      status.uploads,
      "Local files that will be uploaded to GitHub.",
    );
    this.renderSection(
      "Pending downloads",
      status.downloads,
      "Remote files that will be downloaded into this vault.",
    );
    this.renderSection(
      "Pending local deletions",
      status.deleteLocal,
      "Local files that will be deleted to match GitHub.",
    );
    this.renderSection(
      "Pending remote deletions",
      status.deleteRemote,
      "Remote files that will be deleted on GitHub.",
    );
    this.renderSection(
      "Conflicts",
      status.conflicts,
      "Files changed both locally and remotely and requiring conflict handling.",
    );
  }

  private async renderErrors() {
    const section = this.contentEl.createDiv();
    section.createEl("h3", { text: "Recent errors (last 10)" });
    section.createEl("p", {
      text: "Newest first. Tap an error to copy its full details.",
    });

    let errors;
    try {
      errors = await this.logger.getRecentErrors();
    } catch (err) {
      section.createEl("p", { text: `Unable to read error history. ${err}` });
      return;
    }

    if (errors.length === 0) {
      section.createEl("p", { text: "No errors recorded." });
      return;
    }

    const list = section.createEl("ul", { cls: "github-sync-errors" });
    for (const error of errors) {
      const button = list.createEl("li").createEl("button", {
        cls: "github-sync-error",
        attr: { type: "button", "aria-label": `Copy error: ${error.message}` },
      });
      button.createEl("small", { text: error.timestamp });
      button.createEl("strong", { text: error.message });
      if (error.additional_data !== undefined) {
        button.createEl("span", {
          cls: "github-sync-error-details",
          text:
            typeof error.additional_data === "string"
              ? error.additional_data
              : JSON.stringify(error.additional_data, null, 2),
        });
      }
      button.addEventListener("click", async () => {
        try {
          await copyToClipboard(JSON.stringify(error, null, 2));
          new Notice("Error details copied to clipboard.");
        } catch {
          new Notice("Unable to copy error details to clipboard.");
        }
      });
    }
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
