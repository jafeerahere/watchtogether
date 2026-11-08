// End-to-end: several independent browser contexts (separate "people") on one machine.
// Mic and camera use Chrome's fake devices. The OS screen picker can't be driven in automation,
// so getDisplayMedia is replaced with an animated canvas + tone stream; everything after capture
// (signaling, WebRTC, shared-audio badge, guest rendering) is the real app code.

import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Browser, type Locator, type Page } from '@playwright/test';

let mediaServer: Server;

// With the meme clips present, check they play unmuted; if someone removed them, check the emoji
// fallback card appears instead.
const HAS_CLIPS = existsSync('client/public/memes/got-it.mp4');

async function expectMemeMedia(meme: Locator) {
  if (!HAS_CLIPS) {
    await expect(meme.getByTestId('meme-fallback')).toBeVisible();
    return;
  }
  const clip = meme.getByTestId('meme-video');
  await expect.poll(() => clip.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 5000 }).toBeGreaterThan(0.3);
  expect(await clip.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);
}
let mediaUrl = '';

/** 90 s, 8 kHz mono 16-bit WAV with a quiet tone: a "direct media link" served with Range support. */
function makeWav(seconds = 90, rate = 8000): Buffer {
  const samples = seconds * rate;
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 220) * 1500), 44 + i * 2);
  return buf;
}

test.beforeAll(async () => {
  const wav = makeWav();
  mediaServer = createServer((req, res) => {
    const range = req.headers.range?.match(/bytes=(\d+)-(\d*)/);
    if (range) {
      const start = Number(range[1]);
      const end = range[2] ? Number(range[2]) : wav.length - 1;
      res.writeHead(206, {
        'Content-Type': 'audio/wav',
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${wav.length}`,
        'Content-Length': end - start + 1,
      });
      res.end(wav.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': wav.length });
      res.end(wav);
    }
  });
  await new Promise<void>((r) => mediaServer.listen(0, r));
  mediaUrl = `http://localhost:${(mediaServer.address() as AddressInfo).port}/lecture.wav`;
});

test.afterAll(() => {
  mediaServer?.close();
});

const fakeDisplayMedia = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 360 });
    const ctx = canvas.getContext('2d')!;
    let n = 0;
    setInterval(() => {
      n++;
      ctx.fillStyle = `hsl(${(n * 7) % 360} 70% 40%)`;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#fff';
      ctx.font = '48px sans-serif';
      ctx.fillText(`Slide ${n}`, 40, 190);
    }, 50);
    const stream = canvas.captureStream(20);
    const ac = new AudioContext();
    const osc = ac.createOscillator();
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    stream.addTrack(dest.stream.getAudioTracks()[0]);
    return stream;
  };
};

async function newPerson(browser: Browser): Promise<Page> {
  const context = await browser.newContext();
  await context.addInitScript(fakeDisplayMedia);
  const page = await context.newPage();
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
  return page;
}

async function joinAs(page: Page, url: string, name: string) {
  await page.goto(url);
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId('join-room').click();
  await expect(page.getByTestId('copy-invite')).toBeVisible();
}

const mediaTime = (page: Page) => page.getByTestId('link-video').evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, paused: v.paused }));

test('invite → host screen share → guest view → voice → reactions → synced link → late join → limits', async ({ browser }) => {
  // --- Create + invite -------------------------------------------------------------------
  const host = await newPerson(browser);
  await host.goto('/');
  await host.getByTestId('name-input').fill('Hana');
  await host.getByTestId('create-room').click();
  await expect(host).toHaveURL(/\/r\/[a-z2-9]{3}-[a-z2-9]{4}-[a-z2-9]{3}$/);
  await expect(host.getByTestId('start-share')).toBeVisible();
  const roomUrl = host.url();

  const guest = await newPerson(browser);
  await joinAs(guest, roomUrl, 'Gus');
  await expect(host.getByTestId('participant')).toHaveCount(2);
  await expect(guest.getByText('Waiting for Hana to pick something')).toBeVisible();
  await expect(guest.getByTestId('start-share')).toHaveCount(0); // only the host can share

  // --- Screen share: host → guest, with shared audio ---------------------------------------
  await host.getByTestId('start-share').click();
  await expect(host.getByTestId('share-preview')).toBeVisible();
  const guestVideo = guest.getByTestId('share-video');
  await expect.poll(() => guestVideo.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
  const frames1 = await guestVideo.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
  await guest.waitForTimeout(1500);
  const frames2 = await guestVideo.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
  expect(frames2).toBeGreaterThan(frames1); // live, not a frozen frame
  await expect(guest.getByTestId('share-audio')).toHaveAttribute('data-audio', 'on');
  expect(await guestVideo.evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getAudioTracks().length)).toBe(1);

  // --- Voice: separate from shared audio ---------------------------------------------------
  await host.getByTestId('mic-toggle').click();
  await guest.getByTestId('mic-toggle').click();
  const hanaOnGuest = guest.locator('[data-testid=participant][data-name=Hana]');
  const gusOnHost = host.locator('[data-testid=participant][data-name=Gus]');
  await expect(hanaOnGuest).toHaveAttribute('data-voice-state', 'connected', { timeout: 30_000 });
  await expect(gusOnHost).toHaveAttribute('data-voice-state', 'connected', { timeout: 30_000 });
  await expect(hanaOnGuest).toHaveAttribute('data-has-audio', 'yes');
  await expect(guest.getByTestId('voice-audio')).toHaveCount(1);
  // The voice element and the shared-screen element carry different streams.
  const separate = await guest.evaluate(() => {
    const voice = (document.querySelector('[data-testid=voice-audio]') as HTMLAudioElement).srcObject as MediaStream;
    const screen = (document.querySelector('[data-testid=share-video]') as HTMLVideoElement).srcObject as MediaStream;
    return voice.id !== screen.id && voice.getVideoTracks().length === 0;
  });
  expect(separate).toBe(true);

  // --- Reactions → memes for everyone ------------------------------------------------------
  await guest.getByTestId('react-got-it').click();
  for (const page of [host, guest]) {
    const meme = page.locator('[data-testid=meme][data-kind=got-it]');
    await expect(meme).toBeVisible();
    await expect(meme).toContainText('GOT IT');
    await expect(meme).toContainText('Gus');
    await expectMemeMedia(meme);
  }
  await expect(guest.getByTestId('react-lets-go')).toBeDisabled(); // cooldown
  await expect(guest.getByTestId('react-lets-go')).toBeEnabled({ timeout: 5000 });

  // "Wow!" meme for everyone.
  await host.getByTestId('react-wow').click();
  for (const page of [host, guest]) {
    const meme = page.locator('[data-testid=meme][data-kind=wow]');
    await expect(meme).toBeVisible();
    await expect(meme).toContainText('Hana');
    await expectMemeMedia(meme);
  }
  await expect(host.locator('[data-testid=meme][data-kind=wow]')).toHaveCount(0, { timeout: 8000 });
  await expect(host.getByTestId('react-wow')).toBeEnabled({ timeout: 5000 });

  // The other two memes show for the other person too.
  await guest.getByTestId('react-wait-doubt').click();
  await host.getByTestId('react-lets-go').click();
  for (const [page, kind] of [[host, 'wait-doubt'], [guest, 'lets-go']] as const) {
    await expectMemeMedia(page.locator(`[data-testid=meme][data-kind=${kind}]`));
  }
  await expect(host.getByTestId('meme')).toHaveCount(0, { timeout: 10_000 });
  await expect(guest.getByTestId('react-got-it')).toBeEnabled({ timeout: 5000 });

  // Button-only "Haha" meme.
  await guest.getByTestId('react-haha').click();
  await expectMemeMedia(host.locator('[data-testid=meme][data-kind=haha]'));

  // --- Paste a link: synced playback --------------------------------------------------------
  await host.getByTestId('share-toggle').click(); // stop sharing
  await expect(host.getByTestId('link-input')).toBeVisible();
  await host.getByTestId('link-input').fill('https://www.netflix.com/watch/123');
  await host.getByTestId('link-submit').click();
  await expect(host.getByText(/uses DRM/)).toBeVisible();
  await expect(host.getByRole('button', { name: 'Share a tab instead' })).toBeVisible();

  await host.getByTestId('link-input').fill(mediaUrl);
  await host.getByTestId('link-submit').click();
  await expect(host.getByTestId('link-video')).toBeVisible();
  await expect(guest.getByTestId('link-video')).toBeVisible();
  expect(await guest.getByTestId('link-video').evaluate((v: HTMLVideoElement) => v.controls)).toBe(false);
  await expect.poll(async () => host.getByTestId('link-video').evaluate((v: HTMLVideoElement) => v.readyState)).toBeGreaterThanOrEqual(1);

  // Host presses play (native controls).
  await host.getByTestId('link-video').evaluate((v: HTMLVideoElement) => v.play());
  await expect.poll(async () => (await mediaTime(guest)).paused, { timeout: 10_000 }).toBe(false);
  await host.waitForTimeout(3000);
  let [h, g] = await Promise.all([mediaTime(host), mediaTime(guest)]);
  console.log(`play: host=${h.t.toFixed(2)} guest=${g.t.toFixed(2)}`);
  expect(Math.abs(h.t - g.t)).toBeLessThan(1.0);

  // Host seeks.
  await host.getByTestId('link-video').evaluate((v: HTMLVideoElement) => {
    v.currentTime = 40;
  });
  await expect.poll(async () => (await mediaTime(guest)).t, { timeout: 10_000 }).toBeGreaterThan(39);
  await host.waitForTimeout(1500);
  [h, g] = await Promise.all([mediaTime(host), mediaTime(guest)]);
  console.log(`seek: host=${h.t.toFixed(2)} guest=${g.t.toFixed(2)}`);
  expect(Math.abs(h.t - g.t)).toBeLessThan(1.0);

  // Host pauses.
  await host.getByTestId('link-video').evaluate((v: HTMLVideoElement) => v.pause());
  await expect.poll(async () => (await mediaTime(guest)).paused, { timeout: 10_000 }).toBe(true);
  await host.waitForTimeout(1500);
  [h, g] = await Promise.all([mediaTime(host), mediaTime(guest)]);
  console.log(`pause: host=${h.t.toFixed(2)} guest=${g.t.toFixed(2)}`);
  expect(Math.abs(h.t - g.t)).toBeLessThan(0.5);

  // Late join while playing.
  await host.getByTestId('link-video').evaluate((v: HTMLVideoElement) => v.play());
  await host.waitForTimeout(2000);
  const late = await newPerson(browser);
  await joinAs(late, roomUrl, 'Lia');
  await expect.poll(async () => (await mediaTime(late)).paused, { timeout: 15_000 }).toBe(false);
  await late.waitForTimeout(2500);
  const [h2, l2] = await Promise.all([mediaTime(host), mediaTime(late)]);
  console.log(`late join: host=${h2.t.toFixed(2)} late=${l2.t.toFixed(2)}`);
  expect(Math.abs(h2.t - l2.t)).toBeLessThan(1.0);

  // --- Gesture camera: on-device model loads from local assets -------------------------------
  await guest.getByTestId('camera-toggle').click();
  await expect(guest.getByTestId('gesture-panel')).toHaveAttribute('data-phase', 'ready', { timeout: 60_000 });
  // The face model (needed for the two-hands-on-chin "Wow!" pose) loaded too. (Haha is button-only, so 4 gestures.)
  await expect(guest.locator('.gesture-legend li')).toHaveCount(4);
  await expect(guest.locator('.gesture-legend li.unavailable')).toHaveCount(0);
  await expect(host.locator('[data-testid=participant][data-name=Gus]')).toContainText('📷');

  // --- Capacity + host refresh --------------------------------------------------------------
  const fourth = await newPerson(browser);
  await joinAs(fourth, roomUrl, 'Fay');
  const fifth = await newPerson(browser);
  await fifth.goto(roomUrl);
  await expect(fifth.getByText('This room is full (4 people max).')).toBeVisible();
  await expect(fifth.getByTestId('join-room')).toBeDisabled();

  await host.reload();
  await expect(host.getByTestId('copy-invite')).toBeVisible();
  await expect(host.getByText('You control playback')).toBeVisible(); // still the host after a refresh
  await expect(host.getByTestId('participant')).toHaveCount(4);
});
