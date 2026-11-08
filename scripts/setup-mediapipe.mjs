// Copies MediaPipe's WASM runtime from node_modules and downloads the gesture + face models into
// client/public/mediapipe so gesture detection works without third-party CDNs at runtime.
// Safe to re-run; failures are non-fatal (the client falls back to the CDN copies).

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const quiet = process.argv.includes('--quiet');
const log = (...args) => !quiet && console.log('[mediapipe]', ...args);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'client', 'public', 'mediapipe');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmOut = path.join(outDir, 'wasm');
const MODELS = [
  {
    file: 'gesture_recognizer.task',
    url: 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task',
    minBytes: 1_000_000,
  },
  {
    file: 'blaze_face_short_range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    minBytes: 100_000,
  },
];

mkdirSync(wasmOut, { recursive: true });

if (existsSync(wasmSrc)) {
  for (const file of readdirSync(wasmSrc)) {
    const src = path.join(wasmSrc, file);
    const dst = path.join(wasmOut, file);
    if (!existsSync(dst) || statSync(dst).size !== statSync(src).size) copyFileSync(src, dst);
  }
  log('WASM runtime ready');
} else {
  console.warn('[mediapipe] @mediapipe/tasks-vision not installed; run npm install');
}

for (const model of MODELS) {
  const out = path.join(outDir, model.file);
  if (existsSync(out) && statSync(out).size >= model.minBytes) {
    log(`${model.file} already present`);
    continue;
  }
  try {
    const res = await fetch(model.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    log(`downloaded ${model.file} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  } catch (err) {
    console.warn(`[mediapipe] could not download ${model.file} (${err.message}); the app will load it from Google's CDN instead.`);
  }
}
