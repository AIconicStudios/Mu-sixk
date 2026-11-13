/* Mu-sixk demo material: a short synthetic loop with deliberate mix problems, so the app has
   something to show before the user loads their own audio. Not real instruments. */
(function (root) {
  'use strict';
  const M = (root.MuSixk = root.MuSixk || {});
  const FS = 44100, BPM = 100, BARS = 6;

  function makeDemoStems() {
    const beat = (60 / BPM) * FS;
    const n = Math.round(beat * 4 * BARS);
    let seed = 7;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    const buf = () => new Float32Array(n);
    const resonator = (f, q) => {
      const w = (2 * Math.PI * f) / FS, alpha = Math.sin(w) / (2 * q), a0 = 1 + alpha;
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      return (x) => {
        const y = (alpha * x - alpha * x2 + 2 * Math.cos(w) * y1 - (1 - alpha) * y2) / a0;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return y;
      };
    };

    const kick = buf();
    for (let b = 0; b < BARS * 4; b++) {
      const start = Math.round(b * beat);
      let phase = 0;
      for (let i = 0; i < FS * 0.35 && start + i < n; i++) {
        const t = i / FS;
        phase += (2 * Math.PI * (48 + 90 * Math.exp(-t * 35))) / FS;
        kick[start + i] += 0.9 * Math.sin(phase) * Math.exp(-t * 9);
      }
    }

    const bass = buf();
    const roots = [55, 55, 65.4, 49];
    let lp = 0;
    for (let i = 0; i < n; i++) {
      const pos = i / beat;
      const f = roots[Math.floor(pos / 4) % 4];
      const env = Math.exp(-((pos * 2) % 1) * 1.6);
      const saw = 2 * (((i * f) / FS) % 1) - 1;
      lp += 0.035 * (saw - lp);
      bass[i] = 0.55 * env * (lp + 0.5 * Math.sin((2 * Math.PI * f * i) / FS));
    }

    const keysL = buf(), keysR = buf();
    const chords = [[220, 261.6, 329.6], [220, 261.6, 329.6], [196, 261.6, 329.6], [196, 246.9, 293.7]];
    for (let i = 0; i < n; i++) {
      const pos = i / beat;
      const chord = chords[Math.floor(pos / 4) % 4];
      const env = 0.4 + 0.6 * Math.exp(-(pos % 2) * 1.2);
      let l = 0, r = 0;
      chord.forEach((f, k) => {
        for (let h = 1; h <= 3; h++) {
          const s = Math.sin((2 * Math.PI * f * h * i) / FS + k) / (h * h);
          l += s * (k === 1 ? 0.4 : 1); r += s * (k === 1 ? 1 : 0.4);
        }
      });
      keysL[i] = 0.12 * env * l; keysR[i] = 0.12 * env * r;
    }

    const hats = buf();
    let hp = 0;
    for (let e = 0; e < BARS * 8; e++) {
      const start = Math.round((e * beat) / 2);
      for (let i = 0; i < FS * 0.06 && start + i < n; i++) {
        const x = rand();
        hp += 0.25 * (x - hp);
        hats[start + i] += 0.1 * (e % 2 ? 1 : 0.6) * (x - hp) * Math.exp(-i / (FS * 0.012));
      }
    }

    const vocal = buf();
    const f1 = resonator(650, 6), f2 = resonator(1250, 8), f3 = resonator(2700, 9), ess = resonator(7200, 2.5);
    const melody = [220, 247, 262, 294, 262, 247, 220, 196];
    let phase = 0;
    for (let i = 0; i < n; i++) {
      const pos = i / beat;
      const note = Math.floor(pos / 2) % melody.length;
      const inNote = (pos / 2) % 1;
      const singing = inNote < 0.8 && Math.floor(pos / 8) % 3 !== 2;
      const f = melody[note] * (1 + 0.006 * Math.sin((2 * Math.PI * 5.5 * i) / FS));
      phase += f / FS;
      const src = singing ? 2 * (phase % 1) - 1 : 0;
      const loud = note % 3 === 0 ? 1.7 : note % 3 === 1 ? 0.55 : 1; // uneven performance on purpose
      const env = Math.min(1, inNote * 20) * Math.min(1, (0.8 - inNote) * 12);
      const voiced = (f1(src) + 0.7 * f2(src) + 0.35 * f3(src)) * loud * Math.max(env, 0);
      const s = inNote > 0.8 && inNote < 0.88 ? ess(rand()) * 0.9 : ess(0);
      vocal[i] = 0.32 * voiced + 0.3 * s + 0.0006 * rand();
    }

    return [
      { name: 'Lead Vocal.wav', channels: [vocal], sampleRate: FS },
      { name: 'Kick.wav', channels: [kick], sampleRate: FS },
      { name: 'Bass.wav', channels: [bass], sampleRate: FS },
      { name: 'Keys.wav', channels: [keysL, keysR], sampleRate: FS },
      { name: 'Hats.wav', channels: [hats], sampleRate: FS },
    ];
  }

  /* A rough bounce of the stems: bass too hot, top end missing, pushed into clipping. */
  function makeDemoMix(stems) {
    const n = stems[0].channels[0].length;
    const L = new Float32Array(n), R = new Float32Array(n);
    const gains = { 'Lead Vocal.wav': 0.7, 'Kick.wav': 0.9, 'Bass.wav': 1.9, 'Keys.wav': 1.2, 'Hats.wav': 0.5 };
    for (const s of stems) {
      const g = gains[s.name];
      const l = s.channels[0], r = s.channels[1] || s.channels[0];
      for (let i = 0; i < n; i++) { L[i] += g * l[i]; R[i] += g * r[i]; }
    }
    for (let i = 0; i < n; i++) {
      L[i] = Math.max(-1, Math.min(1, L[i] * 1.5));
      R[i] = Math.max(-1, Math.min(1, R[i] * 1.5));
    }
    return { name: 'Demo loop (synthetic)', channels: [L, R], sampleRate: FS };
  }

  M.demo = { makeDemoStems, makeDemoMix };
})(typeof self !== 'undefined' ? self : globalThis);
