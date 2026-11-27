/* Mu-sixk interface. Everything runs in the page: files are decoded with Web Audio and never uploaded. */
(function () {
  'use strict';
  const M = window.MuSixk;
  const { num, hz, dbAbs } = M.advice.format;
  const $ = (id) => document.getElementById(id);
  const STORE = 'musixk.learned.v1';

  const state = { learned: {}, mix: null, stems: [], mixdown: null, mixdownRun: 0, nextId: 1 };

  /* ---------- small helpers ---------- */
  const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter((k) => k != null && k !== false));
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
  function playButton(label, getAudio, offset = 0) {
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
      node.start(0, Math.max(0, Math.min(offset, buffer.duration - 0.05)));
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
    const reference = state.ref ? [M.profiles.buildLearned('reference', `Reference: ${state.ref.name}`, [M.profiles.fingerprint(state.ref.name, state.ref.analysis)])] : [];
    return { builtIn: M.profiles.BUILT_IN, learned, reference };
  }
  function currentProfile() {
    const { builtIn, learned, reference } = allProfiles();
    return [...reference, ...learned, ...builtIn].find((p) => p.id === $('style-select').value) || builtIn[0];
  }
  function fillStyleSelect(selectId) {
    const select = $('style-select');
    const keep = selectId || select.value || 'pop';
    const { builtIn, learned, reference } = allProfiles();
    fill(select);
    if (reference.length) select.append(h('optgroup', { label: 'Reference song' }, reference.map((p) => h('option', { value: p.id }, p.name.replace(/\.[a-z0-9]+$/i, '')))));
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
      h('div', { class: 'score', 'aria-label': `${result.score} percent good` }, `${result.score}%`, h('small', {}, ' good')),
      h('div', { class: 'word' }, h('h2', {}, result.verdict), h('span', {}, note ? `${name} · ${note}` : name)),
      h('p', {}, result.summary),
      h('div', { class: 'led', 'aria-hidden': 'true' }, Array.from({ length: 25 }, (_, i) => h('i', { class: i < lit ? 'on' : '' }))));
  }

  function fixList(issues) {
    const label = { high: 'Fix first', med: 'Fix', low: 'Polish' };
    return h('ol', { class: 'fixes' }, issues.map((i) => {
      const tool = M.advice.TOOLS[i.tool];
      return h('li', {},
        h('span', { class: `pill ${i.sev}` }, label[i.sev]),
        h('h3', {}, i.title),
        h('p', {}, i.fix),
        tool ? h('div', { class: 'use' },
          h('span', { class: 'tool' }, 'Use: ', h('strong', {}, tool.name)),
          h('dl', { class: 'settings' }, i.settings.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))))) : null);
    }));
  }

  /* The tools the fixes call for, each with what it does and a free plugin that does it. */
  function toolboxPanel(keys) {
    const tools = M.advice.toolbox(keys);
    if (!tools.length) return null;
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'What you need for this'), h('p', {}, 'The plugins that came with your DAW do all of these')),
      h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Tool', 'What it does', 'Used in', 'A free one'].map((t) => h('th', {}, t)))),
        h('tbody', {}, tools.map((t) => h('tr', {}, h('td', {}, h('strong', {}, t.name)), h('td', {}, t.does),
          h('td', {}, `${t.uses} fix${t.uses > 1 ? 'es' : ''}`), h('td', {}, t.free || 'Built into every DAW')))))));
  }

  function bar(pct, tone) {
    return h('div', { class: `bar tone-${tone}`, role: 'img', 'aria-label': `${pct} percent` }, h('i', { style: `width:${pct}%` }));
  }
  /* Part-by-part grades for a finished song. */
  function reportPanel(result) {
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Part by part'), h('p', {}, 'Levels come from a model trained on real songs; tone from where each part sits in the sound.')),
      h('div', { class: 'card' }, M.advice.reportCard(result).map((p) => h('div', { class: 'card-row' },
        h('strong', {}, p.name), bar(p.pct, p.tone), h('span', { class: `pct tone-${p.tone}` }, `${p.pct}% ${p.word}`),
        p.level ? h('p', { class: 'level' }, 'Level in the mix: ', h('strong', {}, `${num(p.level.value)} dB`),
          ` · usual ${num(p.level.judge.lo)} to ${num(p.level.judge.hi)} dB · ±${num(p.level.mae)} dB accuracy`) : null,
        h('p', {}, p.found.length ? p.found.map((i) => i.title).join(' · ') : 'Nothing wrong found.', h('em', {}, ` ${p.about}`))))));
  }

  /* Loudness over time, the sections, and timestamped findings you can click to hear. */
  function timelinePanel(a, result, profile, audio) {
    const list = M.advice.moments(a, profile, result);
    const W = 720, H = 190, L = 40, R = 10, T = 30, B = 24;
    const dur = a.duration;
    const curve = (a.loudCurve || []).filter(([, v]) => v > -70);
    const top = curve.length ? Math.ceil(Math.max(...curve.map(([, v]) => v)) + 3) : 0;
    const lo = top - 24;
    const x = (t) => L + (Math.max(0, Math.min(dur, t)) / dur) * (W - L - R);
    const y = (v) => T + ((top - Math.max(lo, Math.min(top, v))) / (top - lo)) * (H - T - B);
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Loudness over time with sections and findings' });
    (a.sections || []).forEach((sec, i) => {
      root.append(svg('rect', { class: i % 2 ? 'band alt' : 'band', x: x(sec.start), y: T, width: Math.max(1, x(sec.end) - x(sec.start)), height: H - T - B }));
      if (x(sec.end) - x(sec.start) > 16) root.append(svg('text', { class: 'label', x: (x(sec.start) + x(sec.end)) / 2, y: H - B - 8, 'text-anchor': 'middle' }, sec.letter + (sec.tags.includes('loudest') ? '★' : '')));
    });
    for (let v = top - 6; v > lo; v -= 6) {
      root.append(svg('line', { class: 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
      root.append(svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
    }
    root.append(svg('text', { x: 4, y: 12 }, 'LUFS (3 s)'));
    const step = dur > 300 ? 60 : dur > 120 ? 30 : dur > 40 ? 10 : 5;
    for (let t = 0; t <= dur; t += step) root.append(svg('text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }, clock(t)));
    if (curve.length > 1) root.append(svg('polyline', { class: 'line', points: curve.map(([t, v]) => `${x(t)},${y(v)}`).join(' ') }));
    list.forEach((m) => {
      const cx = x(m.t0);
      const dot = svg('circle', { class: `mark ${m.sev}`, cx, cy: 20, r: 6, tabindex: '0', role: 'button', 'aria-label': `${clock(m.t0)} ${m.title}` });
      const play = () => { const b = playButton('', () => audio, m.t0); b.click(); };
      dot.addEventListener('click', play);
      dot.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); play(); } });
      dot.addEventListener('pointermove', (e) => showTip(e, `${clock(m.t0)} · ${m.title}`));
      dot.addEventListener('pointerleave', hideTip);
      root.append(svg('line', { class: `markline ${m.sev}`, x1: cx, x2: cx, y1: 26, y2: H - B }), dot);
    });
    const label = { high: 'Fix first', med: 'Fix', low: 'Polish' };
    const rows = (a.sections || []).map((sec) => h('tr', {},
      h('td', {}, `${sec.letter}${sec.tags.length ? ` (${sec.tags.join(', ')})` : ''}`),
      h('td', {}, `${clock(sec.start)} - ${clock(sec.end)}`), h('td', {}, `${num(sec.lufs)} LUFS`),
      h('td', {}, sec.elements && Number.isFinite(sec.elements.vocals) ? `${num(sec.elements.vocals)} dB` : '-'),
      h('td', {}, h('span', {}, playButton('Play', () => audio, sec.start)))));
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Through the song'),
        h('p', {}, `${(a.sections || []).length} sections found. Letters repeat when sections sound alike; ★ is the loudest. Click a dot to hear it.`)),
      h('div', { class: 'chart tl' }, root),
      list.length ? h('ol', { class: 'fixes compact moments' }, list.map((m) => h('li', {},
        h('span', { class: `pill ${m.sev}` }, label[m.sev]),
        h('h3', {}, playButton(`▶ ${clock(m.t0)}`, () => audio, m.t0), ' ', m.title),
        h('p', {}, m.detail))))
        : h('p', { class: 'empty' }, 'Nothing goes wrong in one place more than the rest of the song.'),
      (a.sections || []).length > 1 ? h('details', { class: 'table' }, h('summary', {}, 'Show sections as a table'),
        h('div', { class: 'scroll' }, h('table', {},
          h('thead', {}, h('tr', {}, ['Section', 'Time', 'Loudness', 'Vocal level', ''].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows)))) : null);
  }
  function problemList(dx) {
    const label = { high: 'Fix first', med: 'Fix', low: 'Polish' };
    if (!dx.problems.length) return h('p', { class: 'empty' }, 'Nothing wrong found with this track. The chain below is polish.');
    return h('ol', { class: 'fixes compact' }, dx.problems.map((x) => h('li', {},
      h('span', { class: `pill ${x.sev}` }, label[x.sev]), h('h3', {}, x.title), h('p', {}, x.detail))));
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

  /* ---------- key finder ---------- */
  let listening = null;

  function sureWord(p) { return p >= 0.8 ? 'Very sure' : p >= 0.55 ? 'Fairly sure' : p >= 0.35 ? 'Leaning' : 'Unsure'; }
  const enharmonic = (name) => {
    const map = { 'C#': 'Db', 'D#': 'Eb', 'F#': 'Gb', 'G#': 'Ab', 'A#': 'Bb', Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };
    const [note, mode] = name.split(' ');
    return map[note] ? `${map[note]} ${mode}` : null;
  };

  /* Short synth notes for hearing the key: the home chord, or any chord in it. */
  function playNotes(midis, seconds = 1.6) {
    const c = ctx();
    c.resume();
    const now = c.currentTime;
    const out = c.createGain();
    out.gain.value = 0.18 / Math.sqrt(midis.length);
    out.connect(c.destination);
    for (const m of midis) {
      const o = c.createOscillator(), g = c.createGain();
      o.type = 'triangle';
      o.frequency.value = 440 * Math.pow(2, (m - 69) / 12);
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(1, now + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, now + seconds);
      o.connect(g); g.connect(out);
      o.start(now); o.stop(now + seconds + 0.05);
    }
  }
  function chordMidis(rootPc, quality) {
    const root = 48 + rootPc + (rootPc > 6 ? -12 : 0) + 12;
    const third = quality === 'm' || quality === 'dim' ? 3 : 4, fifth = quality === 'dim' ? 6 : 7;
    return [root - 12, root, root + third, root + fifth];
  }

  /* ---------- key finder graphics ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  const pcOf = (name) => Math.max(M.key.NOTES.indexOf(name), M.key.FLATS.indexOf(name));
  const spell = (r, pc) => r.scale[r.scalePcs.indexOf(pc)] || (M.key.FLATS.includes(r.scale[0]) && r.scale.some((n) => n.includes('b')) ? M.key.FLATS : M.key.NOTES)[pc];
  const toneOf = (p) => (p >= 0.8 ? 'good' : p >= 0.55 ? 'ok' : p >= 0.35 ? 'warn' : 'bad');
  const tipOn = (el, text) => { el.addEventListener('pointermove', (e) => showTip(e, text)); el.addEventListener('pointerleave', hideTip); return el; };

  /* Donut showing how sure it is. */
  function ring(p, label, size = 132) {
    const r = 52, c = 2 * Math.PI * r, tone = toneOf(p);
    return h('div', { class: 'gauge' },
      svg('svg', { viewBox: '0 0 132 132', width: size, height: size, role: 'img', 'aria-label': `${label}: ${Math.round(p * 100)}%` },
        svg('circle', { class: 'ring-bg', cx: 66, cy: 66, r }),
        svg('circle', { class: `ring-fg tone-${tone}`, cx: 66, cy: 66, r, 'stroke-dasharray': `${c * p} ${c}`, transform: 'rotate(-90 66 66)' }),
        svg('text', { class: 'ring-num', x: 66, y: 70, 'text-anchor': 'middle' }, `${Math.round(p * 100)}%`),
        svg('text', { class: 'ring-sub', x: 66, y: 90, 'text-anchor': 'middle' }, sureWord(p).toLowerCase())),
      h('span', {}, label));
  }

  /* Half-dial needle from -50 to +50 cents: how far the recording sits from A = 440 Hz. */
  function tuningDial(cents, refA) {
    const a = (Math.max(-50, Math.min(50, cents)) / 50) * 80;
    const rad = ((a - 90) * Math.PI) / 180;
    const ticks = [-50, -25, 0, 25, 50].map((v) => {
      const t = (((v / 50) * 80 - 90) * Math.PI) / 180;
      return svg('line', { class: 'tick', x1: 66 + 46 * Math.cos(t), y1: 70 + 46 * Math.sin(t), x2: 66 + 54 * Math.cos(t), y2: 70 + 54 * Math.sin(t) });
    });
    return h('div', { class: 'gauge' },
      tipOn(svg('svg', { viewBox: '0 0 132 92', width: 132, height: 92, role: 'img', 'aria-label': `Tuning ${Math.round(cents)} cents, A = ${refA.toFixed(1)} Hz` },
        svg('path', { class: 'dial', d: 'M 15 70 A 51 51 0 0 1 117 70' }),
        svg('path', { class: 'dial-ok', d: `M ${66 + 51 * Math.cos((-98 * Math.PI) / 180)} ${70 + 51 * Math.sin((-98 * Math.PI) / 180)} A 51 51 0 0 1 ${66 + 51 * Math.cos((-82 * Math.PI) / 180)} ${70 + 51 * Math.sin((-82 * Math.PI) / 180)}` }),
        ...ticks,
        svg('line', { class: 'needle', x1: 66, y1: 70, x2: 66 + 44 * Math.cos(rad), y2: 70 + 44 * Math.sin(rad) }),
        svg('circle', { class: 'hub', cx: 66, cy: 70, r: 4 }),
        svg('text', { class: 'ring-sub', x: 66, y: 88, 'text-anchor': 'middle' }, `A = ${refA.toFixed(0)} Hz`)),
      `${cents > 0 ? '+' : ''}${Math.round(cents)} cents from standard A = 440 Hz`),
      h('span', {}, 'Tuning'));
  }

  /* Camelot wheel: outer ring majors (B), inner ring minors (A). Fill = this key / alternatives; outline = mixes with. */
  function camelotWheel(r) {
    const W = 300, C = W / 2;
    const root = svg('svg', { viewBox: `0 0 ${W} ${W}`, class: 'wheel', role: 'img', 'aria-label': `Camelot wheel: ${r.camelot} ${r.name}` });
    const p = new Map(r.ranked.slice(0, 6).map((k) => [`${k.tonic}${k.mode}`, k.p]));
    const mixes = new Set(r.mixesWith.map((s) => s.split(' ')[0]));
    const seg = (i, r0, r1) => {
      const a0 = ((i * 30 - 105) * Math.PI) / 180, a1 = ((i * 30 - 75) * Math.PI) / 180;
      const pt = (rr, a) => `${C + rr * Math.cos(a)} ${C + rr * Math.sin(a)}`;
      return `M ${pt(r1, a0)} A ${r1} ${r1} 0 0 1 ${pt(r1, a1)} L ${pt(r0, a1)} A ${r0} ${r0} 0 0 0 ${pt(r0, a0)} Z`;
    };
    for (let num = 1; num <= 12; num++) {
      for (const mode of ['major', 'minor']) {
        const tonic = mode === 'major' ? [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1].indexOf(num) : ([8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1].indexOf(num) + 9) % 12;
        const code = `${num}${mode === 'major' ? 'B' : 'A'}`;
        const name = M.key.keyName(tonic, mode);
        const prob = p.get(`${tonic}${mode}`) || 0;
        const isKey = tonic === r.tonic && mode === r.mode;
        const [r0, r1] = mode === 'major' ? [96, 146] : [52, 94];
        const path = svg('path', { d: seg(num - 1, r0, r1), class: `cw${isKey ? ' key' : ''}${!isKey && mixes.has(code) ? ' mix' : ''}`, style: !isKey && prob > 0.02 ? `--p:${Math.min(1, 0.25 + prob * 1.5)}` : '' });
        if (!isKey && prob > 0.02) path.classList.add('alt');
        tipOn(path, `${code} · ${name}${isKey ? ' · this key' : prob > 0.02 ? ` · ${Math.round(prob * 100)}%` : mixes.has(code) ? ' · mixes well' : ''}`);
        const mid = (((num - 1) * 30 - 90) * Math.PI) / 180, rr = (r0 + r1) / 2;
        const short = name.replace(' major', '').replace(' minor', 'm');
        root.append(path,
          svg('text', { class: `cw-t${isKey ? ' on' : ''}`, x: C + rr * Math.cos(mid), y: C + rr * Math.sin(mid) - 2, 'text-anchor': 'middle' }, short),
          svg('text', { class: `cw-c${isKey ? ' on' : ''}`, x: C + rr * Math.cos(mid), y: C + rr * Math.sin(mid) + 10, 'text-anchor': 'middle' }, code));
      }
    }
    root.append(svg('text', { class: 'cw-mid', x: C, y: C + 6, 'text-anchor': 'middle' }, r.camelot));
    return h('div', { class: 'panel wheelbox' },
      h('h3', {}, 'Camelot wheel'),
      root,
      h('div', { class: 'legend' },
        h('span', {}, h('i', { class: 'sw key' }), 'this key'),
        h('span', {}, h('i', { class: 'sw alt' }), 'could be'),
        h('span', {}, h('i', { class: 'sw mix' }), 'mixes with')));
  }

  /* One-octave keyboard lit by how much of each note was heard; dots mark the scale, a ring the home note. */
  function keyboard(r) {
    const whites = [0, 2, 4, 5, 7, 9, 11], blacks = [[1, 0], [3, 1], [6, 3], [8, 4], [10, 5]];
    const KW = 56, W = KW * 7, H = 170;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'piano', role: 'img', 'aria-label': `Notes heard; scale ${r.scale.join(' ')}` });
    const key = (pc, x, y, w, hh, black) => {
      const v = r.chroma[pc] || 0, inKey = r.scalePcs.includes(pc), home = pc === r.tonic;
      const g = svg('g', {});
      g.append(svg('rect', { class: black ? 'pk-b' : 'pk-w', x, y, width: w, height: hh, rx: 4 }));
      if (v > 0.04) g.append(svg('rect', { class: `pk-lit${inKey ? '' : ' out'}`, x: x + 3, y: y + hh - 6 - (hh - 30) * v, width: w - 6, height: (hh - 30) * v, rx: 3 }));
      if (inKey) g.append(svg('circle', { class: `pk-dot${home ? ' home' : ''}`, cx: x + w / 2, cy: y + hh - (black ? 14 : 16), r: home ? 7 : 4.5 }));
      g.append(svg('text', { class: `pk-n${black ? ' blk' : ''}${home ? ' home' : ''}`, x: x + w / 2, y: y + (black ? 16 : 18), 'text-anchor': 'middle' }, spell(r, pc)));
      return tipOn(g, `${spell(r, pc)}: heard ${Math.round(v * 100)}%${home ? ' · home note' : inKey ? ' · in the key' : ' · outside the key'}`);
    };
    whites.forEach((pc, i) => root.append(key(pc, i * KW + 1, 1, KW - 2, H - 2, false)));
    blacks.forEach(([pc, after]) => root.append(key(pc, (after + 1) * KW - 17, 1, 34, 104, true)));
    return h('div', { class: 'panel' }, h('h3', {}, 'Notes heard'), root);
  }

  /* Chord tiles coloured by job: home (I, vi, iii), away (IV, ii), tension (V, vii). Tap to hear. */
  function chordTiles(r) {
    const role = (roman) => (/^(I|i|vi|VI|iii|III)$/.test(roman) ? 'home' : /^(IV|iv|ii|ii°)$/.test(roman) ? 'away' : 'tension');
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Chords that fit'),
        h('div', { class: 'legend' }, h('span', {}, h('i', { class: 'sw home' }), 'home'), h('span', {}, h('i', { class: 'sw away' }), 'away'), h('span', {}, h('i', { class: 'sw tension' }), 'tension'))),
      h('div', { class: 'tiles' }, r.chords.map((c) => {
        const quality = /dim/.test(c.name) ? 'dim' : /m$/.test(c.name) ? 'm' : '';
        return h('button', { class: `tile ${role(c.roman.split(' ')[0])}`, type: 'button', 'aria-label': `Play ${c.name}`, onclick: () => playNotes(chordMidis(pcOf(c.name.replace(/(m|dim)$/, '')), quality)) },
          h('strong', {}, c.name), h('small', {}, c.roman.replace(' (harmonic)', '*')), h('span', { class: 'play', 'aria-hidden': 'true' }, '▶'));
      })));
  }

  /* Piano roll of the sung notes against the key: scale rows shaded, home row highlighted, out-of-key notes flagged. */
  function pianoRoll(r) {
    const notes = r.notes;
    const lo = Math.min(...notes.map((n) => n.midi)) - 1, hi = Math.max(...notes.map((n) => n.midi)) + 1;
    const t0 = notes[0].start, t1 = notes[notes.length - 1].end;
    const W = 720, L = 40, R = 8, T = 6, B = 22, rowH = Math.max(7, Math.min(16, 220 / (hi - lo + 1)));
    const H = T + B + rowH * (hi - lo + 1);
    const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const y = (m) => T + (hi - m) * rowH;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'roll', role: 'img', 'aria-label': `Sung notes from ${r.range.low} to ${r.range.high}` });
    let lastLabel = Infinity;
    for (let m = hi; m >= lo; m--) {
      const pc = ((m % 12) + 12) % 12, inKey = r.scalePcs.includes(pc);
      if (inKey) root.append(svg('rect', { class: pc === r.tonic ? 'row home' : 'row', x: L, y: y(m), width: W - L - R, height: rowH }));
      /* Label home notes always, other scale notes only where they will not collide with the label above. */
      const room = (lastLabel - m) * rowH >= 13;
      if (inKey && room && (pc === r.tonic || rowH >= 7)) {
        root.append(svg('text', { class: pc === r.tonic ? 'label' : '', x: L - 5, y: y(m) + rowH / 2 + 4, 'text-anchor': 'end' }, `${spell(r, pc)}${Math.floor(m / 12) - 1}`));
        lastLabel = m;
      }
    }
    const step = t1 - t0 > 60 ? 15 : t1 - t0 > 20 ? 5 : 2;
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) root.append(svg('text', { x: x(t), y: H - 6, 'text-anchor': 'middle' }, clock(t)));
    for (const n of notes) {
      const inKey = r.scalePcs.includes(((n.midi % 12) + 12) % 12);
      root.append(tipOn(svg('rect', { class: `nr${inKey ? '' : ' out'}`, x: x(n.start), y: y(n.midi) + 1, width: Math.max(2, x(n.end) - x(n.start)), height: rowH - 2, rx: 2 }),
        `${spell(r, ((n.midi % 12) + 12) % 12)}${Math.floor(n.midi / 12) - 1} at ${clock(n.start)} · ${n.cents > 0 ? '+' : ''}${n.cents} cents${inKey ? '' : ' · outside the key'}`));
    }
    return root;
  }

  function vocalPanel(r) {
    const inKey = Math.max(0, 1 - r.offKey);
    const pitchScore = Math.max(0, Math.min(1, 1 - r.intonation / 50));
    const cands = [{ name: r.name, p: r.confidence }, ...r.alternatives.slice(0, 2)];
    const chordOf = (name) => { const [note, mode] = name.split(' '); return chordMidis(pcOf(note), mode === 'minor' ? 'm' : ''); };
    return [
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, 'Your singing'), h('p', {}, `${r.notes.length} notes`)),
        h('div', { class: 'chart' }, pianoRoll(r)),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('strong', {}, `${r.range.low}–${r.range.high}`), h('span', {}, `range · ${r.range.semitones} semitones`)),
          tipOn(ring(pitchScore, 'on pitch', 96), `Notes land on average ${r.intonation} cents from true pitch`),
          tipOn(ring(inKey, 'in the key', 96), `${Math.round(r.offKey * 100)}% of the singing is outside ${r.name}`))),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, 'Which sounds like home?'), h('p', {}, 'Play each, sing your last line over it')),
        h('div', { class: 'tiles cands' }, cands.map((c) => h('button', { class: 'tile cand', type: 'button', onclick: () => playNotes(chordOf(c.name), 3) },
          h('strong', {}, c.name), h('span', { class: 'mini' }, h('i', { style: `width:${Math.max(4, Math.round(c.p * 100))}%` })), h('small', {}, `${Math.round(c.p * 100)}%`), h('span', { class: 'play', 'aria-hidden': 'true' }, '▶'))))),
    ];
  }

  function keyChanges(r) {
    if (!r.timeline || r.timeline.length < 2) return null;
    const end = r.timeline[r.timeline.length - 1].end;
    return h('div', { class: 'panel' }, h('h3', {}, 'Key changes'),
      h('div', { class: 'strip' }, r.timeline.map((seg, i) => tipOn(h('div', { class: `seg s${i % 3}`, style: `flex:${seg.end - seg.start}` }, h('strong', {}, seg.name), h('span', {}, clock(seg.start))), `${clock(seg.start)}–${clock(seg.end)}: ${seg.name} (${seg.camelot})`))),
      h('div', { class: 'strip-axis' }, h('span', {}, '0:00'), h('span', {}, clock(end))));
  }

  function renderKey(r, meta) {
    const box = $('key-result');
    if (!r) { fill(box, h('p', { class: 'empty' }, meta.live ? 'Keep going: not enough notes yet.' : 'No clear notes found. Try a part with singing, chords or melody.')); return; }
    const other = enharmonic(r.name);
    const home = chordMidis(r.tonic, r.mode === 'minor' ? 'm' : '');
    const short = r.seconds < 25, unsure = r.confidence < 0.6;
    fill(box,
      h('div', { class: 'panel keyhero' },
        h('div', { class: 'keyname' },
          h('span', { class: 'eyebrow' }, h('span', { class: `src ${r.vocal ? 'voice' : 'music'}` }, r.vocal ? 'voice' : 'music'), meta.live ? ` ${clock(meta.seconds)} heard` : ` ${meta.name}`),
          h('h2', {}, r.name),
          h('div', { class: 'row' },
            h('span', { class: 'camelot', title: 'Camelot code' }, r.camelot),
            other ? h('span', { class: 'muted' }, `= ${other}`) : null),
          h('div', { class: 'row' },
            h('button', { class: 'btn small', type: 'button', onclick: () => playNotes(home) }, `▶ ${r.name.split(' ')[0]}${r.mode === 'minor' ? 'm' : ''}`),
            h('button', { class: 'btn small', type: 'button', onclick: () => playNotes([48 + r.tonic, 60 + r.tonic], 3) }, '▶ home note')),
          short || unsure ? h('span', { class: 'hint' }, short ? `${Math.round(r.seconds)} s heard · longer is surer` : 'close call · check below') : null),
        h('div', { class: 'gauges' }, ring(r.confidence, 'sure'), tuningDial(r.tuningCents, r.referenceA))),
      r.vocal ? vocalPanel(r) : null,
      h('div', { class: 'duo' }, camelotWheel(r), h('div', { class: 'stack' }, keyboard(r), chordTiles(r))),
      keyChanges(r));
  }

  async function keyFromFile(file) {
    if (listening) stopListening();
    try {
      status(`${file.name}: reading…`);
      await breathe();
      const audio = await decode(file);
      status(`${file.name}: finding the key…`);
      await breathe();
      state.keyAudio = audio;
      const r = M.vocalKey.auto(audio.channels, audio.sampleRate, $('key-mode').value);
      status('');
      renderKey(r, { name: file.name });
    } catch (e) {
      status(e.message, true);
    }
  }

  async function startListening() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      status('This page cannot use the microphone here. Use the desktop app or open the downloaded Mu-sixk.html in Chrome or Edge, or drop a recording instead.', true);
      return;
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) {
      status('The microphone was not allowed. Allow it in your browser or system settings, or drop a recording instead. (The online version cannot use the microphone; the desktop app can.)', true);
      return;
    }
    const c = ctx();
    await c.resume();
    const src = c.createMediaStreamSource(stream);
    const proc = c.createScriptProcessor(4096, 1, 1);
    const maxLen = c.sampleRate * 60;
    const buf = new Float32Array(maxLen);
    listening = { stream, src, proc, buf, len: 0, total: 0, timer: null, level: 0, rate: c.sampleRate };
    proc.onaudioprocess = (e) => {
      const x = e.inputBuffer.getChannelData(0);
      const L = listening;
      if (!L) return;
      let pk = 0;
      for (let i = 0; i < x.length; i++) {
        L.buf[(L.total + i) % maxLen] = x[i];
        const a = Math.abs(x[i]); if (a > pk) pk = a;
      }
      L.total += x.length; L.len = Math.min(maxLen, L.len + x.length);
      L.level = Math.max(pk, L.level * 0.85);
      e.outputBuffer.getChannelData(0).fill(0);
    };
    src.connect(proc); proc.connect(c.destination);
    $('key-listen').textContent = 'Stop listening';
    $('key-listen').setAttribute('aria-pressed', 'true');
    $('key-live').hidden = false;
    status('');
    const tick = () => {
      const L = listening;
      if (!L) return;
      $('key-vu').style.width = `${Math.min(100, Math.round(L.level * 140))}%`;
      const secs = L.len / L.rate;
      $('key-live-text').textContent = secs < 4 ? `Listening… ${Math.ceil(4 - secs)} s until the first guess` : `Listening… ${clock(L.total / L.rate)}`;
      if (secs >= 4 && (!L.lastRun || performance.now() - L.lastRun > 1500)) {
        L.lastRun = performance.now();
        const ordered = new Float32Array(L.len);
        const startAt = (L.total - L.len) % maxLen;
        for (let i = 0; i < L.len; i++) ordered[i] = L.buf[(startAt + i) % maxLen];
        renderKey(M.vocalKey.auto([ordered], L.rate, $('key-mode').value), { live: true, seconds: L.total / L.rate });
      }
      L.timer = setTimeout(tick, 250);
    };
    tick();
  }

  function stopListening() {
    const L = listening;
    if (!L) return;
    listening = null;
    clearTimeout(L.timer);
    try { L.src.disconnect(); L.proc.disconnect(); } catch (e) { /* already disconnected */ }
    L.stream.getTracks().forEach((t) => t.stop());
    $('key-listen').textContent = 'Listen with microphone';
    $('key-listen').setAttribute('aria-pressed', 'false');
    $('key-live').hidden = true;
  }

  /* ---------- reference song ---------- */
  async function loadReference(file) {
    stopPlayback();
    try {
      status(`${file.name}: reading…`);
      await breathe();
      const audio = await decode(file);
      const analysis = await M.analyze(audio, { pause: pauseWith(file.name) });
      state.ref = { name: file.name, analysis, audio };
      fillStyleSelect('reference');
      $('ref-clear').hidden = false;
      status(`Comparing against "${file.name}". It is selected under "Compare against".`);
      renderMix();
    } catch (e) {
      status(e.message, true);
    }
  }

  function refPanel(a, r, refAudio) {
    const prof = M.profiles.buildLearned('reference', 'Reference', [M.profiles.fingerprint('ref', r)]);
    const tonal = M.profiles.compareTonal(a, prof);
    const notes = [];
    const note = (size, text) => notes.push({ size, text });
    const dl = a.lufs - r.lufs;
    if (Math.abs(dl) > 1.5) note(Math.abs(dl), `Yours is ${dbAbs(dl)} ${dl < 0 ? 'quieter' : 'louder'}. On a master, ${dl < 0 ? 'push' : 'ease'} the limiter input about ${dbAbs(dl)}.`);
    const dp = a.plr - r.plr;
    if (Math.abs(dp) > 2) note(Math.abs(dp) * 0.8, dp < 0 ? `Yours is more squashed (${dbAbs(dp)} less punch). Ease off the limiter and bus compressor.` : `Yours is more dynamic (${dbAbs(dp)} more punch). The reference is compressed harder; 2-3 dB of bus compression gets you closer.`);
    const dw = a.stereoInfo.widthDb - r.stereoInfo.widthDb;
    if (a.stereo && r.stereo && Math.abs(dw) > 3) note(Math.abs(dw) * 0.6, dw < 0 ? `Yours is narrower. Pan supporting parts wider and use stereo reverb on them.` : `Yours is wider. Check it in mono and keep kick, bass and vocal centred.`);
    for (const reg of M.REGIONS) {
      const { dev } = tonal.regions[reg.id];
      if (Math.abs(dev) < 2) continue;
      const t = { sub: '50 Hz low shelf', bass: '100-150 Hz bell', lowmid: '300 Hz bell', mid: '1 kHz bell', highmid: '3 kHz bell', presence: '6 kHz bell', air: '10 kHz high shelf' }[reg.id];
      note(Math.abs(dev), `${reg.name}: yours has ${dbAbs(dev)} ${dev > 0 ? 'more' : 'less'} than the reference. Equalizer: ${t}, ${dev > 0 ? '-' : '+'}${dbAbs(Math.min(4, Math.abs(dev) * 0.7))}.`);
    }
    const names = { vocals: 'Vocal', drums: 'Drums', bass: 'Bass', other: 'Instruments' };
    if (a.elements && r.elements) for (const [p, n] of Object.entries(names)) {
      const d = a.elements[p] - r.elements[p];
      if (Math.abs(d) >= 2) note(Math.abs(d), `${n} ${p === 'drums' ? 'sit' : 'sits'} about ${dbAbs(d)} ${d < 0 ? 'lower' : 'higher'} in your mix than in the reference. Move ${p === 'vocals' ? 'the vocal' : `the ${n.toLowerCase()}`} ${d < 0 ? 'up' : 'down'} about ${dbAbs(d)}.`);
    }
    notes.sort((x, y) => y.size - x.size);
    const fmt = (v, u) => (Number.isFinite(v) ? `${num(v)}${u ? ` ${u}` : ''}` : '-');
    const diff = (x, y) => (Number.isFinite(x) && Number.isFinite(y) ? `${x - y > 0 ? '+' : ''}${num(x - y)}` : '-');
    const row = (label, x, y, u) => h('tr', {}, h('td', {}, label), h('td', {}, fmt(x, u)), h('td', {}, fmt(y, u)), h('td', {}, diff(x, y)));
    const rows = [
      row('Loudness', a.lufs, r.lufs, 'LUFS'), row('True peak', a.truePeakDb, r.truePeakDb, 'dBTP'), row('Punch', a.plr, r.plr, 'dB'),
      row('Width', a.stereoInfo.widthDb, r.stereoInfo.widthDb, 'dB'),
      ...(a.elements && r.elements ? Object.entries(names).map(([p, n]) => row(`${n} level`, a.elements[p], r.elements[p], 'dB')) : []),
      h('tr', {}, h('td', {}, 'Key'), h('td', {}, a.key ? a.key.name : '-'), h('td', {}, r.key ? r.key.name : '-'), h('td', {}, '')),
      h('tr', {}, h('td', {}, 'Tempo'), h('td', {}, a.tempo.bpm ? `${Math.round(a.tempo.bpm)} BPM` : '-'), h('td', {}, r.tempo.bpm ? `${Math.round(r.tempo.bpm)} BPM` : '-'), h('td', {}, '')),
    ];
    return h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, `Side by side with ${state.ref.name.replace(/\.[a-z0-9]+$/i, '')}`),
        h('div', { class: 'row' }, playButton('Play yours', () => state.mix.audio), playButton('Play reference', () => refAudio))),
      notes.length ? h('div', { class: 'sub' }, h('h3', {}, 'Biggest differences'), h('ul', {}, notes.slice(0, 6).map((n) => h('li', {}, n.text))))
        : h('p', { class: 'empty' }, 'Yours is close to the reference on every measure.'),
      h('div', { class: 'scroll' }, h('table', {},
        h('thead', {}, h('tr', {}, ['', 'Yours', 'Reference', 'Difference'].map((t) => h('th', {}, t)))), h('tbody', {}, rows))));
  }

  function renderMix() {
    const box = $('mix-result');
    if (!state.mix) { fill(box); return; }
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
      meter('Key', a.key ? a.key.name : '-', a.key && a.key.camelot ? a.key.camelot : '', a.key ? (Number.isFinite(a.key.confidence) ? `${Math.round(a.key.confidence * 100)}% sure. Details in Find the key` : `Or ${a.key.relative}`) : 'No clear key'),
      meter('Length', clock(a.duration), '', `${(a.sampleRate / 1000).toFixed(1)} kHz ${a.stereo ? 'stereo' : 'mono'}`));

    const copy = h('button', { class: 'btn small', type: 'button', onclick: () => copyText(mixReport(name, profile, result, a), copy) }, 'Copy report');
    fill(box, 
      verdictBlock(result, name, demo ? 'example, not your audio' : ''),
      meters,
      state.ref ? refPanel(a, state.ref.analysis, state.ref.audio) : null,
      reportPanel(result),
      timelinePanel(a, result, profile, audio),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, 'Waveform'), h('div', { class: 'row' }, playButton('Play', () => audio), copy)),
        wavePanel(a.wave)),
      tonalChart(a, profile, result.tonal),
      toolboxPanel([...result.issues.map((i) => i.tool), ...(master ? [] : M.advice.masteringPlan(a, profile, result).map(M.advice.toolForStep))]),
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
    const lines = [`Mu-sixk report: ${name}`, `Compared against: ${profile.name}`, `Overall: ${result.score}% good (${result.verdict})`,
      `Loudness ${num(a.lufs)} LUFS, true peak ${num(a.truePeakDb)} dBTP, punch ${num(a.plr)} dB`, '',
      ...M.advice.reportCard(result).map((p) => `${p.name}: ${p.pct}% (${p.word})`), ''];
    result.issues.forEach((i, n) => {
      const tool = M.advice.TOOLS[i.tool];
      lines.push(`${n + 1}. ${i.title}`, `   ${i.fix}`);
      if (tool) lines.push(`   Use: ${tool.name}. ${i.settings.map(([k, v]) => `${k}: ${v}`).join('; ')}`);
    });
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
        const analysis = await M.analyze(audio, { pause: pauseWith(audio.name), segments: 3, model: false });
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
    if (!state.stems.length) { fill(list); fill($('stems-together')); return; }
    const { profile, bpm, gains } = stemPlan();
    const seen = {};
    const counts = {};
    for (const s of state.stems) counts[s.role] = (counts[s.role] || 0) + 1;
    const needed = [];
    const marks = [];
    const cards = state.stems.map((s, i) => {
      const index = (seen[s.role] = (seen[s.role] || 0) + 1) - 1;
      const recipe = M.advice.stemRecipe(s.analysis, s.role, { profile, bpm, sameRoleIndex: index, sameRoleCount: counts[s.role] });
      needed.push(...recipe.steps.map(M.advice.toolForStep));
      const select = h('select', { id: `role-${s.id}`, 'aria-label': `Instrument for ${s.name}` },
        Object.entries(M.advice.ROLES).map(([id, r]) => h('option', { value: id, selected: id === s.role }, r.name)));
      select.addEventListener('change', () => { s.role = select.value; renderStems(); runMixdown(); });
      const g = gains[i];
      const dx = M.advice.diagnoseStem(s.analysis, s.role, g, state.songKey);
      marks.push({ name: s.name, role: M.advice.ROLES[s.role].name, dx });
      return h('div', { class: 'panel stem' },
        h('div', { class: 'panel-head' },
          h('h3', {}, s.name),
          h('div', { class: 'row' },
            h('span', { class: 'fader', title: 'Move this track\'s fader by this much from where it is now' }, `Fader ${g > 0 ? '+' : ''}${g.toFixed(1)} dB`),
            select,
            h('button', { class: 'btn small', type: 'button', 'aria-label': `Remove ${s.name}`, onclick: () => { state.stems = state.stems.filter((x) => x !== s); renderStems(); runMixdown(); } }, 'Remove'))),
        h('div', { class: 'card-row solo' }, h('strong', {}, 'Health'), bar(dx.pct, dx.tone), h('span', { class: `pct tone-${dx.tone}` }, `${dx.pct}% ${dx.word}`)),
        problemList(dx),
        h('details', { open: i === 0 },
          h('summary', {}, `Effect chain, in order (${recipe.steps.length} steps)`),
          h('div', { class: 'scroll chain' }, h('table', {}, h('tbody', {}, recipe.steps.map((st) =>
            h('tr', {}, h('td', {}, st.fx), h('td', {}, st.setting), h('td', {}, st.why))))))));
    });
    const board = h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h3', {}, 'Track by track'), h('p', {}, 'Worst first. Details are on each track below.')),
      h('div', { class: 'card' }, marks.slice().sort((x, y) => x.dx.pct - y.dx.pct).map((m) => h('div', { class: 'card-row' },
        h('strong', {}, m.name), bar(m.dx.pct, m.dx.tone), h('span', { class: `pct tone-${m.dx.tone}` }, `${m.dx.pct}% ${m.dx.word}`),
        h('p', {}, m.dx.problems.length ? m.dx.problems.map((x) => x.title).join(' · ') : 'Nothing wrong found.', h('em', {}, ` ${m.role}.`))))));
    fill(list, h('h2', {}, 'Each track: what is wrong and what to put on it'), board, toolboxPanel(needed), ...cards);
  }

  /* Sum the stems twice (as loaded, and with the suggested fader moves) and judge both. */
  async function runMixdown() {
    const run = ++state.mixdownRun;
    const box = $('stems-together');
    if (state.stems.length < 2) {
      fill(box, state.stems.length ? h('p', { class: 'empty' }, 'Add at least one more track to see how they sit together.') : '');
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
      const aRaw = await M.analyze({ channels: raw, sampleRate: fs }, { pause: pauseWith('Your current balance'), segments: 6 });
      const aBal = await M.analyze({ channels: bal, sampleRate: fs }, { pause: pauseWith('Suggested balance'), segments: 6 });
      if (run !== state.mixdownRun) return;
      const rRaw = M.advice.assessMix(aRaw, profile, 'mix');
      const rBal = M.advice.assessMix(aBal, profile, 'mix');
      state.mixdown = { raw: { channels: raw, sampleRate: fs }, bal: { channels: bal, sampleRate: fs } };
      const keyChanged = (state.songKey && state.songKey.name) !== (aRaw.key && aRaw.key.name);
      state.songKey = aRaw.key;
      if (keyChanged) renderStems();
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
    fill($('stems-together'), h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', {}, 'How it comes together'),
        h('p', {}, `${stems.length} tracks, judged as ${profile.name}${bpm ? `, about ${Math.round(bpm)} BPM` : ''}${state.songKey ? `, key ${state.songKey.name}` : ''}`)),
      h('div', { class: 'compare' },
        h('div', {}, h('span', {}, 'As loaded'), h('strong', { class: 'big' }, `${rRaw.score}%`)),
        h('span', { class: 'arrow', 'aria-hidden': 'true' }, '→'),
        h('div', {}, h('span', {}, 'With the fader moves'), h('strong', { class: 'big' }, `${rBal.score}%`)),
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
        const analysis = await M.analyze(audio, { pause: pauseWith(file.name), segments: 6 });
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
    fill($('teach-list'), ...(entries.length ? entries.map(([id, p]) => h('div', { class: 'panel learned' },
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
    for (const t of ['mix', 'stems', 'key', 'teach']) {
      $(`tab-${t}`).setAttribute('aria-selected', String(t === name));
      $(`panel-${t}`).hidden = t !== name;
    }
    $('stage').hidden = name !== 'mix';
    requestAnimationFrame(redrawWaves);
  }

  function start() {
    loadLearned();
    fillStyleSelect('pop');
    for (const t of ['mix', 'stems', 'key', 'teach']) $(`tab-${t}`).addEventListener('click', () => selectTab(t));
    wireDrop($('drop-key'), $('file-key'), (files) => keyFromFile(files[0]));
    $('key-listen').addEventListener('click', () => (listening ? stopListening() : startListening()));
    $('key-mode').addEventListener('change', () => {
      if (state.keyAudio && !listening) renderKey(M.vocalKey.auto(state.keyAudio.channels, state.keyAudio.sampleRate, $('key-mode').value), { name: state.keyAudio.name });
    });
    wireDrop($('drop-mix'), $('file-mix'), (files) => loadMix(files[0]));
    wireDrop($('drop-ref'), $('file-ref'), (files) => loadReference(files[0]));
    $('ref-clear').addEventListener('click', () => { state.ref = null; $('ref-clear').hidden = true; fillStyleSelect('pop'); renderMix(); status(''); });
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
