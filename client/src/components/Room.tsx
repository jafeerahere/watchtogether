import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ReactionEvent } from '../../../shared/protocol';
import { memeDuration, REACTIONS, REACTION_KINDS, type ReactionKind } from '../../../shared/reactions';
import { useRoom } from '../hooks/useRoom';
import { PeerMesh, type LinkStatus } from '../rtc/PeerMesh';
import { canShareScreen, captureDisplay, describeMediaError, displaySurface, getMicTrack } from '../rtc/media';
import { GesturePanel } from './GesturePanel';
import { IdleStage } from './IdleStage';
import { LinkStage } from './LinkStage';
import { MemeOverlay } from './MemeOverlay';
import { Participants, RemoteAudio } from './Participants';
import { ShareStage, type ContentHint } from './ShareStage';

const REACTION_COOLDOWN_MS = 2500;

interface Props {
  roomId: string;
  name: string;
  onLeave: () => void;
}

export function Room({ roomId, name, onLeave }: Props) {
  const { status, error, state, selfId, ice, socket, clock, notices, notify, onReaction } = useRoom(roomId, name);
  const isHost = !!state && !!selfId && state.hostId === selfId;
  const participants = state?.participants ?? [];
  const ids = useMemo(() => participants.map((p) => p.id), [participants]);
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const stateRef = useRef(state);
  stateRef.current = state;

  const meshRef = useRef<PeerMesh | null>(null);
  const [voiceStreams, setVoiceStreams] = useState<Record<string, MediaStream>>({});
  const [remoteScreen, setRemoteScreen] = useState<{ peerId: string; stream: MediaStream } | null>(null);
  const [statuses, setStatuses] = useState<Record<string, LinkStatus>>({});

  const micTrackRef = useRef<MediaStreamTrack | null>(null);
  const [micStream, setMicStream] = useState<MediaStream | null>(null);
  const [micBusy, setMicBusy] = useState(false);

  const localShareRef = useRef<MediaStream | null>(null);
  const [localShare, setLocalShare] = useState<MediaStream | null>(null);
  const sharePendingRef = useRef(false);
  const [hint, setHint] = useState<ContentHint>('detail');

  const [cameraOn, setCameraOn] = useState(false);
  const cameraOnRef = useRef(false);
  cameraOnRef.current = cameraOn;

  const [memes, setMemes] = useState<ReactionEvent[]>([]);
  const [lastReaction, setLastReaction] = useState<Record<string, ReactionEvent>>({});
  const cooldownRef = useRef(0);
  const [coolingDown, setCoolingDown] = useState(false);
  const [voiceVolume, setVoiceVolume] = useState(1);

  // --- Peer mesh: one per (socket id, ICE config). Recreated after reconnects. -----------------
  useEffect(() => {
    if (!selfId || !ice) return;
    const mesh = new PeerMesh(socket, selfId, ice, {
      onVoiceStream: (id, stream) =>
        setVoiceStreams((prev) => {
          const next = { ...prev };
          if (stream) next[id] = stream;
          else delete next[id];
          return next;
        }),
      onScreenStream: (id, stream) => setRemoteScreen((prev) => (stream ? { peerId: id, stream } : prev?.peerId === id ? null : prev)),
      onStatus: (id, channel, st) =>
        setStatuses((prev) => {
          const next = { ...prev };
          if (st) next[`${channel}:${id}`] = st;
          else delete next[`${channel}:${id}`];
          return next;
        }),
    });
    meshRef.current = mesh;

    // Restore what this tab was doing before a reconnect.
    socket.emit('profile:update', { mic: !!micTrackRef.current, gestures: cameraOnRef.current });
    if (micTrackRef.current) void mesh.setMicTrack(micTrackRef.current, idsRef.current);
    const share = localShareRef.current;
    if (share && share.getVideoTracks()[0]?.readyState === 'live' && stateRef.current?.hostId === selfId) {
      socket.emit('share:start', { hasAudio: share.getAudioTracks().length > 0, surface: displaySurface(share) }, (res) => {
        if (res.ok) mesh.startScreenShare(share, idsRef.current);
        else stopShare(false);
      });
    } else if (share) {
      stopShare(false);
    }

    return () => {
      mesh.dispose();
      meshRef.current = null;
      setVoiceStreams({});
      setRemoteScreen(null);
      setStatuses({});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selfId, ice, socket]);

  useEffect(() => {
    meshRef.current?.sync(ids, state?.share?.sharerId ?? null);
  }, [ids, state?.share?.sharerId]);

  // If the room no longer says we're sharing (host handed off, a link was opened…), release the capture.
  useEffect(() => {
    if (status !== 'joined' || !localShare || sharePendingRef.current) return;
    if (state?.share?.sharerId !== selfId) stopShare(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.share?.sharerId, selfId, localShare, status]);

  // Release devices when leaving.
  useEffect(
    () => () => {
      micTrackRef.current?.stop();
      localShareRef.current?.getTracks().forEach((t) => t.stop());
    },
    [],
  );

  // --- Reactions ----------------------------------------------------------------------------
  useEffect(
    () =>
      onReaction((r) => {
        setMemes((m) => [...m.slice(-4), r]);
        setTimeout(() => setMemes((m) => m.filter((x) => x.id !== r.id)), memeDuration(r.kind));
        setLastReaction((prev) => ({ ...prev, [r.fromId]: r }));
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const sendReaction = (kind: ReactionKind, via: 'gesture' | 'button'): boolean => {
    const now = Date.now();
    if (now < cooldownRef.current) return false;
    cooldownRef.current = now + REACTION_COOLDOWN_MS;
    setCoolingDown(true);
    setTimeout(() => setCoolingDown(false), REACTION_COOLDOWN_MS);
    socket.emit('reaction:send', { kind, via });
    return true;
  };

  // --- Mic ----------------------------------------------------------------------------------
  const setMic = async (on: boolean) => {
    if (micBusy) return;
    setMicBusy(true);
    try {
      if (!on) {
        micTrackRef.current?.stop();
        micTrackRef.current = null;
        setMicStream(null);
        await meshRef.current?.setMicTrack(null, idsRef.current);
        socket.emit('profile:update', { mic: false });
        return;
      }
      const track = await getMicTrack();
      track.addEventListener('ended', () => {
        if (micTrackRef.current === track) void setMic(false);
      });
      micTrackRef.current = track;
      setMicStream(new MediaStream([track]));
      await meshRef.current?.setMicTrack(track, idsRef.current);
      socket.emit('profile:update', { mic: true });
    } catch (err) {
      notify(describeMediaError(err, 'microphone'), 'warn');
    } finally {
      setMicBusy(false);
    }
  };

  // --- Screen share -------------------------------------------------------------------------
  function stopShare(tellServer = true) {
    const stream = localShareRef.current;
    if (!stream) return;
    localShareRef.current = null;
    setLocalShare(null);
    stream.getTracks().forEach((t) => t.stop());
    meshRef.current?.stopScreenShare();
    if (tellServer) socket.emit('share:stop');
  }

  const startShare = async () => {
    if (!isHost) return;
    if (!canShareScreen()) {
      notify("This browser can't share its screen (most phones and tablets can't). Use a desktop browser to share.", 'warn');
      return;
    }
    let stream: MediaStream;
    try {
      stream = await captureDisplay();
    } catch (err) {
      const msg = describeMediaError(err, 'screen');
      if ((err as { name?: string })?.name !== 'NotAllowedError') notify(msg, 'warn');
      return;
    }
    const video = stream.getVideoTracks()[0];
    if (video) video.contentHint = hint;
    const audio = stream.getAudioTracks()[0];
    sharePendingRef.current = true;
    stopShare(false);
    socket.emit('share:start', { hasAudio: !!audio, surface: displaySurface(stream) }, (res) => {
      sharePendingRef.current = false;
      if (!res.ok) {
        stream.getTracks().forEach((t) => t.stop());
        notify(res.error, 'warn');
        return;
      }
      localShareRef.current = stream;
      setLocalShare(stream);
      meshRef.current?.startScreenShare(stream, idsRef.current);
    });
    // The browser's own "Stop sharing" bar ends the video track.
    video?.addEventListener('ended', () => {
      if (localShareRef.current === stream) stopShare();
    });
    audio?.addEventListener('ended', () => {
      if (localShareRef.current === stream) socket.emit('share:update', { hasAudio: false });
    });
  };

  const changeHint = (h: ContentHint) => {
    setHint(h);
    const video = localShareRef.current?.getVideoTracks()[0];
    if (video) video.contentHint = h;
  };

  // --- Render -------------------------------------------------------------------------------
  const inviteUrl = `${window.location.origin}/r/${roomId}`;
  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      notify('Invite link copied. Send it to up to 3 friends.');
    } catch {
      window.prompt('Copy this invite link:', inviteUrl);
    }
  };

  if (status === 'error' || status === 'kicked') {
    return (
      <div className="center-card">
        <h2>{status === 'kicked' ? 'You left this tab' : "Can't join this room"}</h2>
        <p>{error}</p>
        <button className="btn primary" onClick={onLeave}>
          Back to start
        </button>
      </div>
    );
  }
  if (!state || !selfId) {
    return (
      <div className="center-card">
        <div className="spinner" />
        <p>Joining room…</p>
      </div>
    );
  }

  const host = participants.find((p) => p.id === state.hostId);
  const sharer = participants.find((p) => p.id === state.share?.sharerId);
  const isSharer = state.share?.sharerId === selfId;
  const screenForGuest = remoteScreen && remoteScreen.peerId === state.share?.sharerId ? remoteScreen.stream : null;

  return (
    <div className="room">
      <header className="room-header">
        <a className="brand" href="/" onClick={(e) => (e.preventDefault(), onLeave())}>
          <img src="/favicon.svg" alt="" /> WatchTogether
        </a>
        <span className="room-code" title="Room code">
          {roomId}
        </span>
        <span className="count">
          {participants.length}/4 here
        </span>
        <span className="spacer" />
        {status === 'reconnecting' && <span className="badge warn">Reconnecting…</span>}
        <button className="btn" onClick={copyInvite} data-testid="copy-invite">
          🔗 Copy invite link
        </button>
      </header>

      <main className="room-main">
        <section className="stage" data-mode={state.mode}>
          {state.mode === 'share' && state.share ? (
            <ShareStage
              share={state.share}
              isSharer={isSharer}
              sharerName={sharer?.name ?? 'The host'}
              stream={isSharer ? localShare : screenForGuest}
              connection={isSharer ? null : statuses[`screen:${state.share.sharerId}`] ?? null}
              hint={hint}
              onHintChange={changeHint}
              onStop={() => stopShare()}
            />
          ) : state.mode === 'link' && state.link ? (
            <LinkStage
              link={state.link}
              isHost={isHost}
              socket={socket}
              clock={clock}
              onShareTabInstead={startShare}
              onStop={() => socket.emit('link:clear')}
            />
          ) : (
            <IdleStage
              isHost={isHost}
              hostName={host?.name ?? null}
              socket={socket}
              canShare={canShareScreen()}
              onShare={startShare}
              onCopyInvite={copyInvite}
              inviteUrl={inviteUrl}
            />
          )}
          <MemeOverlay reactions={memes} />
        </section>

        <aside className="sidebar">
          <Participants
            participants={participants}
            selfId={selfId}
            hostId={state.hostId}
            isHost={isHost}
            voiceStreams={voiceStreams}
            micStream={micStream}
            statuses={statuses}
            lastReaction={lastReaction}
            onMakeHost={(id) => socket.emit('host:transfer', id)}
          />
          <label className="volume block">
            Voice volume
            <input type="range" min={0} max={1} step={0.05} value={voiceVolume} onChange={(e) => setVoiceVolume(Number(e.target.value))} />
          </label>
          {cameraOn && (
            <GesturePanel
              onGesture={(kind) => sendReaction(kind, 'gesture')}
              onClose={(err) => {
                setCameraOn(false);
                socket.emit('profile:update', { gestures: false });
                if (err) notify(err, 'warn');
              }}
            />
          )}
        </aside>
      </main>

      <footer className="controls" aria-label="Room controls">
        <div className="control-group">
          <button
            className={`btn control ${micStream ? 'on' : ''}`}
            onClick={() => setMic(!micStream)}
            disabled={micBusy}
            aria-pressed={!!micStream}
            data-testid="mic-toggle"
          >
            {micStream ? '🎙️ Mic on' : '🎙️ Mic off'}
          </button>
          <button
            className={`btn control ${cameraOn ? 'on' : ''}`}
            onClick={() => {
              const next = !cameraOn;
              setCameraOn(next);
              socket.emit('profile:update', { gestures: next });
            }}
            aria-pressed={cameraOn}
            title="Camera is used only on your device to detect hand gestures. Video is never sent."
            data-testid="camera-toggle"
          >
            {cameraOn ? '📷 Gestures on' : '📷 Gestures off'}
          </button>
          {isHost && (
            <button
              className={`btn control ${localShare ? 'on' : ''}`}
              onClick={() => (localShare ? stopShare() : startShare())}
              disabled={!canShareScreen()}
              title={canShareScreen() ? 'Share a tab, window, or screen' : "This browser can't share its screen"}
              data-testid="share-toggle"
            >
              {localShare ? '🖥️ Stop sharing' : '🖥️ Share screen'}
            </button>
          )}
        </div>

        <div className="control-group reactions" role="group" aria-label="Reactions">
          {REACTION_KINDS.map((k) => (
            <button
              key={k}
              className="btn reaction"
              style={{ '--accent': REACTIONS[k].color } as CSSProperties}
              onClick={() => sendReaction(k, 'button')}
              disabled={coolingDown}
              title={REACTIONS[k].gestureLabel ? `${REACTIONS[k].label} (gesture: ${REACTIONS[k].gestureLabel})` : `${REACTIONS[k].label} (button only)`}
              data-testid={`react-${k}`}
            >
              <span>{REACTIONS[k].emoji}</span> {REACTIONS[k].label}
            </button>
          ))}
        </div>

        <div className="control-group">
          <button className="btn danger" onClick={onLeave}>
            Leave
          </button>
        </div>
      </footer>

      {Object.entries(voiceStreams).map(([id, stream]) => (
        <RemoteAudio key={id} peerId={id} stream={stream} volume={voiceVolume} />
      ))}

      <div className="toasts" role="status">
        {notices.map((n) => (
          <div key={n.id} className={`toast ${n.tone}`}>
            {n.text}
          </div>
        ))}
      </div>
    </div>
  );
}
