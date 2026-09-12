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
