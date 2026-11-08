import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const serverPort = Number(process.env.PORT ?? 3001);
const mediapipeVersion: string = JSON.parse(
  readFileSync(new URL('./node_modules/@mediapipe/tasks-vision/package.json', import.meta.url), 'utf8'),
).version;

export default defineConfig({
  root: 'client',
  plugins: [react()],
  define: {
    __MEDIAPIPE_VERSION__: JSON.stringify(mediapipeVersion),
  },
  server: {
    port: Number(process.env.CLIENT_PORT ?? 5173),
    // `npm run dev -- --host` exposes the dev server on your LAN (needs HTTPS for mic/camera; see docs).
    proxy: {
      '/api': `http://localhost:${serverPort}`,
      '/socket.io': { target: `http://localhost:${serverPort}`, ws: true },
    },
  },
  build: {
    outDir: '../dist/client',
    emptyOutDir: true,
    sourcemap: true,
  },
});
