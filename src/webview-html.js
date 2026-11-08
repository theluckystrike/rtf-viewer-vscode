'use strict';
// The webview page. CSP: nothing from the network; scripts and styles only from the extension's media folder
// (scripts also need the nonce); pictures only from blob: and data: URLs the page makes itself.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

function nonce() { return crypto.randomBytes(18).toString('base64').replace(/[^A-Za-z0-9]/g, ''); }
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function csp(webview, n) {
  return [
    "default-src 'none'",
    `img-src ${webview.cspSource} blob: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${n}'`,
    "connect-src 'none'", "frame-src 'none'", "worker-src 'none'", "form-action 'none'", "base-uri 'none'"
  ].join('; ');
}

function buildHtml(o) {
  const wv = o.webview;
  const n = nonce();
  const media = (f) => wv.asWebviewUri(o.extensionUri.with({ path: o.extensionUri.path + '/media/' + f })).toString();
  const prefs = JSON.stringify(o.prefs || {}).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp(wv, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RTF Viewer</title>
<link rel="stylesheet" href="${media('viewer.css')}">
<style>${FOOTER_CSS}</style>
</head><body>
<div id="app" data-pictures="${esc(media('pictures.js'))}" data-nonce="${n}">
<div id="bar" role="toolbar" aria-label="RTF Viewer">
  <button id="btnOutline" title="Outline (headings)" aria-pressed="false">☰ Outline</button>
  <span class="grp find"><input id="q" type="search" placeholder="Find (Cmd/Ctrl+F)" aria-label="Find in document"><span id="hits" aria-live="polite"></span><button id="prev" title="Previous match (Shift+Enter)">↑</button><button id="next" title="Next match (Enter)">↓</button></span>
  <span class="grp"><button id="zout" title="Zoom out (Ctrl -)">−</button><button id="zval" title="Reset zoom">100%</button><button id="zin" title="Zoom in (Ctrl =)">+</button><button id="zfit" title="Fit page width">Fit</button></span>
  <span class="grp"><label>View <select id="view" aria-label="View"><option value="page">Page</option><option value="flow">Flow</option></select></label>
  <label>Page <select id="theme" aria-label="Page colors"><option value="auto">Auto</option><option value="light">Light</option><option value="dark">Dark</option><option value="invert">Invert</option></select></label></span>
  <span class="grp"><button id="btnCopy" title="Copy all text">Copy text</button><button id="btnExport" title="Save as one HTML file">Export HTML</button><button id="btnText" title="Open the RTF source in the text editor">Open as Text</button></span>
</div>
<div id="notes" hidden></div>
<div id="main">
  <nav id="outline" hidden aria-label="Outline"></nav>
  <div id="scroller" tabindex="0">
    <div id="status" role="status">Opening ${esc(o.title || '')}…</div>
    <div id="paper" class="doc" hidden><div id="docbody"></div><div id="fns"></div></div>
  </div>
</div>
${footerHtml('rtfViewer', o.showSupportLinks !== false, 'zovo-support-fixed')}
</div>
<script nonce="${n}">window.RTFV_PREFS = ${prefs};</script>
<script nonce="${n}" src="${media('viewer.js')}"></script>
</body></html>`;
}

module.exports = { buildHtml, csp };
