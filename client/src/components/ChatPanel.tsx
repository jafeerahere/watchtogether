import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MAX_CHAT_LENGTH, type Ack, type ChatMessage, type Participant } from '../../../shared/protocol';

interface Props {
  messages: ChatMessage[];
  selfId: string;
  participants: Participant[];
  typingIds: string[];
  onSend: (text: string) => Promise<Ack>;
  onTyping: (typing: boolean) => void;
}

/** Consecutive messages from the same person within this window share one name header. */
const GROUP_WINDOW_MS = 2 * 60_000;
/** Treat the list as "at the bottom" within this many pixels. */
const STICKY_PX = 48;

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

/** Turn http(s) links into anchors. Everything else stays plain text (React escapes it). */
function linkify(text: string): ReactNode[] {
  return text.split(URL_RE).map((part, i) =>
    i % 2 === 1 ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow">
        {part}
      </a>
    ) : (
      part
    ),
  );
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });

export function ChatPanel({ messages, selfId, participants, typingIds, onSend, onTyping }: Props) {
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unseen, setUnseen] = useState(0);
  const atBottom = useRef(true);
  const lastCount = useRef(messages.length);
  const typingSent = useRef(false);
  const typingIdle = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep pinned to the newest message unless the reader scrolled up; then count what they missed.
  useLayoutEffect(() => {
    const el = listRef.current;
    const added = messages.length - lastCount.current;
    lastCount.current = messages.length;
    if (!el) return;
    const mine = messages.at(-1)?.fromId === selfId;
    if (atBottom.current || mine) {
      el.scrollTop = el.scrollHeight;
      setUnseen(0);
    } else if (added > 0) {
      setUnseen((n) => n + added);
    }
  }, [messages, selfId]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_PX;
    if (atBottom.current) setUnseen(0);
  };

  const jumpToBottom = () => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottom.current = true;
    setUnseen(0);
  };

  const stopTyping = () => {
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = null;
    if (typingSent.current) {
      typingSent.current = false;
      onTyping(false);
    }
  };

  useEffect(() => stopTyping, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onDraftChange = (value: string) => {
    setDraft(value);
    setError(null);
    if (!value.trim()) {
      stopTyping();
      return;
    }
    if (!typingSent.current) {
      typingSent.current = true;
      onTyping(true);
    }
    if (typingIdle.current) clearTimeout(typingIdle.current);
    typingIdle.current = setTimeout(stopTyping, 3000);
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    stopTyping();
    const res = await onSend(text);
    setSending(false);
    if (res.ok) {
      setDraft('');
      atBottom.current = true;
    } else {
      setError(res.error);
    }
    inputRef.current?.focus();
  };

  const names = new Map(participants.map((p) => [p.id, p.name]));
  const typers = typingIds.filter((id) => id !== selfId && names.has(id)).map((id) => names.get(id)!);
  const typingLine =
    typers.length === 0 ? '' : typers.length === 1 ? `${typers[0]} is typing…` : `${typers.slice(0, -1).join(', ')} and ${typers.at(-1)} are typing…`;

  return (
    <section className="chat" aria-label="Room chat" data-testid="chat">
      <h3>Chat</h3>
      <div className="chat-list" ref={listRef} onScroll={onScroll} role="log" aria-live="polite" data-testid="chat-list">
        {messages.length === 0 && <p className="chat-empty">No messages yet. Say hi 👋</p>}
        {messages.map((m, i) => {
          if (m.kind === 'system') {
            return (
              <div key={m.id} className="chat-system" data-testid="chat-system">
                {m.text}
              </div>
            );
          }
          const prev = messages[i - 1];
          const grouped = prev?.kind === 'user' && prev.fromId === m.fromId && m.at - prev.at < GROUP_WINDOW_MS;
          const mine = m.fromId === selfId;
          return (
            <div key={m.id} className={`chat-msg ${mine ? 'mine' : ''} ${grouped ? 'grouped' : ''}`} data-testid="chat-message" data-from={m.fromName ?? ''}>
              {!grouped && (
                <div className="chat-meta">
                  <span className="chat-name">{mine ? 'You' : m.fromName}</span>
                  <time dateTime={new Date(m.at).toISOString()}>{timeFmt.format(m.at)}</time>
                </div>
              )}
              <div className="chat-text">{linkify(m.text)}</div>
            </div>
          );
        })}
      </div>
      {unseen > 0 && (
        <button className="chat-unseen" onClick={jumpToBottom}>
          {unseen} new message{unseen > 1 ? 's' : ''} ↓
        </button>
      )}
      <div className="chat-typing" aria-live="polite" data-testid="chat-typing">
        {typingLine}
      </div>
      <form
        className="chat-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends; Shift+Enter adds a new line. Don't send mid-IME composition.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          onBlur={stopTyping}
          rows={1}
          maxLength={MAX_CHAT_LENGTH}
          placeholder="Message the room…"
          aria-label="Chat message"
          data-testid="chat-input"
        />
        <button className="btn primary small" type="submit" disabled={!draft.trim() || sending} data-testid="chat-send">
          Send
        </button>
      </form>
      {error && <p className="chat-error">{error}</p>}
    </section>
  );
}
