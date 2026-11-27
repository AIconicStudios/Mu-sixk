'use strict';
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['dsp', 'key', 'keyprofiles']) require(`../src/${f}.js`);
const M = globalThis.MuSixk;

/* Chords as MIDI note lists, each held for one bar, with a bass note an octave below the root. */
function render(chords, { fs = 44100, bpm = 96, cents = 0, bars = 2 } = {}) {
  const bar = (60 / bpm) * 4;
  const seconds = chords.length * bar * bars;
  const n = Math.round(seconds * fs);
  const L = new Float32Array(n), R = new Float32Array(n);
  const tune = Math.pow(2, cents / 1200);
  for (let rep = 0; rep < bars; rep++) {
    chords.forEach((notes, c) => {
      const t0 = (rep * chords.length + c) * bar;
      const voiced = [notes[0] - 12, ...notes];
      for (const [j, m] of voiced.entries()) {
        const f = 440 * Math.pow(2, (m - 69) / 12) * tune;
        const s = Math.round(t0 * fs), e = Math.min(n, Math.round((t0 + bar) * fs));
        for (let i = s; i < e; i++) {
          const t = (i - s) / fs;
          const env = Math.min(1, t / 0.01) * Math.exp(-t * 1.5) * (j === 0 ? 1.2 : 0.6);
          let v = 0;
          for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
          L[i] += env * v * 0.15; R[i] += env * v * 0.15;
        }
      }
    });
  }
  return [L, R];
}
const triad = (root, minor) => [root, root + (minor ? 3 : 4), root + 7];

test('Eb major: I - V - vi - IV', () => {
  const r = M.key.detect(render([triad(63), triad(70), triad(72, true), triad(68)]), 44100);
  assert.strictEqual(r.name, 'Eb major');
  assert.strictEqual(r.camelot, '5B');
});

test('F# minor: i - iv - V - i (harmonic minor), which only fits F# minor', () => {
  const r = M.key.detect(render([triad(66, true), triad(71, true), triad(73), triad(66, true)]), 44100);
  assert.strictEqual(r.name, 'F# minor');
  assert.strictEqual(r.camelot, '11A');
});

test('F#m - D - A - E loop reads as A major (vi-IV-I-V) or F# minor, never an unrelated key', () => {
  const r = M.key.detect(render([triad(66, true), triad(62), triad(69), triad(64)]), 44100);
  assert.ok(['A major', 'F# minor'].includes(r.name), r.name);
});

test('D minor with a harmonic-minor V (A major chord) at 48 kHz', () => {
  const r = M.key.detect(render([triad(62, true), triad(67, true), triad(69), triad(62, true)], { fs: 48000 }), 48000);
  assert.strictEqual(r.name, 'D minor');
});

test('a recording tuned 30 cents sharp: tuning is measured and the key still holds', () => {
  const r = M.key.detect(render([triad(64), triad(69), triad(71), triad(64)], { cents: 30 }), 44100);
  assert.strictEqual(r.name, 'E major');
  assert.ok(Math.abs(r.tuningCents - 30) < 5, `tuning ${r.tuningCents}`);
  assert.ok(Math.abs(r.referenceA - 447.7) < 2.5, `A = ${r.referenceA}`);
});

test('names, Camelot codes and chords in the key', () => {
  assert.strictEqual(M.key.camelot(9, 'minor'), '8A');
  assert.strictEqual(M.key.camelot(0, 'major'), '8B');
  assert.strictEqual(M.key.camelot(6, 'major'), '2B');
  assert.strictEqual(M.key.camelot(1, 'minor'), '12A');
  assert.strictEqual(M.key.keyName(10, 'major'), 'Bb major');
  assert.strictEqual(M.key.keyName(1, 'minor'), 'C# minor');
  const am = M.key.chords(9, 'minor').map((c) => `${c.roman}:${c.name}`);
  assert.deepStrictEqual(am, ['i:Am', 'ii°:Bdim', 'III:C', 'iv:Dm', 'v:Em', 'VI:F', 'VII:G', 'V (harmonic):E']);
});

test('silence and pure noise give no confident key', () => {
  assert.strictEqual(M.key.detect([new Float32Array(44100 * 5)], 44100), null);
  let s = 9;
  const noise = Float32Array.from({ length: 44100 * 8 }, () => ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 0.5);
  const r = M.key.detect([noise], 44100);
  assert.ok(!r || (r.noKey && r.confidence < 0.1), `noise confidence ${r && r.confidence}`);
});
