'use strict';
// RTF Viewer: a read-only custom editor for .rtf files. The file is parsed in a worker thread (src/worker.js,
// src/core/rtf.js) and drawn in a webview with a strict CSP: no network, scripts by nonce only, pictures from
// blob: and data: URLs made in the webview. Links open only through vscode.env.openExternal after a click, and
// only for http, https and mailto.
const vscode = require('vscode');
const path = require('path');
const { Worker } = require('worker_threads');
const { buildHtml } = require('./webview-html');
const { safeLink } = require('./core/rtf');
const { registerSupport, commandUris, showLinks } = require('./support');
const { createRatingPrompt } = require('./rate');

const EXT_ID = 'zovo.zovo-rtf-viewer';
const SECTION = 'rtfViewer';
const VIEW_TYPE = 'rtfViewer.preview';
let rating = { success() {}, failure() {} };

const cfg = () => vscode.workspace.getConfiguration(SECTION);

class RtfEditor {
  constructor(context, doc, panel, provider) {
    this.context = context; this.uri = doc.uri; this.panel = panel; this.provider = provider;
    this.gen = 0; this.worker = null; this.allowLarge = false; this.counted = false; this.disposed = false;
    this.subs = [];
    const wv = panel.webview;
    wv.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')], enableCommandUris: commandUris(SECTION) };
    const prefs = context.globalState.get('rtfViewer.prefs', {});
    wv.html = buildHtml({
      webview: wv, extensionUri: context.extensionUri, title: path.basename(this.uri.path),
      showSupportLinks: showLinks(vscode, SECTION),
      prefs: { theme: prefs.theme || cfg().get('theme', 'auto'), view: prefs.view || cfg().get('view', 'page'), zoom: prefs.zoom || cfg().get('zoom', 1), zoomSaved: !!prefs.zoom || cfg().get('zoom', 1) !== 1, outline: prefs.outline }
    });
    this.subs.push(wv.onDidReceiveMessage((m) => this.onMessage(m)));
    this.subs.push(panel.onDidChangeViewState(() => { if (panel.active) provider.active = this; }));
    panel.onDidDispose(() => this.dispose());
    provider.active = this;
    this.watch();
  }
  watch() {
    if (!cfg().get('liveReload', true)) return;
    try {
      const dir = vscode.Uri.joinPath(this.uri, '..');
      const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dir, path.posix.basename(this.uri.path)));
      const again = () => { clearTimeout(this.t); this.t = setTimeout(() => this.load(true), 350); };
      this.subs.push(w, w.onDidChange(again), w.onDidCreate(again), w.onDidDelete(() => this.post({ type: 'deleted' })));
    } catch (_) { /* no watcher on this file system */ }
  }
  post(m) { if (!this.disposed) return this.panel.webview.postMessage(Object.assign({ gen: this.gen }, m)); }
  /** A file that could not be read (or was too large to open) records a failure for the rating rule, once (VER11). */
  failed() { if (!this.counted) { this.counted = true; rating.failure(); } }
  async load(reload) {
    const gen = ++this.gen;
    if (this.worker) { this.worker.terminate(); this.worker = null; }
    let size = 0;
    try { size = (await vscode.workspace.fs.stat(this.uri)).size; } catch (e) {
      this.post({ type: 'start', size: 0, name: path.posix.basename(this.uri.path) });
      this.post({ type: 'error', title: 'The file could not be read', detail: String(e.message || e) });
      this.failed();
      return;
    }
    if (gen !== this.gen) return;
    const maxMB = cfg().get('maxFileSizeMB', 200);
    if (size > maxMB * 1048576 && !this.allowLarge) { this.post({ type: 'tooLarge', size, maxMB, name: path.posix.basename(this.uri.path) }); this.failed(); return; }
    this.post({ type: 'start', size, reload: !!reload, name: path.posix.basename(this.uri.path) });
    const data = { maxImageBytes: Math.round(cfg().get('maxImageSizeMB', 20) * 1048576) };
    if (this.uri.scheme === 'file') data.path = this.uri.fsPath;
    else {
      try { data.bytes = await vscode.workspace.fs.readFile(this.uri); } catch (e) { this.post({ type: 'error', title: 'The file could not be read', detail: String(e.message || e) }); this.failed(); return; }
      if (gen !== this.gen) return;
    }
    const w = new Worker(path.join(__dirname, 'worker.js'), { workerData: data, resourceLimits: { maxOldGenerationSizeMb: 2048 } });
    this.worker = w;
    const t0 = Date.now();
    w.on('message', (m) => {
      if (gen !== this.gen) return;
      if (m.type === 'chunk') {
        this.post({ type: 'chunk', seq: m.seq, html: m.html, images: m.images, pos: m.pos, total: m.total, page: m.page, fontCss: m.fontCss });
      } else if (m.type === 'progress') {
        this.post({ type: 'progress', pos: m.pos, total: m.total });
      } else if (m.type === 'done') {
        this.worker = null;
        this.post({ type: 'done', res: m.res, ms: Date.now() - t0, parseMs: m.parseMs, size: m.size });
      } else if (m.type === 'error') {
        this.worker = null;
        const notice = m.code === 'EMPTY' || m.code === 'NOTRTF';
        this.post({ type: 'error', title: m.code === 'EMPTY' ? 'This file is empty' : notice ? 'This is not an RTF file' : 'The file could not be shown', detail: m.message, notice });
        if (!notice && !this.counted) { this.counted = true; rating.failure(); }
      }
    });
    w.on('error', (e) => {
      if (gen !== this.gen) return;
      this.post({ type: 'error', title: 'The file could not be shown', detail: String(e.message || e).slice(0, 300) });
      if (!this.counted) { this.counted = true; rating.failure(); }
    });
  }
  async onMessage(m) {
    switch (m && m.type) {
      case 'ready': this.load(false); break;
      case 'rendered': if (m.gen === this.gen && !this.counted) { this.counted = true; rating.success(this.uri); } break;
      case 'openAnyway': this.allowLarge = true; this.load(false); break;
      case 'openLink': {
        const l = safeLink(m.url);
        if (!l.ok) { vscode.window.showWarningMessage('RTF Viewer did not open this link: ' + (l.scheme ? l.scheme + ': links are blocked.' : 'it is not a web or mail address.')); break; }
        vscode.env.openExternal(vscode.Uri.parse(l.url, true));
        break;
      }
      case 'openAsText': openAsText(this.uri); break;
      case 'copyText': await vscode.env.clipboard.writeText(String(m.text || '')); vscode.window.setStatusBarMessage('RTF Viewer: copied ' + String(m.text || '').length.toLocaleString() + ' characters', 3000); break;
      case 'exportHtml': await this.saveHtml(String(m.html || '')); break;
      case 'prefs': {
        const p = Object.assign({}, this.context.globalState.get('rtfViewer.prefs', {}), m.prefs || {});
        this.context.globalState.update('rtfViewer.prefs', p);
        break;
      }
      default: break;
    }
  }
  async saveHtml(html) {
    const base = this.uri.path.replace(/\.rtf$/i, '') + '.html';
    const target = await vscode.window.showSaveDialog({ defaultUri: this.uri.with({ path: base }), filters: { HTML: ['html', 'htm'] }, saveLabel: 'Export' });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(html, 'utf8'));
    const open = await vscode.window.showInformationMessage('Saved ' + path.posix.basename(target.path), 'Open Folder');
    if (open) vscode.commands.executeCommand('revealFileInOS', target);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.worker) this.worker.terminate();
    clearTimeout(this.t);
    for (const s of this.subs) { try { s.dispose(); } catch (_) {} }
    if (this.provider.active === this) this.provider.active = null;
    this.provider.editors.delete(this);
  }
}

class Provider {
  constructor(context) { this.context = context; this.active = null; this.editors = new Set(); }
  openCustomDocument(uri) { return { uri, dispose() {} }; }
  resolveCustomEditor(doc, panel) { const e = new RtfEditor(this.context, doc, panel, this); this.editors.add(e); }
}

function openAsText(uri) { return vscode.commands.executeCommand('vscode.openWith', uri, 'default'); }

function targetUri(provider, arg) {
  if (arg instanceof vscode.Uri) return arg;
  if (provider.active) return provider.active.uri;
  const ed = vscode.window.activeTextEditor;
  return ed && /\.rtf$/i.test(ed.document.uri.path) ? ed.document.uri : null;
}

function activate(context) {
  const provider = new Provider(context);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { supportsMultipleEditorsPerDocument: true, webviewOptions: { retainContextWhenHidden: true, enableFindWidget: false } }));
  const send = (type) => { if (provider.active) provider.active.post({ type }); };
  const reg = (id, fn) => context.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('rtfViewer.find', () => send('find'));
  reg('rtfViewer.copyText', () => send('copyText'));
  reg('rtfViewer.exportHtml', () => send('exportHtml'));
  reg('rtfViewer.openAsText', (arg) => { const u = targetUri(provider, arg); if (u) openAsText(u); });
  reg('rtfViewer.openPreview', (arg) => { const u = targetUri(provider, arg); if (u) vscode.commands.executeCommand('vscode.openWith', u, VIEW_TYPE); });
  reg('rtfViewer.openSample', () => vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'samples', 'welcome.rtf'), VIEW_TYPE));
  reg('rtfViewer.openWalkthrough', () => vscode.commands.executeCommand('workbench.action.openWalkthrough', EXT_ID + '#rtfViewer.start', false));
  registerSupport({ vscode, context, prefix: SECTION, selfId: EXT_ID });
  rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: SECTION, name: 'RTF Viewer' });
  return { provider };
}

function deactivate() {}

module.exports = { activate, deactivate };
