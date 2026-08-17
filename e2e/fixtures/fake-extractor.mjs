#!/usr/bin/env node

import fs from 'node:fs';

const [mode, source, output] = process.argv.slice(2);
if (mode !== 'ocr' || !source || !output) {
  process.stderr.write('usage: fake-extractor.mjs ocr <image> <out-note>\n');
  process.exit(2);
}
if (!fs.statSync(source).isFile()) {
  process.stderr.write(`source is not a file: ${source}\n`);
  process.exit(2);
}

const text = process.env.STASHBASE_FAKE_OCR_TEXT?.trim();
if (!text) {
  process.stderr.write('STASHBASE_FAKE_OCR_TEXT is required\n');
  process.exit(2);
}

fs.writeFileSync(
  output,
  `${text}\n\n<!-- stashbase-ocr-conversion: complete -->\n`,
  'utf8',
);
