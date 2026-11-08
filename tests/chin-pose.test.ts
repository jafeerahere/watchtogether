import { describe, expect, it } from 'vitest';
import { detectChinHands, type FaceInfo, type Pt } from '../client/src/gestures/chinPose';
import { GestureDetector } from '../client/src/gestures/detector';

const ASPECT = 4 / 3;

/** A face centred at x=0.5 in a 4:3 frame; eyes y=0.35, nose 0.42, mouth 0.48 → chin ≈ 0.55. */
function face(tilt = 0): FaceInfo {
  const rot = (p: Pt): Pt => {
    // rotate around the nose to simulate a tilted head
    const cx = 0.5, cy = 0.42;
    const dx = (p.x - cx) * ASPECT, dy = p.y - cy;
    const c = Math.cos(tilt), s = Math.sin(tilt);
    return { x: cx + (dx * c - dy * s) / ASPECT, y: cy + dx * s + dy * c };
  };
  return {
    box: { x: 0.38, y: 0.25, w: 0.24, h: 0.34 },
    keypoints: [
      { x: 0.46, y: 0.35 }, { x: 0.54, y: 0.35 }, { x: 0.5, y: 0.42 }, { x: 0.5, y: 0.48 }, { x: 0.39, y: 0.4 }, { x: 0.61, y: 0.4 },
    ].map(rot),
  };
}

/** 21 landmarks clustered around a point, with the fingertips pointing toward `toward`. */
function hand(at: Pt, toward: Pt = at): Pt[] {
  return Array.from({ length: 21 }, (_, i) => {
    const t = i / 20;
    return { x: at.x + (toward.x - at.x) * t, y: at.y + (toward.y - at.y) * t };
  });
}

const CHIN = { x: 0.5, y: 0.55 };

describe('detectChinHands (wow pose)', () => {
  it('detects both hands cupping the chin from left and right', () => {
    const left = hand({ x: 0.36, y: 0.66 }, { x: 0.46, y: 0.56 });
    const right = hand({ x: 0.64, y: 0.66 }, { x: 0.54, y: 0.56 });
    expect(detectChinHands([left, right], face(), ASPECT)).toEqual({ onChin: true, handsAtFace: true });
  });

  it('works with the head tilted', () => {
    const f = face(0.25);
    const left = hand({ x: 0.33, y: 0.68 }, { x: 0.43, y: 0.6 });
    const right = hand({ x: 0.6, y: 0.7 }, { x: 0.5, y: 0.61 });
    expect(detectChinHands([left, right], f, ASPECT).onChin).toBe(true);
  });

  it('needs two hands', () => {
    expect(detectChinHands([hand({ x: 0.46, y: 0.6 }, CHIN)], face(), ASPECT).onChin).toBe(false);
  });

  it('needs a face', () => {
    const left = hand({ x: 0.36, y: 0.66 }, CHIN);
    const right = hand({ x: 0.64, y: 0.66 }, CHIN);
    expect(detectChinHands([left, right], null, ASPECT)).toEqual({ onChin: false, handsAtFace: false });
  });

  it('ignores hands far from the chin (e.g. two palms raised at the sides)', () => {
    const left = hand({ x: 0.1, y: 0.4 }, { x: 0.12, y: 0.2 });
    const right = hand({ x: 0.9, y: 0.4 }, { x: 0.88, y: 0.2 });
    expect(detectChinHands([left, right], face(), ASPECT)).toEqual({ onChin: false, handsAtFace: false });
  });

  it('ignores hands on the forehead', () => {
    const left = hand({ x: 0.42, y: 0.22 }, { x: 0.48, y: 0.28 });
    const right = hand({ x: 0.58, y: 0.22 }, { x: 0.52, y: 0.28 });
    expect(detectChinHands([left, right], face(), ASPECT).onChin).toBe(false);
  });

  it('ignores the tracker reporting the same hand twice', () => {
    const h = hand({ x: 0.45, y: 0.65 }, CHIN);
    expect(detectChinHands([h, h.map((p) => ({ x: p.x + 0.005, y: p.y }))], face(), ASPECT).onChin).toBe(false);
  });

  it('flags hands near the face (so open palms there are not read as "Wait, doubt!")', () => {
    const left = hand({ x: 0.3, y: 0.5 }, { x: 0.33, y: 0.4 });
    const right = hand({ x: 0.7, y: 0.5 }, { x: 0.67, y: 0.4 });
    expect(detectChinHands([left, right], face(), ASPECT)).toEqual({ onChin: false, handsAtFace: true });
  });
});

describe('GestureDetector with the chin pose', () => {
  it('maps Chin_Hands to the wow reaction after the hold', () => {
    const d = new GestureDetector();
    let fired = null;
    for (let t = 0; t <= 800 && !fired; t += 80) fired = d.update('Chin_Hands', 1, t).fired;
    expect(fired).toBe('wow');
  });
});
