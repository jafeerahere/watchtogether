// Room state machine. No Socket.IO here: the socket layer (index.ts) calls these methods
// and broadcasts `toState()` whenever `onChange` fires. That keeps the rules unit-testable.

import { randomInt, randomUUID } from 'node:crypto';
import { checkMediaLink, forceFileSource, type MediaSourceInfo } from '../shared/links';
import {
  CHAT_BURST,
  CHAT_HISTORY_LIMIT,
  CHAT_WINDOW_MS,
  HOST_GRACE_MS,
  MAX_PARTICIPANTS,
  SERVER_REACTION_MIN_INTERVAL_MS,
  cleanChatText,
  cleanName,
  expectedPosition,
  randomRoomId,
  type Ack,
  type ChatMessage,
  type JoinError,
  type LinkPlayback,
  type Participant,
  type RoomMode,
  type RoomState,
  type ShareInfo,
} from '../shared/protocol';

interface Member extends Participant {
  clientId: string;
  lastReactionAt: number;
  /** Timestamps of recent chat messages, for the rate limit. */
  chatTimes: number[];
}

export interface Room {
  id: string;
  createdAt: number;
  /** Stable per-tab identity of the host; survives refreshes, unlike socket ids. */
  hostClientId: string | null;
  hostGraceTimer: ReturnType<typeof setTimeout> | null;
  emptyTimer: ReturnType<typeof setTimeout> | null;
  members: Map<string, Member>;
  mode: RoomMode;
  link: LinkPlayback | null;
  share: ShareInfo | null;
  /** Recent chat, oldest first, capped at CHAT_HISTORY_LIMIT. */
  chat: ChatMessage[];
  /** Pending "X left" notices by clientId, cancelled if that tab comes straight back (refresh). */
  leaveNotices: Map<string, ReturnType<typeof setTimeout>>;
}

export interface RoomStoreOptions {
  onChange: (roomId: string) => void;
  /** Called for every new chat message (user or system) so the socket layer can broadcast it. */
  onChat?: (roomId: string, message: ChatMessage) => void;
  now?: () => number;
  hostGraceMs?: number;
  /** How long an empty room is kept before it's deleted. */
  emptyRoomTtlMs?: number;
  /** Delay before announcing that someone left (a refresh within it stays silent). */
  leaveNoticeDelayMs?: number;
}

export type JoinResult =
  | { ok: true; room: Room; replacedSocketId: string | null }
  | { ok: false; error: JoinError };

export class RoomStore {
  readonly rooms = new Map<string, Room>();
  private readonly socketRoom = new Map<string, string>();
  private readonly now: () => number;
  private readonly hostGraceMs: number;
  private readonly emptyRoomTtlMs: number;
  private readonly leaveNoticeDelayMs: number;

  constructor(private readonly opts: RoomStoreOptions) {
    this.now = opts.now ?? Date.now;
    this.hostGraceMs = opts.hostGraceMs ?? HOST_GRACE_MS;
    this.emptyRoomTtlMs = opts.emptyRoomTtlMs ?? 30 * 60_000;
    this.leaveNoticeDelayMs = opts.leaveNoticeDelayMs ?? 8_000;
  }

  create(hostClientId: string): Room {
    let id = randomRoomId(randomInt);
    while (this.rooms.has(id)) id = randomRoomId(randomInt);
    const room: Room = {
      id,
      createdAt: this.now(),
      hostClientId,
      hostGraceTimer: null,
      emptyTimer: null,
      members: new Map(),
      mode: 'idle',
      link: null,
      share: null,
      chat: [],
      leaveNotices: new Map(),
    };
    this.rooms.set(id, room);
    this.scheduleEmptyCleanup(room);
    return room;
  }

  roomOf(socketId: string): Room | undefined {
    const id = this.socketRoom.get(socketId);
    return id ? this.rooms.get(id) : undefined;
  }

  hostId(room: Room): string | null {
    for (const m of room.members.values()) if (m.clientId === room.hostClientId) return m.id;
    return null;
  }

  isHost(socketId: string): boolean {
    const room = this.roomOf(socketId);
    return !!room && this.hostId(room) === socketId;
  }

  join(roomId: string, socketId: string, clientId: string, rawName: string): JoinResult {
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, error: 'not-found' };
    const name = cleanName(rawName);
    if (!name || typeof clientId !== 'string' || clientId.length < 8 || clientId.length > 64) {
      return { ok: false, error: 'bad-request' };
    }

    // Same tab reconnecting (refresh, network blip): replace its previous socket.
    let replacedSocketId: string | null = null;
    for (const m of room.members.values()) {
      if (m.clientId === clientId) {
        replacedSocketId = m.id;
        this.removeMember(room, m.id);
        break;
      }
    }
    if (room.members.size >= MAX_PARTICIPANTS) return { ok: false, error: 'full' };

    room.members.set(socketId, {
      id: socketId,
      clientId,
      name,
      joinedAt: this.now(),
      mic: false,
      gestures: false,
      playbackIssue: null,
      lastReactionAt: 0,
      chatTimes: [],
    });
    this.socketRoom.set(socketId, roomId);

    // Announce new arrivals, but stay quiet when a tab simply refreshed or reconnected.
    const pendingLeave = room.leaveNotices.get(clientId);
    if (pendingLeave) {
      clearTimeout(pendingLeave);
      room.leaveNotices.delete(clientId);
    } else if (!replacedSocketId) {
      this.postSystem(room, `${name} joined`);
    }

    if (room.emptyTimer) {
      clearTimeout(room.emptyTimer);
      room.emptyTimer = null;
    }
    if (room.hostClientId === null) room.hostClientId = clientId;
    if (room.hostClientId === clientId && room.hostGraceTimer) {
      clearTimeout(room.hostGraceTimer);
      room.hostGraceTimer = null;
    }
    return { ok: true, room, replacedSocketId };
  }

  leave(socketId: string): Room | undefined {
    const room = this.roomOf(socketId);
    if (!room) return undefined;
    const member = room.members.get(socketId);
    this.removeMember(room, socketId);
    if (member) this.scheduleLeaveNotice(room, member);
    return room;
  }

  private scheduleLeaveNotice(room: Room, member: Member) {
    const existing = room.leaveNotices.get(member.clientId);
    if (existing) clearTimeout(existing);
    room.leaveNotices.set(
      member.clientId,
      setTimeout(() => {
        room.leaveNotices.delete(member.clientId);
        const back = [...room.members.values()].some((m) => m.clientId === member.clientId);
        if (!back && this.rooms.has(room.id)) this.postSystem(room, `${member.name} left`);
      }, this.leaveNoticeDelayMs),
    );
  }

  // --- Chat -----------------------------------------------------------------------------------

  private post(room: Room, message: ChatMessage) {
    room.chat.push(message);
    if (room.chat.length > CHAT_HISTORY_LIMIT) room.chat.splice(0, room.chat.length - CHAT_HISTORY_LIMIT);
    this.opts.onChat?.(room.id, message);
  }

  private postSystem(room: Room, text: string) {
    this.post(room, { id: randomUUID(), kind: 'system', fromId: null, fromName: null, text, at: this.now() });
  }

  sendChat(socketId: string, raw: unknown): Ack {
    const room = this.roomOf(socketId);
    const member = room?.members.get(socketId);
    if (!room || !member) return { ok: false, error: 'Not in a room.' };
    const text = cleanChatText(raw);
    if (!text) return { ok: false, error: 'Message is empty.' };
    const now = this.now();
    member.chatTimes = member.chatTimes.filter((t) => now - t < CHAT_WINDOW_MS);
    if (member.chatTimes.length >= CHAT_BURST) return { ok: false, error: "You're sending messages too fast. Wait a moment." };
    member.chatTimes.push(now);
    this.post(room, { id: randomUUID(), kind: 'user', fromId: socketId, fromName: member.name, text, at: now });
    return { ok: true };
  }

  chatHistory(room: Room): ChatMessage[] {
    return room.chat.slice();
  }

  private removeMember(room: Room, socketId: string) {
    const member = room.members.get(socketId);
    if (!member) return;
    room.members.delete(socketId);
    this.socketRoom.delete(socketId);

    if (room.share?.sharerId === socketId) {
      room.share = null;
      if (room.mode === 'share') room.mode = 'idle';
    }
    if (member.clientId === room.hostClientId) this.startHostGrace(room);
    if (room.members.size === 0) this.scheduleEmptyCleanup(room);
  }

  private startHostGrace(room: Room) {
    if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = setTimeout(() => {
      room.hostGraceTimer = null;
      if (this.hostId(room)) return; // host came back
      const next = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.hostClientId = next ? next.clientId : null;
      this.opts.onChange(room.id);
    }, this.hostGraceMs);
  }

  private scheduleEmptyCleanup(room: Room) {
    if (room.emptyTimer) clearTimeout(room.emptyTimer);
    room.emptyTimer = setTimeout(() => {
      if (room.members.size > 0) return;
      if (room.hostGraceTimer) clearTimeout(room.hostGraceTimer);
      for (const t of room.leaveNotices.values()) clearTimeout(t);
      this.rooms.delete(room.id);
    }, this.emptyRoomTtlMs);
  }

  updateProfile(socketId: string, patch: { name?: unknown; mic?: unknown; gestures?: unknown; playbackIssue?: unknown }): Room | undefined {
    const room = this.roomOf(socketId);
    const m = room?.members.get(socketId);
    if (!room || !m) return undefined;
    if (patch.name !== undefined) {
      const name = cleanName(patch.name);
      if (name) m.name = name;
    }
    if (typeof patch.mic === 'boolean') m.mic = patch.mic;
    if (typeof patch.gestures === 'boolean') m.gestures = patch.gestures;
    if (patch.playbackIssue === null) m.playbackIssue = null;
    else if (typeof patch.playbackIssue === 'string') m.playbackIssue = patch.playbackIssue.slice(0, 300);
    return room;
  }

  transferHost(socketId: string, toId: string): Room | undefined {
    const room = this.roomOf(socketId);
    if (!room || this.hostId(room) !== socketId) return undefined;
    const target = room.members.get(toId);
    if (!target || toId === socketId) return undefined;
    room.hostClientId = target.clientId;
    // The old host's screen share stops: only the host shares.
    if (room.share?.sharerId === socketId) {
      room.share = null;
      room.mode = 'idle';
    }
    return room;
  }

  startShare(socketId: string, info: { hasAudio?: unknown; surface?: unknown }): Ack {
    const room = this.roomOf(socketId);
    if (!room) return { ok: false, error: 'Not in a room.' };
    if (this.hostId(room) !== socketId) return { ok: false, error: 'Only the host can share.' };
    room.share = {
      sharerId: socketId,
      hasAudio: info.hasAudio === true,
      surface: typeof info.surface === 'string' ? info.surface.slice(0, 20) : null,
      startedAt: this.now(),
    };
    room.mode = 'share';
    room.link = null;
    this.clearIssues(room);
    return { ok: true };
  }

  updateShare(socketId: string, info: { hasAudio?: unknown }): Room | undefined {
    const room = this.roomOf(socketId);
    if (!room || room.share?.sharerId !== socketId) return undefined;
    room.share.hasAudio = info.hasAudio === true;
    return room;
  }

  stopShare(socketId: string): Room | undefined {
    const room = this.roomOf(socketId);
    if (!room || room.share?.sharerId !== socketId) return undefined;
    room.share = null;
    room.mode = 'idle';
    return room;
  }

  setLink(socketId: string, req: { url?: unknown; forceFile?: unknown }): Ack {
    const room = this.roomOf(socketId);
    if (!room) return { ok: false, error: 'Not in a room.' };
    if (this.hostId(room) !== socketId) return { ok: false, error: 'Only the host can choose what plays.' };
    if (typeof req.url !== 'string' || req.url.length > 2048) return { ok: false, error: 'Invalid link.' };

    let source: MediaSourceInfo | null;
    const check = checkMediaLink(req.url);
    if (check.ok) source = check.source;
    else if (req.forceFile === true && check.canTryAsFile) source = forceFileSource(req.url);
    else return { ok: false, error: check.reason };
    if (!source) return { ok: false, error: 'Invalid link.' };

    room.share = null;
    room.mode = 'link';
    room.link = {
      url: req.url.trim(),
      source,
      playing: false,
      position: source.kind === 'youtube' ? source.startSeconds : 0,
      rate: 1,
      updatedAt: this.now(),
    };
    this.clearIssues(room);
    return { ok: true };
  }

  controlLink(socketId: string, ctl: { playing?: unknown; position?: unknown; rate?: unknown }): Room | undefined {
    const room = this.roomOf(socketId);
    if (!room || !room.link || this.hostId(room) !== socketId) return undefined;
    if (typeof ctl.playing !== 'boolean') return undefined;
    if (typeof ctl.position !== 'number' || !Number.isFinite(ctl.position) || ctl.position < 0) return undefined;
    room.link.playing = ctl.playing;
    room.link.position = ctl.position;
    if (typeof ctl.rate === 'number' && Number.isFinite(ctl.rate) && ctl.rate >= 0.25 && ctl.rate <= 4) room.link.rate = ctl.rate;
    room.link.updatedAt = this.now();
    return room;
  }

  clearLink(socketId: string): Room | undefined {
    const room = this.roomOf(socketId);
    if (!room || this.hostId(room) !== socketId || room.mode !== 'link') return undefined;
    room.link = null;
    room.mode = 'idle';
    this.clearIssues(room);
    return room;
  }

  /** Returns the member if the reaction is allowed (rate limited per person). */
  allowReaction(socketId: string): Member | undefined {
    const room = this.roomOf(socketId);
    const m = room?.members.get(socketId);
    if (!m) return undefined;
    const now = this.now();
    if (now - m.lastReactionAt < SERVER_REACTION_MIN_INTERVAL_MS) return undefined;
    m.lastReactionAt = now;
    return m;
  }

  /** Both sockets must be in the same room for signaling to be relayed. */
  sameRoom(a: string, b: string): boolean {
    const ra = this.socketRoom.get(a);
    return !!ra && ra === this.socketRoom.get(b);
  }

  private clearIssues(room: Room) {
    for (const m of room.members.values()) m.playbackIssue = null;
  }

  toState(room: Room): RoomState {
    return {
      id: room.id,
      hostId: this.hostId(room),
      participants: [...room.members.values()]
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map(({ id, name, joinedAt, mic, gestures, playbackIssue }) => ({ id, name, joinedAt, mic, gestures, playbackIssue })),
      mode: room.mode,
      link: room.link ? { ...room.link } : null,
      share: room.share ? { ...room.share } : null,
    };
  }

  /** Current live position; exposed for tests and diagnostics. */
  livePosition(room: Room): number | null {
    return room.link ? expectedPosition(room.link, this.now()) : null;
  }
}
