import { useEffect, useState } from 'react';

let ctx: AudioContext | null = null;

function audioContext(): AudioContext {
  ctx ??= new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** True while the stream's audio is above a speaking threshold. */
export function useSpeaking(stream: MediaStream | null, enabled = true): boolean {
  const [speaking, setSpeaking] = useState(false);
  useEffect(() => {
    if (!stream || !enabled || stream.getAudioTracks().length === 0) {
      setSpeaking(false);
      return;
    }
    const ac = audioContext();
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let last = false;
    let quietSince = 0;
    const timer = setInterval(() => {
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const v of data) sum += (v - 128) ** 2;
      const rms = Math.sqrt(sum / data.length) / 128;
      const now = performance.now();
      let next = last;
      if (rms > 0.04) {
        next = true;
        quietSince = now;
      } else if (now - quietSince > 350) next = false;
      if (next !== last) {
        last = next;
        setSpeaking(next);
      }
    }, 100);
    return () => {
      clearInterval(timer);
      source.disconnect();
    };
  }, [stream, enabled]);
  return speaking;
}
