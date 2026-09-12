// index.js — Profanity Filter Addon (Stremio / Nuvio), single-file version
//
// Wraps an existing stream addon and subtitle addon: censors profanity in
// subtitles, and mutes audio during profane subtitle lines.
//
// Requires: Node 18+, ffmpeg installed and on PATH.
// Install deps: npm install express node-fetch@2
// Run: node index.js

const express = require("express");
const fetch = require("node-fetch");
const { spawn } = require("child_process");

// ============================================================
// CONFIG — edit these or set as environment variables
// ============================================================
const config = {
  PORT: process.env.PORT || 7000,
  SELF_URL: process.env.SELF_URL || `http://127.0.0.1:${process.env.PORT || 7000}`,
  // Base URL of an upstream Stremio-protocol stream addon (e.g. Torrentio, a debrid addon)
  UPSTREAM_STREAM_ADDON: process.env.UPSTREAM_STREAM_ADDON || "",
  // Base URL of an upstream Stremio-protocol subtitle addon (e.g. OpenSubtitles v3)
  UPSTREAM_SUBTITLE_ADDON: process.env.UPSTREAM_SUBTITLE_ADDON || "",
  // "mute" = silence audio during profane lines, "duck" = lower volume instead
  AUDIO_MODE: process.env.AUDIO_MODE || "mute",
  DUCK_VOLUME: process.env.DUCK_VOLUME || "0.1"
};

// ============================================================
// MANIFEST
// ============================================================
const manifest = {
  id: "com.yourname.profanityfilter",
  version: "0.1.0",
  name: "Profanity Filter",
  description: "Censors cuss words in subtitles and mutes audio during profane lines.",
  resources: ["stream", "subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt"],
  catalogs: [],
  behaviorHints: { configurable: false, p2p: false }
};

// ============================================================
// PROFANITY WORD LIST — extend this array freely
// ============================================================
const profanityList = [
  "damn", "hell", "ass", "bastard", "bitch", "crap", "piss", "dick",
  "shit", "fuck", "cunt", "asshole", "motherfucker", "bullshit"
  // add slurs/variants/leetspeak forms as needed
];

// ============================================================
// TEXT CENSORING
// ============================================================
const sortedWords = [...profanityList].sort((a, b) => b.length - a.length);
const profanityPattern = new RegExp(`\\b(${sortedWords.join("|")})\\b`, "gi");

function maskWord(word) {
  if (word.length <= 1) return "*";
  return word[0] + "*".repeat(word.length - 2) + word[word.length - 1];
}

function censorText(text) {
  let matched = false;
  const out = text.replace(profanityPattern, (w) => {
    matched = true;
    return maskWord(w);
  });
  return { text: out, matched };
}

// ============================================================
// SRT / VTT PARSING
// ============================================================
function timeToSeconds(t) {
  const m = t.trim().match(/(\d+):(\d{2}):(\d{2})[.,](\d{3})/);
  if (!m) return 0;
  const [, h, min, s, ms] = m;
  return (+h) * 3600 + (+min) * 60 + (+s) + (+ms) / 1000;
}

function secondsToTime(sec, sep) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec - Math.floor(sec)) * 1000);
  const pad = (n, l = 2) => String(n).padStart(l, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms, 3)}`;
}

function isVtt(content) {
  return /^\uFEFF?WEBVTT/.test(content.trim());
}

function parseSubtitle(content) {
  const format = isVtt(content) ? "vtt" : "srt";
  const blocks = content
    .replace(/\r/g, "")
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter(Boolean);

  const cues = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const timeLineIdx = lines.findIndex((l) => l.includes("-->"));
    if (timeLineIdx === -1) continue;

    const [startStr, endStrRaw] = lines[timeLineIdx].split("-->");
    const endStr = endStrRaw.trim().split(" ")[0];
    const text = lines.slice(timeLineIdx + 1).join("\n");

    cues.push({
      index: cues.length + 1,
      start: timeToSeconds(startStr),
      end: timeToSeconds(endStr),
      text
    });
  }
  return { format, cues };
}

function serializeSubtitle(format, cues) {
  const sep = format === "vtt" ? "." : ",";
  const header = format === "vtt" ? "WEBVTT\n\n" : "";
  const body = cues
    .map((c) => `${c.index}\n${secondsToTime(c.start, sep)} --> ${secondsToTime(c.end, sep)}\n${c.text}`)
    .join("\n\n");
  return header + body + "\n";
}

// ============================================================
// SUBTITLE FETCH + CENSOR
// ============================================================
async function fetchAndCensor(subtitleUrl) {
  const res = await fetch(subtitleUrl);
  if (!res.ok) throw new Error(`Failed to fetch subtitle: ${res.status}`);
  const raw = await res.text();

  const { format, cues } = parseSubtitle(raw);
  const muteRanges = [];

  const censoredCues = cues.map((cue) => {
    const { text, matched } = censorText(cue.text);
    if (matched) muteRanges.push({ start: cue.start, end: cue.end });
    return { ...cue, text };
  });

  return {
    body: serializeSubtitle(format, censoredCues),
    contentType: format === "vtt" ? "text/vtt" : "application/x-subrip",
    muteRanges
  };
}

async function censorRoute(req, res) {
  const src = req.query.src;
  if (!src) return res.status(400).send("Missing ?src=");
  try {
    const { body, contentType } = await fetchAndCensor(decodeURIComponent(src));
    res.set("Content-Type", contentType);
    res.send(body);
  } catch (err) {
    res.status(502).send(String(err));
  }
}

// ============================================================
// AUDIO MUTE PROXY (ffmpeg)
// ============================================================
function buildAudioFilter(ranges) {
  if (!ranges.length) return null;
  const targetVol = config.AUDIO_MODE === "duck" ? config.DUCK_VOLUME : "0";
  return ranges
    .map((r) => `volume=enable='between(t,${r.start},${r.end})':volume=${targetVol}`)
    .join(",");
}

function muteRoute(req, res) {
  const src = req.query.src;
  const rangesParam = req.query.ranges;
  if (!src) return res.status(400).send("Missing ?src=");

  let ranges = [];
  try {
    ranges = rangesParam ? JSON.parse(rangesParam) : [];
  } catch {
    return res.status(400).send("Malformed ?ranges= (expected JSON array)");
  }

  const sourceUrl = decodeURIComponent(src);
  const audioFilter = buildAudioFilter(ranges);

  const args = [
    "-hide_banner", "-loglevel", "error",
    "-i", sourceUrl,
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c:v", "copy"
  ];

  if (audioFilter) {
    args.push("-af", audioFilter, "-c:a", "aac", "-b:a", "160k");
  } else {
    args.push("-c:a", "copy");
  }

  args.push("-movflags", "frag_keyframe+empty_moov+faststart", "-f", "mp4", "pipe:1");

  res.set("Content-Type", "video/mp4");

  const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
  ff.stdout.pipe(res);
  ff.stderr.on("data", (d) => console.error("ffmpeg:", d.toString()));
  ff.on("error", (err) => {
    console.error("Failed to start ffmpeg:", err);
    if (!res.headersSent) res.status(500).end("ffmpeg failed to start");
  });
  req.on("close", () => {
    if (!ff.killed) ff.kill("SIGKILL");
  });
}

// ============================================================
// SERVER
// ============================================================
const app = express();

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  next();
});

app.get("/manifest.json", (req, res) => res.json(manifest));

app.get("/subtitles/:type/:id.json", async (req, res) => {
  if (!config.UPSTREAM_SUBTITLE_ADDON) return res.json({ subtitles: [] });
  try {
    const { type, id } = req.params;
    const upstreamUrl = `${config.UPSTREAM_SUBTITLE_ADDON}/subtitles/${type}/${id}.json`;
    const upstream = await fetch(upstreamUrl).then((r) => r.json());

    const subtitles = (upstream.subtitles || []).map((s) => ({
      ...s,
      url: `${config.SELF_URL}/subtitles/censor?src=${encodeURIComponent(s.url)}`
    }));

    res.json({ subtitles });
  } catch (err) {
    console.error(err);
    res.json({ subtitles: [] });
  }
});

app.get("/subtitles/censor", censorRoute);

async function getMuteRangesForId(type, id) {
  if (!config.UPSTREAM_SUBTITLE_ADDON) return [];
  try {
    const upstream = await fetch(
      `${config.UPSTREAM_SUBTITLE_ADDON}/subtitles/${type}/${id}.json`
    ).then((r) => r.json());

    const first = (upstream.subtitles || [])[0];
    if (!first) return [];

    const { muteRanges } = await fetchAndCensor(first.url);
    return muteRanges;
  } catch (err) {
    console.error("getMuteRangesForId failed:", err);
    return [];
  }
}

app.get("/stream/:type/:id.json", async (req, res) => {
  if (!config.UPSTREAM_STREAM_ADDON) return res.json({ streams: [] });
  try {
    const { type, id } = req.params;

    const [upstreamStreams, subtitleCues] = await Promise.all([
      fetch(`${config.UPSTREAM_STREAM_ADDON}/stream/${type}/${id}.json`).then((r) => r.json()),
      getMuteRangesForId(type, id)
    ]);

    const streams = (upstreamStreams.streams || []).map((s) => {
      if (!s.url) return s;
      const params = new URLSearchParams({
        src: encodeURIComponent(s.url),
        ranges: JSON.stringify(subtitleCues)
      });
      return {
        ...s,
        title: `${s.title || s.name || "Stream"} [Filtered]`,
        url: `${config.SELF_URL}/mute?${params.toString()}`
      };
    });

    res.json({ streams });
  } catch (err) {
    console.error(err);
    res.json({ streams: [] });
  }
});

app.get("/mute", muteRoute);

app.listen(config.PORT, () => {
  console.log(`Profanity filter addon running on port ${config.PORT}`);
  console.log(`Manifest: ${config.SELF_URL}/manifest.json`);
});
