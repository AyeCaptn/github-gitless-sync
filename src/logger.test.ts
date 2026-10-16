import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const proxyquire = require("proxyquire").noCallThru();

const Logger = proxyquire("./logger", {
  obsidian: {
    Vault: class {},
    normalizePath: (path: string) => path,
  },
}).default;

function loggerWithHistory(content: string) {
  return new Logger(
    {
      configDir: ".obsidian",
      adapter: { read: async () => content },
    },
    false,
  );
}

test("writes errors when verbose logging is disabled", async () => {
  const entries: string[] = [];
  const vault = {
    configDir: ".obsidian",
    adapter: {
      append: async (_path: string, content: string) => entries.push(content),
    },
  };
  const logger = new Logger(vault, false);

  await logger.info("not persisted");
  await logger.error("sync failed", "merge conflict");

  assert.equal(entries.length, 1);
  assert.deepEqual(JSON.parse(entries[0]), {
    timestamp: JSON.parse(entries[0]).timestamp,
    level: "ERROR",
    message: "sync failed",
    additional_data: "merge conflict",
  });
});

test("returns the last 10 saved errors, newest first", async () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    timestamp: `2026-10-16T10:00:${String(index).padStart(2, "0")}Z`,
    level: "ERROR",
    message: `Failure ${index}`,
  }));
  const logger = loggerWithHistory(
    entries.map((entry) => JSON.stringify(entry)).join("\n"),
  );

  const errors = await logger.getRecentErrors();

  assert.deepEqual(errors.map((error: { message: string }) => error.message), [
    "Failure 11",
    "Failure 10",
    "Failure 9",
    "Failure 8",
    "Failure 7",
    "Failure 6",
    "Failure 5",
    "Failure 4",
    "Failure 3",
    "Failure 2",
  ]);
});

test("preserves the complete GitHub error response in saved history", async () => {
  const entry = {
    timestamp: "2026-10-16T10:00:00Z",
    level: "ERROR",
    message: "Failed to update branch head sha",
    additional_data: {
      status: 422,
      message: "Update is not a fast forward",
      response: '{"message":"Update is not a fast forward","status":"422"}',
    },
  };
  const logger = loggerWithHistory(JSON.stringify(entry));

  assert.deepEqual(await logger.getRecentErrors(), [entry]);
});

test("ignores non-errors and malformed entries without hiding earlier errors", async () => {
  const entry = {
    timestamp: "2026-10-16T10:00:00Z",
    level: "ERROR",
    message: "Sync failed",
  };
  const logger = loggerWithHistory(
    [
      JSON.stringify(entry),
      JSON.stringify({ ...entry, level: "INFO" }),
      JSON.stringify({ ...entry, level: "WARN" }),
      JSON.stringify({ level: "ERROR", message: "Missing timestamp" }),
      "null",
      '{"level":"ERROR",',
      "",
    ].join("\n"),
  );

  assert.deepEqual(await logger.getRecentErrors(), [entry]);
});

test("returns no recent errors for an empty log", async () => {
  const logger = loggerWithHistory("");

  assert.deepEqual(await logger.getRecentErrors(), []);
});

test("reports a failure to read saved error history", async () => {
  const logger = new Logger(
    {
      configDir: ".obsidian",
      adapter: {
        read: async () => {
          throw new Error("Read failed");
        },
      },
    },
    false,
  );

  await assert.rejects(logger.getRecentErrors(), /Read failed/);
});
