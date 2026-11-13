/* Mu-sixk analyzer: turns decoded audio into the measurements the advice engine reads. */
(function (root) {
  'use strict';
  const M = (root.MuSixk = root.MuSixk || {});
  const { toDb, ampDb, clamp, percentile, mean, stdev, fft, hann, loudness, truePeak } = M.dsp;

  /* 30 third-octave bands, 25 Hz .. 20 kHz */
  const THIRD_OCT = Array.from({ length: 30 }, (_, i) => 1000 * Math.pow(2, (i - 16) / 3));

  /* The seven regions people actually talk about when mixing. */
  const REGIONS = [
    { id: 'sub', name: 'Sub', lo: 20, hi: 60 },
    { id: 'bass', name: 'Bass', lo: 60, hi: 250 },
    { id: 'lowmid', name: 'Low mids', lo: 250, hi: 500 },
    { id: 'mid', name: 'Mids', lo: 500, hi: 2000 },
    { id: 'highmid', name: 'Upper mids', lo: 2000, hi: 4000 },
    { id: 'presence', name: 'Presence', lo: 4000, hi: 8000 },
    { id: 'air', name: 'Air', lo: 8000, hi: 20000 },
  ];

  /* Sum a power spectrum between two frequencies, counting partial bins. */
  function bandPower(spec, df, f1, f2) {
    const last = spec.length - 1;
    const k1 = clamp(f1 / df, 0.5, last + 0.5);
    const k2 = clamp(f2 / df, 0.5, last + 0.5);
    if (k2 <= k1) return 0;
    let sum = 0;
    for (let k = Math.max(1, Math.floor(k1 + 0.5)); k <= Math.min(last, Math.floor(k2 + 0.5)); k++) {
      const overlap = Math.min(k + 0.5, k2) - Math.max(k - 0.5, k1);
      if (overlap > 0) sum += spec[k] * overlap;
    }
    return sum;
  }

  /* Power sum of third-octave levels (dB) between two frequencies. */
  function levelBetween(thirdOctDb, f1, f2) {
    let sum = 0;
    for (let i = 0; i < THIRD_OCT.length; i++) {
      const lo = THIRD_OCT[i] * Math.pow(2, -1 / 6);
      const hi = THIRD_OCT[i] * Math.pow(2, 1 / 6);
      const overlap = Math.log2(Math.min(hi, f2) / Math.max(lo, f1)) * 3;
      if (overlap > 0) sum += Math.pow(10, thirdOctDb[i] / 10) * Math.min(1, overlap);
    }
    return toDb(sum);
  }

  function timePass(L, R, fs) {
    const n = L.length;
    const block = Math.round(fs * 0.1);
    const nBlocks = Math.max(1, Math.floor(n / block));
    const blockPeakDb = new Float32Array(nBlocks);
    const blockRmsDb = new Float32Array(nBlocks);
    const buckets = Math.min(1200, Math.max(1, Math.floor(n / 16)));
    const waveMin = new Float32Array(buckets);
    const waveMax = new Float32Array(buckets);
    let peak = 0, sumL = 0, sumR = 0, sumLL = 0, sumRR = 0, sumLR = 0;
    let clipRuns = 0, clipSamples = 0, run = 0;
    let bPeak = 0, bSq = 0, bPos = 0, bIdx = 0;
    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      const a = al > ar ? al : ar;
      if (a > peak) peak = a;
      sumL += l; sumR += r; sumLL += l * l; sumRR += r * r; sumLR += l * r;
      if (a >= 0.999) { run++; } else { if (run >= 3) { clipRuns++; clipSamples += run; } run = 0; }
      if (a > bPeak) bPeak = a;
      bSq += (l * l + r * r) * 0.5;
      if (++bPos === block && bIdx < nBlocks) {
        blockPeakDb[bIdx] = ampDb(bPeak);
        blockRmsDb[bIdx] = toDb(bSq / block);
        bIdx++; bPeak = 0; bSq = 0; bPos = 0;
      }
      const w = Math.min(buckets - 1, Math.floor((i / n) * buckets));
      const m = (l + r) * 0.5;
      if (m < waveMin[w]) waveMin[w] = m;
      if (m > waveMax[w]) waveMax[w] = m;
    }
    if (run >= 3) { clipRuns++; clipSamples += run; }
    const rms = Math.sqrt((sumLL + sumRR) / (2 * n));
    const denom = Math.sqrt(sumLL * sumRR);
    return {
      peak, rms,
      dc: Math.max(Math.abs(sumL / n), Math.abs(sumR / n)),
      correlation: denom > 1e-12 ? sumLR / denom : 1,
      balanceDb: sumLL > 1e-12 && sumRR > 1e-12 ? toDb(sumLL / sumRR) : 0,
      clipRuns, clipSamples, blockPeakDb, blockRmsDb, waveMin, waveMax,
    };
  }

  function spectralPass(L, R, fs, stereo) {
    const N = fs >= 32000 ? 8192 : 4096;
    const n = L.length;
    const hop = Math.max(N / 2, Math.floor((n - N) / 3000));
    const win = hann(N);
    let sumW2 = 0;
    for (let i = 0; i < N; i++) sumW2 += win[i] * win[i];
    const scale = 2 / (N * sumW2);
    const half = N / 2;
    const df = fs / N;
    const accM = new Float64Array(half + 1);
    const accS = new Float64Array(half + 1);
    const reL = new Float64Array(N), imL = new Float64Array(N);
    const reR = new Float64Array(N), imR = new Float64Array(N);
    const kMid1 = Math.round(1000 / df), kMid2 = Math.round(4000 / df);
    const kHi1 = Math.round(5000 / df), kHi2 = Math.min(half, Math.round(10000 / df));
    const frames = { mid: [], hi: [], hiCentroid: [] };
    let used = 0;
    const frameCount = Math.max(1, Math.floor((n - N) / hop) + 1);
    for (let f = 0; f < frameCount; f++) {
      const start = f * hop;
      let energy = 0;
      for (let i = 0; i < N; i++) {
        const idx = start + i;
        const l = idx < n ? L[idx] : 0;
        reL[i] = l * win[i]; imL[i] = 0;
        energy += l * l;
        if (stereo) { const r = idx < n ? R[idx] : 0; reR[i] = r * win[i]; imR[i] = 0; energy += r * r; }
      }
      if (energy / N < 1e-7) continue; // skip silence so gaps don't dilute the average
      fft(reL, imL);
      if (stereo) fft(reR, imR);
      let pMid = 0, pHi = 0, cNum = 0;
      for (let k = 1; k <= half; k++) {
        let pm, ps = 0;
        if (stereo) {
          const mr = (reL[k] + reR[k]) * 0.5, mi = (imL[k] + imR[k]) * 0.5;
          const sr = (reL[k] - reR[k]) * 0.5, si = (imL[k] - imR[k]) * 0.5;
          pm = (mr * mr + mi * mi) * scale;
          ps = (sr * sr + si * si) * scale;
        } else {
          pm = (reL[k] * reL[k] + imL[k] * imL[k]) * scale;
        }
        accM[k] += pm; accS[k] += ps;
        const p = pm + ps;
        if (k >= kMid1 && k < kMid2) pMid += p;
        else if (k >= kHi1 && k < kHi2) { pHi += p; cNum += p * k * df; }
      }
      frames.mid.push(toDb(pMid));
      frames.hi.push(toDb(pHi));
      frames.hiCentroid.push(pHi > 0 ? cNum / pHi : 7000);
      used++;
    }
    const tot = new Float64Array(half + 1);
    for (let k = 0; k <= half; k++) {
      accM[k] /= Math.max(used, 1); accS[k] /= Math.max(used, 1);
      tot[k] = accM[k] + accS[k];
    }
    return { tot, mid: accM, side: accS, df, frames, used };
  }

  function findResonances(tot, df) {
    const centres = [];
    for (let f = 100; f <= 10000; f *= Math.pow(2, 1 / 12)) centres.push(f);
    const lev = centres.map((f) => toDb(bandPower(tot, df, f * Math.pow(2, -1 / 24), f * Math.pow(2, 1 / 24))));
    const top = Math.max(...lev);
    const found = [];
    for (let i = 2; i < lev.length - 2; i++) {
      if (lev[i] < lev[i - 1] || lev[i] < lev[i + 1]) continue;
      const around = [];
      for (let j = Math.max(0, i - 8); j <= Math.min(lev.length - 1, i + 8); j++) {
        if (Math.abs(j - i) > 1) around.push(lev[j]);
      }
      const excess = lev[i] - percentile(around, 50);
      if (excess >= 7 && lev[i] > top - 25 && centres[i] >= 150 && centres[i] <= 8000) {
        found.push({ freq: centres[i], excessDb: excess });
      }
    }
    return found.sort((a, b) => b.excessDb - a.excessDb).slice(0, 3).sort((a, b) => a.freq - b.freq);
  }

  /* Tempo from onset strength (low band + everything else), autocorrelated. */
  function estimateTempo(L, R, fs) {
    const rate = 200;
    const hop = Math.round(fs / rate);
    const count = Math.floor(L.length / hop);
    if (count < rate * 4) return { bpm: null, confidence: 0 };
    const a = Math.exp((-2 * Math.PI * 150) / fs);
    const onset = new Float64Array(count);
    let lp = 0, prevLo = 0, prevHi = 0;
    for (let t = 0; t < count; t++) {
      let eLo = 0, eHi = 0;
      const base = t * hop;
      for (let i = 0; i < hop; i++) {
        const x = (L[base + i] + R[base + i]) * 0.5;
        lp += (1 - a) * (x - lp);
        const h = x - lp;
        eLo += lp * lp; eHi += h * h;
      }
      const lo = Math.sqrt(eLo / hop), hi = Math.sqrt(eHi / hop);
      onset[t] = Math.max(0, lo - prevLo) + Math.max(0, hi - prevHi);
      prevLo = lo; prevHi = hi;
    }
    const m = mean(onset);
    for (let t = 0; t < count; t++) onset[t] -= m;
    const acf = (lag) => {
      let s = 0;
      for (let t = lag; t < count; t++) s += onset[t] * onset[t - lag];
      return s / (count - lag);
    };
    const zero = acf(0);
    if (!(zero > 0)) return { bpm: null, confidence: 0 };
    const minLag = Math.floor((rate * 60) / 210), maxLag = Math.ceil((rate * 60) / 55);
    const values = new Float64Array(maxLag * 2 + 2);
    for (let lag = minLag; lag <= maxLag * 2 + 1 && lag < count; lag++) values[lag] = acf(lag) / zero;
    let best = 0, bestScore = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = (rate * 60) / lag;
      const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.8, 2));
      const score = (values[lag] + 0.5 * values[lag * 2]) * prior;
      if (score > bestScore) { bestScore = score; best = lag; }
    }
    let refined = best;
    const y0 = values[best - 1], y1 = values[best], y2 = values[best + 1];
    const curve = y0 - 2 * y1 + y2;
    if (best > minLag && curve < 0) refined = best + clamp((0.5 * (y0 - y2)) / curve, -0.5, 0.5);
    const confidence = values[best];
    return { bpm: confidence > 0.08 ? (rate * 60) / refined : null, confidence };
  }

  /* Main entry. input: { channels: Float32Array[], sampleRate }. opts.pause: async yield for the UI. */
  async function analyze(input, opts = {}) {
    const fs = input.sampleRate;
    const stereo = input.channels.length > 1;
    const L = input.channels[0];
    const R = stereo ? input.channels[1] : L;
    const pause = opts.pause || (async () => {});
    const n = L.length;
    if (n < fs * 0.5) throw new Error('That file is shorter than half a second. Load a longer clip.');

    await pause('Measuring levels');
    const t = timePass(L, R, fs);
    if (t.peak < 1e-5) throw new Error('That file is silent. Check the export and try again.');

    await pause('Measuring loudness');
    const loud = loudness(stereo ? [L, R] : [L], fs);
    const tp = truePeak(stereo ? [L, R] : [L], t.peak);

    await pause('Reading the spectrum');
    const sp = spectralPass(L, R, fs, stereo);
    const totalPower = bandPower(sp.tot, sp.df, 20, Math.min(20000, fs / 2));
    const edge = (f, d) => f * Math.pow(2, d / 6);
    const thirdOctAbs = THIRD_OCT.map((f) => toDb(bandPower(sp.tot, sp.df, edge(f, -1), edge(f, 1))));
    const thirdOct = thirdOctAbs.map((v) => v - toDb(totalPower));
    const regions = {};
    for (const r of REGIONS) regions[r.id] = toDb(bandPower(sp.tot, sp.df, r.lo, r.hi)) - toDb(totalPower);

    let cum = 0, lowExtentHz = 20, highExtentHz = 20000, cNum = 0;
    let gotLow = false, gotHigh = false;
    for (let k = 1; k < sp.tot.length; k++) {
      const f = k * sp.df;
      if (f < 20 || f > 20000) continue;
      cum += sp.tot[k]; cNum += sp.tot[k] * f;
      if (!gotLow && cum >= totalPower * 0.02) { lowExtentHz = f; gotLow = true; }
      if (!gotHigh && cum >= totalPower * 0.98) { highExtentHz = f; gotHigh = true; }
    }

    const midPower = bandPower(sp.mid, sp.df, 20, 20000);
    const sidePower = bandPower(sp.side, sp.df, 20, 20000);
    const lowMid = bandPower(sp.mid, sp.df, 20, 120);
    const lowSide = bandPower(sp.side, sp.df, 20, 120);

    /* How uneven the performance is: spread of 400 ms loudness while the part is actually playing. */
    const active = loud.momentary.filter((v) => v > loud.integrated - 20 && v > -70);
    const activeRatio = loud.momentary.length ? active.length / loud.momentary.length : 1;
    const levelSpreadDb = stdev(active);
    const quiet = Array.from(t.blockRmsDb).filter((v) => v > -100);
    const noiseFloorDb = quiet.length ? percentile(quiet, 5) : -100;
    const loudBlocks = Array.from(t.blockPeakDb).filter((v) => v > ampDb(t.peak) - 30);
    const loudPeakDb = loudBlocks.length ? percentile(loudBlocks, 90) : ampDb(t.peak);

    /* Sibilance: how hard the 5-10 kHz band spikes compared with the body of the sound. */
    let sibilance = { index: -40, freq: 7000 };
    if (sp.frames.mid.length > 8) {
      const midMedian = percentile(sp.frames.mid, 50);
      const hi95 = percentile(sp.frames.hi, 95);
      const hot = sp.frames.hiCentroid.filter((_, i) => sp.frames.hi[i] >= hi95 - 3);
      sibilance = { index: hi95 - midMedian, freq: hot.length ? mean(hot) : 7000 };
    }

    await pause('Finding the tempo');
    const tempo = estimateTempo(L, R, fs);

    const lufs = loud.integrated;
    const truePeakDb = ampDb(tp);
    return {
      duration: n / fs, sampleRate: fs, stereo,
      samplePeakDb: ampDb(t.peak), truePeakDb, rmsDb: ampDb(t.rms),
      lufs, lra: loud.lra, plr: truePeakDb - lufs, crestDb: ampDb(t.peak) - ampDb(t.rms),
      clipRuns: t.clipRuns, clipSamples: t.clipSamples, dcOffset: t.dc,
      thirdOct, thirdOctAbs, regions,
      centroidHz: totalPower > 0 ? cNum / totalPower : 0, lowExtentHz, highExtentHz,
      stereoInfo: {
        correlation: t.correlation,
        widthDb: stereo ? toDb(sidePower) - toDb(midPower) : -Infinity,
        balanceDb: t.balanceDb,
        lowSideDb: stereo ? toDb(lowSide) - toDb(lowMid) : -Infinity,
        monoLossDb: stereo ? toDb(midPower + sidePower) - toDb(midPower) : 0,
      },
      levelSpreadDb, activeRatio, noiseFloorDb, loudPeakDb,
      sibilance, resonances: findResonances(sp.tot, sp.df), tempo,
      wave: { min: t.waveMin, max: t.waveMax },
    };
  }

  M.THIRD_OCT = THIRD_OCT;
  M.REGIONS = REGIONS;
  M.levelBetween = levelBetween;
  M.analyze = analyze;
})(typeof self !== 'undefined' ? self : globalThis);
