/* Mu-sixk DSP primitives: FFT, K-weighted loudness (ITU-R BS.1770), true peak, helpers.
   No DOM access, so the same file runs in the browser and in Node tests. */
(function (root) {
  'use strict';
  const M = (root.MuSixk = root.MuSixk || {});

  const toDb = (power) => 10 * Math.log10(Math.max(power, 1e-20));
  const ampDb = (amp) => 20 * Math.log10(Math.max(Math.abs(amp), 1e-10));
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

  function percentile(values, p) {
    if (!values.length) return NaN;
    const sorted = Array.from(values).sort((a, b) => a - b);
    const idx = clamp((p / 100) * (sorted.length - 1), 0, sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  function mean(values) {
    let s = 0;
    for (let i = 0; i < values.length; i++) s += values[i];
    return values.length ? s / values.length : NaN;
  }

  function stdev(values) {
    if (values.length < 2) return 0;
    const m = mean(values);
    let s = 0;
    for (let i = 0; i < values.length; i++) s += (values[i] - m) * (values[i] - m);
    return Math.sqrt(s / (values.length - 1));
  }

  /* ---------- FFT (in-place, radix 2) ---------- */
  const fftCache = new Map();
  function fftPlan(n) {
    let plan = fftCache.get(n);
    if (plan) return plan;
    const bits = Math.round(Math.log2(n));
    if (1 << bits !== n) throw new Error('FFT size must be a power of two');
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2);
    const sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    plan = { rev, cos, sin };
    fftCache.set(n, plan);
    return plan;
  }

  function fft(re, im) {
    const n = re.length;
    const { rev, cos, sin } = fftPlan(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = start + k;
          const b = a + half;
          const xr = re[b] * cos[t] + im[b] * sin[t];
          const xi = im[b] * cos[t] - re[b] * sin[t];
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  function hann(n) {
    const w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
    return w;
  }

  /* ---------- BS.1770 K-weighting ---------- */
  function kWeighting(fs) {
    // Stage 1: high shelf (+4 dB above ~1.7 kHz). Stage 2: high-pass (~38 Hz).
    const stage = (f0, Q, gainDb, shelf) => {
      const K = Math.tan((Math.PI * f0) / fs);
      const a0 = 1 + K / Q + K * K;
      if (!shelf) {
        return { b0: 1, b1: -2, b2: 1, a1: (2 * (K * K - 1)) / a0, a2: (1 - K / Q + K * K) / a0 };
      }
      const Vh = Math.pow(10, gainDb / 20);
      const Vb = Math.pow(Vh, 0.4996667741545416);
      return {
        b0: (Vh + (Vb * K) / Q + K * K) / a0,
        b1: (2 * (K * K - Vh)) / a0,
        b2: (Vh - (Vb * K) / Q + K * K) / a0,
        a1: (2 * (K * K - 1)) / a0,
        a2: (1 - K / Q + K * K) / a0,
      };
    };
    return [
      stage(1681.974450955533, 0.7071752369554196, 3.999843853973347, true),
      stage(38.13547087602444, 0.5003270373238773, 0, false),
    ];
  }

  /* Energy of the K-weighted signal in consecutive 100 ms slices, summed over channels. */
  function kWeightedSlices(channels, fs) {
    const slice = Math.round(fs * 0.1);
    const n = channels[0].length;
    const count = Math.floor(n / slice);
    const out = new Float64Array(Math.max(count, 0));
    const [s1, s2] = kWeighting(fs);
    for (const x of channels) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0;
      let acc = 0, pos = 0, idx = 0;
      for (let i = 0; i < count * slice; i++) {
        const x0 = x[i];
        const y0 = s1.b0 * x0 + s1.b1 * x1 + s1.b2 * x2 - s1.a1 * y1 - s1.a2 * y2;
        x2 = x1; x1 = x0; y2 = y1; y1 = y0;
        const v0 = s2.b0 * y0 + s2.b1 * u1 + s2.b2 * u2 - s2.a1 * v1 - s2.a2 * v2;
        u2 = u1; u1 = y0; v2 = v1; v1 = v0;
        acc += v0 * v0;
        if (++pos === slice) { out[idx++] += acc / slice; acc = 0; pos = 0; }
      }
    }
    return out;
  }

  function windowedLoudness(slices, width) {
    const out = [];
    let acc = 0;
    for (let i = 0; i < slices.length; i++) {
      acc += slices[i];
      if (i >= width) acc -= slices[i - width];
      if (i >= width - 1) out.push(-0.691 + toDb(Math.max(acc, 0) / width));
    }
    return out;
  }

  function gatedMean(blocksDb, absGate, relGate) {
    const pow = (db) => Math.pow(10, (db + 0.691) / 10);
    const above = blocksDb.filter((b) => b > absGate);
    if (!above.length) return { loudness: -Infinity, kept: [] };
    const first = -0.691 + toDb(mean(above.map(pow)));
    const kept = above.filter((b) => b > first + relGate);
    if (!kept.length) return { loudness: first, kept: above };
    return { loudness: -0.691 + toDb(mean(kept.map(pow))), kept };
  }

  /* Integrated loudness (LUFS), loudness range (LU) and the momentary/short-term series. */
  function loudness(channels, fs) {
    const slices = kWeightedSlices(channels, fs);
    const momentary = windowedLoudness(slices, 4); // 400 ms, 75% overlap
    const shortTerm = windowedLoudness(slices, 30); // 3 s
    const integrated = gatedMean(momentary, -70, -10).loudness;
    let lra = 0;
    const st = gatedMean(shortTerm, -70, -20).kept;
    if (st.length > 4) lra = percentile(st, 95) - percentile(st, 10);
    return { integrated, lra, momentary, shortTerm };
  }

  /* ---------- True peak (4x oversampled, evaluated only near loud samples) ---------- */
  const TP_HALF = 6;
  const tpKernels = (() => {
    const phases = [];
    for (let p = 1; p < 4; p++) {
      const taps = new Float64Array(TP_HALF * 2);
      for (let k = -TP_HALF + 1; k <= TP_HALF; k++) {
        const t = k - p / 4;
        const sinc = Math.sin(Math.PI * t) / (Math.PI * t);
        const win = 0.5 + 0.5 * Math.cos((Math.PI * t) / TP_HALF);
        taps[k + TP_HALF - 1] = sinc * win;
      }
      phases.push(taps);
    }
    return phases;
  })();

  function truePeak(channels, samplePeak) {
    let peak = samplePeak;
    const thr = samplePeak * 0.7;
    if (!(samplePeak > 0)) return 0;
    for (const x of channels) {
      const n = x.length;
      for (let i = TP_HALF; i < n - TP_HALF - 1; i++) {
        const a = x[i] < 0 ? -x[i] : x[i];
        const b = x[i + 1] < 0 ? -x[i + 1] : x[i + 1];
        if (a < thr && b < thr) continue;
        for (let p = 0; p < 3; p++) {
          const taps = tpKernels[p];
          let s = 0;
          for (let k = 0; k < TP_HALF * 2; k++) s += x[i + k - TP_HALF + 1] * taps[k];
          if (s < 0) s = -s;
          if (s > peak) peak = s;
        }
      }
    }
    return peak;
  }

  M.dsp = { toDb, ampDb, clamp, percentile, mean, stdev, fft, hann, loudness, truePeak, kWeighting };
})(typeof self !== 'undefined' ? self : globalThis);
