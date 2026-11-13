'use strict';
const test = require('node:test');
const assert = require('node:assert');
for (const f of ['dsp', 'analyze', 'profiles', 'advice', 'demo']) require(`../src/${f}.js`);
const M = globalThis.MuSixk;
const pop = M.profiles.BUILT_IN[0];

/* Noise shaped to a target curve: the "perfect" tonal balance for that style. */
function shapedNoise(profile, seconds, tilt = () => 0, fs = 48000) {
  const N = 1 << Math.ceil(Math.log2(fs * seconds));
  const make = (seed) => {
    const re = new Float64Array(N), im = new Float64Array(N);
    let s = seed;
    const rand = () => (s = (s * 16807) % 2147483647) / 2147483647;
    for (let k = 1; k < N / 2; k++) {
      const f = (k * fs) / N;
      if (f < 22 || f > 20000) continue;
      const x = Math.log2(f / M.THIRD_OCT[0]) * 3;
      const i = Math.max(0, Math.min(M.THIRD_OCT.length - 2, Math.floor(x)));
      const level = profile.curve[i] + (profile.curve[i + 1] - profile.curve[i]) * (x - i) + tilt(f);
      const amp = Math.pow(10, level / 20) / Math.sqrt(f); // third-octave level -> per-bin density
      const ph = 2 * Math.PI * rand();
      re[k] = amp * Math.cos(ph); im[k] = amp * Math.sin(ph);
      re[N - k] = re[k]; im[N - k] = -im[k];
    }
    M.dsp.fft(re, im);
    return re;
  };
  const a = make(11), b = make(23), c = make(37);
  let peak = 0;
  const L = new Float32Array(N), R = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    L[i] = a[i] + 0.5 * b[i]; R[i] = a[i] + 0.5 * c[i];
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  const g = Math.pow(10, -1.5 / 20) / peak;
  for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; }
  return { channels: [L, R], sampleRate: fs };
}

test('audio that follows the target curve gets a clean tonal bill', async () => {
  const a = await M.analyze(shapedNoise(pop, 10));
  const r = M.advice.assessMix(a, pop, 'mix');
  assert.deepStrictEqual(r.issues.filter((i) => i.area === 'Tone'), []);
});

test('a bass-heavy, dull version is called out in the right bands', async () => {
  const tilt = (f) => (f < 200 ? 8 : f > 4000 ? -9 : 0);
  const a = await M.analyze(shapedNoise(pop, 10, tilt));
  const titles = M.advice.assessMix(a, pop, 'mix').issues.filter((i) => i.area === 'Tone').map((i) => i.title).join(' | ');
  assert.match(titles, /Boomy low end/);
  assert.match(titles, /Dull|No air/);
  assert.doesNotMatch(titles, /mids/i);
});

test('a learned profile accepts the tracks it was taught and rejects a different sound', async () => {
  const hiphop = M.profiles.BUILT_IN.find((p) => p.id === 'hiphop');
  const refs = [];
  for (const wobble of [-1, 0, 1]) {
    const a = await M.analyze(shapedNoise(hiphop, 6, (f) => (f > 2000 ? wobble : 0)));
    refs.push(M.profiles.fingerprint(`ref ${wobble}`, a));
  }
  const learned = M.profiles.buildLearned('mine', 'My sound', refs);
  const same = await M.analyze(shapedNoise(hiphop, 6));
  assert.deepStrictEqual(M.advice.assessMix(same, learned, 'mix').issues.filter((i) => i.area === 'Tone'), []);
  const acoustic = M.profiles.BUILT_IN.find((p) => p.id === 'acoustic');
  const other = await M.analyze(shapedNoise(acoustic, 6));
  assert.ok(M.advice.assessMix(other, learned, 'mix').issues.some((i) => /Thin at the very bottom|Lacks weight/.test(i.title)));
});

test('demo mix is judged poorly and for the reasons built into it', async () => {
  const stems = M.demo.makeDemoStems();
  const a = await M.analyze(M.demo.makeDemoMix(stems));
  const r = M.advice.assessMix(a, pop, 'master');
  const titles = r.issues.map((i) => i.title).join(' | ');
  assert.ok(r.score < 72, `score ${r.score}`);
  assert.match(titles, /Clipping/);
  assert.match(titles, /Boomy|Too much sub/);
});

test('stems: roles are guessed, recipes are specific, balance and clashes come out', async () => {
  const raw = M.demo.makeDemoStems();
  const stems = [];
  for (const s of raw) {
    const analysis = await M.analyze(s);
    stems.push({ name: s.name, analysis, role: M.advice.guessRole(s.name, analysis) });
  }
  assert.deepStrictEqual(stems.map((s) => s.role), ['vocal', 'kick', 'bass', 'keys', 'hats']);

  const bpm = stems[1].analysis.tempo.bpm;
  assert.ok(Math.abs(bpm - 100) < 2 || Math.abs(bpm - 200) < 4, `kick tempo ${bpm}`);

  const vocal = M.advice.stemRecipe(stems[0].analysis, 'vocal', { profile: pop, bpm: 100, sameRoleIndex: 0, sameRoleCount: 1 });
  const byFx = (fx) => vocal.steps.filter((s) => s.fx === fx).map((s) => s.setting).join(' | ');
  assert.match(byFx('High-pass filter'), /\d+ Hz, 12 dB\/oct/);
  assert.match(byFx('Compressor'), /:1, threshold near -?\d+ dB/);
  assert.match(byFx('De-esser'), /kHz/);
  assert.match(byFx('Reverb (send)'), /15% send, 1\.2 s decay, 38 ms pre-delay/);
  assert.match(byFx('Delay (send)'), /600 ms \(1\/4 note\)/);

  const bass = M.advice.stemRecipe(stems[2].analysis, 'bass', { profile: pop, bpm: 100, sameRoleIndex: 0, sameRoleCount: 1 });
  assert.ok(bass.steps.some((s) => s.fx === 'Reverb' && s.setting === 'None'));

  const gains = M.advice.balanceStems(stems, pop);
  assert.strictEqual(gains.length, 5);
  const after = stems.map((s, i) => s.analysis.lufs + gains[i]);
  assert.ok(Math.abs((after[1] - after[0]) - (-2)) < 0.6, 'kick lands 2 LU under the vocal');
  assert.ok(Math.abs((after[4] - after[0]) - (-9)) < 0.6, 'hats land 9 LU under the vocal');

  const clashes = M.advice.findClashes(stems, gains);
  assert.ok(Array.isArray(clashes));
  for (const c of clashes) assert.match(c.fix, /cut|sidechain/i);
});

test('mastering plan sizes the limiter from the measured loudness', async () => {
  const audio = shapedNoise(pop, 10);
  for (const ch of audio.channels) for (let i = 0; i < ch.length; i++) ch[i] *= 0.4; // an unmastered level
  const a = await M.analyze(audio);
  const steps = M.advice.masteringPlan(a, pop, M.advice.assessMix(a, pop, 'mix'));
  const limiter = steps.find((s) => s.fx === 'Limiter');
  const gain = Number(/input gain about \+([\d.]+) dB/.exec(limiter.setting)[1]);
  assert.ok(gain > 1, limiter.setting);
  assert.ok(a.lufs + gain <= -9.5 + 0.5, `never aims past the style target: ${a.lufs} + ${gain}`);
  assert.match(limiter.setting, /Ceiling -1 dBTP/);
  assert.ok(!steps.some((s) => s.fx === 'EQ'), 'on-target tone gets no mastering EQ');
});

test('streaming preview: loud masters are turned down, quiet ones are not turned up on down-only services', () => {
  const loud = M.advice.streamingPreview({ lufs: -8, truePeakDb: -1 });
  assert.strictEqual(loud.find((r) => r.name === 'Spotify').change, -6);
  assert.strictEqual(loud.find((r) => r.name === 'Apple Music').change, -8);
  const quiet = M.advice.streamingPreview({ lufs: -20, truePeakDb: -3 });
  assert.strictEqual(quiet.find((r) => r.name === 'YouTube').change, 0);
  assert.strictEqual(quiet.find((r) => r.name === 'Spotify').change, 2);
  assert.match(quiet.find((r) => r.name === 'YouTube').note, /quieter than other songs/);
});

test('a lossy-style brick wall at 15 kHz and long lead-in silence are caught on a master', async () => {
  const audio = shapedNoise(pop, 10, (f) => (f > 15000 ? -200 : 0));
  const pad = 48000 * 2;
  audio.channels = audio.channels.map((ch) => { const out = new Float32Array(ch.length + pad); out.set(ch, pad); return out; });
  const a = await M.analyze(audio);
  assert.ok(a.cutoffHz >= 14500 && a.cutoffHz <= 15500, `cutoff ${a.cutoffHz}`);
  const titles = M.advice.assessMix(a, pop, 'master').issues.map((i) => i.title).join(' | ');
  assert.match(titles, /Top end stops dead at 15(\.5)? kHz/);
  assert.match(titles, /2\.0 s of silence before the music starts/);
  const clean = await M.analyze(shapedNoise(pop, 10));
  assert.ok(clean.cutoffHz > 19000, `full-band cutoff ${clean.cutoffHz}`);
});

test('every fix names a real tool and its settings', async () => {
  const stems = M.demo.makeDemoStems();
  for (const stage of ['mix', 'master']) {
    const r = M.advice.assessMix(await M.analyze(M.demo.makeDemoMix(stems)), pop, stage);
    assert.ok(r.issues.length > 3);
    for (const i of r.issues) {
      assert.ok(M.advice.TOOLS[i.tool], `${i.title} -> ${i.tool}`);
      assert.ok(i.settings.length >= 1 && i.settings.every(([k, v]) => k && v), i.title);
    }
    const boomy = r.issues.find((i) => /Boomy/.test(i.title));
    assert.strictEqual(boomy.tool, 'eq');
    assert.deepStrictEqual(boomy.settings.map((s) => s[0]), ['Type', 'Frequency', 'Gain', 'Width (Q)', 'Put it on']);
    assert.match(boomy.settings[2][1], /^-\d/);
    const box = M.advice.toolbox(r.issues.map((i) => i.tool));
    assert.strictEqual(box[0].key, 'eq');
  }
});

test('report card grades each part and blames the right one', async () => {
  const r = M.advice.assessMix(await M.analyze(M.demo.makeDemoMix(M.demo.makeDemoStems())), pop, 'master');
  const card = Object.fromEntries(M.advice.reportCard(r).map((p) => [p.id, p]));
  assert.strictEqual(Object.keys(card).length, 7);
  assert.ok(card.low.pct < 85 && card.low.found.some((i) => /Boomy|sub/.test(i.title)), 'bass-heavy demo loses marks on kick and bass');
  assert.ok(card.level.found.some((i) => /Clipping/.test(i.title)));
  assert.strictEqual(card.space.pct, 100);
  assert.strictEqual(card.space.word, 'Good');
  for (const i of r.issues) assert.ok(card[i.part], `${i.title} has a part`);
});

test('stem diagnosis reports volume, tone and performance problems as a percentage', async () => {
  const vocal = await M.analyze(M.demo.makeDemoStems()[0]);
  const quiet = M.advice.diagnoseStem(vocal, 'vocal', 5.5);
  assert.match(quiet.problems.map((x) => x.title).join(' | '), /Volume: 5\.5 dB too quiet/);
  assert.match(quiet.problems.map((x) => x.title).join(' | '), /Harsh "s" sounds/);
  assert.match(quiet.problems.map((x) => x.title).join(' | '), /Uneven/);
  const level = M.advice.diagnoseStem(vocal, 'vocal', 0);
  assert.ok(level.pct > quiet.pct && quiet.pct < 70, `${quiet.pct} vs ${level.pct}`);
  const loud = M.advice.diagnoseStem(vocal, 'vocal', -9);
  assert.match(loud.problems[0].title, /9 dB too loud/);
  assert.strictEqual(loud.problems[0].sev, 'high');
});
