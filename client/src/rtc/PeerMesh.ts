// Full-mesh WebRTC for ≤ 4 people, two independent channels per pair:
//   voice  – mic audio, both directions, one RTCPeerConnection per pair.
//   screen – the host's tab/window/screen (video + optional shared audio), host → each guest.
// Keeping them on separate connections keeps shared audio separate from voice chat end to end
// (own <video> element and volume on the receiving side; voice processing never touches it).
// Negotiation uses the "perfect negotiation" pattern so either side can (re)negotiate safely.

import type { IceConfig, SignalChannel, SignalPayload } from '../../../shared/protocol';
import type { RoomSocket } from '../lib/socket';

export type RouteType = 'host' | 'srflx' | 'prflx' | 'relay' | 'unknown';

export interface LinkStatus {
  state: RTCPeerConnectionState;
  route: RouteType | null;
}

interface Callbacks {
  onVoiceStream: (peerId: string, stream: MediaStream | null) => void;
  onScreenStream: (peerId: string, stream: MediaStream | null) => void;
  onStatus: (peerId: string, channel: SignalChannel, status: LinkStatus | null) => void;
}

interface PeerLink {
  peerId: string;
  channel: SignalChannel;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  queue: Promise<void>;
  audioSender: RTCRtpSender | null;
  restartTimer: ReturnType<typeof setTimeout> | null;
}

const SCREEN_MAX_BITRATE = 2_500_000;

/** Ask for stereo, higher-bitrate Opus on the screen channel so shared music/video audio sounds right. */
function tuneScreenSdp(sdp: string): string {
  const m = sdp.match(/a=rtpmap:(\d+) opus\/48000\/2/i);
  if (!m) return sdp;
  const pt = m[1];
  return sdp.replace(new RegExp(`a=fmtp:${pt} ([^\\r\\n]*)`), (line, params: string) => {
    if (params.includes('stereo=1')) return line;
    return `a=fmtp:${pt} ${params};stereo=1;sprop-stereo=1;maxaveragebitrate=128000`;
  });
}

export class PeerMesh {
  private links = new Map<string, PeerLink>();
  private micTrack: MediaStreamTrack | null = null;
  private micStream = new MediaStream();
  private screenStream: MediaStream | null = null;
  private closed = false;

  constructor(
    private readonly socket: RoomSocket,
    readonly selfId: string,
    private readonly ice: IceConfig,
    private readonly cb: Callbacks,
  ) {
    socket.on('signal', this.onSignal);
  }

  private key(channel: SignalChannel, peerId: string) {
    return `${channel}:${peerId}`;
  }

  /** Keep links in step with the participant list. `sharerId` is who is screen sharing right now. */
  sync(participantIds: string[], sharerId: string | null) {
    if (this.closed) return;
    const others = new Set(participantIds.filter((id) => id !== this.selfId));
    for (const link of [...this.links.values()]) {
      const gone = !others.has(link.peerId);
      // A screen link is stale when the peer left, or when neither side is the sharer any more.
      const staleScreen = link.channel === 'screen' && sharerId !== this.selfId && sharerId !== link.peerId;
      if (gone || staleScreen) this.close(link);
    }
    for (const id of others) {
      // Voice links are created eagerly only if we have something to send; otherwise the remote side's
      // offer creates them on demand. This avoids empty connections between people with mics off.
      if (this.micTrack && !this.links.has(this.key('voice', id))) this.ensure('voice', id);
      if (this.screenStream && sharerId === this.selfId && !this.links.has(this.key('screen', id))) {
        this.ensure('screen', id);
      }
    }
  }

  async setMicTrack(track: MediaStreamTrack | null, participantIds: string[]) {
    this.micTrack = track;
    for (const t of this.micStream.getTracks()) this.micStream.removeTrack(t);
    if (track) this.micStream.addTrack(track);
    for (const id of participantIds) if (id !== this.selfId && track) this.ensure('voice', id);
    for (const link of this.links.values()) {
      if (link.channel !== 'voice') continue;
      if (link.audioSender) await link.audioSender.replaceTrack(track);
      else if (track) link.audioSender = link.pc.addTrack(track, this.micStream);
    }
  }

  startScreenShare(stream: MediaStream, participantIds: string[]) {
    this.stopScreenShare();
    this.screenStream = stream;
    for (const id of participantIds) if (id !== this.selfId) this.ensure('screen', id);
  }

  stopScreenShare() {
    this.screenStream = null;
    for (const link of [...this.links.values()]) if (link.channel === 'screen') this.close(link);
  }

  /** Reconnect screen links (e.g. after the sharer's tracks changed). */
  hasScreenStream() {
    return this.screenStream !== null;
  }

  private ensure(channel: SignalChannel, peerId: string): PeerLink {
    const existing = this.links.get(this.key(channel, peerId));
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.ice.iceServers, iceTransportPolicy: this.ice.iceTransportPolicy });
    const link: PeerLink = {
      peerId,
      channel,
      pc,
      polite: this.selfId > peerId,
      makingOffer: false,
      ignoreOffer: false,
      queue: Promise.resolve(),
      audioSender: null,
      restartTimer: null,
    };
    this.links.set(this.key(channel, peerId), link);

    const send = (data: SignalPayload) => this.socket.emit('signal', { to: peerId, channel, data });

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) send({ candidate: candidate.toJSON() });
    };

    pc.onnegotiationneeded = async () => {
      try {
        link.makingOffer = true;
        if (channel === 'screen') {
          const offer = await pc.createOffer();
          if (pc.signalingState !== 'stable') return;
          await pc.setLocalDescription({ type: 'offer', sdp: tuneScreenSdp(offer.sdp ?? '') });
        } else {
          await pc.setLocalDescription();
        }
        send({ description: pc.localDescription!.toJSON() });
      } catch (err) {
        console.warn(`[rtc] ${channel} offer to ${peerId} failed`, err);
      } finally {
        link.makingOffer = false;
      }
    };

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      if (channel === 'voice') this.cb.onVoiceStream(peerId, stream);
      else this.cb.onScreenStream(peerId, stream);
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      this.cb.onStatus(peerId, channel, { state, route: null });
      if (state === 'connected') {
        if (link.restartTimer) clearTimeout(link.restartTimer);
        void routeType(pc).then((route) => {
          if (pc.connectionState === 'connected') this.cb.onStatus(peerId, channel, { state, route });
        });
      } else if (state === 'failed') {
        pc.restartIce();
      } else if (state === 'disconnected') {
        // Often recovers by itself; restart ICE if it doesn't within a few seconds.
        if (link.restartTimer) clearTimeout(link.restartTimer);
        link.restartTimer = setTimeout(() => {
          if (pc.connectionState === 'disconnected') pc.restartIce();
        }, 4000);
      }
    };
    this.cb.onStatus(peerId, channel, { state: pc.connectionState, route: null });

    if (channel === 'voice' && this.micTrack) {
      link.audioSender = pc.addTrack(this.micTrack, this.micStream);
    }
    if (channel === 'screen' && this.screenStream) {
      for (const track of this.screenStream.getTracks()) {
        pc.addTransceiver(track, {
          direction: 'sendonly',
          streams: [this.screenStream],
          sendEncodings: track.kind === 'video' ? [{ maxBitrate: SCREEN_MAX_BITRATE }] : [{ maxBitrate: 128_000 }],
        });
      }
    }
    return link;
  }

  private onSignal = (msg: { from: string; channel: SignalChannel; data: SignalPayload }) => {
    if (this.closed) return;
    const { from, channel, data } = msg;
    if (!data || (channel !== 'voice' && channel !== 'screen')) return;
    // Offers create links on demand (e.g. a guest receiving the host's screen, or a voice offer
    // from someone who turned their mic on). Other messages for unknown links are stale: drop them.
    let link = this.links.get(this.key(channel, from));
    if (!link) {
      if (data.description?.type !== 'offer') return;
      link = this.ensure(channel, from);
    }
    const l = link;
    l.queue = l.queue.then(() => this.handle(l, data)).catch((err) => console.warn(`[rtc] ${channel} signal from ${from}`, err));
  };

  private async handle(link: PeerLink, data: SignalPayload) {
    const { pc } = link;
    if (pc.signalingState === 'closed') return;
    if (data.description) {
      const description = data.description;
      const collision = description.type === 'offer' && (link.makingOffer || pc.signalingState !== 'stable');
      link.ignoreOffer = !link.polite && collision;
      if (link.ignoreOffer) return;
      await pc.setRemoteDescription(description);
      if (description.type === 'offer') {
        if (link.channel === 'screen') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription({ type: 'answer', sdp: tuneScreenSdp(answer.sdp ?? '') });
        } else {
          await pc.setLocalDescription();
        }
        this.socket.emit('signal', { to: link.peerId, channel: link.channel, data: { description: pc.localDescription!.toJSON() } });
      }
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!link.ignoreOffer) throw err;
      }
    }
  }

  private close(link: PeerLink) {
    if (link.restartTimer) clearTimeout(link.restartTimer);
    link.pc.onconnectionstatechange = null;
    link.pc.close();
    this.links.delete(this.key(link.channel, link.peerId));
    if (link.channel === 'voice') this.cb.onVoiceStream(link.peerId, null);
    else this.cb.onScreenStream(link.peerId, null);
    this.cb.onStatus(link.peerId, link.channel, null);
  }

  /** Expose the screen-channel senders so the host can tweak encoding (e.g. text vs motion). */
  screenSenders(): RTCRtpSender[] {
    return [...this.links.values()].filter((l) => l.channel === 'screen').flatMap((l) => l.pc.getSenders());
  }

  dispose() {
    this.closed = true;
    this.socket.off('signal', this.onSignal);
    for (const link of [...this.links.values()]) this.close(link);
  }
}

/** Which kind of path the connection ended up on: direct (host/srflx) or through TURN (relay). */
export async function routeType(pc: RTCPeerConnection): Promise<RouteType> {
  try {
    const stats = await pc.getStats();
    let pairId: string | undefined;
    stats.forEach((s) => {
      if (s.type === 'transport' && s.selectedCandidatePairId) pairId = s.selectedCandidatePairId;
    });
    let pair: { localCandidateId?: string } | undefined;
    stats.forEach((s) => {
      if (s.type === 'candidate-pair' && (s.id === pairId || (!pairId && s.nominated && s.state === 'succeeded'))) pair = s;
    });
    const local = pair?.localCandidateId ? stats.get(pair.localCandidateId) : undefined;
    return (local?.candidateType as RouteType | undefined) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
