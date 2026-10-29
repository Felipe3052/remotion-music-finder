#!/usr/bin/env node
// Find, fetch, analyse and fit licensed background music for videos.
// Needs Node 18+ and ffmpeg/ffprobe on PATH; no npm dependencies.
//
//   node music.mjs search "upbeat friendly app promo" --use=ad --length=20 [--sources=openverse,jamendo,freesound] [--limit=8]
//   node music.mjs get 3 [--from=music/candidates.json] [--dir=public/music]
//   node music.mjs analyze public/music/track.mp3
//   node music.mjs fit public/music/track.mp3 --length=20 [--start=auto|12.5] [--fade=1.5] [--lufs=-16] [--out=public/music/track-fit.mp3]
//
// search  writes music/candidates.json and music/previews/<n>.mp3 (30 s each)
//         for the user to listen to; it never decides alone.
// get     downloads the chosen candidate and appends its licence to music/CREDITS.md
//         and music/credits.json.
// analyze prints duration, loudness (LUFS), true peak, tempo (BPM) and the beat grid,
//         and writes <file>.analysis.json for timing cuts in Remotion.
// fit     trims to the video length on a bar boundary, fades out, normalises loudness.
//
// API keys (optional): JAMENDO_CLIENT_ID (devportal.jamendo.com),
// FREESOUND_API_KEY (freesound.org/apiv2/apply). Openverse needs none.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name, fallback) => rest.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const positional = rest.filter((a) => !a.startsWith("--"));
const UA = "remotion-music-finder/1.0 (+https://github.com/Felipe3052/remotion-music-finder)";

// ---------------------------------------------------------------- licences

/**
 * What a licence allows for a given use. "ad" = paid advertising, "commercial" =
 * organic posts of a business, app store videos, client work; "personal" =
 * non-commercial. Platform rules can be stricter (see SKILL.md).
 */
const LICENSES = {
  cc0: { name: "CC0 1.0", commercial: true, modify: true, attribution: false },
  pdm: { name: "Public Domain Mark", commercial: true, modify: true, attribution: false },
  by: { name: "CC BY", commercial: true, modify: true, attribution: true },
  "by-sa": { name: "CC BY-SA", commercial: true, modify: true, attribution: true, shareAlike: true },
  "by-nd": { name: "CC BY-ND", commercial: true, modify: false, attribution: true },
  "by-nc": { name: "CC BY-NC", commercial: false, modify: true, attribution: true },
  "by-nc-sa": { name: "CC BY-NC-SA", commercial: false, modify: true, attribution: true, shareAlike: true },
  "by-nc-nd": { name: "CC BY-NC-ND", commercial: false, modify: false, attribution: true },
  sampling: { name: "Sampling+", commercial: false, modify: true, attribution: true },
};

/** Licence key from a code ("by-nc") or a creativecommons.org URL. */
const licenseKey = (s = "") => {
  const t = s.toLowerCase();
  if (t.includes("publicdomain/zero") || t === "cc0" || t.includes("creative commons 0")) return "cc0";
  if (t.includes("publicdomain/mark") || t === "pdm") return "pdm";
  if (t.includes("sampling")) return "sampling";
  const m = t.match(/licenses\/([a-z-]+)\//) ?? t.match(/^(by(?:-nc)?(?:-sa|-nd)?)$/);
  if (m) return m[1];
  if (t.includes("attribution noncommercial")) return "by-nc";
  if (t.includes("attribution")) return "by";
  return "unknown";
};

/** green = fine for this use, yellow = fine with conditions, red = not allowed. */
const verdict = (key, use) => {
  const l = LICENSES[key];
  if (!l) return { light: "red", why: "unknown licence – check the source page" };
  if (use !== "personal" && !l.commercial) return { light: "red", why: `${l.name} forbids commercial use` };
  // Trimming, looping and mixing under picture is an adaptation.
  if (!l.modify) return { light: "red", why: `${l.name} forbids adaptations (trimming/fading/mixing)` };
  const notes = [];
  if (l.attribution) notes.push("credit required (description or end card)");
  if (l.shareAlike) notes.push("share-alike: the video may have to carry the same licence");
  if (use === "ad") notes.push("check the ad platform's music rules");
  return { light: notes.length ? "yellow" : "green", why: notes.join("; ") || "free to use, no credit needed" };
};

// ------------------------------------------------------------------ sources

const getJson = async (url, timeoutMs = 25000) => {
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
};

const lengthBucket = (s) => (s <= 30 ? "short" : s <= 120 ? "medium" : "long");

const SOURCES = {
  async openverse(q, { length }) {
    const p = new URLSearchParams({ q, page_size: "20", category: "music", license_type: "commercial,modification" });
    if (length) p.set("length", length > 120 ? "long" : "medium");
    const j = await getJson(`https://api.openverse.org/v1/audio/?${p}`, 45000);
    return j.results.map((r) => ({
      source: `openverse/${r.source}`,
      title: r.title,
      artist: r.creator,
      duration: r.duration ? r.duration / 1000 : null,
      license: licenseKey(r.license_url ?? r.license),
      licenseUrl: r.license_url,
      page: r.foreign_landing_url,
      audio: r.url,
      tags: (r.tags ?? []).map((t) => t.name).slice(0, 8),
      attribution: r.attribution,
    }));
  },
  async jamendo(q, { length }) {
    const id = process.env.JAMENDO_CLIENT_ID;
    if (!id) throw new Error("set JAMENDO_CLIENT_ID (free at devportal.jamendo.com)");
    const p = new URLSearchParams({
      client_id: id, format: "json", limit: "20", search: q, include: "musicinfo licenses",
      audioformat: "mp32", vocalinstrumental: "instrumental", order: "popularity_total",
    });
    if (length) p.set("durationbetween", `${Math.max(0, length - 5)}_${Math.max(length * 4, 240)}`);
    const j = await getJson(`https://api.jamendo.com/v3.0/tracks/?${p}`);
    if (j.headers?.status !== "success") throw new Error(j.headers?.error_message ?? "Jamendo error");
    return j.results.map((r) => ({
      source: "jamendo",
      title: r.name,
      artist: r.artist_name,
      duration: r.duration,
      license: licenseKey(r.license_ccurl),
      licenseUrl: r.license_ccurl,
      page: r.shareurl,
      audio: r.audiodownload_allowed ? r.audiodownload : r.audio,
      tags: [...(r.musicinfo?.tags?.genres ?? []), ...(r.musicinfo?.tags?.vartags ?? [])].slice(0, 8),
      bpmHint: r.musicinfo?.speed,
      note: "Jamendo also sells commercial licences for NC tracks (licensing.jamendo.com).",
    }));
  },
  async freesound(q, { length }) {
    const key = process.env.FREESOUND_API_KEY;
    if (!key) throw new Error("set FREESOUND_API_KEY (free at freesound.org/apiv2/apply)");
    const lo = length ? Math.max(5, length - 5) : 10;
    const p = new URLSearchParams({
      query: q, token: key, page_size: "20", sort: "rating_desc",
      fields: "id,name,username,license,duration,previews,url,tags",
      filter: `duration:[${lo} TO 600] tag:music`,
    });
    const j = await getJson(`https://freesound.org/apiv2/search/text/?${p}`);
    return j.results.map((r) => ({
      source: "freesound",
      title: r.name,
      artist: r.username,
      duration: r.duration,
      license: licenseKey(r.license),
      licenseUrl: r.license,
      page: r.url,
      // The HQ preview (128 kbit/s MP3) needs no OAuth; the original file does.
      audio: r.previews?.["preview-hq-mp3"],
      tags: (r.tags ?? []).slice(0, 8),
    }));
  },
};

/** Libraries without a public API: links for the user to browse. */
const manualLinks = (q) => {
  const e = encodeURIComponent(q);
  return [
    { name: "Pixabay Music (Pixabay Content License)", url: `https://pixabay.com/music/search/${e}/` },
    { name: "YouTube Audio Library (YouTube only)", url: "https://studio.youtube.com/channel/UC/music" },
    { name: "Mixkit (Mixkit License)", url: `https://mixkit.co/free-stock-music/?q=${e}` },
    { name: "Uppbeat (free tier with credit)", url: `https://uppbeat.io/browse/search?query=${e}` },
    { name: "TikTok Commercial Music Library (for TikTok ads)", url: "https://ads.tiktok.com/business/creativecenter/music/pc/en" },
    { name: "Meta Sound Collection (for Facebook/Instagram)", url: "https://www.facebook.com/sound/collection/" },
  ];
};

// ------------------------------------------------------------------- audio

const ff = (args) => spawnSync("ffmpeg", ["-hide_banner", "-nostats", ...args], { encoding: "utf8", maxBuffer: 1 << 28 });
const duration = (file) =>
  Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }));

const loudness = (file) => {
  const log = ff(["-i", file, "-af", "ebur128=peak=true", "-f", "null", "-"]).stderr;
  const summary = log.slice(log.lastIndexOf("Summary:"));
  return {
    lufs: Number(summary.match(/I:\s+(-?[\d.]+) LUFS/)?.[1]),
    truePeak: Number(summary.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1]),
  };
};

/**
 * Tempo from the onset envelope: spectral-flux-like energy rise per 11.6 ms
 * hop, autocorrelated over 70–180 BPM; the phase is the offset whose beat
 * grid collects the most onset energy.
 */
const tempo = (file, maxSeconds = 90) => {
  const rate = 11025;
  const raw = execFileSync(
    "ffmpeg",
    ["-v", "error", "-t", String(maxSeconds), "-i", file, "-ac", "1", "-ar", String(rate), "-f", "f32le", "-"],
    { maxBuffer: 1 << 28 },
  );
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const hop = 128;
  const win = 512;
  const env = [];
  let prev = 0;
  for (let i = 0; i + win < x.length; i += hop) {
    let e = 0;
    for (let k = 0; k < win; k++) e += x[i + k] * x[i + k];
    e = Math.log1p(e * 100);
    env.push(Math.max(0, e - prev));
    prev = e;
  }
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  const o = env.map((v) => v - mean);
  const fps = rate / hop;
  let best = { bpm: 0, score: -Infinity };
  const scores = [];
  for (let bpm = 70; bpm <= 180; bpm += 0.25) {
    const lag = (60 / bpm) * fps;
    let s = 0;
    // Comb over two and four beats sharpens the peak against half/double tempo.
    for (const m of [1, 2, 4]) {
      const L = lag * m;
      const l0 = Math.floor(L);
      const f = L - l0;
      for (let i = 0; i + l0 + 1 < o.length; i++) s += o[i] * (o[i + l0] * (1 - f) + o[i + l0 + 1] * f);
    }
    scores.push(s);
    if (s > best.score) best = { bpm, score: s };
  }
  const sorted = [...scores].sort((a, b) => b - a);
  // How far the winning tempo stands out from the typical one (0 = no clear beat).
  const median = sorted[Math.floor(sorted.length / 2)];
  const spread = best.score - sorted[sorted.length - 1] || 1;
  const confidence = Math.max(0, Math.min(1, (best.score - median) / spread));
  const period = (60 / best.bpm) * fps;
  let phase = { off: 0, sum: -Infinity };
  for (let off = 0; off < period; off++) {
    let sum = 0;
    for (let t = off; t < env.length; t += period) sum += env[Math.round(t)] ?? 0;
    if (sum > phase.sum) phase = { off, sum };
  }
  return { bpm: Math.round(best.bpm * 10) / 10, confidence: Math.round(confidence * 100) / 100, firstBeat: Math.round((phase.off / fps) * 1000) / 1000 };
};

const analyze = (file) => {
  const d = duration(file);
  const { lufs, truePeak } = loudness(file);
  const { bpm, confidence, firstBeat } = tempo(file);
  const beat = 60 / bpm;
  const beats = [];
  for (let t = firstBeat; t < d; t += beat) beats.push(Math.round(t * 1000) / 1000);
  return { file, duration: Math.round(d * 100) / 100, lufs, truePeak, bpm, confidence, beat, bar: beat * 4, firstBeat, beats };
};

// ---------------------------------------------------------------- commands

const commands = {
  async search() {
    const query = positional.join(" ");
    if (!query) throw new Error('usage: music.mjs search "mood genre keywords" --use=ad|commercial|personal --length=seconds');
    const use = opt("use", "commercial");
    const length = Number(opt("length", "0")) || null;
    const limit = Number(opt("limit", "8"));
    const wanted = opt("sources", "openverse,jamendo,freesound").split(",");
    const found = [];
    const status = {};
    for (const name of wanted) {
      try {
        const r = await SOURCES[name](query, { length });
        found.push(...r);
        status[name] = `${r.length} results`;
      } catch (e) {
        status[name] = `skipped: ${e.message}`;
      }
    }
    const ranked = found
      .filter((c) => c.audio)
      .map((c) => ({ ...c, ...verdict(c.license, use) }))
      .filter((c) => c.light !== "red")
      .filter((c) => !length || !c.duration || c.duration >= length * 0.9 || c.duration >= 60)
      .sort((a, b) => (a.light === b.light ? 0 : a.light === "green" ? -1 : 1))
      .slice(0, limit)
      .map((c, i) => ({ n: i + 1, ...c }));

    mkdirSync("music/previews", { recursive: true });
    for (const c of ranked) {
      const out = join("music", "previews", `${c.n}.mp3`);
      // 30 s from a third into the track: past the intro, where the body plays.
      const start = c.duration ? Math.max(0, c.duration / 3 - 5) : 0;
      const r = ff(["-y", "-ss", String(start), "-t", "30", "-user_agent", UA, "-i", c.audio, "-ac", "2", "-b:a", "128k", out]);
      c.preview = r.status === 0 ? out : null;
    }
    const result = { query, use, length, searched: status, candidates: ranked, manual: manualLinks(query) };
    writeFileSync("music/candidates.json", JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  },

  async get() {
    const n = Number(positional[0]);
    const from = opt("from", "music/candidates.json");
    const dir = opt("dir", "public/music");
    const list = JSON.parse(readFileSync(from, "utf8"));
    const c = list.candidates.find((x) => x.n === n);
    if (!c) throw new Error(`no candidate ${n} in ${from}`);
    mkdirSync(dir, { recursive: true });
    const slug = `${c.artist}-${c.title}`.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    const res = await fetch(c.audio, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    const ext = type.includes("wav") ? ".wav" : type.includes("ogg") ? ".ogg" : type.includes("flac") ? ".flac" : ".mp3";
    const file = join(dir, slug + ext);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));

    const l = LICENSES[c.license];
    const credit = c.attribution ?? `"${c.title}" by ${c.artist} (${c.page}), licensed under ${l?.name ?? c.license}${c.licenseUrl ? ` – ${c.licenseUrl}` : ""}`;
    const entry = {
      file, title: c.title, artist: c.artist, source: c.source, page: c.page, license: l?.name ?? c.license,
      licenseUrl: c.licenseUrl, attributionRequired: Boolean(l?.attribution), credit, use: list.use,
      downloaded: new Date().toISOString().slice(0, 10),
    };
    mkdirSync("music", { recursive: true });
    const jsonPath = join("music", "credits.json");
    const all = existsSync(jsonPath) ? JSON.parse(readFileSync(jsonPath, "utf8")) : [];
    writeFileSync(jsonPath, JSON.stringify([...all.filter((e) => e.file !== file), entry], null, 2));
    const md = join("music", "CREDITS.md");
    if (!existsSync(md)) writeFileSync(md, "# Music credits\n\nKeep this file with the project; it is the proof of licence for every track.\n");
    appendFileSync(md, `\n## ${basename(file)}\n\n- Title: ${c.title}\n- Artist: ${c.artist}\n- Source: ${c.page}\n- Licence: ${entry.license}${c.licenseUrl ? ` (${c.licenseUrl})` : ""}\n- Credit${entry.attributionRequired ? " (required)" : ""}: ${credit}\n- Downloaded: ${entry.downloaded}, for use: ${list.use}\n`);
    console.log(JSON.stringify(entry, null, 2));
  },

  async analyze() {
    const file = positional[0];
    if (!file) throw new Error("usage: music.mjs analyze <audio file>");
    const a = analyze(file);
    const out = file.replace(/\.[^.]+$/, "") + ".analysis.json";
    writeFileSync(out, JSON.stringify(a, null, 2));
    console.log(JSON.stringify({ ...a, beats: `${a.beats.length} beats → ${out}` }, null, 2));
  },

  async fit() {
    const file = positional[0];
    const length = Number(opt("length", "0"));
    if (!file || !length) throw new Error("usage: music.mjs fit <audio> --length=seconds [--start=auto|s] [--fade=s] [--lufs=-16]");
    const a = analyze(file);
    const fade = Number(opt("fade", "1.5"));
    const lufs = Number(opt("lufs", "-16"));
    // Start on a bar line about a third in (past the intro), so the cut is musical.
    let start = opt("start", "auto");
    if (start === "auto") {
      const target = Math.min(a.duration / 3, Math.max(0, a.duration - length));
      start = a.firstBeat + Math.max(0, Math.round((target - a.firstBeat) / a.bar)) * a.bar;
      if (start + length > a.duration) start = Math.max(0, a.duration - length);
    }
    start = Number(start);
    const tooShort = start + length > a.duration;
    const out = opt("out", join(dirname(file), `${basename(file, extname(file))}-fit-${length}s.mp3`));
    const filters = [
      `afade=t=in:st=0:d=0.05`,
      `afade=t=out:st=${Math.max(0, length - fade)}:d=${fade}`,
      `loudnorm=I=${lufs}:TP=-1.5:LRA=11`,
    ].join(",");
    const input = tooShort ? ["-stream_loop", "-1", "-i", file] : ["-ss", String(start), "-i", file];
    const r = ff(["-y", ...input, "-t", String(length), "-af", filters, "-ar", "48000", "-b:a", "192k", out]);
    if (r.status !== 0) throw new Error(r.stderr.split("\n").slice(-5).join("\n"));
    const result = { out, start: Math.round(start * 1000) / 1000, length, looped: tooShort, bpm: a.bpm, bar: a.bar, lufs, after: loudness(out) };
    console.log(JSON.stringify(result, null, 2));
  },
};

if (!commands[cmd]) {
  console.error("usage: music.mjs <search|get|analyze|fit> … (see the header of this file)");
  process.exit(1);
}
commands[cmd]().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
