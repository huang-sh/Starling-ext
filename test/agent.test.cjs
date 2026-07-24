const assert = require("node:assert/strict");
const test = require("node:test");

const agent = require("../out/agent.js");

test("recognizes all Starling agent providers", () => {
  assert.deepEqual(agent.AGENT_PROVIDERS, ["claude", "codex", "pi"]);
  assert.equal(agent.normalizeAgentProvider(" PI "), "pi");
  assert.equal(agent.normalizeAgentProvider("other"), undefined);
});

test("builds provider-native resume arguments", () => {
  assert.deepEqual(agent.agentResumeArgs("claude", "sid"), ["--resume", "sid"]);
  assert.deepEqual(agent.agentResumeArgs("codex", "sid"), ["resume", "sid"]);
  assert.deepEqual(agent.agentResumeArgs("pi", "MixedCase", "/sessions/pi.jsonl"), [
    "--session",
    "/sessions/pi.jsonl",
  ]);
  assert.throws(() => agent.agentResumeArgs("pi", "sid"), /transcript path/);
});

test("builds provider-native fork arguments", () => {
  assert.deepEqual(agent.agentForkArgs("claude", "sid"), [
    "--resume",
    "sid",
    "--fork-session",
  ]);
  assert.deepEqual(agent.agentForkArgs("codex", "sid"), ["fork", "sid"]);
  assert.deepEqual(agent.agentForkArgs("pi", "MixedCase", "/sessions/pi.jsonl"), [
    "--fork",
    "/sessions/pi.jsonl",
  ]);
  assert.throws(() => agent.agentForkArgs("pi", "sid"), /transcript path/);
});
