/* Mu-sixk timeline: splits a song into sections where its sound changes, and summarises each one. */
(function (root) {
  'use strict';
  const M = (root.MuSixk = root.MuSixk || {});
  const { toDb, mean, stdev } = M.dsp;

  const pow = (db) => Math.pow(10, db / 10);

  /* One row per second: loudness, the energy in each of the seven regions, and width. */
  function perSecond(frames, momentary, duration) {
    const secs = Math.max(1, Math.ceil(duration));
    const reg = Array.from({ length: secs }, () => new Float64Array(7));
    const mid = new Float64Array(secs), side = new Float64Array(secs), count = new Float64Array(secs);
    frames.t.forEach((t, i) => {
      const s = Math.min(secs - 1, Math.floor(t));
      const r = frames.reg[i];
      for (let k = 0; k < 7; k++) reg[s][k] += r[k];
      mid[s] += frames.midP[i]; side[s] += frames.sideP[i]; count[s]++;
    });
    const loud = new Float64Array(secs), loudN = new Float64Array(secs);
    momentary.forEach((db, i) => {
      const s = Math.min(secs - 1, Math.floor((i + 2) * 0.1));
      if (db > -70) { loud[s] += pow(db + 0.691); loudN[s]++; }
    });
    return Array.from({ length: secs }, (_, s) => ({
      lufs: loudN[s] ? -0.691 + toDb(loud[s] / loudN[s]) : -70,
      reg: reg[s], width: mid[s] > 0 ? toDb(side[s] + 1e-20) - toDb(mid[s]) : -40, has: count[s] > 0,
    }));
  }

  /* Foote novelty on a per-second feature path; boundaries where the past and future look most different. */
  function boundaries(rows) {
    const n = rows.length;
    if (n < 16) return [];
    const K = Math.max(3, Math.min(6, Math.round(n / 10)));
    const minLen = Math.max(4, Math.min(8, Math.round(n / 8)));
    const feat = rows.map((r) => {
      const total = r.reg.reduce((a, b) => a + b, 0) || 1e-20;
      return [r.lufs, ...Array.from(r.reg, (p) => toDb(p / total + 1e-12)), Math.max(-40, r.width)];
    });
    const dims = feat[0].length;
    const mu = [], sd = [];
    for (let d = 0; d < dims; d++) {
      const col = feat.map((f) => f[d]);
      mu.push(mean(col)); sd.push(stdev(col) || 1);
    }
    const z = feat.map((f) => f.map((v, d) => Math.max(-3, Math.min(3, (v - mu[d]) / sd[d]))));
    const sm = z.map((_, t) => {
      const lo = Math.max(0, t - 1), hi = Math.min(n - 1, t + 1);
      return Array.from({ length: dims }, (_, d) => { let s = 0; for (let u = lo; u <= hi; u++) s += z[u][d]; return s / (hi - lo + 1); });
    });
    const dist = (a, b) => { let s = 0; for (let d = 0; d < dims; d++) s += (a[d] - b[d]) ** 2; return Math.sqrt(s / dims); };
    const nov = new Float64Array(n);
    for (let t = K; t <= n - K; t++) {
      let cross = 0, within = 0;
      for (let i = t - K; i < t; i++) for (let j = t; j < t + K; j++) cross += dist(sm[i], sm[j]);
      for (let i = t - K; i < t; i++) for (let j = i + 1; j < t; j++) within += dist(sm[i], sm[j]);
      for (let i = t; i < t + K; i++) for (let j = i + 1; j < t + K; j++) within += dist(sm[i], sm[j]);
      nov[t] = cross / (K * K) - within / (K * (K - 1));
    }
    const vals = Array.from(nov).filter((v) => v > 0);
    const thr = vals.length ? Math.max(0.12, 0.8 * mean(vals)) : Infinity;
    const peaks = [];
    for (let t = K; t <= n - K; t++) if (nov[t] > thr && nov[t] >= nov[t - 1] && nov[t] >= nov[t + 1]) peaks.push(t);
    peaks.sort((a, b) => nov[b] - nov[a]);
    const chosen = [];
    for (const p of peaks) {
      if (chosen.length >= 14) break;
      if (p < minLen || n - p < minLen || chosen.some((c) => Math.abs(c - p) < minLen)) continue;
      chosen.push(p);
    }
    return chosen.sort((a, b) => a - b);
  }

  function sections(rows) {
    const cuts = [0, ...boundaries(rows), rows.length];
    const list = [];
    for (let i = 0; i < cuts.length - 1; i++) {
      const part = rows.slice(cuts[i], cuts[i + 1]);
      const live = part.filter((r) => r.lufs > -60);
      const reg = new Float64Array(7);
      let mid = 0;
      part.forEach((r) => r.reg.forEach((p, k) => { reg[k] += p; }));
      const total = reg.reduce((a, b) => a + b, 0) || 1e-20;
      const widths = part.filter((r) => r.has).map((r) => r.width);
      list.push({
        start: cuts[i], end: cuts[i + 1],
        lufs: live.length ? -0.691 + toDb(mean(live.map((r) => pow(r.lufs + 0.691)))) : -70,
        regions: Object.fromEntries(M.REGIONS.map((r, k) => [r.id, toDb(reg[k] / total + 1e-12)])),
        widthDb: widths.length ? mean(widths) : -40,
        tags: [],
      });
      void mid;
    }
    /* Letters: sections that sound alike share one. */
    const sig = (s) => [s.lufs / 3, ...M.REGIONS.map((r) => s.regions[r.id] / 3), s.widthDb / 6];
    const reps = [];
    list.forEach((s) => {
      const v = sig(s);
      let best = -1, bestD = Infinity;
      reps.forEach((r, i) => { const d = Math.sqrt(mean(v.map((x, k) => (x - r[k]) ** 2))); if (d < bestD) { bestD = d; best = i; } });
      if (best >= 0 && bestD < 0.4) s.letter = String.fromCharCode(65 + best);
      else { reps.push(v); s.letter = String.fromCharCode(65 + reps.length - 1); }
    });
    const live = list.filter((s) => s.lufs > -60);
    if (live.length >= 3) {
      const top = Math.max(...live.map((s) => s.lufs));
      const med = M.dsp.percentile(live.map((s) => s.lufs), 50);
      live.forEach((s) => { if (s.lufs >= top - 1 && top - med >= 1) s.tags.push('loudest'); });
      if (list[0].lufs < med - 4) list[0].tags.push('intro');
      if (list.length > 2 && list[list.length - 1].lufs < med - 4) list[list.length - 1].tags.push('outro');
    }
    return list;
  }

  /* Where to take the model's listening samples: up to `max` stretches spread over the playing parts. */
  function pickSegments(momentary, lufs, n, fs, max = 12) {
    const len = Math.min(n, Math.round(fs * 6));
    if (n <= len * 1.5) return [{ start: 0, len: n }];
    const cands = [];
    for (let start = 0; start + len <= n; start += len) {
      const a = Math.floor(start / (fs * 0.1)), b = Math.floor((start + len) / (fs * 0.1)) - 4;
      const vals = momentary.slice(a, Math.max(a + 1, b)).filter((v) => v > -70);
      const level = vals.length ? -0.691 + toDb(mean(vals.map((v) => pow(v + 0.691)))) : -70;
      if (level > lufs - 12) cands.push({ start, len });
    }
    if (cands.length <= max) return cands.length ? cands : [{ start: 0, len }];
    return Array.from({ length: max }, (_, i) => cands[Math.round((i * (cands.length - 1)) / (max - 1))]);
  }

  M.timeline = { perSecond, sections, pickSegments };
})(typeof self !== 'undefined' ? self : globalThis);
