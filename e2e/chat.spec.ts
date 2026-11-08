// Real-time chat between separate browser sessions.

import { expect, test, type Browser, type Page } from '@playwright/test';

async function person(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (err) => console.log(`[pageerror] ${err.message}`));
  return page;
}

async function enter(page: Page, url: string, name: string, create = false) {
  await page.goto(url);
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId(create ? 'create-room' : 'join-room').click();
  await expect(page.getByTestId('copy-invite')).toBeVisible();
}

const messages = (page: Page) => page.getByTestId('chat-message');

test('chat: live messages, typing, links, safe text, history, join/leave notices, rate limit', async ({ browser }) => {
  const host = await person(browser);
  await enter(host, '/', 'Hana', true);
  const roomUrl = host.url();
  const guest = await person(browser);
  await enter(guest, roomUrl, 'Gus');

  // Join notice reaches the host live.
  await expect(host.getByTestId('chat-system').filter({ hasText: 'Gus joined' })).toBeVisible();

  // Typing indicator.
  const input = guest.getByTestId('chat-input');
  await input.fill('');
  await input.pressSequentially('quick q', { delay: 30 });
  await expect(host.getByTestId('chat-typing')).toHaveText('Gus is typing…');

  // Enter sends; markup is shown as text, links are clickable.
  await input.fill('');
  await input.pressSequentially('what is <img src=x onerror="window.__pwned=1"> on https://example.com/notes?', { delay: 5 });
  await input.press('Enter');
  const msg = messages(host).filter({ hasText: 'what is' });
  await expect(msg).toBeVisible();
  await expect(msg).toContainText('<img src=x onerror="window.__pwned=1">');
  await expect(msg.locator('img')).toHaveCount(0);
  expect(await host.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  const link = msg.getByRole('link', { name: 'https://example.com/notes' });
  await expect(link).toHaveAttribute('href', 'https://example.com/notes');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(host.getByTestId('chat-typing')).toHaveText('');
  await expect(input).toHaveValue('');

  // Shift+Enter makes a new line; the reply shows "You" for the sender and the name for others.
  const hostInput = host.getByTestId('chat-input');
  await hostInput.click();
  await hostInput.pressSequentially('line one', { delay: 5 });
  await hostInput.press('Shift+Enter');
  await hostInput.pressSequentially('line two', { delay: 5 });
  await host.getByTestId('chat-send').click();
  const reply = messages(guest).filter({ hasText: 'line one' });
  await expect(reply).toBeVisible();
  expect(await reply.locator('.chat-text').innerText()).toBe('line one\nline two');
  await expect(reply.locator('.chat-name')).toHaveText('Hana');
  await expect(messages(host).filter({ hasText: 'line one' }).locator('.chat-name')).toHaveText('You');

  // Late joiner gets the history.
  const late = await person(browser);
  await enter(late, roomUrl, 'Lia');
  await expect(messages(late)).toHaveCount(2);
  await expect(messages(late).first()).toContainText('what is');

  // A refresh doesn't spam "left/joined".
  const systemCount = await host.getByTestId('chat-system').count();
  await guest.reload();
  await expect(guest.getByTestId('copy-invite')).toBeVisible();
  await expect(messages(guest)).toHaveCount(2); // history restored after the refresh
  await host.waitForTimeout(9_000);
  expect(await host.getByTestId('chat-system').count()).toBe(systemCount);

  // Leaving for real is announced (after a short grace period).
  await late.context().close();
  await expect(host.getByTestId('chat-system').filter({ hasText: 'Lia left' })).toBeVisible({ timeout: 15_000 });

  // Rate limit: the 6th message inside 5 s is refused with a visible reason.
  for (let i = 1; i <= 6; i++) {
    await hostInput.fill(`spam ${i}`);
    await hostInput.press('Enter');
    if (i < 6) await expect(messages(host).filter({ hasText: `spam ${i}` })).toBeVisible();
  }
  await expect(host.locator('.chat-error')).toContainText('too fast');
  await expect(hostInput).toHaveValue('spam 6'); // unsent text is kept
  await expect(messages(guest).filter({ hasText: 'spam 5' })).toBeVisible();
  await expect(messages(guest).filter({ hasText: 'spam 6' })).toHaveCount(0);
});
