export async function getMicTrack(): Promise<MediaStreamTrack> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  return stream.getAudioTracks()[0];
}

export function canShareScreen(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;
}

export async function captureDisplay(): Promise<MediaStream> {
  // Extra Chromium options aren't in TypeScript's DOM types yet.
  const options: DisplayMediaStreamOptions & Record<string, unknown> = {
    video: { frameRate: { ideal: 30, max: 30 } },
    audio: {
      // Raw content audio: voice processing would mangle music and lecture audio.
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      suppressLocalAudioPlayback: false,
    } as MediaTrackConstraints,
    selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include',
    systemAudio: 'include',
  };
  return navigator.mediaDevices.getDisplayMedia(options);
}

export function displaySurface(stream: MediaStream): string | null {
  const settings = stream.getVideoTracks()[0]?.getSettings() as MediaTrackSettings & { displaySurface?: string };
  return settings?.displaySurface ?? null;
}

export function surfaceLabel(surface: string | null): string {
  switch (surface) {
    case 'browser':
      return 'a browser tab';
    case 'window':
      return 'a window';
    case 'monitor':
      return 'their screen';
    default:
      return 'their screen';
  }
}

type Browser = 'chromium' | 'firefox' | 'safari' | 'other';

function detectBrowser(): Browser {
  const ua = navigator.userAgent;
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\/|Edg\//.test(ua)) return 'chromium';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}

/** Explain to the sharer why their capture has no audio, based on what they picked and the platform. */
export function noShareAudioReason(surface: string | null): string {
  const browser = detectBrowser();
  const mac = /Mac OS X|Macintosh/.test(navigator.userAgent);
  if (browser === 'firefox' || browser === 'safari') {
    return `${browser === 'firefox' ? 'Firefox' : 'Safari'} doesn't capture audio when sharing. Use Chrome or Edge to share sound.`;
  }
  if (surface === 'window') return "Browsers can't capture a single window's audio. Share a tab (or your entire screen on Windows/ChromeOS) instead.";
  if (surface === 'monitor') {
    return mac
      ? "macOS doesn't let browsers capture system audio. Share a tab instead to include sound."
      : 'System audio was not included. Re-share and tick "Also share system audio" in the picker.';
  }
  if (surface === 'browser') return 'Tab audio was not included. Re-share and keep "Also share tab audio" switched on in the picker.';
  return 'No audio was captured with this share.';
}

export async function getCameraStream(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, facingMode: 'user' },
    audio: false,
  });
}

export function describeMediaError(err: unknown, what: 'microphone' | 'camera' | 'screen'): string {
  const name = (err as { name?: string })?.name;
  if (!window.isSecureContext) return `The ${what} needs HTTPS (or localhost). Open this room over https://.`;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return what === 'screen' ? 'Screen sharing was cancelled or blocked.' : `Permission to use the ${what} was denied. Allow it in the address bar's site settings.`;
    case 'NotFoundError':
    case 'OverconstrainedError':
      return `No ${what} was found.`;
    case 'NotReadableError':
    case 'AbortError':
      return `The ${what} is busy or unavailable (another app may be using it).`;
    default:
      return `Couldn't start the ${what}${name ? ` (${name})` : ''}.`;
  }
}
