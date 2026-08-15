const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");

function renderChat() {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === "vscode") return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { chatHtml } = require("../out/views/piChat.js");
    return chatHtml({ cspSource: "vscode-webview:" });
  } finally {
    Module._load = originalLoad;
  }
}

test("renders the Codex-style Starling chat shell without dropping chat controls", () => {
  const html = renderChat();

  assert.match(html, /class="thread-header"/);
  assert.match(html, /class="empty-state"/);
  assert.match(html, /class="composer-shell"/);
  assert.match(html, /aria-label="New chat"/);
  assert.match(html, /aria-label="Chat history"/);
  assert.match(html, /aria-label="Send message"/);
  assert.match(html, /aria-label="Stop agent"/);
  assert.match(html, /Ask Starling to build, review, or explain/);
  assert.match(html, /busy \? 'Queue follow-up' : 'Send message'/);
  assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(html, /Content-Security-Policy/);
  assert.doesNotMatch(html, />New<\/button>/);
  assert.doesNotMatch(html, />History<\/button>/);
});
