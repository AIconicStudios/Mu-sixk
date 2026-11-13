#!/usr/bin/env node
/* Measures a folder of MUSDB18-style *.stem.mp4 files (streams: mixture, drums, bass, other, vocals)
   with the Mu-sixk analyzer and writes src/calibration.js: numbers only, no audio.

   Usage: node tools/calibrate.js <dataset-folder> [--raw measurements.json]
   Needs ffmpeg on the PATH. The dataset is not part of this repository. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
for (const f of ['dsp', 'analyze']) require(`../src/${f}.js`);
const M = globalThis.MuSixk;
const { percentile, mean } = M.dsp;

const STREAMS = ['mix', 'drums', 'bass', 'other', 'vocals'];
const FS = 44100;

function decode(file, stream) {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', `0:${stream}`, '-f', 'f32le', '-ac', '2', '-ar', String(FS), '-'],
    { maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(out.stderr.toString().slice(0, 200));
  const inter = new Float32Array(out.stdout.buffer, out.stdout.byteOffset, Math.floor(out.stdout.length / 4));
  const n = inter.length >> 1;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1]; }
  return { channels: [L, R], sampleRate: FS };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.stem.mp4') ? [path.join(dir, e.name)] : []);
}

async function measure(files) {
  const rows = [];
  for (const [i, file] of files.entries()) {
    const row = {};
    for (const [s, name] of STREAMS.entries()) {
      try {
        const a = await M.analyze(decode(file, s));
        if (a.lufs < -45) continue; // the part is not really playing in this excerpt
        row[name] = {
          lufs: a.lufs, plr: a.plr, crest: a.crestDb, spread: a.levelSpreadDb, sib: a.sibilance.index,
          width: Math.max(a.stereoInfo.widthDb, -60), corr: a.stereoInfo.correlation, lowSide: Math.max(a.stereoInfo.lowSideDb, -60),
          cutoff: a.cutoffHz, abs: a.thirdOctAbs, rel: a.thirdOct,
        };
      } catch (e) { /* silent or unreadable stream: skip */ }
    }
    rows.push(row);
    if ((i + 1) % 20 === 0) console.error(`${i + 1}/${files.length}`);
  }
  return rows;
}

const r1 = (v) => Math.round(v * 10) / 10;
const span = (values, lo = 10, hi = 90) => ({ lo: r1(percentile(values, lo)), mid: r1(percentile(values, 50)), hi: r1(percentile(values, hi)), n: values.length });

/* The band-vs-band tone measures the advice engine uses, per stem type. */
const TONE = {
  vocals: { mud: [[200, 400], [1000, 4000]], presence: [[3000, 6000], [500, 2000]], air: [[8000, 16000], [500, 2000]] },
  bass: { mud: [[180, 400], [40, 120]], definition: [[700, 2500], [40, 120]] },
  drums: { lows: [[40, 120], [300, 2000]], highs: [[6000, 14000], [300, 2000]] },
  other: { mud: [[120, 350], [800, 3000]], bite: [[2500, 5000], [300, 1200]] },
};

function summarise(rows) {
  const out = { source: 'MUSDB18 7-second excerpts', tracks: rows.length, stems: {}, levels: {}, mix: {} };
  for (const name of ['vocals', 'drums', 'bass', 'other']) {
    const got = rows.map((r) => r[name]).filter(Boolean);
    const tone = {};
    for (const [key, [a, b]] of Object.entries(TONE[name])) {
      tone[key] = span(got.map((g) => M.levelBetween(g.abs, a[0], a[1]) - M.levelBetween(g.abs, b[0], b[1])), 5, 95);
    }
    out.stems[name] = { n: got.length, tone, spread: span(got.map((g) => g.spread)), sibilance: span(got.map((g) => g.sib)), width: span(got.map((g) => g.width)) };
    if (name !== 'vocals') {
      const both = rows.filter((r) => r[name] && r.vocals);
      out.levels[name] = span(both.map((r) => r[name].lufs - r.vocals.lufs), 25, 75);
    }
  }
  const mixes = rows.map((r) => r.mix).filter(Boolean);
  const anchored = mixes.map((m) => { const ref = M.levelBetween(m.rel, 200, 4000); return m.rel.map((v) => v - ref); });
  const median = M.THIRD_OCT.map((_, i) => percentile(anchored.map((c) => c[i]), 50));
  const regionSpread = {};
  for (const r of M.REGIONS) regionSpread[r.id] = span(anchored.map((c) => M.levelBetween(c, r.lo, r.hi) - M.levelBetween(median, r.lo, r.hi)), 5, 95);
  out.mix = {
    n: mixes.length, regionSpread,
    curve: M.THIRD_OCT.map((_, i) => r1(percentile(anchored.map((c) => c[i]), 50))),
    curveLo: M.THIRD_OCT.map((_, i) => r1(percentile(anchored.map((c) => c[i]), 15))),
    curveHi: M.THIRD_OCT.map((_, i) => r1(percentile(anchored.map((c) => c[i]), 85))),
    lufs: span(mixes.map((m) => m.lufs)), plr: span(mixes.map((m) => m.plr)), width: span(mixes.map((m) => m.width)),
    correlation: span(mixes.map((m) => m.corr)), lowSide: span(mixes.map((m) => m.lowSide)), cutoff: span(mixes.map((m) => m.cutoff)),
  };
  return out;
}

(async () => {
  const dir = process.argv[2];
  if (!dir) { console.error('Usage: node tools/calibrate.js <dataset-folder> [--raw file.json]'); process.exit(1); }
  const rawAt = process.argv.indexOf('--raw');
  const rawFile = rawAt > 0 ? process.argv[rawAt + 1] : null;
  let rows;
  if (rawFile && fs.existsSync(rawFile)) rows = JSON.parse(fs.readFileSync(rawFile, 'utf8'));
  else {
    rows = await measure(walk(dir).sort());
    if (rawFile) fs.writeFileSync(rawFile, JSON.stringify(rows));
  }
  const summary = summarise(rows);
  const target = path.join(__dirname, '..', 'src', 'calibration.js');
  fs.writeFileSync(target, `/* Generated by tools/calibrate.js. Measurements of real, professionally mixed songs and their stems.\n   Numbers only: no audio from the dataset is included. */\n(function (root) {\n  'use strict';\n  const M = (root.MuSixk = root.MuSixk || {});\n  M.calibration = ${JSON.stringify(summary, null, 1).replace(/\n\s+(-?[\d.]+,?)(?=\n)/g, ' $1').replace(/\n/g, '\n  ')};\n})(typeof self !== 'undefined' ? self : globalThis);\n`);
  console.log(JSON.stringify({ ...summary, mix: { ...summary.mix, curve: summary.mix.curve.join(' '), curveLo: undefined, curveHi: undefined } }, null, 1));
})();
