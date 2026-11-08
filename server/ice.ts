// ICE (STUN/TURN) configuration handed to clients when they join a room.
// TURN credentials are only given to people inside a room, never from a public endpoint.

import { createHmac } from 'node:crypto';
import type { IceConfig, IceServer } from '../shared/protocol';

type Env = Record<string, string | undefined>;

const list = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

/**
 * coturn "TURN REST API" credentials (`use-auth-secret` + `static-auth-secret`):
 * username = "<expiry unix seconds>:<label>", credential = base64(HMAC-SHA1(secret, username)).
 */
export function turnRestCredentials(secret: string, label: string, ttlSeconds: number, nowMs: number) {
  const username = `${Math.floor(nowMs / 1000) + ttlSeconds}:${label}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

export function iceConfigFor(env: Env, label: string, nowMs = Date.now()): IceConfig {
  const iceServers: IceServer[] = [];
  const stun = env.STUN_URLS === undefined ? ['stun:stun.l.google.com:19302'] : list(env.STUN_URLS);
  if (stun.length) iceServers.push({ urls: stun });

  const turn = list(env.TURN_URLS);
  if (turn.length) {
    if (env.TURN_SECRET) {
      const ttl = Number(env.TURN_TTL_SECONDS ?? 43_200);
      iceServers.push({ urls: turn, ...turnRestCredentials(env.TURN_SECRET, label, ttl, nowMs) });
    } else if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
      iceServers.push({ urls: turn, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
    } else {
      console.warn('[ice] TURN_URLS is set but neither TURN_SECRET nor TURN_USERNAME/TURN_CREDENTIAL is; ignoring TURN.');
    }
  }
  return {
    iceServers,
    iceTransportPolicy: env.ICE_TRANSPORT_POLICY === 'relay' ? 'relay' : 'all',
  };
}

export function describeIce(env: Env): string {
  const cfg = iceConfigFor(env, 'startup');
  const hasTurn = cfg.iceServers.some((s) => [s.urls].flat().some((u) => String(u).startsWith('turn')));
  return `STUN: ${list(env.STUN_URLS ?? 'stun:stun.l.google.com:19302').length} url(s), TURN: ${hasTurn ? 'configured' : 'not configured'}, policy: ${cfg.iceTransportPolicy}`;
}
