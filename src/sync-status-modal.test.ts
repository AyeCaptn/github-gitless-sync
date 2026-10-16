import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import * as sinon from "sinon";
import type { ErrorLogEntry } from "./logger";
import type { SyncStatus } from "./sync-manager";

const require = createRequire(import.meta.url);
const proxyquire = require("proxyquire").noCallThru();

class Element {
  children: Element[] = [];
  click?: () => Promise<void>;

  constructor(
    public tag = "div",
    public text = "",
  ) {}

  empty() {
    this.children = [];
  }

  createEl(tag: string, options: { text?: string } = {}) {
    const element = new Element(tag, options.text);
    this.children.push(element);
    return element;
  }

  createDiv() {
    return this.createEl("div");
  }

  addEventListener(_event: string, callback: () => Promise<void>) {
    this.click = callback;
  }

  descendants(): Element[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
}

const upToDate: SyncStatus = {
  uploads: [],
  downloads: [],
  deleteLocal: [],
  deleteRemote: [],
  conflicts: [],
  metadataNeedsUpdate: false,
  remoteDriftFiles: [],
};

const error: ErrorLogEntry = {
  timestamp: "2026-10-16T10:00:00Z",
  level: "ERROR",
  message: "Failed to update branch head sha",
  additional_data: {
    status: 422,
    message: "Update is not a fast forward",
    response: "Full response " + "details ".repeat(100),
  },
};

function setup(status: SyncStatus | null = upToDate, errors = [error]) {
  const notices: string[] = [];
  const copy = sinon.stub().resolves();
  const logger = { getRecentErrors: sinon.stub().resolves(errors) };
  const SyncStatusModal = proxyquire("./views/sync-status-modal", {
    obsidian: {
      Modal: class {
        contentEl = new Element();
        setTitle() {}
      },
      Notice: class {
        constructor(message: string) {
          notices.push(message);
        }
      },
    },
    "src/utils": { copyToClipboard: copy },
  }).default;
  const modal = new SyncStatusModal({}, status, logger, "Network unavailable");
  const content: Element = modal.contentEl;
  return { modal, content, copy, notices, logger };
}

test("shows saved errors even when everything is up to date", async () => {
  const { modal, content } = setup();

  await modal.onOpen();

  assert.deepEqual(
    content.descendants().filter((el) => el.tag === "strong").map((el) => el.text),
    [error.message],
  );
});

test("shows saved errors when loading sync status fails", async () => {
  const { modal, content } = setup(null);

  await modal.onOpen();

  assert.deepEqual(
    content.descendants().filter((el) => el.tag === "button").map((el) => el.children[1].text),
    [error.message],
  );
});

test("retains pending file sections alongside the error history", async () => {
  const { modal, content } = setup({ ...upToDate, uploads: ["note.md"] });

  await modal.onOpen();

  assert.deepEqual(
    content.descendants().filter((el) => el.tag === "h3").map((el) => el.text),
    [
      "Pending uploads (1)",
      "Pending downloads (0)",
      "Pending local deletions (0)",
      "Pending remote deletions (0)",
      "Conflicts (0)",
      "Recent errors (last 10)",
    ],
  );
});

test("clicking an error copies its full untruncated saved details", async () => {
  const { modal, content, copy } = setup();
  await modal.onOpen();
  const button = content.descendants().find((el) => el.tag === "button")!;

  await button.click!();

  assert.deepEqual(copy.firstCall.args, [JSON.stringify(error, null, 2)]);
});

test("confirms that error details were copied", async () => {
  const { modal, content, notices } = setup();
  await modal.onOpen();

  await content.descendants().find((el) => el.tag === "button")!.click!();

  assert.deepEqual(notices, ["Error details copied to clipboard."]);
});

test("reports a clipboard failure", async () => {
  const { modal, content, copy, notices } = setup();
  copy.rejects(new Error("Clipboard unavailable"));
  await modal.onOpen();

  await content.descendants().find((el) => el.tag === "button")!.click!();

  assert.deepEqual(notices, ["Unable to copy error details to clipboard."]);
});

test("shows an empty state when no errors were recorded", async () => {
  const { modal, content } = setup(upToDate, []);

  await modal.onOpen();

  assert.equal(
    content.descendants().some((el) => el.text === "No errors recorded."),
    true,
  );
});

test("shows a readable error when saved history cannot be loaded", async () => {
  const { modal, content, logger } = setup();
  logger.getRecentErrors.rejects(new Error("Read failed"));

  await modal.onOpen();

  assert.equal(
    content.descendants().find((el) => el.text.startsWith("Unable to read error history."))?.text,
    "Unable to read error history. Error: Read failed",
  );
});
