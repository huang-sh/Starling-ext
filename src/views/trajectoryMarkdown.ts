/**
 * Webview shim rendering trajectory input/output exactly like Pi's TUI
 * markdown pipeline (dist/core/export-html/template.js): marked with gfm +
 * breaks, HTML-like input treated as plain text, URL scheme allow-list,
 * hljs syntax highlighting for code blocks.
 *
 * Requires `marked` and `hljs` globals, provided by inlining
 * assets/vendor/marked.min.js and assets/vendor/highlight.min.js.
 * Vendored from @earendil-works/pi-coding-agent so rendering matches `pi`
 * /export byte-for-byte. Checked by `npm run check:md`.
 */
export const TRAJECTORY_MD_JS = `// ---- markdown renderer (ported from pi's export-html template) ----
function __mdEsc(s) { return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function sanitizeMarkdownUrl(value) {
  var href = String(value || "").trim().replace(/[\\x00-\\x1f\\x7f]/g, '');
  if (!href) return href;
  var scheme = href.match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  if (scheme && !/^(https?|mailto|tel|ftp)$/i.test(scheme[1])) return null;
  return href;
}
var __mdInit = false;
function md(src) {
  if (typeof marked === "undefined") return "<pre>" + __mdEsc(src) + "</pre>";
  if (!__mdInit) {
    __mdInit = true;
    var strictStrikethroughRegex = /^(~~)(?=[^\\s~])((?:\\\\.|[^\\\\])*?(?:\\\\.|[^\\s~\\\\]))\\1(?=[^~]|$)/;
    marked.use({
      breaks: true,
      gfm: true,
      tokenizer: {
        // Treat HTML-like input as plain text so tags are shown verbatim,
        // matching the TUI markdown renderer.
        html() { return undefined; },
        tag() { return undefined; },
        del(src) {
          var match = strictStrikethroughRegex.exec(src);
          if (!match) return undefined;
          return {
            type: 'del',
            raw: match[0],
            text: match[2],
            tokens: this.lexer.inlineTokens(match[2])
          };
        }
      },
      renderer: {
        link(token) {
          var href = sanitizeMarkdownUrl(token.href);
          if (href === null) return this.parser.parseInline(token.tokens);
          var out = '<a href="' + __mdEsc(href) + '"';
          if (token.title) out += ' title="' + __mdEsc(token.title) + '"';
          out += '>' + this.parser.parseInline(token.tokens) + '</a>';
          return out;
        },
        image(token) {
          var href = sanitizeMarkdownUrl(token.href);
          if (href === null) return __mdEsc(token.text || '');
          var out = '<img src="' + __mdEsc(href) + '" alt="' + __mdEsc(token.text || '') + '"';
          if (token.title) out += ' title="' + __mdEsc(token.title) + '"';
          return out + '>';
        },
        code(token) {
          var code = token.text, lang = token.lang, highlighted;
          if (lang && hljs.getLanguage(lang)) {
            try { highlighted = hljs.highlight(code, { language: lang }).value; }
            catch { highlighted = __mdEsc(code); }
          } else {
            try { highlighted = hljs.highlightAuto(code).value; }
            catch { highlighted = __mdEsc(code); }
          }
          return '<pre><code class="hljs">' + highlighted + '</code></pre>';
        },
        codespan(token) {
          return '<code>' + __mdEsc(token.text) + '</code>';
        }
      }
    });
  }
  return marked.parse(String(src ?? ""));
}
function looksMd(t) {
  var t = String(t ?? "");
  return /(^|\\n)\\s*#{1,6}\\s/.test(t) || /(^|\\n)\\s*[-*+]\\s+\\S/.test(t) ||
    /(^|\\n)\\s*\\d+[.)]\\s+\\S/.test(t) || /\u0060\u0060\u0060/.test(t) || /\u0060[^\u0060\\n]+\u0060/.test(t) ||
    /\\*\\*[^*]+\\*\\*/.test(t) || /(^|\\n)\\s*\\|.+\\|/.test(t) || /(^|\\n)\\s*&gt;/.test(t);
}
function mdOrPre(s) {
  var t = String(s ?? "");
  return looksMd(t) ? "<div class='md markdown-content'>" + md(t) + "</div>" : "<pre>" + __mdEsc(t) + "</pre>";
}
`;
