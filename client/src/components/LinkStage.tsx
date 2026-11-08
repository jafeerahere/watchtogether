import { useEffect, useRef, useState } from 'react';
import { expectedPosition, type LinkPlayback } from '../../../shared/protocol';
import type { RoomSocket, ServerClock } from '../lib/socket';
import { FilePlayer, YouTubePlayer, type PlayerHandle } from './players';

interface Props {
  link: LinkPlayback;
  isHost: boolean;
  socket: RoomSocket;
  clock: ServerClock;
  onShareTabInstead: () => void;
  onStop: () => void;
}

/** Drift (s) that triggers a corrective seek on guests while playing / while paused. */
const PLAYING_TOLERANCE = 1.0;
const PAUSED_TOLERANCE = 0.2;
/** Host reports its position when it differs from the shared timeline by more than this. */
const HOST_REPORT_TOLERANCE = 1.0;

export function LinkStage({ link, isHost, socket, clock, onShareTabInstead, onStop }: Props) {
  const [handle, setHandle] = useState<PlayerHandle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [volume, setVolume] = useState(1);
  const linkRef = useRef(link);
  linkRef.current = link;
  const sourceKey = link.source.kind === 'youtube' ? `yt:${link.source.videoId}` : `file:${link.source.url}`;

  // New link (or host change remounting the player): forget the old player and error.
  useEffect(() => {
    setHandle(null);
    setError(null);
    setBlocked(false);
  }, [sourceKey, isHost]);

  useEffect(() => {
    socket.emit('profile:update', { playbackIssue: error });
  }, [error, socket]);

  useEffect(() => {
    handle?.setVolume(volume);
  }, [handle, volume]);

  // Host: the host's player is the source of truth. Report play/pause/seek/rate to the room.
  useEffect(() => {
    if (!handle || !isHost) return;
    const initial = linkRef.current;
    const start = expectedPosition(initial, clock.now());
    if (Math.abs(handle.getTime() - start) > HOST_REPORT_TOLERANCE) handle.seek(start);
    if (initial.playing) handle.play().catch(() => setBlocked(true));

    let ref = { playing: initial.playing, position: start, rate: initial.rate, at: clock.now() };
    const check = () => {
      const playing = handle.isPlaying();
      const position = handle.getTime();
      const rate = handle.getRate();
      const expected = expectedPosition({ ...ref, updatedAt: ref.at }, clock.now());
      if (playing !== ref.playing || rate !== ref.rate || Math.abs(position - expected) > HOST_REPORT_TOLERANCE) {
        ref = { playing, position, rate, at: clock.now() };
        socket.emit('link:control', { playing, position, rate });
      }
    };
    const interval = setInterval(check, 400);
    const unsubscribe = handle.onChange(() => setTimeout(check, 50));
    return () => {
      clearInterval(interval);
      unsubscribe();
    };
  }, [handle, isHost, socket, clock]);

  // Guests: follow the shared timeline; correct drift; no independent control.
  useEffect(() => {
    if (!handle || isHost) return;
    let lastSeek = 0;
    let playPending = false;
    const apply = () => {
      const current = linkRef.current;
      const expected = expectedPosition(current, clock.now());
      if (handle.getRate() !== current.rate) handle.setRate(current.rate);
      const drift = handle.getTime() - expected;
      const tolerance = current.playing ? PLAYING_TOLERANCE : PAUSED_TOLERANCE;
      const sinceSeek = performance.now() - lastSeek;
      // Small drifts get one correction every 2.5 s (avoids seek loops on slow connections);
      // big gaps (late join, a seek that didn't land) retry quickly.
      if (Math.abs(drift) > tolerance && (sinceSeek > 2500 || (Math.abs(drift) > 3 && sinceSeek > 800))) {
        lastSeek = performance.now();
        // Lead slightly while playing: the seek itself takes a moment.
        handle.seek(current.playing ? expected + 0.25 : expected);
      }
      if (current.playing && !handle.isPlaying() && !playPending) {
        playPending = true;
        handle
          .play()
          .then(() => setBlocked(false))
          .catch(() => setBlocked(true))
          .finally(() => {
            playPending = false;
          });
      } else if (!current.playing && handle.isPlaying()) {
        handle.pause();
      }
    };
    apply();
    const interval = setInterval(apply, 1000);
    return () => clearInterval(interval);
    // Re-run immediately on every timeline update from the host.
  }, [handle, isHost, clock, link.playing, link.position, link.updatedAt, link.rate]);

  const reportError = (reason: string) => setError(reason);

  return (
    <div className="link-stage">
      <div className="stage-toolbar">
        <span className="badge">{link.source.kind === 'youtube' ? 'YouTube' : link.source.mediaType === 'audio' ? 'Audio file' : 'Video file'}</span>
        <span className="link-url" title={link.url}>
          {link.url}
        </span>
        <span className="spacer" />
        {isHost ? (
          <>
            <span className="hint">You control playback</span>
            <button className="btn small" onClick={onStop}>
              Close link
            </button>
          </>
        ) : (
          <>
            <span className="hint">Host controls playback</span>
            <label className="volume">
              🔈
              <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Video volume" />
            </label>
          </>
        )}
      </div>

      <div className="player-frame" data-playing={link.playing}>
        {link.source.kind === 'youtube' ? (
          <YouTubePlayer
            key={`${link.source.videoId}:${isHost}`}
            videoId={link.source.videoId}
            startSeconds={link.source.startSeconds}
            isHost={isHost}
            onReady={setHandle}
            onError={reportError}
          />
        ) : (
          <FilePlayer
            key={`${link.source.url}:${isHost}`}
            url={link.source.url}
            mediaType={link.source.mediaType}
            isHost={isHost}
            onReady={setHandle}
            onError={reportError}
          />
        )}
        {/* Guests can't click through to the player: the host drives playback. */}
        {!isHost && <div className="click-shield" aria-hidden />}

        {blocked && !error && (
          <div className="player-overlay">
            <p>Your browser paused autoplay.</p>
            <button
              className="btn primary"
              onClick={() => {
                handle?.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
              }}
            >
              ▶ Start playback
            </button>
          </div>
        )}

        {error && (
          <div className="player-overlay error" role="alert">
            <h3>This link can't play here</h3>
            <p>{error}</p>
            {isHost ? (
              <div className="row">
                <button className="btn primary" onClick={onShareTabInstead}>
                  Share a tab instead
                </button>
                <button className="btn" onClick={onStop}>
                  Pick something else
                </button>
              </div>
            ) : (
              <p className="hint">The host can see this and can switch to sharing a tab.</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
