import { existsSync, readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Server, type Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import {
  isValidRoomId,
  MAX_PARTICIPANTS,
  type ClientToServerEvents,
  type ServerToClientEvents,
} from '../shared/protocol';
import { isReactionKind } from '../shared/reactions';
import { describeIce, iceConfigFor } from './ice';
import { RoomStore } from './rooms';

try {
  process.loadEnvFile();
} catch {
  /* no .env file: fine */
}

const env = process.env;
const PORT = Number(env.PORT ?? 3001);
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const clientDist = path.join(rootDir, 'dist', 'client');

const app = express();
if (env.TRUST_PROXY) app.set('trust proxy', Number(env.TRUST_PROXY) || env.TRUST_PROXY);
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));

const server =
  env.SSL_KEY_FILE && env.SSL_CERT_FILE
    ? https.createServer({ key: readFileSync(env.SSL_KEY_FILE), cert: readFileSync(env.SSL_CERT_FILE) }, app)
    : http.createServer(app);

type IO = Server<ClientToServerEvents, ServerToClientEvents>;
type WSocket = Socket<ClientToServerEvents, ServerToClientEvents>;

const io: IO = new Server(server, {
  maxHttpBufferSize: 256 * 1024,
  ...(env.CORS_ORIGIN ? { cors: { origin: env.CORS_ORIGIN.split(',') } } : {}),
});

const store = new RoomStore({
  onChange: (roomId) => broadcast(roomId),
  onChat: (roomId, message) => io.to(roomId).emit('chat:message', message),
});

function broadcast(roomId: string) {
  const room = store.rooms.get(roomId);
  if (room) io.to(roomId).emit('room:state', store.toState(room));
}

// --- HTTP API -------------------------------------------------------------------------------

const createLimiter = new Map<string, { count: number; resetAt: number }>();
function allowCreate(ip: string): boolean {
  const now = Date.now();
  const entry = createLimiter.get(ip);
  if (!entry || entry.resetAt < now) {
    createLimiter.set(ip, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count += 1;
  return entry.count <= 20;
}

app.post('/api/rooms', (req, res) => {
  const clientId = req.body?.clientId;
  if (typeof clientId !== 'string' || clientId.length < 8 || clientId.length > 64) {
    res.status(400).json({ error: 'clientId required' });
    return;
  }
  if (!allowCreate(req.ip ?? 'unknown')) {
    res.status(429).json({ error: 'Too many rooms created. Try again in a minute.' });
    return;
  }
  const room = store.create(clientId);
  res.json({ roomId: room.id });
});

app.get('/api/rooms/:id', (req, res) => {
  const room = isValidRoomId(req.params.id) ? store.rooms.get(req.params.id) : undefined;
  if (!room) {
    res.status(404).json({ exists: false });
    return;
  }
  res.json({ exists: true, participants: room.members.size, max: MAX_PARTICIPANTS });
});

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, rooms: store.rooms.size });
});

if (existsSync(clientDist)) {
  app.use(express.static(clientDist, { index: false, maxAge: '1h' }));
  app.get(['/', '/r/:id'], (_req, res) => res.sendFile(path.join(clientDist, 'index.html')));
}

// --- Socket.IO ------------------------------------------------------------------------------

io.on('connection', (socket: WSocket) => {
  const afterChange = (room: { id: string } | undefined) => {
    if (room) broadcast(room.id);
  };

  socket.on('time:sync', (ack) => {
    if (typeof ack === 'function') ack(Date.now());
  });

  socket.on('room:join', (req, ack) => {
    if (typeof ack !== 'function') return;
    if (!req || typeof req.roomId !== 'string' || !isValidRoomId(req.roomId)) {
      ack({ ok: false, error: 'not-found' });
      return;
    }
    const previous = store.roomOf(socket.id);
    if (previous) {
      store.leave(socket.id);
      socket.leave(previous.id);
      broadcast(previous.id);
    }
    const result = store.join(req.roomId, socket.id, req.clientId, req.name);
    if (!result.ok) {
      ack({ ok: false, error: result.error });
      return;
    }
    if (result.replacedSocketId) {
      const old = io.sockets.sockets.get(result.replacedSocketId);
      old?.emit('room:kicked', 'You joined this room from somewhere else (another tab or a reconnect).');
      old?.leave(req.roomId);
    }
    socket.join(req.roomId);
    ack({
      ok: true,
      selfId: socket.id,
      state: store.toState(result.room),
      ice: iceConfigFor(env, `${req.roomId}:${socket.id.slice(0, 8)}`),
      chat: store.chatHistory(result.room),
    });
    broadcast(req.roomId);
  });

  socket.on('room:leave', () => {
    const room = store.leave(socket.id);
    if (room) {
      socket.leave(room.id);
      broadcast(room.id);
    }
  });

  socket.on('profile:update', (patch) => {
    if (patch && typeof patch === 'object') afterChange(store.updateProfile(socket.id, patch));
  });

  socket.on('host:transfer', (toId) => {
    if (typeof toId !== 'string') return;
    const room = store.transferHost(socket.id, toId);
    if (room) {
      io.to(toId).emit('notice', { text: 'You are now the host.' });
      broadcast(room.id);
    }
  });

  socket.on('share:start', (info, ack) => {
    const res = store.startShare(socket.id, info ?? {});
    // Broadcast before acking so the sharer already sees the new state when its ack arrives.
    if (res.ok) afterChange(store.roomOf(socket.id));
    if (typeof ack === 'function') ack(res);
  });
  socket.on('share:update', (info) => afterChange(store.updateShare(socket.id, info ?? {})));
  socket.on('share:stop', () => afterChange(store.stopShare(socket.id)));

  socket.on('link:set', (req, ack) => {
    const res = store.setLink(socket.id, req ?? {});
    if (res.ok) afterChange(store.roomOf(socket.id));
    if (typeof ack === 'function') ack(res);
  });
  socket.on('link:control', (ctl) => afterChange(store.controlLink(socket.id, ctl ?? {})));
  socket.on('link:clear', () => afterChange(store.clearLink(socket.id)));

  socket.on('reaction:send', (r) => {
    if (!r || !isReactionKind(r.kind)) return;
    const room = store.roomOf(socket.id);
    const member = store.allowReaction(socket.id);
    if (!room || !member) return;
    io.to(room.id).emit('reaction', {
      id: randomUUID(),
      fromId: socket.id,
      fromName: member.name,
      kind: r.kind,
      via: r.via === 'gesture' ? 'gesture' : 'button',
      at: Date.now(),
    });
  });

  socket.on('chat:send', (text, ack) => {
    const res = store.sendChat(socket.id, text);
    if (typeof ack === 'function') ack(res);
  });

  socket.on('chat:typing', (typing) => {
    const room = store.roomOf(socket.id);
    if (room) socket.to(room.id).emit('chat:typing', { id: socket.id, typing: typing === true });
  });

  socket.on('signal', (msg) => {
    if (!msg || typeof msg.to !== 'string' || (msg.channel !== 'voice' && msg.channel !== 'screen')) return;
    if (!store.sameRoom(socket.id, msg.to)) return;
    io.to(msg.to).emit('signal', { from: socket.id, channel: msg.channel, data: msg.data });
  });

  socket.on('disconnect', () => {
    const room = store.leave(socket.id);
    if (room) {
      socket.to(room.id).emit('chat:typing', { id: socket.id, typing: false });
      broadcast(room.id);
    }
  });
});

server.listen(PORT, () => {
  const scheme = server instanceof https.Server ? 'https' : 'http';
  console.log(`[watchtogether] listening on ${scheme}://localhost:${PORT}`);
  console.log(`[watchtogether] ${describeIce(env)}`);
  if (!existsSync(clientDist)) console.log('[watchtogether] no client build found; use `npm run dev` (Vite on :5173) or `npm run build`.');
});
