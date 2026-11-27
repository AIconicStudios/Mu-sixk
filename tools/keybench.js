#!/usr/bin/env node
/* Key-finder benchmark on POP909 (MIT licence, github.com/music-x-lab/POP909-Dataset): 909 pop songs as MIDI
   with key labels. Each single-key song is rendered to audio with varied instrument sounds, drums, detuning,
   noise and reverb, then measured.

   node tools/keybench.js features <POP909 folder> <out.jsonl>    render + measure every song (slow, once)
   node tools/keybench.js evaluate <features.jsonl> [--write]      compare settings; learn templates on the
                                                                   odd-numbered songs, score on the even ones;
                                                                   --write saves src/keyprofiles.js */
'use strict';
const fs = require('fs');
const path = require('path');
for (const f of ['dsp', 'key']) require(`../src/${f}.js`);
const M = globalThis.MuSixk;
const K = M.key._internal;

const FS = 44100;
const SECONDS = 60;
const PC = { C: 0, 'B#': 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, Fb: 4, F: 5, 'E#': 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11, Cb: 11 };

/* ---------- MIDI ---------- */
function parseMidi(buf) {
  let p = 0;
  const str = (n) => { const s = buf.toString('latin1', p, p + n); p += n; return s; };
  const u32 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };
  const u16 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const vlq = () => { let v = 0, b; do { b = buf[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80); return v; };
  if (str(4) !== 'MThd') throw new Error('not a MIDI file');
  const hlen = u32(); u16(); const ntracks = u16(); const division = u16(); p += hlen - 6;
  const tempos = [];
  const tracks = [];
  for (let t = 0; t < ntracks; t++) {
    if (str(4) !== 'MTrk') break;
    const end = u32() + p;
    let tick = 0, status = 0, name = '';
    const open = new Map(), notes = [];
    while (p < end) {
      tick += vlq();
      let b = buf[p];
      if (b & 0x80) { status = b; p++; } else b = status;
      const type = status & 0xf0;
      if (status === 0xff) {
        const meta = buf[p++]; const len = vlq();
        if (meta === 0x51) tempos.push({ tick, us: (buf[p] << 16) | (buf[p + 1] << 8) | buf[p + 2] });
        if (meta === 0x03) name = buf.toString('latin1', p, p + len);
        p += len;
      } else if (status === 0xf0 || status === 0xf7) { p += vlq(); }
      else if (type === 0x90 || type === 0x80) {
        const note = buf[p++], vel = buf[p++];
        if (type === 0x90 && vel > 0) open.set(note, { tick, vel });
        else if (open.has(note)) { const o = open.get(note); notes.push({ note, vel: o.vel, on: o.tick, off: tick }); open.delete(note); }
      } else if (type === 0xc0 || type === 0xd0) p += 1;
      else p += 2;
    }
    p = end;
    tracks.push({ name, notes });
  }
  tempos.sort((a, b) => a.tick - b.tick);
  if (!tempos.length || tempos[0].tick > 0) tempos.unshift({ tick: 0, us: 500000 });
  const toSec = (tick) => {
    let sec = 0;
    for (let i = 0; i < tempos.length; i++) {
      const next = i + 1 < tempos.length ? tempos[i + 1].tick : Infinity;
      if (tick <= next) return sec + ((tick - tempos[i].tick) * tempos[i].us) / 1e6 / division;
      sec += ((next - tempos[i].tick) * tempos[i].us) / 1e6 / division;
    }
    return sec;
  };
  for (const tr of tracks) for (const n of tr.notes) { n.t0 = toSec(n.on); n.t1 = toSec(n.off); }
  return { tracks: tracks.filter((t) => t.notes.length), bpm: 60e6 / tempos[0].us };
}

/* ---------- synthesis ---------- */
function rng(seed) { let s = seed % 2147483647 || 1; return () => ((s = (s * 16807) % 2147483647) / 2147483647); }

const TIMBRES = {
  piano: { h: (k) => 1 / Math.pow(k, 1.1), decay: 2.2, sustain: 0, attack: 0.004 },
  epiano: { h: (k) => [1, 0.35, 0.12, 0.08, 0.03, 0.02][k - 1] || 0, decay: 1.6, sustain: 0.1, attack: 0.003 },
  organ: { h: (k) => ({ 1: 1, 2: 0.7, 3: 0.5, 4: 0.45, 6: 0.3, 8: 0.25 })[k] || 0, decay: 0, sustain: 1, attack: 0.01 },
  saw: { h: (k) => 1 / k, decay: 0.6, sustain: 0.6, attack: 0.02 },
  strings: { h: (k) => 1 / Math.pow(k, 1.4), decay: 0, sustain: 1, attack: 0.15 },
  square: { h: (k) => (k % 2 ? 1 / k : 0.05 / k), decay: 0.4, sustain: 0.5, attack: 0.01 },
  voice: { h: (k, f) => { const fk = k * f; return (1 / k) * (1 + 3 * Math.exp(-(((fk - 650) / 250) ** 2)) + 2 * Math.exp(-(((fk - 1250) / 300) ** 2)) + 1.2 * Math.exp(-(((fk - 2700) / 400) ** 2))); }, decay: 0, sustain: 1, attack: 0.04, vibrato: true },
  guitar: { h: (k) => (Math.abs(Math.sin(k * 0.9)) + 0.1) / Math.pow(k, 0.9), decay: 1.2, sustain: 0.05, attack: 0.002 },
};

/* One cycle of a timbre with as many harmonics as fit under 9 kHz at this pitch. */
const tableCache = new Map();
function table(name, f) {
  const maxH = Math.max(1, Math.min(24, Math.floor(9000 / f)));
  const band = Math.round(Math.log2(f) * 2);
  const key = `${name}:${maxH}:${name === 'voice' ? band : 0}`;
  if (tableCache.has(key)) return tableCache.get(key);
  const T = 2048, tab = new Float32Array(T), spec = TIMBRES[name];
  let peak = 0;
  for (let k = 1; k <= maxH; k++) {
    const a = spec.h(k, f);
    if (!a) continue;
    for (let i = 0; i < T; i++) tab[i] += a * Math.sin((2 * Math.PI * k * i) / T + k * 0.7);
  }
  for (let i = 0; i < T; i++) peak = Math.max(peak, Math.abs(tab[i]));
  for (let i = 0; i < T; i++) tab[i] /= peak || 1;
  tableCache.set(key, tab);
  return tab;
}

function renderNotes(out, notes, timbre, gain, detune, pan, t0, seconds) {
  const spec = TIMBRES[timbre];
  const n = out[0].length;
  for (const nt of notes) {
    if (nt.t1 <= t0 || nt.t0 >= t0 + seconds) continue;
    const f = 440 * Math.pow(2, (nt.note - 69) / 12) * detune;
    if (f > 6000) continue;
    const tab = table(timbre, f);
    const start = Math.max(0, Math.round((nt.t0 - t0) * FS));
    const holdEnd = Math.min(n, Math.round((nt.t1 - t0) * FS));
    const release = Math.round(0.08 * FS);
    const end = Math.min(n, holdEnd + release);
    const amp = gain * (nt.vel / 127) * Math.min(1, 220 / f + 0.4);
    let phase = Math.random() * 2048;
    const onset = Math.round((nt.t0 - t0) * FS);
    const fall = spec.decay ? Math.exp(-(spec.decay * (f / 300) ** 0.3) / FS) : 1;
    let dec = Math.pow(fall, Math.max(0, start - onset));
    const inc = (2048 * f) / FS;
    for (let i = start; i < end; i++) {
      const t = (i - onset) / FS;
      let env = t < spec.attack ? t / spec.attack : 1;
      if (spec.decay) { env *= spec.sustain + (1 - spec.sustain) * dec; dec *= fall; }
      if (i >= holdEnd) env *= 1 - (i - holdEnd) / release;
      phase += spec.vibrato ? inc * (1 + 0.004 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t * 3)) : inc;
      const v = amp * env * tab[Math.floor(phase) & 2047];
      out[0][i] += v * (1 - pan); out[1][i] += v * pan;
    }
  }
}

function drums(out, bpm, level, r) {
  const n = out[0].length, beat = (60 / bpm) * FS;
  let hp = 0, prev = 0;
  for (let b = 0; b * beat < n; b++) {
    const s = Math.round(b * beat);
    if (b % 2 === 0 || r() < 0.15) for (let i = 0; i < FS * 0.3 && s + i < n; i++) { const t = i / FS; const v = level * Math.sin(2 * Math.PI * (50 * t + 60 * (1 - Math.exp(-t * 30)) / 30)) * Math.exp(-t * 10); out[0][s + i] += v; out[1][s + i] += v; }
    if (b % 2 === 1) for (let i = 0; i < FS * 0.2 && s + i < n; i++) { const v = level * 0.6 * ((r() * 2 - 1) * 0.8 + 0.3 * Math.sin(2 * Math.PI * 190 * i / FS)) * Math.exp(-i / (FS * 0.05)); out[0][s + i] += v; out[1][s + i] += v; }
    for (const off of [0, 0.5]) {
      const hs = Math.round(s + off * beat);
      for (let i = 0; i < FS * 0.05 && hs + i < n; i++) { const x = r() * 2 - 1; hp = 0.6 * (hp + x - prev); prev = x; const v = level * 0.25 * hp * Math.exp(-i / (FS * 0.012)); out[0][hs + i] += v * 0.8; out[1][hs + i] += v; }
    }
  }
}

function reverb(out, mix) {
  for (const ch of out) {
    const n = ch.length, wet = new Float32Array(n);
    for (const [d, g] of [[1557, 0.82], [1617, 0.8], [1491, 0.81], [1422, 0.79]]) {
      const buf = new Float32Array(d); let idx = 0;
      for (let i = 0; i < n; i++) { const y = buf[idx]; buf[idx] = ch[i] + g * y; idx = (idx + 1) % d; wet[i] += y * 0.25; }
    }
    for (let i = 0; i < n; i++) ch[i] += mix * wet[i];
  }
}

function renderSong(midi, seed, only) {
  const r = rng(seed);
  const pick = (list) => list[Math.floor(r() * list.length)];
  const cents = r() < 0.5 ? 0 : (r() * 2 - 1) * 45;
  const detune = Math.pow(2, cents / 1200);
  const first = Math.min(...midi.tracks.flatMap((t) => t.notes.map((nt) => nt.t0)));
  const t0 = Math.max(0, first);
  const out = [new Float32Array(FS * SECONDS), new Float32Array(FS * SECONDS)];
  const used = [];
  for (const tr of midi.tracks) {
    const nm = tr.name.toUpperCase();
    if (only === 'melody' && !nm.includes('MELODY')) continue;
    if (only === 'chords' && nm.includes('MELODY')) continue;
    const timbre = nm.includes('MELODY') ? pick(['voice', 'voice', 'saw', 'square'])
      : nm.includes('BRIDGE') ? pick(['strings', 'epiano', 'guitar', 'saw', 'organ']) : pick(['piano', 'piano', 'epiano', 'guitar', 'organ', 'strings']);
    const gain = nm.includes('MELODY') ? 0.5 + r() * 0.4 : 0.15 + r() * 0.3;
    renderNotes(out, tr.notes, timbre, gain, detune, 0.3 + r() * 0.4, t0, SECONDS);
    used.push(timbre);
  }
  const drumLevel = r() < 0.15 || only ? 0 : 0.2 + r() * 0.9;
  if (drumLevel) drums(out, midi.bpm, drumLevel, r);
  reverb(out, r() * 0.4);
  const noise = r() < 0.3 ? 0.01 + r() * 0.03 : 0;
  let peak = 0;
  for (const ch of out) for (let i = 0; i < ch.length; i++) { ch[i] += noise * (r() * 2 - 1); peak = Math.max(peak, Math.abs(ch[i])); }
  for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] *= 0.9 / (peak || 1);
  return { channels: out, cents, timbres: used, drums: drumLevel, noise };
}

/* ---------- features ---------- */
const CONFIGS = [];
for (const harmonics of [1, 2, 4]) for (const weight of ['sqrt', 'lin', 'whiten']) CONFIGS.push({ harmonics, weight, decay: 0.6, low: 80, high: 5000 });

function features(audio) {
  const { x, rate } = K.prepare(audio.channels, FS);
  const frames = K.framePeaks(x, rate, { high: 5000 });
  const cents = K.tuning(frames);
  const ref = (440 * Math.pow(2, cents / 1200)) / Math.pow(2, 9 / 12);
  const out = {};
  for (const cfg of CONFIGS) {
    const c = new Float64Array(12), b = new Float64Array(12);
    for (const fr of frames) {
      const fc = K.frameChroma(fr, ref, cfg);
      const cm = Math.max(...fc.chroma), bm = Math.max(...fc.bass);
      if (cm > 0) for (let i = 0; i < 12; i++) c[i] += fc.chroma[i] / cm;
      if (bm > 0) for (let i = 0; i < 12; i++) b[i] += fc.bass[i] / bm;
    }
    out[`h${cfg.harmonics}-${cfg.weight}`] = { c: K.normalise(c).map((v) => +v.toFixed(4)), b: K.normalise(b).map((v) => +v.toFixed(4)) };
  }
  return { cents, features: out };
}

/* ---------- evaluation ---------- */
function mirex(t, m, truth) {
  if (t === truth.tonic && m === truth.mode) return 1;
  if (m === truth.mode && (t === (truth.tonic + 7) % 12 || t === (truth.tonic + 5) % 12)) return 0.5;
  const rel = truth.mode === 'major' ? [(truth.tonic + 9) % 12, 'minor'] : [(truth.tonic + 3) % 12, 'major'];
  if (t === rel[0] && m === rel[1]) return 0.3;
  if (t === truth.tonic && m !== truth.mode) return 0.2;
  return 0;
}
const rotate = (v, k) => v.map((_, i) => v[(i + k) % 12]);

function learn(rows, cfg) {
  const acc = { major: new Array(12).fill(0), minor: new Array(12).fill(0), bassMajor: new Array(12).fill(0), bassMinor: new Array(12).fill(0) };
  for (const r of rows) {
    const f = r.features[cfg];
    const c = rotate(f.c, r.tonic), b = rotate(f.b, r.tonic);
    for (let i = 0; i < 12; i++) { acc[r.mode][i] += c[i]; acc[r.mode === 'major' ? 'bassMajor' : 'bassMinor'][i] += b[i]; }
  }
  for (const k of Object.keys(acc)) { const m = Math.max(...acc[k]); acc[k] = acc[k].map((v) => +(v / m).toFixed(4)); }
  return acc;
}

function evaluate(rows, cfg, profile, bassWeight, learned) {
  const saved = M.keyProfiles;
  M.keyProfiles = learned || null;
  let score = 0, exact = 0;
  const kinds = { correct: 0, fifth: 0, relative: 0, parallel: 0, other: 0 };
  for (const r of rows) {
    const f = r.features[cfg];
    const best = K.scoreKeys(f.c, f.b, { profile, bassWeight })[0];
    const s = mirex(best.tonic, best.mode, r);
    score += s; if (s === 1) exact++;
    kinds[s === 1 ? 'correct' : s === 0.5 ? 'fifth' : s === 0.3 ? 'relative' : s === 0.2 ? 'parallel' : 'other']++;
  }
  M.keyProfiles = saved;
  return { weighted: score / rows.length, exact: exact / rows.length, kinds };
}

function fitTemperature(rows, cfg, bassWeight, learned) {
  M.keyProfiles = learned;
  let best = { t: 0.05, ll: Infinity };
  for (let t = 0.005; t <= 0.3; t *= 1.15) {
    let ll = 0;
    for (const r of rows) {
      const f = r.features[cfg];
      const ranked = K.scoreKeys(f.c, f.b, { profile: 'learned', bassWeight });
      const top = ranked[0].score;
      const z = ranked.reduce((s, k) => s + Math.exp((k.score - top) / t), 0);
      const truth = ranked.find((k) => k.tonic === r.tonic && k.mode === r.mode);
      ll -= Math.log(Math.max(1e-9, Math.exp((truth.score - top) / t) / z));
    }
    if (ll < best.ll) best = { t, ll };
  }
  return best.t;
}

async function main() {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === 'features') {
    const root = path.join(a, 'POP909');
    const shardArg = process.argv.indexOf('--shard');
    const [shard, shards] = shardArg > 0 ? process.argv[shardArg + 1].split('/').map(Number) : [0, 1];
    const ids = fs.readdirSync(root).filter((d) => /^\d+$/.test(d)).sort().filter((_, i) => i % shards === shard);
    /* Appends one line per song as it goes, and skips songs already in the file, so a restart resumes. */
    const have = new Set(fs.existsSync(b) ? fs.readFileSync(b, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id) : []);
    let done = have.size;
    for (const id of ids) {
      const keys = fs.readFileSync(path.join(root, id, 'key_audio.txt'), 'utf8').trim().split('\n');
      if (keys.length !== 1) continue;
      const [kname, kmode] = keys[0].trim().split(/\s+/)[2].split(':');
      if (!(kname in PC) || have.has(Number(id))) continue;
      const midi = parseMidi(fs.readFileSync(path.join(root, id, `${id}.mid`)));
      const audio = renderSong(midi, Number(id) * 7919);
      const t = Date.now();
      const feat = features(audio);
      fs.appendFileSync(b, `${JSON.stringify({ id: Number(id), tonic: PC[kname], mode: kmode === 'maj' ? 'major' : 'minor', trueCents: +audio.cents.toFixed(1), estCents: +feat.cents.toFixed(1), drums: +audio.drums.toFixed(2), noise: audio.noise > 0, timbres: audio.timbres, ms: Date.now() - t, features: feat.features })}\n`);
      if (++done % 50 === 0) console.error(`${done} songs`);
    }
    return;
  }
  if (cmd === 'evaluate') {
    const rows = fs.readFileSync(a, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const dev = rows.filter((r) => r.id % 2 === 1), test = rows.filter((r) => r.id % 2 === 0);
    console.log(`${rows.length} songs (${dev.length} to tune on, ${test.length} to test on)`);
    const tuneErr = rows.map((r) => Math.abs(r.estCents - r.trueCents));
    console.log(`tuning: median error ${M.dsp.percentile(tuneErr, 50).toFixed(1)} cents, 95th ${M.dsp.percentile(tuneErr, 95).toFixed(1)}`);
    const results = [];
    /* --cfg h1-lin limits the search to one feature setting (h1 = no overtone credit, which keeps a key's IV from
       borrowing the tonic's overtones; it scores within 0.1 points of h4 here and passes the clean progression tests). */
    const only = process.argv.includes('--cfg') ? process.argv[process.argv.indexOf('--cfg') + 1] : null;
    for (const cfg of Object.keys(rows[0].features).filter((c) => !only || c === only)) {
      for (const profile of ['krumhansl', 'temperley', 'shaath', 'albrecht']) {
        for (const bw of [0, 0.5]) results.push({ cfg, profile, bw, dev: evaluate(dev, cfg, profile, bw).weighted });
      }
      const learned = learn(dev, cfg);
      for (const bw of [0, 0.25, 0.5, 1]) results.push({ cfg, profile: 'learned', bw, dev: evaluate(dev, cfg, 'learned', bw, learned).weighted, learned });
    }
    results.sort((x, y) => y.dev - x.dev);
    console.log('Best settings on the tuning half:');
    results.slice(0, 8).forEach((r) => console.log(`  ${r.cfg.padEnd(10)} ${r.profile.padEnd(10)} bass ${r.bw}  ${(r.dev * 100).toFixed(1)}`));
    const bestPublished = results.find((r) => r.profile !== 'learned');
    const best = results[0];
    const show = (label, r) => {
      const t = evaluate(test, r.cfg, r.profile, r.bw, r.learned);
      console.log(`${label.padEnd(34)} weighted ${(t.weighted * 100).toFixed(1)}%  exact ${(t.exact * 100).toFixed(1)}%  ${JSON.stringify(t.kinds)}`);
      return t;
    };
    console.log('On the held-out half:');
    show(`Krumhansl, no tuning/bass tricks`, { cfg: 'h1-sqrt', profile: 'krumhansl', bw: 0 });
    show(`best published (${bestPublished.profile})`, bestPublished);
    /* --blend albrecht:0.8 mixes the learned templates with a published one, which keeps quirks of this dataset
       (here, a weak 4th degree in major) from deciding real songs; chosen on the tuning half. */
    if (process.argv.includes('--blend') && best.profile === 'learned') {
      const [pub, share] = process.argv[process.argv.indexOf('--blend') + 1].split(':');
      const a = Number(share);
      const norm = (v) => { const m = Math.max(...v); return v.map((x) => x / m); };
      const [pm, pn] = M.key.PUBLISHED[pub].map(norm);
      best.learned = { ...best.learned, major: best.learned.major.map((v, i) => +(a * v + (1 - a) * pm[i]).toFixed(4)), minor: best.learned.minor.map((v, i) => +(a * v + (1 - a) * pn[i]).toFixed(4)), blend: `${pub}:${a}` };
    }
    const final = show(`chosen (${best.profile}, ${best.cfg}, bass ${best.bw})`, best);
    if (b === '--write' && best.profile === 'learned') {
      const temperature = fitTemperature(dev, best.cfg, best.bw, best.learned);
      const [h, w] = best.cfg.slice(1).split('-');
      const body = { source: 'POP909 (MIT), odd-numbered songs rendered to audio', songs: dev.length, settings: { harmonics: Number(h), weight: w, bassWeight: best.bw }, temperature: +temperature.toFixed(4), test: { songs: test.length, weighted: +final.weighted.toFixed(3), exact: +final.exact.toFixed(3), kinds: final.kinds }, ...best.learned };
      fs.writeFileSync(path.join(__dirname, '..', 'src', 'keyprofiles.js'),
        `/* Generated by tools/keybench.js: key templates learned from labelled songs. Numbers only. */\n(function (root) {\n  'use strict';\n  const M = (root.MuSixk = root.MuSixk || {});\n  M.keyProfiles = ${JSON.stringify(body)};\n})(typeof self !== 'undefined' ? self : globalThis);\n`);
      console.log(`wrote src/keyprofiles.js (temperature ${temperature.toFixed(4)})`);
    }
    return;
  }
  if (cmd === 'robust') {
    /* The finished detector (src/keyprofiles.js) on held-out songs under harder conditions. */
    require('../src/keyprofiles.js');
    const root = path.join(a, 'POP909');
    const limit = Number(b) || 120;
    const ids = fs.readdirSync(root).filter((d) => /^\d+$/.test(d) && Number(d) % 2 === 0).sort().filter((id) => {
      const keys = fs.readFileSync(path.join(root, id, 'key_audio.txt'), 'utf8').trim().split('\n');
      return keys.length === 1;
    }).slice(0, limit);
    const onePole = (x, fc) => { const k = Math.exp((-2 * Math.PI * fc) / FS); let y = 0; return x.map((v) => (y = (1 - k) * v + k * y)); };
    const conditions = {
      'full song excerpt (60 s)': (au) => au.channels,
      'first 15 seconds': (au) => au.channels.map((ch) => ch.slice(0, FS * 15)),
      'phone recording (300-3400 Hz)': (au) => au.channels.map((ch) => { const lp = onePole(onePole(ch, 3400), 3400); const lo = onePole(lp, 300); return lp.map((v, i) => v - lo[i]); }),
      'noisy room (10 dB SNR)': (au) => { const r = rng(5); return au.channels.map((ch) => { let p = 0; for (const v of ch) p += v * v; const amp = Math.sqrt((3 * p) / ch.length / 10); return ch.map((v) => v + amp * (r() * 2 - 1)); }); },
    };
    const tally = {};
    const add = (name, s) => { const t = (tally[name] = tally[name] || { n: 0, w: 0, e: 0 }); t.n++; t.w += s; if (s === 1) t.e++; };
    for (const id of ids) {
      const [kname, kmode] = fs.readFileSync(path.join(root, id, 'key_audio.txt'), 'utf8').trim().split(/\s+/)[2].split(':');
      const truth = { tonic: PC[kname], mode: kmode === 'maj' ? 'major' : 'minor' };
      const midi = parseMidi(fs.readFileSync(path.join(root, id, `${id}.mid`)));
      const full = renderSong(midi, Number(id) * 7919);
      for (const [name, fn] of Object.entries(conditions)) { const k = M.key.detect(fn(full), FS); add(name, k ? mirex(k.tonic, k.mode, truth) : 0); }
      for (const only of ['melody', 'chords']) {
        const k = M.key.detect(renderSong(midi, Number(id) * 7919, only).channels, FS);
        add(only === 'melody' ? 'singing only (melody line)' : 'chords only (no melody, no drums)', k ? mirex(k.tonic, k.mode, truth) : 0);
      }
    }
    for (const [name, t] of Object.entries(tally)) console.log(`${name.padEnd(36)} exact ${((100 * t.e) / t.n).toFixed(1)}%  weighted ${((100 * t.w) / t.n).toFixed(1)}%  (${t.n} songs)`);
    return;
  }
  console.error('Usage: node tools/keybench.js features <POP909 folder> <out.jsonl> | evaluate <features.jsonl> [--write]');
  process.exit(1);
}

module.exports = { parseMidi, renderSong, mirex, FS };
if (require.main === module) main();
