import * as assert from "node:assert/strict";
import test from "node:test";
import {
  getDeletionSyncAction,
  isContentConflict,
  tryThreeWayMerge,
} from "./conflict-resolution";

test("does not classify a local deletion as a text conflict", () => {
  assert.equal(
    isContentConflict(
      { sha: "remote-change" },
      { sha: "base", deleted: true },
      null,
    ),
    false,
  );
});

test("does not classify a remote deletion as a text conflict", () => {
  assert.equal(
    isContentConflict(
      { sha: "base", deleted: true },
      { sha: "base" },
      "local-change",
    ),
    false,
  );
});

test("classifies different local and remote edits as a text conflict", () => {
  assert.equal(
    isContentConflict(
      { sha: "remote-change" },
      { sha: "base" },
      "local-change",
    ),
    true,
  );
});

test("propagates a local deletion when remote content is unchanged", () => {
  assert.equal(
    getDeletionSyncAction(
      { sha: "base", lastModified: 300 },
      { sha: "base", deleted: true, deletedAt: 200 },
      null,
    ),
    "delete_remote",
  );
});

test("restores a file when the remote edit is newer than its local deletion", () => {
  assert.equal(
    getDeletionSyncAction(
      { sha: "remote-change", lastModified: 300 },
      { sha: "base", deleted: true, deletedAt: 200 },
      null,
    ),
    "download",
  );
});

test("prefers a local deletion over an older remote edit", () => {
  assert.equal(
    getDeletionSyncAction(
      { sha: "remote-change", lastModified: 100 },
      { sha: "base", deleted: true, deletedAt: 200 },
      null,
    ),
    "delete_remote",
  );
});

test("propagates a remote deletion when local content is unchanged", () => {
  assert.equal(
    getDeletionSyncAction(
      { sha: "base", deleted: true, deletedAt: 200 },
      { sha: "base", lastModified: 300 },
      "base",
    ),
    "delete_local",
  );
});

test("reuploads a local edit made after a remote deletion", () => {
  assert.equal(
    getDeletionSyncAction(
      { sha: "base", deleted: true, deletedAt: 200 },
      { sha: "base", lastModified: 300 },
      "local-change",
    ),
    "upload",
  );
});

test("prefers a remote deletion over an older local edit", () => {
  assert.equal(
    getDeletionSyncAction(
      { sha: "base", deleted: true, deletedAt: 300 },
      { sha: "base", lastModified: 200 },
      "local-change",
    ),
    "delete_local",
  );
});

test("merges edits to different parts of a file", () => {
  const base = "title\nfirst paragraph\nsecond paragraph\nend\n";
  const local = "local title\nfirst paragraph\nsecond paragraph\nend\n";
  const remote = "title\nfirst paragraph\nremote paragraph\nend\n";

  assert.equal(
    tryThreeWayMerge(local, base, remote),
    "local title\nfirst paragraph\nremote paragraph\nend\n",
  );
});

test("merges independent insertions and preserves the trailing newline", () => {
  const base = "one\ntwo\nthree\n";
  const local = "one\nlocal\ntwo\nthree\n";
  const remote = "one\ntwo\nthree\nremote\n";

  assert.equal(
    tryThreeWayMerge(local, base, remote),
    "one\nlocal\ntwo\nthree\nremote\n",
  );
});

test("accepts the same change made on both sides", () => {
  assert.equal(
    tryThreeWayMerge("one\nchanged\n", "one\ntwo\n", "one\nchanged\n"),
    "one\nchanged\n",
  );
});

test("leaves overlapping edits for manual resolution", () => {
  assert.equal(
    tryThreeWayMerge("one\nlocal\n", "one\nbase\n", "one\nremote\n"),
    null,
  );
});
