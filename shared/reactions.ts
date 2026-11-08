export type ReactionKind = 'got-it' | 'lets-go' | 'wait-doubt' | 'wow' | 'haha';

/** MediaPipe GestureRecognizer categories, plus poses we detect ourselves (see client/src/gestures/chinPose.ts). */
export type GestureName =
  | 'Thumb_Up'
  | 'Thumb_Down'
  | 'Victory'
  | 'Open_Palm'
  | 'Closed_Fist'
  | 'Pointing_Up'
  | 'ILoveYou'
  | 'Chin_Hands';

export interface ReactionMeta {
  kind: ReactionKind;
  label: string;
  /** Big caption on the meme card. */
  caption: string;
  emoji: string;
  /** Gesture that triggers it. Leave out for a button-only reaction. */
  gesture?: GestureName;
  gestureLabel?: string;
  color: string;
  animation: 'pop' | 'rocket' | 'shake';
  /** Optional image under client/public (e.g. "/memes/got-it.gif"). Shown instead of the emoji when set. */
  image?: string;
  /** Optional video clip under client/public, played with sound for everyone. */
  video?: string;
  /** Poster frame shown while the video loads. */
  poster?: string;
  /** How long the meme stays on screen (default 2800 ms). */
  durationMs?: number;
}

export const DEFAULT_MEME_DURATION_MS = 2800;

export function memeDuration(kind: ReactionKind): number {
  return REACTIONS[kind].durationMs ?? DEFAULT_MEME_DURATION_MS;
}

export const REACTIONS: Record<ReactionKind, ReactionMeta> = {
  'got-it': {
    kind: 'got-it',
    label: 'Got it',
    caption: 'GOT IT',
    emoji: '👍',
    gesture: 'Thumb_Up',
    gestureLabel: 'Thumbs-up',
    color: '#22c55e',
    animation: 'pop',
    video: '/memes/got-it.mp4',
    poster: '/memes/got-it.jpg',
    durationMs: 6600,
  },
  'lets-go': {
    kind: 'lets-go',
    label: "Let's go",
    caption: "LET'S GO",
    emoji: '✌️',
    gesture: 'Victory',
    gestureLabel: 'Victory / peace sign',
    color: '#a855f7',
    animation: 'rocket',
    video: '/memes/lets-go.mp4',
    poster: '/memes/lets-go.jpg',
    durationMs: 7300,
  },
  'wait-doubt': {
    kind: 'wait-doubt',
    label: 'Wait, doubt!',
    caption: 'WAIT, DOUBT!',
    emoji: '✋',
    gesture: 'Open_Palm',
    gestureLabel: 'Open palm',
    color: '#f59e0b',
    animation: 'shake',
    video: '/memes/wait-doubt.mp4',
    poster: '/memes/wait-doubt.jpg',
    durationMs: 6500,
  },
  wow: {
    kind: 'wow',
    label: 'Wow!',
    caption: 'WOW! OH MY GOD',
    emoji: '🤩',
    gesture: 'Chin_Hands',
    gestureLabel: 'Both hands on your chin',
    color: '#06b6d4',
    animation: 'pop',
    video: '/memes/wow.mp4',
    poster: '/memes/wow.jpg',
    durationMs: 4800,
  },
  haha: {
    kind: 'haha',
    label: 'Haha',
    caption: 'HAHAHA',
    emoji: '😹',
    color: '#ec4899',
    animation: 'shake',
    video: '/memes/haha.mp4',
    poster: '/memes/haha.jpg',
    durationMs: 6500,
  },
};

export const REACTION_KINDS = Object.keys(REACTIONS) as ReactionKind[];

export function isReactionKind(value: unknown): value is ReactionKind {
  return typeof value === 'string' && value in REACTIONS;
}

export function reactionForGesture(category: string): ReactionKind | null {
  for (const meta of Object.values(REACTIONS)) if (meta.gesture && meta.gesture === category) return meta.kind;
  return null;
}
