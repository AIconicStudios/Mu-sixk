/* Mu-sixk advice engine: turns measurements into a verdict, per-stem recipes, fader moves and
   clash warnings. Every threshold here is a mixing rule of thumb, so the wording stays "start here". */
(function (root) {
  'use strict';
  const M = (root.MuSixk = root.MuSixk || {});
  const { clamp } = M.dsp;

  const half = (x) => Math.round(x * 2) / 2;
  const db = (x) => `${half(x) > 0 ? '+' : ''}${half(x).toFixed(half(x) % 1 ? 1 : 0)} dB`;
  const dbAbs = (x) => `${Math.abs(half(x)).toFixed(Math.abs(half(x)) % 1 ? 1 : 0)} dB`;
  const num = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
  function hz(f) {
    if (f >= 1000) return `${(Math.round(f / 100) / 10).toString()} kHz`;
    const step = f < 100 ? 5 : 10;
    return `${Math.round(f / step) * step} Hz`;
  }
  const ms = (x) => `${Math.round(x)} ms`;

  /* ================= Tools ================= */
  /* What each fix is done with. "free" names a free plugin; any DAW's stock version works too. */
  const TOOLS = {
    eq: { name: 'Equalizer (EQ)', does: 'Turns chosen frequencies up or down.', free: 'TDR Nova' },
    comp: { name: 'Compressor', does: 'Evens out the loud and quiet moments.', free: 'TDR Kotelnikov' },
    limiter: { name: 'Limiter', does: 'Makes the song louder and stops peaks going over.', free: 'LoudMax' },
    clipper: { name: 'Clipper', does: 'Shaves the very tips off drum hits.', free: 'FreeClip' },
    deess: { name: 'De-esser', does: 'Turns down harsh "s" sounds only when they happen.', free: 'Lisp' },
    reverb: { name: 'Reverb', does: 'Adds room and depth around a sound.', free: 'Valhalla Supermassive' },
    delay: { name: 'Delay', does: 'Adds timed echoes.', free: 'Valhalla Supermassive' },
    sat: { name: 'Saturation', does: 'Adds warmth and harmonics.', free: 'Softube Saturation Knob' },
    gate: { name: 'Gate', does: 'Mutes hiss and bleed between phrases.', free: '' },
    stereo: { name: 'Stereo tool', does: 'Controls width, mono bass and left/right balance.', free: 'Voxengo MSED' },
    fader: { name: 'Volume fader', does: 'Just the track or master level. No plugin needed.', free: '' },
    auto: { name: 'Volume automation', does: 'Drawing level changes over time in your DAW.', free: '' },
    edit: { name: 'Editing and export', does: 'Trimming, fades and export settings in your DAW.', free: '' },
  };
  const FX_TOOL = { 'High-pass filter': 'eq', EQ: 'eq', 'Gate / expander': 'gate', 'De-esser': 'deess', Compressor: 'comp', 'Bus compressor': 'comp',
    Saturation: 'sat', 'Reverb (send)': 'reverb', 'Delay (send)': 'delay', Limiter: 'limiter', Clipper: 'clipper', Stereo: 'stereo' };
  const toolForStep = (step) => (/^(Skip it|None)$/.test(step.setting) ? null : FX_TOOL[step.fx] || null);

  /* Tally of the tools a set of fixes calls for, most used first. */
  function toolbox(keys) {
    const count = {};
    for (const k of keys) if (k && TOOLS[k]) count[k] = (count[k] || 0) + 1;
    return Object.entries(count).sort((x, y) => y[1] - x[1]).map(([key, uses]) => ({ key, uses, ...TOOLS[key] }));
  }

  /* ================= Full-mix verdict ================= */
  const TONE = {
    sub: {
      high: { title: 'Too much sub', hear: 'The low end rumbles and swallows the kick; small speakers distort.', type: 'Low shelf', f: '50 Hz', q: '', on: '808 / sub bass first. On the master only as a last resort.', also: 'High-pass every track that is not kick or bass at 80-120 Hz.' },
      low: { title: 'Thin at the very bottom', hear: 'No weight in the chest; sounds small on big speakers and in cars.', type: 'Low shelf', f: '50 Hz', q: '', on: '808 / sub bass, or the master.', also: 'Or simply raise the sub or 808 fader. Check the kick is not tuned too high.' },
    },
    bass: {
      high: { title: 'Boomy low end', hear: 'Bass notes blur together and the mix sounds heavy and slow.', type: 'Bell', f: '100-150 Hz', q: '0.8 (wide)', on: 'Bass and kick.', also: 'Check kick and bass are not hitting the same note. A compressor on the bass (4:1) keeps its notes even.' },
      low: { title: 'Lacks weight', hear: 'The song feels light and does not hit.', type: 'Bell', f: '100 Hz', q: '0.8 (wide)', on: 'Bass and kick.', also: 'Or raise the bass and kick faders by the same amount.' },
    },
    lowmid: {
      high: { title: 'Muddy low mids', hear: 'Cloudy, like a blanket over the speakers. Words are harder to make out.', type: 'Bell', f: '300 Hz', q: '1', on: 'Guitars, keys, pads and the body of the vocal.', also: 'Less reverb on low instruments also clears mud.' },
      low: { title: 'Hollow body', hear: 'Thin and cold. Instruments sound small.', type: 'Bell', f: '300-400 Hz', q: '1', on: 'Guitars, keys and vocal.', also: 'Ease off any low-mid cuts already on those tracks.' },
    },
    mid: {
      high: { title: 'Boxy, honky mids', hear: 'Like listening through a cardboard tube or a phone.', type: 'Bell', f: '1 kHz', q: '0.7 (wide)', on: 'Whichever of vocal, guitars or keys is loudest there.', also: '' },
      low: { title: 'Scooped mids', hear: 'Vocals and melody sit far back; the song loses its body on phones.', type: 'Bell', f: '1 kHz', q: '0.7 (wide)', on: 'Lead vocal or lead instrument.', also: 'Or raise the lead fader by the same amount.' },
    },
    highmid: {
      high: { title: 'Harsh upper mids', hear: 'Tiring and piercing when played loud.', type: 'Bell (a dynamic EQ is kinder)', f: '3 kHz', q: '1.5', on: 'Vocal, snare and electric guitars.', also: '' },
      low: { title: 'Lacks bite and clarity', hear: 'Vocals feel buried and words are hard to follow.', type: 'Bell', f: '3 kHz', q: '1', on: 'Lead vocal first, then snare.', also: '' },
    },
    presence: {
      high: { title: 'Sharp, sibilant top', hear: '"S" sounds and hi-hats cut like needles.', type: 'Bell', f: '6 kHz', q: '1.5', on: 'Hi-hats and cymbals.', also: 'Put a de-esser on the vocals (6-8 kHz, 3-5 dB of reduction) before reaching for EQ.' },
      low: { title: 'Dull', hear: 'Muffled, as if the speakers are behind a curtain.', type: 'Bell', f: '5-6 kHz', q: '1', on: 'Vocal, hi-hats and snare.', also: 'Or raise the hi-hat fader.' },
    },
    air: {
      high: { title: 'Fizzy, brittle air', hear: 'A hissy, cheap-sounding top end.', type: 'High shelf', f: '10 kHz', q: '', on: 'Cymbals and any track with an exciter on it.', also: '' },
      low: { title: 'No air', hear: 'Closed-in, without sparkle or shine.', type: 'High shelf', f: '10-12 kHz', q: '', on: 'Vocal and cymbals, or the master.', also: 'If this came from an MP3, the encoder may have cut the top off.' },
    },
  };

  /* The parts of a song a finished mix is graded on, and where each one is read from. */
  const PARTS = [
    { id: 'vocals', name: 'Vocals and lead', about: 'Read from 500 Hz to 4 kHz, where the voice and melody sit.' },
    { id: 'low', name: 'Kick and bass', about: 'Read from everything under 250 Hz.' },
    { id: 'drums', name: 'Drums and punch', about: 'Read from how far the hits stand above the average level.' },
    { id: 'inst', name: 'Instruments', about: 'Guitars, keys and pads, read from the low mids (250-500 Hz).' },
    { id: 'top', name: 'Hi-hats, cymbals and air', about: 'Read from everything above 4 kHz.' },
    { id: 'space', name: 'Width and space', about: 'Read from how left and right differ.' },
    { id: 'level', name: 'Volume and loudness', about: 'Read from peaks, loudness and the start and end of the file.' },
  ];
  const REGION_PART = { sub: 'low', bass: 'low', lowmid: 'inst', mid: 'vocals', highmid: 'vocals', presence: 'top', air: 'top' };
  const AREA_PART = { Level: 'level', Loudness: 'level', Dynamics: 'drums', Stereo: 'space', Edit: 'level', Tone: 'inst' };
  const grade = (pct) => (pct >= 85 ? ['Good', 'good'] : pct >= 70 ? ['Decent', 'ok'] : pct >= 50 ? ['Meh', 'warn'] : ['Bad', 'bad']);

  /* Percentage for each part of the song, with the findings that cost it marks. */
  function reportCard(result) {
    const cost = { high: 45, med: 25, low: 12 };
    return PARTS.map((p) => {
      const found = result.issues.filter((i) => i.part === p.id);
      const pct = clamp(100 - found.reduce((sum, i) => sum + cost[i.sev], 0), 0, 100);
      const [word, tone] = grade(pct);
      return { ...p, pct, word, tone, found };
    });
  }

  /* One stem on its own: its volume against the others, its tone, its dynamics and any faults. */
  function diagnoseStem(a, roleId, gain) {
    const role = ROLES[roleId] || ROLES.other;
    const problems = [];
    const add = (sev, title, detail) => problems.push({ sev, title, detail });
    const tonalRole = !['kick', 'snare', 'hats', 'perc', 'drums', 'fx'].includes(roleId);
    if (Math.abs(gain) >= 1.5) {
      add(Math.abs(gain) >= 8 ? 'high' : Math.abs(gain) >= 4 ? 'med' : 'low', `Volume: ${dbAbs(gain)} too ${gain > 0 ? 'quiet' : 'loud'}`,
        `Against the other tracks, a ${role.name.toLowerCase()} normally sits ${dbAbs(gain)} ${gain > 0 ? 'higher' : 'lower'} than this. Move its fader ${db(gain)}.`);
    }
    if (a.clipRuns > 0) add('high', `Clipped in ${a.clipRuns} place${a.clipRuns > 1 ? 's' : ''}`, 'The recording or export hit the ceiling and is distorted. Export it again with the track level lower.');
    else if (a.samplePeakDb > -0.3) add('low', 'Peaks touch the ceiling', 'There is no room left on this track. Lower its clip gain 3-6 dB before adding effects.');
    for (const r of role.tone) {
      const diff = M.levelBetween(a.thirdOctAbs, r.a[0], r.a[1]) - M.levelBetween(a.thirdOctAbs, r.b[0], r.b[1]);
      const hit = diff > r.hi && r.high ? [r.high, diff - r.hi] : diff < r.lo && r.low ? [r.low, r.lo - diff] : null;
      if (!hit) continue;
      const [setting, why] = eqMove(hit[0], hit[1]);
      add(hit[1] > 6 ? 'med' : 'low', `Tone: ${why}`, `Equalizer: ${setting.charAt(0).toLowerCase()}${setting.slice(1)}.`);
    }
    if (tonalRole && a.levelSpreadDb > 4) add(a.levelSpreadDb > 6 ? 'med' : 'low', `Uneven: level swings ±${num(a.levelSpreadDb)} dB`, 'Some notes or words jump out and others get lost. A compressor fixes this; settings are in the effect chain below.');
    if ((roleId === 'vocal' || roleId === 'bvox') && a.sibilance.index > -9) add(a.sibilance.index > -4 ? 'med' : 'low', 'Harsh "s" sounds', `They spike around ${hz(clamp(a.sibilance.freq, 5000, 9000))}. A de-esser fixes this.`);
    if (a.noiseFloorDb > -62 && a.activeRatio < 0.8 && a.loudPeakDb - a.noiseFloorDb > 25) add(a.noiseFloorDb > -50 ? 'med' : 'low', `Noise in the gaps (${Math.round(a.noiseFloorDb)} dB)`, 'Hiss, hum or bleed is audible when the part is not playing. A gate, or cutting the silent sections, removes it.');
    if (a.loudPeakDb - a.noiseFloorDb < 25 && a.noiseFloorDb > -50 && a.activeRatio < 0.8) add('med', 'Noisy recording', 'The quiet parts are only a little below the loud ones. Record again closer to the microphone, or use a noise-reduction tool.');
    if (a.stereo && a.stereoInfo.correlation < 0) add('high', 'Left and right are out of phase', 'This track will cancel itself on a mono speaker. Flip the polarity of one side, or remove the widener on it.');
    if (/Centre/.test(role.pan) && a.stereo && a.stereoInfo.widthDb > -6) add('low', 'Too wide for a centre part', `A ${role.name.toLowerCase()} should be solid in the middle. Make it mono or narrow it.`);
    if (a.dcOffset > 0.005) add('low', 'DC offset', 'The waveform sits off centre. A high-pass filter at 20 Hz removes it.');
    const cost = { high: 30, med: 18, low: 8 };
    const pct = clamp(100 - problems.reduce((sum, x) => sum + cost[x.sev], 0), 0, 100);
    const order = { high: 0, med: 1, low: 2 };
    problems.sort((x, y) => order[x.sev] - order[y.sev]);
    const [word, tone] = grade(pct);
    return { pct, word, tone, problems };
  }

  function assessMix(a, profile, stage) {
    const issues = [];
    const good = [];
    const add = (sev, area, title, tool, settings, fix, part) => issues.push({ sev, area, title, tool, settings: settings.filter((s) => s[1]), fix, part: part || AREA_PART[area] });
    const master = stage === 'master';
    const st = a.stereoInfo;

    /* Level, peaks, clipping */
    if (a.clipRuns > 0) {
      add(a.clipRuns > 20 ? 'high' : 'med', 'Level', `Clipping in ${a.clipRuns} place${a.clipRuns > 1 ? 's' : ''}`, master ? 'limiter' : 'fader',
        master ? [['Ceiling', '-1 dBTP'], ['Mode', 'True peak on'], ['Input gain', 'Lower until the crackle stops']] : [['Master fader', 'Down until peaks read about -6 dBFS'], ['Limiter on the mix bus', 'Off']],
        'The waveform is flat-topped, which you hear as crackle and distortion. It cannot be repaired afterwards: lower the level and export again.');
    } else if (master) {
      if (a.truePeakDb > 0) add('med', 'Level', `True peak is over zero (${num(a.truePeakDb)} dBTP)`, 'limiter', [['Ceiling', '-1 dBTP'], ['Mode', 'True peak on']], 'It will distort once it is turned into MP3 or AAC for streaming.');
      else if (a.truePeakDb > -0.8) add('low', 'Level', `True peak is tight (${num(a.truePeakDb)} dBTP)`, 'limiter', [['Ceiling', '-1 dBTP'], ['Mode', 'True peak on']], 'Streaming encoders can push it over. A little more room is safer.');
      else good.push(`Peaks are safe at ${num(a.truePeakDb)} dBTP`);
    } else if (a.truePeakDb > -1) {
      add('med', 'Level', `No headroom for mastering (peak ${num(a.truePeakDb)} dB)`, 'fader', [['Master fader', `Down about ${dbAbs(a.truePeakDb + 6)}`], ['Limiter on the mix bus', 'Off']], 'Mastering needs room to work. Peaks near -6 dBFS are ideal.');
    } else if (a.truePeakDb > -3) {
      add('low', 'Level', `Headroom is slim (peak ${num(a.truePeakDb)} dB)`, 'fader', [['Master fader', `Down about ${dbAbs(a.truePeakDb + 6)}`]], 'Fine if nothing clips, but -6 dBFS peaks give mastering more room.');
    } else {
      good.push(`Healthy headroom (peaks at ${num(a.truePeakDb)} dB)`);
    }

    /* Loudness */
    if (master) {
      const [lo, hi] = profile.lufs;
      if (a.lufs < lo - 0.5) {
        const gap = lo - a.lufs;
        add(gap > 4 ? 'med' : 'low', 'Loudness', `Quiet for a ${profile.name} master (${num(a.lufs)} LUFS)`, 'limiter',
          [['Input gain', `Up about ${dbAbs(gap)}`], ['Ceiling', '-1 dBTP'], ['Aim for', `${num(lo, 0)} to ${num(hi, 0)} LUFS`]],
          'Streaming plays everything near -14 LUFS, so this matters most next to other songs in a playlist or DJ set.');
      } else if (a.lufs > hi + 1) {
        add('med', 'Loudness', `Louder than it needs to be (${num(a.lufs)} LUFS)`, 'limiter', [['Input gain', `Down about ${dbAbs(a.lufs - hi)}`], ['Aim for', `${num(lo, 0)} to ${num(hi, 0)} LUFS`]],
          'Streaming will turn it down anyway, and you keep the squashed sound without the loudness.');
      } else {
        good.push(`Loudness sits right for ${profile.name} (${num(a.lufs)} LUFS)`);
      }
    } else if (a.lufs > -9) {
      add('med', 'Loudness', `Already loud for an unmastered mix (${num(a.lufs)} LUFS)`, 'limiter', [['Mix-bus limiter', 'Bypass it before exporting']], 'It looks limited already. Leave that job to mastering so there is something left to work with.');
    }

    /* Dynamics */
    const [plrLo, plrHi] = profile.plr;
    if (a.plr < (master ? plrLo - 1 : 8)) {
      add(a.plr < (master ? plrLo - 3 : 6) ? 'high' : 'med', 'Dynamics', `Squashed (${num(a.plr)} dB between peak and average)`, master ? 'limiter' : 'comp',
        [[master ? 'Limiter input' : 'Bus compressor', `Back off until this reads ${num(master ? plrLo : 9, 0)} dB or more`], ['Gain reduction', 'No more than 3-4 dB on the loudest hits']],
        'Kick and snare have lost their punch and the song sounds flat and tiring. Too much compression or limiting does this.');
    } else if (master && a.plr > plrHi + 3) {
      add('low', 'Dynamics', `Peaks stick out (${num(a.plr)} dB between peak and average)`, 'comp',
        [['Where', 'Master / mix bus'], ['Ratio', '2:1'], ['Attack', '30 ms'], ['Release', 'Auto, or 100 ms'], ['Gain reduction', '2-3 dB']],
        'A few hits jump far above everything else, so the song cannot be made loud without distorting. A soft clipper before the limiter also works.');
    } else {
      good.push(`Punch is intact (${num(a.plr)} dB peak-to-loudness)`);
    }
    if (master && a.lra > 14) add('low', 'Dynamics', `Big loudness swings between sections (${num(a.lra)} LU)`, 'auto', [['Quiet sections', 'Ride them up 2-3 dB']], 'Listeners will reach for the volume knob between verse and chorus.');

    /* Tone */
    const tonal = M.profiles.compareTonal(a, profile);
    let toneHits = 0;
    for (const r of M.REGIONS) {
      const { dev, tol } = tonal.regions[r.id];
      const over = Math.abs(dev) - tol;
      if (over <= 0) continue;
      if (r.id === 'air' && dev < 0 && a.sampleRate < 40000) continue;
      toneHits++;
      const t = TONE[r.id][dev > 0 ? 'high' : 'low'];
      const amount = clamp(Math.abs(dev) - tol / 2, 1, 5);
      add(over < 1.5 ? 'low' : over < 4 ? 'med' : 'high', 'Tone', `${t.title} (${dbAbs(amount)} ${dev > 0 ? 'over' : 'under'})`, 'eq',
        [['Type', t.type], ['Frequency', t.f], ['Gain', `${dev > 0 ? '-' : '+'}${dbAbs(amount)}`], ['Width (Q)', t.q], ['Put it on', t.on]],
        `${t.hear}${t.also ? ` ${t.also}` : ''}`, REGION_PART[r.id]);
    }
    if (!toneHits) good.push(`Tonal balance matches ${profile.name} from sub to air`);

    /* Stereo */
    if (!a.stereo) {
      add('low', 'Stereo', 'This file is mono', 'edit', [['Export', 'Stereo, with supporting parts panned']], 'Everything comes from one point. If that is not on purpose, export in stereo.');
    } else {
      if (st.correlation < 0) add('high', 'Stereo', `Phase problem (correlation ${num(st.correlation, 2)})`, 'stereo', [['Check', 'Flip polarity on one side of doubled or widened tracks'], ['Wideners', 'Remove or reduce']], 'Left and right are cancelling each other. On a phone or club system in mono, parts will vanish.');
      else if (st.correlation < 0.2) add('med', 'Stereo', `Very wide, shaky in mono (correlation ${num(st.correlation, 2)})`, 'stereo', [['Width', 'Reduce wideners to about 70%'], ['Keep centred', 'Lead vocal, kick, bass']], `It loses about ${dbAbs(st.monoLossDb)} when summed to mono (phone speakers, clubs).`);
      else if (st.widthDb < -18) add('low', 'Stereo', 'Nearly mono', 'reverb', [['Type', 'Stereo plate or hall on a send'], ['Send', '10-20% from vocals, keys and guitars'], ['Also pan', 'Doubles, guitars, keys and backing vocals 50-100% left and right']], 'Everything is stacked in the middle, so parts cover each other. Width comes from panning and a stereo reverb.');
      else good.push('Stereo image is wide and still holds up in mono');
      if (st.lowSideDb > -10) add('med', 'Stereo', 'Bass is spread wide', 'stereo', [['Mono below', '120 Hz'], ['Put it on', 'Bass and 808, or the master']], 'Wide bass disappears on club systems and vinyl, and wastes headroom.');
      if (Math.abs(st.balanceDb) > 1.5) add(Math.abs(st.balanceDb) > 3 ? 'med' : 'low', 'Stereo', `Leans ${st.balanceDb > 0 ? 'left' : 'right'} by ${dbAbs(st.balanceDb)}`, 'stereo', [['Balance', `${dbAbs(st.balanceDb / 2)} towards the ${st.balanceDb > 0 ? 'right' : 'left'}`]], 'One side is louder. Better still, move one supporting part to the other side.');
    }

    /* Mastering forensics */
    if (a.rumbleDb > -25) add('low', 'Tone', 'Rumble below 20 Hz', 'eq', [['Type', 'High-pass filter'], ['Frequency', '25-30 Hz'], ['Slope', '24 dB/oct'], ['Put it on', 'The master']], 'You cannot hear it on most speakers, but it eats headroom and makes the limiter work harder.', 'low');
    if (a.sampleRate >= 44100 && a.cutoffHz > 8000 && a.cutoffHz < 17500) add(a.cutoffHz < 15500 ? 'med' : 'low', 'Tone', `Top end stops dead at ${hz(a.cutoffHz)}`, 'edit', [['Source files', 'Use the original WAV exports, not MP3s']], 'That brick wall is the mark of an MP3/AAC source or a low-quality sample. EQ cannot bring back what the encoder removed.', 'top');
    if (master) {
      if (a.limitedRatio > 0.7 && !issues.some((i) => i.area === 'Dynamics')) add('low', 'Dynamics', `Peaks are pinned to the ceiling ${Math.round(a.limitedRatio * 100)}% of the time`, 'limiter', [['Input gain', 'Down 1-2 dB'], ['Before it', 'A clipper taking 1-2 dB off the drum hits']], 'The limiter never lets go, which dulls the drums.');
      if (a.maxShortTerm - a.lufs > 5) add('low', 'Dynamics', `Loudest section jumps ${dbAbs(a.maxShortTerm - a.lufs)} above the rest`, 'auto', [['Loudest section', 'Down 1-2 dB, before the limiter']], 'The drop or last chorus may be overloading the limiter.');
      if (a.leadSilence > 1) add('low', 'Edit', `${num(a.leadSilence)} s of silence before the music starts`, 'edit', [['Trim start to', 'About 0.2 s']], 'The song should start when people press play.');
      if (a.tailSilence > 4) add('low', 'Edit', `${num(a.tailSilence)} s of silence at the end`, 'edit', [['Trim tail to', '1-2 s after the last sound']], 'Dead air delays the next song.');
      if (a.abruptEnd) add('low', 'Edit', 'Ends abruptly', 'edit', [['Ending', 'Let the last note and reverb ring out, or add a short fade']], 'The file stops while the music is still loud.');
    }
    if (a.dcOffset > 0.005) add('low', 'Level', 'DC offset', 'eq', [['Type', 'High-pass filter'], ['Frequency', '20 Hz'], ['Put it on', 'The master']], 'The waveform sits off centre, which wastes headroom.');

    const cost = { high: 14, med: 7, low: 3 };
    const score = clamp(100 - issues.reduce((s, i) => s + cost[i.sev], 0), 0, 100);
    const order = { high: 0, med: 1, low: 2 };
    issues.sort((x, y) => order[x.sev] - order[y.sev]);
    let verdict, tone;
    if (score >= 88) { verdict = 'Good'; tone = 'good'; }
    else if (score >= 72) { verdict = 'Decent'; tone = 'ok'; }
    else if (score >= 50) { verdict = 'Meh'; tone = 'warn'; }
    else { verdict = 'Rough'; tone = 'bad'; }
    const top = issues[0];
    const summary = score >= 88
      ? (issues.length ? `Close to release-ready. One small thing: ${top.title.toLowerCase()}.` : 'Nothing to fix against this target. Trust your ears from here.')
      : `${issues.filter((i) => i.sev !== 'low').length || issues.length} thing${issues.length > 1 ? 's' : ''} to fix. Start with: ${top.title.toLowerCase()}.`;
    return { score, verdict, tone, summary, issues, good, tonal };
  }

  /* ================= Stems ================= */
  const cut = (f, q, why) => ({ kind: 'cut', f, q, why });
  const boost = (f, q, why) => ({ kind: 'boost', f, q, why });
  const shelfUp = (f, why) => ({ kind: 'shelfUp', f, why });
  const shelfDown = (f, why) => ({ kind: 'shelfDown', f, why });
  const rule = (a, b, lo, hi, low, high) => ({ a, b, lo, hi, low, high });

  /* level: target loudness relative to the lead vocal (LU). comp: [ratio, attack ms, release ms, bias].
     verb: reverb send %. pri: who wins a frequency clash. */
  const ROLES = {
    vocal: { name: 'Lead vocal', level: 0, hp: [70, 120], comp: [3, 8, 60, 1.5], verb: 15, verbType: 'Plate', delay: 10, sat: 8, pan: 'Centre', pri: 10,
      tone: [
        rule([200, 400], [1000, 4000], 2, 13, boost(200, 0.8, 'thin, needs body'), cut(300, 1.2, 'muddy, clouds the words')),
        rule([3000, 6000], [500, 2000], -20, -8, boost(4500, 0.8, 'needs presence to sit on top'), cut(3500, 2, 'harsh')),
        rule([8000, 16000], [500, 2000], -28, -14, shelfUp(11000, 'adds air and polish'), shelfDown(10000, 'brittle top')),
      ] },
    bvox: { name: 'Backing vocals', level: -6, hp: [100, 160], comp: [4, 5, 60, 2], verb: 22, verbType: 'Plate or hall', delay: 0, sat: 0, pan: 'Spread 60-80% left and right', pri: 5,
      tone: [
        rule([200, 400], [1000, 4000], 0, 10, null, cut(300, 1, 'leave the body to the lead')),
        rule([3000, 6000], [500, 2000], -24, -12, null, cut(4000, 1.5, 'keeps them behind the lead')),
      ] },
    kick: { name: 'Kick', level: -2, hp: null, comp: [4, 25, 80, 0], verb: 0, sat: 8, pan: 'Centre', pri: 9,
      tone: [
        rule([40, 100], [200, 500], 6, 30, boost(60, 1, 'more thump'), null),
        rule([200, 500], [40, 100], -40, -8, null, cut(350, 1.5, 'boxy cardboard tone')),
        rule([2000, 6000], [40, 100], -38, 0, boost(3500, 1, 'beater click so it reads on small speakers'), null),
      ] },
    snare: { name: 'Snare / clap', level: -3, hp: [80, 110], comp: [4, 15, 100, 0], verb: 12, verbType: 'Plate or room', sat: 5, pan: 'Centre', pri: 8,
      tone: [
        rule([150, 300], [2000, 6000], -8, 12, boost(200, 1, 'more body'), boost(5000, 0.8, 'more crack')),
      ] },
    hats: { name: 'Hi-hats / cymbals', level: -9, hp: [250, 400], comp: null, verb: 3, verbType: 'Room', sat: 0, pan: '15-25% right', pri: 3,
      tone: [rule([2500, 5000], [7000, 14000], -30, 2, null, cut(3500, 1.5, 'clangy, fights the vocal'))] },
    perc: { name: 'Percussion', level: -8, hp: [100, 200], comp: null, verb: 8, verbType: 'Room', sat: 0, pan: '30-40% left', pri: 3, tone: [] },
    drums: { name: 'Drum bus / loop', level: 1, hp: [25, 35], comp: [2, 30, 100, -1], verb: 5, verbType: 'Room', sat: 10, pan: 'Stereo, as recorded', pri: 8,
      tone: [
        rule([40, 120], [300, 2000], -4, 14, boost(70, 0.8, 'kick lacks weight'), cut(90, 0.8, 'low end swamps the kit')),
        rule([6000, 14000], [300, 2000], -22, -4, shelfUp(8000, 'cymbals and snare are dull'), shelfDown(8000, 'cymbals are splashy')),
      ] },
    bass: { name: 'Bass', level: -3, hp: [25, 35], comp: [4, 20, 120, 1], verb: 0, sat: 10, pan: 'Centre', pri: 7,
      tone: [
        rule([180, 400], [40, 120], -30, -4, null, cut(250, 1.2, 'muddy')),
        rule([700, 2500], [40, 120], -40, 0, boost(1000, 1, 'so the notes are heard on small speakers'), null),
      ] },
    sub808: { name: '808 / sub', level: -2, hp: [20, 28], comp: [3, 30, 150, -1], verb: 0, sat: 18, pan: 'Centre', pri: 7,
      tone: [rule([200, 1000], [30, 100], -30, 0, null, null)] },
    guitar: { name: 'Guitar', level: -7, hp: [80, 120], comp: [3, 20, 100, 0], verb: 10, verbType: 'Room or spring', delay: 0, sat: 0, pan: '30% left', pri: 5,
      tone: [
        rule([120, 350], [800, 3000], -6, 8, null, cut(250, 1, 'muddy, fights bass and vocal body')),
        rule([2500, 5000], [300, 1200], -22, -4, boost(3000, 1, 'needs bite'), cut(3200, 2, 'harsh')),
      ] },
    keys: { name: 'Keys / piano', level: -8, hp: [60, 120], comp: [2.5, 25, 150, -1], verb: 12, verbType: 'Hall', sat: 0, pan: '30% right, or full stereo', pri: 4,
      tone: [rule([120, 400], [800, 3000], -4, 12, null, cut(300, 1, 'left-hand mud'))] },
    synth: { name: 'Synth lead / pluck', level: -5, hp: [100, 150], comp: [2.5, 15, 100, -1], verb: 12, verbType: 'Hall', delay: 12, sat: 8, pan: 'Centre or slightly off', pri: 6, tone: [] },
    pad: { name: 'Pad', level: -11, hp: [120, 200], comp: null, verb: 18, verbType: 'Hall', sat: 0, pan: 'Full stereo width', pri: 1,
      tone: [rule([80, 300], [800, 3000], -10, 8, null, cut(250, 0.8, 'fills the space the bass and vocal need'))] },
    strings: { name: 'Strings', level: -9, hp: [100, 160], comp: null, verb: 20, verbType: 'Hall', sat: 0, pan: '40% left', pri: 2, tone: [] },
    brass: { name: 'Brass / horns', level: -7, hp: [100, 150], comp: [3, 15, 100, 0], verb: 12, verbType: 'Plate', sat: 0, pan: '40% right', pri: 4, tone: [] },
    fx: { name: 'FX / risers', level: -14, hp: [150, 200], comp: null, verb: 20, verbType: 'Hall', sat: 0, pan: 'Wide', pri: 0, tone: [] },
    other: { name: 'Other', level: -8, hp: [40, 150], comp: [2.5, 20, 100, -1], verb: 8, verbType: 'Room', sat: 0, pan: 'Off centre', pri: 2, tone: [] },
  };

  const NAME_HINTS = [
    ['bvox', /\b(bv|bgv)s?\b|back|harm|adlib|choir|dub(s|le)?\b|stack/],
    ['vocal', /vox|vocal|voice|acap|sing|verse|hook|lead.?v/],
    ['kick', /kick|\bbd\b/],
    ['snare', /snare|clap|rim|\bsd\b/],
    ['hats', /hat|\bhh\b|cymbal|ride|shaker|\boh\b/],
    ['perc', /perc|conga|bongo|tamb|cowbell|tom/],
    ['sub808', /808|\bsub/],
    ['bass', /bass/],
    ['drums', /drum|beat|loop|kit|break/],
    ['guitar', /gtr|guit/],
    ['keys', /piano|keys|rhodes|organ|wurl|\bep\b/],
    ['pad', /pad|atmos|ambien/],
    ['strings', /string|violin|cello|viola/],
    ['brass', /brass|horn|sax|trump|tromb/],
    ['synth', /synth|lead|pluck|arp|bell/],
    ['fx', /\bfx\b|riser|sweep|impact|noise|sfx/],
  ];

  function guessRole(fileName, a) {
    const name = fileName.toLowerCase().replace(/[_\-.]+/g, ' ');
    for (const [role, re] of NAME_HINTS) if (re.test(name)) return role;
    if (a.centroidHz < 250 && a.regions.bass + 3 > a.regions.mid) return a.regions.sub > a.regions.bass ? 'sub808' : 'bass';
    if (a.centroidHz > 6000) return 'hats';
    return 'other';
  }

  function eqMove(action, excess) {
    const amount = clamp(0.5 * excess + 1.5, 1.5, 5);
    const where = hz(action.f);
    if (action.kind === 'cut') return [`Cut ${dbAbs(amount)} at ${where} (Q ${action.q})`, action.why];
    if (action.kind === 'boost') return [`Boost ${dbAbs(Math.min(amount, 4))} at ${where} (Q ${action.q})`, action.why];
    if (action.kind === 'shelfUp') return [`High shelf +${dbAbs(Math.min(amount, 4))} from ${where}`, action.why];
    return [`High shelf -${dbAbs(Math.min(amount, 4))} from ${where}`, action.why];
  }

  /* One stem's effect chain, in the order to insert it. ctx: { profile, bpm, sameRoleIndex, sameRoleCount } */
  function stemRecipe(a, roleId, ctx) {
    const role = ROLES[roleId] || ROLES.other;
    const steps = [];
    const step = (fx, setting, why) => steps.push({ fx, setting, why });
    const beat = ctx.bpm ? 60000 / ctx.bpm : 500;
    const tempoNote = ctx.bpm ? `at ${Math.round(ctx.bpm)} BPM` : 'tempo not detected, assuming 120 BPM';
    const abs = a.thirdOctAbs;
    const tonalRole = !['kick', 'snare', 'hats', 'perc', 'drums', 'fx'].includes(roleId);

    /* 1. Clean-up */
    if (role.hp) {
      const f = clamp(a.lowExtentHz * 0.8, role.hp[0], role.hp[1]);
      step('High-pass filter', `${hz(f)}, 12 dB/oct`, `Almost nothing useful sits below that in this ${role.name.toLowerCase()}; it only eats headroom.`);
    } else if (a.lowExtentHz < 28) {
      step('High-pass filter', '25 Hz, 24 dB/oct', 'There is rumble below what speakers can play.');
    }
    if (a.noiseFloorDb > -62 && a.activeRatio < 0.8 && a.loudPeakDb - a.noiseFloorDb > 25) {
      step('Gate / expander', `Threshold about ${Math.round(a.noiseFloorDb + 8)} dB, 6-10 dB of reduction`, `Hiss or bleed sits around ${Math.round(a.noiseFloorDb)} dB in the gaps.`);
    }

    /* 2. Corrective EQ */
    for (const r of role.tone) {
      const diff = M.levelBetween(abs, r.a[0], r.a[1]) - M.levelBetween(abs, r.b[0], r.b[1]);
      if (diff > r.hi && r.high) step('EQ', ...eqMove(r.high, diff - r.hi));
      else if (diff < r.lo && r.low) step('EQ', ...eqMove(r.low, r.lo - diff));
    }
    if (tonalRole) {
      const boosted = steps.some((s) => /^Boost/.test(s.setting));
      for (const res of a.resonances.filter((r) => r.excessDb <= 14).slice(0, boosted ? 0 : 2)) {
        step('EQ', `Narrow cut ${dbAbs(clamp(res.excessDb * 0.4, 2, 5))} at ${hz(res.freq)} (Q 6)`, `A peak stands ${Math.round(res.excessDb)} dB proud there. Sweep to confirm it rings before cutting; it may just be the key of the song.`);
      }
    }

    /* 3. De-ess (voices only) */
    if ((roleId === 'vocal' || roleId === 'bvox') && a.sibilance.index > -9) {
      const amount = a.sibilance.index > -4 ? '4-6 dB' : '2-3 dB';
      step('De-esser', `${hz(clamp(a.sibilance.freq, 5000, 9000))}, ${amount} of reduction on the S sounds`, 'The "s" and "t" sounds jump out against the rest of the voice.');
    }

    /* 4. Compression, sized from how uneven the part actually is */
    const spread = a.levelSpreadDb;
    const comp = role.comp || (spread > 4 ? [2.5, 20, 120, -1] : null);
    if (comp) {
      const [baseRatio, attack, release, bias] = comp;
      const gr = tonalRole ? clamp(0.9 * spread + bias, 0, 8) : 3 + bias;
      if (gr < 1.5 && a.crestDb < 14) {
        step('Compressor', 'Skip it', `Level only moves about ±${num(spread)} dB. It is already even.`);
      } else {
        const ratio = !tonalRole ? baseRatio : spread > 5 ? baseRatio + 1 : spread < 2.5 ? Math.max(2, baseRatio - 1) : baseRatio;
        const target = Math.max(gr, 2);
        const threshold = a.loudPeakDb - target / (1 - 1 / ratio);
        const why = !tonalRole
          ? 'Evens out the hits. The slow attack lets the transient through so it keeps its punch.'
          : `Level swings about ±${num(spread)} dB while it plays.${spread > 5 ? ' That is a lot: even out the loudest phrases with clip gain or automation first so the compressor does not pump.' : ''}`;
        step('Compressor', `${ratio}:1, threshold near ${Math.round(threshold)} dB, attack ${ms(attack)}, release ${ms(release)}, aim for ${Math.round(target)} dB of gain reduction on the loud parts`, why);
      }
    }

    /* 5. Colour */
    let sat = role.sat || 0;
    if ((roleId === 'bass' || roleId === 'sub808') && M.levelBetween(abs, 200, 2000) - M.levelBetween(abs, 30, 120) < -22) sat += 12;
    if (sat) step('Saturation', `${sat}% mix (parallel)`, roleId === 'bass' || roleId === 'sub808' ? 'Adds harmonics so the bass line is heard on phones and laptops.' : 'A little density and warmth.');

    /* 6. Space */
    const verb = Math.round(role.verb * (ctx.profile.verb || 1));
    if (verb > 0) {
      const long = ['vocal', 'bvox', 'pad', 'strings', 'keys', 'synth', 'fx'].includes(roleId);
      const decay = long ? clamp((2 * beat) / 1000, 0.8, 2.6) : clamp(beat / 1000, 0.4, 1.2);
      const pre = clamp(beat / 16, 15, 60);
      step('Reverb (send)', `${role.verbType}, ${verb}% send, ${decay.toFixed(1)} s decay, ${ms(pre)} pre-delay`, `Decay and pre-delay are timed to the song (${tempoNote}). Filter the return: cut below 250 Hz and above 8 kHz.`);
    } else {
      step('Reverb', 'None', 'Reverb on low-end parts blurs the whole mix.');
    }
    if (role.delay) {
      step('Delay (send)', `${ms(roleId === 'vocal' ? beat : beat / 2)} (${roleId === 'vocal' ? '1/4' : '1/8'} note), ${Math.round(role.delay * (ctx.profile.verb || 1))}% send, 20% feedback`, 'Fills gaps between phrases without washing out the words. Filter it darker than the dry sound.');
    }

    /* 7. Placement */
    let pan = role.pan;
    if (ctx.sameRoleCount > 1 && !/Centre$/.test(role.pan)) {
      const side = ctx.sameRoleIndex % 2 === 0 ? 'left' : 'right';
      const amount = clamp(100 - 30 * Math.floor(ctx.sameRoleIndex / 2), 40, 100);
      pan = `${amount}% ${side} (opposite its twin)`;
    }
    step('Pan', pan, a.stereo && a.stereoInfo.widthDb > -12 ? 'This file is already stereo; keep its width unless it crowds the centre.' : '');
    return { role: role.name, steps };
  }

  /* Fader moves that bring the stems to a typical balance for the style. */
  function balanceStems(stems, profile) {
    const wanted = stems.map((s) => (ROLES[s.role] || ROLES.other).level + (profile.levels[s.role] || 0) - s.analysis.lufs);
    const sorted = wanted.slice().sort((x, y) => x - y);
    const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    return wanted.map((w) => half(clamp(w - mid, -15, 15)));
  }

  /* Pairs of stems fighting for the same frequencies once balanced. */
  function findClashes(stems, gains, bpm) {
    const bands = M.THIRD_OCT.map((f, i) => ({ f, i })).filter((b) => b.f >= 40 && b.f <= 10000);
    const out = [];
    for (let x = 0; x < stems.length; x++) {
      for (let y = x + 1; y < stems.length; y++) {
        const A = stems[x].analysis.thirdOctAbs.map((v) => v + gains[x]);
        const B = stems[y].analysis.thirdOctAbs.map((v) => v + gains[y]);
        const topA = Math.max(...bands.map((b) => A[b.i]));
        const topB = Math.max(...bands.map((b) => B[b.i]));
        let run = [], best = [];
        for (const b of bands) {
          const hit = A[b.i] > topA - 10 && B[b.i] > topB - 10 && Math.abs(A[b.i] - B[b.i]) < 6;
          if (hit) { run.push(b.f); if (run.length > best.length) best = run.slice(); } else run = [];
        }
        if (best.length < 2) continue;
        const lo = best[0], hi = best[best.length - 1], centre = Math.sqrt(lo * hi);
        const rx = ROLES[stems[x].role] || ROLES.other, ry = ROLES[stems[y].role] || ROLES.other;
        const [win, lose] = rx.pri >= ry.pri ? [stems[x], stems[y]] : [stems[y], stems[x]];
        const lowPair = hi < 200 && [stems[x].role, stems[y].role].some((r) => r === 'kick' || r === 'drums');
        const fix = lowPair
          ? `Let the kick own the hit: sidechain-compress ${lose.name} from ${win.name} (4:1, fastest attack, release ${ms(bpm ? 30000 / bpm : 150)}, 3-5 dB of ducking), or cut ${lose.name} 3 dB at ${hz(centre)}.`
          : `Give ${win.name} the space: cut ${lose.name} by 2-3 dB at ${hz(centre)} (Q 1.5)${/Centre/.test(rx.pan) && /Centre/.test(ry.pan) ? '' : ', or pan them to opposite sides'}.`;
        out.push({ a: stems[x].name, b: stems[y].name, lo, hi, size: best.length, fix });
      }
    }
    return out.sort((p, q) => q.size - p.size).slice(0, 5);
  }

  /* What the arrangement lacks, read from the summed stems. */
  function findGaps(mixAssessment, stems) {
    const roles = new Set(stems.map((s) => s.role));
    const has = (...ids) => ids.some((r) => roles.has(r));
    const gaps = [];
    const dev = (id) => mixAssessment.tonal.regions[id];
    const under = (id) => dev(id).dev < -dev(id).tol;
    if (under('sub') || under('bass')) gaps.push(has('bass', 'sub808') ? 'The low end is light even with the bass in. Raise it, or pick a lower octave for the bass line.' : 'There is no bass instrument and the low end is empty. Add a bass line or 808.');
    else if (!has('bass', 'sub808', 'drums', 'kick')) gaps.push('No kick or bass stem was loaded, so low-end advice is limited.');
    if (under('lowmid')) gaps.push('Thin in the low mids (250-500 Hz). A pad, rhythm guitar or piano chords would give it warmth.');
    if (under('mid') || under('highmid')) gaps.push(has('vocal', 'synth', 'guitar', 'brass') ? 'The middle is recessed. The lead parts need to come up, or carry more 1-3 kHz.' : 'Nothing is carrying the melody range (1-3 kHz). A lead vocal or lead instrument is missing.');
    if (under('presence') || under('air')) gaps.push(has('hats', 'drums', 'perc') ? 'The top end is dull. Brighten hats and vocal air, or add a shaker.' : 'There is nothing up top. Hi-hats, shakers or a bright percussion part would add sparkle.');
    return gaps;
  }

  /* Song tempo from the stems: trust drums first, then whichever stem has the clearest pulse. */
  function songTempo(stems) {
    const drums = ['kick', 'drums', 'snare', 'hats', 'perc'];
    const pick = (list) => list.filter((s) => s.analysis.tempo.bpm).sort((x, y) => y.analysis.tempo.confidence - x.analysis.tempo.confidence)[0];
    const best = pick(stems.filter((s) => drums.includes(s.role))) || pick(stems);
    return best ? Math.round(best.analysis.tempo.bpm * 2) / 2 : null;
  }

  /* What streaming services will do to this master's volume. */
  function streamingPreview(a) {
    const services = [['Spotify', -14, 'limited'], ['YouTube', -14, 'down'], ['Apple Music', -16, 'both'], ['Tidal', -14, 'down'], ['Amazon Music', -14, 'down']];
    return services.map(([name, target, mode]) => {
      let change = target - a.lufs;
      if (change > 0) change = mode === 'down' ? 0 : Math.max(0, Math.min(change, (mode === 'limited' ? -1 : 0) - a.truePeakDb));
      const plays = a.lufs + change;
      const note = change < -0.5 ? `Turned down ${dbAbs(change)}` : change > 0.5 ? `Turned up ${dbAbs(change)}` : 'Left as it is';
      return { name, target, change, plays, note: plays < target - 1 ? `${note}. Plays ${dbAbs(target - plays)} quieter than other songs` : note };
    });
  }

  /* A mastering chain for an unmastered mix, sized from its measurements. */
  function masteringPlan(a, profile, result) {
    const steps = [];
    const step = (fx, setting, why) => steps.push({ fx, setting, why });
    const st = a.stereoInfo;
    const EQ = {
      sub: (x) => `Low shelf ${x} at 50 Hz`, bass: (x) => `Bell ${x} at 110 Hz (Q 0.8)`, lowmid: (x) => `Bell ${x} at 300 Hz (Q 1)`,
      mid: (x) => `Bell ${x} at 1 kHz (Q 0.7)`, highmid: (x) => `Bell ${x} at 3 kHz (Q 1)`, presence: (x) => `Bell ${x} at 6 kHz (Q 1)`, air: (x) => `High shelf ${x} at 10 kHz`,
    };
    const big = M.REGIONS.filter((r) => Math.abs(result.tonal.regions[r.id].dev) > result.tonal.regions[r.id].tol + 4);
    if (a.clipRuns > 0 || big.length) {
      step('Before mastering', 'Go back to the mix', `${a.clipRuns > 0 ? 'The file is clipped. ' : ''}${big.length ? `The tone is further off than mastering EQ should correct (${big.map((r) => r.name.toLowerCase()).join(', ')}). ` : ''}Mastering polishes a mix; it cannot rescue one.`);
    }
    if (a.rumbleDb > -30 || a.lowExtentHz < 30) step('High-pass filter', '25 Hz, 24 dB/oct', 'Clears inaudible rumble so the limiter has less to fight.');
    if (a.stereo && st.lowSideDb > -14) step('Stereo', 'Mono everything below 120 Hz', 'Keeps the low end solid on clubs, phones and vinyl.');
    for (const r of M.REGIONS) {
      const { dev, tol } = result.tonal.regions[r.id];
      if (Math.abs(dev) < tol * 0.6) continue;
      const move = -clamp(dev * 0.5, -3, 3);
      if (Math.abs(move) < 0.75) continue;
      step('EQ', EQ[r.id](db(move)), `${r.name}: ${dbAbs(dev)} ${dev > 0 ? 'over' : 'under'} the ${profile.name} target. Mastering moves stay gentle and wide.`);
    }
    const [plrLo, plrHi] = profile.plr;
    if (a.plr > plrHi + 1) step('Bus compressor', '2:1, attack 30 ms, release auto, 1-2 dB of gain reduction', `Peaks stand ${num(a.plr)} dB above the average. A little glue evens that out before the limiter.`);
    else step('Bus compressor', a.plr < plrLo + 1 ? 'Skip it' : 'Optional: 1.5:1, attack 30 ms, 1 dB of gain reduction', a.plr < plrLo + 1 ? 'The mix is already dense. More compression will only flatten it.' : 'Dynamics are in a good place; only add glue if you like the sound of it.');
    const target = (profile.lufs[0] + profile.lufs[1]) / 2;
    const gain = target - a.lufs;
    const limiting = Math.max(0, a.truePeakDb + gain + 1);
    if (gain <= 0.5) {
      step('Limiter', 'Ceiling -1 dBTP, true-peak mode, no extra gain', `It already reads ${num(a.lufs)} LUFS, at or above the ${num(target, 0)} LUFS this style aims for.`);
    } else if (limiting > 5) {
      const safe = gain - (limiting - 4);
      step('Clipper', 'Soft clip 1-2 dB off the loudest drum hits', `Reaching ${num(target, 0)} LUFS would need about ${Math.round(limiting)} dB of limiting, which flattens the drums. Shave the peaks first.`);
      step('Limiter', `Ceiling -1 dBTP, true-peak mode, input gain about ${db(safe)} (lands near ${num(a.lufs + safe)} LUFS)`, `Stop at around 4 dB of limiting. To go louder than that, tame kick and snare peaks in the mix, not here.`);
    } else {
      step('Limiter', `Ceiling -1 dBTP, true-peak mode, input gain about ${db(gain)}`, `Lands near ${num(target, 0)} LUFS with about ${num(limiting, 0)} dB of limiting on the loudest hits.`);
    }
    step('Check', 'Export, then load the result here as "Finished master"', 'Confirms loudness, true peak and tone landed where this plan aimed.');
    return steps;
  }

  M.advice = { PARTS, reportCard, diagnoseStem, grade, TOOLS, toolbox, toolForStep, songTempo, streamingPreview, masteringPlan, assessMix, stemRecipe, balanceStems, findClashes, findGaps, guessRole, ROLES, format: { hz, db, dbAbs, num } };
})(typeof self !== 'undefined' ? self : globalThis);
