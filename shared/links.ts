// Decide whether a pasted link can be played in sync inside the room, and explain why not when it can't.

export type MediaSourceInfo =
  | { kind: 'youtube'; videoId: string; startSeconds: number }
  | { kind: 'file'; url: string; mediaType: 'video' | 'audio' };

export type LinkCheck =
  | { ok: true; source: MediaSourceInfo; note?: string }
  | { ok: false; reason: string; /** The host may still try it as a direct media file. */ canTryAsFile: boolean };

const VIDEO_EXT = ['mp4', 'm4v', 'webm', 'ogv', 'mov'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'oga', 'ogg', 'opus', 'wav', 'flac'];

const DRM_HOSTS: Record<string, string> = {
  'netflix.com': 'Netflix',
  'primevideo.com': 'Prime Video',
  'disneyplus.com': 'Disney+',
  'hulu.com': 'Hulu',
  'max.com': 'Max',
  'hbomax.com': 'Max',
  'tv.apple.com': 'Apple TV',
  'hotstar.com': 'Hotstar',
  'jiocinema.com': 'JioCinema',
  'crunchyroll.com': 'Crunchyroll',
  'peacocktv.com': 'Peacock',
  'paramountplus.com': 'Paramount+',
  'spotify.com': 'Spotify',
};

const PAGE_HOSTS: Record<string, string> = {
  'vimeo.com': 'Vimeo',
  'twitch.tv': 'Twitch',
  'dailymotion.com': 'Dailymotion',
  'facebook.com': 'Facebook',
  'instagram.com': 'Instagram',
  'tiktok.com': 'TikTok',
  'x.com': 'X',
  'twitter.com': 'X',
  'coursera.org': 'Coursera',
  'udemy.com': 'Udemy',
  'docs.google.com': 'Google Docs/Slides',
  'canva.com': 'Canva',
};

function hostMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function parseYouTubeTime(raw: string | null): number {
  if (!raw) return 0;
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = raw.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!m) return 0;
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function youTubeId(url: URL): string | null {
  const host = url.hostname.replace(/^www\.|^m\.|^music\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.slice(1).split('/')[0] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    if (url.pathname === '/watch') id = url.searchParams.get('v');
    else {
      const m = url.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
      id = m?.[1] ?? null;
    }
  }
  return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
}

export function checkMediaLink(input: string): LinkCheck {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return { ok: false, reason: "That doesn't look like a link.", canTryAsFile: false };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'Only http(s) links can be played. For files on your computer, open them in a tab and use Share a tab.', canTryAsFile: false };
  }
  const host = url.hostname.toLowerCase();

  if (hostMatches(host, 'youtube.com') || host === 'youtu.be' || hostMatches(host, 'youtube-nocookie.com')) {
    const videoId = youTubeId(url);
    if (!videoId) {
      return {
        ok: false,
        reason: url.searchParams.has('list')
          ? 'Playlists aren\'t supported yet — paste the link of a single video.'
          : 'This YouTube link doesn\'t point to a single video.',
        canTryAsFile: false,
      };
    }
    return { ok: true, source: { kind: 'youtube', videoId, startSeconds: parseYouTubeTime(url.searchParams.get('t') ?? url.searchParams.get('start')) } };
  }

  for (const [domain, name] of Object.entries(DRM_HOSTS)) {
    if (hostMatches(host, domain)) {
      return {
        ok: false,
        reason: `${name} uses DRM, so it can't be embedded or synced here. Screen capture of DRM video usually shows a black frame too, so everyone should play it on their own account.`,
        canTryAsFile: false,
      };
    }
  }

  // Dropbox share links can be turned into direct file links.
  if (hostMatches(host, 'dropbox.com') && url.searchParams.get('dl') === '0') {
    url.searchParams.delete('dl');
    url.searchParams.set('raw', '1');
  }

  const ext = url.pathname.split('.').pop()?.toLowerCase() ?? '';
  if (ext === 'm3u8' || ext === 'mpd') {
    return { ok: false, reason: 'Adaptive streams (HLS/DASH) aren\'t supported for synced playback yet. Open the stream in a tab and use Share a tab.', canTryAsFile: false };
  }
  if (ext === 'mkv' || ext === 'avi' || ext === 'wmv' || ext === 'flv') {
    return { ok: false, reason: `.${ext} files usually don't play in browsers. Play it in a desktop player and share that window or screen instead.`, canTryAsFile: true };
  }
  if (VIDEO_EXT.includes(ext)) return { ok: true, source: { kind: 'file', url: url.toString(), mediaType: 'video' } };
  if (AUDIO_EXT.includes(ext)) return { ok: true, source: { kind: 'file', url: url.toString(), mediaType: 'audio' } };
  if (hostMatches(host, 'dropbox.com') && url.searchParams.get('raw') === '1') {
    return { ok: true, source: { kind: 'file', url: url.toString(), mediaType: 'video' } };
  }

  if (hostMatches(host, 'drive.google.com')) {
    return { ok: false, reason: 'Google Drive links open a viewer page, not a media file, and Drive blocks streaming large files. Open it in a tab and use Share a tab.', canTryAsFile: false };
  }
  for (const [domain, name] of Object.entries(PAGE_HOSTS)) {
    if (hostMatches(host, domain)) {
      return { ok: false, reason: `${name} links are web pages, not embeddable media we can sync. Open it in a tab and use Share a tab.`, canTryAsFile: false };
    }
  }
  return {
    ok: false,
    reason: 'This looks like a web page, not a video or audio file. For websites and slides, use Share a tab. If it really is a media file without an extension, you can try it anyway.',
    canTryAsFile: true,
  };
}

/** Accept any http(s) URL as a direct file when the host chooses "Try anyway". */
export function forceFileSource(input: string): MediaSourceInfo | null {
  try {
    const url = new URL(input.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return { kind: 'file', url: url.toString(), mediaType: 'video' };
  } catch {
    return null;
  }
}

export function youTubeErrorReason(code: number): string {
  switch (code) {
    case 2:
      return 'YouTube says the video ID is invalid.';
    case 5:
      return "YouTube's player hit an HTML5 playback error on this device.";
    case 100:
      return 'The video was removed or is private.';
    case 101:
    case 150:
      return "The video's owner doesn't allow playback on other sites (this also happens with age-restricted videos).";
    case 153:
      return 'YouTube rejected the embed because the page sent no referrer. Check that no proxy strips the Referer header.';
    default:
      return `YouTube reported error ${code}.`;
  }
}

export function mediaErrorReason(code: number | undefined): string {
  switch (code) {
    case 1:
      return 'Loading was aborted.';
    case 2:
      return "A network error stopped the download. The link may have expired, need a login, or block playback from other sites.";
    case 3:
      return 'The file is damaged or uses an encoding this browser can\'t decode.';
    case 4:
      return "This browser can't play it. The server may have returned a web page instead of a media file, or the format/codec (e.g. MKV, HEVC, AVI) isn't supported.";
    default:
      return 'The media failed to load.';
  }
}
