import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { ReactionEvent } from '../../../shared/protocol';
import { memeDuration, REACTIONS, REACTION_KINDS, type ReactionMeta } from '../../../shared/reactions';

const VIDEO_MEMES = REACTION_KINDS.map((k) => REACTIONS[k]).filter((m) => m.video);

/** Full-stage meme cards, shown to everyone in the room when someone reacts. */
export function MemeOverlay({ reactions }: { reactions: ReactionEvent[] }) {
  return (
    <div className="meme-layer" aria-live="polite">
      {/* Warm the cache so video memes start instantly. */}
      <div hidden>
        {VIDEO_MEMES.map((m) => (
          <video key={m.kind} src={m.video} preload="auto" muted />
        ))}
      </div>
      {reactions.map((r, i) => {
        const meta = REACTIONS[r.kind];
        return (
          <div
            key={r.id}
            className={`meme meme-${meta.animation} ${meta.video ? 'meme-has-video' : ''}`}
            data-testid="meme"
            data-kind={r.kind}
            style={
              {
                '--meme-color': meta.color,
                '--offset': `${(i % 3) * 14 - 14}%`,
                '--meme-duration': `${memeDuration(r.kind)}ms`,
              } as CSSProperties
            }
          >
            {meta.video ? (
              <MemeVideo meta={meta} />
            ) : meta.image ? (
              <img src={meta.image} alt="" className="meme-img" />
            ) : (
              <div className="meme-emoji">{meta.emoji}</div>
            )}
            <div className="meme-caption">{meta.caption}</div>
            <div className="meme-from">
              {r.fromName}
              {r.via === 'gesture' ? ' · via gesture' : ''}
            </div>
            {meta.animation === 'rocket' && (
              <div className="confetti" aria-hidden>
                {Array.from({ length: 14 }, (_, j) => (
                  <i key={j} style={{ '--i': j } as CSSProperties} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function MemeVideo({ meta }: { meta: ReactionMeta }) {
  const ref = useRef<HTMLVideoElement>(null);
  // Clips aren't shipped in the public repo (see client/public/memes/README.md); fall back to the emoji card.
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.volume = 0.85;
    // Everyone clicked "Join", so sound is normally allowed; if the browser still blocks it, play muted.
    v.play().catch(() => {
      v.muted = true;
      void v.play().catch(() => undefined);
    });
  }, []);
  if (missing) return <div className="meme-emoji" data-testid="meme-fallback">{meta.emoji}</div>;
  return (
    <video
      ref={ref}
      className="meme-video"
      src={meta.video}
      poster={meta.poster}
      playsInline
      preload="auto"
      data-testid="meme-video"
      onError={() => setMissing(true)}
    />
  );
}
