#!/usr/bin/env node
/* Bundles src/ into one self-contained index.html that runs by double-clicking it.
   Pass an output path as the second argument with --fragment to emit a head-less page body. */
'use strict';
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');

const scripts = ['dsp.js', 'analyze.js', 'features.js', 'model.js', 'elements.js', 'music.js', 'timeline.js', 'calibration.js', 'profiles.js', 'advice.js', 'demo.js', 'app.js']
  .map((f) => `<script>\n${read(f).replace(/<\/script/gi, '<\\/script')}</script>`).join('\n');
const head = [
  '<title>Mu-sixk</title>',
  '<meta name="claude:viewport-fit-sides" content="cover">',
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Space+Grotesk:wght@500;600;700&display=swap">',
  `<style>\n${read('styles.css')}</style>`,
].join('\n');
const body = `${read('page.html')}\n${scripts}\n`;

const fragment = process.argv.includes('--fragment');
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) || path.join(__dirname, 'index.html');
const page = fragment
  ? `${head}\n${body}`
  : `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n${head}\n</head>\n<body>\n${body}</body>\n</html>\n`;
fs.writeFileSync(out, page);
console.log(`Wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);
