'use strict';
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['dsp', 'key', 'vocalkey', 'keyprofiles']) require(`../src/${f}.js`);
const M = globalThis.MuSixk;
const FS = 44100;

/* A sung line: each note slides in from below, then gets vibrato; vowel-like harmonics; optional detune. */
function sing(melody, { noteLen = 0.45, cents = 0, shift = 0 } = {}) {
  const n = Math.round(FS * noteLen * melody.length);
  const x = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / FS, k = Math.floor(t / noteLen), tn = t - k * noteLen;
    const m = melody[k] + shift + (tn < 0.06 ? -1 + tn / 0.06 : 0) + 0.4 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, tn * 4);
    const f = 440 * Math.pow(2, (m - 69) / 12) * Math.pow(2, cents / 1200);
    ph += f / FS;
    let v = 0;
    for (let h = 1; h <= 10; h++) v += (Math.sin(2 * Math.PI * h * ph) / h) * (1 + 2 * Math.exp(-Math.pow((h * f - 700) / 300, 2)));
    x[i] = tn < noteLen - 0.05 ? 0.2 * v : 0;
  }
  return [x];
}
const C_MAJOR_TUNE = [60, 62, 64, 65, 67, 65, 64, 62, 60, 64, 67, 72, 71, 67, 65, 64, 62, 60];
const A_MINOR_TUNE = [69, 72, 76, 74, 72, 71, 69, 67, 69, 72, 74, 76, 77, 76, 74, 72, 71, 68, 69];

test('a sung C major tune, 20 cents sharp, with slides and vibrato', () => {
  const r = M.vocalKey.detect(sing(C_MAJOR_TUNE, { cents: 20 }), FS);
  assert.strictEqual(r.name, 'C major');
  assert.ok(Math.abs(r.tuningCents - 20) < 6, `tuning ${r.tuningCents}`);
  assert.strictEqual(r.notes.length, C_MAJOR_TUNE.length, 'every note transcribed once');
  assert.deepStrictEqual([r.range.low, r.range.high], ['C4', 'C5']);
  assert.ok(r.intonation < 15, `intonation ${r.intonation}`);
});

test('a sung A minor tune ending on the raised 7th (G#) and home', () => {
  const r = M.vocalKey.detect(sing(A_MINOR_TUNE), FS);
  assert.strictEqual(r.name, 'A minor');
});

test('the same tune an octave lower (male range) gives the same key and a lower range', () => {
  const r = M.vocalKey.detect(sing(C_MAJOR_TUNE, { shift: -12 }), FS);
  assert.strictEqual(r.name, 'C major');
  assert.deepStrictEqual([r.range.low, r.range.high], ['C3', 'C4']);
});

test('auto mode: a voice goes to the vocal method, chords go to the full-music method', () => {
  const v = M.vocalKey.auto(sing(C_MAJOR_TUNE), FS);
  assert.strictEqual(v.vocal, true);
  const n = FS * 8, x = new Float32Array(n);
  const chords = [[60, 64, 67], [65, 69, 72], [67, 71, 74], [60, 64, 67]];
  for (let i = 0; i < n; i++) {
    const t = i / FS, ch = chords[Math.floor(t / 2) % 4];
    for (const m of [ch[0] - 12, ...ch]) { const f = 440 * Math.pow(2, (m - 69) / 12); for (let h = 1; h <= 5; h++) x[i] += (0.05 * Math.sin(2 * Math.PI * f * h * t)) / h; }
  }
  const p = M.vocalKey.auto([x], FS);
  assert.ok(!p.vocal, 'chords are not treated as a single voice');
  assert.strictEqual(p.name, 'C major');
});

test('too little singing gives no answer rather than a guess', () => {
  assert.strictEqual(M.vocalKey.detect(sing([60, 62]), FS), null);
  assert.strictEqual(M.vocalKey.detect([new Float32Array(FS * 4)], FS), null);
});

test('an acapella with three-part harmony (lead, a third below, a sixth below) still finds the key', () => {
  const lead = C_MAJOR_TUNE;
  const scale = [0, 2, 4, 5, 7, 9, 11];
  const below = (m, steps) => { let k = 0, x = m; while (k < steps) { x--; if (scale.includes(((x % 12) + 12) % 12)) k++; } return x; };
  const parts = [sing(lead), sing(lead.map((m) => below(m, 2))), sing(lead.map((m) => below(m, 5)))];
  const mix = new Float32Array(parts[0][0].length);
  parts.forEach((p, i) => p[0].forEach((v, j) => { mix[j] += v * (i === 0 ? 1 : 0.6); }));
  const r = M.vocalKey.auto([mix], FS);
  assert.strictEqual(r.name, 'C major');
});
