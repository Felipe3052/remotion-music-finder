# remotion-music-finder

An agent skill for Claude Code and other agents that read `SKILL.md` that
finds **licensed background music** for your Remotion videos, instead of
letting the agent synthesise something that sounds like a placeholder.

## What it does

1. **Brief:** It works out the use of the video (ad, commercial, personal),
   its length, mood and pace.
2. **Search:** It queries Openverse (no key needed) and, if keys are set,
   Jamendo and Freesound. It also lists libraries without an API as links:
   Pixabay Music, YouTube Audio Library, Mixkit, Uppbeat, TikTok Commercial
   Music Library and Meta Sound Collection.
3. **Licence check:** It drops tracks whose licence doesn't allow the use, for
   example NC for business videos or ND, since trimming is an adaptation. It
   marks each remaining track green (free) or yellow (credit, share-alike or
   platform rules).
4. **You choose:** It renders 30-second previews of 3–5 candidates and lets
   you listen, because the agent can't hear music.
5. **Licence record:** It saves title, artist, source, licence, credit line and
   date to `music/CREDITS.md` and `credits.json`.
6. **Analyse and fit:**
   - finds tempo (BPM), beat grid and loudness
   - cuts the track to the video length, starting on a bar line
   - fades it out, normalises loudness (LUFS) and loops it if it's too short
7. **Remotion:** It wires the track in with a volume envelope and gives you
   the beat times so cuts can land on the music.

## Install

You need Node 18+ and `ffmpeg` / `ffprobe` on PATH. No npm packages are
needed.

```bash
git clone https://github.com/Felipe3052/remotion-music-finder ~/.claude/skills/remotion-music-finder
```

Optional free API keys for more results:

```bash
export JAMENDO_CLIENT_ID=...   # https://devportal.jamendo.com
export FREESOUND_API_KEY=...   # https://freesound.org/apiv2/apply
```

## Use

Ask your agent for music ("add fitting background music to this promo") and
the skill takes over. You can also run the script by hand:

```bash
node ~/.claude/skills/remotion-music-finder/scripts/music.mjs search "upbeat acoustic positive" --use=commercial --length=20
node ~/.claude/skills/remotion-music-finder/scripts/music.mjs get 2
node ~/.claude/skills/remotion-music-finder/scripts/music.mjs analyze public/music/<track>.mp3
node ~/.claude/skills/remotion-music-finder/scripts/music.mjs fit public/music/<track>.mp3 --length=20 --lufs=-14
```

| Command | Result |
|---|---|
| `search "<query>" --use=ad\|commercial\|personal --length=s [--sources=openverse,jamendo,freesound] [--limit=8]` | `music/candidates.json`, `music/previews/<n>.mp3` |
| `get <n> [--dir=public/music]` | track file, `music/CREDITS.md`, `music/credits.json` |
| `analyze <file>` | `<file>.analysis.json` with BPM, beats, bar, LUFS, true peak |
| `fit <file> --length=s [--start=auto\|s] [--fade=1.5] [--lufs=-16] [--out=…]` | fitted MP3 starting on a bar line |

## Status

v1.0.0: Tempo detection, fitting, download and the licence record are tested.
Live search and preview generation have not been verified end to end yet: Openverse
timed out during testing, and Jamendo and Freesound need keys. If you try it,
please open an issue with the result.

## Not legal advice

The licence check follows the Creative Commons terms and the libraries'
published licences. Platform rules, such as TikTok ads and YouTube Content
ID, change and are stricter in places. Check the terms for your use, and
keep `CREDITS.md` as your proof.

## Works well with

- [remotion-video-check](https://github.com/Felipe3052/remotion-video-check):
  visually checks the rendered video afterwards and fixes what is wrong.
- The official [Remotion skills](https://github.com/remotion-dev/skills)
  for writing compositions.

## License

MIT, see `LICENSE`.
