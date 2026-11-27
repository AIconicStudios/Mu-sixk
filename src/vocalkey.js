/* Mu-sixk vocal key finder: the key of a voice (or any single-note line) from the notes sung.
   1. Track the sung pitch every 10 ms (YIN, Cheveigne & Kawahara 2002), skipping breaths and consonants.
   2. Measure the singer's overall tuning, then turn the pitch curve into notes, ignoring vibrato and slides.
   3. Count how long each note is held and which notes end phrases.
   4. Score all 24 keys against melody templates learned from real song melodies (src/keyprofiles.js).
   Shares naming, chords and confidence handling with src/key.js. */
(function (root) {
  'use strict';
  const M = (root.MuSixk = root.MuSixk || {});
  const { fft } = M.dsp;

  /* Melody templates used when no learned ones are loaded (tonic first). */
  const FALLBACK = {
    major: [1, 0.05, 0.6, 0.05, 0.75, 0.45, 0.05, 0.85, 0.05, 0.55, 0.05, 0.3],
    minor: [1, 0.05, 0.5, 0.75, 0.05, 0.5, 0.05, 0.85, 0.35, 0.05, 0.5, 0.15],
    finalMajor: [1, 0.02, 0.35, 0.02, 0.5, 0.15, 0.02, 0.55, 0.02, 0.35, 0.02, 0.1],
    finalMinor: [1, 0.02, 0.3, 0.45, 0.02, 0.2, 0.02, 0.55, 0.1, 0.02, 0.25, 0.05],
  };
  const DEFAULTS = { finalWeight: 0.5, minNote: 0.09, threshold: 0.15, gate: 0.08, apKeep: 0.25 };

  /* Mono, low-passed and decimated to ~11 kHz: enough for any sung fundamental up to ~1.1 kHz. */
  function toLowRate(channels, fs) {
    const { x, rate } = M.key._internal.prepare(channels, fs);
    let y = x, r = rate;
    while (r > 14000) {
      const m = Math.floor(y.length / 2), z = new Float32Array(m);
      let a = 0, b = 0;
      for (let i = 0; i < m; i++) {
        const v = 0.25 * y[2 * i - 1 >= 0 ? 2 * i - 1 : 0] + 0.5 * y[2 * i] + 0.25 * (y[2 * i + 1] || 0);
        a = 0.6 * a + 0.4 * v; b = 0.6 * b + 0.4 * a; z[i] = b;
      }
      y = z; r /= 2;
    }
    return { x: y, rate: r };
  }

  /* YIN pitch track: f0 (Hz, 0 when unvoiced) and how clearly periodic each 10 ms frame is (0 = perfectly). */
  function pitchTrack(x, rate, opts = {}) {
    const fMin = opts.fMin || 75, fMax = 1100;
    const tauMin = Math.floor(rate / fMax), tauMax = Math.ceil(rate / fMin);
    const W = 1 << Math.ceil(Math.log2(tauMax * 1.6));
    const N = W * 2;
    const hop = Math.round(rate * 0.01);
    const frames = Math.max(0, Math.floor((x.length - W - tauMax) / hop));
    const f0 = new Float32Array(frames), ap = new Float32Array(frames), rms = new Float32Array(frames);
    const re = new Float64Array(N), im = new Float64Array(N), d = new Float64Array(tauMax + 1), cmnd = new Float64Array(tauMax + 1);
    const thr = opts.threshold || DEFAULTS.threshold;
    let peakRms = 0;
    for (let f = 0; f < frames; f++) {
      const s = f * hop;
      let e = 0;
      for (let i = 0; i < W; i++) e += x[s + i] * x[s + i];
      rms[f] = Math.sqrt(e / W);
      if (rms[f] > peakRms) peakRms = rms[f];
    }
    const gate = peakRms * (opts.gate || 0.03);
    for (let f = 0; f < frames; f++) {
      ap[f] = 1;
      if (rms[f] < gate) continue;
      const s = f * hop;
      /* Difference function via one FFT autocorrelation: d(t) = E0 + Et - 2 r(t). */
      re.fill(0); im.fill(0);
      for (let i = 0; i < W + tauMax && i < N; i++) re[i] = x[s + i] || 0;
      const seg = re.slice(0, W + tauMax);
      for (let i = W; i < N; i++) im[i] = 0;
      const a = new Float64Array(N), ai = new Float64Array(N), b = new Float64Array(N), bi = new Float64Array(N);
      for (let i = 0; i < W; i++) a[i] = seg[i];
      for (let i = 0; i < W + tauMax && i < N; i++) b[i] = seg[i];
      fft(a, ai); fft(b, bi);
      for (let k = 0; k < N; k++) { const r0 = a[k] * b[k] + ai[k] * bi[k], i0 = a[k] * bi[k] - ai[k] * b[k]; a[k] = r0; ai[k] = -i0; }
      fft(a, ai);
      let e0 = 0;
      for (let i = 0; i < W; i++) e0 += seg[i] * seg[i];
      let et = e0;
      d[0] = 0;
      for (let t = 1; t <= tauMax; t++) {
        et += seg[W + t - 1] * seg[W + t - 1] - seg[t - 1] * seg[t - 1];
        d[t] = Math.max(0, e0 + et - (2 * a[t]) / N);
      }
      let run = 0;
      cmnd[0] = 1;
      for (let t = 1; t <= tauMax; t++) { run += d[t]; cmnd[t] = run > 0 ? (d[t] * t) / run : 1; }
      let tau = -1;
      for (let t = tauMin; t < tauMax; t++) {
        if (cmnd[t] < thr) { while (t + 1 < tauMax && cmnd[t + 1] < cmnd[t]) t++; tau = t; break; }
      }
      if (tau < 0) {
        let best = tauMin;
        for (let t = tauMin; t < tauMax; t++) if (cmnd[t] < cmnd[best]) best = t;
        if (cmnd[best] > (opts.apMax || 0.35)) continue;
        tau = best;
      }
      const y0 = cmnd[tau - 1], y1 = cmnd[tau], y2 = cmnd[tau + 1] !== undefined ? cmnd[tau + 1] : y1;
      const den = y0 - 2 * y1 + y2;
      const shift = den > 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den)) : 0;
      f0[f] = rate / (tau + shift);
      ap[f] = y1;
    }
    return { f0, ap, rms, hop: 0.01 };
  }

  /* Singer's overall tuning (cents) from where the voiced frames sit between semitones. */
  function tuningOf(track) {
    let c = 0, s = 0;
    for (let i = 0; i < track.f0.length; i++) {
      if (!track.f0[i]) continue;
      const m = 69 + 12 * Math.log2(track.f0[i] / 440), w = 1 - track.ap[i];
      c += w * Math.cos(2 * Math.PI * m); s += w * Math.sin(2 * Math.PI * m);
    }
    return c === 0 && s === 0 ? 0 : (100 * Math.atan2(s, c)) / (2 * Math.PI);
  }

  /* Notes from the pitch track: median-smoothed, octave jumps repaired, held at least `minNote` seconds. */
  function toNotes(track, cents, opts = {}) {
    const n = track.f0.length, dt = track.hop;
    const midi = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) if (track.f0[i]) midi[i] = 69 + 12 * Math.log2(track.f0[i] / 440) - cents / 100;
    /* Repair single octave errors against the neighbourhood median. */
    const sm = new Float64Array(n).fill(NaN);
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(midi[i])) continue;
      const win = [];
      for (let j = Math.max(0, i - 4); j <= Math.min(n - 1, i + 4); j++) if (!Number.isNaN(midi[j])) win.push(midi[j]);
      win.sort((a, b) => a - b);
      const med = win[win.length >> 1];
      let v = midi[i];
      while (v - med > 9) v -= 12;
      while (med - v > 9) v += 12;
      sm[i] = v;
    }
    const notes = [];
    const minFrames = Math.round((opts.minNote || DEFAULTS.minNote) / dt);
    let start = -1, cur = null, vals = [];
    const close = (end) => {
      if (start >= 0 && end - start >= minFrames) {
        const sorted = vals.slice().sort((a, b) => a - b);
        const pitch = sorted[sorted.length >> 1];
        notes.push({ start: start * dt, end: end * dt, midi: Math.round(pitch), cents: Math.round((pitch - Math.round(pitch)) * 100) });
      }
      start = -1; cur = null; vals = [];
    };
    for (let i = 0; i < n; i++) {
      const v = sm[i];
      if (Number.isNaN(v)) { close(i); continue; }
      /* A note continues while the smoothed pitch stays within 70 cents of its running centre (vibrato fits). */
      if (cur !== null && Math.abs(v - cur) <= 0.7) { vals.push(v); cur = 0.9 * cur + 0.1 * v; continue; }
      close(i);
      start = i; cur = v; vals = [v];
    }
    close(n);
    /* Merge repeats of the same note split by a tiny gap. */
    const merged = [];
    for (const nt of notes) {
      const last = merged[merged.length - 1];
      if (last && last.midi === nt.midi && nt.start - last.end < 0.06) last.end = nt.end;
      else merged.push({ ...nt });
    }
    return merged;
  }

  /* Duration-weighted note histogram, and the notes that end phrases (followed by a pause, or last). */
  function histograms(notes) {
    const dur = new Array(12).fill(0), fin = new Array(12).fill(0);
    notes.forEach((nt, i) => {
      const pc = ((nt.midi % 12) + 12) % 12;
      const len = Math.min(1.5, nt.end - nt.start);
      dur[pc] += len;
      const next = notes[i + 1];
      if (!next || next.start - nt.end > 0.25) fin[pc] += 0.5 + len;
    });
    return { dur, fin };
  }

  function corr(a, b) { return M.key._internal.corr ? M.key._internal.corr(a, b) : pearson(a, b); }
  function pearson(a, b) {
    let ma = 0, mb = 0;
    for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; }
    ma /= 12; mb /= 12;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < 12; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  }

  function templates() {
    const L = M.keyProfiles && M.keyProfiles.vocal;
    return L || FALLBACK;
  }

  function scoreMelody(hist, opts = {}) {
    const T = templates();
    const fw = opts.finalWeight != null ? opts.finalWeight : (M.keyProfiles && M.keyProfiles.vocal && M.keyProfiles.vocal.finalWeight) || DEFAULTS.finalWeight;
    const hasFinal = hist.fin.some((v) => v > 0);
    const out = [];
    for (let tonic = 0; tonic < 12; tonic++) {
      const d = hist.dur.map((_, i) => hist.dur[(i + tonic) % 12]);
      const f = hist.fin.map((_, i) => hist.fin[(i + tonic) % 12]);
      for (const mode of ['major', 'minor']) {
        const score = pearson(d, T[mode]) + (hasFinal ? fw * pearson(f, mode === 'major' ? T.finalMajor : T.finalMinor) : 0);
        out.push({ tonic, mode, score });
      }
    }
    return out.sort((a, b) => b.score - a.score);
  }

  function noteName(midi) { return `${M.key.NOTES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`; }

  /* Main entry: the key of a voice. Returns the same shape as M.key.detect plus notes and range. */
  function detect(channels, fs, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const { x, rate } = toLowRate(channels, fs);
    const track = pitchTrack(x, rate, opts);
    if (opts.apKeep) for (let i = 0; i < track.f0.length; i++) if (track.ap[i] > opts.apKeep) track.f0[i] = 0;
    const cents = tuningOf(track);
    const notes = toNotes(track, cents, opts);
    const voiced = track.f0.reduce((s, v) => s + (v ? 1 : 0), 0) / Math.max(1, track.f0.length);
    let loud = 0, clear = 0;
    for (let i = 0; i < track.f0.length; i++) { if (track.rms[i] <= 0) continue; loud++; if (track.f0[i] && track.ap[i] < 0.12) clear++; }
    const clarity = loud ? clear / loud : 0;
    const sung = notes.reduce((s, nt) => s + nt.end - nt.start, 0);
    if (notes.length < 4 || sung < 1.5) return null;
    const hist = histograms(notes);
    const seconds = x.length / rate;
    /* Melody evidence plus the spectrum of the same recording (which also hears backing harmonies and doubles). */
    const vp = (M.keyProfiles && M.keyProfiles.vocal) || {};
    const wSpec = opts.spectralWeight != null ? opts.spectralWeight : vp.spectralWeight != null ? vp.spectralWeight : 1;
    let combined = scoreMelody(hist, opts);
    const spectral = wSpec ? M.key.detect(channels, fs) : null;
    if (spectral) {
      const sp = new Map(spectral.ranked.map((k) => [`${k.tonic}${k.mode}`, k.score]));
      combined = combined.map((k) => ({ ...k, score: k.score + wSpec * (sp.get(`${k.tonic}${k.mode}`) || 0) })).sort((a, b) => b.score - a.score);
    }
    const ranked = M.key._internal.confidences(combined, seconds, opts.temperature || vp.temperature || 0.08);
    const result = M.key._internal.describe(ranked);
    const max = Math.max(...hist.dur);
    result.chroma = hist.dur.map((v) => v / (max || 1));
    result.tuningCents = cents;
    result.referenceA = 440 * Math.pow(2, cents / 1200);
    result.seconds = seconds;
    result.ranked = ranked;
    result.vocal = true;
    result.notes = notes;
    result.voiced = voiced;
    result.clarity = clarity;
    const sortedMidi = notes.map((nt) => nt.midi).sort((a, b) => a - b);
    const lo = sortedMidi[Math.floor(sortedMidi.length * 0.03)], hi = sortedMidi[Math.min(sortedMidi.length - 1, Math.floor(sortedMidi.length * 0.97))];
    result.range = { low: noteName(lo), high: noteName(hi), semitones: hi - lo };
    result.offKey = notes.filter((nt) => !result.scalePcs.includes(((nt.midi % 12) + 12) % 12)).reduce((s, nt) => s + nt.end - nt.start, 0) / (sung || 1);
    result.intonation = Math.round(Math.sqrt(notes.reduce((s, nt) => s + nt.cents * nt.cents * (nt.end - nt.start), 0) / (sung || 1)));
    result.timeline = [];
    return result;
  }

  /* Is this a single voice or instrument line (use detect) or a full mix / chords (use M.key.detect)? */
  function isSingleLine(channels, fs) {
    const { x, rate } = toLowRate(channels, fs);
    const track = pitchTrack(x, rate);
    let loud = 0, clear = 0;
    for (let i = 0; i < track.f0.length; i++) {
      if (track.rms[i] <= 0) continue;
      loud++;
      if (track.f0[i] && track.ap[i] < 0.12) clear++;
    }
    return { single: loud > 0 && clear / loud > 0.45, clarity: loud ? clear / loud : 0 };
  }

  /* Pick the method: 'voice' (single sung or played line), 'song' (full mix, chords) or 'auto'. */
  function auto(channels, fs, mode = 'auto') {
    if (mode === 'song') return M.key.detect(channels, fs);
    const v = detect(channels, fs);
    if (mode === 'voice') return v || M.key.detect(channels, fs);
    if (v && v.clarity > 0.45) return v;
    return M.key.detect(channels, fs);
  }

  M.vocalKey = { auto, detect, isSingleLine, pitchTrack, toNotes, histograms, scoreMelody, tuningOf, toLowRate, FALLBACK };
})(typeof self !== 'undefined' ? self : globalThis);
