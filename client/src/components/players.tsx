import { useEffect, useImperativeHandle, useRef, forwardRef } from 'react';
import { mediaErrorReason, youTubeErrorReason } from '../../../shared/links';

/** Minimal surface the sync engine needs from any player. */
export interface PlayerHandle {
  getTime(): number;
  isPlaying(): boolean;
  play(): Promise<void>;
  pause(): void;
  seek(seconds: number): void;
  getRate(): number;
  setRate(rate: number): void;
  setVolume(volume: number): void;
  /** Subscribe to user-visible state changes (play/pause/seek) for faster host updates. */
  onChange(fn: () => void): () => void;
}

interface PlayerProps {
  isHost: boolean;
  onReady: (handle: PlayerHandle) => void;
  onError: (reason: string) => void;
}

// ---------------------------------------------------------------------------------------------
// Direct media files (<video> handles audio-only files too)

export const FilePlayer = forwardRef<HTMLVideoElement, PlayerProps & { url: string; mediaType: 'video' | 'audio' }>(
  function FilePlayer({ url, mediaType, isHost, onReady, onError }, ref) {
    const videoRef = useRef<HTMLVideoElement>(null);
    useImperativeHandle(ref, () => videoRef.current!, []);

    useEffect(() => {
      const v = videoRef.current;
      if (!v) return;
      const listeners = new Set<() => void>();
      const fire = () => listeners.forEach((fn) => fn());
      const events = ['play', 'pause', 'seeked', 'ratechange', 'ended'];
      events.forEach((e) => v.addEventListener(e, fire));
      const handle: PlayerHandle = {
        getTime: () => v.currentTime,
        isPlaying: () => !v.paused && !v.ended,
        play: () => v.play(),
        pause: () => v.pause(),
        seek: (t) => {
          v.currentTime = t;
        },
        getRate: () => v.playbackRate,
        setRate: (r) => {
          v.playbackRate = r;
        },
        setVolume: (vol) => {
          v.volume = Math.min(1, Math.max(0, vol));
        },
        onChange: (fn) => {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      };
      let ready = false;
      const markReady = () => {
        if (ready) return;
        ready = true;
        onReady(handle);
      };
      const handleError = () => onError(mediaErrorReason(v.error?.code));
      v.addEventListener('loadedmetadata', markReady);
      v.addEventListener('error', handleError);
      if (v.readyState >= 1) markReady();
      return () => {
        events.forEach((e) => v.removeEventListener(e, fire));
        v.removeEventListener('loadedmetadata', markReady);
        v.removeEventListener('error', handleError);
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url]);

    return (
      <div className={`file-player ${mediaType === 'audio' ? 'is-audio' : ''}`}>
        {mediaType === 'audio' && <div className="audio-art" aria-hidden>🎧</div>}
        <video
          ref={videoRef}
          src={url}
          controls={isHost}
          playsInline
          preload="auto"
          data-testid="link-video"
          onContextMenu={isHost ? undefined : (e) => e.preventDefault()}
        />
      </div>
    );
  },
);

// ---------------------------------------------------------------------------------------------
// YouTube IFrame API

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  setVolume(volume: number): void;
  destroy(): void;
}

interface YTNamespace {
  Player: new (el: HTMLElement, opts: unknown) => YTPlayer;
}

declare global {
  interface Window {
    YT?: YTNamespace;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let ytApi: Promise<YTNamespace> | null = null;

function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  ytApi ??= new Promise<YTNamespace>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve(window.YT!);
    };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api';
    script.onerror = () => {
      ytApi = null;
      reject(new Error('blocked'));
    };
    document.head.append(script);
  });
  return ytApi;
}

const YT_PLAYING = 1;
const YT_BUFFERING = 3;

export function YouTubePlayer({ videoId, startSeconds, isHost, onReady, onError }: PlayerProps & { videoId: string; startSeconds: number }) {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let player: YTPlayer | null = null;
    let cancelled = false;
    const listeners = new Set<() => void>();
    const target = document.createElement('div');
    mountRef.current?.append(target);

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return;
        player = new YT.Player(target, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            controls: isHost ? 1 : 0,
            disablekb: isHost ? 0 : 1,
            rel: 0,
            playsinline: 1,
            start: Math.floor(startSeconds),
            origin: window.location.origin,
            enablejsapi: 1,
          },
          events: {
            onReady: () => {
              if (cancelled || !player) return;
              const p = player;
              onReady({
                getTime: () => p.getCurrentTime() ?? 0,
                isPlaying: () => [YT_PLAYING, YT_BUFFERING].includes(p.getPlayerState()),
                play: () =>
                  new Promise<void>((resolve, reject) => {
                    p.playVideo();
                    setTimeout(() => ([YT_PLAYING, YT_BUFFERING].includes(p.getPlayerState()) ? resolve() : reject(new Error('blocked'))), 1500);
                  }),
                pause: () => p.pauseVideo(),
                seek: (t) => p.seekTo(t, true),
                getRate: () => p.getPlaybackRate() ?? 1,
                setRate: (r) => p.setPlaybackRate(r),
                setVolume: (v) => p.setVolume(Math.round(v * 100)),
                onChange: (fn) => {
                  listeners.add(fn);
                  return () => listeners.delete(fn);
                },
              });
            },
            onStateChange: () => listeners.forEach((fn) => fn()),
            onPlaybackRateChange: () => listeners.forEach((fn) => fn()),
            onError: (e: { data: number }) => onError(youTubeErrorReason(e.data)),
          },
        });
      })
      .catch(() => onError("YouTube's player couldn't load. An ad/tracker blocker or network filter may be blocking youtube.com."));

    return () => {
      cancelled = true;
      try {
        player?.destroy();
      } catch {
        /* already gone */
      }
      target.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, isHost]);

  return <div className="yt-player" ref={mountRef} data-testid="youtube-player" />;
}
