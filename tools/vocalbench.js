#!/usr/bin/env node
/* Vocal key benchmark on POP909 melodies (MIT licence).
   node tools/vocalbench.js learn <POP909 folder> [--write]   melody templates from odd-numbered songs, scored on even ones
   node tools/vocalbench.js sing <POP909 folder> [count]       render held-out melodies as realistic singing and test audio
   node tools/vocalbench.js real <musdb folder>                real vocal stems vs the instruments' key (no labels exist) */
'use strict';
const fs = require('fs');
const path = require('path');
for (const f of ['dsp', 'key', 'vocalkey', 'keyprofiles']) require(`../src/${f}.js`);
const M = globalThis.MuSixk;
const kb = require('./keybench.js');
const V = M.vocalKey;

const FS = 44100;
const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };
const rng = (seed) => { let s = seed % 2147483647 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); };

function songs(root) {
  const dir = path.join(root, 'POP909');
  return fs.readdirSync(dir).filter((d) => /^\d+$/.test(d)).sort().map((id) => {
    const keys = fs.readFileSync(path.join(dir, id, 'key_audio.txt'), 'utf8').trim().split('\n');
    if (keys.length !== 1) return null;
    const [k, m] = keys[0].trim().split(/\s+/)[2].split(':');
    if (!(k in PC)) return null;
    const midi = kb.parseMidi(fs.readFileSync(path.join(dir, id, `${id}.mid`)));
    const mel = midi.tracks.find((t) => t.name.toUpperCase().includes('MELODY'));
    if (!mel || mel.notes.length < 20) return null;
    const notes = mel.notes.map((n) => ({ start: n.t0, end: n.t1, midi: n.note, cents: 0 })).sort((a, b) => a.start - b.start);
    return { id: Number(id), tonic: PC[k], mode: m === 'maj' ? 'major' : 'minor', notes, midi };
  }).filter(Boolean);
}

/* A window of the melody starting at its first note. */
function windowNotes(notes, seconds, offset = 0) {
  const t0 = notes[0].start + offset;
  return notes.filter((n) => n.start >= t0 && n.start < t0 + seconds).map((n) => ({ ...n, end: Math.min(n.end, t0 + seconds) }));
}

const rot = (v, k) => v.map((_, i) => v[(i + k) % 12]);
/* Melody pitch-class statistics of the Essen folk-song collection (Temperley, Music and Probability, 2007).
   POP909 melodies are largely pentatonic (Chinese pop), so the learned templates are blended 50/50 with these;
   the blend was chosen on half of 144 real vocal tracks (MUSDB18) and checked on the other half. */
const ESSEN = { major: [0.184, 0.001, 0.155, 0.003, 0.191, 0.109, 0.005, 0.214, 0.001, 0.078, 0.004, 0.055], minor: [0.192, 0.005, 0.149, 0.179, 0.002, 0.144, 0.002, 0.201, 0.038, 0.012, 0.053, 0.022] };
const blendEssen = (learned, a = 0.5) => {
  const norm = (v) => { const m = Math.max(...v); return v.map((x) => x / m); };
  return { ...learned, major: norm(ESSEN.major).map((v, i) => +(a * v + (1 - a) * learned.major[i]).toFixed(4)), minor: norm(ESSEN.minor).map((v, i) => +(a * v + (1 - a) * learned.minor[i]).toFixed(4)) };
};
function learn(set) {
  const acc = { major: new Array(12).fill(0), minor: new Array(12).fill(0), finalMajor: new Array(12).fill(0), finalMinor: new Array(12).fill(0) };
  for (const s of set) {
    const h = V.histograms(s.notes);
    const sd = h.dur.reduce((a, b) => a + b, 0) || 1, sf = h.fin.reduce((a, b) => a + b, 0) || 1;
    const d = rot(h.dur, s.tonic), f = rot(h.fin, s.tonic);
    for (let i = 0; i < 12; i++) { acc[s.mode][i] += d[i] / sd; acc[s.mode === 'major' ? 'finalMajor' : 'finalMinor'][i] += f[i] / sf; }
  }
  for (const k of Object.keys(acc)) { const m = Math.max(...acc[k]); acc[k] = acc[k].map((v) => +(v / m).toFixed(4)); }
  return acc;
}

function score(set, fw, seconds, offset = 0) {
  let w = 0, e = 0, n = 0;
  for (const s of set) {
    const notes = seconds ? windowNotes(s.notes, seconds, offset) : s.notes;
    if (notes.length < 4) continue;
    const best = V.scoreMelody(V.histograms(notes), { finalWeight: fw })[0];
    const m = kb.mirex(best.tonic, best.mode, s);
    w += m; if (m === 1) e++; n++;
  }
  return { exact: e / n, weighted: w / n, n };
}

function fitTemperature(set, fw, seconds) {
  let best = { t: 0.08, ll: Infinity };
  for (let t = 0.01; t < 0.6; t *= 1.12) {
    let ll = 0;
    for (const s of set) {
      const notes = windowNotes(s.notes, seconds);
      if (notes.length < 4) continue;
      const ranked = V.scoreMelody(V.histograms(notes), { finalWeight: fw });
      const top = ranked[0].score;
      const z = ranked.reduce((a, k) => a + Math.exp((k.score - top) / t), 0);
      const tr = ranked.find((k) => k.tonic === s.tonic && k.mode === s.mode);
      ll -= Math.log(Math.max(1e-9, Math.exp((tr.score - top) / t) / z));
    }
    if (ll < best.ll) best = { t, ll };
  }
  return best.t;
}

/* ---------- realistic singing ---------- */
const VOWELS = { a: [[800, 80], [1150, 90], [2900, 120]], e: [[400, 60], [1700, 80], [2600, 100]], i: [[300, 50], [2200, 90], [3000, 120]], o: [[450, 70], [800, 80], [2830, 100]], u: [[325, 50], [700, 60], [2530, 170]] };
function formantGain(f, vowel) {
  let g = 0.05;
  for (const [fc, bw] of VOWELS[vowel]) g += 1 / (1 + ((f - fc) / bw) ** 2);
  return g;
}

function sing(notes, seed, seconds = 60) {
  const r = rng(seed);
  const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
  const n = Math.round(seconds * FS);
  const out = new Float32Array(n);
  const t0 = notes[0].start;
  const octave = r() < 0.5 ? -12 : 0; // half male, half female range
  const detune = r() < 0.5 ? 0 : (r() * 2 - 1) * 40;
  const sloppy = 10 + r() * 25; // cents of intonation error per note
  const vibDepth = 20 + r() * 50, vibRate = 5 + r() * 1.5;
  const breath = 0.01 + r() * 0.04;
  let prevCents = null, phase = 0;
  for (const nt of notes) {
    const s = Math.round((nt.start - t0) * FS);
    if (s >= n) break;
    const e = Math.min(n, Math.round((nt.end - t0) * FS));
    if (e - s < FS * 0.03) continue;
    const target = (nt.midi + octave - 69) * 100 + detune + gauss() * sloppy;
    const scoopFrom = prevCents !== null && nt.start - (prevCents.end || 0) < 0.15 ? prevCents.c : target - (60 + r() * 140);
    const scoopLen = (0.04 + r() * 0.08) * FS;
    const vowel = 'aeiou'[Math.floor(r() * 5)];
    const f0 = 440 * Math.pow(2, target / 1200);
    const maxH = Math.max(1, Math.floor(4500 / f0));
    const amps = Array.from({ length: maxH }, (_, h) => formantGain((h + 1) * f0, vowel) / Math.pow(h + 1, 1.0));
    const tab = new Float32Array(2048);
    for (let h = 0; h < maxH; h++) for (let i = 0; i < 2048; i++) tab[i] += amps[h] * Math.sin((2 * Math.PI * (h + 1) * i) / 2048 + h);
    let pk = 0; for (const v of tab) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < 2048; i++) tab[i] /= pk || 1;
    const gain = 0.25 * (0.6 + 0.4 * r());
    let drift = 0;
    const consonant = r() < 0.4;
    for (let i = s; i < e; i++) {
      const k = i - s, t = k / FS;
      drift += (gauss() * 0.5 - drift * 0.002);
      let c = k < scoopLen ? scoopFrom + (target - scoopFrom) * (k / scoopLen) : target;
      c += vibDepth * Math.sin(2 * Math.PI * vibRate * t) * Math.max(0, Math.min(1, (t - 0.2) * 3)) + drift * 0.3;
      phase += (2048 * 440 * Math.pow(2, c / 1200)) / FS;
      const env = Math.min(1, t / 0.04) * Math.min(1, (e - i) / (0.06 * FS));
      out[i] += gain * env * (tab[Math.floor(phase) & 2047] + breath * (r() * 2 - 1));
      if (consonant && k < 0.03 * FS) out[i] += 0.08 * (r() * 2 - 1) * (1 - k / (0.03 * FS));
    }
    prevCents = { c: target, end: nt.end };
  }
  let p = 0, q = 0;
  const room = r() * 0.01;
  for (let i = 0; i < n; i++) { p = 0.995 * p + room * (r() * 2 - 1) * 0.1; out[i] += p + room * 0.2 * (r() * 2 - 1); q = Math.max(q, Math.abs(out[i])); }
  for (let i = 0; i < n; i++) out[i] *= 0.9 / (q || 1);
  return { channels: [out], detune, octave, sloppy };
}

async function main() {
  const [cmd, root, extra] = process.argv.slice(2);
  if (cmd === 'learn') {
    const all = songs(root);
    const dev = all.filter((s) => s.id % 2 === 1), test = all.filter((s) => s.id % 2 === 0);
    console.log(`${all.length} melodies (${dev.length} to learn from, ${test.length} to test on)`);
    const saved = M.keyProfiles;
    M.keyProfiles = { ...(saved || {}), vocal: { ...V.FALLBACK, finalWeight: 0.5 } };
    const fallbackTest = score(test, 0.5, 30);
    const learned = learn(dev);
    let bestFw = 0, bestDev = -1;
    for (const fw of [0, 0.25, 0.5, 0.75, 1, 1.5]) {
      M.keyProfiles = { ...(saved || {}), vocal: { ...learned, finalWeight: fw } };
      const d = (score(dev, fw, 30).weighted + score(dev, fw, 15).weighted) / 2;
      if (d > bestDev) { bestDev = d; bestFw = fw; }
    }
    M.keyProfiles = { ...(saved || {}), vocal: { ...learned, finalWeight: bestFw } };
    console.log(`phrase-ending weight chosen on the learning half: ${bestFw}`);
    console.log(`hand-set melody templates, 30 s: exact ${(100 * fallbackTest.exact).toFixed(1)}%`);
    for (const sec of [15, 30, 60, null]) {
      const t = score(test, bestFw, sec);
      console.log(`learned templates, perfect notes, ${sec ? `${sec} s` : 'whole melody'}: exact ${(100 * t.exact).toFixed(1)}%  weighted ${(100 * t.weighted).toFixed(1)}%  (${t.n})`);
    }
    if (extra === '--write') {
      const temperature = fitTemperature(dev, bestFw, 30);
      const file = path.join(__dirname, '..', 'src', 'keyprofiles.js');
      const text = fs.readFileSync(file, 'utf8');
      const body = JSON.parse(text.match(/M\.keyProfiles = (\{.*\});/)[1]);
      body.vocal = { source: 'POP909 melodies (MIT), odd-numbered songs, blended 50/50 with Essen melody statistics', songs: dev.length, ...blendEssen(learned), finalWeight: bestFw, spectralWeight: 1, temperature: +temperature.toFixed(4) };
      fs.writeFileSync(file, text.replace(/M\.keyProfiles = \{.*\};/, `M.keyProfiles = ${JSON.stringify(body)};`));
      console.log(`wrote vocal templates into src/keyprofiles.js (temperature ${temperature.toFixed(4)})`);
    }
    return;
  }
  if (cmd === 'calibrate') {
    /* Confidence temperature for the full vocal pipeline, fitted on sung renders of learning-half melodies. */
    const dev = songs(root).filter((s) => s.id % 2 === 1).slice(0, Number(extra) || 120);
    const sets = [];
    for (const s of dev) {
      const full = sing(s.notes, s.id * 104729, 60);
      for (const sec of [15, 30, 60]) {
        const v = V.detect([full.channels[0].slice(0, sec * FS)], FS);
        if (v) sets.push({ sec, ranked: v.ranked.map((k) => ({ s: k.score, ok: k.tonic === s.tonic && k.mode === s.mode })) });
      }
    }
    let best = { t: 0.08, ll: Infinity };
    for (let t = 0.01; t < 1; t *= 1.1) {
      let ll = 0;
      for (const r of sets) {
        const temp = t * 1.3 * Math.pow(60 / Math.max(5, Math.min(60, r.sec)), 0.23);
        const top = r.ranked[0].s;
        const z = r.ranked.reduce((a, k) => a + Math.exp((k.s - top) / temp), 0);
        const tr = r.ranked.find((k) => k.ok);
        ll -= Math.log(Math.max(1e-9, Math.exp((tr.s - top) / temp) / z));
      }
      if (ll < best.ll) best = { t, ll };
    }
    const file = path.join(__dirname, '..', 'src', 'keyprofiles.js');
    const text = fs.readFileSync(file, 'utf8');
    const body = JSON.parse(text.match(/M\.keyProfiles = (\{.*\});/)[1]);
    body.vocal.temperature = +best.t.toFixed(4);
    fs.writeFileSync(file, text.replace(/M\.keyProfiles = \{.*\};/, `M.keyProfiles = ${JSON.stringify(body)};`));
    console.log(`vocal confidence temperature ${best.t.toFixed(4)} from ${sets.length} sung clips`);
    return;
  }
  if (cmd === 'sing') {
    const test = songs(root).filter((s) => s.id % 2 === 0).slice(0, Number(extra) || 150);
    const tally = {};
    const add = (k, m) => { const t = (tally[k] = tally[k] || { n: 0, w: 0, e: 0, none: 0 }); t.n++; if (m === null) t.none++; else { t.w += m; if (m === 1) t.e++; } };
    for (const s of test) {
      const full = sing(s.notes, s.id * 104729, 60);
      for (const sec of [15, 30, 60]) {
        const ch = [full.channels[0].slice(0, sec * FS)];
        const v = V.detect(ch, FS), p = M.key.detect(ch, FS);
        add(`vocal method, ${sec} s`, v ? kb.mirex(v.tonic, v.mode, s) : null);
        add(`mix method, ${sec} s`, p ? kb.mirex(p.tonic, p.mode, s) : null);
        if (sec === 30) add('single voice recognised (30 s)', V.isSingleLine(ch, FS).single ? 1 : 0);
      }
    }
    for (const [k, t] of Object.entries(tally)) console.log(`${k.padEnd(32)} exact ${((100 * t.e) / t.n).toFixed(1)}%  weighted ${((100 * t.w) / t.n).toFixed(1)}%${t.none ? `  (no key ${t.none})` : ''}  n=${t.n}`);
    return;
  }
  if (cmd === 'real') {
    const { decode, walk } = require('./musdb.js');
    const sum = (chs) => { const n = Math.min(...chs.map((c) => c[0].length)); const L = new Float32Array(n), R = new Float32Array(n); for (const c of chs) for (let i = 0; i < n; i++) { L[i] += c[0][i]; R[i] += c[1][i]; } return [L, R]; };
    const id = (k) => `${k.tonic}${k.mode}`;
    const relId = (k) => (k.mode === 'major' ? `${(k.tonic + 9) % 12}minor` : `${(k.tonic + 3) % 12}major`);
    const res = { old: { same: 0, rel: 0, close: 0 }, vocal: { same: 0, rel: 0, close: 0 } };
    const resSure = { old: 0, vocal: 0, n: 0 };
    let n = 0, single = 0;
    for (const f of walk(root)) {
      const inst = M.key.detect(sum([decode(f, 2).channels, decode(f, 3).channels]), 44100);
      const voc = decode(f, 4).channels;
      if (!inst || inst.noKey) continue;
      const v = V.detect(voc, 44100), o = M.key.detect(voc, 44100);
      if (!v) continue;
      n++;
      if (V.isSingleLine(voc, 44100).single) single++;
      for (const [name, k] of [['old', o], ['vocal', v]]) {
        if (!k) continue;
        const m = kb.mirex(k.tonic, k.mode, inst);
        if (m === 1) res[name].same++; else if (m === 0.3) res[name].rel++;
        if (m >= 0.3 || id(k) === id(inst) || relId(k) === id(inst)) res[name].close++;
      }
      if (inst.confidence >= 0.7) { resSure.n++; if (o && id(o) === id(inst)) resSure.old++; if (id(v) === id(inst)) resSure.vocal++; }
    }
    console.log(`${n} real vocal stems (7-second excerpts) with a sung part; recognised as a single voice: ${((100 * single) / n).toFixed(0)}%`);
    for (const name of ['old', 'vocal']) console.log(`${name === 'old' ? 'mix method on the vocal ' : 'vocal method            '} same key as instruments ${((100 * res[name].same) / n).toFixed(1)}% | same or relative ${((100 * (res[name].same + res[name].rel)) / n).toFixed(1)}% | same, relative or a fifth ${((100 * res[name].close) / n).toFixed(1)}%`);
    console.log(`songs where the instruments' key is 70%+ sure (${resSure.n}): mix method ${((100 * resSure.old) / resSure.n).toFixed(0)}% same key, vocal method ${((100 * resSure.vocal) / resSure.n).toFixed(0)}%`);
    return;
  }
  console.error('Usage: node tools/vocalbench.js learn|sing|real <folder> [...]');
  process.exit(1);
}

module.exports = { sing, songs };
if (require.main === module) main();
