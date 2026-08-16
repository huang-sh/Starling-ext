// Runnable check for the trajectory webview markdown rendering.
// Loads the exact vendor bundles (marked + hljs from pi's export-html) and the
// same shim string shipped to the webview.
// Usage: npm run compile && npm run check:md
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { TRAJECTORY_MD_JS } = require("../out/views/trajectoryMarkdown.js");

const root = new URL("..", import.meta.url).pathname;
// marked/hljs are vendored browser scripts: evaluate them in this global scope.
globalThis.self = globalThis;
(0, eval)(fs.readFileSync(`${root}assets/vendor/marked.min.js`, "utf-8"));
(0, eval)(fs.readFileSync(`${root}assets/vendor/highlight.min.js`, "utf-8"));
if (typeof globalThis.marked === "undefined" || typeof globalThis.hljs === "undefined") {
  console.error("vendor bundles failed to load");
  process.exit(1);
}
(0, eval)(TRAJECTORY_MD_JS);

const cases = [
  // [name, input, must-contain, must-not-contain]
  ["heading", "# Title\nbody", ["<h1>Title</h1>", "body"], []],
  ["nested list", "- a\n  - nested\n- b", ["<ul>", "<li>a", "<li>nested</li>"], []],
  ["fence highlight", "```js\nlet x = 1 < 2;\n```", ["hljs", "&lt;"], ["<script"]],
  ["inline code", "run `npm i <b>` now", ["<code>npm i &lt;b&gt;</code>"], ["<b>"]],
  ["bold+italic", "**bold** and *ital*", ["<strong>bold</strong>", "<em>ital</em>"], []],
  ["strike strict", "gone ~~old~~ new", ["<del>old</del>"], []],
  ["table", "| a | b |\n|---|---|\n| 1 | 2 |", ["<th>a</th>", "<td>1</td>"], []],
  ["quote", "> note here", ["<blockquote>"], []],
  ["link ok", "see [docs](https://example.com/a?b=1)", ["<a href=\"https://example.com/a?b=1\">docs</a>"], []],
  ["xss escaped", "<script>alert(1)</script> & <b>raw</b>", ["&lt;script&gt;", "&lt;b&gt;raw&lt;/b&gt;"], ["<script>alert", "<b>raw</b>"]],
  ["xss link href", "[x](javascript:alert(1))", ["<p>x</p>"], ["<a ", "javascript:"]],
  ["mdOrPre json stays pre", '{"path": "/x"}', ["<pre>"], ["markdown-content"]],
  ["mdOrPre md renders", "## Heading\n\n- item", ["markdown-content", "<h2>Heading</h2>"], ["<pre>"]],
];

let failed = 0;
for (const [name, input, has, hasNot] of cases) {
  const fn = name.startsWith("mdOrPre") ? mdOrPre : md;
  const html = fn(input);
  for (const needle of has) {
    if (!html.includes(needle)) { console.error(`FAIL ${name}: missing ${JSON.stringify(needle)} in ${JSON.stringify(html.slice(0, 300))}`); failed++; }
  }
  for (const needle of hasNot) {
    if (html.includes(needle)) { console.error(`FAIL ${name}: unexpected ${JSON.stringify(needle)} in ${JSON.stringify(html.slice(0, 300))}`); failed++; }
  }
}
if (failed) { console.error(`\n${failed} assertion(s) failed`); process.exit(1); }
console.log(`pi-style markdown rendering: ${cases.length} cases OK`);
