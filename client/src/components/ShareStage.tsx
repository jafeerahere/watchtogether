import { useEffect, useRef, useState } from 'react';
import type { ShareInfo } from '../../../shared/protocol';
import { noShareAudioReason, surfaceLabel } from '../rtc/media';
import type { LinkStatus } from '../rtc/PeerMesh';

export type ContentHint = 'detail' | 'motion';

interface Props {
  share: ShareInfo;
  isSharer: boolean;
  sharerName: string;
  /** Host: their own capture. Guest: the stream received from the host. */
  stream: MediaStream | null;
  connection: LinkStatus | null;
  hint: ContentHint;
  onHintChange: (hint: ContentHint) => void;
  onStop: () => void;
}

export function ShareStage({ share, isSharer, sharerName, stream, connection, hint, onHintChange, onStop }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const [volume, setVolume] = useState(1);
  const [needsClick, setNeedsClick] = useState(false);
  const [hasFrames, setHasFrames] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.srcObject = stream;
    setHasFrames(false);
    if (!stream) return;
    const onFrames = () => setHasFrames(v.videoWidth > 0);
    v.addEventListener('loadeddata', onFrames);
    v.addEventListener('resize', onFrames);
    v.play()
      .then(() => setNeedsClick(false))
      .catch(() => setNeedsClick(true));
    return () => {
      v.removeEventListener('loadeddata', onFrames);
      v.removeEventListener('resize', onFrames);
    };
  }, [stream]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume;
  }, [volume]);

  const audioBadge = share.hasAudio ? (
    <span className="badge ok" data-testid="share-audio" data-audio="on" title="The host's tab/screen audio is included. It plays separately from voice chat.">
      🔊 Shared audio on
    </span>
  ) : (
    <span
      className="badge muted"
      data-testid="share-audio"
      data-audio="off"
      title={isSharer ? noShareAudioReason(share.surface) : 'The host is sharing video only.'}
    >
      🔇 No shared audio
    </span>
  );

  const waiting = !isSharer && (!stream || !hasFrames);
  const connState = connection?.state;

  return (
    <div className="share-stage">
      <div className="stage-toolbar">
        <span className="badge live">● LIVE</span>
        <span className="hint">{isSharer ? `You're sharing ${surfaceLabel(share.surface)}` : `${sharerName} is sharing ${surfaceLabel(share.surface)}`}</span>
        {audioBadge}
        <span className="spacer" />
        {isSharer ? (
          <>
            <label className="select">
              Optimize for
              <select value={hint} onChange={(e) => onHintChange(e.target.value as ContentHint)}>
                <option value="detail">Text & slides (sharp)</option>
                <option value="motion">Video (smooth)</option>
              </select>
            </label>
            <button className="btn small danger" onClick={onStop}>
              Stop sharing
            </button>
          </>
        ) : (
          <>
            {share.hasAudio && (
              <label className="volume">
                Shared audio
                <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} aria-label="Shared audio volume" />
              </label>
            )}
            <button className="btn small" onClick={() => frameRef.current?.requestFullscreen?.()}>
              ⛶ Fullscreen
            </button>
          </>
        )}
      </div>

      {isSharer && !share.hasAudio && <p className="inline-note">{noShareAudioReason(share.surface)}</p>}

      <div className="player-frame" ref={frameRef}>
        <video
          ref={videoRef}
          className="share-video"
          data-testid={isSharer ? 'share-preview' : 'share-video'}
          autoPlay
          playsInline
          // The sharer's own preview is muted to avoid hearing their tab twice.
          muted={isSharer}
        />
        {waiting && (
          <div className="player-overlay">
            <div className="spinner" />
            <p>
              {connState === 'failed'
                ? "Couldn't connect to the host's stream. Your network may need a TURN server (see docs)."
                : 'Connecting to the shared screen…'}
            </p>
          </div>
        )}
        {needsClick && !isSharer && (
          <div className="player-overlay">
            <button
              className="btn primary"
              onClick={() =>
                videoRef.current
                  ?.play()
                  .then(() => setNeedsClick(false))
                  .catch(() => undefined)
              }
            >
              ▶ Click to watch
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
