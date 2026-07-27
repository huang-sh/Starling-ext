const assert = require("node:assert/strict");
const test = require("node:test");

const {
  monitorRefreshDelayMs,
  monitorRetryDelayMs,
  monitorTimeoutMs,
} = require("../out/monitorPolicy.js");

test("monitor timeout defaults to 60 seconds and accepts a configured value", () => {
  assert.equal(monitorTimeoutMs(undefined), 60_000);
  assert.equal(monitorTimeoutMs(90), 90_000);
  assert.equal(monitorTimeoutMs(0.1), 1_000);
});

test("monitor retry delay uses capped exponential backoff with jitter", () => {
  assert.equal(monitorRetryDelayMs(1, () => 0), 5_000);
  assert.equal(monitorRetryDelayMs(2, () => 0), 10_000);
  assert.equal(monitorRetryDelayMs(3, () => 1), 24_000);
  assert.equal(monitorRetryDelayMs(20, () => 1), 60_000);
});

test("monitor refresh delay adds bounded positive jitter", () => {
  assert.equal(monitorRefreshDelayMs(5_000, () => 0), 5_000);
  assert.equal(monitorRefreshDelayMs(5_000, () => 1), 6_000);
});
