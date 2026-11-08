// Turns noisy per-frame gesture labels into deliberate reactions:
//  - hold:     the same gesture must be seen continuously for `holdMs` before it fires
//  - flicker:  short dropouts (< `graceMs`) don't reset the hold (the recognizer blinks between frames)
//  - cooldown: after firing, nothing fires for `cooldownMs`
//  - release:  the same gesture can't fire again until the hand drops it (no repeat-firing while held)

import { reactionForGesture, type ReactionKind } from '../../../shared/reactions';

export interface DetectorOptions {
  holdMs: number;
  cooldownMs: number;
  graceMs: number;
  minScore: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
  holdMs: 700,
  cooldownMs: 3000,
  graceMs: 250,
  minScore: 0.6,
};

export interface DetectorOutput {
  /** Gesture currently being held and how far along the hold is (0..1). */
  holding: { kind: ReactionKind; progress: number } | null;
  /** Set on the frame a reaction should be sent. */
  fired: ReactionKind | null;
  coolingDown: boolean;
}

export class GestureDetector {
  private current: ReactionKind | null = null;
  private since = 0;
  private lastSeen = 0;
  private cooldownUntil = 0;
  private mustRelease: ReactionKind | null = null;

  constructor(private readonly opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS) {}

  /** Start a cooldown from outside (e.g. a manual button was pressed). */
  startCooldown(now: number) {
    this.cooldownUntil = now + this.opts.cooldownMs;
  }

  update(category: string | null, score: number, now: number): DetectorOutput {
    const kind = category && score >= this.opts.minScore ? reactionForGesture(category) : null;

    if (kind !== this.mustRelease && (kind !== null || now - this.lastSeen > this.opts.graceMs)) {
      // The hand let go of (or changed) the gesture that last fired.
      this.mustRelease = null;
    }

    if (kind) {
      if (kind !== this.current) {
        this.current = kind;
        this.since = now;
      }
      this.lastSeen = now;
    } else if (this.current && now - this.lastSeen > this.opts.graceMs) {
      this.current = null;
    }

    const coolingDown = now < this.cooldownUntil;
    if (!this.current || this.current === this.mustRelease) {
      return { holding: null, fired: null, coolingDown };
    }
    const progress = Math.min(1, (now - this.since) / this.opts.holdMs);
    if (progress >= 1 && !coolingDown) {
      const fired = this.current;
      this.cooldownUntil = now + this.opts.cooldownMs;
      this.mustRelease = fired;
      this.current = null;
      return { holding: null, fired, coolingDown: true };
    }
    return { holding: coolingDown ? null : { kind: this.current, progress }, fired: null, coolingDown };
  }
}
