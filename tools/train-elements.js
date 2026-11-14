#!/usr/bin/env node
/* Builds the training set for the element-level model: every MUSDB18 song is remixed several times
   with the vocals, drums, bass and other parts turned up and down, and for each remix we record the
   segment features (src/features.js) and how loud each part really is against the whole mix.

   Usage: node tools/train-elements.js <dataset-folder> <out.jsonl>
   Then:  python3 tools/train_elements.py <out.jsonl>   (writes src/model.js) */
'use strict';
const fs = require('fs');
for (const f of ['dsp', 'features']) require(`../src/${f}.js`);
const M = globalThis.MuSixk;
const { decode, walk, FS } = require('./musdb.js');

const PARTS = ['drums', 'bass', 'other', 'vocals'];
const VARIANTS = 10;
let seed = 12345;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const uniform = (lo, hi) => lo + (hi - lo) * rand();
const lufs = (ch) => M.dsp.loudness(ch, FS).integrated;

(async () => {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) { console.error('Usage: node tools/train-elements.js <dataset-folder> <out.jsonl>'); process.exit(1); }
  const files = walk(dir);
  const sink = fs.createWriteStream(out);
  for (const [t, file] of files.entries()) {
    const stems = {};
    PARTS.forEach((p, i) => { stems[p] = decode(file, i + 1).channels; });
    const n = Math.min(...PARTS.map((p) => stems[p][0].length));
    const present = Object.fromEntries(PARTS.map((p) => [p, lufs(stems[p]) > -45]));
    for (let v = 0; v < VARIANTS; v++) {
      const gains = v === 0 ? { drums: 0, bass: 0, other: 0, vocals: 0 }
        : { drums: uniform(-8, 6), bass: uniform(-8, 6), other: uniform(-6, 4), vocals: uniform(-8, 6) };
      const L = new Float32Array(n), R = new Float32Array(n);
      const scaled = {};
      for (const p of PARTS) {
        const g = Math.pow(10, gains[p] / 20);
        const [sl, sr] = stems[p];
        const pl = new Float32Array(n), pr = new Float32Array(n);
        for (let i = 0; i < n; i++) { pl[i] = g * sl[i]; pr[i] = g * sr[i]; L[i] += pl[i]; R[i] += pr[i]; }
        scaled[p] = [pl, pr];
      }
      let peak = 0;
      for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
      const k = 0.8 / (peak || 1);
      for (let i = 0; i < n; i++) { L[i] *= k; R[i] *= k; }
      const mixLufs = lufs([L, R]);
      const seg = M.features.segment(L, R, FS, 0, n);
      if (!seg || !Number.isFinite(mixLufs)) continue;
      const y = {};
      for (const p of PARTS) {
        if (!present[p]) { y[p] = null; continue; }
        const l = lufs(scaled[p]) + 20 * Math.log10(k);
        y[p] = Number.isFinite(l) ? l - mixLufs : null;
      }
      sink.write(`${JSON.stringify({ track: t, name: file.split('/').pop(), variant: v, gains, x: seg.x, y })}\n`);
    }
    if ((t + 1) % 10 === 0) console.error(`${t + 1}/${files.length}`);
  }
  sink.end();
})();
