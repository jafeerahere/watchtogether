import { useEffect, useRef, useState } from 'react';
import { CHAT_HISTORY_LIMIT, type ChatMessage, type IceConfig, type JoinError, type ReactionEvent, type RoomState } from '../../../shared/protocol';
import { getClientId } from '../lib/identity';
import { createSocket, ServerClock, type RoomSocket } from '../lib/socket';

export type RoomStatus = 'connecting' | 'joined' | 'reconnecting' | 'error' | 'kicked';

export interface Notice {
  id: number;
  text: string;
  tone: 'info' | 'warn';
}

const JOIN_ERRORS: Record<JoinError, string> = {
  'not-found': "This room doesn't exist or has expired. Rooms close 30 minutes after everyone leaves.",
  full: 'This room is full (4 people max).',
  'bad-request': 'Could not join: invalid name.',
};

export function useRoom(roomId: string, name: string) {
  const [status, setStatus] = useState<RoomStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<RoomState | null>(null);
  const [selfId, setSelfId] = useState<string | null>(null);
  const [ice, setIce] = useState<IceConfig | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [socket] = useState<RoomSocket>(() => createSocket());
  const [clock] = useState(() => new ServerClock());
  const reactionListeners = useRef(new Set<(r: ReactionEvent) => void>());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [typingIds, setTypingIds] = useState<string[]>([]);
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nameRef = useRef(name);
  nameRef.current = name;

  const notify = (text: string, tone: 'info' | 'warn' = 'info') => {
    const id = Date.now() + Math.random();
    setNotices((n) => [...n.slice(-3), { id, text, tone }]);
    setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), tone === 'warn' ? 7000 : 4000);
  };

  useEffect(() => {
    let kicked = false;
    const join = () => {
      socket.emit('room:join', { roomId, clientId: getClientId(), name: nameRef.current }, (res) => {
        if (!res.ok) {
          setStatus('error');
          setError(JOIN_ERRORS[res.error]);
          return;
        }
        setSelfId(res.selfId);
        setIce(res.ice);
        setState(res.state);
        // Full history on every (re)join, so nothing is missed or duplicated across reconnects.
        setMessages(res.chat);
        setStatus('joined');
      });
    };
    const setTyping = (id: string, typing: boolean) => {
      const timers = typingTimers.current;
      const old = timers.get(id);
      if (old) clearTimeout(old);
      timers.delete(id);
      // Safety expiry in case the "stopped typing" event never arrives.
      if (typing) timers.set(id, setTimeout(() => setTyping(id, false), 6000));
      setTypingIds((ids) => (typing ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((x) => x !== id)));
    };
    socket.on('connect', () => {
      if (kicked) return;
      clock.start(socket);
      join();
    });
    socket.on('disconnect', (reason) => {
      clock.stop();
      if (!kicked && reason !== 'io client disconnect') setStatus('reconnecting');
    });
    socket.on('room:state', setState);
    socket.on('reaction', (r) => reactionListeners.current.forEach((fn) => fn(r)));
    socket.on('notice', (n) => notify(n.text, n.tone ?? 'info'));
    socket.on('chat:message', (m) => {
      setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m].slice(-CHAT_HISTORY_LIMIT)));
      if (m.fromId) setTyping(m.fromId, false);
    });
    socket.on('chat:typing', ({ id, typing }) => setTyping(id, typing));
    socket.on('room:kicked', (reason) => {
      kicked = true;
      setStatus('kicked');
      setError(reason);
      socket.disconnect();
    });
    if (socket.disconnected) socket.connect();
    const timers = typingTimers.current;
    return () => {
      clock.stop();
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      socket.emit('room:leave');
      socket.removeAllListeners();
      socket.disconnect();
    };
  }, [socket, clock, roomId]);

  const onReaction = (fn: (r: ReactionEvent) => void) => {
    reactionListeners.current.add(fn);
    return () => {
      reactionListeners.current.delete(fn);
    };
  };

  return { status, error, state, selfId, ice, socket, clock, notices, notify, onReaction, messages, typingIds };
}
