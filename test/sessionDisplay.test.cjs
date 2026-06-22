const assert = require("node:assert/strict");
const test = require("node:test");

const display = require("../out/sessionDisplay.js");

test("formats monitor status glyphs with the canonical statuses", () => {
  assert.equal(display.formatStatusGlyph("waiting"), "⏸ Waiting");
  assert.equal(display.formatStatusGlyph("running"), "● Running");
  assert.equal(display.formatStatusGlyph("stale_running"), "◐ Running?");
  assert.equal(display.formatStatusGlyph("aborted"), "× Aborted");
  assert.equal(display.formatStatusGlyph("idle"), "○ Idle");
  assert.equal(display.formatStatusGlyph("stopped"), "· Stopped");
  assert.equal(display.formatStatusGlyph("unknown"), "? Unknown");
});

test("formats compact token counts and token usage", () => {
  assert.equal(display.formatTokenCount(undefined), "-");
  assert.equal(display.formatTokenCount(842), "842");
  assert.equal(display.formatTokenCount(12_345), "12.3K");
  assert.equal(display.formatTokenCount(1_500_000), "1.5M");
  assert.equal(
    display.formatTokenUsage({
      input_tokens: 12_345,
      output_tokens: 678,
      total_tokens: 13_023,
      cache_tokens: 1_200,
    }),
    "input: 12.3K, output: 678, total: 13K, cache: 1.2K",
  );
});

test("formats runtime resources for monitor descriptions", () => {
  assert.equal(display.formatCpuPct(undefined), "-");
  assert.equal(display.formatCpuPct(12.3), "12%");
  assert.equal(display.formatMemKb(undefined), "-");
  assert.equal(display.formatMemKb(900 * 1024), "900M");
  assert.equal(display.formatMemKb(2 * 1024 * 1024), "2.00G");
  assert.equal(display.formatCtxPct(-1), "-");
  assert.equal(display.formatCtxPct(62.4), "62%");
});

test("formats elapsed seconds and short session ids", () => {
  assert.equal(display.shortSessionId("8fa13c6d-3b35-4c83-834a-5043d755b223"), "8fa13c6d-3b35");
  assert.equal(display.formatElapsedSecs(0), "-");
  assert.equal(display.formatElapsedSecs(45), "45s");
  assert.equal(display.formatElapsedSecs(125), "2m");
  assert.equal(display.formatElapsedSecs(3_900), "1h 5m");
});
