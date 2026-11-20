#!/usr/bin/env node
/**
 * Download the embedding model used by Throughline.
 *
 * The weights (~129 MB) are not committed to the repository. This script
 * fetches them from Hugging Face into service/model/ and verifies their size.
 *
 *   node scripts/fetch-model.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = path.join(HERE, '..', 'service', 'model');
const BASE = 'https://huggingface.co/Xenova/multilingual-e5-small/resolve/main/';

const FILES = [
  { name: 'model_quantized.onnx', url: `${BASE}onnx/model_quantized.onnx`, minBytes: 100 * 1024 * 1024 },
  { name: 'tokenizer.json', url: `${BASE}tokenizer.json`, minBytes: 10 * 1024 * 1024 },
];

async function download(file) {
  const dest = path.join(MODEL_DIR, file.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size >= file.minBytes) {
    console.log(`ok      ${file.name} (already present)`);
    return;
  }
  console.log(`fetch   ${file.name} ...`);
  const res = await fetch(file.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${file.name}: HTTP ${res.status}`);
  const tmp = `${dest}.partial`;
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  const size = fs.statSync(tmp).size;
  if (size < file.minBytes) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`${file.name}: got ${size} bytes, expected at least ${file.minBytes}`);
  }
  fs.renameSync(tmp, dest);
  console.log(`done    ${file.name} (${(size / 1048576).toFixed(1)} MB)`);
}

fs.mkdirSync(MODEL_DIR, { recursive: true });
for (const file of FILES) await download(file);
console.log('\nModel ready. Install dependencies with:');
console.log('  python -m pip install -r service/requirements.txt');
