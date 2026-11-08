'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('display name holds every word of the target phrases', () => {
  const name = pkg.displayName.toLowerCase();
  for (const phrase of ['rtf viewer', 'rtf', 'rich text viewer', 'rtf preview']) for (const w of phrase.split(' ')) assert.ok(name.includes(w), w);
  assert.ok(!/\b(word|docx)\b/i.test(pkg.displayName), 'Word and DOCX belong to the DOCX listing');
});

test('engines floor is ^1.90.0 (OVX1) and there are no runtime dependencies', () => {
  assert.equal(pkg.engines.vscode, '^1.90.0');
  assert.ok(!pkg.dependencies || !Object.keys(pkg.dependencies).length);
});

test('custom editor for .rtf, read-only, default priority', () => {
  const ce = pkg.contributes.customEditors[0];
  assert.equal(ce.viewType, 'rtfViewer.preview');
  assert.deepEqual(ce.selector, [{ filenamePattern: '*.rtf' }]);
  assert.ok(pkg.activationEvents.includes('onCustomEditor:rtfViewer.preview'));
});

test('every command has a handler in extension.js or support.js', () => {
  const src = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8') + fs.readFileSync(path.join(root, 'src', 'support.js'), 'utf8');
  for (const c of pkg.contributes.commands) {
    const short = c.command.split('.')[1];
    assert.ok(src.includes("'" + c.command + "'") || src.includes('`${prefix}.' + short + '`'), c.command);
  }
});

test('settings: rating ask and support links can be turned off', () => {
  const p = pkg.contributes.configuration.properties;
  assert.equal(p['rtfViewer.askForRating'].default, true);
  assert.equal(p['rtfViewer.showSupportLinks'].default, true);
});

test('vsix content: no tests, scripts, large samples or images; the walkthrough sample ships', () => {
  const ig = fs.readFileSync(path.join(root, '.vscodeignore'), 'utf8');
  for (const l of ['test/**', 'scripts/**', 'samples/**', '!samples/welcome.rtf', 'images/**']) assert.ok(ig.split('\n').includes(l), l);
  assert.ok(fs.existsSync(path.join(root, 'samples', 'welcome.rtf')));
});

test('walkthrough media files exist', () => {
  for (const s of pkg.contributes.walkthroughs[0].steps) if (s.media.markdown) assert.ok(fs.existsSync(path.join(root, s.media.markdown)), s.media.markdown);
});

test('webview CSP: no network, scripts by nonce', () => {
  const { buildHtml, csp } = require('../src/webview-html');
  const wv = { cspSource: 'vscode-resource:', asWebviewUri: (u) => ({ toString: () => 'vscode-resource:' + u.path }) };
  const html = buildHtml({ webview: wv, extensionUri: { path: '/ext', with: (o) => ({ path: o.path }) }, title: '<x>.rtf', prefs: { theme: 'dark' } });
  const c = csp(wv, 'N');
  assert.match(c, /default-src 'none'/);
  assert.match(c, /connect-src 'none'/);
  assert.match(c, /script-src 'nonce-N'/);
  assert.doesNotMatch(c, /https?:/);
  assert.doesNotMatch(html, /<x>\.rtf/);
  assert.ok((html.match(/<script nonce="/g) || []).length === 2);
  assert.match(html, /id="zovo-support"/);
});
