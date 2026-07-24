const assert = require("node:assert/strict");
const test = require("node:test");

const identity = require("../out/sessionIdentity.js");

test("Pi identity includes project scope when no file path is available", () => {
  const first = identity.sessionIdentityKey({
    provider: "pi",
    session_id: "main",
    project_path: "/work/alpha",
  });
  const second = identity.sessionIdentityKey({
    provider: "pi",
    session_id: "main",
    project_path: "/work/beta",
  });

  assert.notEqual(first, second);
});

test("session ids are case-sensitive for Pi and case-insensitive for legacy agents", () => {
  assert.equal(identity.sessionIdMatches("pi", "Research", "research"), false);
  assert.equal(identity.sessionIdMatches("claude", "ABC-123", "abc-123"), true);
  assert.equal(identity.sessionIdMatches("codex", "ABC-123", "abc", true), true);
});

test("Pi bookmarks only match the same project while Codex matches by id", () => {
  const piSession = { provider: "pi", session_id: "main", project_path: "/work/a" };
  assert.equal(
    identity.sameSessionIdentity(piSession, {
      provider: "pi",
      session_id: "main",
      project_path: "/work/b",
    }),
    false
  );
  assert.equal(
    identity.sameSessionIdentity(
      { provider: "codex", session_id: "ABC", project_path: "/work/a" },
      { provider: "codex", session_id: "abc", project_path: "/work/b" }
    ),
    true
  );
});
