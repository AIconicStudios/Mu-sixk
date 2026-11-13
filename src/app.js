/* Mu-sixk interface. Everything runs in the page: files are decoded with Web Audio and never uploaded. */
(function () {
  'use strict';
  const M = window.MuSixk;
  const { num, hz, dbAbs } = M.advice.format;
  const $ = (id) => document.getElementById(id);
  const STORE = 'musixk.learned.v1';

  const state = { learned: {}, mix: null, stems: [], mixdown: null, mixdownRun: 0, nextId: 1 };

  /* ---------- small helpers ---------- */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const kid of kids.flat()) if (kid != null) el.append(kid);
    return el;
  }
  function status(text, isError) {
    const el = $('status');
    el.hidden = !text;
    el.textContent = text || '';
    el.classList.toggle('error', !!isError);
  }
  const breathe = () => new Promise((r) => setTimeout(r, 0));
  const pauseWith = (name) => async (stage) => { status(`${name}: ${stage.toLowerCase()}…`); await breathe(); };
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

  let audioCtx = null;
  const ctx = () => audioCtx || (audioCtx = new (window.AudioContext || window.webkitAudioContext)());

  async function decode(file) {
    let data;
    try {
      data = await ctx().decodeAudioData(await file.arrayBuffer());
    } catch (e) {
      throw new Error(`Could not read "${file.name}". Export it as WAV or MP3 and try again.`);
    }
    const channels = [];
    for (let c = 0; c < Math.min(2, data.numberOfChannels); c++) channels.push(data.getChannelData(c));
    return { name: file.name, channels, sampleRate: data.sampleRate };
  }

  /* ---------- playback ---------- */
  let playing = null;
  function stopPlayback() {
    if (!playing) return;
    try { playing.node.stop(); } catch (e) { /* already stopped */ }
    playing.button.textContent = playing.label;
    playing.button.setAttribute('aria-pressed', 'false');
    playing = null;
  }
  function playButton(label, getAudio) {
    const button = h('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false' }, label);
    button.addEventListener('click', async () => {
      const wasMe = playing && playing.button === button;
      stopPlayback();
      if (wasMe) return;
      const audio = getAudio();
      if (!audio) return;
      const c = ctx();
      await c.resume();
      const buffer = c.createBuffer(2, audio.channels[0].length, audio.sampleRate);
      buffer.copyToChannel(audio.channels[0], 0);
      buffer.copyToChannel(audio.channels[1] || audio.channels[0], 1);
      const node = c.createBufferSource();
      node.buffer = buffer;
      node.connect(c.destination);
      node.onended = () => { if (playing && playing.node === node) stopPlayback(); };
      node.start();
      playing = { node, button, label };
      button.textContent = 'Stop';
      button.setAttribute('aria-pressed', 'true');
    });
    return button;
  }

  /* ---------- profiles ---------- */
  function loadLearned() {
    try { state.learned = JSON.parse(localStorage.getItem(STORE) || '{}') || {}; } catch (e) { state.learned = {}; }
  }
  function saveLearned() {
    try { localStorage.setItem(STORE, JSON.stringify(state.learned)); } catch (e) { /* storage unavailable: keep in memory */ }
  }
  function allProfiles() {
    const learned = Object.entries(state.learned)
      .filter(([, p]) => p && Array.isArray(p.tracks) && p.tracks.length)
      .map(([id, p]) => M.profiles.buildLearned(id, p.name, p.tracks));
    return { builtIn: M.profiles.BUILT_IN, learned };
  }
  function currentProfile() {
    const { builtIn, learned } = allProfiles();
    return [...learned, ...builtIn].find((p) => p.id === $('style-select').value) || builtIn[0];
  }
  function fillStyleSelect(selectId) {
    const select = $('style-select');
    const keep = selectId || select.value || 'pop';
    const { builtIn, learned } = allProfiles();
    select.replaceChildren();
    if (learned.length) {
      select.append(h('optgroup', { label: 'Learned from your references' },
        learned.map((p) => h('option', { value: p.id }, `${p.name} (${p.tracks.length} song${p.tracks.length > 1 ? 's' : ''})`))));
    }
    select.append(h('optgroup', { label: 'Built-in styles' }, builtIn.map((p) => h('option', { value: p.id }, p.name))));
    select.value = keep;
    if (!select.value) select.value = 'pop';
  }
  const stage = () => (document.querySelector('input[name="stage"]:checked') || {}).value || 'master';

  /* ---------- drawing ---------- */
  function drawWave(canvas, wave) {
    const ratio = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, hgt = canvas.clientHeight;
    if (!w) return;
    canvas.width = w * ratio; canvas.height = hgt * ratio;
    const g = canvas.getContext('2d');
    g.scale(ratio, ratio);
    g.clearRect(0, 0, w, hgt);
    const css = getComputedStyle(document.documentElement);
    g.fillStyle = css.getPropertyValue('--series').trim();
    const n = wave.min.length;
    for (let x = 0; x < w; x++) {
      const a = Math.floor((x / w) * n), b = Math.max(a + 1, Math.floor(((x + 1) / w) * n));
      let lo = 0, hi = 0;
      for (let i = a; i < b && i < n; i++) { lo = Math.min(lo, wave.min[i]); hi = Math.max(hi, wave.max[i]); }
      const y1 = (0.5 - hi / 2) * hgt, y2 = (0.5 - lo / 2) * hgt;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
    g.fillStyle = css.getPropertyValue('--line').trim();
    g.fillRect(0, hgt / 2, w, 1);
  }
  const waves = [];
  function wavePanel(wave) {
    const canvas = h('canvas', { class: 'wave', role: 'img', 'aria-label': 'Waveform of the whole file' });
    waves.push({ canvas, wave });
    requestAnimationFrame(() => drawWave(canvas, wave));
    return canvas;
  }
  function redrawWaves() {
    for (let i = waves.length - 1; i >= 0; i--) {
      if (!waves[i].canvas.isConnected) waves.splice(i, 1); else drawWave(waves[i].canvas, waves[i].wave);
    }
  }

  function showTip(evt, text) {
    const tip = $('tip');
    tip.textContent = text;
    tip.hidden = false;
    const x = Math.min(window.innerWidth - tip.offsetWidth - 8, evt.clientX + 12);
    tip.style.left = `${Math.max(8, x)}px`;
    tip.style.top = `${Math.max(8, evt.clientY - tip.offsetHeight - 10)}px`;
  }
  const hideTip = () => { $('tip').hidden = true; };

  /* Deviation from the target per third-octave band. Zero line = on target; grey band = allowed range. */
  function tonalChart(a, profile, tonal) {
    const W = 720, H = 250, L = 40, R = 10, T = 24, B = 34, RANGE = 12;
    const fMin = 22, fMax = 21000;
    const x = (f) => L + ((Math.log(f / fMin) / Math.log(fMax / fMin)) * (W - L - R));
    const y = (d) => T + ((RANGE - Math.max(-RANGE, Math.min(RANGE, d))) / (2 * RANGE)) * (H - T - B);
    const nyquist = a.sampleRate / 2;
    const pts = M.THIRD_OCT.map((f, i) => ({ f, dev: tonal.shifted[i] - profile.curve[i], tol: profile.tol[i] }))
      .filter((p) => p.f < nyquist * 0.9);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Tonal balance against ${profile.name}` });
    for (const d of [-12, -6, 6, 12]) {
      root.append(svg('line', { class: 'grid', x1: L, x2: W - R, y1: y(d), y2: y(d) }));
      root.append(svg('text', { x: L - 6, y: y(d) + 4, 'text-anchor': 'end' }, `${d > 0 ? '+' : ''}${d}`));
    }
    root.append(svg('text', { x: L - 6, y: y(0) + 4, 'text-anchor': 'end' }, '0 dB'));
    for (const r of M.REGIONS) {
      if (r.lo > fMin) root.append(svg('line', { class: 'grid', x1: x(r.lo), x2: x(r.lo), y1: T, y2: H - B }));
      root.append(svg('text', { class: 'label', x: (x(Math.max(r.lo, fMin)) + x(Math.min(r.hi, fMax))) / 2, y: 14, 'text-anchor': 'middle' }, r.name));
    }
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
      root.append(svg('text', { x: x(f), y: H - B + 16, 'text-anchor': 'middle' }, f >= 1000 ? `${f / 1000}k` : String(f)));
    }
    root.append(svg('text', { x: W - R, y: H - 4, 'text-anchor': 'end' }, 'Frequency (Hz)'));
    const top = pts.map((p) => `${x(p.f)},${y(p.tol)}`);
    const bottom = pts.slice().reverse().map((p) => `${x(p.f)},${y(-p.tol)}`);
    root.append(svg('polygon', { class: 'band', points: [...top, ...bottom].join(' ') }));
    root.append(svg('line', { class: 'zero', x1: L, x2: W - R, y1: y(0), y2: y(0) }));
    root.append(svg('polyline', { class: 'line', points: pts.map((p) => `${x(p.f)},${y(p.dev)}`).join(' ') }));
    pts.forEach((p, i) => {
      const out = Math.abs(p.dev) > p.tol;
      root.append(svg('circle', { class: `dot${out ? ' out' : ''}`, cx: x(p.f), cy: y(p.dev), r: out ? 4 : 3 }));
      const left = i ? (x(pts[i - 1].f) + x(p.f)) / 2 : L;
      const right = i < pts.length - 1 ? (x(p.f) + x(pts[i + 1].f)) / 2 : W - R;
      const hit = svg('rect', { class: 'hit', x: left, y: T, width: right - left, height: H - T - B });
      const text = `${hz(p.f)}: ${Math.abs(p.dev) < 0.5 ? 'on target' : `${dbAbs(p.dev)} ${p.dev > 0 ? 'over' : 'under'} target`}${out ? ' (outside the range)' : ''}`;
      hit.addEventListener('pointermove', (e) => showTip(e, text));
      hit.addEventListener('pointerleave', hideTip);
      root.append(hit);
    });
    const rows = M.REGIONS.map((r) => {
      const { dev, tol } = tonal.regions[r.id];
      const word = Math.abs(dev) <= tol ? 'In range' : dev > 0 ? 'Too much' : 'Too little';
      return h('tr', {}, h('td', {}, r.name), h('td', {}, `${hz(r.lo)} - ${hz(r.hi)}`), h('td', {}, `${dev > 0 ? '+' : ''}${num(dev)} dB`), h('td', {}, `±${num(tol)} dB`), h('td', {}, word));
    });
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('h3', {}, `Tonal balance against ${profile.name}`),
        h('p', {}, 'Grey band is the target range. Above it is too much, below is too little.')),
      h('div', { class: 'chart' }, root),
      h('details', { class: 'table' }, h('summary', {}, 'Show as a table'),
        h('div', { class: 'scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Region', 'Range', 'Against target', 'Allowed', 'Reading'].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows)))));
  }

  function verdictBlock(result, name, note) {
    const lit = Math.round(result.score / 4);
    return h('div', { class: `verdict tone-${result.tone}` },
      h('div', { class: 'score', 'aria-label': `Score ${result.score} out of 100` }, String(result.score), h('small', {}, ' /100')),
      h('div', { class: 'word' }, h('h2', {}, result.verdict), h('span', {}, note ? `${name} · ${note}` : name)),
      h('p', {}, result.summary),
      h('div', { class: 'led', 'aria-hidden': 'true' }, Array.from({ length: 25 }, (_, i) => h('i', { class: i < lit ? 'on' : '' }))));
  }

  function fixList(issues) {
    const label = { high: 'Fix first', med: 'Fix', low: 'Polish' };
    return h('ol', { class: 'fixes' }, issues.map((i) => h('li', {},
      h('span', { class: `pill ${i.sev}` }, label[i.sev]), h('h3', {}, i.title), h('p', {}, i.fix))));
  }

  function meter(label, value, unit, note) {
    return h('div', {}, h('dt', {}, label), h('dd', {}, value, unit ? h('small', {}, unit) : null), h('span', {}, note || ''));
  }

  /* ---------- tab: full mix ---------- */
  async function loadMix(source, demo) {
    stopPlayback();
    try {
      status(`${source.name}: reading…`);
      await breathe();
      const audio = source.channels ? source : await decode(source);
      const analysis = await M.analyze(audio, { pause: pauseWith(audio.name) });
      state.mix = { name: audio.name, analysis, audio, demo: !!demo };
      status('');
      renderMix();
    } catch (e) {
      status(e.message, true);
    }
  }

  function renderMix() {
    const box = $('mix-result');
    if (!state.mix) { box.replaceChildren(); return; }
    const { analysis: a, name, audio, demo } = state.mix;
    const profile = currentProfile();
    const master = stage() === 'master';
    const result = M.advice.assessMix(a, profile, stage());
    const st = a.stereoInfo;
    const width = !a.stereo ? 'Mono' : st.correlation < 0.2 ? 'Too wide' : st.widthDb < -18 ? 'Narrow' : 'Healthy';
    const meters = h('dl', { class: 'meters' },
      meter('Loudness', num(a.lufs), 'LUFS', master ? `Target ${num(profile.lufs[0], 0)} to ${num(profile.lufs[1], 0)}` : 'Not judged before mastering'),
      meter('True peak', num(a.truePeakDb), 'dBTP', master ? 'Keep at or under -1' : 'Aim near -6 for mastering'),
      meter('Punch', num(a.plr), 'dB', `Peak above average. ${num(profile.plr[0], 0)}-${num(profile.plr[1], 0)} is typical`),
      meter('Stereo', width, '', a.stereo ? `Correlation ${num(st.correlation, 2)}` : 'Single channel'),
      meter('Tempo', a.tempo.bpm ? String(Math.round(a.tempo.bpm)) : '-', a.tempo.bpm ? 'BPM' : '', a.tempo.bpm ? 'Estimate. May read half or double' : 'No steady pulse found'),
      meter('Length', clock(a.duration), '', `${(a.sampleRate / 1000).toFixed(1)} kHz ${a.stereo ? 'stereo' : 'mono'}`));

    const copy = h('button', { class: 'btn small', type: 'button', onclick: () => copyText(mixReport(name, profile, result, a), copy) }, 'Copy report');
    box.replaceChildren(
      verdictBlock(result, name, demo ? 'example, not your audio' : ''),
      meters,
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, 'Waveform'), h('div', { class: 'row' }, playButton('Play', () => audio), copy)),
        wavePanel(a.wave)),
      tonalChart(a, profile, result.tonal),
      result.issues.length ? h('div', { class: 'panel' }, h('h3', {}, 'What to fix, most important first'), fixList(result.issues)) : null,
      master ? streamingPanel(a) : masteringPanel(a, profile, result),
      result.good.length ? h('div', { class: 'panel' }, h('h3', {}, 'Already working'), h('ul', { class: 'goods' }, result.good.map((g) => h('li', {}, g)))) : null);
  }

  function chainTable(steps) {
    return h('div', { class: 'scroll chain' }, h('table', {}, h('tbody', {}, steps.map((st) =>
      h('tr', {}, h('td', {}, st.fx), h('td', {}, st.setting), h('td', {}, st.why))))));
  }
  function masteringPanel(a, profile, result) {
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Mastering chain for this mix'), h('p', {}, `In this order, aiming at ${profile.name}`)),
      chainTable(M.advice.masteringPlan(a, profile, result)));
  }
  function streamingPanel(a) {
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'What streaming will do to it'), h('p', {}, 'Services level every song to their own loudness')),
      h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Service', 'Plays songs at', 'Your master'].map((t) => h('th', {}, t)))),
        h('tbody', {}, M.advice.streamingPreview(a).map((r) => h('tr', {}, h('td', {}, r.name), h('td', {}, `${r.target} LUFS`), h('td', {}, r.note)))))));
  }

  function mixReport(name, profile, result, a) {
    const lines = [`Mu-sixk report: ${name}`, `Compared against: ${profile.name}`, `Score: ${result.score}/100 (${result.verdict})`,
      `Loudness ${num(a.lufs)} LUFS, true peak ${num(a.truePeakDb)} dBTP, punch ${num(a.plr)} dB`, ''];
    result.issues.forEach((i, n) => lines.push(`${n + 1}. ${i.title}`, `   ${i.fix}`));
    if (stage() !== 'master') {
      lines.push('', 'Mastering chain:');
      for (const st of M.advice.masteringPlan(a, profile, result)) lines.push(`- ${st.fx}: ${st.setting}`);
    }
    if (result.good.length) lines.push('', 'Already working:', ...result.good.map((g) => `- ${g}`));
    return lines.join('\n');
  }

  async function copyText(text, button) {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch (e) {
      const area = h('textarea', { rows: '8', readonly: true, 'aria-label': 'Report text' });
      area.value = text;
      button.closest('.panel').append(area);
      area.select();
      button.textContent = 'Select and copy below';
    }
    setTimeout(() => { button.textContent = original; }, 2000);
  }

  /* ---------- tab: stems ---------- */
  async function addStems(sources) {
    stopPlayback();
    for (const source of sources) {
      try {
        status(`${source.name}: reading…`);
        await breathe();
        const audio = source.channels ? source : await decode(source);
        const analysis = await M.analyze(audio, { pause: pauseWith(audio.name) });
        state.stems.push({
          id: state.nextId++, name: audio.name.replace(/\.[a-z0-9]+$/i, ''), analysis,
          role: M.advice.guessRole(audio.name, analysis),
          file: source.channels ? null : source, audio: source.channels ? audio : null,
        });
        renderStems();
      } catch (e) {
        status(e.message, true);
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    status('');
    runMixdown();
  }

  function stemPlan() {
    const profile = currentProfile();
    const bpm = M.advice.songTempo(state.stems);
    const gains = state.stems.length ? M.advice.balanceStems(state.stems, profile) : [];
    return { profile, bpm, gains };
  }

  function renderStems() {
    const list = $('stems-list');
    $('stems-clear').hidden = !state.stems.length;
    if (!state.stems.length) { list.replaceChildren(); $('stems-together').replaceChildren(); return; }
    const { profile, bpm, gains } = stemPlan();
    const seen = {};
    const counts = {};
    for (const s of state.stems) counts[s.role] = (counts[s.role] || 0) + 1;
    list.replaceChildren(h('h2', {}, 'Each track: what to put on it'), ...state.stems.map((s, i) => {
      const index = (seen[s.role] = (seen[s.role] || 0) + 1) - 1;
      const recipe = M.advice.stemRecipe(s.analysis, s.role, { profile, bpm, sameRoleIndex: index, sameRoleCount: counts[s.role] });
      const select = h('select', { id: `role-${s.id}`, 'aria-label': `Instrument for ${s.name}` },
        Object.entries(M.advice.ROLES).map(([id, r]) => h('option', { value: id, selected: id === s.role }, r.name)));
      select.addEventListener('change', () => { s.role = select.value; renderStems(); runMixdown(); });
      const g = gains[i];
      return h('div', { class: 'panel stem' },
        h('div', { class: 'panel-head' },
          h('h3', {}, s.name),
          h('div', { class: 'row' },
            h('span', { class: 'fader', title: 'Move this track\'s fader by this much from where it is now' }, `Fader ${g > 0 ? '+' : ''}${g.toFixed(1)} dB`),
            select,
            h('button', { class: 'btn small', type: 'button', 'aria-label': `Remove ${s.name}`, onclick: () => { state.stems = state.stems.filter((x) => x !== s); renderStems(); runMixdown(); } }, 'Remove'))),
        h('details', { open: i === 0 },
          h('summary', {}, `Effect chain, in order (${recipe.steps.length} steps)`),
          h('div', { class: 'scroll chain' }, h('table', {}, h('tbody', {}, recipe.steps.map((st) =>
            h('tr', {}, h('td', {}, st.fx), h('td', {}, st.setting), h('td', {}, st.why))))))));
    }));
  }

  /* Sum the stems twice (as loaded, and with the suggested fader moves) and judge both. */
  async function runMixdown() {
    const run = ++state.mixdownRun;
    const box = $('stems-together');
    if (state.stems.length < 2) {
      box.replaceChildren(state.stems.length ? h('p', { class: 'empty' }, 'Add at least one more track to see how they sit together.') : '');
      return;
    }
    const { profile, bpm, gains } = stemPlan();
    const stems = state.stems.slice();
    try {
      let raw = null, bal = null, fs = 0;
      for (let i = 0; i < stems.length; i++) {
        status(`Summing the tracks: ${stems[i].name}…`);
        await breathe();
        const audio = stems[i].audio || await decode(stems[i].file);
        if (run !== state.mixdownRun) return;
        if (!raw) {
          fs = audio.sampleRate;
          const longest = Math.max(...stems.map((s) => Math.ceil(s.analysis.duration * fs) + 1));
          raw = [new Float32Array(longest), new Float32Array(longest)];
          bal = [new Float32Array(longest), new Float32Array(longest)];
        }
        const g = Math.pow(10, gains[i] / 20);
        for (let c = 0; c < 2; c++) {
          const src = audio.channels[c] || audio.channels[0];
          const n = Math.min(src.length, raw[c].length);
          for (let k = 0; k < n; k++) { raw[c][k] += src[k]; bal[c][k] += g * src[k]; }
        }
      }
      /* Bring both sums to -6 dBFS peak so they are judged on balance, not on level. */
      const trim = (chs) => {
        let peak = 0;
        for (const ch of chs) for (let k = 0; k < ch.length; k++) { const v = Math.abs(ch[k]); if (v > peak) peak = v; }
        const g = peak > 0 ? 0.5 / peak : 1;
        for (const ch of chs) for (let k = 0; k < ch.length; k++) ch[k] *= g;
        return 20 * Math.log10(g);
      };
      trim(raw);
      const balTrim = trim(bal);
      const aRaw = await M.analyze({ channels: raw, sampleRate: fs }, { pause: pauseWith('Your current balance') });
      const aBal = await M.analyze({ channels: bal, sampleRate: fs }, { pause: pauseWith('Suggested balance') });
      if (run !== state.mixdownRun) return;
      const rRaw = M.advice.assessMix(aRaw, profile, 'mix');
      const rBal = M.advice.assessMix(aBal, profile, 'mix');
      state.mixdown = { raw: { channels: raw, sampleRate: fs }, bal: { channels: bal, sampleRate: fs } };
      status('');
      renderTogether({ profile, bpm, gains, stems, rRaw, rBal, aBal, balTrim });
    } catch (e) {
      status(e.message, true);
    }
  }

  function renderTogether({ profile, bpm, gains, stems, rRaw, rBal, aBal, balTrim }) {
    const named = stems.map((s, i) => ({ ...s, gain: gains[i] }));
    const clashes = M.advice.findClashes(named, gains, bpm);
    const gaps = M.advice.findGaps(rBal, named);
    const better = rBal.score > rRaw.score;
    const lead = better
      ? 'The suggested fader moves bring the balance closer to the target. Set the faders, then work through the effect chains below.'
      : rBal.score === rRaw.score
        ? 'Your balance and the suggested one score the same. Use the fader moves as a second opinion.'
        : 'Your current balance already scores higher than the suggested one. Keep your faders and treat the moves as a second opinion.';
    const remaining = rBal.issues.filter((i) => i.area !== 'Level' && i.area !== 'Loudness');
    $('stems-together').replaceChildren(h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'How it comes together'),
        h('p', {}, `${stems.length} tracks, judged as ${profile.name}${bpm ? `, about ${Math.round(bpm)} BPM` : ''}`)),
      h('div', { class: 'compare' },
        h('div', {}, h('span', {}, 'As loaded'), h('strong', { class: 'big' }, String(rRaw.score))),
        h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
        h('div', {}, h('span', {}, 'With the fader moves'), h('strong', { class: 'big' }, String(rBal.score))),
        h('div', { class: 'row' },
          playButton('Play as loaded', () => state.mixdown && state.mixdown.raw),
          playButton('Play with fader moves', () => state.mixdown && state.mixdown.bal))),
      h('p', {}, lead),
      h('p', { class: 'empty' }, `After the moves, ${balTrim < 0 ? `pull every fader down another ${dbAbs(balTrim)}` : `you can push every fader up ${dbAbs(balTrim)}`} so the mix bus peaks near -6 dBFS. Both previews are level-matched and have no effects on them.`),
      gaps.length ? h('div', { class: 'sub' }, h('h3', {}, 'What it is missing'), h('ul', {}, gaps.map((g) => h('li', {}, g)))) : null,
      clashes.length ? h('div', { class: 'sub' }, h('h3', {}, 'Tracks fighting for the same space'),
        h('ul', {}, clashes.map((c) => h('li', {}, h('strong', {}, `${c.a} and ${c.b}, ${hz(c.lo)} to ${hz(c.hi)}. `), c.fix)))) : null,
      remaining.length ? h('div', { class: 'sub' }, h('h3', {}, 'Still off after balancing'), fixList(remaining)) : null,
      wavePanel(aBal.wave)));
  }

  /* ---------- tab: teach ---------- */
  async function addReferences(files) {
    const name = $('teach-name').value.trim() || 'My sound';
    const id = `learned-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    let added = 0;
    for (const file of files) {
      try {
        status(`${file.name}: reading…`);
        await breathe();
        const audio = await decode(file);
        const analysis = await M.analyze(audio, { pause: pauseWith(file.name) });
        const entry = state.learned[id] || (state.learned[id] = { name, tracks: [] });
        entry.tracks.push(M.profiles.fingerprint(file.name, analysis));
        added++;
      } catch (e) {
        status(e.message, true);
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    if (!added) return;
    saveLearned();
    fillStyleSelect(id);
    renderTeach();
    renderMix();
    renderStems();
    await runMixdown();
    const count = state.learned[id].tracks.length;
    status(`Learned "${name}" from ${count} song${count > 1 ? 's' : ''}. It is now selected under "Compare against".`);
  }

  function renderTeach() {
    const entries = Object.entries(state.learned).filter(([, p]) => p && p.tracks && p.tracks.length);
    $('teach-json').value = entries.length ? JSON.stringify(state.learned) : '';
    $('teach-list').replaceChildren(...(entries.length ? entries.map(([id, p]) => h('div', { class: 'panel learned' },
      h('div', {}, h('h3', {}, p.name), h('p', {}, `${p.tracks.length} song${p.tracks.length > 1 ? 's' : ''}: ${p.tracks.map((t) => t.name).join(', ')}`)),
      h('button', { class: 'btn small', type: 'button', onclick: () => { delete state.learned[id]; saveLearned(); fillStyleSelect(); renderTeach(); renderMix(); renderStems(); runMixdown(); } }, 'Forget')))
      : [h('p', { class: 'empty' }, 'Nothing learned yet. Add a few finished songs above to make your first sound.')]));
  }

  function importLearned() {
    try {
      const data = JSON.parse($('teach-json').value);
      let count = 0;
      for (const [id, p] of Object.entries(data)) {
        const ok = p && typeof p.name === 'string' && Array.isArray(p.tracks) && p.tracks.every((t) =>
          Array.isArray(t.thirdOct) && t.thirdOct.length === M.THIRD_OCT.length && t.thirdOct.every(Number.isFinite) && Number.isFinite(t.lufs) && Number.isFinite(t.plr));
        if (!ok || !/^learned-[a-z0-9-]*$/.test(id)) continue;
        state.learned[id] = { name: p.name.slice(0, 40), tracks: p.tracks.map((t) => ({ name: String(t.name).slice(0, 120), thirdOct: t.thirdOct, lufs: t.lufs, plr: t.plr, widthDb: Number(t.widthDb) || 0 })) };
        count++;
      }
      if (!count) throw new Error('none');
      saveLearned(); fillStyleSelect(); renderTeach();
      status(`Imported ${count} learned sound${count > 1 ? 's' : ''}.`);
    } catch (e) {
      status('That text is not a Mu-sixk export. Copy it again from the other computer.', true);
    }
  }

  /* ---------- wiring ---------- */
  function wireDrop(zone, input, onFiles) {
    const audioOnly = (list) => Array.from(list).filter((f) => /^audio\//.test(f.type) || /\.(wav|mp3|flac|m4a|ogg|aiff?|aac|opus)$/i.test(f.name));
    input.addEventListener('change', () => { const files = audioOnly(input.files); input.value = ''; if (files.length) onFiles(files); });
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault(); zone.classList.remove('over');
      const files = audioOnly(e.dataTransfer.files);
      if (files.length) onFiles(files); else status('Those are not audio files. Drop WAV, MP3, FLAC, M4A or OGG.', true);
    });
  }

  function selectTab(name) {
    for (const t of ['mix', 'stems', 'teach']) {
      $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
      $(`panel-${t}`).hidden = t !== name;
    }
    $('stage').hidden = name !== 'mix';
    requestAnimationFrame(redrawWaves);
  }

  function start() {
    loadLearned();
    fillStyleSelect('pop');
    for (const t of ['mix', 'stems', 'teach']) $(`tab-${t}`).addEventListener('click', () => selectTab(t));
    wireDrop($('drop-mix'), $('file-mix'), (files) => loadMix(files[0]));
    wireDrop($('drop-stems'), $('file-stems'), addStems);
    wireDrop($('drop-teach'), $('file-teach'), addReferences);
    $('stems-demo').addEventListener('click', () => { state.stems = []; addStems(M.demo.makeDemoStems()); });
    $('stems-clear').addEventListener('click', () => { stopPlayback(); state.stems = []; state.mixdownRun++; renderStems(); });
    $('style-select').addEventListener('change', () => { renderMix(); renderStems(); runMixdown(); });
    for (const r of document.querySelectorAll('input[name="stage"]')) r.addEventListener('change', renderMix);
    $('teach-copy').addEventListener('click', () => copyText($('teach-json').value, $('teach-copy')));
    $('teach-import').addEventListener('click', importLearned);
    window.addEventListener('resize', redrawWaves);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', redrawWaves);
    new MutationObserver(redrawWaves).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    renderTeach();
    loadMix(M.demo.makeDemoMix(M.demo.makeDemoStems()), true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
