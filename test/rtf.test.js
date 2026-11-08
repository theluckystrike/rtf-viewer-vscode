'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseRtf, safeLink, skipGroup, dibToBmp } = require('../src/core/rtf');

const S = path.join(__dirname, '..', 'samples');
const doc = (body, head = '{\\fonttbl{\\f0\\fswiss Arial;}{\\f1\\froman Times New Roman;}}{\\colortbl;\\red0\\green0\\blue0;\\red255\\green0\\blue0;}') => parseRtf(Buffer.from('{\\rtf1\\ansi\\deff0' + head + body + '}', 'latin1'));
const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

test('plain paragraphs and character formatting', () => {
  const r = doc('\\f0 Hello {\\b bold} {\\i it} {\\ul under} {\\strike gone} {\\cf2 red} H{\\sub 2}O x{\\super 2}\\par Second\\par');
  assert.match(r.html, /<p><span class="f0">Hello <\/span><span class="f0" style="font-weight:bold">bold<\/span>/);
  assert.match(r.html, /font-style:italic">it</);
  assert.match(r.html, /text-decoration:underline">under</);
  assert.match(r.html, /text-decoration:line-through">gone</);
  assert.match(r.html, /color:#ff0000">red</);
  assert.match(r.html, /<sub><span class="f0">2<\/span><\/sub>/);
  assert.match(r.html, /<sup><span class="f0">2<\/span><\/sup>/);
  assert.equal(text(r.html), 'Hello bold it under gone red H2O x2Second');
});

test('black and auto colours are not written, so dark mode can recolour the text', () => {
  const r = doc('{\\cf1 black} {\\cf0 auto}\\par');
  assert.doesNotMatch(r.html, /color:/);
});

test('paragraph alignment, indents and spacing', () => {
  const r = doc('\\pard\\qc\\li720\\ri360\\fi-360\\sb240\\sa120 Centered\\par\\pard\\qr Right\\par\\pard\\qj Just\\par');
  assert.match(r.html, /<p style="text-align:center;margin-left:48px;margin-right:24px;text-indent:-24px;margin-top:16px;margin-bottom:8px">/);
  assert.match(r.html, /text-align:right/);
  assert.match(r.html, /text-align:justify/);
});

test('text is escaped: markup in a file stays text', () => {
  const r = doc('<script>alert(1)</script> <img src=x onerror="x()"> & "q"\\par');
  assert.doesNotMatch(r.html, /<script|<img src=x/);
  assert.match(r.html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(r.html, /&amp; &quot;q&quot;/);
});

test('escapes, specials and \\u with \\uc fallback', () => {
  const r = doc('\\{\\}\\\\ \\emdash\\endash\\bullet\\lquote x\\rquote\\ldblquote y\\rdblquote  a\\~b \\u8364? \\uc2\\u26085\\\'93\\\'fa end\\par');
  assert.equal(text(r.html), '{}\\ —–•‘x’“y” a b € 日 end');
});

test('surrogate pairs from two \\u words make one character', () => {
  const r = doc('\\u-10179?\\u-8704? smile\\par');
  assert.equal(text(r.html), '\u{1F600} smile');
});

test('code pages: \\ansicpg and font charsets (Shift-JIS, GBK, Big5, 1251)', () => {
  const r = parseRtf(fs.readFileSync(path.join(S, 'cjk-languages.rtf')));
  const t = text(r.html);
  for (const s of ['日本語のテキスト、東京都。', '简体中文文本，北京市。', '繁體中文文字，臺北市。', '한국어 텍스트', 'Русский текст, Москва.', 'Ελληνικό κείμενο', '日本語', '🙂 ✓', 'القاهرة']) assert.ok(t.includes(s), s);
});

test('an unknown code page falls back to Windows-1252 with a note', () => {
  const r = parseRtf(fs.readFileSync(path.join(S, 'hostile', 'bad-codepage.rtf')));
  assert.ok(text(r.html).includes('Bytes éèÿ in an unknown code page.'));
  assert.ok(r.notes.some((n) => /Code page 99999/.test(n)));
});

test('Symbol font bullets become real bullets', () => {
  const r = doc('{\\listtext\\f2 \\\'b7\\tab}\\li720\\fi-360 Item\\par', '{\\fonttbl{\\f0 Arial;}{\\f2\\fcharset2 Symbol;}}');
  assert.ok(text(r.html).startsWith('•'));
});

test('font table: classes with a generic fallback; Cocoa font tables without groups', () => {
  const r = parseRtf(Buffer.from('{\\rtf1\\ansi{\\fonttbl\\f0\\fswiss\\fcharset0 Helvetica;\\f1\\fmodern\\fcharset0 Menlo-Regular;}\\f0 a \\f1 b\\par}', 'latin1'));
  assert.match(r.fontCss, /\.f0\{font-family:"Helvetica",sans-serif\}/);
  assert.match(r.fontCss, /\.f1\{font-family:"Menlo-Regular",monospace\}/);
});

test('headings from heading styles and \\outlinelevel; fallback for big bold lines', () => {
  const r = doc('\\pard\\s1 Intro\\par\\pard\\outlinelevel1 Sub\\par\\pard Body\\par', '{\\fonttbl{\\f0 Arial;}}{\\stylesheet{\\s0 Normal;}{\\s1 heading 1;}}');
  assert.match(r.html, /<p data-o="1" id="h1">(<span class="f0">)?Intro(<\/span>)?<\/p>/);
  assert.match(r.html, /<p data-o="2" id="h2">(<span class="f0">)?Sub(<\/span>)?<\/p>/);
  const t = parseRtf(fs.readFileSync(path.join(S, 'textedit-letter.rtf')));
  assert.match(t.html, /data-oc="1"[^>]*>.*Letter to the tenants/);
});

test('tables: widths from \\cellx, horizontal and vertical merges, borders, shading', () => {
  const r = doc('\\trowd\\trgaph108\\clmgf\\clbrdrb\\brdrs\\brdrw15\\cellx2880\\clmrg\\cellx5760\\clcbpat2\\cellx8640\\pard\\intbl A\\cell\\cell C\\cell\\row'
    + '\\trowd\\clvmgf\\cellx2880\\cellx5760\\cellx8640\\pard\\intbl D\\cell E\\cell F\\cell\\row'
    + '\\trowd\\clvmrg\\cellx2880\\cellx5760\\cellx8640\\pard\\intbl \\cell H\\cell I\\cell\\row\\pard After\\par');
  assert.match(r.html, /<table class="t" style="width:576px"><colgroup><col style="width:192px"><col style="width:192px"><col style="width:192px"><\/colgroup>/);
  assert.match(r.html, /<td colspan="2" style="border-bottom:1px solid currentColor"><p><span class="f0">A<\/span><\/p><\/td>/);
  assert.match(r.html, /background-color:#ff0000/);
  const h = r.html.replace(/<span class="f0">([^<]*)<\/span>/g, '$1');
  assert.match(h, /<td rowspan="2"><p>D<\/p><\/td>/);
  assert.match(h, /<tr><td><p>H<\/p><\/td><td><p>I<\/p><\/td><\/tr>/);
  assert.match(h, /<\/table><p>After<\/p>/);
  assert.equal(r.counts.tables, 1);
});

test('clinical tables: header rows, spanning headers and page breaks', () => {
  const r = parseRtf(fs.readFileSync(path.join(S, 'clinical-ae.rtf')));
  assert.equal(r.page.w, 15840);
  assert.ok(r.counts.tables >= 2);
  assert.ok(r.counts.pages >= 2);
  assert.match(r.html, /<tr class="hdr">/);
  assert.match(r.html, /colspan="4"[^>]*><p[^>]*><span[^>]*>Number of subjects with events, n \(%\)/);
  assert.match(r.header, /Protocol ZV-2026-001/);
  assert.match(r.header, /<span class="fld" data-f="PAGE">/);
  const lab = parseRtf(fs.readFileSync(path.join(S, 'clinical-lab-shift.rtf')));
  assert.equal((lab.html.match(/rowspan="3"/g) || []).length, 4);
});

test('page breaks and \\pagebb', () => {
  const r = doc('One\\par\\page Two\\par\\pard\\pagebb Three\\par');
  assert.equal((r.html.match(/class="pb"/g) || []).length, 2);
  assert.equal(r.counts.pages, 3);
});

test('header, footer and footnotes go to their own parts', () => {
  const r = parseRtf(fs.readFileSync(path.join(S, 'welcome.rtf')));
  assert.match(r.header, /Northwind field office/);
  assert.match(r.footer, /data-f="NUMPAGES"/);
  assert.match(r.footnotes, /id="fn1".*Measured over 42 inspections/);
  assert.match(r.html, /<sup class="fnref"><a data-fn="1">1<\/a><\/sup>/);
  assert.doesNotMatch(r.html, /Measured over 42/);
  assert.equal(r.title, 'Quarterly field report');
});

test('links: http, https and mailto get data-href; javascript, data, file and vbscript are inert', () => {
  const r = parseRtf(fs.readFileSync(path.join(S, 'hostile', 'javascript-link.rtf')));
  assert.doesNotMatch(r.html, /\shref=/);
  assert.match(r.html, /<a class="lnk" data-href="https:\/\/example.org\/safe"/);
  assert.equal((r.html.match(/class="lnk-off"/g) || []).length, 5);
  assert.equal((r.html.match(/data-href=/g) || []).length, 1);
  assert.equal(r.counts.linksBlocked, 5);
  assert.deepEqual(safeLink(' JaVa\tScript:alert(1)'), { ok: false, url: 'JaVa\tScript:alert(1)', scheme: 'javascript' });
  assert.equal(safeLink('https://a.b/c').ok, true);
  assert.equal(safeLink('mailto:x@y.z').ok, true);
  assert.equal(safeLink('https://a.b/"onmouseover=x').ok, false);
});

test('pictures: PNG, JPEG, EMF, WMF and DIB are kept with their size; PICT becomes a box', () => {
  const r = parseRtf(fs.readFileSync(path.join(S, 'pictures.rtf')));
  const kinds = r.images.map((i) => i.kind);
  for (const k of ['png', 'jpeg', 'emf', 'wmf', 'bmp']) assert.ok(kinds.includes(k), k);
  assert.match(r.html, /<img class="pic" data-id="0" data-kind="png" style="width:160px;height:120px"/);
  assert.match(r.html, /class="ph"[^>]*>Picture \(PICT\) in a format the viewer cannot show/);
  const bmp = r.images.find((i) => i.kind === 'bmp').bytes;
  assert.equal(String.fromCharCode(bmp[0], bmp[1]), 'BM');
  assert.equal(r.images[0].bytes[0], 0x89);
});

test('\\nonshppict copies are skipped, so a picture is not shown twice', () => {
  const r = doc('{\\*\\shppict{\\pict\\pngblip\\picwgoal100\\pichgoal100 89504e470d0a1a0a}}{\\nonshppict{\\pict\\wmetafile8 0100090000}}\\par');
  assert.equal(r.images.length, 1);
});

test('pictures over the size limit become a box', () => {
  const big = '89504e47' + '00'.repeat(3000);
  const r = parseRtf(Buffer.from('{\\rtf1{\\pict\\pngblip ' + big + '}\\par}', 'latin1'), { maxImageBytes: 1000 });
  assert.equal(r.images.length, 0);
  assert.match(r.html, /larger than the 0 MB picture limit|picture limit/);
});

test('hostile: 100,000-deep nesting is flattened quickly, with the text kept', () => {
  const t0 = Date.now();
  const r = parseRtf(fs.readFileSync(path.join(S, 'hostile', 'deep-nesting.rtf')));
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(text(r.html), 'Before the deep part.deep textAfter the deep part.');
  assert.ok(r.notes.some((n) => /nested deeper/.test(n)));
});

test('hostile: \\bin past the end of the file stops at the end', () => {
  const r = parseRtf(fs.readFileSync(path.join(S, 'hostile', 'bin-overflow.rtf')));
  assert.ok(text(r.html).includes('Text before the picture.'));
  assert.ok(r.notes.some((n) => /\\bin/.test(n)));
});

test('hostile: an embedded OLE object is a labelled box; its bytes are never kept', () => {
  const r = parseRtf(fs.readFileSync(path.join(S, 'hostile', 'ole-object.rtf')));
  assert.match(r.html, /<span class="obj">Embedded object \(Package\), not opened<\/span>/);
  assert.doesNotMatch(r.html, /calc\.exe|d0cf11e0/i);
  assert.equal(r.counts.objects, 1);
  assert.ok(text(r.html).includes('After the object.'));
});

test('hostile: empty and non-RTF files throw a clear error with a code', () => {
  assert.throws(() => parseRtf(Buffer.alloc(0)), (e) => e.code === 'EMPTY');
  assert.throws(() => parseRtf(fs.readFileSync(path.join(S, 'hostile', 'not-rtf.rtf'))), (e) => e.code === 'NOTRTF');
});

test('ignorable destinations are skipped, document words with the same name are not', () => {
  const r = doc('{\\*\\themedata 0102}{\\*\\unknownthing secret}\\trackformatting1 Body text\\par{\\*\\datastore 0105}');
  assert.equal(text(r.html), 'Body text');
});

test('skipGroup honours escaped braces and \\bin', () => {
  const s = '{a\\{b{c}\\bin3 }}}d}x';
  assert.equal(s[skipGroup(s, 0)], '}');
  assert.equal(s.slice(skipGroup(s, 0) + 1), 'x');
});

test('dibToBmp builds a valid header and refuses junk', () => {
  assert.equal(dibToBmp(new Uint8Array(10)), null);
  const d = new Uint8Array(40 + 16); d[0] = 40; d[14] = 24;
  const b = dibToBmp(d);
  assert.equal(b.length, 70);
  assert.equal(b[10], 54);
});

test('streaming: onChunk gets the body in order, with picture bytes', () => {
  const chunks = [];
  const res = parseRtf(fs.readFileSync(path.join(S, 'pictures.rtf')), { chunkBytes: 200, onChunk: (c) => chunks.push({ html: c.html, n: c.images.length, b: c.images.map((i) => i.bytes && i.bytes.length) }) });
  assert.ok(chunks.length >= 3);
  assert.equal(res.html, undefined);
  assert.equal(chunks.reduce((a, c) => a + c.n, 0), 6);
  assert.ok(chunks.every((c) => c.b.every((x) => x > 0)));
  const whole = parseRtf(fs.readFileSync(path.join(S, 'pictures.rtf')));
  assert.equal(chunks.map((c) => c.html).join(''), whole.html);
});

test('every sample parses without throwing and has text', () => {
  for (const f of fs.readdirSync(S).filter((f) => f.endsWith('.rtf'))) {
    const r = parseRtf(fs.readFileSync(path.join(S, f)));
    assert.ok(text(r.html).trim().length > 20, f);
  }
});

test('real Word RTF shape: \\rtlch/\\ltrch runs, \\pnseclvl, list tables and field links', () => {
  const r = doc('{\\*\\listtable{\\list{\\listlevel\\leveltext\\\'01\\u-3913 ?;}}}{\\*\\pnseclvl1\\pnucrm{\\pntxta .}}\\pard\\plain \\rtlch\\fcs1 \\af0 \\ltrch\\fcs0 \\f0\\fs22 {\\rtlch\\fcs1 \\af0 \\ltrch\\fcs0 Run one }{\\field{\\*\\fldinst {\\rtlch\\fcs1 \\ltrch\\fcs0 HYPERLINK "https://x.example/" }}{\\fldrslt {\\cs15\\ul\\cf2 link}}}\\par');
  assert.equal(text(r.html), 'Run one link');
  assert.match(r.html, /data-href="https:\/\/x.example\/"/);
});
