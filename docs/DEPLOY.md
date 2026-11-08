# HTTPS and TURN setup

Two things decide whether WatchTogether works beyond your own machine:

1. **HTTPS.** Browsers only allow microphone, camera, and screen capture in a *secure context*: `https://…` or `http://localhost`. Over plain `http://192.168.x.x`, the mic/camera/share buttons fail with a "needs HTTPS" message.
2. **TURN.** WebRTC tries to connect people directly. That works on most home networks with just STUN, but fails behind symmetric NATs, carrier-grade NAT (common on mobile data), and restrictive corporate or campus Wi-Fi. A TURN server relays the media when direct paths fail.

All configuration is environment variables (see `.env.example`). The server reads a `.env` file in the project root automatically.

---

## 1. HTTPS

Pick one.

### A. Same computer only

`http://localhost:5173` (dev) or `http://localhost:3001` (prod) is already a secure context. Nothing to do.

### B. Devices on your Wi-Fi (LAN testing) with mkcert

[mkcert](https://github.com/FiloSottile/mkcert) creates a locally trusted certificate.

```bash
mkcert -install
mkdir certs
mkcert -key-file certs/key.pem -cert-file certs/cert.pem localhost 127.0.0.1 192.168.1.50   # use your LAN IP
```

Then in `.env`:

```
SSL_KEY_FILE=certs/key.pem
SSL_CERT_FILE=certs/cert.pem
```

```bash
npm run build && npm start      # → https://192.168.1.50:3001
```

Other devices must trust the mkcert root CA, or they'll get a certificate warning. On phones, install `rootCA.pem` (find it with `mkcert -CAROOT`). Desktop browsers on other machines can click through the warning for testing.

Find your LAN IP on Windows with `ipconfig`, or on macOS/Linux with `ip addr` / `ipconfig getifaddr en0`. Allow inbound TCP 3001 in your firewall.

### C. Friends anywhere, no server (quick tunnel)

A tunnel gives you a public `https://` URL that forwards to your machine:

```bash
npm run build && npm start
cloudflared tunnel --url http://localhost:3001      # or: ngrok http 3001
```

Share the printed `https://….trycloudflare.com/r/<room>` link. Socket.IO websockets work through both. Only the web traffic is tunneled. WebRTC media still goes peer to peer, so add TURN (section 2) if a friend can't connect.

### D. Production: a server with a domain

Run Node on a VPS and put Caddy in front. Caddy gets and renews Let's Encrypt certificates automatically and proxies websockets.

```
# /etc/caddy/Caddyfile
watch.example.com {
    reverse_proxy localhost:3001
}
```

```bash
# on the server
npm ci && npm run build
TRUST_PROXY=1 PORT=3001 npm start     # run under systemd/pm2 in practice
```

With nginx instead, proxy `/socket.io/` with `proxy_http_version 1.1`, `Upgrade`, and `Connection "upgrade"` headers.

Room state is in memory. Run **one** Node process; rooms reset when it restarts.

---

## 2. TURN (coturn)

### Do I need it?

- Everyone on the same Wi-Fi: no.
- Friends on typical home broadband: usually not, since STUN (default `stun:stun.l.google.com:19302`) is enough.
- Anyone on mobile data, campus/corporate networks, or a voice/screen indicator stuck on "connecting" or showing "failed": **yes**.

Each person's row in the sidebar shows how their voice connected: `local network`, `direct`, or `via TURN`.

### Install coturn on a VPS

Any small Linux VPS with a public IP works. TURN uses bandwidth roughly equal to the relayed streams; a screen share at ~2.5 Mbps to three guests is ~7.5 Mbps.

```bash
sudo apt install coturn
```

`/etc/turnserver.conf`:

```
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=REPLACE_WITH_A_LONG_RANDOM_STRING
realm=turn.example.com
# Public IP of the VPS (and private IP if it's behind 1:1 NAT, e.g. AWS/GCP):
external-ip=203.0.113.10
# external-ip=203.0.113.10/10.0.0.5
min-port=49160
max-port=49200
# TLS (lets TURN work on networks that only allow 443-style traffic):
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
no-cli
no-multicast-peers
# Don't let the relay reach private networks:
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

Enable and open the firewall:

```bash
sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl restart coturn
sudo ufw allow 3478/udp && sudo ufw allow 3478/tcp && sudo ufw allow 5349/tcp && sudo ufw allow 49160:49200/udp
```

### Point WatchTogether at it

`.env` on the app server:

```
TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
TURN_SECRET=REPLACE_WITH_A_LONG_RANDOM_STRING     # same as static-auth-secret
TURN_TTL_SECONDS=43200
```

With `TURN_SECRET`, each person gets **short-lived credentials when they join a room** (coturn's TURN REST scheme: `username = <expiry>:<label>`, `credential = base64(HMAC-SHA1(secret, username))`). Credentials are never served from a public endpoint or baked into the JS bundle. Static `TURN_USERNAME`/`TURN_CREDENTIAL` also work (coturn `lt-cred-mech` + `user=name:pass`) if you prefer.

Managed TURN (Twilio, Cloudflare Calls TURN, Metered, Xirsys) works too: put their URLs and credentials in `TURN_URLS` + `TURN_USERNAME`/`TURN_CREDENTIAL`. Their credentials usually expire, so you'd need to rotate them or add a small fetch in `server/ice.ts`.

### Prove TURN works

1. **Force relay.** Set `ICE_TRANSPORT_POLICY=relay` and restart. Browsers may now only use TURN, so if voice connects, TURN works. The sidebar should say `via TURN`. Remove it afterwards: relay-only adds latency and server bandwidth.
2. **Automated.** With the same env vars:
   ```bash
   npm run build
   TURN_URLS=... TURN_SECRET=... ICE_TRANSPORT_POLICY=relay npx playwright test turn-relay
   ```
3. **Manual.** Use the WebRTC "Trickle ICE" sample page with your TURN URL and a generated username/credential, and look for `typ relay` candidates.

---

## Checklist before inviting friends from other networks

- [ ] Room URL is `https://` (or a tunnel URL).
- [ ] TURN configured (`[watchtogether] … TURN: configured` in the server log).
- [ ] Tested once with `ICE_TRANSPORT_POLICY=relay`, then switched back.
- [ ] Host uses desktop Chrome/Edge, and picks a **tab** when the content has sound.
- [ ] Everyone uses headphones (prevents the host's tab audio and others' voices from echoing through mics).
