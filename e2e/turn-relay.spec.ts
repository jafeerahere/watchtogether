// Proves media can flow through your TURN server. Skipped unless relay mode is configured, e.g.:
//   TURN_URLS=turn:turn.example.com:3478 TURN_SECRET=... ICE_TRANSPORT_POLICY=relay npx playwright test turn-relay
// With ICE_TRANSPORT_POLICY=relay, browsers may only use TURN candidates, so if this passes, TURN works.

import { expect, test, type Page } from '@playwright/test';

test.skip(process.env.ICE_TRANSPORT_POLICY !== 'relay', 'set ICE_TRANSPORT_POLICY=relay and TURN_* to run');

async function enter(page: Page, url: string, name: string, create = false) {
  await page.goto(url);
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId(create ? 'create-room' : 'join-room').click();
  await expect(page.getByTestId('copy-invite')).toBeVisible();
}

test('voice and screen share connect through TURN only', async ({ browser }) => {
  const host = await (await browser.newContext()).newPage();
  await enter(host, '/', 'Host', true);
  const guest = await (await browser.newContext()).newPage();
  await enter(guest, host.url(), 'Guest');

  await host.getByTestId('mic-toggle').click();
  const hostRow = guest.locator('[data-testid=participant][data-name=Host]');
  await expect(hostRow).toHaveAttribute('data-voice-state', 'connected', { timeout: 45_000 });
  await expect(hostRow).toContainText('via TURN', { timeout: 10_000 });

  await host.getByTestId('start-share').click();
  await expect
    .poll(() => guest.getByTestId('share-video').evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 45_000 })
    .toBeGreaterThan(0);
});
