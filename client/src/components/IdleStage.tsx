import { useState } from 'react';
import { checkMediaLink } from '../../../shared/links';
import type { RoomSocket } from '../lib/socket';

interface Props {
  isHost: boolean;
  hostName: string | null;
  socket: RoomSocket;
  canShare: boolean;
  onShare: () => void;
  onCopyInvite: () => void;
  inviteUrl: string;
}

export function IdleStage({ isHost, hostName, socket, canShare, onShare, onCopyInvite, inviteUrl }: Props) {
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState<{ reason: string; canTryAsFile: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  if (!isHost) {
    return (
      <div className="idle guest-idle">
        <div className="idle-icon">🍿</div>
        <h2>{hostName ? `Waiting for ${hostName} to pick something` : 'Waiting for the host…'}</h2>
        <p className="hint">You'll see their shared screen or synced video here. Meanwhile, turn on your mic or gestures below.</p>
      </div>
    );
  }

  const submit = (forceFile = false) => {
    const trimmed = url.trim();
    if (!trimmed) return;
    if (!forceFile) {
      const check = checkMediaLink(trimmed);
      if (!check.ok) {
        setProblem({ reason: check.reason, canTryAsFile: check.canTryAsFile });
        return;
      }
    }
    setBusy(true);
    socket.emit('link:set', { url: trimmed, forceFile }, (res) => {
      setBusy(false);
      if (!res.ok) setProblem({ reason: res.error, canTryAsFile: false });
    });
  };

  return (
    <div className="idle host-idle">
      <h2>What are we watching?</h2>
      <div className="choices">
        <div className="choice">
          <div className="choice-icon">🖥️</div>
          <h3>Share anything</h3>
          <p>
            A tab, window, or your whole screen: slides, notes, websites, local videos. Everyone watches your live feed.
          </p>
          <button className="btn primary" onClick={onShare} disabled={!canShare} data-testid="start-share">
            Share a tab or screen
          </button>
          {!canShare && <p className="hint">This browser can't share its screen. Use desktop Chrome, Edge, or Firefox.</p>}
          <p className="hint">Tip: pick a <b>Chrome tab</b> to include its sound.</p>
        </div>

        <div className="choice">
          <div className="choice-icon">🔗</div>
          <h3>Paste a link</h3>
          <p>YouTube or a direct .mp4 / .webm / .mp3 link. Everyone streams it themselves, perfectly in sync.</p>
          <form
            className="link-form"
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
          >
            <input
              type="url"
              inputMode="url"
              placeholder="https://youtube.com/watch?v=…"
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setProblem(null);
              }}
              aria-label="Video link"
              data-testid="link-input"
            />
            <button className="btn primary" type="submit" disabled={busy || !url.trim()} data-testid="link-submit">
              Play
            </button>
          </form>
          {problem && (
            <div className="problem" role="alert">
              <p>{problem.reason}</p>
              <div className="row">
                <button className="btn small primary" onClick={onShare} disabled={!canShare}>
                  Share a tab instead
                </button>
                {problem.canTryAsFile && (
                  <button className="btn small" onClick={() => submit(true)}>
                    Try it anyway
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="invite-strip">
        <span>Invite friends:</span>
        <code>{inviteUrl}</code>
        <button className="btn small" onClick={onCopyInvite}>
          Copy
        </button>
      </div>
    </div>
  );
}
