import { defineConfig } from '@playwright/test';

const PORT = 3123;

export default defineConfig({
  testDir: 'e2e',
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Uses the locally installed Google Chrome, so no Playwright browser download is needed.
    channel: process.env.PW_CHANNEL ?? 'chrome',
    headless: process.env.HEADED ? false : true,
    permissions: ['microphone', 'camera'],
    launchOptions: {
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        // Real getDisplayMedia: auto-pick the tab with this title instead of showing the picker.
        '--auto-select-tab-capture-source-by-title=Study Slides',
      ],
    },
  },
  webServer: {
    // Requires `npm run build` first (serves dist/client).
    command: 'npx tsx server/index.ts',
    url: `http://localhost:${PORT}/healthz`,
    // Pass TURN_* / ICE_TRANSPORT_POLICY through (for e2e/turn-relay.spec.ts); no public STUN by default.
    env: { STUN_URLS: '', ...(process.env as Record<string, string>), PORT: String(PORT) },
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
