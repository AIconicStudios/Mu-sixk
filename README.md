# Mu-sixk

Free mix feedback for your PC. Drop in audio, and it measures the sound and tells you what to fix and by how much.

Nothing is uploaded. All analysis runs on your computer, in the browser.

![A song being checked: overall percentage and part-by-part grades](shots/1-song-check.png)

## Use it

Download `index.html` and double-click it. It opens in Chrome, Edge or Firefox. There is nothing to install.

| Tab | What you give it | What you get |
|---|---|---|
| **Check a full mix** | One song (WAV, MP3, FLAC, M4A, OGG) | An overall percentage (Good / Decent / Meh / Rough), a grade for each part (vocals, kick and bass, drums, instruments, top end, width, volume), loudness, true peak, punch, stereo and tempo readings, a tonal-balance chart against the style you pick, and a ranked list of fixes with amounts. For a finished master: what each streaming service will do to its volume, plus checks for over-limiting, MP3-sourced audio, rumble, silence and abrupt endings. For an unmastered mix: a mastering chain (EQ moves, bus compression, limiter gain) sized to reach the style's loudness |
| **Build from stems** | The separate tracks (vocal, kick, bass, keys…) | For each track: a health percentage and what is wrong with it (volume against the other tracks, tone, uneven level, harsh "s" sounds, noise, clipping), then a fader move, high-pass, EQ moves, compressor settings, de-esser, saturation %, reverb and delay sends timed to the song's tempo, and pan. Then how the tracks sit together: which ones clash and where, what the arrangement is missing, and a before/after preview of the balance |
| **Find the key** | A song, beat or voice memo, or let it listen through your microphone | The key and its Camelot code, how sure it is, the recording's tuning (A = 440 Hz or not), close alternatives, the notes it heard, the chords that fit (tap to hear them), compatible keys for DJs and key changes over time |
| **Teach it your sound** | A few finished songs you want yours to sit next to | A learned target (tonal balance, loudness, punch) that your mixes are then judged against |

Name stem files after the instrument (`Lead Vocal.wav`, `Kick.wav`, `808.wav`) and the roles are filled in for you. Export every stem from the start of the song so they line up.

## How it works

- **Measurements** are standard: integrated loudness and loudness range per ITU-R BS.1770 / EBU R128, 4x-oversampled true peak, a third-octave spectrum (averaged, silence skipped), mid/side stereo analysis, clipping and DC detection, and tempo from onset autocorrelation.
- **Advice** comes from mixing rules of thumb applied to those measurements. Compression amounts are sized from how uneven the part actually is, reverb and delay times from the detected tempo, fader moves from each stem's measured loudness, and clashes from where two stems are both strong in the same bands.
- **Vocal, drum, bass and instrument levels inside a finished mix** come from a small model trained on real songs. Every MUSDB18 song was remixed 10 ways with each part turned up and down (1,440 mixes), and the model learned to read each part's level from the mix alone, using a centre/sides split and a split into sustained and hit-like sound. Scored only on songs it never trained on, see the accuracy table below.
- **Through the song**: the song is split into sections where its sound changes (letters repeat when sections sound alike), and findings get timestamps you can click to hear: clipping bursts, a section where the tone goes wrong, the vocal dropping in one section, a chorus that doesn't lift.
- **Key** comes from a dedicated key finder (src/key.js): it downsamples to about 22 kHz, takes long FFTs (2.7 Hz detail), picks spectral peaks against a smoothed envelope, measures the tuning from where peaks sit between semitones, builds a pitch-class profile and a separate bass profile, and scores all 24 keys against templates learned from labelled songs. Confidence is calibrated, and scaled down when the sound has no clear notes (drums, noise). The bass, 808 and kick stems are checked against the key with a high-resolution low-end pitch detector, and you are told how many semitones to retune.
- **Reference song**: drop a finished song you like next to yours and get a side-by-side table and the biggest differences, each with a fix.
- **Learning** is statistical, not a neural network. A learned sound is the average spectrum, loudness and dynamics of your reference songs, with tolerances set by how much the references differ from each other. It is saved in the browser and can be copied to another computer as text.

## How accurate the key finder is

Measured on POP909 (909 pop songs as MIDI with key labels, MIT licence), rendered to audio with varied instrument sounds, drums, random detuning up to ±45 cents, noise and reverb. Settings and templates were tuned on the 376 odd-numbered single-key songs and scored on the 381 even-numbered ones it never saw:

| Method | Exact key | MIREX weighted score |
|---|---|---|
| Textbook Krumhansl-Kessler, no tuning or bass handling | 33.9% | 57.8% |
| Best published templates (Albrecht-Shanahan) with this front end | 80.6% | 87.3% |
| **Mu-sixk** | **86.4%** | **90.6%** |

Of the 52 misses, 47 are the relative major/minor key (C major vs A minor: same notes, different home), 4 a neighbouring key a fifth away, 1 other. Tuning is measured to within 1.6 cents (median). When it says 90-100% sure it was right 94% of the time; 70-90% sure, 77%; 50-70% sure, 67%.

Harder conditions, on 120 of the held-out songs:

| Condition | Exact key | Weighted |
|---|---|---|
| 60-second excerpt of the full song | 90.0% | 93.2% |
| Only the first 15 seconds | 72.5% | 81.6% |
| Phone-quality recording (300-3400 Hz) | 89.2% | 92.7% |
| Noisy room (noise 10 dB below the music) | 90.0% | 93.3% |
| Singing only (just the melody line) | 75.0% | 84.1% |
| Chords only (no melody, no drums) | 86.7% | 91.1% |

These songs were rendered by Mu-sixk's own synthesizer from real compositions. That tests the harmony and melody of real music, but not real recorded instruments and voices, so expect somewhat lower accuracy on real recordings. POP909's labels come with the dataset and may contain mistakes of their own.

### Checked on real recordings

Real recordings with known keys (from GitHub-hosted test audio of the librosa and Essentia projects):

| Recording | Labelled | Mu-sixk | Note |
|---|---|---|---|
| Mozart, 30 s excerpt | C major | C major, 95% | |
| Vivaldi, Cello Sonata No. 5, II | E minor | E minor, 88% | |
| Tchaikovsky, Sugar Plum Fairy (Kevin MacLeod) | E minor | E minor, 87% | |
| Tenor sax phrase (MTG) | D minor | D minor, 86% | |
| Tenor sax phrase (MTG) | "E major" | Eb major, 84% | The notes played are Bb, Eb, G, C, D, F and Ab: exactly Eb major, with no E, F# or B. The label does not match the sound. |
| Brahms, Hungarian Dance No. 5, string orchestra | "F# minor" | G minor, 96% | The label is the original piano key. The notes heard (D, G, A, Bb, C, with F# as leading note) are G minor, the key this arrangement is usually played in. |
| Guitar tuned to A = 432 Hz (two files) | 432 Hz | 433.3 and 432.7 Hz | Tuning measured within 5 cents |

It matches the key actually sounding in all six, but only four of the six labels; the two disagreements are explained by the notes in the audio, judged from the measurements rather than by ear.

144 real pop and rock songs from MUSDB18 (7-second excerpts, no key labels exist for them): the full mix gives the same key as the instruments alone (bass plus keys, guitars and synths) in 78% of songs; most of the rest are near misses typical of a short clip (14 a fifth apart, 4 relative, 5 same home note), 9 (6%) unrelated. On 7-second clips it is usually unsure (median confidence 61%); when it says 80% or more, the two agree 93% of the time. A voice alone matched the instruments (or their relative key) in only 39% of these 7-second clips: one sung phrase rarely pins a key down, so sing a whole verse and chorus, or play the chords. Confidence is softened for short clips, fitted on held-out songs; across 7, 15 and 60 second clips, when it says 80-100% it is right 90% of the time, 60-80%: 76%, 40-60%: 50%.

### Singing and other single-note lines

For a voice (or any one-note-at-a-time instrument) the key finder switches to a vocal method automatically: it tracks the sung pitch every 10 ms (YIN), measures the singer's overall tuning, turns the pitch curve into notes while ignoring vibrato and slides into notes, and scores keys from how long each note is held, using melody templates learned from POP909's vocal melodies blended 50/50 with the Essen folk-song melody statistics (POP909 melodies alone are mostly pentatonic and penalised the 4th and 7th that most pop, R&B, gospel and Afrobeats melodies use), plus the spectrum of the same recording. It also reports the singer's range, how close the notes land to true pitch, and how much of the singing falls outside the key, and offers the top keys' chords to sing along to.

| Test | Old method | Vocal method |
|---|---|---|
| Realistic singing of 150 held-out melodies, 15 s | 46% | 56% |
| same, 30 s | 55% | 60% |
| same, 60 s | 63% | 71% |
| Recognised as a single voice (30 s) | | 97% |
| 114 real vocal tracks (MUSDB18, 7-second clips, about 4 s of actual singing each): same key as the instruments | 32% | 29% |
| same, counting relative key or a fifth apart | 68% | 66% |

On the realistic singing benchmark (vibrato, slides, notes up to about 35 cents out, varied vowels, breath, consonants, room noise, male and female range) the vocal method is clearly better. On the real 7-second vocal clips the two are level: a few seconds of melody rarely decides a key for any method. The ceiling, with the notes known perfectly, is 65% at 15 s, 72% at 30 s and 81% at 60 s of melody, because a tune on its own often fits its relative key or a neighbouring one. So sing a whole verse and chorus, and when two keys are close, use the chord buttons: the one your last line resolves onto is the key. Confidence for voices was fitted on the sung benchmark and then softened by half again because it ran high on the real clips; on real 7-second vocals the median confidence is about 40%.

## How accurate the level model is

Measured with 5-fold cross-validation grouped by song (a song's remixes never sit in both training and testing), on 7-second excerpts:

| Part | Error guessing the average | Model error | Change within one song, tracked to | Right direction when it moved 3+ dB |
|---|---|---|---|---|
| Vocals | 2.9 dB | 1.6 dB | ±1.5 dB | 95% |
| Drums | 4.0 dB | 2.1 dB | ±1.7 dB | 98% |
| Bass | 4.2 dB | 2.6 dB | ±2.3 dB | 93% |
| Instruments | 3.0 dB | 2.2 dB | ±1.9 dB | 94% |

It is better at "the vocal got quieter here" than at a verdict on one song, because professional balances differ by a couple of dB from song to song. A part is called "leaning" quiet or loud outside the middle 80% of professional mixes (about 1 in 5 professional mixes get at least one such note per part) and "too" quiet or loud outside the middle 90% (about 1 in 10). It catches roughly a third to a half of parts that are 4.5 dB or more off. On a full song it averages up to 12 separate stretches, which should do better than these single-excerpt figures, but that has not been measured.

## Limits worth knowing

- **What is measured from real music.** The all-round tonal target, its tolerances, the tone ranges for vocals, drums, bass and instruments, and the level of drums, bass and instruments against the vocal come from 144 real, professionally mixed songs and their separate tracks (the MUSDB18 dataset, 7-second excerpts, mostly pop and rock). Run against half of those same songs, the calibrated app scores the median mix 90%. That is a sanity check, not an independent test.
- **What is still a rule of thumb.** The differences between styles (hip-hop, afrobeats, dance…), the loudness targets for masters, and the rules for a kick, snare or hi-hat on its own. The dataset's mixes are not mastered and its drums come as one track. A learned sound built from your own references is still the best target for your style.
- It measures sound, not taste. It can't tell whether the melody is good or the vocal is in tune.
- Tempo can read half or double. Delay and reverb times stay musically related either way.
- Every number is a place to start. Then trust your ears.

## Recalibrate

`src/calibration.js` holds the measured numbers only; no audio from the dataset is in this repository. To regenerate it from a folder of MUSDB18 `*.stem.mp4` files (needs ffmpeg):

```bash
node tools/calibrate.js path/to/musdb18
```

To retrain the level model (src/model.js holds weights only):

```bash
node tools/train-elements.js path/to/musdb18 elements.jsonl
```

```bash
python3 tools/train_elements.py elements.jsonl
```

To rebuild the key templates (src/keyprofiles.js) from a clone of github.com/music-x-lab/POP909-Dataset:

```bash
node tools/keybench.js features path/to/POP909-Dataset keyfeat.jsonl
```

```bash
node tools/keybench.js evaluate keyfeat.jsonl --write --cfg h1-lin --blend albrecht:0.8
```

Vocal templates and their confidence (same POP909 clone):

```bash
node tools/vocalbench.js learn path/to/POP909-Dataset --write
```

```bash
node tools/vocalbench.js calibrate path/to/POP909-Dataset
```

MUSDB18 is licensed for non-commercial research and education. Check its terms before using the audio for anything else.

## Develop

```bash
npm test
```

```bash
npm run build
```

Source lives in `src/`; `build.js` bundles it into the single `index.html`. The analysis code (`dsp.js`, `analyze.js`, `profiles.js`, `advice.js`) has no browser dependencies, so the tests run in plain Node 22+ with no packages to install.
