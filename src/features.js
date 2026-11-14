/* Mu-sixk segment features: what a few seconds of a mix look like once it is split into
   centre/sides and into sustained (harmonic) and hit-like (percussive) sound.
   The same code feeds the trained element-level model in the app and in tools/train-elements.js,
   so any change here means retraining. */
(function (root) {
  'use strict';
  const M = (root.MuSixk = root.MuSixk || {});
  const { fft, hann, toDb } = M.dsp;

  const EDGES = [30, 60, 120, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const WIDE = [[30, 250], [250, 1000], [1000, 4000], [4000, 8000], [8000, 16000]];
  const VOX = [250, 4000];
  const NAMES = [
    ...EDGES.slice(0, -1).map((f, i) => `mid ${f}-${EDGES[i + 1]}`),
    ...WIDE.map(([a, b]) => `side/mid ${a}-${b}`),
    ...EDGES.slice(0, -1).map((f, i) => `perc ${f}-${EDGES[i + 1]}`),
    'centre harmonic vox', 'side harmonic vox', 'vox modulation 3-8 Hz', 'vox flatness',
    'onset rate', 'kick pulse', 'crest',
    ...EDGES.slice(0, -1).map((f, i) => `harm share ${f}-${EDGES[i + 1]}`),
    ...EDGES.slice(0, -1).map((f, i) => `perc share ${f}-${EDGES[i + 1]}`),
    ...WIDE.map(([a, b]) => `movement ${a}-${b}`),
    ...WIDE.map(([a, b]) => `contrast ${a}-${b}`),
  ];
  const cap = (v) => Math.max(-80, Math.min(30, v));

  /* Short-time spectra of the centre (mid) and sides, one FFT per frame via the two-real-signals trick. */
  function stft(L, R, fs, start, len) {
    const N = fs > 60000 ? 4096 : 2048;
    const hop = N / 4;
    const df = fs / N;
    const bins = Math.min(N / 2, Math.floor(16000 / df)) + 1;
    const frames = Math.max(1, Math.floor((len - N) / hop) + 1);
    const win = hann(N);
    const mid = new Float32Array(frames * bins);
    const side = new Float32Array(frames * bins);
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let t = 0; t < frames; t++) {
      const base = start + t * hop;
      for (let i = 0; i < N; i++) {
        const j = base + i;
        const l = j < L.length ? L[j] : 0, r = j < R.length ? R[j] : 0;
        re[i] = 0.5 * (l + r) * win[i];
        im[i] = 0.5 * (l - r) * win[i];
      }
      fft(re, im);
      for (let k = 1; k < bins; k++) {
        const zr = re[k], zi = im[k], cr = re[N - k], ci = im[N - k];
        const xr = 0.5 * (zr + cr), xi = 0.5 * (zi - ci);
        const yr = 0.5 * (zi + ci), yi = -0.5 * (zr - cr);
        mid[t * bins + k] = Math.sqrt(xr * xr + xi * xi);
        side[t * bins + k] = Math.sqrt(yr * yr + yi * yi);
      }
    }
    return { N, hop, df, bins, frames, mid, side, rate: fs / hop };
  }

  function median(buf, n) {
    for (let i = 1; i < n; i++) {
      const v = buf[i];
      let j = i - 1;
      while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
      buf[j + 1] = v;
    }
    return n & 1 ? buf[n >> 1] : 0.5 * (buf[(n >> 1) - 1] + buf[n >> 1]);
  }

  /* Median-filter harmonic/percussive split (Fitzgerald 2010): returns the harmonic share of each cell. */
  function harmonicMask(mag, frames, bins) {
    const W = 8;
    const buf = new Float64Array(2 * W + 1);
    const H = new Float32Array(mag.length);
    const mask = new Float32Array(mag.length);
    for (let k = 0; k < bins; k++) {
      for (let t = 0; t < frames; t++) {
        let n = 0;
        for (let u = Math.max(0, t - W); u <= Math.min(frames - 1, t + W); u++) buf[n++] = mag[u * bins + k];
        H[t * bins + k] = median(buf, n);
      }
    }
    for (let t = 0; t < frames; t++) {
      const row = t * bins;
      for (let k = 0; k < bins; k++) {
        let n = 0;
        for (let u = Math.max(0, k - W); u <= Math.min(bins - 1, k + W); u++) buf[n++] = mag[row + u];
        const p = median(buf, n), h = H[row + k];
        mask[row + k] = (h * h) / (h * h + p * p + 1e-20);
      }
    }
    return mask;
  }

  /* Share of an envelope's movement that happens at syllable rate (3-8 Hz) rather than 0.5-20 Hz. */
  function modulationShare(env, rate) {
    const n = env.length;
    let m = 0;
    for (let i = 0; i < n; i++) m += env[i];
    m /= n || 1;
    let inBand = 0, all = 0;
    for (let f = 0.5; f <= 20; f += 0.25) {
      let c = 0, s = 0;
      const w = (2 * Math.PI * f) / rate;
      for (let i = 0; i < n; i++) { const v = env[i] - m; c += v * Math.cos(w * i); s += v * Math.sin(w * i); }
      const p = c * c + s * s;
      all += p;
      if (f >= 3 && f <= 8) inBand += p;
    }
    return all > 0 ? inBand / all : 0;
  }

  function onsetRate(env, rate) {
    const flux = [];
    for (let i = 1; i < env.length; i++) flux.push(Math.max(0, env[i] - env[i - 1]));
    if (!flux.length) return 0;
    const sorted = flux.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const mad = sorted.map((v) => Math.abs(v - med)).sort((a, b) => a - b)[sorted.length >> 1];
    const thr = med + 3 * mad + 1e-9;
    let count = 0, last = -1e9;
    for (let i = 1; i < flux.length - 1; i++) {
      if (flux[i] > thr && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1] && i - last > rate * 0.08) { count++; last = i; }
    }
    return count / (env.length / rate);
  }

  /* Features, chroma (for the key) and band energies for one stretch of audio. Returns null for silence. */
  function segment(L, R, fs, start, len) {
    const s = stft(L, R, fs, start, len);
    const { bins, frames, df, mid, side, rate } = s;
    const mask = harmonicMask(mid, frames, bins);
    const band = (f) => { for (let b = 0; b < EDGES.length - 1; b++) if (f >= EDGES[b] && f < EDGES[b + 1]) return b; return -1; };
    const wide = (f) => WIDE.findIndex(([a, b]) => f >= a && f < b);
    const binBand = new Int8Array(bins), binWide = new Int8Array(bins), binPc = new Int8Array(bins);
    for (let k = 0; k < bins; k++) {
      const f = k * df;
      binBand[k] = band(f); binWide[k] = wide(f);
      binPc[k] = f >= 55 && f <= 5000 ? ((Math.round(69 + 12 * Math.log2(f / 440)) % 12) + 12) % 12 : -1;
    }
    const kv1 = Math.ceil(VOX[0] / df), kv2 = Math.floor(VOX[1] / df);
    const harmE = new Float64Array(9), wideLog = Array.from({ length: 5 }, () => []), contrast = new Float64Array(5), contrastN = new Float64Array(5);
    const wideBins = WIDE.map(([a, b]) => [Math.max(1, Math.ceil(a / df)), Math.min(bins - 1, Math.floor(b / df))]);
    const midE = new Float64Array(9), percE = new Float64Array(9), wideMid = new Float64Array(5), wideSide = new Float64Array(5);
    const chroma = new Float64Array(12), chromaLow = new Float64Array(12);
    const voxEnv = new Float64Array(frames), percEnv = new Float64Array(frames), kickEnv = new Float64Array(frames);
    let total = 0, harmVoxMid = 0, harmVoxSide = 0, flatSum = 0, flatN = 0;
    for (let t = 0; t < frames; t++) {
      const row = t * bins;
      let logSum = 0, linSum = 0, voxBins = 0;
      for (let k = 1; k < bins; k++) {
        const b = binBand[k];
        if (b < 0) continue;
        const m2 = mid[row + k] * mid[row + k], s2 = side[row + k] * side[row + k], h = mask[row + k];
        const hm = m2 * h, pm = m2 - hm;
        total += m2 + s2;
        midE[b] += m2; percE[b] += pm; harmE[b] += hm;
        const w = binWide[k];
        if (w >= 0) { wideMid[w] += m2; wideSide[w] += s2; }
        percEnv[t] += pm;
        if (b <= 1) kickEnv[t] += pm;
        if (k >= kv1 && k <= kv2) {
          harmVoxMid += hm; harmVoxSide += s2 * h; voxEnv[t] += hm;
          logSum += Math.log(hm + 1e-14); linSum += hm; voxBins++;
        }
        const pc = binPc[k];
        if (pc >= 0) { chroma[pc] += Math.sqrt(hm); if (k * df < 260) chromaLow[pc] += Math.sqrt(hm); }
      }
      if (linSum > 1e-10 && voxBins) { flatSum += logSum / voxBins - Math.log(linSum / voxBins); flatN++; }
      wideBins.forEach(([k1, k2], w) => {
        if (k2 <= k1) return;
        const vals = [];
        let e = 0;
        for (let k = k1; k <= k2; k++) { const m2 = mid[row + k] * mid[row + k]; vals.push(m2); e += m2; }
        if (e < 1e-12) return;
        wideLog[w].push(toDb(e));
        vals.sort((a, b) => a - b);
        contrast[w] += toDb(vals[Math.floor(vals.length * 0.9)] + 1e-14) - toDb(vals[Math.floor(vals.length * 0.1)] + 1e-14);
        contrastN[w]++;
      });
    }
    if (total < 1e-8 * frames) return null;
    let peak = 0, sq = 0;
    for (let i = start; i < Math.min(start + len, L.length); i++) {
      const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
      if (a > peak) peak = a;
      sq += 0.5 * (L[i] * L[i] + R[i] * R[i]);
    }
    const rms = Math.sqrt(sq / Math.max(1, Math.min(len, L.length - start)));
    const env = (e) => Array.from(e, (v) => Math.sqrt(v));
    const x = [
      ...Array.from(midE, (v) => cap(toDb(v / total))),
      ...Array.from(wideMid, (v, i) => cap(toDb((wideSide[i] + 1e-20) / (v + 1e-20)))),
      ...Array.from(percE, (v, i) => cap(toDb((v + 1e-20) / (midE[i] + 1e-20)))),
      cap(toDb(harmVoxMid / total)), cap(toDb((harmVoxSide + 1e-20) / total)),
      modulationShare(env(voxEnv), rate),
      flatN ? (10 / Math.LN10) * (flatSum / flatN) : -30,
      Math.log1p(onsetRate(env(percEnv).map((v) => Math.log(v + 1e-9)), rate)),
      modulationShare(env(kickEnv), rate),
      cap(20 * Math.log10((peak + 1e-12) / (rms + 1e-12))),
      ...Array.from(harmE, (v) => cap(toDb((v + 1e-20) / total))),
      ...Array.from(percE, (v) => cap(toDb((v + 1e-20) / total))),
      ...wideLog.map((list) => (list.length > 1 ? Math.min(30, M.dsp.stdev(list)) : 0)),
      ...Array.from(contrast, (v, i) => (contrastN[i] ? v / contrastN[i] : 0)),
    ];
    const norm = (c) => { const sum = c.reduce((a, b) => a + b, 0) || 1; return Array.from(c, (v) => v / sum); };
    return { x, chroma: norm(chroma), chromaLow: norm(chromaLow) };
  }

  M.features = { segment, NAMES };
})(typeof self !== 'undefined' ? self : globalThis);
