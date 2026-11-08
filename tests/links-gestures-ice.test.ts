import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GestureDetector } from '../client/src/gestures/detector';
import { iceConfigFor, turnRestCredentials } from '../server/ice';
import { checkMediaLink } from '../shared/links';

describe('checkMediaLink', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s', 'dQw4w9WgXcQ', 65],
    ['https://youtu.be/dQw4w9WgXcQ?t=42', 'dQw4w9WgXcQ', 42],
    ['youtube.com/shorts/dQw4w9WgXcQ', 'dQw4w9WgXcQ', 0],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ', 0],
    ['https://www.youtube.com/live/dQw4w9WgXcQ', 'dQw4w9WgXcQ', 0],
  ])('YouTube %s', (url, videoId, startSeconds) => {
    expect(checkMediaLink(url)).toEqual({ ok: true, source: { kind: 'youtube', videoId, startSeconds } });
  });

  it('accepts direct media files', () => {
    expect(checkMediaLink('https://example.com/lecture.mp4')).toMatchObject({ ok: true, source: { kind: 'file', mediaType: 'video' } });
    expect(checkMediaLink('https://example.com/podcast.mp3?sig=1')).toMatchObject({ ok: true, source: { kind: 'file', mediaType: 'audio' } });
  });

  it('turns Dropbox share links into direct links', () => {
    const res = checkMediaLink('https://www.dropbox.com/s/abc/talk.mp4?dl=0');
    expect(res.ok && res.source.kind === 'file' && res.source.url).toContain('raw=1');
  });

  it('explains why links cannot play', () => {
    const cases: [string, RegExp, boolean][] = [
      ['https://www.netflix.com/watch/1', /DRM/, false],
      ['https://www.youtube.com/playlist?list=PL123', /Playlists/, false],
      ['https://example.com/live/index.m3u8', /HLS/, false],
      ['https://drive.google.com/file/d/abc/view', /Google Drive/, false],
      ['https://vimeo.com/12345', /Vimeo/, false],
      ['https://example.com/movie.mkv', /browsers/, true],
      ['https://en.wikipedia.org/wiki/Physics', /web page/, true],
      ['file:///C:/videos/a.mp4', /http/, false],
    ];
    for (const [url, reason, canTry] of cases) {
      const res = checkMediaLink(url);
      expect(res.ok, url).toBe(false);
      if (!res.ok) {
        expect(res.reason, url).toMatch(reason);
        expect(res.canTryAsFile, url).toBe(canTry);
      }
    }
  });
});

describe('GestureDetector', () => {
  const run = (d: GestureDetector, label: string | null, from: number, to: number, step = 80, score = 0.9) => {
    const fired: string[] = [];
    for (let t = from; t <= to; t += step) {
      const out = d.update(label, score, t);
      if (out.fired) fired.push(`${out.fired}@${t}`);
    }
    return fired;
  };

  it('fires after a ~700ms hold, not before', () => {
    const d = new GestureDetector();
    expect(run(d, 'Thumb_Up', 0, 640)).toEqual([]);
    expect(run(d, 'Thumb_Up', 720, 800)).toEqual(['got-it@720']);
  });

  it('does not repeat while the gesture is still held, even after the cooldown', () => {
    const d = new GestureDetector();
    expect(run(d, 'Victory', 0, 10_000)).toHaveLength(1);
  });

  it('fires again after release and cooldown', () => {
    const d = new GestureDetector();
    run(d, 'Open_Palm', 0, 800);
    run(d, null, 880, 3200);
    expect(run(d, 'Open_Palm', 3280, 4400)).toEqual(['wait-doubt@4000']);
  });

  it('respects the cooldown when switching gestures', () => {
    const d = new GestureDetector();
    run(d, 'Thumb_Up', 0, 800);
    const fired = run(d, 'Victory', 880, 5000);
    expect(fired).toHaveLength(1);
    expect(Number(fired[0].split('@')[1])).toBeGreaterThanOrEqual(720 + 3000);
  });

  it('tolerates brief recognizer dropouts but resets on real gaps', () => {
    const d = new GestureDetector();
    run(d, 'Thumb_Up', 0, 400);
    d.update(null, 0, 480); // one-frame flicker
    expect(run(d, 'Thumb_Up', 560, 720)).toEqual(['got-it@720']);

    const e = new GestureDetector();
    run(e, 'Thumb_Up', 0, 400);
    run(e, null, 480, 1000); // hand dropped
    expect(run(e, 'Thumb_Up', 1080, 1700)).toEqual([]);
  });

  it('ignores low-confidence and unmapped gestures', () => {
    const d = new GestureDetector();
    expect(run(d, 'Thumb_Up', 0, 2000, 80, 0.3)).toEqual([]);
    expect(run(d, 'Closed_Fist', 0, 2000)).toEqual([]);
  });

  it('external cooldown (manual button) blocks gestures', () => {
    const d = new GestureDetector();
    d.startCooldown(0);
    expect(run(d, 'Thumb_Up', 0, 2900)).toEqual([]);
  });
});

describe('ICE config', () => {
  it('defaults to public STUN only', () => {
    const cfg = iceConfigFor({}, 'x');
    expect(cfg.iceTransportPolicy).toBe('all');
    expect(cfg.iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302'] }]);
  });

  it('issues coturn REST credentials that verify with the shared secret', () => {
    const cfg = iceConfigFor({ TURN_URLS: 'turn:t.example.com:3478', TURN_SECRET: 's3cret', TURN_TTL_SECONDS: '600', ICE_TRANSPORT_POLICY: 'relay' }, 'room:abc', 1_700_000_000_000);
    const turn = cfg.iceServers.find((s) => String([s.urls].flat()[0]).startsWith('turn'))!;
    expect(turn.username).toBe('1700000600:room:abc');
    expect(turn.credential).toBe(createHmac('sha1', 's3cret').update('1700000600:room:abc').digest('base64'));
    expect(cfg.iceTransportPolicy).toBe('relay');
    expect(turnRestCredentials('k', 'u', 1, 0).username).toBe('1:u');
  });

  it('supports static TURN credentials', () => {
    const cfg = iceConfigFor({ STUN_URLS: '', TURN_URLS: 'turns:t.example.com:5349', TURN_USERNAME: 'u', TURN_CREDENTIAL: 'p' }, 'x');
    expect(cfg.iceServers).toEqual([{ urls: ['turns:t.example.com:5349'], username: 'u', credential: 'p' }]);
  });
});
