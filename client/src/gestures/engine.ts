// Runs MediaPipe on the local camera, entirely on-device:
//   GestureRecognizer (2 hands) → thumbs-up / victory / open palm + hand landmarks
//   FaceDetector (BlazeFace)     → where the chin is, for the "both hands on chin" wow pose
// Only the resulting reaction kind is ever sent to the room; frames never leave this browser.

import type { FaceDetector, GestureRecognizer } from '@mediapipe/tasks-vision';
import { detectChinHands, type FaceInfo } from './chinPose';

const LOCAL_WASM = '/mediapipe/wasm';
const LOCAL_GESTURE_MODEL = '/mediapipe/gesture_recognizer.task';
const LOCAL_FACE_MODEL = '/mediapipe/blaze_face_short_range.tflite';
const CDN_WASM = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${__MEDIAPIPE_VERSION__}/wasm`;
const CDN_GESTURE_MODEL = 'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const CDN_FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite';

export interface Models {
  recognizer: GestureRecognizer;
  /** Null if the face model couldn't load: the chin pose is then unavailable, other gestures still work. */
  faceDetector: FaceDetector | null;
}

let modelsPromise: Promise<Models> | null = null;

async function exists(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    // Vite's dev server answers unknown paths with index.html, so check the content type too.
    return res.ok && !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return false;
  }
}

async function withGpuFallback<T>(make: (delegate: 'GPU' | 'CPU') => Promise<T>, what: string): Promise<T> {
  try {
    return await make('GPU');
  } catch (err) {
    console.warn(`[gestures] GPU delegate unavailable for ${what}, using CPU`, err);
    return make('CPU');
  }
}

async function createModels(): Promise<Models> {
  const { FilesetResolver, GestureRecognizer, FaceDetector } = await import('@mediapipe/tasks-vision');
  const [localWasm, localGesture, localFace] = await Promise.all([
    exists(`${LOCAL_WASM}/vision_wasm_internal.wasm`),
    exists(LOCAL_GESTURE_MODEL),
    exists(LOCAL_FACE_MODEL),
  ]);
  const fileset = await FilesetResolver.forVisionTasks(localWasm ? LOCAL_WASM : CDN_WASM);

  const recognizer = await withGpuFallback(
    (delegate) =>
      GestureRecognizer.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: localGesture ? LOCAL_GESTURE_MODEL : CDN_GESTURE_MODEL, delegate },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.5,
        minHandPresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      }),
    'gestures',
  );

  let faceDetector: FaceDetector | null = null;
  try {
    faceDetector = await withGpuFallback(
      (delegate) =>
        FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: localFace ? LOCAL_FACE_MODEL : CDN_FACE_MODEL, delegate },
          runningMode: 'VIDEO',
          minDetectionConfidence: 0.5,
        }),
      'face',
    );
  } catch (err) {
    console.warn('[gestures] face detector unavailable; the chin pose is disabled', err);
  }
  return { recognizer, faceDetector };
}

export function loadModels(): Promise<Models> {
  modelsPromise ??= createModels().catch((err) => {
    modelsPromise = null;
    throw err;
  });
  return modelsPromise;
}

export interface FrameResult {
  /** Built-in category name, or 'Chin_Hands' for our custom pose; null when nothing is shown. */
  category: string | null;
  score: number;
  hands: number;
  face: boolean;
}

/** Calls `onFrame` ~12 times per second with the gesture in view. Returns a stop function. */
export function runRecognition(models: Models, video: HTMLVideoElement, onFrame: (result: FrameResult, now: number) => void, fps = 12): () => void {
  let stopped = false;
  let lastRun = 0;
  let lastVideoTime = -1;
  const interval = 1000 / fps;

  const analyze = (now: number): FrameResult => {
    const result = models.recognizer.recognizeForVideo(video, now);
    const hands = result.landmarks ?? [];

    let face: FaceInfo | null = null;
    if (models.faceDetector && hands.length >= 2) {
      // Face detection only matters for the two-handed pose; skip it otherwise to save CPU.
      const det = models.faceDetector.detectForVideo(video, now).detections[0];
      if (det?.boundingBox && det.keypoints.length >= 4) {
        const w = video.videoWidth || 1;
        const h = video.videoHeight || 1;
        const bb = det.boundingBox;
        face = {
          box: { x: bb.originX / w, y: bb.originY / h, w: bb.width / w, h: bb.height / h },
          keypoints: det.keypoints.map((k) => ({ x: k.x, y: k.y })),
        };
      }
    }

    const aspect = (video.videoWidth || 4) / (video.videoHeight || 3);
    const chin = detectChinHands(hands, face, aspect);
    if (chin.onChin) return { category: 'Chin_Hands', score: 1, hands: hands.length, face: !!face };
    // Two hands around the face (even if not quite on the chin): don't let them read as "open palm".
    if (chin.handsAtFace) return { category: null, score: 0, hands: hands.length, face: !!face };

    // Otherwise the most confident built-in gesture across the visible hands.
    let best: { name: string; score: number } | null = null;
    for (const perHand of result.gestures ?? []) {
      const top = perHand[0];
      if (top && top.categoryName !== 'None' && (!best || top.score > best.score)) best = { name: top.categoryName, score: top.score };
    }
    return { category: best?.name ?? null, score: best?.score ?? 0, hands: hands.length, face: !!face };
  };

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    if (now - lastRun >= interval && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
      lastRun = now;
      lastVideoTime = video.currentTime;
      try {
        onFrame(analyze(now), now);
      } catch (err) {
        console.warn('[gestures] recognition failed', err);
      }
    }
    // rAF pauses in background tabs; a timeout keeps detection alive at a lower rate there.
    if (document.hidden) setTimeout(tick, interval);
    else requestAnimationFrame(tick);
  };
  tick();
  return () => {
    stopped = true;
  };
}
