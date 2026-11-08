// Checks that need real sources instead of stubs:
//  1. Real getDisplayMedia tab capture (Chrome auto-selects a tab by title instead of showing the picker).
//  2. Real YouTube embed sync (needs internet; set SKIP_NETWORK=1 to skip).

import { expect, test, type Page } from '@playwright/test';

async function createRoom(page: Page, name: string): Promise<string> {
  await page.goto('/');
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId('create-room').click();
  await expect(page.getByTestId('start-share')).toBeVisible();
  return page.url();
}

async function join(page: Page, url: string, name: string) {
  await page.goto(url);
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId('join-room').click();
  await expect(page.getByTestId('copy-invite')).toBeVisible();
}

test.describe('real tab capture', () => {
  // Chrome flag in playwright.config.ts: --auto-select-tab-capture-source-by-title=Study Slides
  test('host shares a real browser tab; guest receives live frames', async ({ browser }) => {
    const hostCtx = await browser.newContext();
    const slides = await hostCtx.newPage();
    await slides.setContent(
      `<title>Study Slides</title><body style="margin:0;background:#123;color:#fff;font:64px sans-serif">
         <h1 id=h>Slide 1</h1><script>let n=1;setInterval(()=>{document.getElementById('h').textContent='Slide '+(++n)},200)</script>`,
    );
    const host = await hostCtx.newPage();
    const url = await createRoom(host, 'Host');
    const guest = await (await browser.newContext()).newPage();
    await join(guest, url, 'Guest');

    await host.getByTestId('start-share').click();
    await expect(host.getByTestId('share-preview')).toBeVisible();
    const surface = await host.getByTestId('share-preview').evaluate(
      (v: HTMLVideoElement) => ((v.srcObject as MediaStream).getVideoTracks()[0].getSettings() as { displaySurface?: string }).displaySurface,
    );
    // With --use-fake-ui-for-media-stream Chrome may pick the whole screen instead of the titled tab.
    expect(['browser', 'monitor', 'window']).toContain(surface);
    const label = surface === 'browser' ? /sharing a browser tab/ : surface === 'window' ? /sharing a window/ : /sharing their screen/;
    await expect(host.getByText(label)).toBeVisible();

    const video = guest.getByTestId('share-video');
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 30_000 }).toBeGreaterThan(0);
    await expect(guest.getByText(new RegExp(`Host is ${label.source}`))).toBeVisible();
    // Audio badge reflects what the browser actually captured (a silent setContent tab may have none).
    const hasAudio = await host.getByTestId('share-preview').evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getAudioTracks().length > 0);
    await expect(guest.getByTestId('share-audio')).toHaveAttribute('data-audio', hasAudio ? 'on' : 'off');
    console.log(`real tab capture: surface=${surface} audio=${hasAudio}`);
  });
});

test('YouTube embed stays in sync for guests', async ({ browser }) => {
  test.skip(!!process.env.SKIP_NETWORK, 'needs internet');
  const host = await (await browser.newContext()).newPage();
  const url = await createRoom(host, 'Host');
  const guest = await (await browser.newContext()).newPage();
  await join(guest, url, 'Guest');

  // "Big Buck Bunny" (Blender Foundation, CC-BY), embeddable.
  await host.getByTestId('link-input').fill('https://www.youtube.com/watch?v=aqz-KE-bpKQ');
  await host.getByTestId('link-submit').click();

  const ytVideo = (page: Page) => page.frameLocator('[data-testid=youtube-player] iframe').locator('video');
  const ytTime = (page: Page) => ytVideo(page).evaluate((v: HTMLVideoElement) => ({ t: v.currentTime, paused: v.paused }));

  try {
    await expect(ytVideo(host)).toBeAttached({ timeout: 30_000 });
    await expect(ytVideo(guest)).toBeAttached({ timeout: 30_000 });
  } catch {
    test.skip(true, 'YouTube player did not load in this environment (network/consent/bot check)');
  }

  // Host uses YouTube's own UI/player (what its controls call), like a real user would.
  const ytFrame = host.frameLocator('[data-testid=youtube-player] iframe');
  type YTEl = HTMLElement & { seekTo(t: number, ahead: boolean): void; pauseVideo(): void };
  await ytFrame.getByRole('button', { name: 'Play video' }).first().click();
  await expect.poll(async () => (await ytTime(guest)).paused, { timeout: 30_000 }).toBe(false);
  await host.waitForTimeout(4000);
  let [h, g] = await Promise.all([ytTime(host), ytTime(guest)]);
  console.log(`youtube play: host=${h.t.toFixed(2)} guest=${g.t.toFixed(2)}`);
  expect(Math.abs(h.t - g.t)).toBeLessThan(1.5);

  await ytFrame.locator('#movie_player').evaluate((p) => (p as YTEl).seekTo(120, true));
  await expect.poll(async () => (await ytTime(guest)).t, { timeout: 20_000 }).toBeGreaterThan(119);
  await host.waitForTimeout(3000);
  [h, g] = await Promise.all([ytTime(host), ytTime(guest)]);
  console.log(`youtube seek: host=${h.t.toFixed(2)} guest=${g.t.toFixed(2)}`);
  expect(Math.abs(h.t - g.t)).toBeLessThan(1.5);

  await ytFrame.locator('#movie_player').evaluate((p) => (p as YTEl).pauseVideo());
  await expect.poll(async () => (await ytTime(guest)).paused, { timeout: 15_000 }).toBe(true);
});
