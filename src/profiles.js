/* Mu-sixk targets: built-in style curves plus profiles learned from the user's reference tracks.
   The all-round curve is the median spectrum of real mixes (src/calibration.js). The other styles
   keep a hand-set difference from it, and the loudness ranges are hand-set too, because the
   measured mixes are not mastered. Learned profiles replace all of it with the user's own data. */
(function (root) {
  'use strict';
  const M = (root.MuSixk = root.MuSixk || {});
  const { clamp, mean, stdev } = M.dsp;
  const OCTAVES = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  const REGION_TOL = { sub: 5, bass: 3, lowmid: 3, mid: 2.5, highmid: 3, presence: 3, air: 4.5 };

  function curveFromOctaves(points) {
    const curve = M.THIRD_OCT.map((f) => {
      const x = Math.log2(f / OCTAVES[0]);
      if (x <= 0) return points[0] + x * 12;
      if (x >= OCTAVES.length - 1) return points[points.length - 1] - (x - (OCTAVES.length - 1)) * 12;
      const i = Math.floor(x);
      return points[i] + (points[i + 1] - points[i]) * (x - i);
    });
    const total = 10 * Math.log10(curve.reduce((s, v) => s + Math.pow(10, v / 10), 0));
    return curve.map((v) => v - total);
  }

  /* Built-in styles start from the median spectrum of real mixes (src/calibration.js) and keep the
     hand-set difference between each style and the all-round one. Above 13 kHz the measured files
     are band-limited by their encoder, so the hand-set slope carries on from there. */
  const cal = M.calibration ? M.calibration.mix : null;
  const POP = [-3, 4, 4, 2, 1, 0, -2, -4.5, -8, -15];
  const anchor = (c) => { const ref = M.levelBetween(c, 200, 4000); return c.map((v) => v - ref); };
  function grounded(octaves) {
    const hand = anchor(curveFromOctaves(octaves));
    if (!cal) return hand;
    const pop = anchor(curveFromOctaves(POP));
    const last = M.THIRD_OCT.findLastIndex((f) => f <= 13000);
    const out = M.THIRD_OCT.map((f, i) => (i <= last ? cal.curve[i] + hand[i] - pop[i] : 0));
    for (let i = last + 1; i < out.length; i++) out[i] = out[last] + hand[i] - hand[last];
    const total = 10 * Math.log10(out.reduce((s, v) => s + Math.pow(10, v / 10), 0));
    return out.map((v) => v - total);
  }
  const defaultTol = () => M.THIRD_OCT.map((f, i) => {
    const hand = f < 50 ? 6 : f < 100 ? 4.5 : f < 8000 ? 3.5 : 5;
    return cal && f <= 13000 ? clamp((cal.curveHi[i] - cal.curveLo[i]) / 2, 2.5, 7) : hand;
  });
  if (cal) for (const r of M.REGIONS) REGION_TOL[r.id] = clamp((cal.regionSpread[r.id].hi - cal.regionSpread[r.id].lo) / 2, 2, 6.5);

  const style = (id, name, octaves, lufs, plr, verb, levels) => ({
    id, name, learned: false, curve: grounded(octaves), tol: defaultTol(),
    regionTol: REGION_TOL, lufs, plr, verb, levels: levels || {},
  });

  const BUILT_IN = [
    style('pop', 'Pop / all-round', POP, [-11, -8], [8, 12], 1),
    style('hiphop', 'Hip-hop / trap', [3, 7, 4, 1, 0, 0, -2.5, -5, -8, -15], [-10, -7], [7, 11], 0.6, { kick: 2, sub808: 2, bass: 2 }),
    style('afro', 'Afrobeats / amapiano', [1, 6, 5, 2, 0.5, 0, -2, -5, -8.5, -15], [-11, -8], [8, 12], 0.8, { perc: 2, bass: 1 }),
    style('rnb', 'R&B / soul', [0, 5, 4.5, 2, 1, 0, -2.5, -5.5, -9, -16], [-12, -9], [9, 13], 1.3),
    style('edm', 'Dance / electronic', [2, 6.5, 4, 1, 0, 0, -1.5, -4, -7, -13], [-9, -6], [6, 10], 1.1, { kick: 3, bass: 2, synth: 1 }),
    style('rock', 'Rock / metal', [-8, 2, 4, 3, 1.5, 0, -1, -3.5, -8, -16], [-11, -8], [8, 12], 0.8, { guitar: 3, drums: 1 }),
    style('gospel', 'Gospel / live band', [-5, 3, 4, 2.5, 1.5, 0, -2, -4.5, -8.5, -16], [-13, -9], [9, 14], 1.2, { keys: 2, bvox: 2 }),
    style('acoustic', 'Acoustic / jazz / folk', [-10, 0, 3, 2.5, 1.5, 0, -2, -5, -9.5, -17], [-16, -11], [10, 16], 1.2, { guitar: 4, keys: 2 }),
  ];

  /* What a reference track contributes to a learned profile. Small enough to keep in localStorage. */
  function fingerprint(name, a) {
    const r1 = (v) => Math.round(v * 10) / 10;
    return {
      name, thirdOct: a.thirdOct.map(r1), lufs: r1(a.lufs), plr: r1(a.plr),
      widthDb: r1(Math.max(a.stereoInfo.widthDb, -40)),
    };
  }

  function buildLearned(id, name, tracks) {
    const anchored = tracks.map((t) => {
      const ref = M.levelBetween(t.thirdOct, 200, 4000);
      return t.thirdOct.map((v) => v - ref);
    });
    const curve = M.THIRD_OCT.map((_, i) => mean(anchored.map((c) => c[i])));
    const tol = M.THIRD_OCT.map((f, i) => {
      const floor = f < 50 ? 4 : f < 8000 ? 2.5 : 3.5;
      return clamp(1.5 * stdev(anchored.map((c) => c[i])), floor, 7);
    });
    const regionTol = {};
    for (const r of M.REGIONS) {
      const vals = anchored.map((c) => M.levelBetween(c, r.lo, r.hi));
      regionTol[r.id] = clamp(1.5 * stdev(vals), REGION_TOL[r.id] * 0.7, REGION_TOL[r.id] * 1.5);
    }
    const range = (key, pad) => {
      const vals = tracks.map((t) => t[key]);
      const spread = Math.max(pad, stdev(vals));
      return [mean(vals) - spread, mean(vals) + spread];
    };
    return {
      id, name, learned: true, tracks, curve, tol, regionTol,
      lufs: range('lufs', 1.5), plr: range('plr', 2), verb: 1, levels: {},
    };
  }

  /* Line the track up with the target over 200 Hz - 4 kHz, then report how far each band strays. */
  function compareTonal(a, profile) {
    const offset = M.levelBetween(profile.curve, 200, 4000) - M.levelBetween(a.thirdOct, 200, 4000);
    const shifted = a.thirdOct.map((v) => v + offset);
    const regions = {};
    for (const r of M.REGIONS) {
      regions[r.id] = {
        dev: M.levelBetween(shifted, r.lo, r.hi) - M.levelBetween(profile.curve, r.lo, r.hi),
        tol: profile.regionTol[r.id],
      };
    }
    return { shifted, regions };
  }

  M.profiles = { BUILT_IN, fingerprint, buildLearned, compareTonal, curveFromOctaves };
})(typeof self !== 'undefined' ? self : globalThis);
