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

  /* ================= Full-mix verdict ================= */
  const TONE_TEXT = {
    sub: {
      high: (x) => [`Too much sub (${x} over)`, `High-pass everything that isn't kick or bass, then pull a low shelf at 50 Hz down about ${x}, or turn the 808/sub down.`],
      low: (x) => [`Thin at the very bottom (${x} under)`, `Raise the sub bass or 808, or add a low shelf at 50 Hz of about +${x}. Check the kick isn't tuned too high.`],
    },
    bass: {
      high: (x) => [`Boomy low end (${x} over)`, `Cut about ${x} around 100-150 Hz with a wide bell (Q 0.8). Check that kick and bass aren't stacking on the same note.`],
      low: (x) => [`Lacks weight (${x} under)`, `Bring the bass and kick up about ${x}, or add a wide +${x} bell at 100 Hz.`],
    },
    lowmid: {
      high: (x) => [`Muddy low mids (${x} over)`, `Cut about ${x} at 300 Hz (Q 1). If you have the stems, do it on guitars, keys, pads and the vocal body, not on the master.`],
      low: (x) => [`Hollow body (${x} under)`, `Add about +${x} at 300-400 Hz, or ease off the low-mid cuts on guitars, keys and vocal.`],
    },
    mid: {
      high: (x) => [`Boxy, honky mids (${x} over)`, `Cut about ${x} at 1 kHz with a wide bell (Q 0.7).`],
      low: (x) => [`Scooped mids (${x} under)`, `Vocals and melody live here. Raise the lead by about ${x}, or add a wide +${x} bell at 1 kHz.`],
    },
    highmid: {
      high: (x) => [`Harsh upper mids (${x} over)`, `Cut about ${x} at 3 kHz (Q 1.5). Usual suspects: vocal, snare, electric guitars. A dynamic EQ is kinder than a static cut.`],
      low: (x) => [`Lacks bite and clarity (${x} under)`, `Add about +${x} at 3 kHz. If the vocal feels buried, do it on the vocal first.`],
    },
    presence: {
      high: (x) => [`Sharp, sibilant top (${x} over)`, `De-ess the vocals, pull the hats down, and cut about ${x} at 6 kHz.`],
      low: (x) => [`Dull (${x} under)`, `Add about +${x} at 5-6 kHz, or raise hats and vocal presence.`],
    },
    air: {
      high: (x) => [`Fizzy, brittle air (${x} over)`, `High shelf at 10 kHz, about -${x}.`],
      low: (x) => [`No air (${x} under)`, `High shelf at 10-12 kHz, about +${x}. If this came from an MP3, the encoder may have cut the top off.`],
    },
  };

  function assessMix(a, profile, stage) {
    const issues = [];
    const good = [];
    const add = (sev, area, title, fix) => issues.push({ sev, area, title, fix });
    const master = stage === 'master';
    const st = a.stereoInfo;

    /* Level, peaks, clipping */
    if (a.clipRuns > 0) {
      add(a.clipRuns > 20 ? 'high' : 'med', 'Level', `Clipping in ${a.clipRuns} place${a.clipRuns > 1 ? 's' : ''}`,
        'The waveform is flat-topped. Pull the master fader or limiter ceiling down and re-export. Aim for a true peak of -1 dB.');
    } else if (master) {
      if (a.truePeakDb > 0) add('med', 'Level', `True peak is over zero (${num(a.truePeakDb)} dBTP)`, 'It will distort after MP3/AAC encoding. Set the limiter ceiling to -1 dBTP with true-peak mode on.');
      else if (a.truePeakDb > -0.8) add('low', 'Level', `True peak is tight (${num(a.truePeakDb)} dBTP)`, 'Set the limiter ceiling to -1 dBTP so streaming encoders don\'t clip it.');
      else good.push(`Peaks are safe at ${num(a.truePeakDb)} dBTP`);
    } else if (a.truePeakDb > -1) {
      add('med', 'Level', `No headroom for mastering (peak ${num(a.truePeakDb)} dB)`, `Pull the mix bus down about ${dbAbs(a.truePeakDb + 6)} so peaks land near -6 dBFS, and take any limiter off.`);
    } else if (a.truePeakDb > -3) {
      add('low', 'Level', `Headroom is slim (peak ${num(a.truePeakDb)} dB)`, 'Fine if nothing clips, but -6 dBFS peaks give mastering more room.');
    } else {
      good.push(`Healthy headroom (peaks at ${num(a.truePeakDb)} dB)`);
    }

    /* Loudness */
    if (master) {
      const [lo, hi] = profile.lufs;
      if (a.lufs < lo - 0.5) {
        const gap = lo - a.lufs;
        add(gap > 4 ? 'med' : 'low', 'Loudness', `Quiet for a ${profile.name} master (${num(a.lufs)} LUFS)`,
          `Typical is ${num(lo, 0)} to ${num(hi, 0)} LUFS. Push about ${dbAbs(gap)} more into the limiter. Streaming plays everything near -14 LUFS, so this matters mostly next to other songs in a playlist or DJ set.`);
      } else if (a.lufs > hi + 1) {
        add('med', 'Loudness', `Louder than it needs to be (${num(a.lufs)} LUFS)`, `Streaming will turn it down anyway and you keep the squashed sound. Back the limiter off about ${dbAbs(a.lufs - hi)}.`);
      } else {
        good.push(`Loudness sits right for ${profile.name} (${num(a.lufs)} LUFS)`);
      }
    } else if (a.lufs > -9) {
      add('med', 'Loudness', `Already loud for an unmastered mix (${num(a.lufs)} LUFS)`, 'It looks limited. Bypass the mix-bus limiter before mastering so there is something left to work with.');
    }

    /* Dynamics */
    const [plrLo, plrHi] = profile.plr;
    if (a.plr < (master ? plrLo - 1 : 8)) {
      add(a.plr < (master ? plrLo - 3 : 6) ? 'high' : 'med', 'Dynamics', `Squashed (${num(a.plr)} dB between peak and average)`,
        `Drums lose their punch below about ${num(master ? plrLo : 9, 0)} dB. Ease the limiter and bus compressor until the kick and snare jump out again.`);
    } else if (master && a.plr > plrHi + 3) {
      add('low', 'Dynamics', `Peaks stick out (${num(a.plr)} dB between peak and average)`, 'Tame them with 2-3 dB of bus compression (2:1, 30 ms attack, auto release) or a soft clipper before the limiter.');
    } else {
      good.push(`Punch is intact (${num(a.plr)} dB peak-to-loudness)`);
    }
    if (master && a.lra > 14) add('low', 'Dynamics', `Big loudness swings between sections (${num(a.lra)} LU)`, 'Ride the quiet sections up with volume automation so listeners don\'t reach for the volume knob.');

    /* Tone */
    const tonal = M.profiles.compareTonal(a, profile);
    let toneHits = 0;
    for (const r of M.REGIONS) {
      const { dev, tol } = tonal.regions[r.id];
      const over = Math.abs(dev) - tol;
      if (over <= 0) continue;
      if (r.id === 'air' && dev < 0 && a.sampleRate < 40000) continue;
      toneHits++;
      const amount = dbAbs(clamp(Math.abs(dev) - tol / 2, 1, 5));
      const [title, fix] = TONE_TEXT[r.id][dev > 0 ? 'high' : 'low'](amount);
      add(over < 1.5 ? 'low' : over < 4 ? 'med' : 'high', 'Tone', title, fix);
    }
    if (!toneHits) good.push(`Tonal balance matches ${profile.name} from sub to air`);

    /* Stereo */
    if (!a.stereo) {
      add('low', 'Stereo', 'This file is mono', 'If that is not on purpose, export in stereo and pan the supporting parts.');
    } else {
      if (st.correlation < 0) add('high', 'Stereo', `Phase problem (correlation ${num(st.correlation, 2)})`, 'Left and right are cancelling. In mono, parts will vanish. Look for a stereo widener, a flipped cable/polarity, or a doubled part with one side inverted.');
      else if (st.correlation < 0.2) add('med', 'Stereo', `Very wide, shaky in mono (correlation ${num(st.correlation, 2)})`, `It loses about ${dbAbs(st.monoLossDb)} when summed to mono (phone speakers, clubs). Ease off stereo wideners and keep lead, kick and bass centred.`);
      else if (st.widthDb < -18) add('low', 'Stereo', 'Nearly mono', 'Pan doubles, guitars, keys and backing vocals outwards, and use a stereo reverb, so the centre is left for vocal, kick and bass.');
      else good.push('Stereo image is wide and still holds up in mono');
      if (st.lowSideDb > -10) add('med', 'Stereo', 'Bass is spread wide', 'Make everything under 120 Hz mono (most EQs and utility plugins have a "mono below" control). Wide bass disappears on club systems and vinyl.');
      if (Math.abs(st.balanceDb) > 1.5) add(Math.abs(st.balanceDb) > 3 ? 'med' : 'low', 'Stereo', `Leans ${st.balanceDb > 0 ? 'left' : 'right'} by ${dbAbs(st.balanceDb)}`, 'Balance the panning: move one supporting part to the other side or nudge the master balance.');
    }
    /* Mastering forensics */
    if (a.rumbleDb > -25) add('low', 'Tone', 'Rumble below 20 Hz', 'Energy down there is inaudible on most speakers but eats headroom and makes the limiter work harder. High-pass the master at 25-30 Hz (24 dB/oct).');
    if (a.sampleRate >= 44100 && a.cutoffHz > 8000 && a.cutoffHz < 17500) add(a.cutoffHz < 15500 ? 'med' : 'low', 'Tone', `Top end stops dead at ${hz(a.cutoffHz)}`, 'That brick wall is the mark of an MP3/AAC source or a low-quality sample. Master from the original WAV exports; EQ cannot bring back what the encoder removed.');
    if (master) {
      if (a.limitedRatio > 0.7 && !issues.some((i) => i.area === 'Dynamics')) add('low', 'Dynamics', `Peaks are pinned to the ceiling ${Math.round(a.limitedRatio * 100)}% of the time`, 'The limiter never lets go. Lower its input 1-2 dB, or control the loudest drum hits with a clipper first so the limiter only catches the odd peak.');
      if (a.maxShortTerm - a.lufs > 5) add('low', 'Dynamics', `Loudest section jumps ${dbAbs(a.maxShortTerm - a.lufs)} above the rest`, 'Check the drop or last chorus is not overloading the limiter. Automate that section down 1-2 dB before the limiter rather than letting it crush.');
      if (a.leadSilence > 1) add('low', 'Edit', `${num(a.leadSilence)} s of silence before the music starts`, 'Trim it to about 0.2 s so the song starts when people press play.');
      if (a.tailSilence > 4) add('low', 'Edit', `${num(a.tailSilence)} s of silence at the end`, 'Trim the tail to 1-2 s after the last sound fades.');
      if (a.abruptEnd) add('low', 'Edit', 'Ends abruptly', 'The file stops while the music is still loud. Let the last note and reverb ring out, or add a short fade.');
    }
    if (a.dcOffset > 0.005) add('low', 'Level', 'DC offset', 'The waveform sits off centre, which wastes headroom. Put a 20 Hz high-pass (or a DC-removal tool) on the master.');

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

  M.advice = { songTempo, streamingPreview, masteringPlan, assessMix, stemRecipe, balanceStems, findClashes, findGaps, guessRole, ROLES, format: { hz, db, dbAbs, num } };
})(typeof self !== 'undefined' ? self : globalThis);
