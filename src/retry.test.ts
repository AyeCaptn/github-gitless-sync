import * as assert from "node:assert/strict";
import test from "node:test";
import {
  getHttpRetryDelay,
  isTransientHttpResponse,
  retryUntil,
} from "./retry";

test("classifies transient GitHub responses", () => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    assert.equal(isTransientHttpResponse({ status }), true);
  }

  assert.equal(isTransientHttpResponse({ status: 422 }), false);
  assert.equal(isTransientHttpResponse({ status: 404 }), false);
  assert.equal(
    isTransientHttpResponse({
      status: 403,
      headers: { "Retry-After": "60" },
    }),
    true,
  );
});

test("retries a 502 response and returns the successful response", async () => {
  let attempts = 0;
  const response = await retryUntil(
    async () => ({ status: ++attempts === 1 ? 502 : 201 }),
    (result) => !isTransientHttpResponse(result),
    2,
    0,
  );

  assert.equal(response.status, 201);
  assert.equal(attempts, 2);
});

test("honors GitHub rate-limit retry headers", () => {
  assert.equal(
    getHttpRetryDelay(
      { status: 403, headers: { "Retry-After": "60" } },
      1000,
      10_000,
    ),
    60_000,
  );
  assert.equal(
    getHttpRetryDelay(
      { status: 403, headers: { "X-RateLimit-Reset": "70" } },
      1000,
      10_000,
    ),
    60_000,
  );
  assert.equal(getHttpRetryDelay({ status: 429 }, 1000, 10_000), 60_000);
});

test("retries network errors and rethrows the final error", async () => {
  let attempts = 0;

  await assert.rejects(
    retryUntil(
      async () => {
        attempts++;
        throw new Error("offline");
      },
      () => true,
      2,
      0,
    ),
    /offline/,
  );
  assert.equal(attempts, 3);
});
