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

const {
  ANTHROPIC_API_KEY,
  ANTHROPIC_MODEL = "claude-sonnet-5",
  OMDB_API_KEY,
  RAPIDAPI_KEY,
  MOTN_API_KEY,
  STREAMING_PROVIDER = "rapidapi",
  FILL_RATINGS_WEB = "true",
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
  // Salvage a truncated array: keep everything up to the last COMPLETE object and close the bracket.
  if (cand[0] === "[") {
    const lastObj = cand.lastIndexOf("}");
    if (lastObj > -1) { try { return JSON.parse(cand.slice(0, lastObj + 1) + "]"); } catch {} }
  }
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
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    // Surface the real reason (bad key, no credit, wrong model, rate limit, ...) in plain-ish text.
    let detail = "";
    try {
      const err = await res.json();
      detail = err?.error?.message || JSON.stringify(err);
    } catch { detail = await res.text().catch(() => ""); }
    throw new Error(`The AI service refused the request (error ${res.status}). ${detail}`.slice(0, 300));
  }

  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  let parsed = extractJSON(text);
  // Accept a bare array, or an object that contains an array (some models wrap it).
  let list = Array.isArray(parsed) ? parsed
    : (parsed && typeof parsed === "object"
        ? Object.values(parsed).find((v) => Array.isArray(v)) || null
        : null);
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`The AI replied but not with a usable list. It said: "${(text || "").trim().slice(0, 160)}"`);
  }
  return list.slice(0, limit);
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

// ---------- 3b. web fallback: fill RT / Metacritic when OMDb has no score ----------
async function webFillRatings(title, year, type) {
  if (FILL_RATINGS_WEB === "false" || !ANTHROPIC_API_KEY) return {};
  const prompt =
`Use web search to find current critic ratings for the ${String(type || "").toLowerCase()} "${title}"${year ? ` (${year})` : ""}.
Return ONLY JSON, no other text:
{"rtCritics":92,"metascore":78}
- rtCritics: Rotten Tomatoes critics (Tomatometer) score 0-100 as a number, or null
- metascore: Metacritic metascore 0-100 as a number, or null
Only report values you can verify from search results. Use null otherwise.`;
  try {
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
        tools: [{ type: "web_search_20250305", name: "web_search" }],
      }),
    });
    if (!res.ok) return {};
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    const j = extractJSON(text);
    if (!j || typeof j !== "object") return {};
    return {
      rtCritics: typeof j.rtCritics === "number" ? j.rtCritics : null,
      metascore: typeof j.metascore === "number" ? j.metascore : null,
    };
  } catch { return {}; }
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
    const wantType = String(req.body?.type || "").toLowerCase();   // "movie" | "series" | ""
    const wantGenre = String(req.body?.genre || "").trim();         // e.g. "Comedy" | "" | "Any"
    const log = (req.body && typeof req.body.watched === "object" && req.body.watched) || {};
    let guidance = historyPrompt(log);
    if (wantType === "movie") guidance += "Only recommend films (movies), never series.\n";
    else if (wantType === "series") guidance += "Only recommend series (TV shows), never films.\n";
    if (wantGenre && wantGenre.toLowerCase() !== "any") guidance += `Only recommend titles in the ${wantGenre} genre.\n`;
    if (exclude.length) guidance += `Already suggested this session — do NOT repeat these: ${exclude.join("; ")}.\n`;
    const recs = await recommend(loved, countryName, limit, guidance);

    const skip = new Set([...Object.keys(log), ...exclude.map(normTitle)]);
    const fresh = recs.filter((r) => !skip.has(normTitle(r.title))); // never repeat watched or already-shown
    const results = await pool(fresh, 4, async (r) => {
      const omdb = await omdbLookup(r.title, r.year);
      const sa = omdb?.imdbID ? await saLookup(omdb.imdbID, country) : null;
      const title = omdb?.resolvedTitle || r.title;
      const year = omdb?.year || r.year || "";
      const type = omdb?.type || (r.type === "Series" ? "Series" : "Movie");
      let rtCritics = omdb?.rtCritics ?? null;
      let metascore = omdb?.metascore ?? null;
      // Fall back to a web lookup when the ratings service has no RT/Metacritic score.
      if (rtCritics == null || metascore == null) {
        const web = await webFillRatings(title, year, type);
        if (rtCritics == null && web.rtCritics != null) rtCritics = web.rtCritics;
        if (metascore == null && web.metascore != null) metascore = web.metascore;
      }
      return {
        title,
        year,
        type,
        reason: r.reason || "",
        poster: omdb?.poster || null,
        imdb: omdb?.imdb ?? null,
        rtCritics,
        metascore,
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
    res.status(502).json({ error: e.message || "Something broke while building recommendations." });
  }
});

app.get("/api/diag", async (_req, res) => {
  const out = {
    anthropic: { keySaved: !!ANTHROPIC_API_KEY },
    streaming: { keySaved: STREAMING_PROVIDER === "motn" ? !!MOTN_API_KEY : !!RAPIDAPI_KEY },
    omdb: {},
  };
  try {
    if (!OMDB_API_KEY) {
      out.omdb = { working: false, note: "No OMDb key is saved on the server." };
    } else {
      const u = new URL("https://www.omdbapi.com/");
      u.searchParams.set("apikey", OMDB_API_KEY);
      u.searchParams.set("t", "The Matrix");
      u.searchParams.set("y", "1999");
      const r = await fetch(u);
      const d = await r.json();
      if (d.Response === "False") {
        out.omdb = { working: false, omdbSays: d.Error || "unknown error" };
      } else {
        out.omdb = {
          working: true,
          testedWith: "The Matrix (1999)",
          imdb: d.imdbRating || null,
          rottenTomatoes: (d.Ratings || []).find((x) => x.Source === "Rotten Tomatoes")?.Value || "not listed for this film",
          metacritic: d.Metascore || null,
        };
      }
    }
  } catch (e) {
    out.omdb = { working: false, error: String(e.message) };
  }
  res.json(out);
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

const PAGE = Buffer.from("PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPgo8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEiIC8+Cjx0aXRsZT5XaGF0IE5leHQgwrcgTmV0ZmxpeCB0YXN0ZS1tYXRjaGVyPC90aXRsZT4KPHN0eWxlPgogIDpyb290ewogICAgLS1iZzojMEUxMTE2OyAtLWJnMjojMTIxNjFDOyAtLWNhcmQ6IzE3MUMyNDsgLS1jYXJkSGk6IzFDMjIyQjsKICAgIC0tbGluZTojMjcyRTM5OyAtLWdvbGQ6I0U4QjQ0QTsgLS10ZXh0OiNGMkVERTM7IC0tbXV0OiM4QjkzQTA7IC0tbXV0MjojNUM2NDcwOwogICAgLS1nb29kOiM0RkI0Nzc7IC0tbWlkOiNFOEI0NEE7IC0tYmFkOiNFMDU3NEI7IC0tbmV0OiM0RkI0Nzc7CiAgfQogICp7Ym94LXNpemluZzpib3JkZXItYm94fQogIGJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7CiAgICBmb250LWZhbWlseTotYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwnU2Vnb2UgVUknLFJvYm90byxzYW5zLXNlcmlmO30KICAud3JhcHttYXgtd2lkdGg6OTQwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjQwcHggMjJweCA3MnB4fQogIC5leWVicm93e2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4yMmVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1nb2xkKTttYXJnaW4tYm90dG9tOjEwcHh9CiAgaDF7Zm9udC1mYW1pbHk6dWktc2VyaWYsR2VvcmdpYSxzZXJpZjtmb250LXNpemU6NDZweDtsaW5lLWhlaWdodDoxLjAyO21hcmdpbjowO2ZvbnQtd2VpZ2h0OjYwMDtsZXR0ZXItc3BhY2luZzotLjAxZW19CiAgLnN1Yntjb2xvcjp2YXIoLS1tdXQpO2ZvbnQtc2l6ZToxNXB4O21hcmdpbi10b3A6MTJweDttYXgtd2lkdGg6NTIwcHg7bGluZS1oZWlnaHQ6MS41fQogIC5wYW5lbHtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE4cHg7cGFkZGluZzoyNHB4fQogIC5yb3d7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDo4cHh9CiAgLmNoaXB7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtiYWNrZ3JvdW5kOnZhcigtLWNhcmRIaSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsKICAgIGJvcmRlci1yYWRpdXM6OTk5cHg7cGFkZGluZzo3cHggOHB4IDdweCAxNHB4O2ZvbnQtc2l6ZToxMy41cHh9CiAgLmNoaXAgYnV0dG9ue2N1cnNvcjpwb2ludGVyO2JvcmRlcjpub25lO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6dmFyKC0tbXV0KTtmb250LXNpemU6MTVweDtsaW5lLWhlaWdodDoxO3BhZGRpbmc6MCAycHh9CiAgaW5wdXQudGl0bGV7ZmxleDoxIDAgMTYwcHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS10ZXh0KTtmb250LXNpemU6MTRweDtwYWRkaW5nOjhweCA0cHg7bWluLXdpZHRoOjE0MHB4O291dGxpbmU6bm9uZX0KICBpbnB1dC50aXRsZTo6cGxhY2Vob2xkZXJ7Y29sb3I6dmFyKC0tbXV0Mil9CiAgc2VsZWN0e2JhY2tncm91bmQ6dmFyKC0tY2FyZEhpKTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjEwcHggMTRweDtmb250LXNpemU6MTRweDtjdXJzb3I6cG9pbnRlcn0KICAuY3Rhe2JhY2tncm91bmQ6dmFyKC0tZ29sZCk7Y29sb3I6IzIwMTgwYTtib3JkZXI6bm9uZTtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzoxM3B4IDI2cHg7Zm9udC1zaXplOjE0LjVweDtmb250LXdlaWdodDo3MDA7Y3Vyc29yOnBvaW50ZXJ9CiAgLmN0YVtkaXNhYmxlZF17YmFja2dyb3VuZDp2YXIoLS1jYXJkSGkpO2NvbG9yOnZhcigtLW11dDIpO2N1cnNvcjpub3QtYWxsb3dlZH0KICAuaHJ7aGVpZ2h0OjFweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpfQogIC5ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMzAwcHgsMWZyKSk7Z2FwOjE2cHh9CiAgLnJje2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjEycHh9CiAgLnJjLnNlZW57Ym9yZGVyLWNvbG9yOnJnYmEoMjMyLDE4MCw3NCwuMjgpfQogIC5raWNrZXJ7Zm9udC1zaXplOjEwcHg7bGV0dGVyLXNwYWNpbmc6LjEyZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLWdvbGQpfQogIC5ydC10aXRsZXtmb250LWZhbWlseTp1aS1zZXJpZixHZW9yZ2lhLHNlcmlmO2ZvbnQtc2l6ZToyMnB4O2xpbmUtaGVpZ2h0OjEuMTU7Zm9udC13ZWlnaHQ6NjAwfQogIC5yZWFzb257Zm9udC1zaXplOjEzLjVweDtsaW5lLWhlaWdodDoxLjU7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tdG9wOjZweH0KICAuc2NvcmVze2Rpc3BsYXk6ZmxleDtnYXA6MTZweH0KICAuc2N7ZmxleDoxO21pbi13aWR0aDowfQogIC5zYyAubGFie2ZvbnQtc2l6ZToxMHB4O2xldHRlci1zcGFjaW5nOi4wOGVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tYm90dG9tOjRweH0KICAuc2MgLnZhbHtmb250LWZhbWlseTp1aS1tb25vc3BhY2UsTWVubG8sbW9ub3NwYWNlO2ZvbnQtc2l6ZToyMHB4O2ZvbnQtd2VpZ2h0OjYwMDtsaW5lLWhlaWdodDoxfQogIC5tZXRlcntoZWlnaHQ6M3B4O2JvcmRlci1yYWRpdXM6MnB4O2JhY2tncm91bmQ6dmFyKC0tbGluZSk7bWFyZ2luLXRvcDo4cHg7b3ZlcmZsb3c6aGlkZGVufQogIC5tZXRlcj5pe2Rpc3BsYXk6YmxvY2s7aGVpZ2h0OjEwMCU7Ym9yZGVyLXJhZGl1czoycHh9CiAgLmxhYjJ7Zm9udC1zaXplOjEwcHg7bGV0dGVyLXNwYWNpbmc6LjA4ZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi1ib3R0b206OHB4fQogIC5zdmN7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjVweDtmb250LXNpemU6MTEuNXB4O2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NHB4IDlweDt0ZXh0LWRlY29yYXRpb246bm9uZX0KICAuc3ZjLm5ldHtjb2xvcjojYmZlOGNmO2JhY2tncm91bmQ6cmdiYSg3OSwxODAsMTE5LC4xNCk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDc5LDE4MCwxMTksLjM1KX0KICAuc3ZjLnBsYWlue2NvbG9yOnZhcigtLW11dCk7YmFja2dyb3VuZDpyZ2JhKDEzOSwxNDcsMTYwLC4wOCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0KICAuc3ZjLnBsYWluOmhvdmVye2NvbG9yOnZhcigtLXRleHQpfQogIC5zZWVucm93e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweH0KICAucmF0ZXtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjZweCAxMnB4O2ZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NjAwO2N1cnNvcjpwb2ludGVyfQogIC5yYXRlLnVwe2JhY2tncm91bmQ6cmdiYSg3OSwxODAsMTE5LC4xMCk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDc5LDE4MCwxMTksLjMpO2NvbG9yOiNiZmU4Y2Z9CiAgLnJhdGUuZG93bntiYWNrZ3JvdW5kOnJnYmEoMjI0LDg3LDc1LC4wOCk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIyNCw4Nyw3NSwuMjgpO2NvbG9yOiNlZmIzYWR9CiAgLndhdGNoZWR0YWd7Zm9udC1zaXplOjEyLjVweDtmb250LXdlaWdodDo2MDB9CiAgLnVuZG97YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTJweDtjdXJzb3I6cG9pbnRlcjt0ZXh0LWRlY29yYXRpb246dW5kZXJsaW5lO3BhZGRpbmc6MnB4fQogIC50b29sYmFye2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6MThweDthbGlnbi1pdGVtczpmbGV4LWVuZDtwYWRkaW5nOjE0cHggMTZweDtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7bWFyZ2luLWJvdHRvbToyMHB4fQogIC5zZWd7ZGlzcGxheTppbmxpbmUtZmxleDtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjlweDtwYWRkaW5nOjNweDtnYXA6MnB4fQogIC5zZWcgYnV0dG9ue2JvcmRlcjpub25lO2N1cnNvcjpwb2ludGVyO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NnB4IDEycHg7Zm9udC1zaXplOjEyLjVweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOnZhcigtLW11dCl9CiAgLnNlZyBidXR0b24ub257YmFja2dyb3VuZDp2YXIoLS1nb2xkKTtjb2xvcjojMjAxODBhO2ZvbnQtd2VpZ2h0OjcwMH0KICAuZ2hvc3R7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2NvbG9yOnZhcigtLXRleHQpO2JvcmRlci1yYWRpdXM6OTk5cHg7cGFkZGluZzo4cHggMTZweDtmb250LXNpemU6MTNweDtjdXJzb3I6cG9pbnRlcjtkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4fQogIC5kb3R7d2lkdGg6NnB4O2hlaWdodDo2cHg7Ym9yZGVyLXJhZGl1czo5OTlweDtiYWNrZ3JvdW5kOnZhcigtLW11dDIpfQogIC5sb2dwYW5lbHtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxNnB4O21hcmdpbi1ib3R0b206MjBweH0KICAubG9naXRlbXtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMHB4O2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzo5cHggMTJweH0KICAubm90ZXtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjY7bWFyZ2luLXRvcDoyNnB4O21heC13aWR0aDo2NDBweH0KICBhLmxpbmt7Y29sb3I6dmFyKC0tZ29sZCk7dGV4dC1kZWNvcmF0aW9uOm5vbmU7Zm9udC1zaXplOjEyLjVweH0KICBidXR0b246Zm9jdXMtdmlzaWJsZSxpbnB1dDpmb2N1cy12aXNpYmxlLHNlbGVjdDpmb2N1cy12aXNpYmxlLC5zZWcgYnV0dG9uOmZvY3VzLXZpc2libGV7b3V0bGluZToycHggc29saWQgdmFyKC0tZ29sZCk7b3V0bGluZS1vZmZzZXQ6MnB4fQogIEBrZXlmcmFtZXMgcHswJSwxMDAle29wYWNpdHk6LjQ1fTUwJXtvcGFjaXR5Oi44fX0gLmxvYWR7YW5pbWF0aW9uOnAgMS40cyBlYXNlLWluLW91dCBpbmZpbml0ZX0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0id3JhcCI+CiAgPGRpdiBpZD0ic3RhdHVzIiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbjowIDAgMThweDtwYWRkaW5nOjEwcHggMTRweDtib3JkZXItcmFkaXVzOjEwcHg7Zm9udC1zaXplOjEzLjVweCI+PC9kaXY+CiAgPGRpdiBjbGFzcz0iZXllYnJvdyI+TmV0ZmxpeCB0YXN0ZS1tYXRjaGVyPC9kaXY+CiAgPGgxPldoYXQgbmV4dC48L2gxPgogIDxwIGNsYXNzPSJzdWIiPk5hbWUgYSBoYW5kZnVsIG9mIHRoaW5ncyB5b3Ugd2F0Y2hlZCBhbmQgbG92ZWQuIFJlYWwgSU1EYiAmYW1wOyBSb3R0ZW4gVG9tYXRvZXMgc2NvcmVzLCByZWFsIHJlZ2lvbmFsIGF2YWlsYWJpbGl0eSwgZGVlcCBsaW5rcyB0byB3aGVyZSBpdCBzdHJlYW1zIOKAlCBhbmQgaXQgbGVhcm5zIGZyb20gd2hhdCB5b3UgcmF0ZS48L3A+CgogIDxkaXYgaWQ9ImlucHV0IiBzdHlsZT0ibWFyZ2luLXRvcDozMHB4IiBjbGFzcz0icGFuZWwiPgogICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmJhc2VsaW5lO21hcmdpbi1ib3R0b206MTJweCI+CiAgICAgIDxsYWJlbCBzdHlsZT0iZm9udC1zaXplOjEzcHg7Zm9udC13ZWlnaHQ6NjAwIj5UaGluZ3MgeW91IGxvdmVkPC9sYWJlbD4KICAgICAgPHNwYW4gaWQ9ImNvdW50IiBzdHlsZT0iZm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLG1vbm9zcGFjZTtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQyKSI+MCAvIDEwPC9zcGFuPgogICAgPC9kaXY+CiAgICA8ZGl2IGlkPSJjaGlwcyIgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi1ib3R0b206MTRweCI+CiAgICAgIDxpbnB1dCBjbGFzcz0idGl0bGUiIGlkPSJkcmFmdCIgcGxhY2Vob2xkZXI9IlR5cGUgYSB0aXRsZSwgcHJlc3MgRW50ZXIiIC8+CiAgICA8L2Rpdj4KICAgIDxidXR0b24gaWQ9ImV4YW1wbGUiIHN0eWxlPSJiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tZ29sZCk7Zm9udC1zaXplOjEyLjVweDtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjAgMCA4cHgiPk5lZWQgYSBzcGFyaz8gTG9hZCBhbiBleGFtcGxlIOKGkjwvYnV0dG9uPgogICAgPGRpdiBjbGFzcz0iaHIiIHN0eWxlPSJtYXJnaW46NnB4IDAgMThweCI+PC9kaXY+CiAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjE2cHg7YWxpZ24taXRlbXM6ZmxleC1lbmQ7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW4iPgogICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjE2cHgiPgogICAgICAgIDxkaXY+CiAgICAgICAgICA8bGFiZWwgZm9yPSJyZWdpb24iIHN0eWxlPSJkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCk7bWFyZ2luLWJvdHRvbTo3cHgiPldhdGNoaW5nIGZyb208L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBpZD0icmVnaW9uIj48L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGZvcj0idHlwZSIgc3R5bGU9ImRpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tYm90dG9tOjdweCI+U2hvdyBtZTwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJ0eXBlIj48L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGZvcj0iZ2VucmUiIHN0eWxlPSJkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCk7bWFyZ2luLWJvdHRvbTo3cHgiPkdlbnJlPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImdlbnJlIj48L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gaWQ9ImdvIiBjbGFzcz0iY3RhIiBkaXNhYmxlZD5GaW5kIG15IG5leHQgd2F0Y2g8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0iaGludCIgc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi10b3A6MTJweCI+QWRkIGF0IGxlYXN0IDMgdGl0bGVzIGZvciBhIGdvb2QgcmVhZCBvbiB5b3VyIHRhc3RlLjwvZGl2PgogICAgPGRpdiBpZD0iaW5wdXRsb2ciPjwvZGl2PgogIDwvZGl2PgoKICA8ZGl2IGlkPSJyZXN1bHRzIiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6MzBweCI+PC9kaXY+CjwvZGl2PgoKPHNjcmlwdD4Kd2luZG93Lm9uZXJyb3I9ZnVuY3Rpb24obSl7dmFyIHM9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInN0YXR1cyIpO2lmKHMpe3Muc3R5bGUuZGlzcGxheT0iYmxvY2siO3Muc3R5bGUuYmFja2dyb3VuZD0iIzViMWExYSI7cy5zdHlsZS5ib3JkZXI9IjFweCBzb2xpZCAjYTMzIjtzLnN0eWxlLmNvbG9yPSIjZmZkOWQ0IjtzLnRleHRDb250ZW50PSJQcm9ibGVtIHN0YXJ0aW5nIHRoZSBhcHA6ICIrbTt9cmV0dXJuIGZhbHNlO307Cgpjb25zdCBSRUdJT05TPVtbInphIiwiU291dGggQWZyaWNhIl0sWyJ1cyIsIlVuaXRlZCBTdGF0ZXMiXSxbImdiIiwiVW5pdGVkIEtpbmdkb20iXSxbImNhIiwiQ2FuYWRhIl0sWyJhdSIsIkF1c3RyYWxpYSJdLFsiaW4iLCJJbmRpYSJdLFsibmciLCJOaWdlcmlhIl0sWyJrZSIsIktlbnlhIl0sWyJkZSIsIkdlcm1hbnkiXSxbImZyIiwiRnJhbmNlIl0sWyJlcyIsIlNwYWluIl0sWyJiciIsIkJyYXppbCJdLFsibXgiLCJNZXhpY28iXSxbImpwIiwiSmFwYW4iXSxbImtyIiwiU291dGggS29yZWEiXV07CmNvbnN0IEVYQU1QTEU9WyJEYXJrIiwiVGhlIEJlYXIiLCJCcmVha2luZyBCYWQiLCJQYXJhc2l0ZSIsIkZsZWFiYWciXTsKbGV0IHNob3dzPVtdLCBkYXRhPW51bGwsIHdhdGNoZWRNYXA9e30sIHNob3dMb2c9ZmFsc2U7CmxldCBsb2FkaW5nTW9yZT1mYWxzZSwgZXhoYXVzdGVkPWZhbHNlLCBpbz1udWxsOwpsZXQgZmlsdGVycz17dHlwZToiYWxsIixtaW46MCxuZXQ6ZmFsc2Usc29ydDoibWF0Y2gifTsKCmNvbnN0ICQ9cz0+ZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzKTsKY29uc3QgbnJtPXM9PlN0cmluZyhzfHwiIikudHJpbSgpLnRvTG93ZXJDYXNlKCk7CmNvbnN0IGVzYz1zPT5TdHJpbmcocykucmVwbGFjZSgvWyY8PiJdL2csYz0+KHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsifVtjXSkpOwpjb25zdCB3YXRjaGVkQ291bnQ9KCk9Pk9iamVjdC5rZXlzKHdhdGNoZWRNYXApLmxlbmd0aDsKCmNvbnN0IHJlZ2lvblNlbD0kKCIjcmVnaW9uIik7ClJFR0lPTlMuZm9yRWFjaCgoW2Msbl0pPT57Y29uc3Qgbz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJvcHRpb24iKTtvLnZhbHVlPWM7by50ZXh0Q29udGVudD1uO3JlZ2lvblNlbC5hcHBlbmRDaGlsZChvKTt9KTsKY29uc3QgVFlQRVM9W1siIiwiTW92aWVzICYgc2VyaWVzIl0sWyJtb3ZpZSIsIk1vdmllcyBvbmx5Il0sWyJzZXJpZXMiLCJTZXJpZXMgb25seSJdXTsKY29uc3QgR0VOUkVTPVsiQW55IiwiQWN0aW9uIiwiQWR2ZW50dXJlIiwiQW5pbWF0aW9uIiwiQ29tZWR5IiwiQ3JpbWUiLCJEb2N1bWVudGFyeSIsIkRyYW1hIiwiRmFudGFzeSIsIkhvcnJvciIsIk15c3RlcnkiLCJSb21hbmNlIiwiU2NpLUZpIiwiVGhyaWxsZXIiXTsKY29uc3QgdHlwZVNlbD0kKCIjdHlwZSIpOyBUWVBFUy5mb3JFYWNoKChbdixuXSk9Pntjb25zdCBvPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoIm9wdGlvbiIpO28udmFsdWU9djtvLnRleHRDb250ZW50PW47dHlwZVNlbC5hcHBlbmRDaGlsZChvKTt9KTsKY29uc3QgZ2VucmVTZWw9JCgiI2dlbnJlIik7IEdFTlJFUy5mb3JFYWNoKGc9Pntjb25zdCBvPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoIm9wdGlvbiIpO28udmFsdWU9ZztvLnRleHRDb250ZW50PShnPT09IkFueSI/IkFueSBnZW5yZSI6Zyk7Z2VucmVTZWwuYXBwZW5kQ2hpbGQobyk7fSk7CgpmdW5jdGlvbiBzY29yZUNvbG9yKHApe2lmKHA9PW51bGx8fGlzTmFOKHApKXJldHVybiJ2YXIoLS1tdXQyKSI7aWYocD49NzUpcmV0dXJuInZhcigtLWdvb2QpIjtpZihwPj01MClyZXR1cm4idmFyKC0tbWlkKSI7cmV0dXJuInZhcigtLWJhZCkiO30KCi8vIC0tLS0gd2F0Y2ggaGlzdG9yeSAoc2F2ZWQgaW4gdGhpcyBicm93c2VyIHZpYSBsb2NhbFN0b3JhZ2UpIC0tLS0KY29uc3QgTFNfS0VZPSJ3bl93YXRjaGxvZyI7CmZ1bmN0aW9uIHBlcnNpc3RXYXRjaGVkKCl7dHJ5e2xvY2FsU3RvcmFnZS5zZXRJdGVtKExTX0tFWSxKU09OLnN0cmluZ2lmeSh3YXRjaGVkTWFwKSk7fWNhdGNoKGUpe319CmZ1bmN0aW9uIGxvYWRXYXRjaGVkKCl7CiAgdHJ5e2NvbnN0IHJhdz1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShMU19LRVkpO3dhdGNoZWRNYXA9cmF3PyhKU09OLnBhcnNlKHJhdyl8fHt9KTp7fTt9Y2F0Y2goZSl7d2F0Y2hlZE1hcD17fTt9CiAgcmVuZGVySW5wdXRMb2coKTsKfQpmdW5jdGlvbiBtYXJrV2F0Y2hlZChyZWMsbGlrZWQpewogIHdhdGNoZWRNYXBbbnJtKHJlYy50aXRsZSldPXt0aXRsZTpyZWMudGl0bGUseWVhcjpyZWMueWVhcix0eXBlOnJlYy50eXBlLGxpa2VkLHRzOkRhdGUubm93KCl9OwogIHBlcnNpc3RXYXRjaGVkKCk7IGlmKGRhdGEpcmVuZGVyKCk7IHJlbmRlcklucHV0TG9nKCk7Cn0KZnVuY3Rpb24gcmVtb3ZlV2F0Y2hlZChpZCl7CiAgZGVsZXRlIHdhdGNoZWRNYXBbaWRdOyBwZXJzaXN0V2F0Y2hlZCgpOyBpZihkYXRhKXJlbmRlcigpOyByZW5kZXJJbnB1dExvZygpOwp9CgpmdW5jdGlvbiBsb2dMaXN0SFRNTCgpewogIGNvbnN0IGl0ZW1zPU9iamVjdC5lbnRyaWVzKHdhdGNoZWRNYXApLnNvcnQoKGEsYik9PihiWzFdLnRzfHwwKS0oYVsxXS50c3x8MCkpOwogIGlmKCFpdGVtcy5sZW5ndGgpcmV0dXJuICc8ZGl2IHN0eWxlPSJmb250LXNpemU6MTNweDtjb2xvcjp2YXIoLS1tdXQyKTtwYWRkaW5nOjhweCAycHgiPk5vdGhpbmcgbG9nZ2VkIHlldC4gUmF0ZSBhIHN1Z2dlc3Rpb24gYW5kIGl0XCdsbCBzaGFwZSB3aGF0IGNvbWVzIG5leHQuPC9kaXY+JzsKICByZXR1cm4gaXRlbXMubWFwKChbaWQsd10pPT4nPGRpdiBjbGFzcz0ibG9naXRlbSI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6Jysody5saWtlZD8ndmFyKC0tZ29vZCknOncubGlrZWQ9PT1mYWxzZT8ndmFyKC0tYmFkKSc6J3ZhcigtLW11dDIpJykrJyI+PC9zcGFuPicKICAgICsnPHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMy41cHgiPicrZXNjKHcudGl0bGUpKyc8L3NwYW4+JwogICAgKyc8c3BhbiBzdHlsZT0iZm9udC1zaXplOjExLjVweDtjb2xvcjp2YXIoLS1tdXQyKSI+Jysody5saWtlZD8nTG92ZWQgaXQnOncubGlrZWQ9PT1mYWxzZT8nTm90IGZvciBtZSc6J1NlZW4nKSsnPC9zcGFuPicKICAgICsnPGJ1dHRvbiBjbGFzcz0iY2hpcCIgZGF0YS1hY3Q9InVud2F0Y2giIGRhdGEtaWQ9IicrZXNjKGlkKSsnIiBzdHlsZT0ibWFyZ2luLWxlZnQ6YXV0bztiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjpub25lO2NvbG9yOnZhcigtLW11dDIpO2ZvbnQtc2l6ZToxNXB4O3BhZGRpbmc6MCA0cHg7Y3Vyc29yOnBvaW50ZXIiPiZ0aW1lczs8L2J1dHRvbj48L2Rpdj4nKS5qb2luKCIiKTsKfQpmdW5jdGlvbiBsb2dCdXR0b25IVE1MKCl7CiAgY29uc3QgYz13YXRjaGVkQ291bnQoKTsKICByZXR1cm4gJzxidXR0b24gY2xhc3M9Imdob3N0IiBpZD0ibG9nYnRuIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDonKyhjPyd2YXIoLS1nb2xkKSc6J3ZhcigtLW11dDIpJykrJyI+PC9zcGFuPldhdGNoZWQgJysoYz8nKCcrYysnKSc6JycpKycgJysoc2hvd0xvZz8n4pa0Jzon4pa+JykrJzwvYnV0dG9uPic7Cn0KZnVuY3Rpb24gd2lyZUxvZ0NvbnRyb2xzKHNjb3BlKXsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9InVud2F0Y2giXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5yZW1vdmVXYXRjaGVkKGIuZGF0YXNldC5pZCkpOwogIGNvbnN0IGxiPXNjb3BlLnF1ZXJ5U2VsZWN0b3IoIiNsb2didG4iKTsgaWYobGIpbGIub25jbGljaz0oKT0+e3Nob3dMb2c9IXNob3dMb2c7IGlmKGRhdGEpcmVuZGVyKCk7IHJlbmRlcklucHV0TG9nKCk7fTsKfQpmdW5jdGlvbiByZW5kZXJJbnB1dExvZygpewogIGNvbnN0IGJveD0kKCIjaW5wdXRsb2ciKTsKICBpZih3YXRjaGVkQ291bnQoKT09PTApe2JveC5pbm5lckhUTUw9IiI7cmV0dXJuO30KICBib3guaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJociIgc3R5bGU9Im1hcmdpbjoyMHB4IDAgMTZweCI+PC9kaXY+Jytsb2dCdXR0b25IVE1MKCkKICAgICsoc2hvd0xvZz8nPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4nK2xvZ0xpc3RIVE1MKCkrJzwvZGl2Pic6JycpOwogIHdpcmVMb2dDb250cm9scyhib3gpOwp9CgovLyAtLS0tIGlucHV0IC0tLS0KZnVuY3Rpb24gcmVuZGVyQ2hpcHMoKXsKICBjb25zdCBib3g9JCgiI2NoaXBzIik7CiAgYm94LnF1ZXJ5U2VsZWN0b3JBbGwoIi5jaGlwIikuZm9yRWFjaChlPT5lLnJlbW92ZSgpKTsKICBjb25zdCBkcmFmdD0kKCIjZHJhZnQiKTsKICBzaG93cy5mb3JFYWNoKChzLGkpPT57CiAgICBjb25zdCBlbD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJzcGFuIik7ZWwuY2xhc3NOYW1lPSJjaGlwIjsKICAgIGVsLmlubmVySFRNTD1lc2MocykrJyA8YnV0dG9uIGFyaWEtbGFiZWw9IlJlbW92ZSI+JnRpbWVzOzwvYnV0dG9uPic7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCJidXR0b24iKS5vbmNsaWNrPSgpPT57c2hvd3Muc3BsaWNlKGksMSk7cmVuZGVyQ2hpcHMoKTt9OwogICAgYm94Lmluc2VydEJlZm9yZShlbCxkcmFmdCk7CiAgfSk7CiAgZHJhZnQuc3R5bGUuZGlzcGxheT1zaG93cy5sZW5ndGg+PTEwPyJub25lIjoiYmxvY2siOwogIGRyYWZ0LnBsYWNlaG9sZGVyPXNob3dzLmxlbmd0aD8iQWRkIGFub3RoZXLigKYiOiJUeXBlIGEgdGl0bGUsIHByZXNzIEVudGVyIjsKICAkKCIjY291bnQiKS50ZXh0Q29udGVudD1zaG93cy5sZW5ndGgrIiAvIDEwIjsKICAkKCIjY291bnQiKS5zdHlsZS5jb2xvcj1zaG93cy5sZW5ndGg+PTM/InZhcigtLWdvbGQpIjoidmFyKC0tbXV0MikiOwogIGNvbnN0IG9rPXNob3dzLmxlbmd0aD49MzsKICAkKCIjZ28iKS5kaXNhYmxlZD0hb2s7CiAgJCgiI2hpbnQiKS5zdHlsZS5kaXNwbGF5PW9rPyJub25lIjoiYmxvY2siOwogICQoIiNleGFtcGxlIikuc3R5bGUuZGlzcGxheT1zaG93cy5sZW5ndGg/Im5vbmUiOiJibG9jayI7Cn0KZnVuY3Rpb24gYWRkRHJhZnQoKXtjb25zdCBkPSQoIiNkcmFmdCIpO2xldCB2PWQudmFsdWUudHJpbSgpLnJlcGxhY2UoLywkLywiIikudHJpbSgpOwogIGlmKCF2KXJldHVybjtpZihzaG93cy5zb21lKHM9PnMudG9Mb3dlckNhc2UoKT09PXYudG9Mb3dlckNhc2UoKSkpe2QudmFsdWU9IiI7cmV0dXJuO30KICBpZihzaG93cy5sZW5ndGg8MTApc2hvd3MucHVzaCh2KTtkLnZhbHVlPSIiO3JlbmRlckNoaXBzKCk7fQokKCIjZHJhZnQiKS5hZGRFdmVudExpc3RlbmVyKCJrZXlkb3duIixlPT57CiAgaWYoZS5rZXk9PT0iRW50ZXIifHxlLmtleT09PSIsIil7ZS5wcmV2ZW50RGVmYXVsdCgpO2FkZERyYWZ0KCk7fQogIGVsc2UgaWYoZS5rZXk9PT0iQmFja3NwYWNlIiYmISQoIiNkcmFmdCIpLnZhbHVlJiZzaG93cy5sZW5ndGgpe3Nob3dzLnBvcCgpO3JlbmRlckNoaXBzKCk7fQp9KTsKJCgiI2V4YW1wbGUiKS5vbmNsaWNrPSgpPT57c2hvd3M9Wy4uLkVYQU1QTEVdO3JlbmRlckNoaXBzKCk7fTsKJCgiI2dvIikub25jbGljaz1kaXNjb3ZlcjsKCgphc3luYyBmdW5jdGlvbiByZWFkSnNvbihyLGZhbGxiYWNrTXNnKXsKICB2YXIgY3Q9ci5oZWFkZXJzLmdldCgiY29udGVudC10eXBlIil8fCIiOwogIGlmKGN0LmluZGV4T2YoImFwcGxpY2F0aW9uL2pzb24iKT09PS0xKXsKICAgIHZhciB0PShhd2FpdCByLnRleHQoKSkudHJpbSgpOwogICAgaWYodC5jaGFyQXQoMCk9PT0iPCIpIHRocm93IG5ldyBFcnJvcigiVGhlIHNlcnZlciBpcyB3YWtpbmcgdXAgXHUyMDE0IHRoZSBmcmVlIGhvc3RpbmcgcGxhbiBzbGVlcHMgYWZ0ZXIgMTUgbWludXRlcyBvZiBubyB1c2UuIFBsZWFzZSB3YWl0IHVwIHRvIGEgbWludXRlLCB0aGVuIHByZXNzIHRoZSBidXR0b24gYWdhaW4uIik7CiAgICB0aHJvdyBuZXcgRXJyb3IodC5zbGljZSgwLDIwMCl8fGZhbGxiYWNrTXNnfHwoIlJlcXVlc3QgZmFpbGVkICgiK3Iuc3RhdHVzKyIpIikpOwogIH0KICB2YXIgaj1hd2FpdCByLmpzb24oKTsKICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKGouZXJyb3J8fGZhbGxiYWNrTXNnfHwiUmVxdWVzdCBmYWlsZWQiKTsKICByZXR1cm4gajsKfQoKYXN5bmMgZnVuY3Rpb24gZGlzY292ZXIoKXsKICBjb25zdCByZXN1bHRzPSQoIiNyZXN1bHRzIiksIGlucHV0PSQoIiNpbnB1dCIpOwogIGlucHV0LnN0eWxlLmRpc3BsYXk9Im5vbmUiO3Jlc3VsdHMuc3R5bGUuZGlzcGxheT0iYmxvY2siO3Nob3dMb2c9ZmFsc2U7ZXhoYXVzdGVkPWZhbHNlO2xvYWRpbmdNb3JlPWZhbHNlOwogIHJlc3VsdHMuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJsb2FkIiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0KTt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjQwcHggMCI+UmVhZGluZyB5b3VyIHRhc3RlLCBwdWxsaW5nIHJlYWwgcmF0aW5ncyAmYW1wOyBhdmFpbGFiaWxpdHnigKY8L2Rpdj4nOwogIGZpbHRlcnM9e3R5cGU6ImFsbCIsbWluOjAsbmV0OmZhbHNlLHNvcnQ6Im1hdGNoIn07CiAgdHJ5ewogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9kaXNjb3ZlciIse21ldGhvZDoiUE9TVCIsaGVhZGVyczp7IkNvbnRlbnQtVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7bG92ZWQ6c2hvd3MsY291bnRyeTpyZWdpb25TZWwudmFsdWUsdHlwZTp0eXBlU2VsLnZhbHVlLGdlbnJlOmdlbnJlU2VsLnZhbHVlLHdhdGNoZWQ6d2F0Y2hlZE1hcH0pfSk7CiAgICBjb25zdCBqPWF3YWl0IHJlYWRKc29uKHIsIlJlcXVlc3QgZmFpbGVkIik7CiAgICBkYXRhPWo7cmVuZGVyKCk7CiAgfWNhdGNoKGUpewogICAgcmVzdWx0cy5pbm5lckhUTUw9JzxkaXYgY2xhc3M9InJjIiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXIiPjxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206MTRweCI+Jytlc2MoZS5tZXNzYWdlKSsnPC9kaXY+PGJ1dHRvbiBjbGFzcz0iY3RhIiBvbmNsaWNrPSJkaXNjb3ZlcigpIj5UcnkgYWdhaW48L2J1dHRvbj48L2Rpdj4nOwogIH0KfQoKZnVuY3Rpb24gb2JzZXJ2ZVNlbnRpbmVsKCl7CiAgaWYoaW8paW8uZGlzY29ubmVjdCgpOwogIGNvbnN0IGVsPSQoIiNzZW50aW5lbCIpOyBpZighZWwpcmV0dXJuOwogIGlvPW5ldyBJbnRlcnNlY3Rpb25PYnNlcnZlcihlcz0+eyBpZihlc1swXS5pc0ludGVyc2VjdGluZykgbG9hZE1vcmUoKTsgfSx7cm9vdE1hcmdpbjoiNTAwcHgifSk7CiAgaW8ub2JzZXJ2ZShlbCk7Cn0KYXN5bmMgZnVuY3Rpb24gbG9hZE1vcmUoKXsKICBpZihsb2FkaW5nTW9yZXx8ZXhoYXVzdGVkfHwhZGF0YSlyZXR1cm47CiAgbG9hZGluZ01vcmU9dHJ1ZTsgcmVuZGVyKCk7CiAgdHJ5ewogICAgY29uc3QgZXhjbHVkZT1kYXRhLnJlc3VsdHMubWFwKHg9PngudGl0bGUpOwogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9kaXNjb3ZlciIse21ldGhvZDoiUE9TVCIsaGVhZGVyczp7IkNvbnRlbnQtVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7bG92ZWQ6c2hvd3MsY291bnRyeTpyZWdpb25TZWwudmFsdWUsZXhjbHVkZSx0eXBlOnR5cGVTZWwudmFsdWUsZ2VucmU6Z2VucmVTZWwudmFsdWUsd2F0Y2hlZDp3YXRjaGVkTWFwfSl9KTsKICAgIGNvbnN0IGo9YXdhaXQgcmVhZEpzb24ociwiQ291bGRuJ3QgbG9hZCBtb3JlIik7CiAgICBjb25zdCBoYXZlPW5ldyBTZXQoZGF0YS5yZXN1bHRzLm1hcCh4PT5ucm0oeC50aXRsZSkpKTsKICAgIGNvbnN0IGFkZD0oai5yZXN1bHRzfHxbXSkuZmlsdGVyKHg9PiFoYXZlLmhhcyhucm0oeC50aXRsZSkpKTsKICAgIGlmKGFkZC5sZW5ndGg9PT0wKXtleGhhdXN0ZWQ9dHJ1ZTt9IGVsc2Uge2RhdGEucmVzdWx0cz1kYXRhLnJlc3VsdHMuY29uY2F0KGFkZCk7fQogIH1jYXRjaChlKXsgZXhoYXVzdGVkPXRydWU7IH0KICBsb2FkaW5nTW9yZT1mYWxzZTsgcmVuZGVyKCk7Cn0KCmZ1bmN0aW9uIG1ldGVyKHZhbCxwY3QsZGlzcCxsYWIpewogIHJldHVybiAnPGRpdiBjbGFzcz0ic2MiPjxkaXYgY2xhc3M9ImxhYiI+JytsYWIrJzwvZGl2PjxkaXYgY2xhc3M9InZhbCIgc3R5bGU9ImNvbG9yOicrKHZhbD09bnVsbD8idmFyKC0tbXV0MikiOiJ2YXIoLS10ZXh0KSIpKyciPicrZGlzcCsnPC9kaXY+PGRpdiBjbGFzcz0ibWV0ZXIiPjxpIHN0eWxlPSJ3aWR0aDonKyhwY3Q9PW51bGw/MDpNYXRoLm1heCgzLE1hdGgubWluKDEwMCxwY3QpKSkrJyU7YmFja2dyb3VuZDonK3Njb3JlQ29sb3IocGN0KSsnIj48L2k+PC9kaXY+PC9kaXY+JzsKfQoKZnVuY3Rpb24gY2FyZCh4KXsKICBjb25zdCBpZD1ucm0oeC50aXRsZSksIHc9d2F0Y2hlZE1hcFtpZF07CiAgY29uc3Qgb3RoZXJzPSh4LnNlcnZpY2VzfHxbXSkuZmlsdGVyKHM9PiEvbmV0ZmxpeC9pLnRlc3Qocy5pZHx8cy5uYW1lKSkuc2xpY2UoMCw0KTsKICBsZXQgd2F0Y2g7CiAgaWYoIXgub25OZXRmbGl4ICYmIG90aGVycy5sZW5ndGg9PT0wKXsKICAgIHdhdGNoPSc8ZGl2IHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQyKSI+Tm8gc3Vic2NyaXB0aW9uIHN0cmVhbSBmb3VuZCBpbiAnK3guY291bnRyeS50b1VwcGVyQ2FzZSgpKycuPC9kaXY+JzsKICB9ZWxzZXsKICAgIGNvbnN0IGxhYmVsPXgub25OZXRmbGl4PyJXaGVyZSB0byB3YXRjaCI6Ik5vdCBvbiBOZXRmbGl4IMK3IHdhdGNoIG9uIjsKICAgIGxldCBjaGlwcz0iIjsKICAgIGlmKHgub25OZXRmbGl4KXtjb25zdCBsPXgubmV0ZmxpeExpbms7Y2hpcHMrPShsPyc8YSBjbGFzcz0ic3ZjIG5ldCIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiIGhyZWY9IicrZXNjKGwpKyciPic6JzxzcGFuIGNsYXNzPSJzdmMgbmV0Ij4nKSsnTmV0ZmxpeCAnK3guY291bnRyeS50b1VwcGVyQ2FzZSgpKyhsPyc8L2E+JzonPC9zcGFuPicpO30KICAgIG90aGVycy5mb3JFYWNoKHM9PntjaGlwcys9KHMubGluaz8nPGEgY2xhc3M9InN2YyBwbGFpbiIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiIGhyZWY9IicrZXNjKHMubGluaykrJyI+JzonPHNwYW4gY2xhc3M9InN2YyBwbGFpbiI+JykrZXNjKHMubmFtZSkrKHMubGluaz8nPC9hPic6Jzwvc3Bhbj4nKTt9KTsKICAgIHdhdGNoPSc8ZGl2IGNsYXNzPSJsYWIyIj4nK2xhYmVsKyc8L2Rpdj48ZGl2IGNsYXNzPSJyb3ciIHN0eWxlPSJnYXA6NnB4Ij4nK2NoaXBzKyc8L2Rpdj4nOwogIH0KICBsZXQgZm9vdDsKICBpZih3KXsKICAgIGZvb3Q9JzxkaXYgY2xhc3M9InNlZW5yb3ciIHN0eWxlPSJqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbiI+PHNwYW4gY2xhc3M9IndhdGNoZWR0YWciIHN0eWxlPSJjb2xvcjonKyh3Lmxpa2VkPyd2YXIoLS1nb29kKSc6J3ZhcigtLWJhZCknKSsnIj7inJMgV2F0Y2hlZCDCtyAnKyh3Lmxpa2VkPydMb3ZlZCBpdCc6J05vdCBmb3IgbWUnKSsnPC9zcGFuPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJ1bmRvIiBkYXRhLWFjdD0idW53YXRjaCIgZGF0YS1pZD0iJytlc2MoaWQpKyciPnVuZG88L2J1dHRvbj48L2Rpdj4nOwogIH1lbHNlewogICAgZm9vdD0nPGRpdiBjbGFzcz0ic2VlbnJvdyI+PHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi1yaWdodDphdXRvIj5TZWVuIGl0Pzwvc3Bhbj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0icmF0ZSB1cCIgZGF0YS1hY3Q9Imxpa2UiIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj7wn5GNIExvdmVkIGl0PC9idXR0b24+JwogICAgICArJzxidXR0b24gY2xhc3M9InJhdGUgZG93biIgZGF0YS1hY3Q9ImRpc2xpa2UiIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj7wn5GOIE5vdCBmb3IgbWU8L2J1dHRvbj48L2Rpdj4nOwogIH0KICByZXR1cm4gJzxkaXYgY2xhc3M9InJjJysodz8nIHNlZW4nOicnKSsnIj48ZGl2IGNsYXNzPSJraWNrZXIiPicrZXNjKHgudHlwZSkrKHgueWVhcj8nIMK3ICcrZXNjKHgueWVhcik6JycpKyc8L2Rpdj4nCiAgICArJzxkaXY+PGRpdiBjbGFzcz0icnQtdGl0bGUiPicrZXNjKHgudGl0bGUpKyc8L2Rpdj48ZGl2IGNsYXNzPSJyZWFzb24iPicrZXNjKHgucmVhc29uKSsnPC9kaXY+PC9kaXY+JwogICAgKyc8ZGl2IGNsYXNzPSJociI+PC9kaXY+PGRpdiBjbGFzcz0ic2NvcmVzIj4nCiAgICArIG1ldGVyKHguaW1kYiwgeC5pbWRiIT1udWxsP3guaW1kYioxMDpudWxsLCB4LmltZGIhPW51bGw/TnVtYmVyKHguaW1kYikudG9GaXhlZCgxKToi4oCUIiwiSU1EYiIpCiAgICArIG1ldGVyKHgucnRDcml0aWNzLCB4LnJ0Q3JpdGljcywgeC5ydENyaXRpY3MhPW51bGw/TWF0aC5yb3VuZCh4LnJ0Q3JpdGljcykrIiUiOiLigJQiLCJSVCBDcml0aWNzIikKICAgICsgbWV0ZXIoeC5tZXRhc2NvcmUsIHgubWV0YXNjb3JlLCB4Lm1ldGFzY29yZSE9bnVsbD9NYXRoLnJvdW5kKHgubWV0YXNjb3JlKToi4oCUIiwiTWV0YWNyaXRpYyIpCiAgICArJzwvZGl2PjxkaXYgY2xhc3M9ImhyIj48L2Rpdj4nK3dhdGNoKyc8ZGl2IGNsYXNzPSJociI+PC9kaXY+Jytmb290Kyc8L2Rpdj4nOwp9CgpmdW5jdGlvbiBzZWcobmFtZSxvcHRzLGN1cil7CiAgcmV0dXJuICc8ZGl2PjxkaXYgY2xhc3M9ImxhYjIiPicrbmFtZS5sYWJlbCsnPC9kaXY+PGRpdiBjbGFzcz0ic2VnIj4nK29wdHMubWFwKG89PgogICAgJzxidXR0b24gY2xhc3M9IicrKG8udj09PWN1cj8ib24iOiIiKSsnIiBkYXRhLWs9IicrbmFtZS5rZXkrJyIgZGF0YS12PSInK28udisnIj4nK28udCsnPC9idXR0b24+Jykuam9pbigiIikrJzwvZGl2PjwvZGl2Pic7Cn0KCmZ1bmN0aW9uIHJlbmRlcigpewogIGNvbnN0IHJlc3VsdHM9JCgiI3Jlc3VsdHMiKTsKICBsZXQgbGlzdD1kYXRhLnJlc3VsdHMuZmlsdGVyKHg9PnsKICAgIGlmKGZpbHRlcnMudHlwZSE9PSJhbGwiJiZ4LnR5cGUudG9Mb3dlckNhc2UoKSE9PWZpbHRlcnMudHlwZSlyZXR1cm4gZmFsc2U7CiAgICBpZihmaWx0ZXJzLm5ldCYmeC5vbk5ldGZsaXghPT10cnVlKXJldHVybiBmYWxzZTsKICAgIGlmKGZpbHRlcnMubWluPjAmJih4LmltZGI9PW51bGx8fE51bWJlcih4LmltZGIpPGZpbHRlcnMubWluKSlyZXR1cm4gZmFsc2U7CiAgICByZXR1cm4gdHJ1ZTsKICB9KTsKICBpZihmaWx0ZXJzLnNvcnQ9PT0iaW1kYiIpbGlzdD1bLi4ubGlzdF0uc29ydCgoYSxiKT0+KGIuaW1kYnx8LTEpLShhLmltZGJ8fC0xKSk7CiAgaWYoZmlsdGVycy5zb3J0PT09InJ0IilsaXN0PVsuLi5saXN0XS5zb3J0KChhLGIpPT4oYi5ydENyaXRpY3N8fC0xKS0oYS5ydENyaXRpY3N8fC0xKSk7CgogIGNvbnN0IGJhcj0nPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTJweDttYXJnaW4tYm90dG9tOjE4cHg7ZmxleC13cmFwOndyYXAiPicKICAgICsnPGJ1dHRvbiBjbGFzcz0iZ2hvc3QiIGlkPSJiYWNrIj7ihpAgU3RhcnQgb3ZlcjwvYnV0dG9uPicKICAgICsnPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTJweDtmbGV4LXdyYXA6d3JhcCI+PHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMi41cHg7Y29sb3I6dmFyKC0tbXV0KSI+TWF0Y2hlZCB0byAnK3Nob3dzLmxlbmd0aCsnIGxvdmVzIMK3IE5ldGZsaXggJytlc2MoZGF0YS5jb3VudHJ5TmFtZSkrJzwvc3Bhbj4nK2xvZ0J1dHRvbkhUTUwoKSsnPC9kaXY+PC9kaXY+JzsKCiAgY29uc3QgcGFuZWw9c2hvd0xvZz8nPGRpdiBjbGFzcz0ibG9ncGFuZWwiPjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi1ib3R0b206MTJweCI+WW91ciB3YXRjaCBoaXN0b3J5IMK3IHNoYXBlcyBldmVyeSBzdWdnZXN0aW9uPC9kaXY+Jytsb2dMaXN0SFRNTCgpKyc8L2Rpdj4nOicnOwoKICBjb25zdCB0b29sYmFyPSc8ZGl2IGNsYXNzPSJ0b29sYmFyIj4nCiAgICArIHNlZyh7bGFiZWw6IlR5cGUiLGtleToidHlwZSJ9LFt7djoiYWxsIix0OiJBbGwifSx7djoibW92aWUiLHQ6Ik1vdmllcyJ9LHt2OiJzZXJpZXMiLHQ6IlNlcmllcyJ9XSxmaWx0ZXJzLnR5cGUpCiAgICArIHNlZyh7bGFiZWw6Ik1pbiBJTURiIixrZXk6Im1pbiJ9LFt7djowLHQ6IkFueSJ9LHt2OjcsdDoiNysifSx7djo4LHQ6IjgrIn1dLGZpbHRlcnMubWluKQogICAgKyBzZWcoe2xhYmVsOiJTb3J0IGJ5IixrZXk6InNvcnQifSxbe3Y6Im1hdGNoIix0OiJNYXRjaCJ9LHt2OiJpbWRiIix0OiJJTURiIn0se3Y6InJ0Iix0OiJSVCJ9XSxmaWx0ZXJzLnNvcnQpCiAgICArICc8bGFiZWwgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtmb250LXNpemU6MTNweDtjdXJzb3I6cG9pbnRlcjttYXJnaW4tbGVmdDphdXRvO3VzZXItc2VsZWN0Om5vbmUiPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgaWQ9Im5ldG9ubHkiICcrKGZpbHRlcnMubmV0PyJjaGVja2VkIjoiIikrJyBzdHlsZT0iYWNjZW50LWNvbG9yOnZhcigtLWdvbGQpO3dpZHRoOjE2cHg7aGVpZ2h0OjE2cHgiPiBPbiBOZXRmbGl4IG9ubHk8L2xhYmVsPicKICAgICsgJzwvZGl2Pic7CgogIGNvbnN0IGJvZHk9bGlzdC5sZW5ndGgKICAgID8gJzxkaXYgY2xhc3M9ImdyaWQiPicrbGlzdC5tYXAoY2FyZCkuam9pbigiIikrJzwvZGl2PicKICAgIDogJzxkaXYgc3R5bGU9ImNvbG9yOnZhcigtLW11dCk7dGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzo0MHB4IDAiPk5vdGhpbmcgbWF0Y2hlcyB0aGVzZSBmaWx0ZXJzLiBMb29zZW4gdGhlbSB0byBzZWUgbW9yZS48L2Rpdj4nOwoKICBjb25zdCBub3RlPSc8cCBjbGFzcz0ibm90ZSI+UmF0aW5ncyB2aWEgT01EYiAoSU1EYiDCtyBSb3R0ZW4gVG9tYXRvZXMgwrcgTWV0YWNyaXRpYykuICcKICAgICtlc2MoZGF0YS5hdHRyaWJ1dGlvbikrJy4gTW9yZSBsb2FkIGF1dG9tYXRpY2FsbHkgYXMgeW91IHNjcm9sbCwgZWFjaCBiYXRjaCBhdm9pZGluZyB3aGF0IHlvdVwndmUgYWxyZWFkeSBzZWVuLiBZb3VyIHdhdGNoIGhpc3RvcnkgaXMgc2F2ZWQgc2VydmVyLXNpZGUgYW5kIGZlZWRzIGV2ZXJ5IHN1Z2dlc3Rpb24uPC9wPic7CgogIGNvbnN0IGZvb3RlciA9IGV4aGF1c3RlZAogICAgPyAnPGRpdiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjEzcHg7cGFkZGluZzoyNHB4IDAgOHB4Ij5UaGF0XCdzIHRoZSBiZXN0IG9mIHdoYXQgZml0cyB5b3VyIHRhc3RlIHJpZ2h0IG5vdy4gUmF0ZSBhIGZldyBhbmQgc3RhcnQgb3ZlciBmb3IgYSBmcmVzaCByZWFkLjwvZGl2PicKICAgIDogKGxvYWRpbmdNb3JlCiAgICAgICAgPyAnPGRpdiBjbGFzcz0ibG9hZCIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLW11dCk7Zm9udC1zaXplOjEzLjVweDtwYWRkaW5nOjI0cHggMCA4cHgiPkZpbmRpbmcgbW9yZSBmb3IgeW914oCmPC9kaXY+JwogICAgICAgIDogJzxkaXYgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO3BhZGRpbmc6MjBweCAwIDRweCI+PGJ1dHRvbiBjbGFzcz0iZ2hvc3QiIGlkPSJsb2FkbW9yZSI+TG9hZCBtb3JlPC9idXR0b24+PC9kaXY+Jyk7CiAgY29uc3Qgc2VudGluZWw9JzxkaXYgaWQ9InNlbnRpbmVsIiBzdHlsZT0iaGVpZ2h0OjFweCI+PC9kaXY+JzsKCiAgcmVzdWx0cy5pbm5lckhUTUw9YmFyK3BhbmVsK3Rvb2xiYXIrYm9keStmb290ZXIrc2VudGluZWwrbm90ZTsKICAkKCIjYmFjayIpLm9uY2xpY2s9KCk9PntyZXN1bHRzLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyQoIiNpbnB1dCIpLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjt9OwogICQoIiNuZXRvbmx5Iikub25jaGFuZ2U9ZT0+e2ZpbHRlcnMubmV0PWUudGFyZ2V0LmNoZWNrZWQ7cmVuZGVyKCk7fTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoIi5zZWcgYnV0dG9uIikuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PnsKICAgIGNvbnN0IGs9Yi5kYXRhc2V0Lms7bGV0IHY9Yi5kYXRhc2V0LnY7aWYoaz09PSJtaW4iKXY9TnVtYmVyKHYpO2ZpbHRlcnNba109djtyZW5kZXIoKTsKICB9KTsKICAvLyB3YXRjaGVkIGNvbnRyb2xzCiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Imxpa2UiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57Y29uc3Qgcj1kYXRhLnJlc3VsdHMuZmluZCh4PT5ucm0oeC50aXRsZSk9PT1iLmRhdGFzZXQuaWQpO2lmKHIpbWFya1dhdGNoZWQocix0cnVlKTt9KTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0iZGlzbGlrZSJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9Pntjb25zdCByPWRhdGEucmVzdWx0cy5maW5kKHg9Pm5ybSh4LnRpdGxlKT09PWIuZGF0YXNldC5pZCk7aWYociltYXJrV2F0Y2hlZChyLGZhbHNlKTt9KTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0idW53YXRjaCJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PnJlbW92ZVdhdGNoZWQoYi5kYXRhc2V0LmlkKSk7CiAgd2lyZUxvZ0NvbnRyb2xzKHJlc3VsdHMpOwogIGNvbnN0IGxtPSQoIiNsb2FkbW9yZSIpOyBpZihsbSlsbS5vbmNsaWNrPWxvYWRNb3JlOwogIG9ic2VydmVTZW50aW5lbCgpOwp9CgpyZW5kZXJDaGlwcygpOwpsb2FkV2F0Y2hlZCgpOwoKdmFyIF9zPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzdGF0dXMiKTtpZihfcyl7X3Muc3R5bGUuZGlzcGxheT0iYmxvY2siO19zLnN0eWxlLmJhY2tncm91bmQ9IiMxMjI4MWMiO19zLnN0eWxlLmJvcmRlcj0iMXB4IHNvbGlkICMyZjVhM2QiO19zLnN0eWxlLmNvbG9yPSIjYmZlOGNmIjtfcy50ZXh0Q29udGVudD0iUmVhZHkgXHUyMDE0IHR5cGUgYSB0aXRsZSwgcHJlc3MgRW50ZXIsIGFkZCBhdCBsZWFzdCAzLiI7fQo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==", "base64").toString("utf8");

app.get("/", (_req, res) => res.type("html").send(PAGE));

app.listen(PORT, () => console.log(`What Next server → http://localhost:${PORT}`));
