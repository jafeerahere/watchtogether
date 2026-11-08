# Architecture

## Key decisions

| Topic | Approach |
|---|---|
| Room protocol | Socket.IO events typed in `shared/protocol.ts`. The whole room state is re-broadcast on each change (≤ 4 people, so it's tiny and avoids partial-update bugs). |
| Playback sync | A **server-clock-stamped timeline** `{playing, position, rate, updatedAt}`. Clients estimate their clock offset NTP-style, then compute `position + (now − updatedAt) × rate`. Late joiners, refreshes, and drift correction all use the same formula. |
| Control | Host controls; guests have no controls and a click shield over the player. The host role survives refreshes (20 s grace, keyed by a per-tab id) and can be handed over. |
| WebRTC | `voice` and `screen` are separate RTCPeerConnections per pair, so shared audio never mixes with voice. |
| TURN | Configured by env. Short-lived coturn REST credentials are handed out **only on room join**, never baked into the client bundle. |

## Components

```
Browser (React)                                   Node (Express + Socket.IO)
┌──────────────────────────────┐   room:*, link:*, share:*,   ┌──────────────────────────┐
│ useRoom  ── socket.io ───────┼── reaction:*, signal ───────►│ RoomStore (rooms.ts)     │
│ ServerClock (offset)         │◄── room:state, reaction, ────┤  host / share / timeline │
│ PeerMesh ── voice PCs ◄──────┼───── signal relay ───────────┤  rate limits             │
│          ── screen PCs       │                              │ iceConfigFor (ice.ts)    │
│ GesturePanel → MediaPipe     │    (camera frames stay local)└──────────────────────────┘
│ LinkStage → YouTube / <video>│
└──────────────────────────────┘
        ▲  media flows peer-to-peer (or via TURN), never through Node
```

## Screen share

- The host calls `getDisplayMedia` with audio requested and processing **off** (no echo cancellation or noise suppression, which would mangle music and lecture audio), `selfBrowserSurface: exclude`, `systemAudio: include`.
- The host sends `share:start {hasAudio, surface}`; the server marks the room `share` mode and clears any link. The server broadcasts **before** acknowledging, so the host never sees a stale state that would cancel its own share.
- `PeerMesh` opens a `screen` connection to each guest (send-only transceivers, 2.5 Mbps cap). Opus on this channel is negotiated as stereo at 128 kbps.
- An "Optimize for: Text & slides / Video" toggle sets the track's `contentHint` (`detail` keeps text sharp; `motion` keeps frame rate).
- If audio is missing, the host gets a reason based on browser, OS, and surface (window capture never has audio; macOS screen capture can't include system audio; Firefox/Safari capture no audio).
- When the browser's own "Stop sharing" button ends the track, the share is torn down for everyone. After a reconnect, the host's live capture is re-announced automatically.

## Voice

Full mesh, one `voice` RTCPeerConnection per pair, using the **perfect negotiation** pattern (polite/impolite by id). Either side can add a mic later and renegotiate without glare. Mic off uses `replaceTrack(null)` and stops the device. Connections are created lazily: no mic on either side means no connection. ICE restarts on `failed`, or after 4 s of `disconnected`. The sidebar shows the selected candidate type (local, direct, or TURN) from `getStats()`.

## Synced links

- `checkMediaLink` (shared by client and server) accepts YouTube video links and direct media files, and returns a specific reason for everything else.
- Host: its player is the source of truth. It polls every 400 ms (plus player events) and sends `link:control` when play state, rate, or position drifts more than 1 s from what it last sent.
- Guests: every second and on every update, compare with the timeline. Seek if drift > 1 s while playing (> 0.2 s while paused). Small drifts get at most one correction every 2.5 s so slow connections don't loop; large gaps retry after 0.8 s. A "Start playback" overlay appears if the browser blocks autoplay.
- Player errors (YouTube error codes, `MediaError` codes) are translated into reasons. Guests report them, so the host sees "⚠ can't play the link" next to that person and can switch to sharing a tab.

## Gestures

`GesturePanel` opens the camera only while gestures are on. It lazily imports `@mediapipe/tasks-vision` (its own ~126 kB chunk plus WASM, an 8 MB gesture model and a 0.2 MB face model, served locally) and runs `GestureRecognizer` (2 hands) in VIDEO mode at ~12 fps, GPU delegate with CPU fallback.

The *Wow!* pose (both hands on the chin) isn't a built-in MediaPipe gesture. When two hands are visible, `FaceDetector` (BlazeFace) also runs. The chin is estimated from the eye and mouth keypoints (mouth + 0.55 × eyes→mouth, so it follows head tilt). The pose matches when both hands have a contact landmark (wrist, thumb, finger bases or tips) within 0.7 × face width of the chin, sit below the eyes, and are two distinct hands. When both hands are merely near the face, built-in gestures are suppressed so an open palm under the chin doesn't fire *Wait, doubt!*. `GestureDetector` turns frame labels into deliberate reactions: score ≥ 0.6, hold 700 ms, flicker tolerance 250 ms, 3 s cooldown, must release before repeating. The client applies a 2.5 s cooldown shared with the manual buttons; the server enforces 1 s per person. Only `{kind, via}` is sent.

## Limits and next steps

- Rooms are in memory in one process, which is fine for small groups. Horizontal scaling would need Redis for room state plus the Socket.IO Redis adapter.
- Mesh upload grows with room size: the host uploads one screen stream per guest (3 × 2.5 Mbps at 4 people). Past ~4–5 people, move screen share to an SFU (LiveKit, mediasoup).
- Not built yet: text chat, playlists, HLS (`hls.js`), subtitles, room passwords.
