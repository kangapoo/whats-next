import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-5",
  OMDB_API_KEY,
  RAPIDAPI_KEY,
  MOTN_API_KEY,
  STREAMING_PROVIDER = "rapidapi",
  PORT = 8787,
} = process.env;

const COUNTRY_NAMES = {
  za: "South Africa", us: "United States", gb: "United Kingdom", ca: "Canada",
  au: "Australia", in: "India", ng: "Nigeria", ke: "Kenya", de: "Germany",
  fr: "France", es: "Spain", br: "Brazil", mx: "Mexico", jp: "Japan", kr: "South Korea",
};

// ---------- watch history helpers (history is sent by the client on each request) ----------
const normTitle = (s) => String(s || "").trim().toLowerCase();

function historyPrompt(log) {
  const items = Object.values(log);
  if (!items.length) return "";
  const seen = items.map((w) => w.title);
  const liked = items.filter((w) => w.liked).map((w) => w.title);
  const disliked = items.filter((w) => w.liked === false).map((w) => w.title);
  let s = `I have already watched these — never recommend them again: ${seen.join("; ")}.\n`;
  if (liked.length) s += `I especially liked: ${liked.join("; ")} — favour titles with similar qualities.\n`;
  if (disliked.length) s += `I disliked: ${disliked.join("; ")} — avoid titles with similar qualities.\n`;
  return s;
}

// ---------- helpers ----------
function extractJSON(text) {
  if (!text) return null;
  let t = String(text).replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = t.search(/[[{]/);
  if (start === -1) return null;
  const cand = t.slice(start);
  try { return JSON.parse(cand); } catch {}
  const end = Math.max(cand.lastIndexOf("}"), cand.lastIndexOf("]"));
  if (end > -1) { try { return JSON.parse(cand.slice(0, end + 1)); } catch {} }
  return null;
}

async function pool(items, size, worker) {
  const queue = items.map((it, i) => [it, i]);
  const out = new Array(items.length);
  const runners = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) {
      const [it, i] = queue.shift();
      out[i] = await worker(it, i);
    }
  });
  await Promise.all(runners);
  return out;
}

// ---------- 1. recommendations (Anthropic) ----------
async function recommend(loved, countryName, limit, history) {
  const prompt =
`I love these movies/shows: ${loved.join("; ")}.
${history || ""}Recommend exactly ${limit} titles I'd likely love, available to stream on Netflix in ${countryName}. Mix films and series. Do not repeat any title I listed or have watched. Give each a specific one-sentence reason tied to what I love (max 20 words).
Respond with ONLY a JSON array, no markdown, no other text:
[{"title":"","year":0,"type":"Movie","reason":""}]`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 1024,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const list = extractJSON(text);
  return Array.isArray(list) ? list.slice(0, limit) : [];
}

// ---------- 2. ratings (OMDb) ----------
function pctFromRatings(ratings, source) {
  const r = (ratings || []).find((x) => x.Source === source);
  if (!r) return null;
  const m = String(r.Value).match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

async function omdbLookup(title, year) {
  if (!OMDB_API_KEY) return null;
  const url = new URL("https://www.omdbapi.com/");
  url.searchParams.set("apikey", OMDB_API_KEY);
  url.searchParams.set("t", title);
  if (year) url.searchParams.set("y", String(year));
  try {
    const res = await fetch(url);
    const d = await res.json();
    if (d.Response === "False") return null;
    return {
      imdbID: d.imdbID || null,
      imdb: d.imdbRating && d.imdbRating !== "N/A" ? Number(d.imdbRating) : null,
      rtCritics: pctFromRatings(d.Ratings, "Rotten Tomatoes"),
      metascore: d.Metascore && d.Metascore !== "N/A" ? Number(d.Metascore) : null,
      year: d.Year || year,
      type: d.Type === "series" ? "Series" : "Movie",
      poster: d.Poster && d.Poster !== "N/A" ? d.Poster : null,
      resolvedTitle: d.Title || title,
    };
  } catch { return null; }
}

// ---------- 3. availability (Streaming Availability API) ----------
async function saLookup(imdbID, country) {
  if (!imdbID) return null;
  const rapid = STREAMING_PROVIDER !== "motn";
  const base = rapid
    ? `https://streaming-availability.p.rapidapi.com/shows/${imdbID}`
    : `https://api.movieofthenight.com/v4/shows/${imdbID}`;
  const url = new URL(base);
  url.searchParams.set("country", country);
  const headers = rapid
    ? { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": "streaming-availability.p.rapidapi.com" }
    : { "X-API-Key": MOTN_API_KEY };
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    const show = await res.json();
    const opts = (show.streamingOptions && show.streamingOptions[country]) || [];
    // "included with a subscription" = subscription / free / addon (not rent/buy)
    const included = opts.filter((o) => ["subscription", "free", "addon"].includes(o.type));
    const byService = new Map();
    for (const o of included) {
      const name = o.service?.name || o.service?.id || "Unknown";
      if (!byService.has(name)) byService.set(name, { name, link: o.link || null, id: o.service?.id });
    }
    const services = [...byService.values()];
    const netflix = services.find((s) => /netflix/i.test(s.id || s.name));
    return {
      onNetflix: !!netflix,
      netflixLink: netflix?.link || null,
      services, // [{name, link, id}]
    };
  } catch { return null; }
}

// ---------- discover endpoint ----------
app.post("/api/discover", async (req, res) => {
  try {
    const loved = Array.isArray(req.body?.loved) ? req.body.loved.filter(Boolean) : [];
    const country = String(req.body?.country || "za").toLowerCase();
    const limit = Math.min(Math.max(Number(req.body?.limit) || 8, 1), 12);
    const exclude = Array.isArray(req.body?.exclude) ? req.body.exclude.filter(Boolean) : [];
    if (loved.length < 1) return res.status(400).json({ error: "Add at least one title you loved." });
    if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: "Server missing ANTHROPIC_API_KEY." });

    const countryName = COUNTRY_NAMES[country] || country.toUpperCase();
    const log = (req.body && typeof req.body.watched === "object" && req.body.watched) || {};
    let guidance = historyPrompt(log);
    if (exclude.length) guidance += `Already suggested this session — do NOT repeat these: ${exclude.join("; ")}.\n`;
    const recs = await recommend(loved, countryName, limit, guidance);
    if (recs.length === 0) return res.status(502).json({ error: "The recommender returned nothing. Try again." });

    const skip = new Set([...Object.keys(log), ...exclude.map(normTitle)]);
    const fresh = recs.filter((r) => !skip.has(normTitle(r.title))); // never repeat watched or already-shown
    const results = await pool(fresh, 4, async (r) => {
      const omdb = await omdbLookup(r.title, r.year);
      const sa = omdb?.imdbID ? await saLookup(omdb.imdbID, country) : null;
      return {
        title: omdb?.resolvedTitle || r.title,
        year: omdb?.year || r.year || "",
        type: omdb?.type || (r.type === "Series" ? "Series" : "Movie"),
        reason: r.reason || "",
        poster: omdb?.poster || null,
        imdb: omdb?.imdb ?? null,
        rtCritics: omdb?.rtCritics ?? null,
        metascore: omdb?.metascore ?? null,
        onNetflix: sa ? sa.onNetflix : null,
        netflixLink: sa?.netflixLink || null,
        services: sa?.services || [],
        country,
      };
    });

    res.json({
      country,
      countryName,
      results,
      // Required attribution per the Streaming Availability API terms of service.
      attribution: "Streaming availability by Movie of the Night — https://www.movieofthenight.com/about/api",
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Something broke while building recommendations. Check server logs." });
  }
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    keys: {
      anthropic: !!ANTHROPIC_API_KEY,
      omdb: !!OMDB_API_KEY,
      streaming: STREAMING_PROVIDER === "motn" ? !!MOTN_API_KEY : !!RAPIDAPI_KEY,
    },
  });
});

app.listen(PORT, () => console.log(`What Next server → http://localhost:${PORT}`));
