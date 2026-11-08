'use strict';
// Worker thread: reads and parses one RTF file, so a big file never blocks the extension host. Sends the body in
// chunks as it goes (the first page shows while the rest is still being read), then the header, footer,
// footnotes and notes. Picture bytes are transferred, not copied.
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const { parseRtf } = require('./core/rtf');

const t0 = Date.now();
try {
  const buf = workerData.path ? fs.readFileSync(workerData.path) : Buffer.from(workerData.bytes);
  const readMs = Date.now() - t0;
  const total = buf.length;
  let last = 0;
  const res = parseRtf(buf, {
    maxImageBytes: workerData.maxImageBytes,
    onChunk(c) {
      const images = c.images.map((im) => ({ id: im.id, kind: im.kind, bytes: im.bytes }));
      parentPort.postMessage({ type: 'chunk', seq: c.seq, html: c.html, images, pos: c.pos, total, page: c.page, fontCss: c.fontCss }, images.map((im) => im.bytes.buffer));
    },
    onProgress(pos) {
      const now = Date.now();
      if (now - last < 250) return;
      last = now;
      parentPort.postMessage({ type: 'progress', pos, total });
    }
  });
  parentPort.postMessage({ type: 'done', res, readMs, parseMs: Date.now() - t0 - readMs, size: total });
} catch (e) {
  parentPort.postMessage({ type: 'error', code: e.code || '', message: String((e && e.message) || e).slice(0, 400) });
}
