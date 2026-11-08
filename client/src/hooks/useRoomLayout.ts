// Room layout: view mode (default / theatre / full screen), the collapsible Chat|People panel,
// unread chat count, auto-hiding controls in full screen, and keyboard shortcuts (T, F, C).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../../shared/protocol';

export type ViewMode = 'default' | 'theatre' | 'full';
export type SidebarTab = 'chat' | 'people';

const CHROME_IDLE_MS = 2500;

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

export function useRoomLayout(messages: ChatMessage[], selfId: string | null, notify: (text: string, tone?: 'info' | 'warn') => void) {
  const roomRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<ViewMode>(() => (load('wt:view') === 'theatre' ? 'theatre' : 'default'));
  const [sidebarOpen, setSidebarOpen] = useState(() => load('wt:sidebar') !== 'closed');
  const [tab, setTab] = useState<SidebarTab>(() => (load('wt:tab') === 'people' ? 'people' : 'chat'));
  const [chromeHidden, setChromeHidden] = useState(false);
  /** Layout to return to when full screen ends (Esc, the button, or the browser). */
  const beforeFull = useRef<{ mode: Exclude<ViewMode, 'full'>; sidebarOpen: boolean }>({ mode: 'default', sidebarOpen: true });
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // Remember the layout per viewer (full screen isn't remembered: browsers require a click to enter it).
  useEffect(() => {
    if (mode !== 'full') save('wt:view', mode);
  }, [mode]);
  useEffect(() => {
    if (mode !== 'full') save('wt:sidebar', sidebarOpen ? 'open' : 'closed');
  }, [sidebarOpen, mode]);
  useEffect(() => save('wt:tab', tab), [tab]);

  const restoreFromFull = useCallback(() => {
    setMode(beforeFull.current.mode);
    setSidebarOpen(beforeFull.current.sidebarOpen);
    setChromeHidden(false);
  }, []);

  const enterFull = useCallback(async () => {
    const el = roomRef.current;
    if (!el) return;
    if (modeRef.current !== 'full') beforeFull.current = { mode: modeRef.current as Exclude<ViewMode, 'full'>, sidebarOpen };
    try {
      await el.requestFullscreen({ navigationUI: 'hide' });
      setSidebarOpen(false); // full screen starts as video-only; C or the chat button slides chat back in
      setMode('full');
    } catch {
      notify("This browser didn't allow full screen, so you're in theatre mode instead.", 'warn');
      setMode('theatre');
    }
  }, [notify, sidebarOpen]);

  const setView = useCallback(
    (next: ViewMode) => {
      if (next === 'full') {
        void enterFull();
        return;
      }
      if (modeRef.current === 'full') {
        beforeFull.current = { ...beforeFull.current, mode: next };
        if (document.fullscreenElement) void document.exitFullscreen();
        else restoreFromFull();
        return;
      }
      setMode(next);
    },
    [enterFull, restoreFromFull],
  );

  // Leaving browser full screen any way (Esc included) restores the previous layout.
  useEffect(() => {
    const onChange = () => {
      if (!document.fullscreenElement && modeRef.current === 'full') restoreFromFull();
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, [restoreFromFull]);

  const toggleChat = useCallback(() => {
    if (!sidebarOpen) {
      setSidebarOpen(true);
      setTab('chat');
    } else if (tab !== 'chat') {
      setTab('chat');
    } else {
      setSidebarOpen(false);
    }
  }, [sidebarOpen, tab]);

  const openTab = useCallback((next: SidebarTab) => {
    setTab(next);
    setSidebarOpen(true);
  }, []);

  // Full screen: hide the controls after a moment of no mouse/keyboard activity (like a video player).
  useEffect(() => {
    if (mode !== 'full') {
      setChromeHidden(false);
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const wake = () => {
      setChromeHidden(false);
      clearTimeout(timer);
      timer = setTimeout(() => {
        // Stay visible while the pointer is on the controls or chat, or while typing in chat.
        // (Focus left on a control button after a click doesn't count, or they'd never hide.)
        const busy = roomRef.current?.querySelector('.controls:hover, .sidebar:hover, .sidebar:focus-within');
        if (!busy) setChromeHidden(true);
      }, CHROME_IDLE_MS);
    };
    wake();
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart'] as const;
    events.forEach((e) => window.addEventListener(e, wake, { passive: true }));
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, wake));
    };
  }, [mode]);

  // Shortcuts: T theatre, F full screen, C chat. Ignored while typing.
  const handlers = useRef({ setView, toggleChat });
  handlers.current = { setView, toggleChat };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat || isTypingTarget(e.target)) return;
      const key = e.key.toLowerCase();
      const current = modeRef.current;
      if (key === 't') handlers.current.setView(current === 'theatre' ? 'default' : 'theatre');
      else if (key === 'f') handlers.current.setView(current === 'full' ? beforeFull.current.mode : 'full');
      else if (key === 'c') handlers.current.toggleChat();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Unread: messages from others that arrived while the chat wasn't on screen.
  const chatVisible = sidebarOpen && tab === 'chat';
  const lastAt = messages.at(-1)?.at ?? 0;
  const lastAtRef = useRef(lastAt);
  lastAtRef.current = lastAt;
  const [seenAt, setSeenAt] = useState(0);
  useEffect(() => {
    // History received on (re)join counts as already seen.
    if (selfId) setSeenAt((s) => Math.max(s, lastAtRef.current));
  }, [selfId]);
  useEffect(() => {
    if (chatVisible) setSeenAt(lastAt);
  }, [chatVisible, lastAt]);
  const unread = chatVisible ? 0 : messages.filter((m) => m.kind === 'user' && m.fromId !== selfId && m.at > seenAt).length;

  return {
    roomRef,
    mode,
    setView,
    exitFullTo: () => setView(beforeFull.current.mode),
    sidebarOpen,
    setSidebarOpen,
    toggleChat,
    tab,
    openTab,
    chatVisible,
    unread,
    chromeHidden,
  };
}
