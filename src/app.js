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

  function chromaChart(r) {
    const W = 600, H = 150, B = 24, bw = W / 12;
    const root = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'How much of each note it heard' });
    for (let i = 0; i < 12; i++) {
      const pc = (r.tonic + i) % 12;
      const v = r.chroma[pc], inKey = r.scalePcs.includes(pc);
      const hgt = Math.max(2, v * (H - B - 8));
      const rect = svg('rect', { class: `nb${inKey ? ' in' : ''}${i === 0 ? ' home' : ''}`, x: i * bw + 6, y: H - B - hgt, width: bw - 12, height: hgt, rx: 3 });
      rect.addEventListener('pointermove', (e) => showTip(e, `${M.key.NOTES[pc]}: ${Math.round(v * 100)}%${inKey ? ' · in the key' : ''}`));
      rect.addEventListener('pointerleave', hideTip);
      root.append(rect, svg('text', { class: i === 0 ? 'label' : '', x: i * bw + bw / 2, y: H - 6, 'text-anchor': 'middle' }, (r.scale.find((n, k) => r.scalePcs[k] === pc) || M.key.NOTES[pc])));
    }
    return root;
  }

  function renderKey(r, meta) {
    const box = $('key-result');
    if (!r) { fill(box, h('p', { class: 'empty' }, meta.live ? 'Keep playing: not enough notes yet.' : 'No clear notes found. Try a part with chords or melody, not just drums.')); return; }
    const pct = Math.round(r.confidence * 100);
    const other = enharmonic(r.name);
    const cents = Math.round(r.tuningCents);
    const tuningText = Math.abs(cents) <= 5 ? 'Standard tuning (A = 440 Hz)' : `Tuned ${Math.abs(cents)} cents ${cents > 0 ? 'sharp' : 'flat'} (A = ${r.referenceA.toFixed(1)} Hz)`;
    const sure = sureWord(r.confidence);
    const tone = r.confidence >= 0.8 ? 'good' : r.confidence >= 0.55 ? 'ok' : r.confidence >= 0.35 ? 'warn' : 'bad';
    const home = chordMidis(r.tonic, r.mode === 'minor' ? 'm' : '');
    fill(box,
      h('div', { class: 'panel keyhero' },
        h('div', { class: 'keyname' },
          h('span', { class: 'eyebrow' }, meta.live ? `Listening · ${clock(meta.seconds)} heard` : meta.name),
          h('h2', {}, r.name),
          h('div', { class: 'row' },
            h('span', { class: 'camelot', title: 'Camelot code, used by DJs for mixing in key' }, r.camelot),
            other ? h('span', { class: 'muted' }, `also written ${other}`) : null)),
        h('div', { class: 'keysure' },
          h('div', { class: 'card-row solo' }, h('strong', {}, sure), bar(pct, tone), h('span', { class: `pct tone-${tone}` }, `${pct}%`)),
          h('p', {}, tuningText),
          h('div', { class: 'row' },
            h('button', { class: 'btn small', type: 'button', onclick: () => playNotes(home) }, `Play ${r.name.split(' ')[0]}${r.mode === 'minor' ? 'm' : ''} chord`),
            h('button', { class: 'btn small', type: 'button', onclick: () => playNotes([48 + r.tonic, 60 + r.tonic], 3) }, 'Play the home note')))),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, 'Could also be'), h('p', {}, 'Close calls are usually the relative key, which shares all its notes')),
        h('div', { class: 'card' }, r.alternatives.map((alt) => {
          const p = Math.round(alt.p * 100);
          return h('div', { class: 'card-row' }, h('strong', {}, `${alt.name} · ${alt.camelot}`), bar(Math.max(p, 1), 'ok'), h('span', { class: 'pct' }, `${p}%`));
        }))),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, 'Notes it heard'), h('p', {}, 'Coloured bars are notes in the key. The first is the home note.')),
        h('div', { class: 'chart' }, chromaChart(r)),
        h('div', { class: 'chips' }, h('span', { class: 'muted' }, 'Scale:'), r.scale.map((n, i) => h('span', { class: `chip${i === 0 ? ' home' : ''}` }, n)))),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, 'Chords that fit'), h('p', {}, 'Tap one to hear it. Roman numerals show its place in the key.')),
        h('div', { class: 'chips' }, r.chords.map((c) => {
          const quality = /dim/.test(c.name) ? 'dim' : /m$/.test(c.name) ? 'm' : '';
          const rootName = c.name.replace(/(m|dim)$/, '');
          const pc = Math.max(M.key.NOTES.indexOf(rootName), M.key.FLATS.indexOf(rootName));
          return h('button', { class: 'chip chord', type: 'button', onclick: () => playNotes(chordMidis(pc, quality)) }, h('small', {}, c.roman), c.name);
        }))),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, 'For DJs and producers')),
        h('ul', { class: 'goods' },
          h('li', {}, `Relative key: ${r.relative} (same notes, different home)`),
          h('li', {}, `Parallel key: ${r.parallel} (same home note, different mood)`),
          h('li', {}, `Mixes in key with: ${r.mixesWith.join(', ')}`))),
      r.timeline && r.timeline.length > 1 ? h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h3', {}, 'Key changes'), h('p', {}, 'Where the song moves to a different key')),
        h('ul', { class: 'goods' }, r.timeline.map((seg) => h('li', {}, `${clock(seg.start)} - ${clock(seg.end)}: ${seg.name} (${seg.camelot})`)))) : null);
  }

  async function keyFromFile(file) {
    if (listening) stopListening();
    try {
      status(`${file.name}: reading…`);
      await breathe();
      const audio = await decode(file);
      status(`${file.name}: finding the key…`);
      await breathe();
      const r = M.key.detect(audio.channels, audio.sampleRate);
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
        renderKey(M.key.detect([ordered], L.rate), { live: true, seconds: L.total / L.rate });
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
