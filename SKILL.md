---
name: remotion-music-finder
description: Find licensed background music that fits a video, instead of synthesising it. Derives mood, tempo and length from what is being built, searches free libraries (Openverse, Jamendo, Freesound) with a licence check for the intended use, makes previews for the user to choose, keeps a licence record, detects tempo and beats, fits the track to the video length on a bar line and wires it into Remotion. Use it whenever a Remotion video needs music or someone asks for background music, a soundtrack, BGM or royalty-free music.
---

# Remotion music finder

Generated music usually sounds like a placeholder. Real tracks from free
libraries sound better, but only if the licence fits the use. This skill finds
candidates; **the user listens and chooses**, because you cannot hear the
music, and taste is theirs. Answer in the user's language.

Requirements: Node 18+, `ffmpeg` and `ffprobe` on PATH. The script
`<skill>/scripts/music.mjs` needs no npm packages. `<skill>` below means the
folder of this SKILL.md. Run the script from the project root.

## 1. Brief

Work out the brief from the video, its script or composition, and the
conversation. Ask only for what you cannot infer:

- **Use** (most important, decides the licence):
  - `ad`: paid ads on Meta, TikTok, YouTube or Google
  - `commercial`: organic posts of a company or product, app store videos,
    client work
  - `personal`: non-commercial
- **Length** of the video in seconds, and whether music runs the whole time.
- **Mood and energy:** for example calm, warm, upbeat, epic, playful, tense or
  corporate. Note the pace of the cuts too: fast cuts need about 110–130 BPM,
  calm product shots about 70–95 BPM.
- **Genre and instruments** if they matter, for example lo-fi, acoustic,
  electronic, piano or cinematic. Choose instrumental under speech or text.
- **Platforms** where it will run, because their rules can be stricter
  (step 3).

Turn the brief into 2–3 short search queries of mood, genre and use. For
example: `upbeat acoustic positive`, `bright electronic tech product`.

## 2. Search and shortlist

```bash
node <skill>/scripts/music.mjs search "upbeat acoustic positive" --use=commercial --length=20
```

- The script queries Openverse (no key needed), plus Jamendo when
  `JAMENDO_CLIENT_ID` is set and Freesound when `FREESOUND_API_KEY` is set.
  Both keys are free. If a source is skipped, tell the user why.
- It drops every track whose licence is wrong for the use. These are tracks
  that forbid commercial use or adaptations; trimming and fading count as an
  adaptation.
- It writes `music/candidates.json` and 30-second previews to
  `music/previews/<n>.mp3`.
- It also lists libraries without an API (Pixabay Music, YouTube Audio
  Library, Mixkit, Uppbeat, TikTok Commercial Music Library, Meta Sound
  Collection) as search links.

Try 2–3 queries and merge the best results into one shortlist of 3–5 tracks.
Show the user a table:

| # | Title / artist | Length | Licence | Light | Why it fits | Preview |
|---|---|---|---|---|---|---|

The "Light" column means:
- **green**: free to use, no credit needed
- **yellow**: allowed with conditions (credit, share-alike, platform rules).
  Name the condition.

Red tracks never appear. Then **stop and let the user listen and choose.**
They may also bring their own file, for example from a manual link. In that
case ask where it comes from and which licence it has, and record it the same
way (step 4).

## 3. Licence check (do not skip)

- **CC0 / Public Domain:** free to use.
- **CC BY:** free to use, but the credit must appear somewhere viewers can
  see it, such as the video description, the end card or the app store
  listing.
- **CC BY-SA:** allowed, but the video may have to be shared under the same
  licence. For ads and brand videos, prefer something else.
- **NC (non-commercial) and ND (no derivatives):** not for business videos.
  Trimming and mixing a track under a picture is already a derivative.
  Jamendo sells commercial licences for its NC tracks.
- **Library licences** (Pixabay, Mixkit, Uppbeat, YouTube Audio Library):
  read the current terms on the track page. Some exclude standalone resale,
  are tied to one platform, or require a credit on the free tier.
- **Platforms:**
  - Paid TikTok ads are generally limited to TikTok's Commercial Music
    Library or music you hold the rights to.
  - Meta has its own Sound Collection.
  - On YouTube, even "free" tracks can trigger Content ID claims. Keep the
    licence proof so you can dispute them.

  These rules change; tell the user to check them for the platform they
  use.
- **No proof, no music:** if the licence cannot be found on the source page,
  do not use the track.

## 4. Download and record

```bash
node <skill>/scripts/music.mjs get <n>
```

This downloads the track to `public/music/`. It appends title, artist, source
page, licence, required credit, date and use to `music/CREDITS.md` and
`music/credits.json`. Commit both files, because they are the proof of
licence. Tell the user the exact credit line, if one is required, and where
to put it.

## 5. Analyse and fit

```bash
node <skill>/scripts/music.mjs analyze public/music/<track>.mp3
node <skill>/scripts/music.mjs fit public/music/<track>.mp3 --length=20
```

- **`analyze`** writes `<track>.analysis.json`, containing:
  - `bpm`, `firstBeat`, `beat`, `bar` and all `beats`, so cuts can sit on
    the music
  - `lufs` and `truePeak`

  A `confidence` below ~0.7 means there is no clear beat (ambient, rubato),
  so do not snap cuts to it.
- **`fit`** cuts the track to the video length, starting on a bar line about
  a third into the track (past the intro). It fades out at the end
  (`--fade=1.5`), normalises the loudness (`--lufs=-16`; use about −14 for
  social media) and loops when the track is too short. Pass `--start=<s>` if
  the user wants a specific part.

## 6. Wire into Remotion

```tsx
import { Audio, interpolate, staticFile, useVideoConfig } from "remotion";
import analysis from "../public/music/track-fit-20s.analysis.json"; // optional, for beat-timed cuts

export const Music: React.FC = () => {
  const { fps, durationInFrames } = useVideoConfig();
  return (
    <Audio
      src={staticFile("music/track-fit-20s.mp3")}
      volume={(f) =>
        interpolate(f, [0, 0.4 * fps, durationInFrames - 1.5 * fps, durationInFrames], [0, 0.8, 0.8, 0], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })
      }
    />
  );
};
```

- **Beat-timed cuts:** convert beat times to frames with
  `Math.round(t * fps)`. Let scene lengths be whole bars
  (`analysis.bar * fps`), and place hits, such as a logo or the CTA, on a
  downbeat.
- **Under a voice-over:** lower the music to about 0.25–0.35 while the voice
  speaks, and raise it again in the pauses.
- **Check:** render, then check the result (with `remotion-video-check` if it
  is installed). Make sure the peak sits between −6 and −0.5 dB and the
  music ends with the video.

## 7. Report

Report back in the user's language:
- the chosen track with its licence and the required credit
- where the licence record is
- the BPM, and whether the cuts follow the beat
- anything the user still has to do, for example putting the credit in the
  video description or checking the platform's music rules
