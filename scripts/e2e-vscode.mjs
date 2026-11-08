// Release gate in a real VS Code. Installs the .vsix into an isolated profile, opens every sample and real RTF file
// with real clicks and keys, checks what the webview shows (text, tables, pictures, headers, outline, search, zoom,
// page colors), edits a file on disk to check live reload, opens the 400-page and 52 MB files, checks the hostile
// files, logs every network request of the webviews, and writes screenshots and JSON.
// usage: node scripts/e2e-vscode.mjs <work> <port> <vsix> <samplesDir> <largeDir> <realDir> <shotDir> <outJson> [theme]
import { launch, installVsix, sleep } from './vsc.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [work0, port, vsix, samples0, large0, real0, shotDir, outJson, theme] = process.argv.slice(2);
const work = path.resolve(work0);
const R = { theme: theme || 'Default Dark Modern', vsixSha256: crypto.createHash('sha256').update(fs.readFileSync(vsix)).digest('hex'), steps: [], timings: {}, network: { outside: [], all: 0 }, extHostMB: [], files: [] };
const tag = /Light/.test(R.theme) ? 'light' : 'dark';
const ws = path.join(work, 'ws');
fs.rmSync(ws, { recursive: true, force: true });
fs.cpSync(samples0, ws, { recursive: true });
fs.mkdirSync(path.join(ws, 'large'), { recursive: true });
for (const f of fs.readdirSync(large0)) fs.symlinkSync(path.resolve(large0, f), path.join(ws, 'large', f));
if (real0 && fs.existsSync(real0)) fs.cpSync(real0, path.join(ws, 'real'), { recursive: true });
const clipBefore = (() => { try { return execFileSync('pbpaste', { encoding: 'utf8' }); } catch { return ''; } })();
const getClip = () => execFileSync('pbpaste', { encoding: 'utf8' });

fs.rmSync(path.join(work, 'ud'), { recursive: true, force: true });
fs.rmSync(path.join(work, 'ext'), { recursive: true, force: true });
R.install = installVsix(work, vsix);
const vs = await launch(work, Number(port), ws, {
  'workbench.colorTheme': R.theme, 'workbench.secondarySideBar.defaultVisibility': 'hidden', 'workbench.auxiliaryBar.visible': false,
  'window.titleBarStyle': 'custom', 'files.simpleDialog.enable': true, 'window.dialogStyle': 'custom', 'workbench.editor.enablePreview': false,
  'editor.minimap.enabled': false, 'workbench.editorLargeFileConfirmation': 1024, 'explorer.autoReveal': false,
});

const reqs = new Map();
const LOCAL = /^(vscode-webview|vscode-resource|vscode-file|data|blob|about|chrome-error|devtools):|^https:\/\/[^/]*\.vscode-(cdn|resource)\.net\//;
vs.network = true;
vs.s.on(m => {
  const info = m.sessionId && vs.attached.get(m.sessionId);
  if (m.method === 'Network.requestWillBeSent' && info && m.sessionId !== vs.wb && !/^vscode-file:/.test(info.url || '')) {
    R.network.all++;
    const u = m.params.request.url;
    if (!LOCAL.test(u)) reqs.set(m.sessionId + m.params.requestId, { url: u.slice(0, 200), frame: (info.url || '').slice(0, 60), type: info.type });
  }
  if (m.method === 'Network.loadingFailed' && m.params.blockedReason) { const k = m.sessionId + m.params.requestId; if (reqs.has(k)) reqs.get(k).blocked = m.params.blockedReason; }
});

const shots = [];
const NOSHOT = !!process.env.GATE_NOSHOT;
const shot = async name => { if (NOSHOT) return name; const f = path.join(shotDir, `${tag}-${String(shots.length + 1).padStart(2, '0')}-${name}.png`); await vs.shot(f); shots.push(path.basename(f)); return f; };
const step = async (name, fn) => {
  const t0 = Date.now();
  try { const v = await fn(); R.steps.push({ name, ok: v !== false, value: v, ms: Date.now() - t0 }); console.log(v === false ? 'FAIL' : 'PASS', name, JSON.stringify(v).slice(0, 300)); }
  catch (e) { R.steps.push({ name, ok: false, error: String(e.message || e).slice(0, 1500), ms: Date.now() - t0 }); console.log('FAIL', name, String(e.message || e).slice(0, 500)); try { await shot('FAIL-' + name.replace(/\W+/g, '_').slice(0, 40)); } catch {} }
};
const must = (c, msg) => { if (!c) throw new Error(msg); };
const extHostRss = () => {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,rss=,command='], { encoding: 'utf8', maxBuffer: 1 << 26 });
    let best = 0;
    for (const ln of out.split('\n')) if (ln.includes(vs.ud) && /extensionHost|Code Helper \(Plugin\)|utility-sub-type=node.mojom.NodeService/.test(ln)) best = Math.max(best, Number(ln.trim().split(/\s+/)[1]) || 0);
    return Math.round(best / 1024);
  } catch { return -1; }
};

// The visible RTF Viewer webview showing <name>.
async function viewer(name, ms = 20000) {
  return vs.waitFor(async () => {
    for (const w of await vs.webviews()) {
      try { const p = JSON.parse(await vs.wvEval(w, 'JSON.stringify(window.rtfViewerProbe ? window.rtfViewerProbe() : null)')); if (p && p.visible === 'visible' && (!name || p.name === name) && w.w > 0) return w; } catch {}
    }
    return null;
  }, ms, 150);
}
let cur = null;
const E = async expr => vs.wvEval(cur, expr);
const probe = async () => JSON.parse(await E('JSON.stringify(window.rtfViewerProbe())'));
async function openRtf(rel, { wait = 'rendered', ms = 30000 } = {}) {
  const name = path.basename(rel);
  const t0 = Date.now();
  vs.open(path.join(ws, rel));
  cur = await viewer(name, ms);
  must(cur, 'no RTF Viewer webview for ' + rel);
  if (wait === 'rendered') must(await vs.waitFor(async () => (await probe()).rendered > 0, ms, 100), 'not rendered: ' + rel + ' ' + JSON.stringify(await probe()));
  if (wait === 'error') must(await vs.waitFor(async () => (await probe()).error || (await probe()).tooLarge, ms, 100), 'no error shown for ' + rel);
  return { p: await probe(), ms: Date.now() - t0 };
}
// Closing editors keeps memory low; the viewer() lookup does not need it (hidden webviews report 'hidden').
async function closeAll() {
  for (let i = 0; i < 2; i++) {
    try { await vs.key('Escape', 'Escape'); await vs.command('View: Close All Editors'); await sleep(500); return; }
    catch (e) { R.closeAllRetries = (R.closeAllRetries || 0) + 1; await vs.click(700, 20); await sleep(400); }
  }
}
async function click(selector) { await vs.wvClick(cur, `document.querySelector(${JSON.stringify(selector)})`); await sleep(250); }
async function setSelect(id, value) { await E(`(() => { const s = document.getElementById(${JSON.stringify(id)}); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); return s.value; })()`); await sleep(300); }
const picsOk = () => E(`JSON.stringify([...document.querySelectorAll('#paper img.pic')].map(i => ({ kind: i.dataset.kind, w: i.naturalWidth, src: i.src.slice(0, 5) })))`).then(JSON.parse);
const waitPics = async (n, ms = 15000) => vs.waitFor(async () => { const p = await picsOk(); return p.filter(x => x.w > 0).length >= n ? p : null; }, ms, 200);

await sleep(2500);

// 1. Install and the welcome report: page view, outline, table, picture, header, footnote, links.
await step('install + welcome.rtf opens in RTF Viewer', async () => {
  must(R.install.code === 0, 'install failed: ' + R.install.out.slice(0, 300));
  const { p, ms } = await openRtf('welcome.rtf');
  const v = JSON.parse(await E(`JSON.stringify({ tables: document.querySelectorAll('#docbody table.t').length, headers: document.querySelectorAll('.hf.hdr').length, footers: document.querySelectorAll('.hf.ftr').length,
    pageNums: [...document.querySelectorAll('.hf.ftr')].map(f => f.textContent.trim()), fn: !!document.querySelector('#fns .fnote'), links: document.querySelectorAll('a.lnk[data-href]').length, anyHref: document.querySelectorAll('#paper a[href]').length,
    footer: !!document.querySelector('#zovo-support a[href^="command:rtfViewer.supportDeveloper"]') && /More free viewers/.test(document.getElementById('zovo-support').textContent),
    paperW: Math.round(document.getElementById('paper').getBoundingClientRect().width), bold: getComputedStyle([...document.querySelectorAll('#docbody span')].find(s => s.textContent === 'bold')).fontWeight })`));
  must(v.tables === 1 && v.headers === 2 && v.footers === 2, 'parts ' + JSON.stringify(v));
  must(v.pageNums[0].includes('Page 1 of 2') && v.pageNums[1].includes('Page 2 of 2'), 'page numbers ' + v.pageNums);
  must(v.fn && v.links === 2 && v.anyHref === 0 && v.footer, JSON.stringify(v));
  must(p.outline >= 5, 'outline ' + p.outline);
  const pics = await waitPics(1);
  must(pics, 'chart picture not drawn');
  R.timings.welcomeMs = ms;
  await sleep(400);
  await shot('welcome-page-view');
  return { ms, outline: p.outline, ...v };
});

// 2. Toolbar: search, outline jump, zoom, page colors, flow view.
await step('search with Enter / Shift+Enter, outline jump, zoom, view and page colors', async () => {
  await click('#q');
  await vs.type('inspection');
  await vs.key('Enter', 'Enter');
  let p = await vs.waitFor(async () => { const q = await probe(); return q.hits > 0 ? q : null; }, 5000);
  must(p && p.hits >= 3, 'hits ' + (p && p.hits));
  const first = p.hitIdx;
  await vs.key('Enter', 'Enter'); p = await probe();
  must(p.hitIdx === first + 1, 'Enter did not move to the next match');
  await vs.key('Enter', 'Enter', 8); p = await probe();
  must(p.hitIdx === first, 'Shift+Enter did not move back');
  const hitsText = await E(`document.getElementById('hits').textContent`);
  await shot('search-hits');
  await vs.key('Escape', 'Escape');
  await click('#outline a:last-of-type');
  await sleep(500);
  const top = Number(await E(`(() => { const a = [...document.querySelectorAll('#outline a')].pop(); const h = a && document.getElementById(a.dataset.target); return h ? Math.round(h.getBoundingClientRect().top) : -1; })()`));
  must(top >= 0 && top < 300, 'outline jump: heading at ' + top);
  const z0 = (await probe()).zoom;
  await click('#zin'); await click('#zin');
  p = await probe();
  must(Math.abs(p.zoom - Math.round(Math.round(z0 * 1.1 * 100) / 100 * 1.1 * 100) / 100) < 0.02, 'zoom ' + z0 + ' -> ' + p.zoom);
  await click('#zval');
  must((await probe()).zoom === 1, 'reset zoom');
  const colors = {};
  for (const t of ['light', 'dark', 'invert', 'auto']) {
    await setSelect('theme', t);
    colors[t] = JSON.parse(await E(`JSON.stringify({ bg: getComputedStyle(document.getElementById('paper')).backgroundColor, fg: getComputedStyle(document.getElementById('paper')).color, filter: getComputedStyle(document.getElementById('paper')).filter, eff: window.rtfViewerProbe().theme })`));
    if (t === 'dark' || t === 'invert') await shot('theme-' + t);
  }
  must(colors.light.bg === 'rgb(255, 255, 255)' && colors.light.fg === 'rgb(0, 0, 0)', 'light ' + JSON.stringify(colors.light));
  must(colors.dark.bg !== 'rgb(255, 255, 255)', 'dark ' + JSON.stringify(colors.dark));
  must(/invert/.test(colors.invert.filter), 'invert ' + JSON.stringify(colors.invert));
  must(colors.auto.eff === (tag === 'light' ? 'light' : 'dark'), 'auto follows the theme: ' + colors.auto.eff);
  await setSelect('view', 'flow');
  const flowW = Number(await E(`Math.round(document.getElementById('paper').getBoundingClientRect().width)`));
  await setSelect('view', 'page');
  return { hits: p.hits, hitsText, colors, flowW };
});

// 3. Every sample and real file: text, tables, pictures, notes.
const FILES = [
  ['clinical-ae.rtf', async (p) => { const v = JSON.parse(await E(`JSON.stringify({ t: document.querySelectorAll('table.t').length, hdrRows: document.querySelectorAll('tr.hdr').length, span: !!document.querySelector('td[colspan="4"]'), pages: document.querySelectorAll('.pb').length, hdr: [...document.querySelectorAll('.hf.hdr')].map(h => h.textContent.replace(/\\s+/g, ' ').trim().slice(-12)), w: Math.round(document.getElementById('paper').getBoundingClientRect().width) })`)); must(v.t >= 2 && v.span && v.pages >= 1 && v.hdr.length >= 2 && /Page 2 of 2/.test(v.hdr[1]) && v.w > 1000, JSON.stringify(v)); return v; }],
  ['clinical-demographics.rtf', async () => { const v = JSON.parse(await E(`JSON.stringify({ cells: document.querySelectorAll('td').length, mean: document.body.innerText.includes('75.2 (8.59)'), centered: getComputedStyle(document.querySelector('table.t')).marginLeft !== '0px' })`)); must(v.mean && v.cells > 50, JSON.stringify(v)); return v; }],
  ['clinical-lab-shift.rtf', async () => { const n = Number(await E(`document.querySelectorAll('td[rowspan="3"]').length`)); must(n === 4, 'rowspan cells ' + n); return { rowspan3: n }; }],
  ['cjk-languages.rtf', async () => { const t = await E('document.getElementById("docbody").innerText'); for (const s of ['日本語のテキスト', '简体中文文本', '繁體中文文字', '한국어 텍스트', 'Русский текст', 'Ελληνικό']) must(t.includes(s), 'missing ' + s); return { ok: true }; }],
  ['textedit-letter.rtf', async (p) => { const v = JSON.parse(await E(`JSON.stringify({ red: [...document.querySelectorAll('#docbody span')].some(s => /rgb\\(19[0-9], 0, 0\\)|rgb\\(204, 0, 0\\)/.test(getComputedStyle(s).color)), bullets: (document.body.innerText.match(/•/g) || []).length, right: [...document.querySelectorAll('#docbody p')].some(x => x.style.textAlign === 'right') })`)); must(v.bullets >= 3 && v.right, JSON.stringify(v)); return v; }],
  ['textedit-table.rtf', async () => { const v = JSON.parse(await E(`JSON.stringify({ t: document.querySelectorAll('table.t').length, cs: !!document.querySelector('td[colspan]'), text: document.body.innerText.includes('Workshop (two days)') })`)); must(v.t === 1 && v.text, JSON.stringify(v)); return v; }],
  ['wordpad-notes.rtf', async () => { const pics = await waitPics(1); const t = await E('document.getElementById("docbody").innerText'); must(pics && t.includes('Naïve café menü') && t.includes('€'), 'wordpad ' + t.slice(0, 200)); return { pics: pics.length }; }],
  ['pictures.rtf', async () => { const pics = await waitPics(6); must(pics, 'pictures not drawn: ' + JSON.stringify(await picsOk())); const kinds = [...new Set(pics.filter(x => x.w > 0).map(x => x.kind))]; for (const k of ['png', 'jpeg', 'emf', 'wmf', 'bmp']) must(kinds.includes(k), 'kind ' + k); const box = await E(`document.querySelectorAll('.ph').length`); must(box === 1, 'PICT box ' + box); await shot('pictures'); return { kinds, boxes: box }; }],
];
if (fs.existsSync(path.join(ws, 'real'))) for (const f of fs.readdirSync(path.join(ws, 'real')).sort()) FILES.push(['real/' + f, async (p) => { const n = Number(await E('document.getElementById("docbody").innerText.length')); must(n > 500, 'text length ' + n); return { textLen: n, outline: p.outline, notes: p.notes.slice(0, 80) }; }]);
for (const [rel, check] of FILES) {
  await step('file: ' + rel, async () => {
    await closeAll();
    const { p, ms } = await openRtf(rel);
    const exc = vs.console.filter(c => /vscode-webview/.test(c.where) && c.type === 'exception');
    must(!exc.length, 'webview exception: ' + JSON.stringify(exc[0]));
    const v = await check(p);
    R.files.push({ file: rel, ms, size: p.size, doneMs: p.doneMs, pictures: p.pictures, pictureErrors: p.pictureErrors });
    if (/clinical-ae|cjk|real\/License/.test(rel)) await shot(rel.replace(/\W+/g, '-').replace(/-rtf$/, ''));
    return { ms, doneMs: p.doneMs, ...v };
  });
}

// 4. Live reload: the file changes on disk, the view updates and keeps its place.
await step('live reload when the file changes on disk', async () => {
  await closeAll();
  await openRtf('clinical-ae.rtf');
  await E(`document.getElementById('scroller').scrollTop = 400`);
  await sleep(300);
  const y0 = Number(await E(`document.getElementById('scroller').scrollTop`));
  const g0 = (await probe()).gen;
  const f = path.join(ws, 'clinical-ae.rtf');
  const t0 = Date.now();
  fs.writeFileSync(f, fs.readFileSync(f, 'latin1').replace('Nasopharyngitis', 'Nasopharyngitis (updated run)'), 'latin1');
  const ok = await vs.waitFor(async () => (await E(`document.getElementById('docbody').innerText.includes('Nasopharyngitis (updated run)')`)), 8000, 50);
  must(ok, 'view did not reload');
  const ms = Date.now() - t0;
  const y1 = Number(await E(`document.getElementById('scroller').scrollTop`));
  must(Math.abs(y1 - y0) < 5, 'scroll ' + y0 + ' -> ' + y1);
  R.timings.reloadMs = ms;
  return { ms, scrollBefore: y0, scrollAfter: y1, genBefore: g0, genAfter: (await probe()).gen };
});

// 5. Open as Text and back.
await step('Open as Text shows the RTF source; the editor title button returns to the viewer', async () => {
  await click('#btnText');
  const ok = await vs.waitFor(() => vs.wbEval(`(() => { const t = document.querySelector('.tabs-container .tab.active'); const ed = document.querySelector('.editor-group-container.active .monaco-editor .view-lines'); return !!(t && /clinical-ae\\.rtf/.test(t.textContent) && ed && ed.textContent.includes('rtf1')); })()`), 10000);
  must(ok, 'text editor with RTF source not shown');
  await shot('open-as-text');
  await vs.command('RTF Viewer: Open in RTF Viewer');
  cur = await viewer('clinical-ae.rtf', 10000);
  must(cur, 'back to viewer failed');
  return { ok: true };
});

// 6. Copy text and export HTML.
await step('copy all text to the clipboard', async () => {
  await closeAll();
  await openRtf('welcome.rtf');
  await click('#btnCopy');
  const clip = await vs.waitFor(() => { const c = getClip(); return c.includes('Quarterly field report') && c.includes('Inspections by site') ? c : null; }, 5000);
  must(clip, 'clipboard: ' + getClip().slice(0, 80));
  return { chars: clip.length };
});
await step('export HTML writes one file with pictures inside', async () => {
  const out = path.join(ws, 'welcome.html');
  fs.rmSync(out, { force: true });
  await click('#btnExport');
  const dlg = await vs.waitFor(() => vs.wbEval(`(() => { const w = document.querySelector('.quick-input-widget'); return !!(w && w.style.display !== 'none' && w.offsetParent !== null); })()`), 8000);
  must(dlg, 'save dialog did not open');
  await sleep(500);
  await vs.key('Enter', 'Enter');
  const ok = await vs.waitFor(() => fs.existsSync(out) && fs.statSync(out).size > 1000, 8000);
  must(ok, 'no exported file');
  const html = fs.readFileSync(out, 'utf8');
  must(html.includes('data:image/png;base64') && html.includes('Quarterly field report') && !/<script/i.test(html), 'export content');
  fs.rmSync(out, { force: true });
  await vs.key('Escape', 'Escape');
  return { bytes: html.length };
});

// 7. Large: 400 pages and 52 MB with pictures.
await step('large: 400-page book', async () => {
  await closeAll();
  const before = extHostRss();
  const { p, ms } = await openRtf('large/book-400-pages.rtf', { ms: 60000 });
  must(p.pages === 400, 'pages ' + p.pages);
  must(p.outline === 400, 'outline ' + p.outline);
  await click('#q'); await vs.type('Page 399, paragraph 2'); await vs.key('Enter', 'Enter');
  const h = await vs.waitFor(async () => { const q = await probe(); return q.hits === 1 ? q : null; }, 8000);
  must(h, 'search in a big file');
  R.timings.book = { ms, firstChunkMs: p.firstChunkMs, doneMs: p.doneMs, parseMs: p.parseMs };
  R.extHostMB.push({ at: 'book', before, after: extHostRss() });
  await shot('book-400-search');
  return R.timings.book;
});
await step('large: 52 MB file with 100 pictures, first part shown early', async () => {
  await closeAll();
  const before = extHostRss();
  const t0 = Date.now();
  vs.open(path.join(ws, 'large/large-52mb-pictures.rtf'));
  cur = await viewer('large-52mb-pictures.rtf', 30000);
  must(cur, 'no viewer');
  let sawStatus = '';
  const first = await vs.waitFor(async () => { const q = await probe(); if (q.status) sawStatus = sawStatus || q.status; return q.chunks > 0 ? q : null; }, 60000, 50);
  must(first, 'no first chunk');
  const firstMs = Date.now() - t0;
  const p = await vs.waitFor(async () => { const q = await probe(); if (q.status) sawStatus = sawStatus || q.status; return q.rendered > 0 ? q : null; }, 120000, 200);
  must(p, 'not rendered');
  const pics = await waitPics(100, 60000);
  must(pics, 'pictures drawn ' + (await picsOk()).filter(x => x.w > 0).length);
  const after = extHostRss();
  R.extHostMB.push({ at: '52mb', before, after });
  R.timings.big = { firstVisibleMs: firstMs, doneMs: Date.now() - t0, parseMs: p.parseMs, status: sawStatus, extHostMB: { before, after } };
  await shot('large-52mb');
  return R.timings.big;
});
await step('large: the size limit asks first, and Open anyway works', async () => {
  await closeAll();
  // temporarily set the limit to 10 MB for this check
  const sp = path.join(vs.ud, 'User', 'settings.json');
  const s0 = fs.readFileSync(sp, 'utf8');
  fs.writeFileSync(sp, JSON.stringify(Object.assign(JSON.parse(s0), { 'rtfViewer.maxFileSizeMB': 10 }), null, 1));
  await sleep(1500);
  await openRtf('large/large-52mb-pictures.rtf', { wait: 'error' });
  const st = await E(`document.getElementById('status').innerText`);
  must(/over the 10 MB limit/.test(st), st);
  await shot('large-ask-first');
  await click('#openAnyway');
  must(await vs.waitFor(async () => (await probe()).rendered > 0, 120000, 300), 'Open anyway did not render');
  fs.writeFileSync(sp, s0);
  return { message: st.split('\n')[0] };
});

// 8. Hostile files.
await step('hostile: 100,000-deep nesting', async () => {
  await closeAll();
  const { p, ms } = await openRtf('hostile/deep-nesting.rtf');
  const t = await E('document.getElementById("docbody").innerText');
  must(t.includes('deep text') && t.includes('After the deep part.'), t);
  must(/nested deeper/.test(p.notes), 'note ' + p.notes);
  return { ms, notes: p.notes.slice(0, 120) };
});
await step('hostile: \\bin larger than the file', async () => {
  await closeAll();
  const { p } = await openRtf('hostile/bin-overflow.rtf');
  await sleep(800);
  const v = JSON.parse(await E(`JSON.stringify({ t: document.getElementById('docbody').innerText, ph: document.querySelectorAll('.ph').length, notes: window.rtfViewerProbe().notes })`));
  must(v.t.includes('Text before the picture.') && /\\bin/.test(v.notes) && v.ph === 1, JSON.stringify(v));
  return v;
});
await step('hostile: OLE package object is a box, nothing extracted or run', async () => {
  await closeAll();
  const before = fs.readdirSync(ws).length;
  await openRtf('hostile/ole-object.rtf');
  const box = await E(`(document.querySelector('.obj') || {}).textContent || ''`);
  must(box === 'Embedded object (Package), not opened', box);
  must(fs.readdirSync(ws).length === before, 'a file appeared in the workspace');
  await shot('hostile-ole');
  return { box };
});
await step('hostile: javascript:, data:, file: links and markup stay inert', async () => {
  await closeAll();
  await openRtf('hostile/javascript-link.rtf');
  const v = JSON.parse(await E(`JSON.stringify({ off: document.querySelectorAll('.lnk-off').length, on: document.querySelectorAll('a.lnk[data-href]').length, scripts: document.querySelectorAll('#paper script, #paper iframe, #paper img:not(.pic)').length, pwned: typeof window.pwned })`));
  must(v.off === 5 && v.on === 1 && v.scripts === 0 && v.pwned === 'undefined', JSON.stringify(v));
  const url0 = await E('location.href');
  await vs.wvClick(cur, `document.querySelector('.lnk-off')`);
  await sleep(800);
  const dlg0 = await vs.wbEval(`(() => { const d = document.querySelector('.monaco-dialog-box'); return d && d.offsetParent !== null ? d.textContent.slice(0, 200) : ''; })()`);
  must(!dlg0, 'a dialog opened for a javascript: link: ' + dlg0);
  must((await E('location.href')) === url0 && (await E('typeof window.pwned')) === 'undefined', 'page navigated or script ran');
  // the web link asks VS Code, which shows its own confirmation; cancel it, so nothing is fetched
  await vs.wvClick(cur, `document.querySelector('a.lnk[data-href]')`);
  const dlg = await vs.waitFor(() => vs.wbEval(`(() => { const d = document.querySelector('.monaco-dialog-box'); return d && d.offsetParent !== null ? d.textContent.slice(0, 200) : ''; })()`), 6000);
  await shot('hostile-links-confirm');
  if (dlg) { await vs.key('Escape', 'Escape'); await sleep(400); }
  must(/example\.org/.test(dlg || ''), 'no confirmation for the web link: ' + dlg);
  return { ...v, webLinkDialog: (dlg || '').slice(0, 120) };
});
await step('hostile: unknown code page, empty file, non-RTF file', async () => {
  await closeAll();
  const a = await openRtf('hostile/bad-codepage.rtf');
  must(/Code page 99999/.test(a.p.notes), a.p.notes);
  await closeAll();
  const b = await openRtf('hostile/empty.rtf', { wait: 'error' });
  const bs = await E(`document.getElementById('status').innerText`);
  must(/This file is empty/.test(bs), bs);
  await shot('hostile-empty');
  await closeAll();
  await openRtf('hostile/not-rtf.rtf', { wait: 'error' });
  const cs = await E(`document.getElementById('status').innerText`);
  must(/not an RTF file/.test(cs) && (await E('typeof window.pwned')) === 'undefined', cs);
  return { codepage: a.p.notes.slice(0, 80), empty: bs.split('\n')[0], notRtf: cs.split('\n')[0] };
});

await step('no webview exceptions, no requests outside the machine', async () => {
  const exc = vs.console.filter(c => /vscode-webview/.test(c.where) && c.type === 'exception');
  must(!exc.length, JSON.stringify(exc.slice(0, 3)));
  const out = [...reqs.values()].filter(r => !r.blocked);
  must(!out.length, 'outside requests: ' + JSON.stringify(out.slice(0, 5)));
  return { exceptions: 0, outside: 0, webviewRequests: R.network.all };
});

R.network.outside = [...reqs.values()];
R.extHostFinalMB = extHostRss();
R.shots = shots;
R.consoleErrors = vs.console.filter(c => /vscode-webview/.test(c.where)).slice(0, 30);
const logs = vs.extHostLogs().filter(f => /exthost\.log$/.test(f));
R.exthostErrors = logs.length ? fs.readFileSync(logs[0], 'utf8').split('\n').filter(l => /rtf|zovo/i.test(l) && /error|fail/i.test(l)).slice(-20) : [];
await vs.close();
try { execFileSync('pbcopy', { input: clipBefore }); } catch {}
R.passed = R.steps.filter(s => s.ok).length; R.total = R.steps.length;
fs.writeFileSync(outJson, JSON.stringify(R, null, 1));
console.log(`${R.passed}/${R.total} passed; outside requests: ${R.network.outside.filter(r => !r.blocked).length}`);
process.exit(R.passed === R.total ? 0 : 1);
