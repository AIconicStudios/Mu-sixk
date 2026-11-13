'use strict';
const test = require('node:test');
const assert = require('node:assert');
require('../src/dsp.js');
require('../src/analyze.js');
const M = globalThis.MuSixk;

const FS = 48000;
const sine = (freq, amp, seconds, phase = 0) => {
  const x = new Float32Array(Math.round(FS * seconds));
  for (let i = 0; i < x.length; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / FS + phase);
  return x;
};
const near = (actual, expected, tol, label) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${label}: got ${actual}, expected ${expected} ±${tol}`);

test('a 1 kHz stereo sine at -23 dBFS reads -23 LUFS', async () => {
  const x = sine(1000, Math.pow(10, -23 / 20), 10);
  const a = await M.analyze({ channels: [x, x], sampleRate: FS });
  near(a.lufs, -23, 0.15, 'LUFS');
  near(a.samplePeakDb, -23, 0.1, 'sample peak');
  near(a.stereoInfo.correlation, 1, 0.001, 'correlation');
  near(a.crestDb, 3.01, 0.1, 'crest of a sine');
});

test('true peak finds an inter-sample over that sample peak misses', async () => {
  // fs/4 sine with 45 degree phase: every sample lands at 0.707 of the real crest.
  const x = sine(FS / 4, 1, 2, Math.PI / 4);
  const a = await M.analyze({ channels: [x], sampleRate: FS });
  near(a.samplePeakDb, -3.01, 0.05, 'sample peak');
  near(a.truePeakDb, 0, 0.3, 'true peak');
});

test('spectrum puts a tone in the right band at the right level', async () => {
  const x = sine(100, 0.5, 6);
  const a = await M.analyze({ channels: [x], sampleRate: FS });
  const idx = M.THIRD_OCT.findIndex((f) => Math.abs(f - 100) < 3);
  near(a.thirdOctAbs[idx], -9.03, 0.3, '100 Hz band level (dBFS RMS)');
  assert.ok(a.regions.bass > -0.2, 'nearly all energy in the bass region');
  assert.ok(a.regions.mid < -40, 'no energy in the mids');
});

test('out-of-phase channels are flagged by correlation and mono loss', async () => {
  const l = sine(440, 0.5, 4);
  const r = l.map((v) => -v);
  const a = await M.analyze({ channels: [l, r], sampleRate: FS });
  near(a.stereoInfo.correlation, -1, 0.001, 'correlation');
  assert.ok(a.stereoInfo.monoLossDb > 30, 'collapses in mono');
});

test('clipping is counted', async () => {
  const x = sine(220, 2, 3).map((v) => Math.max(-1, Math.min(1, v)));
  const a = await M.analyze({ channels: [x], sampleRate: FS });
  assert.ok(a.clipRuns > 100, `clip runs: ${a.clipRuns}`);
});

test('tempo of a 128 BPM click track', async () => {
  const x = new Float32Array(FS * 20);
  const beat = (60 / 128) * FS;
  for (let b = 0; b * beat < x.length - 2000; b++) {
    const start = Math.round(b * beat);
    for (let i = 0; i < 2000; i++) x[start + i] += 0.8 * Math.sin((2 * Math.PI * 60 * i) / FS) * Math.exp(-i / 400);
  }
  const a = await M.analyze({ channels: [x], sampleRate: FS });
  near(a.tempo.bpm, 128, 1.5, 'BPM');
});

test('rejects silence with a useful message', async () => {
  await assert.rejects(M.analyze({ channels: [new Float32Array(FS * 2)], sampleRate: FS }), /silent/);
});
