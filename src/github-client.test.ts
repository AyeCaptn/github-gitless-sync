import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { DEFAULT_SETTINGS } from "./settings/settings";

const require = createRequire(import.meta.url);
(globalThis as { require?: NodeRequire }).require = require;
const proxyquire = require("proxyquire").noCallThru();

function createClient(status = 200, message = "") {
  const requests: { url: string; body?: string }[] = [];
  const errors: unknown[] = [];
  const clientModule = proxyquire("./github/client", {
    obsidian: {
      requestUrl: async (request: { url: string; body?: string }) => {
        requests.push(request);
        return {
          status,
          json: { message, tree: [], sha: "tree" },
          text: JSON.stringify({ message }),
        };
      },
    },
  });
  const client = new clientModule.default(
    {
      ...DEFAULT_SETTINGS,
      githubOwner: "owner",
      githubRepo: "repo",
      githubBranch: "notes/mobile",
    },
    { error: async (...args: unknown[]) => errors.push(args) },
  );
  return { client, requests, errors, clientModule };
}

for (const status of [409, 422]) {
  test(`classifies a ${status} non-fast-forward rejection for full sync retry`, async () => {
    const { client, clientModule } = createClient(
      status,
      "Update is not a fast forward",
    );

    await assert.rejects(
      client.updateBranchHead({ sha: "commit", retry: true }),
      clientModule.RemoteBranchChangedError,
    );
  });
}

test("does not save recoverable branch races as errors", async () => {
  const { client, errors } = createClient(422, "Update is not a fast forward");

  await client.updateBranchHead({ sha: "commit" }).catch(() => undefined);

  assert.deepEqual(errors, []);
});

test("does not retry a stale branch update request", async () => {
  const { client, requests } = createClient(422, "Update is not a fast forward");

  await client.updateBranchHead({ sha: "commit", retry: true })
    .catch(() => undefined);

  assert.equal(requests.length, 1);
});

test("preserves unrelated 422 validation errors", async () => {
  const { client } = createClient(422, "Protected branch update failed");

  await assert.rejects(
    client.updateBranchHead({ sha: "commit", retry: true }),
    /Failed to update branch head sha: Protected branch update failed \(status 422\)/,
  );
});

test("explicitly disables force updates", async () => {
  const { client, requests } = createClient();

  await client.updateBranchHead({ sha: "commit" });

  assert.deepEqual(JSON.parse(requests[0].body!), {
    sha: "commit",
    force: false,
  });
});

test("loads a repository tree from the requested snapshot", async () => {
  const { client, requests } = createClient();

  await client.getRepoContent({ ref: "snapshot-sha" });

  assert.equal(
    new URL(requests[0].url).pathname,
    "/repos/owner/repo/git/trees/snapshot-sha",
  );
});

test("keeps the configured branch as the default tree ref", async () => {
  const { client, requests } = createClient();

  await client.getRepoContent();

  assert.equal(
    new URL(requests[0].url).pathname,
    "/repos/owner/repo/git/trees/notes%2Fmobile",
  );
});

test("downloads the archive from the requested snapshot", async () => {
  const { client, requests } = createClient();

  await client.downloadRepositoryArchive({ ref: "snapshot-sha" });

  assert.equal(
    new URL(requests[0].url).pathname,
    "/repos/owner/repo/zipball/snapshot-sha",
  );
});
