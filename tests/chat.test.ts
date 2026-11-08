import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomStore } from '../server/rooms';
import { CHAT_BURST, CHAT_HISTORY_LIMIT, MAX_CHAT_LENGTH, cleanChatText, type ChatMessage } from '../shared/protocol';

let now = 1_000_000;
let posted: { roomId: string; message: ChatMessage }[] = [];
let store: RoomStore;

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_000_000;
  posted = [];
  store = new RoomStore({
    onChange: () => {},
    onChat: (roomId, message) => posted.push({ roomId, message }),
    now: () => now,
    leaveNoticeDelayMs: 5_000,
  });
});
afterEach(() => vi.useRealTimers());

const cid = (n: number) => `client-${n}-xxxxxxxx`;

function room2() {
  const room = store.create(cid(1));
  store.join(room.id, 's1', cid(1), 'Hana');
  store.join(room.id, 's2', cid(2), 'Gus');
  posted = [];
  return room;
}

const texts = () => posted.map((p) => `${p.message.kind}:${p.message.fromName ?? ''}:${p.message.text}`);

describe('chat', () => {
  it('broadcasts a message with sender and keeps it in history', () => {
    const room = room2();
    expect(store.sendChat('s2', '  what does ATP stand for?  ')).toEqual({ ok: true });
    expect(texts()).toEqual(['user:Gus:what does ATP stand for?']);
    expect(posted[0].roomId).toBe(room.id);
    expect(posted[0].message).toMatchObject({ fromId: 's2', at: now });
    expect(store.chatHistory(room).map((m) => m.text)).toEqual(['Hana joined', 'Gus joined', 'what does ATP stand for?']);
  });

  it('rejects empty and non-string messages, and people outside a room', () => {
    room2();
    expect(store.sendChat('s1', '   \n  ')).toMatchObject({ ok: false });
    expect(store.sendChat('s1', 42)).toMatchObject({ ok: false });
    expect(store.sendChat('nobody', 'hi')).toMatchObject({ ok: false });
    expect(posted).toHaveLength(0);
  });

  it(`rate-limits to ${CHAT_BURST} messages per window per person`, () => {
    room2();
    for (let i = 0; i < CHAT_BURST; i++) expect(store.sendChat('s1', `m${i}`).ok).toBe(true);
    expect(store.sendChat('s1', 'too many')).toMatchObject({ ok: false, error: expect.stringMatching(/too fast/) });
    expect(store.sendChat('s2', 'others are unaffected').ok).toBe(true);
    now += 5_001;
    expect(store.sendChat('s1', 'ok again').ok).toBe(true);
  });

  it(`keeps only the last ${CHAT_HISTORY_LIMIT} messages`, () => {
    const room = room2();
    for (let i = 0; i < CHAT_HISTORY_LIMIT + 25; i++) {
      now += 1_001;
      store.sendChat(i % 2 ? 's1' : 's2', `msg ${i}`);
    }
    const history = store.chatHistory(room);
    expect(history).toHaveLength(CHAT_HISTORY_LIMIT);
    expect(history[0].text).toBe('msg 25');
    expect(history.at(-1)?.text).toBe(`msg ${CHAT_HISTORY_LIMIT + 24}`);
  });

  it('history handed to late joiners includes earlier messages', () => {
    const room = room2();
    store.sendChat('s1', 'slide 12 is the important one');
    store.join(room.id, 's3', cid(3), 'Lia');
    expect(store.chatHistory(room).map((m) => m.text)).toEqual(['Hana joined', 'Gus joined', 'slide 12 is the important one', 'Lia joined']);
  });

  it('announces joins and leaves', () => {
    const room = room2();
    store.join(room.id, 's3', cid(3), 'Lia');
    store.leave('s3');
    expect(texts()).toEqual(['system::Lia joined']);
    vi.advanceTimersByTime(5_000);
    expect(texts()).toEqual(['system::Lia joined', 'system::Lia left']);
  });

  it('stays quiet when someone just refreshes or reconnects', () => {
    const room = room2();
    store.leave('s2'); // page refresh: old socket disconnects…
    store.join(room.id, 's2b', cid(2), 'Gus'); // …and the same tab rejoins
    vi.advanceTimersByTime(10_000);
    // Replacing a still-connected socket (network blip) is silent too.
    store.join(room.id, 's2c', cid(2), 'Gus');
    expect(posted).toHaveLength(0);
  });
});

describe('cleanChatText', () => {
  it('trims, strips control characters, keeps line breaks, and caps length', () => {
    expect(cleanChatText('  hi\u0000 there\u0007  ')).toBe('hi there');
    expect(cleanChatText('line 1\r\nline 2\n\n\n\nline 3')).toBe('line 1\nline 2\n\nline 3');
    expect(cleanChatText('x'.repeat(MAX_CHAT_LENGTH + 50))).toHaveLength(MAX_CHAT_LENGTH);
    expect(cleanChatText('\t \n')).toBeNull();
    expect(cleanChatText(null)).toBeNull();
  });

  it('leaves markup as plain text (the client renders it escaped)', () => {
    expect(cleanChatText('<img src=x onerror=alert(1)>')).toBe('<img src=x onerror=alert(1)>');
  });
});
