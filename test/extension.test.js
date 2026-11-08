'use strict';
// The extension host code with a fake VS Code API: commands, the custom editor, the worker round trip,
// the size limit, links and errors.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const Module = require('module');

const root = path.join(__dirname, '..');
const S = path.join(root, 'samples');

function fakeVscode(over = {}) {
  const commands = new Map();
  const shown = { warn: [], info: [], external: [], clipboard: '', executed: [] };
  const settings = Object.assign({ theme: 'auto', view: 'page', zoom: 1, maxFileSizeMB: 200, maxImageSizeMB: 20, liveReload: false, askForRating: false, showSupportLinks: true }, over.settings || {});
  class Uri {
    constructor(scheme, p) { this.scheme = scheme; this.path = p; this.fsPath = p; }
    static file(p) { return new Uri('file', p); }
    static parse(s) { const m = /^([a-z]+):(.*)$/i.exec(s); return new Uri(m ? m[1] : 'file', m ? m[2] : s); }
    static joinPath(u, ...parts) { return new Uri(u.scheme, path.posix.join(u.path, ...parts)); }
    with(o) { return new Uri(o.scheme || this.scheme, o.path || this.path); }
    toString() { return this.scheme + '://' + this.path; }
  }
  const vscode = {
    Uri,
    RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
    QuickPickItemKind: { Separator: -1 },
    workspace: {
      getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
      fs: { stat: async (u) => ({ size: fs.statSync(u.fsPath).size }), readFile: async (u) => fs.readFileSync(u.fsPath), writeFile: async () => {} },
      createFileSystemWatcher: () => ({ onDidChange: () => ({ dispose() {} }), onDidCreate: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose() {} }),
    },
    window: {
      registerCustomEditorProvider: (type, provider) => { vscode._provider = provider; vscode._viewType = type; return { dispose() {} }; },
      showWarningMessage: (m) => { shown.warn.push(m); return Promise.resolve(); },
      showInformationMessage: (m) => { shown.info.push(m); return Promise.resolve(); },
      setStatusBarMessage: () => ({ dispose() {} }),
      showQuickPick: async () => undefined,
      showSaveDialog: async () => undefined,
      activeTextEditor: undefined,
      state: { focused: true },
      onDidChangeWindowState: () => ({ dispose() {} }),
    },
    commands: {
      registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
      executeCommand: async (...a) => { shown.executed.push(a); },
    },
    env: { openExternal: async (u) => { shown.external.push(u.toString()); return true; }, clipboard: { writeText: async (t) => { shown.clipboard = t; } }, appName: 'Visual Studio Code', uriScheme: 'vscode' },
    extensions: { getExtension: () => undefined },
  };
  return { vscode, commands, shown };
}

function load(fake) {
  const orig = Module._load;
  Module._load = function (req, ...rest) { return req === 'vscode' ? fake.vscode : orig.call(this, req, ...rest); };
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(root, 'src'))) delete require.cache[k];
  try { return require(path.join(root, 'src', 'extension.js')); } finally { Module._load = orig; }
}

function context() {
  const store = new Map();
  const state = { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => { store.set(k, v); }, keys: () => [...store.keys()] };
  return { subscriptions: [], extensionUri: fake0.vscode.Uri.file(root), globalState: state, workspaceState: state, globalStorageUri: fake0.vscode.Uri.file('/tmp/gs'), storageUri: undefined, extension: { packageJSON: require('../package.json') } };
}
const fake0 = fakeVscode();

function openEditor(fake, ext, file) {
  const ctx = context();
  ext.activate(ctx);
  const posted = [];
  let onMsg = null;
  const webview = {
    cspSource: 'vscode-webview://x', options: {}, html: '',
    asWebviewUri: (u) => ({ toString: () => 'vscode-webview://x' + u.path }),
    onDidReceiveMessage: (fn) => { onMsg = fn; return { dispose() {} }; },
    postMessage: async (m) => { posted.push(m); return true; },
  };
  const panel = { webview, active: true, onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }) };
  const uri = fake.vscode.Uri.file(file);
  const doc = fake.vscode._provider.openCustomDocument(uri);
  fake.vscode._provider.resolveCustomEditor(doc, panel);
  return { posted, send: (m) => onMsg(m), webview, ctx };
}
const until = async (fn, ms = 10000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 20)); } return null; };

test('activate registers the custom editor and every command', () => {
  const fake = fakeVscode();
  const ext = load(fake);
  ext.activate(context());
  assert.equal(fake.vscode._viewType, 'rtfViewer.preview');
  for (const c of require('../package.json').contributes.commands) assert.ok(fake.commands.has(c.command), c.command);
});

test('ready -> start, chunks and done from the worker; the webview has the strict CSP', async () => {
  const fake = fakeVscode();
  const ext = load(fake);
  const ed = openEditor(fake, ext, path.join(S, 'welcome.rtf'));
  assert.match(ed.webview.html, /default-src 'none'/);
  assert.deepEqual(ed.webview.options.enableCommandUris, ['rtfViewer.supportDeveloper', 'rtfViewer.moreViewers', 'workbench.action.openSettings']);
  ed.send({ type: 'ready' });
  const done = await until(() => ed.posted.find((m) => m.type === 'done'));
  assert.ok(done, JSON.stringify(ed.posted.map((m) => m.type)));
  assert.equal(ed.posted[0].type, 'start');
  const chunks = ed.posted.filter((m) => m.type === 'chunk');
  assert.ok(chunks.length >= 1);
  assert.equal(chunks[0].page.w, 12240);
  assert.match(chunks.map((c) => c.html).join(''), /Quarterly field report/);
  assert.equal(chunks.reduce((a, c) => a + c.images.length, 0), 1);
  assert.ok(chunks.flatMap((c) => c.images)[0].bytes instanceof Uint8Array);
  assert.match(done.res.header, /Northwind/);
});

test('files over the limit ask first; Open anyway loads them', async () => {
  const fake = fakeVscode({ settings: { maxFileSizeMB: 0.001 } });
  const ext = load(fake);
  const ed = openEditor(fake, ext, path.join(S, 'clinical-ae.rtf'));
  ed.send({ type: 'ready' });
  const big = await until(() => ed.posted.find((m) => m.type === 'tooLarge'));
  assert.ok(big && big.name === 'clinical-ae.rtf');
  assert.ok(!ed.posted.some((m) => m.type === 'start'));
  ed.send({ type: 'openAnyway' });
  assert.ok(await until(() => ed.posted.find((m) => m.type === 'done')));
});

test('empty and non-RTF files give a notice, not a crash', async () => {
  const fake = fakeVscode();
  const ext = load(fake);
  for (const [f, title] of [['empty.rtf', 'This file is empty'], ['not-rtf.rtf', 'This is not an RTF file']]) {
    const ed = openEditor(fake, ext, path.join(S, 'hostile', f));
    ed.send({ type: 'ready' });
    const e = await until(() => ed.posted.find((m) => m.type === 'error'));
    assert.equal(e.title, title);
    assert.equal(e.notice, true);
  }
});

test('links: only http, https and mailto reach openExternal', async () => {
  const fake = fakeVscode();
  const ext = load(fake);
  const ed = openEditor(fake, ext, path.join(S, 'welcome.rtf'));
  await ed.send({ type: 'openLink', url: 'javascript:alert(1)' });
  await ed.send({ type: 'openLink', url: 'file:///etc/passwd' });
  await ed.send({ type: 'openLink', url: 'command:workbench.action.terminal.new' });
  assert.equal(fake.shown.external.length, 0);
  assert.equal(fake.shown.warn.length, 3);
  await ed.send({ type: 'openLink', url: 'https://example.org/x' });
  assert.equal(fake.shown.external.length, 1);
  assert.match(fake.shown.external[0], /^https:.*example\.org\/x$/);
});

test('copy text, Open as Text and saved preferences', async () => {
  const fake = fakeVscode();
  const ext = load(fake);
  const ed = openEditor(fake, ext, path.join(S, 'welcome.rtf'));
  await ed.send({ type: 'copyText', text: 'hello' });
  assert.equal(fake.shown.clipboard, 'hello');
  await ed.send({ type: 'openAsText' });
  assert.equal(fake.shown.executed.at(-1)[0], 'vscode.openWith');
  assert.equal(fake.shown.executed.at(-1)[2], 'default');
  await ed.send({ type: 'prefs', prefs: { theme: 'invert', zoom: 1.5 } });
  assert.deepEqual(ed.ctx.globalState.get('rtfViewer.prefs'), { theme: 'invert', zoom: 1.5 });
});
