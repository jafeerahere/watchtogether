// Wire protocol shared by the Node server and the React client.
// Room state is small (≤ 4 people), so the server broadcasts the whole RoomState on every change.

import type { MediaSourceInfo } from './links';
import type { ReactionKind } from './reactions';

export const MAX_PARTICIPANTS = 4;
export const MAX_NAME_LENGTH = 32;
/** How long a disconnected host keeps the host role (covers page refreshes and brief network drops). */
export const HOST_GRACE_MS = 20_000;
/** Server-side floor between two reactions from the same person (clients use a longer cooldown). */
export const SERVER_REACTION_MIN_INTERVAL_MS = 1_000;

export type RoomMode = 'idle' | 'link' | 'share';

export interface Participant {
  /** Socket id: changes on reconnect. Used as the WebRTC peer id. */
  id: string;
  name: string;
  joinedAt: number;
  mic: boolean;
  /** Camera is on and gesture detection is running locally. Video never leaves the device. */
  gestures: boolean;
  /** Set when this person's player can't play the current link (shown to the host). */
  playbackIssue: string | null;
}

/** Shared playback timeline, stamped with server time so late joiners can compute the live position. */
export interface LinkPlayback {
  url: string;
  source: MediaSourceInfo;
  playing: boolean;
  /** Position in seconds at `updatedAt`. */
  position: number;
  rate: number;
  /** Server clock (ms since epoch) when `position` was recorded. */
  updatedAt: number;
}

export interface ShareInfo {
  sharerId: string;
  hasAudio: boolean;
  /** `displaySurface` reported by the browser: 'browser' (tab), 'window', 'monitor', or null if unknown. */
  surface: string | null;
  startedAt: number;
}

export interface RoomState {
  id: string;
  hostId: string | null;
  participants: Participant[];
  mode: RoomMode;
  link: LinkPlayback | null;
  share: ShareInfo | null;
}

export interface ReactionEvent {
  id: string;
  fromId: string;
  fromName: string;
  kind: ReactionKind;
  via: 'gesture' | 'button';
  at: number;
}

export type SignalChannel = 'voice' | 'screen';

// Structural copies of the DOM WebRTC types, so this file also compiles on the server (no DOM lib).
export interface SessionDescription {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}
export interface IceCandidate {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface SignalPayload {
  description?: SessionDescription;
  candidate?: IceCandidate;
}

export interface IceConfig {
  iceServers: IceServer[];
  iceTransportPolicy: 'all' | 'relay';
}

export type JoinError = 'not-found' | 'full' | 'bad-request';

export type JoinResponse =
  | { ok: true; selfId: string; state: RoomState; ice: IceConfig }
  | { ok: false; error: JoinError };

export type Ack = { ok: true } | { ok: false; error: string };

export interface ServerToClientEvents {
  'room:state': (state: RoomState) => void;
  reaction: (reaction: ReactionEvent) => void;
  signal: (msg: { from: string; channel: SignalChannel; data: SignalPayload }) => void;
  notice: (notice: { text: string; tone?: 'info' | 'warn' }) => void;
  /** This socket was replaced by a newer connection from the same tab identity. */
  'room:kicked': (reason: string) => void;
}

export interface ClientToServerEvents {
  'room:join': (req: { roomId: string; clientId: string; name: string }, ack: (res: JoinResponse) => void) => void;
  'room:leave': () => void;
  'profile:update': (patch: { name?: string; mic?: boolean; gestures?: boolean; playbackIssue?: string | null }) => void;
  'host:transfer': (toId: string) => void;
  'share:start': (info: { hasAudio: boolean; surface: string | null }, ack: (res: Ack) => void) => void;
  'share:update': (info: { hasAudio: boolean }) => void;
  'share:stop': () => void;
  'link:set': (req: { url: string; forceFile?: boolean }, ack: (res: Ack) => void) => void;
  'link:control': (ctl: { playing: boolean; position: number; rate?: number }) => void;
  'link:clear': () => void;
  'reaction:send': (r: { kind: ReactionKind; via: 'gesture' | 'button' }) => void;
  signal: (msg: { to: string; channel: SignalChannel; data: SignalPayload }) => void;
  'time:sync': (ack: (serverNow: number) => void) => void;
}

/** Live position of a shared timeline at `serverNow`. */
export function expectedPosition(link: Pick<LinkPlayback, 'playing' | 'position' | 'rate' | 'updatedAt'>, serverNow: number): number {
  if (!link.playing) return link.position;
  return link.position + (Math.max(0, serverNow - link.updatedAt) / 1000) * link.rate;
}

const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function isValidRoomId(id: string): boolean {
  return /^[a-hj-km-np-z2-9]{3}-[a-hj-km-np-z2-9]{4}-[a-hj-km-np-z2-9]{3}$/.test(id);
}

export function randomRoomId(randomInt: (max: number) => number): string {
  const pick = (n: number) => Array.from({ length: n }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : null;
}
