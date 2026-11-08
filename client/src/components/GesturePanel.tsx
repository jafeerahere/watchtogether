import { useEffect, useRef, useState } from 'react';
import { REACTIONS, REACTION_KINDS, type ReactionKind } from '../../../shared/reactions';
import { GestureDetector, type DetectorOutput } from '../gestures/detector';
import { loadModels, runRecognition } from '../gestures/engine';
import { describeMediaError, getCameraStream } from '../rtc/media';

interface Props {
  /** Called when a held gesture fires. Returns false if the shared cooldown blocked it. */
  onGesture: (kind: ReactionKind) => boolean;
  onClose: (error?: string) => void;
}

type Phase = 'camera' | 'model' | 'ready' | 'error';

/** Local-only camera preview + on-device gesture recognition. Mounted only while the camera is on. */
export function GesturePanel({ onGesture, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [phase, setPhase] = useState<Phase>('camera');
  const [output, setOutput] = useState<DetectorOutput>({ holding: null, fired: null, coolingDown: false });
  const [seen, setSeen] = useState<string | null>(null);
  const [chinAvailable, setChinAvailable] = useState(true);
  const [flash, setFlash] = useState<ReactionKind | null>(null);
  const onGestureRef = useRef(onGesture);
  onGestureRef.current = onGesture;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stop: (() => void) | null = null;
    let cancelled = false;
    const detector = new GestureDetector();

    (async () => {
      try {
        stream = await getCameraStream();
      } catch (err) {
        if (!cancelled) onCloseRef.current(describeMediaError(err, 'camera'));
        return;
      }
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = videoRef.current!;
      video.srcObject = stream;
      await video.play().catch(() => undefined);
      setPhase('model');
      let models;
      try {
        models = await loadModels();
      } catch (err) {
        console.error(err);
        if (!cancelled) setPhase('error');
        return;
      }
      if (cancelled) return;
      setPhase('ready');
      setChinAvailable(!!models.faceDetector);
      let lastUi = 0;
      stop = runRecognition(models, video, (frame, now) => {
        const out = detector.update(frame.category, frame.score, now);
        if (out.fired) {
          const sent = onGestureRef.current(out.fired);
          if (sent) {
            setFlash(out.fired);
            setTimeout(() => setFlash(null), 900);
          }
        }
        // Throttle React updates a little.
        if (out.fired || now - lastUi > 80) {
          lastUi = now;
          setOutput(out);
          setSeen(frame.category);
        }
      });
    })();

    return () => {
      cancelled = true;
      stop?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const holding = output.holding;
  const ring = holding ? holding.progress : 0;

  return (
    <div className="gesture-panel" data-testid="gesture-panel" data-phase={phase}>
      <div className="gesture-cam">
        <video ref={videoRef} muted playsInline className="mirror" />
        <svg className="hold-ring" viewBox="0 0 100 100" aria-hidden>
          <circle cx="50" cy="50" r="44" className="track" />
          <circle
            cx="50"
            cy="50"
            r="44"
            className="progress"
            style={{ strokeDasharray: `${ring * 276.5} 276.5`, stroke: holding ? REACTIONS[holding.kind].color : undefined }}
          />
        </svg>
        {holding && <div className="hold-label">{REACTIONS[holding.kind].emoji} hold…</div>}
        {flash && <div className="hold-label fired">{REACTIONS[flash].emoji} sent!</div>}
        <span className="cam-private" title="Video stays on this device. Only the reaction is sent.">
          🔒 on-device
        </span>
      </div>
      <div className="gesture-status">
        {phase === 'camera' && 'Starting camera…'}
        {phase === 'model' && 'Loading gesture model…'}
        {phase === 'error' && "Gesture model couldn't load. Use the reaction buttons instead."}
        {phase === 'ready' &&
          (output.coolingDown ? 'Cooling down…' : seen ? `Seeing: ${seen === 'Chin_Hands' ? 'hands on chin' : seen.replace('_', ' ').toLowerCase()}` : 'Watching for gestures')}
      </div>
      <ul className="gesture-legend">
        {REACTION_KINDS.filter((k) => REACTIONS[k].gesture).map((k) => (
          <li key={k} className={REACTIONS[k].gesture === 'Chin_Hands' && !chinAvailable ? 'unavailable' : undefined}>
            <span>{REACTIONS[k].emoji}</span> {REACTIONS[k].gestureLabel} → <b>{REACTIONS[k].label}</b>
          </li>
        ))}
      </ul>
      <p className="hint">Hold a gesture for about a second. For Wow!, keep your face in view.</p>
      {!chinAvailable && phase === 'ready' && <p className="hint">Face model didn't load, so the chin pose is off. Use the Wow! button.</p>}
    </div>
  );
}
