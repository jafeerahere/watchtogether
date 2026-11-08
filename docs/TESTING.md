# What's been tested, and how

There are two very different levels of "it works" for a WebRTC app:

- **Two browser sessions** on one machine share a network stack. Peers find each other through local host candidates, so NAT traversal, real bandwidth limits, packet loss, and device differences are never exercised.
- **Two real devices on different networks** (say, a laptop on home Wi-Fi and a phone on mobile data) exercise STUN/TURN, NATs, firewalls, real latency, and real hardware.

Everything below marked ✅ was verified on **one Windows 11 machine** with Google Chrome driven by Playwright, using separate browser contexts as separate people. **Nothing has been tested yet across two real devices or two different networks.** That still needs to be done by hand (checklist at the end).

## Automated tests

### Unit (`npm test`, Vitest, 50 tests)

- Room rules: creation, 4-person cap, a refreshing tab reclaims its seat instead of taking a new one, host keeps the role through a 20 s disconnect grace and then the longest-present guest is promoted, only the host can share/link/control, share ends when the sharer leaves, link replaces share, host handoff stops the old host's share, empty rooms expire.
- Playback timeline math (`expectedPosition`) with play/pause/seek/rate, plus rejection of malformed control messages.
- Reaction rate limit (server floor of 1 per second per person).
- Link classification: YouTube variants (`watch`, `youtu.be`, `shorts`, `live`, `m.`, `t=` start times), direct files, Dropbox rewrite, and explained rejections (DRM services, playlists, HLS/DASH, Drive, Vimeo and other page hosts, MKV, plain web pages, `file://`).
- Gesture detector: fires after the hold and not before; no repeat while still held; re-fires after release + cooldown; cooldown applies across gestures; tolerates one-frame recognizer flicker; resets on real gaps; ignores low-confidence and unmapped gestures; manual buttons start the cooldown.
- TURN: coturn REST credentials verify against an independent HMAC; static credentials; relay policy.
- Chat: messages carry sender and server time and go into history; empty, non-text, and outsider messages are rejected; 5-per-5 s rate limit is per person; history is capped at 200; late joiners get earlier messages; join/leave notices fire, but a refresh or reconnect stays silent; text cleaning (control characters, line breaks, length cap; markup kept as text).
- Wow pose (`chinPose.ts`) on synthetic landmarks: both hands cupping the chin (also with a tilted head) fires; one hand, no face, hands far away, hands on the forehead, and one hand reported twice don't; two hands near the face suppress the built-in gestures so an open palm there isn't read as *Wait, doubt!*.

### End-to-end (`npm run build && npm run test:e2e`, Playwright + installed Chrome, headless)

`e2e/room.spec.ts`: one scenario with up to 5 independent browser contexts. Passed 3/3 consecutive full-suite runs.

| Step | Verified | Measured |
|---|---|---|
| Create room → invite link → guest joins | ✅ | |
| Only host sees share controls | ✅ | |
| Host screen share → guest gets live frames (frame counter increasing) | ✅ (capture **stubbed**: canvas + tone instead of the OS picker) | |
| Shared-audio badge "on" for guests; audio track present in the screen stream | ✅ | |
| Voice: both mics on → connected both ways, remote audio element playing | ✅ (Chrome fake mic) | |
| Voice stream and screen stream are separate streams/elements | ✅ | |
| Button reaction → meme with sender's name shown to everyone; cooldown disables and re-enables buttons | ✅ | |
| All five memes (*Got it*, *Let's go*, *Wait, doubt!*, *Wow!*, button-only *Haha*) show for the other person: with local clips they play **unmuted**; with the clips removed, the emoji fallback card shows | ✅ both modes | |
| DRM link → explanation + "Share a tab instead" | ✅ | |
| Direct media link: play / seek / pause sync | ✅ | play 0.05–0.07 s, seek ≈0.23 s, pause 0.00 s apart |
| Late joiner lands at the live position | ✅ | ≈0.2 s apart |
| Gesture camera: on-device gesture + face models load locally and reach "ready" (Wow! pose available); others see 📷 | ✅ (fake camera, so no hands and no gesture fired) | |
| 5th person sees "room is full" | ✅ | |
| Host refreshes → still host, room keeps going | ✅ | |

`e2e/chat.spec.ts`: live chat between three browser sessions.

| Check | Verified |
|---|---|
| "Gus joined" notice reaches others live | ✅ |
| "Gus is typing…" shows while typing and clears after sending | ✅ |
| Enter sends; Shift+Enter keeps a line break; sender sees "You", others see the name | ✅ |
| `<img onerror=…>` in a message renders as text: no element, no script runs | ✅ |
| `https://…` becomes a link opening in a new tab | ✅ |
| Late joiner gets the history | ✅ |
| Guest refresh: rejoins automatically, history restored, no "left/joined" spam | ✅ |
| Closing a tab posts "Lia left" | ✅ |
| 6th message within 5 s is refused with a visible reason; the draft is kept; others never receive it | ✅ |

`e2e/layout.spec.ts`: room layout and view modes.

| Check | Verified |
|---|---|
| Chat is the default tab and uses most of the panel height; People is one click away; a half-typed message survives tab switches | ✅ |
| Collapsing the panel hides it; new messages from others count up on the `‹ 💬 Chat` badge; reopening clears it and shows the newest message | ✅ |
| Unread also counts while the People tab is open | ✅ |
| Theatre hides the header and keeps video + chat; it's remembered after a refresh | ✅ |
| `T`/`F`/`C` shortcuts work, but not while typing in chat | ✅ |
| `F` enters real browser full screen of the whole room (video only to start); `C` slides chat in and messages keep arriving | ✅ |
| Full-screen controls hide after ~2.5 s idle and return on mouse movement | ✅ |
| Leaving full screen returns to the previous layout (theatre, panel open) | ✅ |

Not covered by automation: pressing `Esc` (the browser handles it outside the page). The app listens for the browser's full-screen exit, which is the same path the exit button uses.

`e2e/real-sources.spec.ts`:

| Check | Verified | Notes |
|---|---|---|
| **Real** `getDisplayMedia` (no stub) → guest receives live frames | ✅ | Chrome's auto-accept picked the **whole screen** (`displaySurface=monitor`) with **system audio** (`audio=true`); the UI labels and audio badge matched. |
| **Real YouTube** embed (Big Buck Bunny), host uses YouTube's own play button / player API | ✅ | play 0.1–0.6 s, seek 0.13–0.65 s apart; pause propagates. Needs internet (`SKIP_NETWORK=1` skips it). |

`e2e/turn-relay.spec.ts` (runs only with `ICE_TRANSPORT_POLICY=relay` + `TURN_*`):

| Check | Verified | Notes |
|---|---|---|
| Voice and screen share connect with **relay-only** ICE; sidebar says "via TURN" | ✅ against a local `node-turn` server on the machine's LAN IP | Proves the app's TURN config path and relay media flow. It is **not** coturn and **not** a real NAT. Gotcha found: with mic permission granted, Chrome won't reach a TURN server bound to `127.0.0.1`, so test TURN on a LAN/public IP. |

Also checked manually: `npm run dev` serves the app through Vite, `/api` and Socket.IO websockets work through the Vite proxy, and MediaPipe assets are served locally.

## Not verified yet

- ❌ **Two real devices on different networks.** No STUN/NAT traversal across the internet, no coturn, no real TURN fallback.
- ❌ The **OS share picker** by a person: choosing a tab vs. window, the "Share tab audio" checkbox, the browser's "Stop sharing" bar. (Code handles these; automation can't click the native picker.)
- ❌ Real **hand gestures** in front of a real camera, **including the two-hands-on-chin Wow! pose**. Its thresholds (`reach`, the chin estimate) are tuned on synthetic landmarks only and may need adjusting for real faces, distances, and lighting; see `DEFAULT_CHIN_OPTIONS` in `chinPose.ts`.
- ❌ Firefox, Safari, mobile browsers. Expected: Firefox shares screens but without audio; Safari shares screens without audio; phones can't screen share but can watch, talk, and react.
- ❌ YouTube errors 101/150 (embedding disabled) on a live video. The message mapping is unit-tested but not hit live.
- ❌ Long sessions (1h+), bad Wi-Fi, packet loss, 4 people all talking while the host shares.
- ❌ The HTTPS setups in DEPLOY.md (mkcert, tunnel, Caddy). They're standard but weren't run here.

## Manual two-device test plan

Use this once the app is deployed with HTTPS (DEPLOY.md):

1. **Laptop A** (home Wi-Fi, Chrome): create a room. **Phone or laptop B** on **mobile data / hotspot**: open the invite link.
2. Both turn mics on. Check each sidebar row shows `connected · direct` or `connected · via TURN`. If it's stuck on `connecting`/`failed`, configure TURN.
3. A shares a **Chrome tab** playing a video with sound. B should see the feed, the "🔊 Shared audio on" badge, and be able to set shared-audio volume separately from voice volume.
4. A shares a **window** instead. B should see "🔇 No shared audio", and A should see the explanation.
5. A pastes a YouTube link and plays, seeks, and pauses. B follows within ~1 s. B refreshes mid-video and rejoins at the live position.
6. B turns on gestures and holds 👍 for about a second. Both see "GOT IT". Holding it longer must not repeat. ✌️ and ✋ work after the cooldown. Then both hands on the chin: everyone sees and **hears** the Wow! clip, and it must not trigger "Wait, doubt!".
7. Repeat step 2 with `ICE_TRANSPORT_POLICY=relay` to confirm TURN carries everything.
8. Record which browsers, OSes, and networks you used next to each result.
