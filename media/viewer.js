// RTF Viewer webview. Receives the document in chunks of escaped HTML from the extension, shows pictures from
// blob: URLs, and gives search, outline, zoom, page colors, copy and export. It never navigates: links are
// data-href attributes that go back to the extension on a click.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const app = $('app'), paper = $('paper'), body = $('docbody'), fns = $('fns'), status = $('status'), scroller = $('scroller');
  const outline = $('outline'), notesEl = $('notes');
  const P = Object.assign({ theme: 'auto', view: 'page', zoom: 1, outline: undefined }, window.RTFV_PREFS || {});
  const MIME = { png: 'image/png', jpeg: 'image/jpeg', bmp: 'image/bmp', gif: 'image/gif' };
  let gen = 0, page = null, urls = [], oldUrls = [], blobOf = new Map(), pendingPics = new Map(), picsLib = null, loaded = false, reloadScroll = null;
  let hits = [], hitIdx = -1, lastQ = '', docName = '';
  let probe = { chunks: 0, firstChunkMs: 0, doneMs: 0, start: 0, pictures: 0, pictureErrors: 0, rendered: 0 };
  window.rtfViewerProbe = () => Object.assign({}, probe, { name: docName, visible: document.visibilityState, gen, theme: effectiveTheme(), view: P.view, zoom: P.zoom, hits: hits.length, hitIdx, outline: outline.querySelectorAll('a').length, outlineOpen: !outline.hidden, notes: notesEl.hidden ? '' : notesEl.textContent, status: status.hidden ? '' : status.textContent, pages: body.querySelectorAll('.pb').length + (body.childElementCount ? 1 : 0), textLen: (body.textContent || '').length });

  // ---------- prefs ----------
  function savePrefs(zoomToo) {
    if (zoomToo) P.zoomSaved = true;
    const prefs = { theme: P.theme, view: P.view, outline: !outline.hidden };
    if (P.zoomSaved) prefs.zoom = P.zoom;
    vscode.postMessage({ type: 'prefs', prefs });
  }
  function effectiveTheme() {
    if (P.theme !== 'auto') return P.theme;
    return document.body.classList.contains('vscode-light') || document.body.classList.contains('vscode-high-contrast-light') ? 'light' : 'dark';
  }
  function applyTheme() {
    app.classList.remove('t-light', 't-dark', 't-invert');
    app.classList.add('t-' + effectiveTheme());
    $('theme').value = P.theme;
    darkColors(paper);
  }
  // Dark page: the document's own colors were picked for white paper. Dark text colors are lightened, light
  // cell and paragraph shading is darkened, and highlighted text gets black letters. Light and Invert restore them.
  function rgb(str) { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(str || ''); return m ? [+m[1], +m[2], +m[3]] : null; }
  function lum(c) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); }
  function mix(a, b, t) { return 'rgb(' + a.map((v, i) => Math.round(v * (1 - t) + b[i] * t)).join(', ') + ')'; }
  function darkColors(root) {
    const dark = effectiveTheme() === 'dark';
    for (const el of root.querySelectorAll('[style*="color"]')) {
      if (!dark) {
        if (el.dataset.fg0 !== undefined) { el.style.color = el.dataset.fg0; delete el.dataset.fg0; }
        if (el.dataset.bg0 !== undefined) { el.style.backgroundColor = el.dataset.bg0; delete el.dataset.bg0; }
        continue;
      }
      if (el.dataset.fg0 !== undefined || el.dataset.bg0 !== undefined) continue;
      const fg = rgb(el.style.color), bg = rgb(el.style.backgroundColor);
      if (bg && lum(bg) > 0.35) {
        if (el.tagName === 'SPAN' || el.tagName === 'A') { el.dataset.fg0 = el.style.color; el.style.color = '#000'; }
        else { el.dataset.bg0 = el.style.backgroundColor; el.style.backgroundColor = mix(bg, [32, 32, 32], 0.72); }
      }
      if (fg && el.dataset.fg0 === undefined && lum(fg) < 0.18 && !(bg && lum(bg) > 0.35)) { el.dataset.fg0 = el.style.color; el.style.color = mix(fg, [255, 255, 255], 0.55); }
    }
  }
  new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  function applyView() {
    app.classList.toggle('v-flow', P.view === 'flow');
    app.classList.toggle('v-page', P.view !== 'flow');
    $('view').value = P.view;
    applyPage();
  }
  function applyZoom() {
    P.zoom = Math.max(0.3, Math.min(4, Math.round(P.zoom * 100) / 100));
    paper.style.zoom = String(P.zoom);
    $('zval').textContent = Math.round(P.zoom * 100) + '%';
  }
  function applyPage() {
    if (!page) return;
    const w = page.w / 15, ml = page.ml / 15, mr = page.mr / 15, mt = Math.min(page.mt, 2880) / 15, mb = Math.min(page.mb, 2880) / 15;
    if (P.view === 'flow') { paper.style.width = ''; paper.style.padding = ''; paper.style.setProperty('--ml', '24px'); paper.style.setProperty('--mr', '24px'); }
    else {
      paper.style.width = Math.max(120, Math.round(w - ml - mr)) + 'px'; // content box: the page minus its margins
      paper.style.padding = Math.round(mt) + 'px ' + Math.round(mr) + 'px ' + Math.round(mb) + 'px ' + Math.round(ml) + 'px';
      paper.style.setProperty('--ml', Math.round(ml) + 'px'); paper.style.setProperty('--mr', Math.round(mr) + 'px');
      paper.style.setProperty('--mt', Math.round(mt) + 'px'); paper.style.setProperty('--mb', Math.round(mb) + 'px');
    }
  }
  // A page wider than the editor is fitted once, unless the user picked a zoom before.
  let fitted = false;
  function autoFit(final) {
    if (fitted || P.zoomSaved || P.view === 'flow' || !page) return;
    if (final) fitted = true;
    const need = page.w / 15 + 48;
    if (need > scroller.clientWidth && scroller.clientWidth > 200) { P.zoom = Math.max(0.3, (scroller.clientWidth - 48) / (page.w / 15)); applyZoom(); }
  }
  function fitWidth() {
    if (!page || P.view === 'flow') { P.zoom = 1; applyZoom(); return; }
    const avail = scroller.clientWidth - 48;
    P.zoom = Math.max(0.3, Math.min(4, avail / (page.w / 15)));
    applyZoom(); savePrefs(true);
  }

  // ---------- toolbar ----------
  $('theme').addEventListener('change', (e) => { P.theme = e.target.value; applyTheme(); savePrefs(); });
  $('view').addEventListener('change', (e) => { P.view = e.target.value; applyView(); savePrefs(); });
  $('zin').addEventListener('click', () => { P.zoom *= 1.1; applyZoom(); savePrefs(true); });
  $('zout').addEventListener('click', () => { P.zoom /= 1.1; applyZoom(); savePrefs(true); });
  $('zval').addEventListener('click', () => { P.zoom = 1; applyZoom(); savePrefs(true); });
  $('zfit').addEventListener('click', fitWidth);
  $('btnOutline').addEventListener('click', () => { setOutline(outline.hidden); savePrefs(); });
  $('btnCopy').addEventListener('click', copyText);
  $('btnExport').addEventListener('click', exportHtml);
  $('btnText').addEventListener('click', () => vscode.postMessage({ type: 'openAsText' }));
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); focusFind(); }
    else if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); P.zoom *= 1.1; applyZoom(); savePrefs(true); }
    else if (mod && e.key === '-') { e.preventDefault(); P.zoom /= 1.1; applyZoom(); savePrefs(true); }
    else if (mod && e.key === '0') { e.preventDefault(); P.zoom = 1; applyZoom(); savePrefs(true); }
    else if (e.key === 'Escape' && document.activeElement === $('q')) { $('q').value = ''; clearHits(); scroller.focus(); }
  });
  function setOutline(on) {
    outline.hidden = !on;
    $('btnOutline').setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  // ---------- links ----------
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    if (a.closest('#zovo-support')) return; // command: links of the footer, handled by VS Code
    e.preventDefault();
    if (a.dataset.href) { vscode.postMessage({ type: 'openLink', url: a.dataset.href }); return; }
    if (a.dataset.fn) { const t = document.getElementById('fn' + a.dataset.fn); if (t) t.scrollIntoView({ block: 'center' }); return; }
    if (a.dataset.target) { const t = document.getElementById(a.dataset.target); if (t) t.scrollIntoView({ block: 'start' }); }
  }, true);

  // ---------- pictures ----------
  function loadPicsLib() {
    if (picsLib) return picsLib;
    picsLib = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = app.dataset.pictures; s.nonce = app.dataset.nonce;
      s.onload = () => (window.DocxPictures ? resolve(window.DocxPictures) : reject(new Error('the picture code did not start')));
      s.onerror = () => reject(new Error('the picture code did not load'));
      document.head.appendChild(s);
    });
    return picsLib;
  }
  function picFailed(img, why) {
    probe.pictureErrors++;
    const span = document.createElement('span');
    span.className = 'ph';
    span.textContent = 'Picture (' + (img.dataset.kind || '').toUpperCase() + ') could not be drawn' + (why ? ': ' + why : '');
    if (img.style.width) span.style.minWidth = Math.min(parseFloat(img.style.width), 600) + 'px';
    img.replaceWith(span);
  }
  function showPicture(img, im) {
    if (!im || !im.bytes) return;
    const done = (blob) => { const u = URL.createObjectURL(blob); urls.push(u); blobOf.set(u, blob); img.onerror = () => picFailed(img, 'the picture data is damaged'); img.src = u; probe.pictures++; };
    if (MIME[im.kind]) { done(new Blob([im.bytes], { type: MIME[im.kind] })); return; }
    if (im.kind === 'emf' || im.kind === 'wmf') {
      loadPicsLib().then((lib) => lib.draw(im.bytes, im.kind)).then(done, (e) => picFailed(img, String((e && e.message) || e).slice(0, 120)));
      return;
    }
    picFailed(img, 'unknown format');
  }

  // ---------- receiving the document ----------
  let target = body; // during a reload, chunks go into a hidden copy and replace the page when done
  function start(m) {
    gen = m.gen; loaded = false; docName = m.name || docName;
    probe = { chunks: 0, firstChunkMs: 0, doneMs: 0, start: Date.now(), pictures: 0, pictureErrors: 0, rendered: 0, size: m.size };
    pendingPics = new Map();
    if (m.reload && body.childElementCount) {
      reloadScroll = scroller.scrollTop;
      oldUrls = oldUrls.concat(urls); urls = [];
      target = document.createElement('div');
    } else {
      for (const u of urls) URL.revokeObjectURL(u);
      urls = []; blobOf = new Map();
      target = body; body.innerHTML = ''; fns.innerHTML = '';
      paper.hidden = true;
      status.hidden = false;
      status.textContent = 'Reading ' + m.name + ' (' + mb(m.size) + ')…';
    }
  }
  function mb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function setFonts(css) {
    let fontStyle = document.getElementById('fontcss');
    if (!fontStyle) { fontStyle = document.createElement('style'); fontStyle.id = 'fontcss'; document.head.appendChild(fontStyle); }
    fontStyle.textContent = css || '';
  }
  function chunk(m) {
    probe.chunks++;
    if (m.page && target === body) { page = m.page; applyPage(); autoFit(); }
    if (m.fontCss !== undefined && target === body) setFonts(m.fontCss);
    if (probe.chunks === 1) probe.firstChunkMs = Date.now() - probe.start;
    const div = document.createElement('div');
    div.className = 'chunk';
    div.innerHTML = m.html;
    for (const im of m.images || []) pendingPics.set(im.id, im);
    for (const img of div.querySelectorAll('img.pic')) { const id = Number(img.dataset.id); showPicture(img, pendingPics.get(id)); pendingPics.delete(id); }
    if (effectiveTheme() === 'dark') darkColors(div);
    target.appendChild(div);
    if (target === body) {
      paper.hidden = false;
      if (m.total > 2 * 1048576) { status.hidden = false; status.textContent = 'Reading… ' + Math.min(99, Math.round((m.pos / m.total) * 100)) + '% (' + mb(m.total) + ')'; }
      else status.hidden = true;
    }
  }
  function done(m) {
    const r = m.res;
    page = r.page;
    setFonts(r.fontCss);
    if (target !== body) {
      for (const u of oldUrls) { URL.revokeObjectURL(u); blobOf.delete(u); }
      oldUrls = [];
      body.replaceChildren(...target.childNodes);
      target = body;
      if (reloadScroll !== null) { scroller.scrollTop = reloadScroll; reloadScroll = null; }
    }
    fns.innerHTML = r.footnotes ? '<div class="fnhead">Footnotes</div>' + r.footnotes : '';
    for (const img of fns.querySelectorAll('img.pic')) { const id = Number(img.dataset.id); showPicture(img, pendingPics.get(id)); }
    addHeaders(r.header, r.footer);
    if (effectiveTheme() === 'dark') { darkColors(fns); for (const h of body.querySelectorAll('.hf')) darkColors(h); }
    paper.hidden = false;
    status.hidden = true;
    applyPage();
    buildOutline();
    autoFit(true);
    showNotes(r.notes || [], r.counts || {});
    if (!body.textContent.trim() && !body.querySelector('img,.ph,.obj')) { status.hidden = false; status.textContent = 'This RTF file has no visible text.'; }
    loaded = true;
    probe.doneMs = Date.now() - probe.start;
    probe.parseMs = m.parseMs;
    probe.counts = r.counts;
    probe.rendered++;
    if (lastQ) runSearch(lastQ, true);
    vscode.postMessage({ type: 'rendered', gen: m.gen, ok: true });
  }
  function addHeaders(header, footer) {
    for (const el of body.querySelectorAll('.hf')) el.remove();
    if (!header && !footer) return;
    const mk = (html, cls) => { const d = document.createElement('div'); d.className = 'hf ' + cls; d.innerHTML = html; return d; };
    const breaks = [...body.querySelectorAll('.pb')];
    if (breaks.length > 2000) { if (header) body.prepend(mk(header, 'hdr')); if (footer) body.append(mk(footer, 'ftr')); numberPages(); return; }
    if (header) { body.prepend(mk(header, 'hdr')); for (const b of breaks) b.after(mk(header, 'hdr')); }
    if (footer) { for (const b of breaks) b.before(mk(footer, 'ftr')); body.append(mk(footer, 'ftr')); }
    numberPages();
  }
  function numberPages() {
    const total = body.querySelectorAll('.pb').length + 1;
    let pageNo = 1;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.classList.contains('pb')) pageNo++;
      else if (n.classList.contains('fld')) n.textContent = n.dataset.f === 'PAGE' ? String(pageNo) : String(total);
    }
  }
  function buildOutline() {
    let hs = [...body.querySelectorAll('[data-o]')];
    let attr = 'o';
    if (!hs.length) { hs = [...body.querySelectorAll('[data-oc]')]; attr = 'oc'; }
    outline.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'ohead';
    head.textContent = hs.length ? 'Outline' : 'No headings in this file';
    outline.appendChild(head);
    for (const h of hs.slice(0, 3000)) {
      const a = document.createElement('a');
      a.textContent = (h.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) || '(empty heading)';
      a.dataset.target = h.id;
      a.style.paddingLeft = (6 + (Math.min(Number(h.dataset[attr]) || 1, 6) - 1) * 12) + 'px';
      a.href = '#';
      outline.appendChild(a);
    }
    $('btnOutline').disabled = false;
    const want = P.outline === undefined ? hs.length >= 3 && scroller.clientWidth > 700 : P.outline;
    setOutline(!!want && hs.length > 0);
  }
  function showNotes(notes, counts) {
    const parts = notes.slice(0, 6);
    if (!parts.length) { notesEl.hidden = true; return; }
    notesEl.innerHTML = '';
    for (const t of parts) { const d = document.createElement('div'); d.textContent = t; notesEl.appendChild(d); }
    const x = document.createElement('button'); x.textContent = 'Hide'; x.title = 'Hide these notes'; x.addEventListener('click', () => { notesEl.hidden = true; });
    notesEl.appendChild(x);
    notesEl.hidden = false;
  }
  function showError(m) {
    status.hidden = false;
    paper.hidden = true;
    status.innerHTML = '';
    const h = document.createElement('div'); h.className = 'etitle'; h.textContent = m.title;
    const d = document.createElement('div'); d.className = 'edetail'; d.textContent = m.detail || '';
    const b = document.createElement('button'); b.textContent = 'Open as Text'; b.addEventListener('click', () => vscode.postMessage({ type: 'openAsText' }));
    status.append(h, d, b);
    probe.error = m.title;
  }
  function showTooLarge(m) {
    status.hidden = false; paper.hidden = true; status.innerHTML = '';
    const h = document.createElement('div'); h.className = 'etitle'; h.textContent = 'This file is ' + mb(m.size) + ', over the ' + m.maxMB + ' MB limit';
    const d = document.createElement('div'); d.className = 'edetail'; d.textContent = 'It may take a while and use a lot of memory. The limit is the setting rtfViewer.maxFileSizeMB.';
    const b = document.createElement('button'); b.textContent = 'Open anyway'; b.id = 'openAnyway'; b.addEventListener('click', () => vscode.postMessage({ type: 'openAnyway' }));
    const t = document.createElement('button'); t.textContent = 'Open as Text'; t.addEventListener('click', () => vscode.postMessage({ type: 'openAsText' }));
    status.append(h, d, b, t);
    probe.tooLarge = true;
  }

  // ---------- search ----------
  const q = $('q');
  function focusFind() { q.focus(); q.select(); }
  function clearHits() {
    for (const m of body.querySelectorAll('mark.hit')) { const t = document.createTextNode(m.textContent); m.replaceWith(t); }
    body.normalize();
    hits = []; hitIdx = -1; $('hits').textContent = '';
  }
  function runSearch(text, keep) {
    clearHits();
    lastQ = text;
    if (!text) return;
    const needle = text.toLowerCase();
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.toLowerCase().includes(needle)) nodes.push(n);
    outer: for (const node of nodes) {
      let n = node;
      for (;;) {
        const i = n.nodeValue.toLowerCase().indexOf(needle);
        if (i < 0) break;
        const after = n.splitText(i);
        n = after.splitText(needle.length);
        const mark = document.createElement('mark');
        mark.className = 'hit';
        after.replaceWith(mark);
        mark.appendChild(after);
        hits.push(mark);
        if (hits.length >= 20000) break outer;
      }
    }
    $('hits').textContent = hits.length ? '' : 'No results';
    if (hits.length) go(keep && hitIdx >= 0 ? hitIdx : 0);
  }
  function go(i) {
    if (!hits.length) return;
    if (hitIdx >= 0 && hits[hitIdx]) hits[hitIdx].classList.remove('cur');
    hitIdx = (i + hits.length) % hits.length;
    const m = hits[hitIdx];
    m.classList.add('cur');
    m.scrollIntoView({ block: 'center', inline: 'nearest' });
    $('hits').textContent = (hitIdx + 1) + ' of ' + hits.length + (hits.length >= 20000 ? '+' : '');
  }
  q.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(qTimer);
    if (q.value !== lastQ || !hits.length) runSearch(q.value);
    else go(hitIdx + (e.shiftKey ? -1 : 1));
  });
  let qTimer = 0;
  q.addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(() => { if (q.value !== lastQ && (q.value.length >= 2 || !q.value)) runSearch(q.value); }, 250); });
  $('next').addEventListener('click', () => (q.value !== lastQ ? runSearch(q.value) : go(hitIdx + 1)));
  $('prev').addEventListener('click', () => (q.value !== lastQ ? runSearch(q.value) : go(hitIdx - 1)));

  // ---------- copy and export ----------
  function plainText() { return (paper.innerText || '').replace(/\n{3,}/g, '\n\n').trim() + '\n'; }
  function copyText() { vscode.postMessage({ type: 'copyText', text: plainText() }); }
  async function toDataUrl(src) {
    const blob = blobOf.get(src); // fetch() of blob: URLs is blocked by the CSP (connect-src 'none')
    if (!blob) return '';
    return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => res(''); r.readAsDataURL(blob); });
  }
  async function exportHtml() {
    const clone = paper.cloneNode(true);
    clone.removeAttribute('hidden');
    clone.style.zoom = '';
    for (const m of clone.querySelectorAll('mark.hit')) m.replaceWith(document.createTextNode(m.textContent));
    for (const img of clone.querySelectorAll('img')) {
      if (img.src.startsWith('blob:')) { const d = await toDataUrl(img.src); if (d) img.src = d; else img.removeAttribute('src'); }
    }
    for (const a of clone.querySelectorAll('a[data-href]')) a.setAttribute('href', a.dataset.href);
    const css = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch (_) { return ''; } }).join('\n');
    const title = document.title || 'Document';
    const html = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>' + title.replace(/[<&]/g, '') + '</title><style>' +
      ':root{--vscode-editor-background:#f3f3f3;--vscode-editor-foreground:#222}body{margin:0;background:#f3f3f3}#app{padding:24px 0}' + css +
      '</style></head><body><div id="app" class="t-light v-' + (P.view === 'flow' ? 'flow' : 'page') + '">' + clone.outerHTML + '</div></body></html>';
    vscode.postMessage({ type: 'exportHtml', html });
  }

  // ---------- messages ----------
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'find') { focusFind(); return; }
    if (m.type === 'copyText') { copyText(); return; }
    if (m.type === 'exportHtml') { exportHtml(); return; }
    if (m.type === 'deleted') { status.hidden = false; status.textContent = 'The file was deleted or moved. The last version stays on screen.'; return; }
    if (m.type === 'tooLarge') gen = m.gen;
    if (m.gen !== undefined && m.type !== 'start' && m.gen !== gen) return;
    switch (m.type) {
      case 'start': start(m); break;
      case 'chunk': chunk(m); break;
      case 'progress': if (target === body && m.total > 2 * 1048576) { status.hidden = false; status.textContent = 'Reading… ' + Math.min(99, Math.round((m.pos / m.total) * 100)) + '% (' + mb(m.total) + ')'; } break;
      case 'done': done(m); break;
      case 'error': showError(m); break;
      case 'tooLarge': docName = m.name || docName; showTooLarge(m); break;
      default: break;
    }
  });

  applyTheme(); applyView(); applyZoom();
  if (P.outline === true) setOutline(true);
  vscode.postMessage({ type: 'ready' });
})();
