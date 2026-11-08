import { useEffect, useState } from 'react';
import { isValidRoomId } from '../../shared/protocol';
import { Room } from './components/Room';
import { getClientId, getSavedName, saveName } from './lib/identity';

function navigate(to: string, state?: unknown) {
  window.history.pushState(state ?? null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate', { state }));
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  return path;
}

function roomIdFrom(input: string): string | null {
  const m = input.trim().toLowerCase().match(/([a-z0-9]{3}-[a-z0-9]{4}-[a-z0-9]{3})/);
  return m && isValidRoomId(m[1]) ? m[1] : null;
}

export function App() {
  const path = usePath();
  const roomMatch = path.match(/^\/r\/([^/]+)\/?$/);
  if (roomMatch) return <RoomPage key={roomMatch[1]} roomId={decodeURIComponent(roomMatch[1])} />;
  return <Home />;
}

function Home() {
  const [name, setName] = useState(getSavedName());
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Enter your name first.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: getClientId() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      saveName(trimmed);
      navigate(`/r/${body.roomId}`, { autoJoin: true });
    } catch (err) {
      setError(`Couldn't create a room: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const join = () => {
    const id = roomIdFrom(code);
    if (!id) {
      setError('Paste an invite link or a room code like abc-defg-hjk.');
      return;
    }
    navigate(`/r/${id}`);
  };

  return (
    <div className="home">
      <div className="home-card">
        <div className="logo">
          <img src="/favicon.svg" alt="" width={44} height={44} />
          <h1>WatchTogether</h1>
        </div>
        <p className="tagline">Study, watch, and react together. Share any tab or sync a video, talk over voice, and fire off gesture memes.</p>

        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <label>
            Your name
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="e.g. Priya" autoFocus data-testid="name-input" />
          </label>
          <button className="btn primary big" type="submit" disabled={busy} data-testid="create-room">
            {busy ? 'Creating…' : 'Create a room'}
          </button>
        </form>

        <div className="divider">or join one</div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            join();
          }}
        >
          <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="Invite link or room code" aria-label="Invite link or room code" />
          <button className="btn" type="submit">
            Join
          </button>
        </form>
        {error && <p className="error">{error}</p>}

        <ul className="features">
          <li>🖥️ Share a tab, window, or screen: slides, sites, local videos</li>
          <li>🔗 Synced YouTube & direct video links, with late-join catch-up</li>
          <li>🎙️ Voice chat, separate from shared audio</li>
          <li>✋ Hand gestures → memes for everyone (camera stays on your device)</li>
        </ul>
      </div>
    </div>
  );
}

function RoomPage({ roomId }: { roomId: string }) {
  const autoJoin = (window.history.state as { autoJoin?: boolean } | null)?.autoJoin === true && !!getSavedName();
  const [name, setName] = useState(getSavedName());
  const [joined, setJoined] = useState(autoJoin);
  const [info, setInfo] = useState<{ exists: boolean; participants?: number; max?: number } | null>(null);

  useEffect(() => {
    if (joined) return;
    if (!isValidRoomId(roomId)) {
      setInfo({ exists: false });
      return;
    }
    fetch(`/api/rooms/${roomId}`)
      .then((r) => r.json())
      .then(setInfo)
      .catch(() => setInfo({ exists: false }));
  }, [roomId, joined]);

  const leave = () => navigate('/');

  if (joined) return <Room roomId={roomId} name={name.trim()} onLeave={leave} />;

  const full = !!info?.exists && info.participants !== undefined && info.max !== undefined && info.participants >= info.max;
  return (
    <div className="home">
      <div className="home-card">
        <div className="logo">
          <img src="/favicon.svg" alt="" width={44} height={44} />
          <h1>Join room</h1>
        </div>
        {info === null && <p className="hint">Checking room…</p>}
        {info && !info.exists && (
          <>
            <p className="error">This room doesn't exist or has expired.</p>
            <button className="btn primary" onClick={leave}>
              Create a new room
            </button>
          </>
        )}
        {info?.exists && (
          <form
            className="stack"
            onSubmit={(e) => {
              e.preventDefault();
              if (!name.trim()) return;
              saveName(name.trim());
              // This click also unlocks autoplay with sound for the shared stream and voice.
              setJoined(true);
            }}
          >
            <p>
              Room <code>{roomId}</code> · {info.participants}/{info.max} here
            </p>
            {full && <p className="error">This room is full (4 people max).</p>}
            <label>
              Your name
              <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} placeholder="e.g. Sam" autoFocus data-testid="name-input" />
            </label>
            <button className="btn primary big" type="submit" disabled={!name.trim() || full} data-testid="join-room">
              Join
            </button>
            <p className="hint">Mic and camera stay off until you turn them on.</p>
          </form>
        )}
      </div>
    </div>
  );
}
