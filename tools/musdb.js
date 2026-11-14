/* Reading MUSDB18-style *.stem.mp4 files (streams: mixture, drums, bass, other, vocals) with ffmpeg. */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const STREAMS = ['mix', 'drums', 'bass', 'other', 'vocals'];
const FS = 44100;

function decode(file, stream) {
  const out = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-map', `0:${stream}`, '-f', 'f32le', '-ac', '2', '-ar', String(FS), '-'],
    { maxBuffer: 1 << 28 });
  if (out.status !== 0) throw new Error(out.stderr.toString().slice(0, 200));
  const inter = new Float32Array(out.stdout.buffer, out.stdout.byteOffset, Math.floor(out.stdout.length / 4));
  const n = inter.length >> 1;
  const L = new Float32Array(n), R = new Float32Array(n);
  for (let i = 0; i < n; i++) { L[i] = inter[2 * i]; R[i] = inter[2 * i + 1]; }
  return { channels: [L, R], sampleRate: FS };
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.stem.mp4') ? [path.join(dir, e.name)] : []).sort();
}

module.exports = { STREAMS, FS, decode, walk };
