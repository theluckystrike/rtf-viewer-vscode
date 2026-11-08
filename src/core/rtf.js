'use strict';
// RTF to HTML, in one pass and without recursion. Pure module: no vscode, no DOM, so the unit tests and the
// worker thread both run it. The output is HTML text where every piece of file text is escaped, plus the raw
// bytes of each picture. Nothing in the file is ever run, fetched or extracted: embedded objects (\object,
// \objdata) become a labelled box, links keep their target in a data attribute that only http, https and
// mailto may use, and the webview never navigates by itself.
//
// Covers what real files use: fonts and code pages (\ansicpg, \fcharset, \uN with \ucN, double-byte text),
// bold, italic, underline, strike, colours, highlight, super/subscript, caps, hidden text, paragraph alignment,
// indents and spacing, list markers (\listtext, \pntext), tables with merged cells, borders, shading and vertical
// alignment, page and section breaks, headers and footers, footnotes, fields (HYPERLINK, PAGE, NUMPAGES), and
// pictures (PNG, JPEG, EMF, WMF, DIB; others become a labelled box).
//
// Hostile files: groups nested deeper than MAX_DEPTH are flattened (no stack growth), a \binN past the end of the
// file stops at the end, unknown code pages fall back to Windows-1252, ignorable destinations are skipped by a
// brace scan, and pictures over the size limits become a labelled box.

const MAX_DEPTH = 1000;
const DEFAULTS = { maxImageBytes: 20 * 1024 * 1024, maxTotalImageBytes: 300 * 1024 * 1024, chunkBytes: 192 * 1024 };

const CHARSET_CP = { 0: 1252, 2: 'symbol', 77: 10000, 78: 932, 79: 949, 80: 936, 81: 950, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258, 177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 254: 437, 255: 437 };
const CP_LABEL = { 874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251', 1252: 'windows-1252', 1253: 'windows-1253', 1254: 'windows-1254', 1255: 'windows-1255', 1256: 'windows-1256', 1257: 'windows-1257', 1258: 'windows-1258', 10000: 'macintosh', 10007: 'x-mac-cyrillic', 20127: 'windows-1252', 20936: 'gbk', 28591: 'iso-8859-1', 28592: 'iso-8859-2', 28595: 'iso-8859-5', 28597: 'iso-8859-7', 28605: 'iso-8859-15', 50220: 'iso-2022-jp', 51932: 'euc-jp', 54936: 'gb18030', 65001: 'utf-8', 437: 'windows-1252', 850: 'windows-1252' };
// Symbol font: Greek letters and a few marks. Wingdings: the bullets Word uses in lists.
const SYMBOL = (() => {
  const m = {};
  const up = 'ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ';
  const lo = 'αβχδεφγηιϕκλμνοπθρστυϖωξψζ';
  for (let i = 0; i < 26; i++) { m[0x41 + i] = up[i]; m[0x61 + i] = lo[i]; }
  Object.assign(m, { 0xb7: '•', 0xa7: '♣', 0xa8: '♦', 0xa9: '♥', 0xaa: '♠', 0xb0: '°', 0xb1: '±', 0xb4: '×', 0xb8: '÷', 0xa3: '≤', 0xb3: '≥', 0xb9: '≠', 0xbb: '≈', 0xa5: '∞', 0xd6: '√', 0xe5: '∑', 0xf2: '∫', 0xae: '→', 0xac: '←', 0xad: '↑', 0xaf: '↓', 0xde: '⇒', 0x6d: 'μ' });
  return m;
})();
const WINGDINGS = { 0xa7: '▪', 0x6c: '●', 0x6e: '■', 0x71: '❑', 0x76: '❖', 0xd8: '➢', 0xfc: '✓', 0xfb: '✗', 0xa8: '◻', 0x9f: '•', 0xe0: '→', 0xf0: '⇨' };

const SKIP_DEST = new Set(['filetbl', 'revtbl', 'rsidtbl', 'generator', 'xmlnstbl', 'mmathPr', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'pgdsctbl', 'bkmkstart', 'bkmkend', 'annotation', 'atnid', 'atnauthor', 'atndate', 'atnref', 'atrfstart', 'atrfend', 'template', 'userprops', 'docvar', 'nonshppict', 'pnseclvl', 'listtable', 'listoverridetable', 'ftnsep', 'ftnsepc', 'aftnsep', 'aftnsepc', 'xe', 'tc', 'tcn', 'blipuid', 'fldtype', 'formfield', 'datafield', 'panose', 'falt', 'wgrffmtfilter', 'defchp', 'defpap', 'pgptbl', 'protusertbl', 'expandedcolortbl', 'shpinst', 'objdata', 'author', 'operator', 'company', 'manager', 'category', 'keywords', 'comment', 'doccomm', 'hlinkbase', 'subject', 'creatim', 'revtim', 'printim', 'buptim', 'pn', 'listpicture', 'background', 'factoidname', 'oldcprops', 'oldpprops', 'oldtprops', 'oldsprops', 'mhtmltag', 'htmltag', 'stylesheet_ignored', 'passwordhash', 'ud_ignored', 'objalias', 'objsect', 'objname', 'bliptag', 'picprop', 'hl', 'hlfr', 'hlsrc', 'leveltext', 'levelnumbers', 'tcelld', 'nesttableprops_ignored', 'colortbl_ignored', 'mmath', 'xform', 'docinfo', 'fchars', 'lchars', 'pgdsc', 'rxe', 'txe', 'bkmkcolf', 'bkmkcoll', 'fontemb', 'fontfile', 'file', 'private', 'pxe']);
const HEADER_DEST = { header: 'header', headerr: 'header', headerl: 'headerl', headerf: 'headerf', footer: 'footer', footerr: 'footer', footerl: 'footerl', footerf: 'footerf' };
const SPECIAL = { emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: '\u2003', enspace: '\u2002', qmspace: '\u2005', zwj: '\u200d', zwnj: '\u200c', ltrmark: '\u200e', rtlmark: '\u200f', zwbo: '\u200b', zwnbo: '\ufeff' };
const UL = new Set(['ul', 'uld', 'uldash', 'uldashd', 'uldashdd', 'uldb', 'ulhwave', 'ulldash', 'ulth', 'ulthd', 'ulthdash', 'ulthdashd', 'ulthdashdd', 'ulthldash', 'ululdbwave', 'ulw', 'ulwave']);

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
// Characters that HTML must not carry (C0 controls except tab and newline, lone surrogates, noncharacters).
function clean(s) {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(^|[^\ud800-\udbff])[\udc00-\udfff]/g, '$1');
}
const px = (tw) => Math.round((tw / 15) * 10) / 10; // twips to CSS pixels (1440 twips = 96 px)

function cssColor(c) { return c ? '#' + ((1 << 24) | (c[0] << 16) | (c[1] << 8) | c[2]).toString(16).slice(1) : ''; }

function safeLink(url) {
  const u = String(url || '').trim();
  if (/^(https?:\/\/|mailto:)/i.test(u) && !/[\s<>"]/.test(u)) return { ok: true, url: u };
  const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(u.replace(/[\u0000-\u0020]+/g, '')) || [])[1];
  return { ok: false, url: u, scheme: scheme ? scheme.toLowerCase() : '' };
}

function newChar() { return { f: -1, fs: 24, b: false, i: false, ul: false, s: false, cf: 0, cb: 0, hl: 0, va: '', caps: false, scaps: false, v: false }; }
function newPar() { return { al: '', li: 0, ri: 0, fi: 0, sb: 0, sa: 0, sl: 0, slm: 0, style: -1, intbl: false, itap: 0, ol: -1, pagebb: false, rtl: false, cbpat: 0 }; }
function newCellDef() { return { right: 0, mgf: false, mrg: false, vmgf: false, vmrg: false, b: {}, pat: 0, va: '' }; }
function newRowDef() { return { cells: [], left: 0, gap: 108, hdr: false, al: '', b: {} }; }

// One output flow: the body, a header, a footer or a footnote. Collects paragraphs and table rows into HTML.
class Flow {
  constructor(p, kind) {
    this.p = p; this.kind = kind; this.out = []; this.size = 0;
    this.runs = []; this.runKey = null; this.runText = ''; this.runFmt = null; this.runLink = null;
    this.parText = ''; this.parAllBold = true; this.parMaxFs = 0; this.parHasPic = false; this.parTextLen = 0;
    this.cellParas = []; this.rowCells = []; this.rows = []; this.rowDef = newRowDef(); this.pendCell = newCellDef();
    this.nestText = [];
  }
  // ---- runs ----
  text(s, st) {
    if (!s) return;
    const c = st.c;
    if (c.v) return; // hidden text
    const key = this.p.fmtKey(c) + (st.link ? '|' + st.link.id : '');
    if (key !== this.runKey) { this.flushRun(); this.runKey = key; this.runFmt = c; this.runLink = st.link; }
    this.runText += s;
    this.parText += s;
    if (/\S/.test(s)) { this.parTextLen += s.length; if (!c.b) this.parAllBold = false; if (c.fs > this.parMaxFs) this.parMaxFs = c.fs; }
  }
  flushRun() {
    if (!this.runText) return;
    const html = this.p.runHtml(this.runText, this.runFmt, this.runLink);
    this.runs.push(html);
    this.runText = '';
    this.runKey = null;
  }
  raw(html, st, isPic) { this.flushRun(); if (st && st.link && !isPic) html = this.p.wrapLink(html, st.link); this.runs.push(html); if (isPic) this.parHasPic = true; }
  // ---- paragraphs ----
  endPar(st, how) {
    this.flushRun();
    const par = st.p;
    const html = this.p.parHtml(this.runs.join(''), par, this);
    const plain = this.parText;
    this.runs = []; this.parText = ''; this.parAllBold = true; this.parMaxFs = 0; this.parHasPic = false; this.parTextLen = 0;
    if (par.intbl && how !== 'force') {
      if (par.itap > 1) { this.nestText.push(html); return; }
      this.cellParas.push(this.nestText.length ? html + '<div class="nest">' + this.nestText.join('') + '</div>' : html);
      this.nestText = [];
      return plain;
    }
    if (this.rows.length || this.rowCells.length) this.flushTable();
    this.push(html);
    return plain;
  }
  hasPending() { return this.runText || this.runs.length; }
  endCell(st, nested) {
    if (nested) { this.flushRun(); const h = this.runs.join(''); this.runs = []; this.parText = ''; this.nestText.push('<span class="nc">' + h + '</span>'); return; }
    if (this.hasPending() || !this.cellParas.length) this.endPar(Object.assign({}, st, { p: Object.assign({}, st.p, { intbl: true, itap: 1 }) }));
    if (this.nestText.length) { this.cellParas.push('<div class="nest">' + this.nestText.join('') + '</div>'); this.nestText = []; }
    this.rowCells.push(this.cellParas.join(''));
    this.cellParas = [];
  }
  endRow(nested) {
    if (nested) { this.nestText.push('<br>'); return; }
    if (this.hasPending()) { this.flushRun(); if (this.runs.length) { this.cellParas.push('<p>' + this.runs.join('') + '</p>'); this.runs = []; } }
    if (this.cellParas.length) { this.rowCells.push(this.cellParas.join('')); this.cellParas = []; }
    const def = this.rowDef;
    this.rows.push({ cells: this.rowCells, def: { cells: def.cells.map((c) => Object.assign({}, c, { b: Object.assign({}, c.b) })), left: def.left, gap: def.gap, hdr: def.hdr, al: def.al, b: Object.assign({}, def.b) } });
    this.rowCells = [];
    if (this.rows.length >= 2000) this.flushTable(true);
  }
  flushTable(more) {
    if (this.rowCells.length || this.cellParas.length) this.endRow();
    if (!this.rows.length) return;
    this.push(this.p.tableHtml(this.rows, !!more, this));
    this.rows = [];
  }
  push(html) {
    this.out.push(html);
    this.size += html.length;
    if (this.kind === 'body') this.p.maybeEmit();
  }
  finish(st) {
    if (this.hasPending()) this.endPar(st, 'force');
    if (this.cellParas.length || this.rowCells.length || this.rows.length) this.flushTable();
    return this.out.join('');
  }
}

class Parser {
  constructor(opts) {
    this.o = Object.assign({}, DEFAULTS, opts || {});
    this.fonts = {}; this.colors = []; this.styles = {}; this.decoders = {};
    this.defCp = 1252; this.defFont = -1; this.uc = 1;
    this.notes = new Set(); this.counts = { objects: 0, pictures: 0, picturesSkipped: 0, links: 0, linksBlocked: 0, headings: 0, tables: 0, pages: 1, depthFlattened: 0 };
    this.images = []; this.imageBytes = 0; this.pendingImages = [];
    this.headers = {}; this.footnotes = []; this.fnCount = 0; this.linkId = 0; this.headingId = 0;
    this.page = { w: 12240, h: 15840, ml: 1800, mr: 1800, mt: 1440, mb: 1440, landscape: false };
    this.title = '';
    this.body = new Flow(this, 'body');
    this.emitted = 0; this.chunkSeq = 0;
  }
  note(s) { if (this.notes.size < 40) this.notes.add(s); }

  // ---- text decoding ----
  cpOfFont(fi) {
    const f = this.fonts[fi];
    if (f) { if (f.cp) return f.cp; if (f.charset !== undefined && f.charset !== 1 && CHARSET_CP[f.charset] !== undefined) return CHARSET_CP[f.charset]; }
    return this.defCp;
  }
  decoder(cp) {
    if (this.decoders[cp]) return this.decoders[cp];
    let label = CP_LABEL[cp];
    let d = null;
    if (label) { try { d = new TextDecoder(label); } catch (_) { d = null; } }
    if (!d) { this.note('Code page ' + cp + ' is not known; its text is read as Windows-1252.'); d = new TextDecoder('windows-1252'); }
    this.decoders[cp] = d;
    return d;
  }
  decodeBytes(str, cp, fontIdx) {
    if (cp === 'symbol') {
      const f = this.fonts[fontIdx];
      const map = f && /wingding|webding/i.test(f.name) ? WINGDINGS : SYMBOL;
      let out = '';
      for (let i = 0; i < str.length; i++) { const b = str.charCodeAt(i); out += map[b] || (b < 0x80 ? str[i] : (map === WINGDINGS ? '•' : String.fromCharCode(b))); }
      return out;
    }
    if (/^[\x00-\x7f]*$/.test(str)) return str;
    const bytes = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i);
    return this.decoder(cp).decode(bytes);
  }

  // ---- formatting to HTML ----
  fmtKey(c) { return c.f + ',' + c.fs + ',' + (c.b ? 1 : 0) + (c.i ? 1 : 0) + (c.ul ? 1 : 0) + (c.s ? 1 : 0) + (c.caps ? 1 : 0) + (c.scaps ? 1 : 0) + ',' + c.cf + ',' + c.cb + ',' + c.hl + ',' + c.va; }
  runHtml(text, c, link) {
    let t = esc(clean(text));
    if (t.indexOf('\t') >= 0) t = t.replace(/\t/g, '<span class="tab">\t</span>');
    const st = [];
    if (c.fs !== this.baseFs) st.push('font-size:' + c.fs / 2 + 'pt');
    if (c.b) st.push('font-weight:bold');
    if (c.i) st.push('font-style:italic');
    if (c.ul || c.s) st.push('text-decoration:' + (c.ul ? 'underline' : '') + (c.ul && c.s ? ' ' : '') + (c.s ? 'line-through' : ''));
    const fg = this.colors[c.cf];
    if (c.cf > 0 && fg && (fg[0] | fg[1] | fg[2])) st.push('color:' + cssColor(fg));
    const bgi = c.hl || c.cb;
    const bg = bgi > 0 && this.colors[bgi];
    if (bg) st.push('background-color:' + cssColor(bg));
    if (c.caps) st.push('text-transform:uppercase');
    if (c.scaps) st.push('font-variant:small-caps');
    const cls = c.f >= 0 && this.fonts[c.f] ? 'f' + c.f : '';
    let html = st.length || cls ? '<span' + (cls ? ' class="' + cls + '"' : '') + (st.length ? ' style="' + st.join(';') + '"' : '') + '>' + t + '</span>' : t;
    if (c.va) html = '<' + c.va + '>' + html + '</' + c.va + '>';
    return link ? this.wrapLink(html, link) : html;
  }
  wrapLink(html, link) {
    if (link.ok) return '<a class="lnk" data-href="' + esc(link.url) + '" title="' + esc(link.url) + '">' + html + '</a>';
    return '<span class="lnk-off" title="' + esc('Link not opened: ' + (link.scheme ? link.scheme + ': links are blocked' : 'the target is not a web or mail address') + ' (' + link.url.slice(0, 120) + ')') + '">' + html + '</span>';
  }
  parHtml(inner, p, flow) {
    const st = [];
    if (p.al) st.push('text-align:' + p.al);
    if (p.li) st.push('margin-left:' + px(p.li) + 'px');
    if (p.ri) st.push('margin-right:' + px(p.ri) + 'px');
    if (p.fi) st.push('text-indent:' + px(p.fi) + 'px');
    if (p.sb) st.push('margin-top:' + px(p.sb) + 'px');
    if (p.sa) st.push('margin-bottom:' + px(p.sa) + 'px');
    if (p.sl) {
      if (p.sl < 0) st.push('line-height:' + Math.abs(p.sl) / 20 + 'pt');
      else if (p.slm) st.push('line-height:' + Math.round((p.sl / 240) * 115) / 100);
      else st.push('min-height:' + p.sl / 20 + 'pt');
    }
    if (p.cbpat && this.colors[p.cbpat]) st.push('background-color:' + cssColor(this.colors[p.cbpat]));
    let attrs = st.length ? ' style="' + st.join(';') + '"' : '';
    if (p.rtl) attrs += ' dir="rtl"';
    let level = -1;
    const sty = this.styles[p.style];
    if (p.ol >= 0 && p.ol < 9) level = p.ol + 1;
    else if (sty && sty.ol >= 0 && sty.ol < 9) level = sty.ol + 1;
    else if (sty && /^heading\s*([1-9])$/i.test(sty.name)) level = Number(/([1-9])$/.exec(sty.name)[1]);
    else if (sty && /^title$/i.test(sty.name)) level = 1;
    const text = flow.parText.replace(/\s+/g, ' ').trim();
    if (flow.kind === 'body' && !p.intbl && text) {
      if (level > 0) { attrs += ' data-o="' + level + '" id="h' + (++this.headingId) + '"'; this.counts.headings++; }
      else if (flow.parAllBold && text.length <= 150 && flow.parMaxFs >= 28) attrs += ' data-oc="' + (flow.parMaxFs >= 36 ? 1 : 2) + '" id="h' + (++this.headingId) + '"';
    }
    const brk = p.pagebb && flow.kind === 'body' ? this.pageBreak() : '';
    return brk + '<p' + attrs + '>' + (inner || '<br>') + '</p>';
  }
  fontCss() {
    const out = [];
    for (const k of Object.keys(this.fonts)) {
      const f = this.fonts[k];
      const name = clean(f.name || '').replace(/[;"\\{}<>]/g, '').trim().slice(0, 64);
      const gen = { roman: 'serif', swiss: 'sans-serif', modern: 'monospace', script: 'cursive', decor: 'fantasy' }[f.family] || (/courier|mono|consol/i.test(name) ? 'monospace' : /times|georgia|garamond|roman|serif|mincho|song|ming/i.test(name) ? 'serif' : 'sans-serif');
      out.push('.doc .f' + k + '{font-family:' + (name && !/^(symbol|wingdings\d?|webdings)$/i.test(name) ? '"' + name + '",' : '') + gen + '}');
    }
    return out.join('\n');
  }
  pageBreak() { this.counts.pages++; return '<div class="pb"></div>'; }
  border(b) {
    if (!b || !b.style || b.style === 'none') return '';
    const w = Math.max(1, Math.round((b.w || 15) / 15));
    const col = b.cf && this.colors[b.cf] && (this.colors[b.cf][0] | this.colors[b.cf][1] | this.colors[b.cf][2]) ? cssColor(this.colors[b.cf]) : 'currentColor';
    const style = b.style === 'double' ? 'double' : b.style === 'dotted' ? 'dotted' : b.style === 'dashed' ? 'dashed' : 'solid';
    return (style === 'double' ? Math.max(3, w) : w) + 'px ' + style + ' ' + col;
  }
  tableHtml(rows, more, flow) {
    if (flow.kind === 'body') this.counts.tables++;
    const bset = new Set();
    for (const r of rows) {
      let l = r.def.left;
      bset.add(l);
      const n = Math.max(r.cells.length, r.def.cells.length);
      for (let i = 0; i < n; i++) {
        const d = r.def.cells[i];
        const right = d && d.right > l ? d.right : l + 1440;
        if (d && !(d.right > l)) d.right = right;
        else if (!d) r.def.cells[i] = Object.assign(newCellDef(), { right });
        bset.add(right);
        l = right;
      }
    }
    const bounds = [...bset].sort((a, b) => a - b);
    const idx = new Map(bounds.map((b, i) => [b, i]));
    const widths = [];
    for (let i = 0; i + 1 < bounds.length; i++) widths.push(px(bounds[i + 1] - bounds[i]));
    const total = widths.reduce((a, b) => a + b, 0);
    const out = [];
    const open = new Map(); // "L:R" -> cell object waiting for vertical merges
    const built = [];
    for (const r of rows) {
      const cells = [];
      let l = r.def.left;
      const seen = new Set();
      for (let i = 0; i < r.def.cells.length; i++) {
        const d = r.def.cells[i];
        const content = r.cells[i] || '';
        const L = l, R = d.right;
        l = R;
        if (d.mrg && cells.length) {
          const prev = cells[cells.length - 1];
          prev.R = R; if (content && content.replace(/<[^>]+>/g, '').trim()) prev.content += content;
          continue;
        }
        cells.push({ L, R, d, content, rowspan: 1, gap: r.def.gap, rb: r.def.b });
      }
      const rowOut = [];
      if (cells.length && cells[0].L > bounds[0]) rowOut.push({ spacer: true, L: bounds[0], R: cells[0].L });
      for (const c of cells) {
        const key = c.L + ':' + c.R;
        seen.add(key);
        if (c.d.vmrg && open.has(key)) { open.get(key).rowspan++; continue; }
        if (c.d.vmgf) open.set(key, c); else open.delete(key);
        rowOut.push(c);
      }
      for (const k of [...open.keys()]) if (!seen.has(k)) open.delete(k);
      built.push({ cells: rowOut, def: r.def });
    }
    out.push('<table class="t' + (more ? ' cont' : '') + '" style="width:' + Math.round(total) + 'px' + (rows[0].def.al === 'center' ? ';margin-left:auto;margin-right:auto' : rows[0].def.left > 0 ? ';margin-left:' + px(rows[0].def.left) + 'px' : '') + '"><colgroup>');
    for (const w of widths) out.push('<col style="width:' + w + 'px">');
    out.push('</colgroup><tbody>');
    for (const r of built) {
      out.push(r.def.hdr ? '<tr class="hdr">' : '<tr>');
      for (const c of r.cells) {
        const span = Math.max(1, (idx.get(c.R) || 0) - (idx.get(c.L) || 0));
        if (c.spacer) { out.push('<td class="sp" colspan="' + span + '"></td>'); continue; }
        const st = [];
        for (const [side, name] of [['t', 'top'], ['l', 'left'], ['b', 'bottom'], ['r', 'right']]) {
          let b = c.d.b[side];
          if (!b && c.rb) b = c.rb[side] || (side === 'l' || side === 'r' ? c.rb.v : c.rb.h);
          const css = this.border(b);
          if (css) st.push('border-' + name + ':' + css);
        }
        if (c.d.pat && this.colors[c.d.pat]) st.push('background-color:' + cssColor(this.colors[c.d.pat]));
        if (c.d.va) st.push('vertical-align:' + c.d.va);
        const pad = px(Math.max(0, Math.min(c.gap, 1440)));
        if (pad !== 7.2) st.push('padding-left:' + pad + 'px;padding-right:' + pad + 'px');
        out.push('<td' + (span > 1 ? ' colspan="' + span + '"' : '') + (c.rowspan > 1 ? ' rowspan="' + c.rowspan + '"' : '') + (st.length ? ' style="' + st.join(';') + '"' : '') + '>' + (c.content || '') + '</td>');
      }
      out.push('</tr>');
    }
    out.push('</tbody></table>');
    return out.join('');
  }

  // ---- pictures ----
  picture(pic, st, flow) {
    this.counts.pictures++;
    let bytes = pic.bin || null;
    if (!bytes) {
      const hex = pic.hex.join('').replace(/[^0-9a-fA-F]/g, '');
      bytes = hexToBytes(hex);
    }
    const kinds = { png: 'png', jpeg: 'jpeg', emf: 'emf', wmf: 'wmf', dib: 'bmp' };
    let kind = kinds[pic.type] || '';
    const label = (pic.type || 'unknown').toUpperCase();
    let wpx = 0, hpx = 0;
    const sx = (pic.sx || 100) / 100, sy = (pic.sy || 100) / 100;
    if (pic.wg > 0 && pic.hg > 0) { wpx = (pic.wg / 15) * sx; hpx = (pic.hg / 15) * sy; }
    else if (pic.w > 0 && pic.h > 0) {
      if (kind === 'emf' || kind === 'wmf') { wpx = (pic.w / 2540) * 96 * sx; hpx = (pic.h / 2540) * 96 * sy; } else { wpx = pic.w * sx; hpx = pic.h * sy; }
    }
    wpx = Math.round(Math.min(wpx, 4000)); hpx = Math.round(Math.min(hpx, 8000));
    const size = wpx > 0 && hpx > 0 ? ' style="width:' + wpx + 'px;height:' + hpx + 'px"' : '';
    const box = (why) => { this.counts.picturesSkipped++; flow.raw('<span class="ph"' + (wpx > 0 ? ' style="min-width:' + Math.min(wpx, 600) + 'px;min-height:' + Math.min(Math.max(hpx, 24), 400) + 'px"' : '') + '>Picture (' + esc(label) + ') ' + esc(why) + '</span>', st, true); };
    if (!kind) return box('in a format the viewer cannot show');
    if (!bytes.length) return box('is empty');
    if (bytes.length > this.o.maxImageBytes) return box('is larger than the ' + Math.round(this.o.maxImageBytes / 1048576) + ' MB picture limit');
    if (this.imageBytes + bytes.length > this.o.maxTotalImageBytes) { this.note('More pictures than the total picture limit; the rest are shown as boxes.'); return box('is over the total picture limit'); }
    if (kind === 'bmp') { bytes = dibToBmp(bytes); if (!bytes) return box('is damaged'); }
    if (kind === 'png' && !(bytes[0] === 0x89 && bytes[1] === 0x50)) kind = sniffKind(bytes) || kind;
    if (kind === 'jpeg' && !(bytes[0] === 0xff && bytes[1] === 0xd8)) kind = sniffKind(bytes) || kind;
    this.imageBytes += bytes.length;
    const id = this.images.length;
    const img = { id, kind, bytes };
    this.images.push(img);
    this.pendingImages.push(img);
    flow.raw('<img class="pic" data-id="' + id + '" data-kind="' + kind + '"' + size + ' alt="Picture ' + (id + 1) + ' (' + label + ')">', st, true);
  }

  // ---- streaming ----
  maybeEmit(force) {
    const b = this.body;
    if (!this.o.onChunk) return;
    if (!force && b.size < this.o.chunkBytes) return;
    if (!b.out.length && !this.pendingImages.length) return;
    const html = b.out.join('');
    b.out = []; b.size = 0;
    const imgs = this.pendingImages; this.pendingImages = [];
    const c = { seq: this.chunkSeq++, html, images: imgs, pos: this.getPos ? this.getPos() : 0 };
    if (c.seq === 0) { c.page = Object.assign({}, this.page); c.fontCss = this.fontCss(); }
    this.o.onChunk(c);
    for (const im of imgs) im.bytes = null; // the receiver owns them now
  }
}

function hexToBytes(hex) {
  const n = hex.length >> 1;
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(hex.slice(0, n * 2), 'hex'));
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function sniffKind(b) {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  return '';
}
// A DIB (BITMAPINFOHEADER + pixels) becomes a .bmp by adding the 14-byte file header.
function dibToBmp(d) {
  if (d.length < 40) return null;
  const hs = d[0] | (d[1] << 8) | (d[2] << 16) | (d[3] << 24);
  if (hs < 12 || hs > 256 || hs > d.length) return null;
  const bits = d[14] | (d[15] << 8);
  let colors = d.length >= 36 ? d[32] | (d[33] << 8) | (d[34] << 16) | (d[35] << 24) : 0;
  if (!colors && bits <= 8) colors = 1 << bits;
  const off = 14 + hs + colors * 4 + ((d[16] | (d[17] << 8)) === 3 && hs === 40 ? 12 : 0);
  const out = new Uint8Array(d.length + 14);
  const size = out.length;
  out[0] = 0x42; out[1] = 0x4d;
  out[2] = size & 255; out[3] = (size >> 8) & 255; out[4] = (size >> 16) & 255; out[5] = (size >>> 24) & 255;
  out[10] = off & 255; out[11] = (off >> 8) & 255; out[12] = (off >> 16) & 255;
  out.set(d, 14);
  return out;
}

// Finds the matching '}' for the group that starts at s[i] === '{', honouring \{ \} \\ and \binN. Returns the
// index of that '}' or s.length when the file ends first. Used for ignorable destinations and \objdata.
function skipGroup(s, i, depth0) {
  let depth = depth0 || 1;
  const n = s.length;
  i++;
  while (i < n) {
    const ch = s.charCodeAt(i);
    if (ch === 0x5c) { // backslash
      const nx = s.charCodeAt(i + 1);
      if (nx === 0x62 && s.startsWith('bin', i + 1)) {
        let j = i + 4, num = '';
        while (j < n && /[-0-9]/.test(s[j]) && num.length < 11) num += s[j++];
        if (s[j] === ' ') j++;
        const len = Math.max(0, parseInt(num || '0', 10) || 0);
        i = Math.min(n, j + len);
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === 0x7b) depth++;
    else if (ch === 0x7d) { depth--; if (depth === 0) return i; }
    i++;
  }
  return n;
}

// input: Uint8Array or Buffer (or a latin1 string). opts.onChunk({seq, html, images}) receives the body as it is
// parsed; without it the whole body is in the result. Returns { html?, header, footer, footnotes, fontCss, page,
// title, notes, counts, images? }.
function parseRtf(input, opts) {
  const P = new Parser(opts);
  let s;
  if (typeof input === 'string') s = input;
  else if (typeof Buffer !== 'undefined') s = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString('latin1');
  else { s = ''; for (let i = 0; i < input.length; i += 65536) s += String.fromCharCode.apply(null, input.subarray(i, i + 65536)); }
  const n = s.length;
  if (!n) throw Object.assign(new Error('The file is empty (0 bytes).'), { code: 'EMPTY' });
  const head = s.slice(0, 64).replace(/^\ufeff|^\xef\xbb\xbf/, '');
  if (!/^\s*\{\s*\\rtf/.test(head)) throw Object.assign(new Error('This file does not start with {\\rtf, so it is not an RTF file.'), { code: 'NOTRTF' });

  let st = { dest: 'flow', flow: P.body, c: newChar(), p: newPar(), uc: 1, link: null, pic: null, coll: null, field: null, fontEntry: null, styleEntry: null, sect: true, obj: null, fn: null };
  const stack = [];
  let overflow = 0;
  let pending = ''; let pendCp = 1252; let pendFont = -1; // bytes of text in the current font's code page
  let uniBuf = '';
  let skipN = 0;
  let ignorableNext = false;
  let atGroupStart = false;
  P.baseFs = 24;
  P.getPos = () => i;
  let nextProg = 1 << 20;

  function flushText() {
    if (pending) {
      const t = P.decodeBytes(pending, pendCp, pendFont);
      pending = '';
      if (uniBuf) { const u = uniBuf; uniBuf = ''; deliver(u); }
      deliver(t);
    } else if (uniBuf) { const u = uniBuf; uniBuf = ''; deliver(u); }
  }
  function deliver(t) {
    switch (st.dest) {
      case 'flow': st.flow.text(t, st); break;
      case 'font': if (st.fontEntry) st.fontEntry.name += t; break;
      case 'style': if (st.styleEntry) st.styleEntry.name += t; break;
      case 'collect': if (st.coll) st.coll.t += t; break;
      case 'pict': break;
      default: break;
    }
  }
  function addBytes(str) {
    const cp = st.dest === 'flow' ? P.cpOfFont(st.c.f) : (st.dest === 'font' && st.fontEntry ? (CHARSET_CP[st.fontEntry.charset] && st.fontEntry.charset !== 2 ? CHARSET_CP[st.fontEntry.charset] : P.defCp) : P.defCp);
    if (pending && (cp !== pendCp || st.c.f !== pendFont)) flushText();
    if (uniBuf) flushText();
    pendCp = cp; pendFont = st.c.f;
    pending += str;
  }
  function addUnicode(str) { if (pending) flushText(); uniBuf += str; }

  function push() {
    flushText();
    if (stack.length >= MAX_DEPTH) { overflow++; P.counts.depthFlattened++; return; }
    stack.push(st);
    st = { dest: st.dest, flow: st.flow, c: Object.assign({}, st.c), p: Object.assign({}, st.p), uc: st.uc, link: st.link, pic: null, coll: st.coll, field: st.field, fontEntry: st.fontEntry, styleEntry: st.styleEntry, sect: st.sect, obj: st.obj, fn: st.fn, inFonttbl: st.inFonttbl, inStyles: st.inStyles, inColors: st.inColors, endHook: null, parent: st };
  }
  function pop() {
    flushText();
    if (overflow > 0) { overflow--; return; }
    if (!stack.length) return false;
    const done = st;
    st = stack.pop();
    if (done.endHook) done.endHook(done);
    return true;
  }
  function skipDest(i) { // i is at the position after the destination word; jump to the end of the current group
    const end = skipGroup(s, i - 1, 1);
    return end; // the main loop sees s[end] === '}' and pops
  }
  function setDest(name, i, first) {
    // returns a new index if the group was skipped. Skipped destinations count only as the first word of a group,
    // so a document word with the same name (\trackformatting1 and the like) cannot swallow the body.
    if (SKIP_DEST.has(name) && first) return skipDest(i);
    switch (name) {
      case 'fonttbl': st.dest = 'font'; st.inFonttbl = true; st.fontEntry = null; return -1;
      case 'colortbl': st.dest = 'color'; st.inColors = true; st.colorCur = null; P.colors = []; P.colorCur = [0, 0, 0, false]; return -1;
      case 'stylesheet': st.dest = 'style'; st.inStyles = true; st.styleEntry = null; return -1;
      case 'info': st.dest = 'info'; return -1;
      case 'title': if (st.dest === 'info') { st.dest = 'collect'; st.coll = { t: '' }; st.endHook = (d) => { P.title = d.coll.t.trim().slice(0, 300); }; return -1; } return skipDest(i);
      case 'pict': {
        st.dest = 'pict'; st.pic = { type: '', w: 0, h: 0, wg: 0, hg: 0, sx: 100, sy: 100, hex: [], bin: null };
        const flow = st.flow; const parent = stack[stack.length - 1] || st;
        st.endHook = (d) => { if (d.pic && flow && !d.inNonShp) P.picture(d.pic, parent, flow); };
        return -1;
      }
      case 'shppict': return -1;
      case 'field': st.field = { inst: '', link: null, kind: '' }; return -1;
      case 'fldinst': {
        st.dest = 'collect'; st.coll = { t: '' };
        const field = st.field;
        st.endHook = (d) => {
          if (!field) return;
          field.inst = d.coll.t;
          const m = /^\s*HYPERLINK\s+(?:\\[a-z]\s+)*"([^"]*)"/i.exec(field.inst) || /^\s*HYPERLINK\s+(?:\\[a-z]\s+)*(\S+)/i.exec(field.inst);
          if (m && !/^\s*HYPERLINK\s+\\l\b/i.test(field.inst)) {
            const l = safeLink(m[1]); l.id = ++P.linkId; field.link = l;
            if (l.ok) P.counts.links++; else P.counts.linksBlocked++;
          }
          const k = /^\s*(PAGE|NUMPAGES|SECTIONPAGES)\b/i.exec(field.inst);
          if (k) field.kind = k[1].toUpperCase();
        };
        return -1;
      }
      case 'fldrslt': {
        if (st.field && st.field.link) st.link = st.field.link;
        if (st.field && st.field.kind && st.flow && st.flow.kind !== 'body') {
          const kind = st.field.kind;
          st.dest = 'skipText';
          st.flow.raw('<span class="fld" data-f="' + kind + '">' + (kind === 'PAGE' ? '1' : '1') + '</span>', st);
        }
        return -1;
      }
      case 'footnote': {
        const f = new Flow(P, 'fn');
        const num = P.fnCount || 1;
        st.dest = 'flow'; st.flow = f; st.p = newPar(); st.link = null; st.fn = num;
        st.endHook = (d) => { const h = f.finish(d); P.footnotes.push('<div class="fnote" id="fn' + num + '"><span class="fnn">' + num + '</span>' + h + '</div>'); };
        return -1;
      }
      case 'object': {
        P.counts.objects++;
        const obj = { cls: '', shown: false };
        st.obj = obj;
        const flow = st.flow; const parent = stack[stack.length - 1] || st;
        st.endHook = () => { if (!obj.shown && flow) flow.raw(objBox(obj), parent); };
        return -1;
      }
      case 'objclass': { st.dest = 'collect'; st.coll = { t: '' }; const obj = st.obj; st.endHook = (d) => { if (obj) obj.cls = d.coll.t.trim().slice(0, 80); }; return -1; }
      case 'result': { if (st.obj && !st.obj.shown && st.flow) { st.obj.shown = true; st.flow.raw(objBox(st.obj), st); } return -1; }
      case 'NeXTGraphic': {
        st.dest = 'collect'; st.coll = { t: '' };
        const flow = st.flow; const parent = stack[stack.length - 1] || st;
        st.endHook = (d) => { if (flow) { P.counts.picturesSkipped++; flow.raw('<span class="ph">Attachment ' + esc(clean(d.coll.t.trim()).slice(0, 80)) + ' (kept in the .rtfd package, not in this file)</span>', parent, true); } };
        return -1;
      }
      default: break;
    }
    if (HEADER_DEST[name] && first) {
      const kind = HEADER_DEST[name];
      const f = new Flow(P, 'hf');
      st.dest = 'flow'; st.flow = f; st.p = newPar(); st.link = null;
      st.endHook = (d) => { const h = f.finish(d); if (!(kind in P.headers) && h.replace(/<[^>]+>/g, '').trim()) P.headers[kind] = h; };
      return -1;
    }
    return -2; // not a destination
  }
  function objBox(obj) { return '<span class="obj">Embedded object' + (obj.cls ? ' (' + esc(clean(obj.cls)) + ')' : '') + ', not opened</span>'; }

  // ---- control words ----
  function word(w, hasP, v, i) {
    // Returns a new index when it consumed input itself, else -1.
    const first = atGroupStart;
    atGroupStart = false;
    if (ignorableNext) {
      ignorableNext = false;
      const r = setDest(w, i, true);
      if (r === -2) return skipDest(i); // unknown ignorable destination
      return r;
    }
    const d = setDest(w, i, first);
    if (d !== -2) return d;
    const c = st.c, p = st.p;
    if (st.dest === 'font' && st.inFonttbl) {
      if (w === 'f') { st.fontEntry = { name: '', charset: undefined, family: '' }; P.fonts[v] = st.fontEntry; return -1; }
      if (w === 'fcharset' && st.fontEntry) { st.fontEntry.charset = v; return -1; }
      if (w === 'cpg' && st.fontEntry) { st.fontEntry.cp = v; return -1; }
      if (/^f(nil|roman|swiss|modern|script|decor|tech|bidi)$/.test(w) && st.fontEntry) { st.fontEntry.family = w.slice(1); return -1; }
    }
    if (st.dest === 'color') {
      const cc = P.colorCur;
      if (w === 'red') { cc[0] = v & 255; cc[3] = true; } else if (w === 'green') { cc[1] = v & 255; cc[3] = true; } else if (w === 'blue') { cc[2] = v & 255; cc[3] = true; }
      return -1;
    }
    if (st.dest === 'style' && st.inStyles && (w === 's' || w === 'cs' || w === 'ds' || w === 'ts')) {
      st.styleEntry = { name: '', ol: -1, kind: w }; if (w === 's') P.styles[v] = st.styleEntry; return -1;
    }
    if (st.dest === 'style' && w === 'outlinelevel' && st.styleEntry) { st.styleEntry.ol = v; return -1; }
    if (st.dest === 'pict' && st.pic) {
      const pic = st.pic;
      switch (w) {
        case 'pngblip': pic.type = 'png'; return -1;
        case 'jpegblip': pic.type = 'jpeg'; return -1;
        case 'emfblip': pic.type = 'emf'; return -1;
        case 'wmetafile': pic.type = 'wmf'; return -1;
        case 'dibitmap': pic.type = 'dib'; return -1;
        case 'wbitmap': pic.type = 'ddb'; return -1;
        case 'macpict': pic.type = 'pict'; return -1;
        case 'pmmetafile': pic.type = 'os2 metafile'; return -1;
        case 'picw': pic.w = v; return -1;
        case 'pich': pic.h = v; return -1;
        case 'picwgoal': pic.wg = v; return -1;
        case 'pichgoal': pic.hg = v; return -1;
        case 'picscalex': pic.sx = v; return -1;
        case 'picscaley': pic.sy = v; return -1;
        case 'bin': {
          const len = Math.max(0, v);
          const end = Math.min(n, i + len);
          if (i + len > n) P.note('A \\bin picture says it has more bytes than the file holds; the picture is cut at the end of the file.');
          const b = new Uint8Array(end - i);
          for (let k = i; k < end; k++) b[k - i] = s.charCodeAt(k);
          pic.bin = b;
          return end;
        }
        default: return -1;
      }
    }
    switch (w) {
      // document
      case 'rtf': return -1;
      case 'ansi': P.defCp = 1252; return -1;
      case 'mac': P.defCp = 10000; return -1;
      case 'pc': P.defCp = 437; return -1;
      case 'pca': P.defCp = 850; return -1;
      case 'ansicpg': P.defCp = v || 1252; if (!CP_LABEL[P.defCp]) P.decoder(P.defCp); return -1;
      case 'deff': P.defFont = v; if (c.f < 0) c.f = v; return -1;
      case 'uc': st.uc = Math.max(0, Math.min(v, 10)); return -1;
      case 'paperw': P.page.w = clampTw(v, P.page.w); return -1;
      case 'paperh': P.page.h = clampTw(v, P.page.h); return -1;
      case 'margl': P.page.ml = clampM(v, P.page.ml); return -1;
      case 'margr': P.page.mr = clampM(v, P.page.mr); return -1;
      case 'margt': P.page.mt = clampM(v, P.page.mt); return -1;
      case 'margb': P.page.mb = clampM(v, P.page.mb); return -1;
      case 'landscape': P.page.landscape = true; return -1;
      case 'pgwsxn': if (!P.sectSeen) P.page.w = clampTw(v, P.page.w); return -1;
      case 'pghsxn': if (!P.sectSeen) P.page.h = clampTw(v, P.page.h); return -1;
      case 'marglsxn': if (!P.sectSeen) P.page.ml = clampM(v, P.page.ml); return -1;
      case 'margrsxn': if (!P.sectSeen) P.page.mr = clampM(v, P.page.mr); return -1;
      case 'lndscpsxn': if (!P.sectSeen) P.page.landscape = true; return -1;
      // character
      case 'plain': { const f = P.defFont; Object.assign(c, newChar()); c.f = f; return -1; }
      case 'b': c.b = !hasP || v !== 0; return -1;
      case 'i': c.i = !hasP || v !== 0; return -1;
      case 'ulnone': c.ul = false; return -1;
      case 'strike': case 'striked': c.s = !hasP || v !== 0; return -1;
      case 'f': c.f = v; return -1;
      case 'fs': c.fs = v > 0 && v < 3200 ? v : 24; return -1;
      case 'cf': c.cf = v; return -1;
      case 'cb': case 'chcbpat': c.cb = v; return -1;
      case 'highlight': c.hl = v; return -1;
      case 'super': c.va = 'sup'; return -1;
      case 'sub': c.va = 'sub'; return -1;
      case 'nosupersub': c.va = ''; return -1;
      case 'up': c.va = v > 0 ? 'sup' : ''; return -1;
      case 'dn': c.va = v > 0 ? 'sub' : ''; return -1;
      case 'caps': c.caps = !hasP || v !== 0; return -1;
      case 'scaps': c.scaps = !hasP || v !== 0; return -1;
      case 'v': c.v = !hasP || v !== 0; return -1;
      case 'webhidden': c.v = !hasP || v !== 0; return -1;
      // paragraph
      case 'pard': { const keep = p.itap > 1 ? 0 : 0; Object.assign(p, newPar()); p.itap = keep; return -1; }
      case 'ql': p.al = ''; return -1;
      case 'qc': p.al = 'center'; return -1;
      case 'qr': p.al = 'right'; return -1;
      case 'qj': case 'qd': p.al = 'justify'; return -1;
      case 'li': case 'lin': p.li = clampInd(v); return -1;
      case 'ri': case 'rin': p.ri = clampInd(v); return -1;
      case 'fi': p.fi = clampInd(v); return -1;
      case 'sb': p.sb = clampSp(v); return -1;
      case 'sa': p.sa = clampSp(v); return -1;
      case 'sl': p.sl = Math.max(-14400, Math.min(v, 14400)); return -1;
      case 'slmult': p.slm = v; return -1;
      case 's': p.style = v; return -1;
      case 'outlinelevel': p.ol = v; return -1;
      case 'intbl': p.intbl = true; if (!p.itap) p.itap = 1; return -1;
      case 'itap': p.itap = v; p.intbl = v > 0; return -1;
      case 'pagebb': p.pagebb = true; return -1;
      case 'rtlpar': p.rtl = true; return -1;
      case 'ltrpar': p.rtl = false; return -1;
      case 'cbpat': p.cbpat = v; return -1;
      // breaks and specials
      case 'par': if (st.dest === 'flow') { st.flow.endPar(st); } return -1;
      case 'line': if (st.dest === 'flow') st.flow.raw('<br>', st); return -1;
      case 'tab': if (st.dest === 'flow') st.flow.text('\t', st); else if (st.dest === 'collect') st.coll.t += '\t'; return -1;
      case 'page': if (st.dest === 'flow' && st.flow.kind === 'body') { if (st.flow.hasPending()) st.flow.endPar(st); st.flow.flushTable(); st.flow.push(P.pageBreak()); } return -1;
      case 'sect': if (st.dest === 'flow' && st.flow.kind === 'body') { if (st.flow.hasPending()) st.flow.endPar(st); st.flow.flushTable(); if (!P.sbkNone) st.flow.push(P.pageBreak()); P.sectSeen = true; } return -1;
      case 'sectd': P.sbkNone = false; return -1;
      case 'sbknone': P.sbkNone = true; return -1;
      case 'cell': if (st.dest === 'flow') st.flow.endCell(st, false); return -1;
      case 'nestcell': if (st.dest === 'flow') st.flow.endCell(st, true); return -1;
      case 'row': if (st.dest === 'flow') st.flow.endRow(false); return -1;
      case 'nestrow': if (st.dest === 'flow') st.flow.endRow(true); return -1;
      case 'chftn': if (st.dest === 'flow') {
        if (st.flow.kind === 'fn') return -1; // the number is drawn by the footnote list
        const num = ++P.fnCount;
        st.flow.raw('<sup class="fnref"><a data-fn="' + num + '">' + num + '</a></sup>', st);
      } return -1;
      // tables
      case 'trowd': { const f = st.flow; if (f) { if (p.itap > 1 || st.nestProps) return -1; f.rowDef = newRowDef(); f.pendCell = newCellDef(); } P.bTarget = null; return -1; }
      case 'trleft': if (st.flow && !st.nestProps) st.flow.rowDef.left = Math.max(-14400, Math.min(v, 31680)); return -1;
      case 'trgaph': if (st.flow && !st.nestProps) st.flow.rowDef.gap = Math.max(0, Math.min(v, 1440)); return -1;
      case 'trhdr': if (st.flow && !st.nestProps) st.flow.rowDef.hdr = true; return -1;
      case 'trqc': if (st.flow && !st.nestProps) st.flow.rowDef.al = 'center'; return -1;
      case 'cellx': if (st.flow && !st.nestProps) { const f = st.flow; f.pendCell.right = Math.max(-14400, Math.min(v, 63360)); if (f.rowDef.cells.length < 200) f.rowDef.cells.push(f.pendCell); f.pendCell = newCellDef(); } P.bTarget = null; return -1;
      case 'clmgf': if (st.flow) st.flow.pendCell.mgf = true; return -1;
      case 'clmrg': if (st.flow) st.flow.pendCell.mrg = true; return -1;
      case 'clvmgf': if (st.flow) st.flow.pendCell.vmgf = true; return -1;
      case 'clvmrg': if (st.flow) st.flow.pendCell.vmrg = true; return -1;
      case 'clcbpat': if (st.flow) st.flow.pendCell.pat = v; return -1;
      case 'clvertalt': if (st.flow) st.flow.pendCell.va = ''; return -1;
      case 'clvertalc': if (st.flow) st.flow.pendCell.va = 'middle'; return -1;
      case 'clvertalb': if (st.flow) st.flow.pendCell.va = 'bottom'; return -1;
      case 'clbrdrt': case 'clbrdrl': case 'clbrdrb': case 'clbrdrr': if (st.flow) { const b = { style: 'solid', w: 15, cf: 0, set: false }; st.flow.pendCell.b[w[6]] = b; P.bTarget = b; } return -1;
      case 'trbrdrt': case 'trbrdrl': case 'trbrdrb': case 'trbrdrr': case 'trbrdrh': case 'trbrdrv': if (st.flow) { const b = { style: 'solid', w: 15, cf: 0 }; st.flow.rowDef.b[w[6]] = b; P.bTarget = b; } return -1;
      case 'brdrt': case 'brdrl': case 'brdrb': case 'brdrr': case 'box': case 'brdrbtw': case 'brdrbar': P.bTarget = { style: 'solid' }; return -1; // paragraph borders: read, not drawn
      case 'brdrnone': case 'brdrnil': case 'brdrtbl': if (P.bTarget) P.bTarget.style = 'none'; return -1;
      case 'brdrs': case 'brdrth': case 'brdrsh': case 'brdrthtnsg': case 'brdrtnthsg': case 'brdroutset': case 'brdrinset': case 'brdremboss': case 'brdrengrave': case 'brdrframe': case 'brdrhair': if (P.bTarget) P.bTarget.style = 'solid'; if (w === 'brdrth' && P.bTarget) P.bTarget.w = Math.max(P.bTarget.w || 0, 30); return -1;
      case 'brdrdb': case 'brdrtriple': case 'brdrwavydb': if (P.bTarget) P.bTarget.style = 'double'; return -1;
      case 'brdrdot': if (P.bTarget) P.bTarget.style = 'dotted'; return -1;
      case 'brdrdash': case 'brdrdashsm': case 'brdrdashd': case 'brdrdashdd': case 'brdrdashdotstr': if (P.bTarget) P.bTarget.style = 'dashed'; return -1;
      case 'brdrw': if (P.bTarget) P.bTarget.w = Math.max(1, Math.min(v, 255)); return -1;
      case 'brdrcf': if (P.bTarget) P.bTarget.cf = v; return -1;
      case 'nesttableprops': st.nestProps = true; return -1;
      case 'nonesttables': return skipDest(i);
      case 'listtext': case 'pntext': return -1; // the literal list marker: shown as text
      case 'nonshppict': st.inNonShp = true; return skipDest(i);
      case 'shprslt': return -1;
      case 'shp': return -1;
      case 'u': {
        let cp = v; if (cp < 0) cp += 65536;
        const ch = String.fromCharCode(cp & 0xffff);
        if (st.dest === 'flow' || st.dest === 'collect' || st.dest === 'font' || st.dest === 'style') addUnicode(ch);
        skipN = st.uc;
        return -1;
      }
      default:
        if (UL.has(w)) { c.ul = !hasP || v !== 0; return -1; }
        if (SPECIAL[w] !== undefined) { if (st.dest === 'flow' || st.dest === 'collect') addUnicode(SPECIAL[w]); return -1; }
        return -1;
    }
  }

  // ---- main loop ----
  var i = 0;
  while (i < n) {
    if (i > nextProg) { nextProg = i + (1 << 20); if (P.o.onProgress) P.o.onProgress(i, n); }
    const ch = s.charCodeAt(i);
    if (skipN > 0) {
      if (ch === 0x7b || ch === 0x7d) { skipN = 0; continue; }
      if (ch === 0x5c) {
        const nx = s[i + 1];
        if (nx === "'") { i += 4; skipN--; continue; }
        if (/[a-zA-Z]/.test(nx || '')) { let j = i + 1; while (j < n && j - i < 34 && isLetter(s.charCodeAt(j))) j++; if (s[j] === '-') j++; while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++; if (s[j] === ' ') j++; i = j; skipN--; continue; }
        i += 2; skipN--; continue;
      }
      if (ch === 0x0d || ch === 0x0a) { i++; continue; }
      i++; skipN--; continue;
    }
    if (ch === 0x7b) { push(); ignorableNext = false; atGroupStart = true; i++; continue; }
    if (ch === 0x7d) { pop(); i++; continue; }
    if (ch === 0x5c) {
      const nx = s.charCodeAt(i + 1);
      if (isLetter(nx)) {
        let j = i + 1;
        while (j < n && j - i <= 32 && isLetter(s.charCodeAt(j))) j++;
        const w = s.slice(i + 1, j);
        let hasP = false, v = 0;
        let neg = false;
        if (s.charCodeAt(j) === 0x2d && s.charCodeAt(j + 1) >= 48 && s.charCodeAt(j + 1) <= 57) { neg = true; j++; }
        const ds = j;
        while (j < n && j - ds < 10 && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++;
        if (j > ds) { hasP = true; v = parseInt(s.slice(ds, j), 10); if (neg) v = -v; if (v > 2147483647) v = 2147483647; }
        while (j < n && s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) j++; // over-long numbers
        if (s.charCodeAt(j) === 0x20) j++;
        if (w !== 'u') flushText();
        if (w === 'bin' && st.dest !== 'pict') { // binary data outside a picture: skip it
          const len = Math.max(0, v);
          if (j + len > n) P.note('A \\bin block says it has more bytes than the file holds.');
          i = Math.min(n, j + len); continue;
        }
        const r = word(w, hasP, v, j);
        i = r >= 0 ? r : j;
        continue;
      }
      // control symbols
      const sym = s[i + 1];
      if (sym === "'") {
        const h = s.substr(i + 2, 2);
        const b = /^[0-9a-fA-F]{2}$/.test(h) ? parseInt(h, 16) : -1;
        i += b >= 0 ? 4 : 2;
        if (b >= 0 && st.dest !== 'pict' && st.dest !== 'skipText' && st.dest !== 'color' && st.dest !== 'info') addBytes(String.fromCharCode(b));
        continue;
      }
      if (sym === '*') { ignorableNext = true; i += 2; continue; }
      atGroupStart = false;
      if (sym === '\\' || sym === '{' || sym === '}') { if (st.dest !== 'pict' && st.dest !== 'skipText') addBytes(sym); i += 2; continue; }
      if (sym === '~') { addUnicode('\u00a0'); i += 2; continue; }
      if (sym === '_') { addUnicode('\u2011'); i += 2; continue; }
      if (sym === '-') { i += 2; continue; }
      if (sym === '\n' || sym === '\r') { flushText(); if (st.dest === 'flow') st.flow.endPar(st); i += 2; continue; }
      i += 2; // \| \: and others
      continue;
    }
    if (ch === 0x0d || ch === 0x0a) { i++; continue; }
    // plain text: take the run up to the next special character
    atGroupStart = false;
    let j = i;
    while (j < n) { const c2 = s.charCodeAt(j); if (c2 === 0x5c || c2 === 0x7b || c2 === 0x7d || c2 === 0x0d || c2 === 0x0a) break; j++; }
    const run = s.slice(i, j);
    i = j;
    switch (st.dest) {
      case 'pict': if (st.pic && !st.pic.bin) st.pic.hex.push(run); break;
      case 'font': case 'style': {
        const parts = run.split(';');
        for (let k = 0; k < parts.length; k++) {
          if (parts[k]) addBytes(parts[k]);
          if (k < parts.length - 1) { flushText(); if (st.dest === 'font') st.fontEntry = null; else st.styleEntry = null; }
        }
        break;
      }
      case 'color': {
        for (const chr of run) if (chr === ';') { const cc = P.colorCur; P.colors.push(cc[3] ? [cc[0], cc[1], cc[2]] : null); P.colorCur = [0, 0, 0, false]; }
        break;
      }
      case 'flow': case 'collect': addBytes(run); break;
      default: break;
    }
  }
  flushText();
  while (stack.length) { const d = st; st = stack.pop(); if (d.endHook) d.endHook(d); }
  if (P.counts.depthFlattened) P.note('Groups nested deeper than ' + MAX_DEPTH + ' levels were read as one level (' + P.counts.depthFlattened + ' groups).');
  if (P.counts.objects) P.note(P.counts.objects + ' embedded object' + (P.counts.objects > 1 ? 's were' : ' was') + ' not opened; each is shown as a box.');
  if (P.counts.linksBlocked) P.note(P.counts.linksBlocked + ' link' + (P.counts.linksBlocked > 1 ? 's point' : ' points') + ' to something other than a web or mail address and will not open.');

  const tail = P.body.finish(st);
  const fontCss = [P.fontCss()];
  const res = {
    header: P.headers.header || P.headers.headerl || P.headers.headerf || '',
    footer: P.headers.footer || P.headers.footerl || P.headers.footerf || '',
    footnotes: P.footnotes.join(''),
    fontCss: fontCss.join('\n'),
    page: P.page, title: P.title, notes: [...P.notes], counts: P.counts, defFs: P.baseFs
  };
  if (P.o.onChunk) {
    P.maybeEmit(true);
  } else {
    res.html = tail;
    res.images = P.images;
  }
  return res;
}

function isLetter(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function clampTw(v, d) { return v >= 1440 && v <= 31680 * 2 ? v : d; }
function clampM(v, d) { return v >= 0 && v <= 14400 ? v : d; }
function clampInd(v) { return Math.max(-14400, Math.min(v, 31680)); }
function clampSp(v) { return Math.max(0, Math.min(v, 7200)); }

module.exports = { parseRtf, safeLink, skipGroup, dibToBmp, MAX_DEPTH, DEFAULTS, esc };
