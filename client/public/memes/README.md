# Meme clips

Each reaction plays a short video clip (with sound) for everyone in the room. If a clip is missing,
that reaction shows an animated emoji card instead, so you can delete or replace any of them.

To swap a clip, replace the file with the same name (H.264/AAC `.mp4` plays in every browser),
plus an optional `.jpg` poster frame:

| Reaction | Gesture | Files | Suggested length |
|---|---|---|---|
| Got it | 👍 thumbs-up | `got-it.mp4`, `got-it.jpg` | ~6 s |
| Let's go | ✌️ victory | `lets-go.mp4`, `lets-go.jpg` | ~7 s |
| Wait, doubt! | ✋ open palm | `wait-doubt.mp4`, `wait-doubt.jpg` | ~6 s |
| Wow! | 🤩 both hands on chin | `wow.mp4`, `wow.jpg` | ~4 s |
| Haha | button only | `haha.mp4`, `haha.jpg` | ~6 s |

Names, captions, gestures and on-screen durations are set in `shared/reactions.ts`.

Trim and re-encode a clip with ffmpeg (example: keep the first 6 s, fade out the end):

```bash
ffmpeg -i source.mp4 -t 6.15 -vf "fade=t=out:st=5.9:d=0.25" -af "afade=t=out:st=5.8:d=0.35" \
  -c:v libx264 -crf 24 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart got-it.mp4
ffmpeg -ss 1 -i got-it.mp4 -frames:v 1 got-it.jpg
```

## Sources

These are widely shared internet meme clips, collected from Pinterest. All rights belong to their
original creators; open an issue if you own one and want it credited differently or removed.

| File | Source | Edit |
|---|---|---|
| `got-it.mp4` | https://in.pinterest.com/pin/1130051731490659777/ | first 6.2 s (film clip; montage after the cut removed) |
| `lets-go.mp4` | https://in.pinterest.com/pin/875739090028599548/ | 1.5–8.5 s |
| `wait-doubt.mp4` | https://in.pinterest.com/pin/946459677970377898/ | first 6.2 s |
| `wow.mp4` | https://in.pinterest.com/pin/1145181011520209611/ | unedited (4.2 s) |
| `haha.mp4` | https://in.pinterest.com/pin/903112531582826569/ | first 6.2 s |
