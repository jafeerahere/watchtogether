// "Both hands on your chin" (the wow pose) isn't one of MediaPipe's built-in gestures, so we detect it
// geometrically from hand landmarks + a face detection. Pure functions, unit-tested in tests/.
//
// Coordinates are MediaPipe's normalized image coords (0..1, y down). Distances are measured after
// scaling x by the frame's aspect ratio so they're in consistent units.

export interface Pt {
  x: number;
  y: number;
}

export interface FaceInfo {
  /** Normalized bounding box. */
  box: { x: number; y: number; w: number; h: number };
  /** BlazeFace keypoints: 0 right eye, 1 left eye, 2 nose tip, 3 mouth, 4 right ear, 5 left ear. */
  keypoints: Pt[];
}

/** Hand landmarks that can rest on a chin: wrist, thumb, finger bases and tips. */
const CONTACT_POINTS = [0, 2, 3, 4, 5, 6, 8, 9, 10, 12, 13, 16, 17, 20];

export interface ChinOptions {
  /** A hand counts as "on the chin" if a contact point is within this × face width of the chin. */
  reach: number;
  /** Looser radius used to decide both hands are around the face at all. */
  nearFace: number;
}

export const DEFAULT_CHIN_OPTIONS: ChinOptions = { reach: 0.7, nearFace: 1.4 };

export function chinGeometry(face: FaceInfo, aspect: number) {
  const [rEye, lEye, , mouth] = face.keypoints;
  const eyeMid = { x: (rEye.x + lEye.x) / 2, y: (rEye.y + lEye.y) / 2 };
  // The chin sits roughly 0.55 × (eyes→mouth) below the mouth, along the same axis (handles head tilt).
  const chin = { x: mouth.x + (mouth.x - eyeMid.x) * 0.55, y: mouth.y + (mouth.y - eyeMid.y) * 0.55 };
  const faceW = face.box.w * aspect;
  return { chin, eyeMid, faceW };
}

function dist(a: Pt, b: Pt, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y);
}

function centroid(hand: Pt[]): Pt {
  const n = hand.length || 1;
  return { x: hand.reduce((s, p) => s + p.x, 0) / n, y: hand.reduce((s, p) => s + p.y, 0) / n };
}

function minDistance(hand: Pt[], target: Pt, aspect: number): number {
  let best = Infinity;
  for (const i of CONTACT_POINTS) if (hand[i]) best = Math.min(best, dist(hand[i], target, aspect));
  return best;
}

export interface ChinResult {
  /** Both hands are resting on the chin. */
  onChin: boolean;
  /** Both hands are around the face: built-in gestures (e.g. open palm) shouldn't fire. */
  handsAtFace: boolean;
}

export function detectChinHands(hands: Pt[][], face: FaceInfo | null, aspect: number, opts: ChinOptions = DEFAULT_CHIN_OPTIONS): ChinResult {
  if (!face || face.keypoints.length < 4 || hands.length < 2) return { onChin: false, handsAtFace: false };
  const { chin, eyeMid, faceW } = chinGeometry(face, aspect);
  const [a, b] = hands;
  const da = minDistance(a, chin, aspect);
  const db = minDistance(b, chin, aspect);
  const handsAtFace = da < faceW * opts.nearFace && db < faceW * opts.nearFace;

  const ca = centroid(a);
  const cb = centroid(b);
  // Two genuinely different hands (the tracker occasionally reports one hand twice)…
  const distinct = dist(ca, cb, aspect) > faceW * 0.25;
  // …held at or below the eyes (not hands on the forehead or behind the head).
  const belowEyes = ca.y > eyeMid.y && cb.y > eyeMid.y;
  const onChin = distinct && belowEyes && da < faceW * opts.reach && db < faceW * opts.reach;
  return { onChin, handsAtFace };
}
