// Room layout: Chat | People tabs, collapsible side panel with unread badge, theatre mode,
// full screen with auto-hiding controls, keyboard shortcuts, and remembered preferences.

import { expect, test, type Browser, type Page } from '@playwright/test';

async function person(browser: Browser): Promise<Page> {
  return (await browser.newContext({ viewport: { width: 1280, height: 760 } })).newPage();
}

async function enter(page: Page, url: string, name: string, create = false) {
  await page.goto(url);
  await page.getByTestId('name-input').fill(name);
  await page.getByTestId(create ? 'create-room' : 'join-room').click();
  await expect(page.getByTestId('room')).toBeVisible();
}

async function say(page: Page, text: string) {
  await page.getByTestId('chat-input').fill(text);
  await page.getByTestId('chat-input').press('Enter');
  await expect(page.getByTestId('chat-input')).toHaveValue('');
}

test('side panel tabs, collapse + unread, theatre, full screen, shortcuts, remembered layout', async ({ browser }) => {
  const host = await person(browser);
  await enter(host, '/', 'Hana', true);
  const guest = await person(browser);
  await enter(guest, host.url(), 'Gus');
  const room = guest.getByTestId('room');
  const panel = guest.getByTestId('side-panel');

  // Default: chat is the full-height tab; People is one click away; the draft survives tab switches.
  await expect(guest.getByTestId('tab-chat')).toHaveAttribute('aria-selected', 'true');
  await expect(guest.getByTestId('chat-input')).toBeVisible();
  const panelBox = (await panel.boundingBox())!;
  const listBox = (await guest.getByTestId('chat-list').boundingBox())!;
  expect(listBox.height).toBeGreaterThan(panelBox.height * 0.6); // chat uses most of the panel
  await guest.getByTestId('chat-input').fill('half-typed thought');
  await guest.getByTestId('tab-people').click();
  await expect(guest.getByTestId('participant').first()).toBeVisible();
  await expect(guest.getByTestId('chat-input')).toBeHidden();
  await guest.getByTestId('tab-chat').click();
  await expect(guest.getByTestId('chat-input')).toHaveValue('half-typed thought');
  await guest.getByTestId('chat-input').fill('');

  // Collapse: the stage takes the width; new messages show as an unread badge; reopening clears it.
  await guest.getByTestId('panel-close').click();
  await expect(panel).toBeHidden();
  await say(host, 'are you there?');
  await expect(guest.getByTestId('unread-badge')).toHaveText('1');
  await say(host, 'next slide');
  await expect(guest.getByTestId('unread-badge')).toHaveText('2');
  await guest.getByTestId('panel-open').click();
  await expect(panel).toBeVisible();
  await expect(guest.getByTestId('tab-chat').locator('.unread')).toHaveCount(0);
  await expect(guest.getByTestId('chat-message').filter({ hasText: 'next slide' })).toBeInViewport();

  // Unread also counts while the People tab is open.
  await guest.getByTestId('tab-people').click();
  await say(host, 'ping');
  await expect(guest.getByTestId('tab-chat').locator('.unread')).toHaveText('1');
  await guest.getByTestId('tab-chat').click();

  // Theatre: header hidden, video + chat; remembered after a refresh.
  await guest.getByTestId('view-theatre').click();
  await expect(room).toHaveAttribute('data-view', 'theatre');
  await expect(guest.getByTestId('copy-invite')).toBeHidden();
  await expect(panel).toBeVisible();
  await guest.reload();
  await expect(guest.getByTestId('room')).toHaveAttribute('data-view', 'theatre');
  await expect(guest.getByTestId('side-panel')).toBeVisible();

  // Shortcuts are ignored while typing in chat.
  await guest.getByTestId('chat-input').click();
  await guest.keyboard.type('t');
  await expect(room).toHaveAttribute('data-view', 'theatre');
  await guest.getByTestId('chat-input').fill('');
  await guest.getByTestId('chat-input').blur();

  // Full screen (F): real browser full screen of the whole room, video only to start.
  await guest.keyboard.press('f');
  await expect(room).toHaveAttribute('data-view', 'full');
  expect(await guest.evaluate(() => document.fullscreenElement?.getAttribute('data-testid'))).toBe('room');
  await expect(panel).toBeHidden();

  // Controls hide when idle and come back on mouse movement.
  await guest.mouse.move(400, 300);
  await expect(room).not.toHaveClass(/chrome-hidden/);
  await expect(room).toHaveClass(/chrome-hidden/, { timeout: 5000 });
  await guest.mouse.move(420, 320);
  await expect(room).not.toHaveClass(/chrome-hidden/);

  // C slides chat in while in full screen; messages still arrive.
  await guest.keyboard.press('c');
  await expect(panel).toBeVisible();
  await say(host, 'still in sync?');
  await expect(guest.getByTestId('chat-message').filter({ hasText: 'still in sync?' })).toBeVisible();

  // Leaving full screen returns to the previous layout (theatre, panel open).
  await guest.getByTestId('view-full').click();
  await expect(room).toHaveAttribute('data-view', 'theatre');
  expect(await guest.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(panel).toBeVisible();

  // T toggles theatre off again.
  await guest.keyboard.press('t');
  await expect(room).toHaveAttribute('data-view', 'default');
  await expect(guest.getByTestId('copy-invite')).toBeVisible();
});
