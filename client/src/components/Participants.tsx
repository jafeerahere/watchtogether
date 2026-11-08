import { useEffect, useRef, useState } from 'react';
import type { Participant, ReactionEvent } from '../../../shared/protocol';
import { REACTIONS } from '../../../shared/reactions';
import { useSpeaking } from '../hooks/useAudioLevel';
import type { LinkStatus } from '../rtc/PeerMesh';

interface Props {
  participants: Participant[];
  selfId: string;
  hostId: string | null;
  isHost: boolean;
  voiceStreams: Record<string, MediaStream>;
  micStream: MediaStream | null;
  statuses: Record<string, LinkStatus>;
  lastReaction: Record<string, ReactionEvent>;
  onMakeHost: (id: string) => void;
}

export function Participants(props: Props) {
  const { participants } = props;
  return (
    <section className="participants" aria-label="People in this room">
      <h3>
        People <span className="hint">({participants.length}/4)</span>
      </h3>
      <ul>
        {participants.map((p) => (
          <ParticipantRow key={p.id} p={p} {...props} />
        ))}
        {Array.from({ length: Math.max(0, 4 - participants.length) }, (_, i) => (
          <li key={`empty-${i}`} className="participant empty">
            <span className="avatar">+</span>
            <span className="hint">Open seat</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function routeLabel(status: LinkStatus | undefined): string {
  if (!status) return '';
  if (status.state !== 'connected') return status.state;
  if (status.route === 'relay') return 'connected · via TURN';
  if (status.route === 'host') return 'connected · local network';
  if (status.route === 'srflx' || status.route === 'prflx') return 'connected · direct';
  return 'connected';
}

function ParticipantRow({ p, selfId, hostId, isHost, voiceStreams, micStream, statuses, lastReaction, onMakeHost }: Props & { p: Participant }) {
  const self = p.id === selfId;
  const stream = self ? micStream : voiceStreams[p.id] ?? null;
  const speaking = useSpeaking(stream, p.mic);
  const voice = statuses[`voice:${p.id}`];
  const reaction = useRecent(lastReaction[p.id], p.id);

  return (
    <li
      className={`participant ${speaking ? 'speaking' : ''}`}
      data-testid="participant"
      data-name={p.name}
      data-voice-state={self ? 'self' : voice?.state ?? 'none'}
      data-has-audio={!self && voiceStreams[p.id] ? 'yes' : 'no'}
    >
      <span className="avatar" aria-hidden>
        {p.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="p-main">
        <div className="p-name">
          {p.name}
          {self && <span className="hint"> (you)</span>}
          {p.id === hostId && (
            <span className="badge host" title="Host controls what's playing">
              👑 host
            </span>
          )}
        </div>
        <div className="p-status">
          <span title={p.mic ? 'Mic on' : 'Mic off'}>{p.mic ? '🎙️' : '🔇'}</span>
          {p.gestures && <span title="Gesture camera on (on-device)">📷</span>}
          {!self && p.mic && voice && <span className={`conn conn-${voice.state}`}>{routeLabel(voice)}</span>}
          {!self && p.mic && !voice && <span className="conn">waiting for audio…</span>}
        </div>
        {p.playbackIssue && (
          <div className="p-issue" title={p.playbackIssue}>
            ⚠ can't play the link: {p.playbackIssue}
          </div>
        )}
      </div>
      {reaction && (
        <span className="p-reaction" style={{ background: REACTIONS[reaction.kind].color }} title={REACTIONS[reaction.kind].label}>
          {REACTIONS[reaction.kind].emoji}
        </span>
      )}
      {isHost && !self && (
        <button className="btn tiny" onClick={() => onMakeHost(p.id)} title="Hand over host controls">
          Make host
        </button>
      )}
    </li>
  );
}

/** Keep a reaction chip visible next to a name for a while ("Wait, doubt!" stays longer, like a raised hand). */
function useRecent(reaction: ReactionEvent | undefined, key: string): ReactionEvent | null {
  const [visible, setVisible] = useState<ReactionEvent | null>(null);
  useEffect(() => {
    if (!reaction) return;
    setVisible(reaction);
    const t = setTimeout(() => setVisible(null), reaction.kind === 'wait-doubt' ? 20_000 : 6_000);
    return () => clearTimeout(t);
  }, [reaction, key]);
  return visible;
}

/** Plays one person's voice. Kept separate from the shared-screen audio element. */
export function RemoteAudio({ peerId, stream, volume }: { peerId: string; stream: MediaStream; volume: number }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    el.play().catch(() => undefined);
  }, [stream]);
  useEffect(() => {
    if (ref.current) ref.current.volume = volume;
  }, [volume]);
  return <audio ref={ref} autoPlay data-peer={peerId} data-testid="voice-audio" />;
}
