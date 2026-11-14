/* Mu-sixk musical helpers: key from a pitch-class profile (Krumhansl-Kessler), note names, scale checks. */
(function (root) {
  'use strict';
  const M = (root.MuSixk = root.MuSixk || {});

  const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const SCALE = { major: [0, 2, 4, 5, 7, 9, 11], minor: [0, 2, 3, 5, 7, 8, 10, 11] }; // minor allows the raised 7th

  function corr(a, b) {
    const n = a.length;
    let ma = 0, mb = 0;
    for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
    ma /= n; mb /= n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
  }

  /* chroma: 12 values, C first. Returns the best key, how clearly it wins, and its relative key. */
  function detectKey(chroma) {
    if (!chroma || chroma.reduce((a, b) => a + b, 0) <= 0) return null;
    const scores = [];
    for (let tonic = 0; tonic < 12; tonic++) {
      const rotated = chroma.map((_, i) => chroma[(i + tonic) % 12]);
      scores.push({ tonic, mode: 'major', r: corr(rotated, MAJOR) });
      scores.push({ tonic, mode: 'minor', r: corr(rotated, MINOR) });
    }
    scores.sort((a, b) => b.r - a.r);
    const best = scores[0];
    const relTonic = best.mode === 'major' ? (best.tonic + 9) % 12 : (best.tonic + 3) % 12;
    const relMode = best.mode === 'major' ? 'minor' : 'major';
    const rival = scores.find((s) => !(s.tonic === relTonic && s.mode === relMode) && s !== best);
    return {
      tonic: best.tonic, mode: best.mode, name: `${NOTES[best.tonic]} ${best.mode}`, r: best.r,
      clarity: best.r - (rival ? rival.r : 0),
      relative: `${NOTES[relTonic]} ${relMode}`,
      scale: SCALE[best.mode].map((s) => (s + best.tonic) % 12),
    };
  }

  /* The strongest pitch class in a profile, if one clearly dominates. */
  function mainNote(chroma) {
    if (!chroma) return null;
    let best = 0;
    for (let i = 1; i < 12; i++) if (chroma[i] > chroma[best]) best = i;
    const total = chroma.reduce((a, b) => a + b, 0);
    const share = total > 0 ? chroma[best] / total : 0;
    return share >= 0.2 ? { pc: best, name: NOTES[best], share } : null;
  }

  /* Smallest retune (in semitones, -6..+5) that moves a note into the scale. */
  function nearestInScale(pc, scale) {
    for (const step of [1, -1, 2, -2]) if (scale.includes((pc + step + 12) % 12)) return step;
    return 0;
  }

  M.music = { NOTES, detectKey, mainNote, nearestInScale };
})(typeof self !== 'undefined' ? self : globalThis);
