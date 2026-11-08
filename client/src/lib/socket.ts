import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '../../../shared/protocol';

export type RoomSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export function createSocket(): RoomSocket {
  return io({ transports: ['websocket', 'polling'], autoConnect: true });
}

/**
 * Estimates the offset between this device's clock and the server's (NTP-style, best of N samples),
 * so everyone computes the same live position for synced playback.
 */
export class ServerClock {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  now(): number {
    return Date.now() + this.offset;
  }

  async sync(socket: RoomSocket, samples = 5): Promise<void> {
    let best: { rtt: number; offset: number } | null = null;
    for (let i = 0; i < samples; i++) {
      const sample = await new Promise<{ rtt: number; offset: number } | null>((resolve) => {
        const t0 = Date.now();
        const timeout = setTimeout(() => resolve(null), 3000);
        socket.emit('time:sync', (serverNow) => {
          clearTimeout(timeout);
          const t1 = Date.now();
          resolve({ rtt: t1 - t0, offset: serverNow - (t0 + (t1 - t0) / 2) });
        });
      });
      if (sample && (!best || sample.rtt < best.rtt)) best = sample;
    }
    if (best) this.offset = best.offset;
  }

  start(socket: RoomSocket) {
    void this.sync(socket);
    this.timer = setInterval(() => void this.sync(socket, 3), 60_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
