import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomStore } from '../server/rooms';
import { expectedPosition, isValidRoomId, MAX_PARTICIPANTS } from '../shared/protocol';

let now = 1_000_000;
const changes: string[] = [];
let store: RoomStore;

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  changes.length = 0;
  store = new RoomStore({ onChange: (id) => changes.push(id), now: () => now, hostGraceMs: 20_000, emptyRoomTtlMs: 60_000 });
});
afterEach(() => vi.useRealTimers());

const cid = (n: number) => `client-${n}-xxxxxxxx`;

function setup(people = 2) {
  const room = store.create(cid(1));
  for (let i = 1; i <= people; i++) {
    now += 10;
    const res = store.join(room.id, `s${i}`, cid(i), `Person ${i}`);
    expect(res.ok).toBe(true);
  }
  return room;
}

describe('rooms', () => {
  it('creates valid room ids and makes the creator host', () => {
    const room = setup(2);
    expect(isValidRoomId(room.id)).toBe(true);
    expect(store.toState(room).hostId).toBe('s1');
    expect(store.isHost('s2')).toBe(false);
  });

  it('rejects unknown rooms and caps rooms at four people', () => {
    expect(store.join('abc-defg-hjk', 'x', cid(9), 'X')).toEqual({ ok: false, error: 'not-found' });
    const room = setup(MAX_PARTICIPANTS);
    expect(store.join(room.id, 's5', cid(5), 'Fifth')).toEqual({ ok: false, error: 'full' });
  });

  it('a refreshing tab (same clientId) replaces its old socket instead of taking a seat', () => {
    const room = setup(MAX_PARTICIPANTS);
    const res = store.join(room.id, 's1b', cid(1), 'Person 1');
    expect(res.ok && res.replacedSocketId).toBe('s1');
    expect(store.toState(room).participants).toHaveLength(MAX_PARTICIPANTS);
    expect(store.toState(room).hostId).toBe('s1b');
  });

  it('keeps the host role through a brief disconnect, then promotes the longest-present guest', () => {
    const room = setup(3);
    store.leave('s1');
    expect(store.toState(room).hostId).toBeNull();

    // Host comes back within the grace period.
    store.join(room.id, 's1b', cid(1), 'Person 1');
    vi.advanceTimersByTime(25_000);
    expect(store.toState(room).hostId).toBe('s1b');

    // Host leaves for good.
    store.leave('s1b');
    vi.advanceTimersByTime(19_000);
    expect(store.toState(room).hostId).toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(store.toState(room).hostId).toBe('s2');
    expect(changes).toContain(room.id);
  });

  it('only the host can share, link, or control playback', () => {
    setup(2);
    expect(store.startShare('s2', { hasAudio: true })).toMatchObject({ ok: false });
    expect(store.setLink('s2', { url: 'https://youtu.be/dQw4w9WgXcQ' })).toMatchObject({ ok: false });
    expect(store.startShare('s1', { hasAudio: true, surface: 'browser' })).toEqual({ ok: true });
  });

  it('screen share ends when the sharer leaves; switching to a link replaces the share', () => {
    const room = setup(2);
    store.startShare('s1', { hasAudio: false, surface: 'window' });
    expect(store.toState(room).mode).toBe('share');
    expect(store.setLink('s1', { url: 'https://example.com/v.mp4' })).toEqual({ ok: true });
    expect(store.toState(room)).toMatchObject({ mode: 'link', share: null });

    store.startShare('s1', { hasAudio: true });
    store.leave('s1');
    expect(store.toState(room)).toMatchObject({ mode: 'idle', share: null });
  });

  it('rejects links that cannot play, unless the host forces a plausible direct file', () => {
    setup(1);
    const res = store.setLink('s1', { url: 'https://www.netflix.com/watch/123' });
    expect(res.ok).toBe(false);
    expect(store.setLink('s1', { url: 'https://cdn.example.com/stream?id=9' })).toMatchObject({ ok: false });
    expect(store.setLink('s1', { url: 'https://cdn.example.com/stream?id=9', forceFile: true })).toEqual({ ok: true });
  });

  it('timeline: late joiners compute the live position from the server-stamped state', () => {
    const room = setup(2);
    store.setLink('s1', { url: 'https://youtu.be/dQw4w9WgXcQ?t=30' });
    expect(room.link?.position).toBe(30);
    store.controlLink('s1', { playing: true, position: 42, rate: 1 });
    now += 10_000;
    expect(store.livePosition(room)).toBeCloseTo(52);
    store.controlLink('s1', { playing: false, position: 53 });
    now += 60_000;
    expect(store.livePosition(room)).toBe(53);
    store.controlLink('s1', { playing: true, position: 53, rate: 2 });
    now += 5_000;
    expect(store.livePosition(room)).toBeCloseTo(63);
  });

  it('ignores malformed playback commands', () => {
    const room = setup(1);
    store.setLink('s1', { url: 'https://example.com/a.mp4' });
    expect(store.controlLink('s1', { playing: true, position: Number.NaN })).toBeUndefined();
    expect(store.controlLink('s1', { playing: 'yes', position: 3 })).toBeUndefined();
    expect(store.controlLink('s1', { playing: true, position: 3, rate: 100 })?.link?.rate).toBe(1);
    expect(room.link?.position).toBe(3);
  });

  it('rate-limits reactions per person', () => {
    setup(2);
    expect(store.allowReaction('s2')).toBeDefined();
    now += 500;
    expect(store.allowReaction('s2')).toBeUndefined();
    expect(store.allowReaction('s1')).toBeDefined();
    now += 600;
    expect(store.allowReaction('s2')).toBeDefined();
  });

  it('only relays signaling between people in the same room', () => {
    setup(2);
    const other = store.create(cid(7));
    store.join(other.id, 'z1', cid(7), 'Z');
    expect(store.sameRoom('s1', 's2')).toBe(true);
    expect(store.sameRoom('s1', 'z1')).toBe(false);
  });

  it('host can hand over; their screen share stops', () => {
    const room = setup(2);
    store.startShare('s1', { hasAudio: true });
    store.transferHost('s1', 's2');
    expect(store.toState(room)).toMatchObject({ hostId: 's2', share: null, mode: 'idle' });
    expect(store.transferHost('s1', 's2')).toBeUndefined();
  });

  it('deletes rooms after they stay empty', () => {
    const room = setup(1);
    store.leave('s1');
    vi.advanceTimersByTime(61_000);
    expect(store.rooms.has(room.id)).toBe(false);
  });
});

describe('expectedPosition', () => {
  it('does not advance while paused or for clocks behind updatedAt', () => {
    expect(expectedPosition({ playing: false, position: 5, rate: 1, updatedAt: 0 }, 99_000)).toBe(5);
    expect(expectedPosition({ playing: true, position: 5, rate: 1, updatedAt: 10_000 }, 9_000)).toBe(5);
  });
});
