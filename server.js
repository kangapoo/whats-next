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
  TMDB_API_KEY,
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

const normTitle = (s) => String(s || "").trim().toLowerCase();

// Genre name -> TMDb genre IDs (movie and TV numbering differ).
const GENRE_IDS = {
  action: { movie: [28], tv: [10759] }, adventure: { movie: [12], tv: [10759] },
  animation: { movie: [16], tv: [16] }, comedy: { movie: [35], tv: [35] },
  crime: { movie: [80], tv: [80] }, documentary: { movie: [99], tv: [99] },
  drama: { movie: [18], tv: [18] }, fantasy: { movie: [14], tv: [10765] },
  horror: { movie: [27], tv: [] }, mystery: { movie: [9648], tv: [9648] },
  romance: { movie: [10749], tv: [] }, "sci-fi": { movie: [878], tv: [10765] },
  thriller: { movie: [53], tv: [] },
};

async function pool(items, size, worker) {
  const q = items.map((it, i) => [it, i]);
  const out = new Array(items.length);
  const runners = Array.from({ length: Math.min(size, q.length) }, async () => {
    while (q.length) { const [it, i] = q.shift(); out[i] = await worker(it, i); }
  });
  await Promise.all(runners);
  return out;
}

// ---------- TMDb: free recommendations ----------
const tmdbIsV4 = () => !!(TMDB_API_KEY && TMDB_API_KEY.startsWith("eyJ"));
function tmdbUrl(p, params = {}) {
  const u = new URL("https://api.themoviedb.org/3" + p);
  if (!tmdbIsV4()) u.searchParams.set("api_key", TMDB_API_KEY || "");
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u;
}
async function tmdb(p, params) {
  const r = await fetch(tmdbUrl(p, params), {
    headers: tmdbIsV4() ? { Authorization: `Bearer ${TMDB_API_KEY}` } : {},
  });
  if (!r.ok) throw new Error(`TMDb ${r.status}`);
  return r.json();
}
const tTitle = (x) => x.title || x.name || "";
const tYear = (x) => (x.release_date || x.first_air_date || "").slice(0, 4);

// For one loved title: find it on TMDb, return its recommended + similar titles.
async function tmdbSeedRecs(seedTitle) {
  let found;
  try {
    const s = await tmdb("/search/multi", { query: seedTitle, include_adult: "false" });
    found = (s.results || []).find((x) => (x.media_type === "movie" || x.media_type === "tv") && tTitle(x));
  } catch { return []; }
  if (!found) return [];
  const mt = found.media_type;
  let recs = [];
  try { const rr = await tmdb(`/${mt}/${found.id}/recommendations`, {}); recs = rr.results || []; } catch {}
  if (recs.length < 6) {
    try { const sim = await tmdb(`/${mt}/${found.id}/similar`, {}); recs = recs.concat(sim.results || []); } catch {}
  }
  recs.forEach((r) => { r.media_type = mt; });
  return recs;
}

// ---------- OMDb: IMDb + Rotten Tomatoes ----------
function pctFromRatings(ratings, source) {
  const r = (ratings || []).find((x) => x.Source === source);
  if (!r) return null;
  const m = String(r.Value).match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}
async function omdbByImdb(imdbID) {
  if (!OMDB_API_KEY || !imdbID) return null;
  try {
    const u = new URL("https://www.omdbapi.com/");
    u.searchParams.set("apikey", OMDB_API_KEY);
    u.searchParams.set("i", imdbID);
    u.searchParams.set("tomatoes", "true"); // legacy field that carries a Tomatometer for some titles
    const r = await fetch(u);
    const d = await r.json();
    if (d.Response === "False") return null;
    let rt = pctFromRatings(d.Ratings, "Rotten Tomatoes");
    if (rt == null && d.tomatoMeter && d.tomatoMeter !== "N/A") { const n = Number(d.tomatoMeter); if (!isNaN(n)) rt = n; }
    return {
      imdb: d.imdbRating && d.imdbRating !== "N/A" ? Number(d.imdbRating) : null,
      rtCritics: rt,
      metascore: d.Metascore && d.Metascore !== "N/A" ? Number(d.Metascore) : null,
      poster: d.Poster && d.Poster !== "N/A" ? d.Poster : null,
      plot: d.Plot && d.Plot !== "N/A" ? d.Plot : null,
    };
  } catch { return null; }
}

// ---------- Streaming availability ----------
async function saLookup(imdbID, country) {
  if (!imdbID) return null;
  const rapid = STREAMING_PROVIDER !== "motn";
  const base = rapid
    ? `https://streaming-availability.p.rapidapi.com/shows/${imdbID}`
    : `https://api.movieofthenight.com/v4/shows/${imdbID}`;
  const u = new URL(base);
  u.searchParams.set("country", country);
  const headers = rapid
    ? { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": "streaming-availability.p.rapidapi.com" }
    : { "X-API-Key": MOTN_API_KEY };
  try {
    const r = await fetch(u, { headers });
    if (!r.ok) return null;
    const show = await r.json();
    const opts = (show.streamingOptions && show.streamingOptions[country]) || [];
    // Accuracy: a lit icon means the title is included with that service's
    // subscription (or free with ads) IN THIS REGION — not a paid add-on, rental, or purchase.
    const included = opts.filter((o) => o.type === "subscription" || o.type === "free");
    const byService = new Map();
    for (const o of included) {
      const name = o.service?.name || o.service?.id || "Unknown";
      if (!byService.has(name)) byService.set(name, { name, link: o.link || null, id: o.service?.id });
    }
    const services = [...byService.values()];
    const netflix = services.find((s) => /netflix/i.test(s.id || s.name));
    return { onNetflix: !!netflix, netflixLink: netflix?.link || null, services };
  } catch { return null; }
}

// ---------- discover ----------
app.post("/api/discover", async (req, res) => {
  try {
    const loved = Array.isArray(req.body?.loved) ? req.body.loved.filter(Boolean) : [];
    const country = String(req.body?.country || "za").toLowerCase();
    const wantType = String(req.body?.type || "").toLowerCase();          // movie | series | ""
    const wantGenre = String(req.body?.genre || "").trim().toLowerCase(); // e.g. comedy | any | ""
    const exclude = Array.isArray(req.body?.exclude) ? req.body.exclude : [];
    const watched = (req.body && typeof req.body.watched === "object" && req.body.watched) || {};
    const limit = Math.min(Math.max(Number(req.body?.limit) || 8, 1), 12);
    if (!TMDB_API_KEY) return res.status(500).json({ error: "Server missing TMDB_API_KEY." });
    if (loved.length < 1) return res.status(400).json({ error: "Add at least one title you loved." });

    // Seeds = titles you loved + titles you watched and liked (extra positive signal).
    const likedWatched = Object.values(watched).filter((w) => w.liked).map((w) => w.title);
    const seeds = [...new Set([...loved, ...likedWatched])].slice(0, 12);

    // Gather candidate titles from each seed's TMDb recommendations.
    const candidates = new Map(); // "movie:123" -> { id, media, raw, seeds:Set, freq }
    const perSeed = await pool(seeds, 4, (t) => tmdbSeedRecs(t));
    perSeed.forEach((recs, idx) => {
      const seedName = seeds[idx];
      (recs || []).forEach((c) => {
        if (!c || !c.id || !c.media_type) return;
        const key = c.media_type + ":" + c.id;
        if (!candidates.has(key)) candidates.set(key, { id: c.id, media: c.media_type, raw: c, seeds: new Set(), freq: 0 });
        const e = candidates.get(key);
        e.seeds.add(seedName);
        e.freq++;
      });
    });

    // Never suggest something loved, already watched, or already shown this session.
    const skip = new Set([
      ...loved.map(normTitle),
      ...Object.values(watched).map((w) => normTitle(w.title)),
      ...exclude.map(normTitle),
    ]);
    let arr = [...candidates.values()].filter((e) => !skip.has(normTitle(tTitle(e.raw))));

    // Type filter.
    if (wantType === "movie") arr = arr.filter((e) => e.media === "movie");
    else if (wantType === "series") arr = arr.filter((e) => e.media === "tv");

    // Genre filter — relax automatically if it would leave nothing.
    if (wantGenre && wantGenre !== "any" && GENRE_IDS[wantGenre]) {
      const filtered = arr.filter((e) => {
        const ids = GENRE_IDS[wantGenre][e.media === "tv" ? "tv" : "movie"] || [];
        if (!ids.length) return false;
        const g = e.raw.genre_ids || [];
        return ids.some((id) => g.includes(id));
      });
      if (filtered.length > 0) arr = filtered; // keep genuine genre matches; if none, leave arr as-is
    }

    // Rank: more seed-overlap first, then TMDb rating / popularity.
    arr.sort((a, b) =>
      (b.freq - a.freq) ||
      ((b.raw.vote_average || 0) - (a.raw.vote_average || 0)) ||
      ((b.raw.popularity || 0) - (a.raw.popularity || 0))
    );
    const top = arr.slice(0, limit);

    // Enrich with IMDb id -> OMDb ratings + streaming availability.
    const results = await pool(top, 4, async (e) => {
      const media = e.media, id = e.id, raw = e.raw;
      let imdbID = null;
      try { const ext = await tmdb(`/${media}/${id}/external_ids`, {}); imdbID = ext.imdb_id || null; } catch {}
      const omdb = imdbID ? await omdbByImdb(imdbID) : null;
      const sa = imdbID ? await saLookup(imdbID, country) : null;
      let videos = [];
      try {
        const v = await tmdb(`/${media}/${id}/videos`, {});
        videos = (v.results || [])
          .filter((x) => x.site === "YouTube" && (x.type === "Trailer" || x.type === "Teaser") && x.key)
          .sort((a, b) => {
            if (!!b.official !== !!a.official) return (b.official ? 1 : 0) - (a.official ? 1 : 0);
            if (a.type !== b.type) return a.type === "Trailer" ? -1 : 1;
            return String(b.published_at || "").localeCompare(String(a.published_at || ""));
          })
          .slice(0, 8)
          .map((x) => ({ key: x.key, name: x.name || x.type, type: x.type }));
      } catch {}
      const seedList = [...e.seeds];
      return {
        title: tTitle(raw),
        year: tYear(raw),
        type: media === "tv" ? "Series" : "Movie",
        reason: seedList.length ? `Because you enjoyed ${seedList[0]}` : "A strong match for your taste",
        overview: raw.overview || omdb?.plot || null,
        videos,
        poster: omdb?.poster || (raw.poster_path ? `https://image.tmdb.org/t/p/w300${raw.poster_path}` : null),
        imdb: omdb?.imdb ?? null,
        rtCritics: omdb?.rtCritics ?? null,
        tmdb: typeof raw.vote_average === "number" && raw.vote_average > 0 ? Math.round(raw.vote_average * 10) / 10 : null,
        metascore: omdb?.metascore ?? null,
        onNetflix: sa ? sa.onNetflix : null,
        netflixLink: sa?.netflixLink || null,
        services: sa?.services || [],
        country,
      };
    });

    res.json({
      country,
      countryName: COUNTRY_NAMES[country] || country.toUpperCase(),
      results,
      attribution: "Suggestions from TMDB (this product uses the TMDB API but is not endorsed or certified by TMDB). Ratings via OMDb. Streaming by Movie of the Night.",
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message || "Something broke while building recommendations." });
  }
});

// ---------- diagnostics ----------
app.get("/api/diag", async (_req, res) => {
  const out = {
    tmdb: {},
    omdb: {},
    streaming: { keySaved: STREAMING_PROVIDER === "motn" ? !!MOTN_API_KEY : !!RAPIDAPI_KEY },
  };
  try {
    if (!TMDB_API_KEY) out.tmdb = { working: false, note: "No TMDB key saved on the server." };
    else { const d = await tmdb("/search/movie", { query: "The Matrix" }); out.tmdb = { working: true, found: (d.results && d.results[0] && d.results[0].title) || null }; }
  } catch (e) { out.tmdb = { working: false, error: String(e.message) }; }
  try {
    if (!OMDB_API_KEY) out.omdb = { working: false, note: "No OMDb key saved." };
    else {
      const u = new URL("https://www.omdbapi.com/");
      u.searchParams.set("apikey", OMDB_API_KEY);
      u.searchParams.set("i", "tt0133093");
      const r = await fetch(u); const d = await r.json();
      if (d.Response === "False") out.omdb = { working: false, omdbSays: d.Error || "unknown" };
      else out.omdb = { working: true, imdb: d.imdbRating, rottenTomatoes: (d.Ratings || []).find((x) => x.Source === "Rotten Tomatoes")?.Value || "not listed" };
    }
  } catch (e) { out.omdb = { working: false, error: String(e.message) }; }
  // Streaming service live test (Breaking Bad, US) — reveals rate limits / key problems.
  try {
    const rapid = STREAMING_PROVIDER !== "motn";
    const keyPresent = rapid ? !!RAPIDAPI_KEY : !!MOTN_API_KEY;
    if (!keyPresent) out.streaming = { working: false, note: "No streaming key saved." };
    else {
      const base = rapid
        ? "https://streaming-availability.p.rapidapi.com/shows/tt0903747"
        : "https://api.movieofthenight.com/v4/shows/tt0903747";
      const u = new URL(base);
      u.searchParams.set("country", "us");
      const headers = rapid
        ? { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": "streaming-availability.p.rapidapi.com" }
        : { "X-API-Key": MOTN_API_KEY };
      const r = await fetch(u, { headers });
      if (!r.ok) {
        let msg = "";
        try { msg = JSON.stringify(await r.json()); } catch { msg = await r.text().catch(() => ""); }
        out.streaming = { working: false, httpStatus: r.status, serviceSays: String(msg).slice(0, 200) };
      } else {
        const show = await r.json();
        const opts = (show.streamingOptions && show.streamingOptions["us"]) || [];
        out.streaming = { working: true, testedWith: "Breaking Bad (US)", servicesFound: [...new Set(opts.map((o) => o.service?.name || o.service?.id))].slice(0, 8) };
      }
    }
  } catch (e) { out.streaming = { working: false, error: String(e.message) }; }
  res.json(out);
});

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    keys: {
      tmdb: !!TMDB_API_KEY,
      omdb: !!OMDB_API_KEY,
      streaming: STREAMING_PROVIDER === "motn" ? !!MOTN_API_KEY : !!RAPIDAPI_KEY,
    },
  });
});

const PAGE = Buffer.from("PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPgo8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEiIC8+Cjx0aXRsZT5XaGF0IE5leHQgwrcgTmV0ZmxpeCB0YXN0ZS1tYXRjaGVyPC90aXRsZT4KPHN0eWxlPgogIDpyb290ewogICAgLS1iZzojMEUxMTE2OyAtLWJnMjojMTIxNjFDOyAtLWNhcmQ6IzE3MUMyNDsgLS1jYXJkSGk6IzFDMjIyQjsKICAgIC0tbGluZTojMjcyRTM5OyAtLWdvbGQ6I0U4QjQ0QTsgLS10ZXh0OiNGMkVERTM7IC0tbXV0OiM4QjkzQTA7IC0tbXV0MjojNUM2NDcwOwogICAgLS1nb29kOiM0RkI0Nzc7IC0tbWlkOiNFOEI0NEE7IC0tYmFkOiNFMDU3NEI7IC0tbmV0OiM0RkI0Nzc7CiAgfQogICp7Ym94LXNpemluZzpib3JkZXItYm94fQogIGJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7CiAgICBmb250LWZhbWlseTotYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwnU2Vnb2UgVUknLFJvYm90byxzYW5zLXNlcmlmO30KICAud3JhcHttYXgtd2lkdGg6OTQwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjQwcHggMjJweCA3MnB4fQogIC5leWVicm93e2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4yMmVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1nb2xkKTttYXJnaW4tYm90dG9tOjEwcHh9CiAgaDF7Zm9udC1mYW1pbHk6dWktc2VyaWYsR2VvcmdpYSxzZXJpZjtmb250LXNpemU6NDZweDtsaW5lLWhlaWdodDoxLjAyO21hcmdpbjowO2ZvbnQtd2VpZ2h0OjYwMDtsZXR0ZXItc3BhY2luZzotLjAxZW19CiAgLnN1Yntjb2xvcjp2YXIoLS1tdXQpO2ZvbnQtc2l6ZToxNXB4O21hcmdpbi10b3A6MTJweDttYXgtd2lkdGg6NTIwcHg7bGluZS1oZWlnaHQ6MS41fQogIC5wYW5lbHtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE4cHg7cGFkZGluZzoyNHB4fQogIC5yb3d7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDo4cHh9CiAgLmNoaXB7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtiYWNrZ3JvdW5kOnZhcigtLWNhcmRIaSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsKICAgIGJvcmRlci1yYWRpdXM6OTk5cHg7cGFkZGluZzo3cHggOHB4IDdweCAxNHB4O2ZvbnQtc2l6ZToxMy41cHh9CiAgLmNoaXAgYnV0dG9ue2N1cnNvcjpwb2ludGVyO2JvcmRlcjpub25lO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6dmFyKC0tbXV0KTtmb250LXNpemU6MTVweDtsaW5lLWhlaWdodDoxO3BhZGRpbmc6MCAycHh9CiAgaW5wdXQudGl0bGV7ZmxleDoxIDAgMTYwcHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS10ZXh0KTtmb250LXNpemU6MTRweDtwYWRkaW5nOjhweCA0cHg7bWluLXdpZHRoOjE0MHB4O291dGxpbmU6bm9uZX0KICBpbnB1dC50aXRsZTo6cGxhY2Vob2xkZXJ7Y29sb3I6dmFyKC0tbXV0Mil9CiAgc2VsZWN0e2JhY2tncm91bmQ6dmFyKC0tY2FyZEhpKTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjEwcHggMTRweDtmb250LXNpemU6MTRweDtjdXJzb3I6cG9pbnRlcn0KICAuY3Rhe2JhY2tncm91bmQ6dmFyKC0tZ29sZCk7Y29sb3I6IzIwMTgwYTtib3JkZXI6bm9uZTtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzoxM3B4IDI2cHg7Zm9udC1zaXplOjE0LjVweDtmb250LXdlaWdodDo3MDA7Y3Vyc29yOnBvaW50ZXJ9CiAgLmN0YVtkaXNhYmxlZF17YmFja2dyb3VuZDp2YXIoLS1jYXJkSGkpO2NvbG9yOnZhcigtLW11dDIpO2N1cnNvcjpub3QtYWxsb3dlZH0KICAuaHJ7aGVpZ2h0OjFweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpfQogIC5ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMzAwcHgsMWZyKSk7Z2FwOjE2cHh9CiAgLnJje2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjEycHh9CiAgLnJjLnNlZW57Ym9yZGVyLWNvbG9yOnJnYmEoMjMyLDE4MCw3NCwuMjgpfQogIC5raWNrZXJ7Zm9udC1zaXplOjEwcHg7bGV0dGVyLXNwYWNpbmc6LjEyZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLWdvbGQpfQogIC5ydC10aXRsZXtmb250LWZhbWlseTp1aS1zZXJpZixHZW9yZ2lhLHNlcmlmO2ZvbnQtc2l6ZToyMnB4O2xpbmUtaGVpZ2h0OjEuMTU7Zm9udC13ZWlnaHQ6NjAwfQogIC5yZWFzb257Zm9udC1zaXplOjEzLjVweDtsaW5lLWhlaWdodDoxLjU7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tdG9wOjZweH0KICAud3JpdGV1cHtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU1O2NvbG9yOnZhcigtLW11dCl9CiAgLnRyYWlsZXJ7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2NvbG9yOnZhcigtLWdvbGQpO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NXB4IDEycHg7Zm9udC1zaXplOjEyLjVweDtjdXJzb3I6cG9pbnRlcjttYXJnaW4tdG9wOjEwcHh9CiAgLnRyYWlsZXI6aG92ZXJ7YmFja2dyb3VuZDpyZ2JhKDIzMiwxODAsNzQsLjA4KX0KICAudG1vZGFse2Rpc3BsYXk6bm9uZTtwb3NpdGlvbjpmaXhlZDtpbnNldDowO2JhY2tncm91bmQ6cmdiYSg2LDgsMTEsLjg1KTt6LWluZGV4OjEwMDA7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7cGFkZGluZzoyMHB4fQogIC50bW9kYWwub3BlbntkaXNwbGF5OmZsZXh9CiAgLnRtYm94e3dpZHRoOjEwMCU7bWF4LXdpZHRoOjgyMHB4fQogIC50bWNsb3Nle2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjZweCAxNHB4O2ZvbnQtc2l6ZToxM3B4O2N1cnNvcjpwb2ludGVyO21hcmdpbi1ib3R0b206MTBweH0KICAudG1jbG9zZTpob3ZlcntiYWNrZ3JvdW5kOnZhcigtLWNhcmQpfQogIC50bWZyYW1le3Bvc2l0aW9uOnJlbGF0aXZlO3BhZGRpbmctYm90dG9tOjU2LjI1JTtoZWlnaHQ6MDtib3JkZXItcmFkaXVzOjEycHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzAwMDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpfQogIC50bWZyYW1lIGlmcmFtZXtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7Ym9yZGVyOjB9CiAgLnZyb3d7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxMHB4fQogIC52dGh1bWJ7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtwYWRkaW5nOjA7Y3Vyc29yOnBvaW50ZXI7d2lkdGg6MTMycHg7dGV4dC1hbGlnbjpsZWZ0fQogIC52dGh1bWItaW1ne3Bvc2l0aW9uOnJlbGF0aXZlO2Rpc3BsYXk6YmxvY2s7d2lkdGg6MTMycHg7aGVpZ2h0Ojc0cHg7Ym9yZGVyLXJhZGl1czo4cHg7YmFja2dyb3VuZC1zaXplOmNvdmVyO2JhY2tncm91bmQtcG9zaXRpb246Y2VudGVyO2JhY2tncm91bmQtY29sb3I6IzAwMDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpfQogIC52cGxheXtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjb2xvcjojZmZmO2ZvbnQtc2l6ZToxNXB4O2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuMzApO2JvcmRlci1yYWRpdXM6OHB4fQogIC52dGh1bWI6aG92ZXIgLnZwbGF5e2JhY2tncm91bmQ6cmdiYSgwLDAsMCwuMTIpfQogIC52Y2Fwe2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLW11dCk7bWFyZ2luLXRvcDo1cHg7bGluZS1oZWlnaHQ6MS4zO292ZXJmbG93OmhpZGRlbjtkaXNwbGF5Oi13ZWJraXQtYm94Oy13ZWJraXQtbGluZS1jbGFtcDoyOy13ZWJraXQtYm94LW9yaWVudDp2ZXJ0aWNhbH0KICAuc3Zjcm93e2Rpc3BsYXk6ZmxleDtnYXA6OHB4O2FsaWduLWl0ZW1zOmNlbnRlcjtmbGV4LXdyYXA6d3JhcH0KICAuc3ZjaWNvbntkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO21pbi13aWR0aDozNHB4O2hlaWdodDoyNnB4O3BhZGRpbmc6MCA4cHg7Ym9yZGVyLXJhZGl1czo3cHg7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6ODAwO2xldHRlci1zcGFjaW5nOi4wMmVtO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7YmFja2dyb3VuZDp2YXIoLS1jYXJkSGkpO2NvbG9yOnZhcigtLW11dDIpfQogIC5zdmNpY29uLm9mZntvcGFjaXR5Oi4zODtmaWx0ZXI6Z3JheXNjYWxlKDEpfQogIGE6aG92ZXIgLnN2Y2ljb257ZmlsdGVyOmJyaWdodG5lc3MoMS4wOCl9CiAgLmhlYWR7ZGlzcGxheTpmbGV4O2dhcDoxNHB4O2FsaWduLWl0ZW1zOmZsZXgtc3RhcnR9CiAgLmhlYWRtZXRhe21pbi13aWR0aDowO2ZsZXg6MX0KICAucG9zdGVye3dpZHRoOjcycHg7aGVpZ2h0OjEwOHB4O2JvcmRlci1yYWRpdXM6OHB4O29iamVjdC1maXQ6Y292ZXI7YmFja2dyb3VuZDp2YXIoLS1jYXJkSGkpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7ZmxleDpub25lO2Rpc3BsYXk6YmxvY2t9CiAgLnBvc3Rlci5waHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjlweDt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjA2ZW07dGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzo0cHh9CiAgLnNjb3Jlc3tkaXNwbGF5OmZsZXg7Z2FwOjE2cHh9CiAgLnNje2ZsZXg6MTttaW4td2lkdGg6MH0KICAuc2MgLmxhYntmb250LXNpemU6MTBweDtsZXR0ZXItc3BhY2luZzouMDhlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLWJvdHRvbTo0cHh9CiAgLnNjIC52YWx7Zm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLE1lbmxvLG1vbm9zcGFjZTtmb250LXNpemU6MjBweDtmb250LXdlaWdodDo2MDA7bGluZS1oZWlnaHQ6MX0KICAubWV0ZXJ7aGVpZ2h0OjNweDtib3JkZXItcmFkaXVzOjJweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpO21hcmdpbi10b3A6OHB4O292ZXJmbG93OmhpZGRlbn0KICAubWV0ZXI+aXtkaXNwbGF5OmJsb2NrO2hlaWdodDoxMDAlO2JvcmRlci1yYWRpdXM6MnB4fQogIC5sYWIye2ZvbnQtc2l6ZToxMHB4O2xldHRlci1zcGFjaW5nOi4wOGVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tYm90dG9tOjhweH0KICAuc3Zje2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo1cHg7Zm9udC1zaXplOjExLjVweDtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjRweCA5cHg7dGV4dC1kZWNvcmF0aW9uOm5vbmV9CiAgLnN2Yy5uZXR7Y29sb3I6I2JmZThjZjtiYWNrZ3JvdW5kOnJnYmEoNzksMTgwLDExOSwuMTQpO2JvcmRlcjoxcHggc29saWQgcmdiYSg3OSwxODAsMTE5LC4zNSl9CiAgLnN2Yy5wbGFpbntjb2xvcjp2YXIoLS1tdXQpO2JhY2tncm91bmQ6cmdiYSgxMzksMTQ3LDE2MCwuMDgpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSl9CiAgLnN2Yy5wbGFpbjpob3Zlcntjb2xvcjp2YXIoLS10ZXh0KX0KICAuc2VlbnJvd3tkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHh9CiAgLnJhdGV7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzo2cHggMTJweDtmb250LXNpemU6MTIuNXB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcn0KICAucmF0ZS51cHtiYWNrZ3JvdW5kOnJnYmEoNzksMTgwLDExOSwuMTApO2JvcmRlcjoxcHggc29saWQgcmdiYSg3OSwxODAsMTE5LC4zKTtjb2xvcjojYmZlOGNmfQogIC5yYXRlLmRvd257YmFja2dyb3VuZDpyZ2JhKDIyNCw4Nyw3NSwuMDgpO2JvcmRlcjoxcHggc29saWQgcmdiYSgyMjQsODcsNzUsLjI4KTtjb2xvcjojZWZiM2FkfQogIC53YXRjaGVkdGFne2ZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NjAwfQogIC51bmRve2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjEycHg7Y3Vyc29yOnBvaW50ZXI7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZTtwYWRkaW5nOjJweH0KICAudG9vbGJhcntkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjE4cHg7YWxpZ24taXRlbXM6ZmxleC1lbmQ7cGFkZGluZzoxNHB4IDE2cHg7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMnB4O21hcmdpbi1ib3R0b206MjBweH0KICAuc2Vne2Rpc3BsYXk6aW5saW5lLWZsZXg7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo5cHg7cGFkZGluZzozcHg7Z2FwOjJweH0KICAuc2VnIGJ1dHRvbntib3JkZXI6bm9uZTtjdXJzb3I6cG9pbnRlcjtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjZweCAxMnB4O2ZvbnQtc2l6ZToxMi41cHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjp2YXIoLS1tdXQpfQogIC5zZWcgYnV0dG9uLm9ue2JhY2tncm91bmQ6dmFyKC0tZ29sZCk7Y29sb3I6IzIwMTgwYTtmb250LXdlaWdodDo3MDB9CiAgLmdob3N0e2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6OHB4IDE2cHg7Zm9udC1zaXplOjEzcHg7Y3Vyc29yOnBvaW50ZXI7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjdweH0KICAuZG90e3dpZHRoOjZweDtoZWlnaHQ6NnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDp2YXIoLS1tdXQyKX0KICAubG9ncGFuZWx7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMnB4O3BhZGRpbmc6MTZweDttYXJnaW4tYm90dG9tOjIwcHh9CiAgLmxvZ2l0ZW17ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMHB4O3BhZGRpbmc6OXB4IDEycHh9CiAgLmZvb3R7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6MTBweH0KICAud2x7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2NvbG9yOnZhcigtLW11dCk7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzo3cHggMTJweDtmb250LXNpemU6MTIuNXB4O2N1cnNvcjpwb2ludGVyO3RleHQtYWxpZ246Y2VudGVyO3dpZHRoOjEwMCV9CiAgLndsOmhvdmVye2NvbG9yOnZhcigtLXRleHQpfQogIC53bC5vbntib3JkZXItY29sb3I6cmdiYSgyMzIsMTgwLDc0LC40KTtjb2xvcjp2YXIoLS1nb2xkKTtiYWNrZ3JvdW5kOnJnYmEoMjMyLDE4MCw3NCwuMDgpfQogIC53bHdyYXB7cG9zaXRpb246cmVsYXRpdmV9CiAgLmxtZW51e2Rpc3BsYXk6bm9uZTtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjRweDttYXJnaW4tdG9wOjZweDtwYWRkaW5nOjhweDtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjhweH0KICAubG1lbnUub3BlbntkaXNwbGF5OmZsZXh9CiAgLmxtaXtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Y29sb3I6dmFyKC0tbXV0KTtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjZweCAxMHB4O2ZvbnQtc2l6ZToxMi41cHg7Y3Vyc29yOnBvaW50ZXI7dGV4dC1hbGlnbjpsZWZ0fQogIC5sbWk6aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dCl9CiAgLmxtaS5vbntib3JkZXItY29sb3I6cmdiYSgyMzIsMTgwLDc0LC40KTtjb2xvcjp2YXIoLS1nb2xkKX0KICAubG1pLm5ld3tjb2xvcjp2YXIoLS1nb2xkKTtib3JkZXItc3R5bGU6ZGFzaGVkfQogIC50aW55YnRue2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjExLjVweDtjdXJzb3I6cG9pbnRlcjt0ZXh0LWRlY29yYXRpb246dW5kZXJsaW5lO3BhZGRpbmc6MnB4IDRweH0KICAudGlueWJ0bjpob3Zlcntjb2xvcjp2YXIoLS10ZXh0KX0KICAubm90ZXtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjY7bWFyZ2luLXRvcDoyNnB4O21heC13aWR0aDo2NDBweH0KICBhLmxpbmt7Y29sb3I6dmFyKC0tZ29sZCk7dGV4dC1kZWNvcmF0aW9uOm5vbmU7Zm9udC1zaXplOjEyLjVweH0KICBidXR0b246Zm9jdXMtdmlzaWJsZSxpbnB1dDpmb2N1cy12aXNpYmxlLHNlbGVjdDpmb2N1cy12aXNpYmxlLC5zZWcgYnV0dG9uOmZvY3VzLXZpc2libGV7b3V0bGluZToycHggc29saWQgdmFyKC0tZ29sZCk7b3V0bGluZS1vZmZzZXQ6MnB4fQogIEBrZXlmcmFtZXMgcHswJSwxMDAle29wYWNpdHk6LjQ1fTUwJXtvcGFjaXR5Oi44fX0gLmxvYWR7YW5pbWF0aW9uOnAgMS40cyBlYXNlLWluLW91dCBpbmZpbml0ZX0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0id3JhcCI+CiAgPGRpdiBpZD0ic3RhdHVzIiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbjowIDAgMThweDtwYWRkaW5nOjEwcHggMTRweDtib3JkZXItcmFkaXVzOjEwcHg7Zm9udC1zaXplOjEzLjVweCI+PC9kaXY+CiAgPGRpdiBjbGFzcz0iZXllYnJvdyI+TmV0ZmxpeCB0YXN0ZS1tYXRjaGVyPC9kaXY+CiAgPGgxPldoYXQgbmV4dC48L2gxPgogIDxwIGNsYXNzPSJzdWIiPk5hbWUgYSBoYW5kZnVsIG9mIHRoaW5ncyB5b3Ugd2F0Y2hlZCBhbmQgbG92ZWQuIFJlYWwgSU1EYiAmYW1wOyBSb3R0ZW4gVG9tYXRvZXMgc2NvcmVzLCByZWFsIHJlZ2lvbmFsIGF2YWlsYWJpbGl0eSwgZGVlcCBsaW5rcyB0byB3aGVyZSBpdCBzdHJlYW1zIOKAlCBhbmQgaXQgbGVhcm5zIGZyb20gd2hhdCB5b3UgcmF0ZS48L3A+CgogIDxkaXYgaWQ9ImlucHV0IiBzdHlsZT0ibWFyZ2luLXRvcDozMHB4IiBjbGFzcz0icGFuZWwiPgogICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmJhc2VsaW5lO21hcmdpbi1ib3R0b206MTJweCI+CiAgICAgIDxsYWJlbCBzdHlsZT0iZm9udC1zaXplOjEzcHg7Zm9udC13ZWlnaHQ6NjAwIj5UaGluZ3MgeW91IGxvdmVkPC9sYWJlbD4KICAgICAgPHNwYW4gaWQ9ImNvdW50IiBzdHlsZT0iZm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLG1vbm9zcGFjZTtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQyKSI+MCAvIDEwPC9zcGFuPgogICAgPC9kaXY+CiAgICA8ZGl2IGlkPSJjaGlwcyIgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi1ib3R0b206MTRweCI+CiAgICAgIDxpbnB1dCBjbGFzcz0idGl0bGUiIGlkPSJkcmFmdCIgcGxhY2Vob2xkZXI9IlR5cGUgYSB0aXRsZSwgcHJlc3MgRW50ZXIiIC8+CiAgICA8L2Rpdj4KICAgIDxidXR0b24gaWQ9ImV4YW1wbGUiIHN0eWxlPSJiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tZ29sZCk7Zm9udC1zaXplOjEyLjVweDtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjAgMCA4cHgiPk5lZWQgYSBzcGFyaz8gTG9hZCBhbiBleGFtcGxlIOKGkjwvYnV0dG9uPgogICAgPGRpdiBjbGFzcz0iaHIiIHN0eWxlPSJtYXJnaW46NnB4IDAgMThweCI+PC9kaXY+CiAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjE2cHg7YWxpZ24taXRlbXM6ZmxleC1lbmQ7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW4iPgogICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjE2cHgiPgogICAgICAgIDxkaXY+CiAgICAgICAgICA8bGFiZWwgZm9yPSJyZWdpb24iIHN0eWxlPSJkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCk7bWFyZ2luLWJvdHRvbTo3cHgiPldhdGNoaW5nIGZyb208L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBpZD0icmVnaW9uIj48L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGZvcj0idHlwZSIgc3R5bGU9ImRpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tYm90dG9tOjdweCI+U2hvdyBtZTwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJ0eXBlIj48L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGZvcj0iZ2VucmUiIHN0eWxlPSJkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCk7bWFyZ2luLWJvdHRvbTo3cHgiPkdlbnJlPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImdlbnJlIj48L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gaWQ9ImdvIiBjbGFzcz0iY3RhIiBkaXNhYmxlZD5GaW5kIG15IG5leHQgd2F0Y2g8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0iaGludCIgc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi10b3A6MTJweCI+QWRkIGF0IGxlYXN0IDMgdGl0bGVzIGZvciBhIGdvb2QgcmVhZCBvbiB5b3VyIHRhc3RlLjwvZGl2PgogICAgPGRpdiBpZD0iaW5wdXRsb2ciPjwvZGl2PgogIDwvZGl2PgoKICA8ZGl2IGlkPSJyZXN1bHRzIiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6MzBweCI+PC9kaXY+CiAgPGRpdiBpZD0idG1vZGFsIiBjbGFzcz0idG1vZGFsIiBvbmNsaWNrPSJpZihldmVudC50YXJnZXQ9PT10aGlzKWNsb3NlVHJhaWxlcigpIj48ZGl2IGNsYXNzPSJ0bWJveCI+PGJ1dHRvbiBjbGFzcz0idG1jbG9zZSIgb25jbGljaz0iY2xvc2VUcmFpbGVyKCkiPuKclSBDbG9zZTwvYnV0dG9uPjxkaXYgY2xhc3M9InRtZnJhbWUiPjxpZnJhbWUgaWQ9InRmcmFtZSIgYWxsb3c9ImF1dG9wbGF5OyBlbmNyeXB0ZWQtbWVkaWE7IGZ1bGxzY3JlZW4iIGFsbG93ZnVsbHNjcmVlbj48L2lmcmFtZT48L2Rpdj48L2Rpdj48L2Rpdj4KPC9kaXY+Cgo8c2NyaXB0Pgp3aW5kb3cub25lcnJvcj1mdW5jdGlvbihtKXt2YXIgcz1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic3RhdHVzIik7aWYocyl7cy5zdHlsZS5kaXNwbGF5PSJibG9jayI7cy5zdHlsZS5iYWNrZ3JvdW5kPSIjNWIxYTFhIjtzLnN0eWxlLmJvcmRlcj0iMXB4IHNvbGlkICNhMzMiO3Muc3R5bGUuY29sb3I9IiNmZmQ5ZDQiO3MudGV4dENvbnRlbnQ9IlByb2JsZW0gc3RhcnRpbmcgdGhlIGFwcDogIittO31yZXR1cm4gZmFsc2U7fTsKCmNvbnN0IFJFR0lPTlM9W1siemEiLCJTb3V0aCBBZnJpY2EiXSxbInVzIiwiVW5pdGVkIFN0YXRlcyJdLFsiZ2IiLCJVbml0ZWQgS2luZ2RvbSJdLFsiY2EiLCJDYW5hZGEiXSxbImF1IiwiQXVzdHJhbGlhIl0sWyJpbiIsIkluZGlhIl0sWyJuZyIsIk5pZ2VyaWEiXSxbImtlIiwiS2VueWEiXSxbImRlIiwiR2VybWFueSJdLFsiZnIiLCJGcmFuY2UiXSxbImVzIiwiU3BhaW4iXSxbImJyIiwiQnJhemlsIl0sWyJteCIsIk1leGljbyJdLFsianAiLCJKYXBhbiJdLFsia3IiLCJTb3V0aCBLb3JlYSJdXTsKY29uc3QgRVhBTVBMRT1bIkRhcmsiLCJUaGUgQmVhciIsIkJyZWFraW5nIEJhZCIsIlBhcmFzaXRlIiwiRmxlYWJhZyJdOwpsZXQgc2hvd3M9W10sIGRhdGE9bnVsbCwgd2F0Y2hlZE1hcD17fSwgd2F0Y2hsaXN0cz17fSwgc2hvd0xvZz1mYWxzZSwgc2hvd0xpc3Q9ZmFsc2U7CmxldCBsb2FkaW5nTW9yZT1mYWxzZSwgZXhoYXVzdGVkPWZhbHNlLCBpbz1udWxsOwpsZXQgZmlsdGVycz17dHlwZToiYWxsIixtaW46MCxuZXQ6ZmFsc2Usc29ydDoibWF0Y2gifTsKCmNvbnN0ICQ9cz0+ZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzKTsKY29uc3QgbnJtPXM9PlN0cmluZyhzfHwiIikudHJpbSgpLnRvTG93ZXJDYXNlKCk7CmNvbnN0IGVzYz1zPT5TdHJpbmcocykucmVwbGFjZSgvWyY8PiJdL2csYz0+KHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsifVtjXSkpOwpjb25zdCB3YXRjaGVkQ291bnQ9KCk9Pk9iamVjdC5rZXlzKHdhdGNoZWRNYXApLmxlbmd0aDsKCmNvbnN0IHJlZ2lvblNlbD0kKCIjcmVnaW9uIik7ClJFR0lPTlMuZm9yRWFjaCgoW2Msbl0pPT57Y29uc3Qgbz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJvcHRpb24iKTtvLnZhbHVlPWM7by50ZXh0Q29udGVudD1uO3JlZ2lvblNlbC5hcHBlbmRDaGlsZChvKTt9KTsKY29uc3QgVFlQRVM9W1siIiwiTW92aWVzICYgc2VyaWVzIl0sWyJtb3ZpZSIsIk1vdmllcyBvbmx5Il0sWyJzZXJpZXMiLCJTZXJpZXMgb25seSJdXTsKY29uc3QgR0VOUkVTPVsiQW55IiwiQWN0aW9uIiwiQWR2ZW50dXJlIiwiQW5pbWF0aW9uIiwiQ29tZWR5IiwiQ3JpbWUiLCJEb2N1bWVudGFyeSIsIkRyYW1hIiwiRmFudGFzeSIsIkhvcnJvciIsIk15c3RlcnkiLCJSb21hbmNlIiwiU2NpLUZpIiwiVGhyaWxsZXIiXTsKY29uc3QgdHlwZVNlbD0kKCIjdHlwZSIpOyBUWVBFUy5mb3JFYWNoKChbdixuXSk9Pntjb25zdCBvPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoIm9wdGlvbiIpO28udmFsdWU9djtvLnRleHRDb250ZW50PW47dHlwZVNlbC5hcHBlbmRDaGlsZChvKTt9KTsKY29uc3QgZ2VucmVTZWw9JCgiI2dlbnJlIik7IEdFTlJFUy5mb3JFYWNoKGc9Pntjb25zdCBvPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoIm9wdGlvbiIpO28udmFsdWU9ZztvLnRleHRDb250ZW50PShnPT09IkFueSI/IkFueSBnZW5yZSI6Zyk7Z2VucmVTZWwuYXBwZW5kQ2hpbGQobyk7fSk7CgpmdW5jdGlvbiBzY29yZUNvbG9yKHApe2lmKHA9PW51bGx8fGlzTmFOKHApKXJldHVybiJ2YXIoLS1tdXQyKSI7aWYocD49NzUpcmV0dXJuInZhcigtLWdvb2QpIjtpZihwPj01MClyZXR1cm4idmFyKC0tbWlkKSI7cmV0dXJuInZhcigtLWJhZCkiO30KCi8vIC0tLS0gd2F0Y2ggaGlzdG9yeSAoc2F2ZWQgaW4gdGhpcyBicm93c2VyIHZpYSBsb2NhbFN0b3JhZ2UpIC0tLS0KY29uc3QgTFNfS0VZPSJ3bl93YXRjaGxvZyI7CmZ1bmN0aW9uIHBlcnNpc3RXYXRjaGVkKCl7dHJ5e2xvY2FsU3RvcmFnZS5zZXRJdGVtKExTX0tFWSxKU09OLnN0cmluZ2lmeSh3YXRjaGVkTWFwKSk7fWNhdGNoKGUpe319CmZ1bmN0aW9uIGxvYWRXYXRjaGVkKCl7CiAgdHJ5e2NvbnN0IHJhdz1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShMU19LRVkpO3dhdGNoZWRNYXA9cmF3PyhKU09OLnBhcnNlKHJhdyl8fHt9KTp7fTt9Y2F0Y2goZSl7d2F0Y2hlZE1hcD17fTt9CiAgcmVuZGVySW5wdXRMb2coKTsKfQpmdW5jdGlvbiBtYXJrV2F0Y2hlZChyZWMsbGlrZWQscmVtb3ZlVGlsZSl7CiAgd2F0Y2hlZE1hcFtucm0ocmVjLnRpdGxlKV09e3RpdGxlOnJlYy50aXRsZSx5ZWFyOnJlYy55ZWFyLHR5cGU6cmVjLnR5cGUsbGlrZWQsdHM6RGF0ZS5ub3coKX07CiAgcGVyc2lzdFdhdGNoZWQoKTsKICBpZihyZW1vdmVUaWxlJiZkYXRhJiZkYXRhLnJlc3VsdHMpZGF0YS5yZXN1bHRzPWRhdGEucmVzdWx0cy5maWx0ZXIoeD0+bnJtKHgudGl0bGUpIT09bnJtKHJlYy50aXRsZSkpOwogIGlmKGRhdGEpcmVuZGVyKCk7IHJlbmRlcklucHV0TG9nKCk7Cn0KZnVuY3Rpb24gcmVtb3ZlV2F0Y2hlZChpZCl7CiAgZGVsZXRlIHdhdGNoZWRNYXBbaWRdOyBwZXJzaXN0V2F0Y2hlZCgpOyBpZihkYXRhKXJlbmRlcigpOyByZW5kZXJJbnB1dExvZygpOwp9CmNvbnN0IExTX0xJU1RTPSJ3bl93YXRjaGxpc3RzIjsKZnVuY3Rpb24gcGVyc2lzdFdhdGNobGlzdHMoKXt0cnl7bG9jYWxTdG9yYWdlLnNldEl0ZW0oTFNfTElTVFMsSlNPTi5zdHJpbmdpZnkod2F0Y2hsaXN0cykpO31jYXRjaChlKXt9fQpmdW5jdGlvbiBsb2FkV2F0Y2hsaXN0cygpewogIHRyeXsKICAgIGNvbnN0IHJhdz1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShMU19MSVNUUyk7CiAgICBpZihyYXcpe3dhdGNobGlzdHM9SlNPTi5wYXJzZShyYXcpfHx7fTtyZXR1cm47fQogICAgY29uc3Qgb2xkPWxvY2FsU3RvcmFnZS5nZXRJdGVtKCJ3bl93YXRjaGxpc3QiKTsKICAgIGlmKG9sZCl7Y29uc3QgaXRlbXM9SlNPTi5wYXJzZShvbGQpfHx7fTtjb25zdCBpZD0ibCIrRGF0ZS5ub3coKTt3YXRjaGxpc3RzPXtbaWRdOntpZDppZCxuYW1lOiJNeSBXYXRjaGxpc3QiLGl0ZW1zOml0ZW1zLHRzOkRhdGUubm93KCl9fTtwZXJzaXN0V2F0Y2hsaXN0cygpO3JldHVybjt9CiAgICB3YXRjaGxpc3RzPXt9OwogIH1jYXRjaChlKXt3YXRjaGxpc3RzPXt9O30KfQpmdW5jdGlvbiBsaXN0Q291bnQoKXtyZXR1cm4gT2JqZWN0LmtleXMod2F0Y2hsaXN0cykubGVuZ3RoO30KZnVuY3Rpb24gbmV3TGlzdChuYW1lKXtjb25zdCBubT0obmFtZXx8IiIpLnRyaW0oKTtpZighbm0pcmV0dXJuIG51bGw7Y29uc3QgaWQ9ImwiK0RhdGUubm93KCkrTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKjEwMDApO3dhdGNobGlzdHNbaWRdPXtpZDppZCxuYW1lOm5tLGl0ZW1zOnt9LHRzOkRhdGUubm93KCl9O3BlcnNpc3RXYXRjaGxpc3RzKCk7cmV0dXJuIGlkO30KZnVuY3Rpb24gcmVuYW1lTGlzdChpZCxuYW1lKXtjb25zdCBubT0obmFtZXx8IiIpLnRyaW0oKTtpZih3YXRjaGxpc3RzW2lkXSYmbm0pe3dhdGNobGlzdHNbaWRdLm5hbWU9bm07cGVyc2lzdFdhdGNobGlzdHMoKTt9fQpmdW5jdGlvbiBkZWxldGVMaXN0KGlkKXtkZWxldGUgd2F0Y2hsaXN0c1tpZF07cGVyc2lzdFdhdGNobGlzdHMoKTtpZihkYXRhKXJlbmRlcigpO3JlbmRlcklucHV0TG9nKCk7fQpmdW5jdGlvbiB0aXRsZUluTGlzdChsaXN0SWQsdGl0bGVJZCl7cmV0dXJuICEhKHdhdGNobGlzdHNbbGlzdElkXSYmd2F0Y2hsaXN0c1tsaXN0SWRdLml0ZW1zJiZ3YXRjaGxpc3RzW2xpc3RJZF0uaXRlbXNbdGl0bGVJZF0pO30KZnVuY3Rpb24gbGlzdHNGb3JUaXRsZSh0aXRsZUlkKXtyZXR1cm4gT2JqZWN0LnZhbHVlcyh3YXRjaGxpc3RzKS5maWx0ZXIobD0+bC5pdGVtcyYmbC5pdGVtc1t0aXRsZUlkXSkubWFwKGw9PmwuaWQpO30KZnVuY3Rpb24gdG9nZ2xlVGl0bGVJbkxpc3QobGlzdElkLHJlYyl7Y29uc3QgaWQ9bnJtKHJlYy50aXRsZSk7Y29uc3QgTD13YXRjaGxpc3RzW2xpc3RJZF07aWYoIUwpcmV0dXJuO2lmKCFMLml0ZW1zKUwuaXRlbXM9e307aWYoTC5pdGVtc1tpZF0pZGVsZXRlIEwuaXRlbXNbaWRdO2Vsc2UgTC5pdGVtc1tpZF09e3RpdGxlOnJlYy50aXRsZSx5ZWFyOnJlYy55ZWFyLHR5cGU6cmVjLnR5cGUsdHM6RGF0ZS5ub3coKX07cGVyc2lzdFdhdGNobGlzdHMoKTtpZihkYXRhKXJlbmRlcigpO3JlbmRlcklucHV0TG9nKCk7fQpmdW5jdGlvbiByZW1vdmVJdGVtRnJvbUxpc3QobGlzdElkLHRpdGxlSWQpe2NvbnN0IEw9d2F0Y2hsaXN0c1tsaXN0SWRdO2lmKEwmJkwuaXRlbXMpZGVsZXRlIEwuaXRlbXNbdGl0bGVJZF07cGVyc2lzdFdhdGNobGlzdHMoKTtpZihkYXRhKXJlbmRlcigpO3JlbmRlcklucHV0TG9nKCk7fQpmdW5jdGlvbiBjcmVhdGVMaXN0UHJvbXB0KCl7Y29uc3Qgbm09d2luZG93LnByb21wdCgiTmFtZSB5b3VyIG5ldyBsaXN0IChlLmcuIENvbWVkeSwgRGF0ZSBuaWdodCk6Iik7aWYobm0mJm5tLnRyaW0oKSl7bmV3TGlzdChubSk7aWYoZGF0YSlyZW5kZXIoKTtyZW5kZXJJbnB1dExvZygpO319CmZ1bmN0aW9uIG5ld0xpc3RGb3JDYXJkKHJlYyl7Y29uc3Qgbm09d2luZG93LnByb21wdCgiTmFtZSB5b3VyIG5ldyBsaXN0IChlLmcuIENvbWVkeSwgRGF0ZSBuaWdodCk6Iik7aWYobm0mJm5tLnRyaW0oKSl7Y29uc3QgaWQ9bmV3TGlzdChubSk7aWYoaWQmJnJlYyl0b2dnbGVUaXRsZUluTGlzdChpZCxyZWMpO319CmZ1bmN0aW9uIHJlbmFtZUxpc3RQcm9tcHQoaWQpe2NvbnN0IGN1cj13YXRjaGxpc3RzW2lkXT93YXRjaGxpc3RzW2lkXS5uYW1lOiIiO2NvbnN0IG5tPXdpbmRvdy5wcm9tcHQoIlJlbmFtZSB0aGlzIGxpc3Q6IixjdXIpO2lmKG5tJiZubS50cmltKCkpe3JlbmFtZUxpc3QoaWQsbm0pO2lmKGRhdGEpcmVuZGVyKCk7cmVuZGVySW5wdXRMb2coKTt9fQpmdW5jdGlvbiBkZWxldGVMaXN0Q29uZmlybShpZCl7Y29uc3QgTD13YXRjaGxpc3RzW2lkXTtpZighTClyZXR1cm47aWYod2luZG93LmNvbmZpcm0oJ0RlbGV0ZSB0aGUgbGlzdCAiJytMLm5hbWUrJyI/IFRoZSB0aXRsZXMgaW4gaXQgd2lsbCBiZSByZW1vdmVkIGZyb20gdGhpcyBsaXN0LicpKWRlbGV0ZUxpc3QoaWQpO30KZnVuY3Rpb24gbGlzdEJ1dHRvbkhUTUwoKXtjb25zdCBjPWxpc3RDb3VudCgpO3JldHVybiAnPGJ1dHRvbiBjbGFzcz0iZ2hvc3QiIGlkPSJsaXN0YnRuIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDonKyhjPyd2YXIoLS1nb2xkKSc6J3ZhcigtLW11dDIpJykrJyI+PC9zcGFuPk15IGxpc3RzICcrKGM/JygnK2MrJyknOicnKSsnICcrKHNob3dMaXN0PyfilrQnOifilr4nKSsnPC9idXR0b24+Jzt9CmZ1bmN0aW9uIHdhdGNobGlzdHNQYW5lbEhUTUwoKXsKICBjb25zdCBsaXN0cz1PYmplY3QudmFsdWVzKHdhdGNobGlzdHMpLnNvcnQoKGEsYik9PihhLnRzfHwwKS0oYi50c3x8MCkpOwogIGxldCBoPScnOwogIGlmKCFsaXN0cy5sZW5ndGgpaCs9JzxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2NvbG9yOnZhcigtLW11dDIpO3BhZGRpbmc6OHB4IDJweCI+WW91IGhhdmUgbm8gbGlzdHMgeWV0LiBDcmVhdGUgb25lLCB0aGVuIHVzZSAiQWRkIHRvIGxpc3QiIG9uIGFueSBzdWdnZXN0aW9uLjwvZGl2Pic7CiAgbGlzdHMuZm9yRWFjaChMPT57CiAgICBjb25zdCBpdGVtcz1PYmplY3QuZW50cmllcyhMLml0ZW1zfHx7fSkuc29ydCgoYSxiKT0+KGJbMV0udHN8fDApLShhWzFdLnRzfHwwKSk7CiAgICBoKz0nPGRpdiBzdHlsZT0ibWFyZ2luLWJvdHRvbToxNnB4Ij4nOwogICAgaCs9JzxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDttYXJnaW4tYm90dG9tOjhweCI+PHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS10ZXh0KSI+Jytlc2MoTC5uYW1lKSsnPC9zcGFuPjxzcGFuIHN0eWxlPSJmb250LXNpemU6MTEuNXB4O2NvbG9yOnZhcigtLW11dDIpIj4nK2l0ZW1zLmxlbmd0aCsnIHRpdGxlJysoaXRlbXMubGVuZ3RoPT09MT8nJzoncycpKyc8L3NwYW4+PGJ1dHRvbiBjbGFzcz0idGlueWJ0biIgZGF0YS1hY3Q9Imxpc3QtcmVuYW1lIiBkYXRhLWxpc3Q9IicrZXNjKEwuaWQpKyciIHN0eWxlPSJtYXJnaW4tbGVmdDphdXRvIj5yZW5hbWU8L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJ0aW55YnRuIiBkYXRhLWFjdD0ibGlzdC1kZWxldGUiIGRhdGEtbGlzdD0iJytlc2MoTC5pZCkrJyI+ZGVsZXRlPC9idXR0b24+PC9kaXY+JzsKICAgIGlmKCFpdGVtcy5sZW5ndGgpaCs9JzxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dDIpO3BhZGRpbmc6MnB4IDJweCA0cHgiPk5vIHRpdGxlcyB5ZXQuPC9kaXY+JzsKICAgIGVsc2UgaCs9aXRlbXMubWFwKChbaWQseF0pPT4nPGRpdiBjbGFzcz0ibG9naXRlbSI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tZ29sZCkiPjwvc3Bhbj48c3BhbiBzdHlsZT0iZm9udC1zaXplOjEzLjVweCI+Jytlc2MoeC50aXRsZSkrJzwvc3Bhbj48c3BhbiBzdHlsZT0iZm9udC1zaXplOjExLjVweDtjb2xvcjp2YXIoLS1tdXQyKSI+Jytlc2MoeC50eXBlfHwnJykrKHgueWVhcj8nIMK3ICcrZXNjKHgueWVhcik6JycpKyc8L3NwYW4+PGJ1dHRvbiBjbGFzcz0iY2hpcCIgZGF0YS1hY3Q9Iml0ZW0tcmVtb3ZlIiBkYXRhLWxpc3Q9IicrZXNjKEwuaWQpKyciIGRhdGEtaWQ9IicrZXNjKGlkKSsnIiBzdHlsZT0ibWFyZ2luLWxlZnQ6YXV0bztiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjpub25lO2NvbG9yOnZhcigtLW11dDIpO2ZvbnQtc2l6ZToxNXB4O3BhZGRpbmc6MCA0cHg7Y3Vyc29yOnBvaW50ZXIiPiZ0aW1lczs8L2J1dHRvbj48L2Rpdj4nKS5qb2luKCIiKTsKICAgIGgrPSc8L2Rpdj4nOwogIH0pOwogIGgrPSc8YnV0dG9uIGNsYXNzPSJ3bCIgZGF0YS1hY3Q9Imxpc3QtbmV3IiBzdHlsZT0ibWFyZ2luLXRvcDo0cHgiPisgTmV3IGxpc3Q8L2J1dHRvbj4nOwogIHJldHVybiBoOwp9CgpmdW5jdGlvbiBsb2dMaXN0SFRNTCgpewogIGNvbnN0IGl0ZW1zPU9iamVjdC5lbnRyaWVzKHdhdGNoZWRNYXApLnNvcnQoKGEsYik9PihiWzFdLnRzfHwwKS0oYVsxXS50c3x8MCkpOwogIGlmKCFpdGVtcy5sZW5ndGgpcmV0dXJuICc8ZGl2IHN0eWxlPSJmb250LXNpemU6MTNweDtjb2xvcjp2YXIoLS1tdXQyKTtwYWRkaW5nOjhweCAycHgiPk5vdGhpbmcgbG9nZ2VkIHlldC4gUmF0ZSBhIHN1Z2dlc3Rpb24gYW5kIGl0XCdsbCBzaGFwZSB3aGF0IGNvbWVzIG5leHQuPC9kaXY+JzsKICByZXR1cm4gaXRlbXMubWFwKChbaWQsd10pPT4nPGRpdiBjbGFzcz0ibG9naXRlbSI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6Jysody5saWtlZD8ndmFyKC0tZ29vZCknOncubGlrZWQ9PT1mYWxzZT8ndmFyKC0tYmFkKSc6J3ZhcigtLW11dDIpJykrJyI+PC9zcGFuPicKICAgICsnPHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMy41cHgiPicrZXNjKHcudGl0bGUpKyc8L3NwYW4+JwogICAgKyc8c3BhbiBzdHlsZT0iZm9udC1zaXplOjExLjVweDtjb2xvcjp2YXIoLS1tdXQyKSI+Jysody5saWtlZD8nTG92ZWQgaXQnOncubGlrZWQ9PT1mYWxzZT8nTm90IGZvciBtZSc6J1NlZW4nKSsnPC9zcGFuPicKICAgICsnPGJ1dHRvbiBjbGFzcz0iY2hpcCIgZGF0YS1hY3Q9InVud2F0Y2giIGRhdGEtaWQ9IicrZXNjKGlkKSsnIiBzdHlsZT0ibWFyZ2luLWxlZnQ6YXV0bztiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjpub25lO2NvbG9yOnZhcigtLW11dDIpO2ZvbnQtc2l6ZToxNXB4O3BhZGRpbmc6MCA0cHg7Y3Vyc29yOnBvaW50ZXIiPiZ0aW1lczs8L2J1dHRvbj48L2Rpdj4nKS5qb2luKCIiKTsKfQpmdW5jdGlvbiBsb2dCdXR0b25IVE1MKCl7CiAgY29uc3QgYz13YXRjaGVkQ291bnQoKTsKICByZXR1cm4gJzxidXR0b24gY2xhc3M9Imdob3N0IiBpZD0ibG9nYnRuIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDonKyhjPyd2YXIoLS1nb2xkKSc6J3ZhcigtLW11dDIpJykrJyI+PC9zcGFuPldhdGNoZWQgJysoYz8nKCcrYysnKSc6JycpKycgJysoc2hvd0xvZz8n4pa0Jzon4pa+JykrJzwvYnV0dG9uPic7Cn0KZnVuY3Rpb24gd2lyZUxvZ0NvbnRyb2xzKHNjb3BlKXsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9InVud2F0Y2giXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5yZW1vdmVXYXRjaGVkKGIuZGF0YXNldC5pZCkpOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0iaXRlbS1yZW1vdmUiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5yZW1vdmVJdGVtRnJvbUxpc3QoYi5kYXRhc2V0Lmxpc3QsYi5kYXRhc2V0LmlkKSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJsaXN0LXJlbmFtZSJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PnJlbmFtZUxpc3RQcm9tcHQoYi5kYXRhc2V0Lmxpc3QpKTsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Imxpc3QtZGVsZXRlIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+ZGVsZXRlTGlzdENvbmZpcm0oYi5kYXRhc2V0Lmxpc3QpKTsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Imxpc3QtbmV3Il0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+Y3JlYXRlTGlzdFByb21wdCgpKTsKICBjb25zdCBsYj1zY29wZS5xdWVyeVNlbGVjdG9yKCIjbG9nYnRuIik7IGlmKGxiKWxiLm9uY2xpY2s9KCk9PntzaG93TG9nPSFzaG93TG9nOyBpZihkYXRhKXJlbmRlcigpOyByZW5kZXJJbnB1dExvZygpO307CiAgY29uc3Qgd2I9c2NvcGUucXVlcnlTZWxlY3RvcigiI2xpc3RidG4iKTsgaWYod2Ipd2Iub25jbGljaz0oKT0+e3Nob3dMaXN0PSFzaG93TGlzdDsgaWYoZGF0YSlyZW5kZXIoKTsgcmVuZGVySW5wdXRMb2coKTt9Owp9CmZ1bmN0aW9uIHJlbmRlcklucHV0TG9nKCl7CiAgY29uc3QgYm94PSQoIiNpbnB1dGxvZyIpOwogIGlmKHdhdGNoZWRDb3VudCgpPT09MCYmbGlzdENvdW50KCk9PT0wKXtib3guaW5uZXJIVE1MPSIiO3JldHVybjt9CiAgbGV0IGg9JzxkaXYgY2xhc3M9ImhyIiBzdHlsZT0ibWFyZ2luOjIwcHggMCAxNnB4Ij48L2Rpdj48ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXAiPicrbGlzdEJ1dHRvbkhUTUwoKStsb2dCdXR0b25IVE1MKCkrJzwvZGl2Pic7CiAgaWYoc2hvd0xpc3QpaCs9JzxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+Jyt3YXRjaGxpc3RzUGFuZWxIVE1MKCkrJzwvZGl2Pic7CiAgaWYoc2hvd0xvZyloKz0nPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4nK2xvZ0xpc3RIVE1MKCkrJzwvZGl2Pic7CiAgYm94LmlubmVySFRNTD1oOwogIHdpcmVMb2dDb250cm9scyhib3gpOwp9CgovLyAtLS0tIGlucHV0IC0tLS0KZnVuY3Rpb24gcmVuZGVyQ2hpcHMoKXsKICBjb25zdCBib3g9JCgiI2NoaXBzIik7CiAgYm94LnF1ZXJ5U2VsZWN0b3JBbGwoIi5jaGlwIikuZm9yRWFjaChlPT5lLnJlbW92ZSgpKTsKICBjb25zdCBkcmFmdD0kKCIjZHJhZnQiKTsKICBzaG93cy5mb3JFYWNoKChzLGkpPT57CiAgICBjb25zdCBlbD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJzcGFuIik7ZWwuY2xhc3NOYW1lPSJjaGlwIjsKICAgIGVsLmlubmVySFRNTD1lc2MocykrJyA8YnV0dG9uIGFyaWEtbGFiZWw9IlJlbW92ZSI+JnRpbWVzOzwvYnV0dG9uPic7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCJidXR0b24iKS5vbmNsaWNrPSgpPT57c2hvd3Muc3BsaWNlKGksMSk7cmVuZGVyQ2hpcHMoKTt9OwogICAgYm94Lmluc2VydEJlZm9yZShlbCxkcmFmdCk7CiAgfSk7CiAgZHJhZnQuc3R5bGUuZGlzcGxheT1zaG93cy5sZW5ndGg+PTEwPyJub25lIjoiYmxvY2siOwogIGRyYWZ0LnBsYWNlaG9sZGVyPXNob3dzLmxlbmd0aD8iQWRkIGFub3RoZXLigKYiOiJUeXBlIGEgdGl0bGUsIHByZXNzIEVudGVyIjsKICAkKCIjY291bnQiKS50ZXh0Q29udGVudD1zaG93cy5sZW5ndGgrIiAvIDEwIjsKICAkKCIjY291bnQiKS5zdHlsZS5jb2xvcj1zaG93cy5sZW5ndGg+PTM/InZhcigtLWdvbGQpIjoidmFyKC0tbXV0MikiOwogIGNvbnN0IG9rPXNob3dzLmxlbmd0aD49MzsKICAkKCIjZ28iKS5kaXNhYmxlZD0hb2s7CiAgJCgiI2hpbnQiKS5zdHlsZS5kaXNwbGF5PW9rPyJub25lIjoiYmxvY2siOwogICQoIiNleGFtcGxlIikuc3R5bGUuZGlzcGxheT1zaG93cy5sZW5ndGg/Im5vbmUiOiJibG9jayI7Cn0KZnVuY3Rpb24gYWRkRHJhZnQoKXtjb25zdCBkPSQoIiNkcmFmdCIpO2xldCB2PWQudmFsdWUudHJpbSgpLnJlcGxhY2UoLywkLywiIikudHJpbSgpOwogIGlmKCF2KXJldHVybjtpZihzaG93cy5zb21lKHM9PnMudG9Mb3dlckNhc2UoKT09PXYudG9Mb3dlckNhc2UoKSkpe2QudmFsdWU9IiI7cmV0dXJuO30KICBpZihzaG93cy5sZW5ndGg8MTApc2hvd3MucHVzaCh2KTtkLnZhbHVlPSIiO3JlbmRlckNoaXBzKCk7fQokKCIjZHJhZnQiKS5hZGRFdmVudExpc3RlbmVyKCJrZXlkb3duIixlPT57CiAgaWYoZS5rZXk9PT0iRW50ZXIifHxlLmtleT09PSIsIil7ZS5wcmV2ZW50RGVmYXVsdCgpO2FkZERyYWZ0KCk7fQogIGVsc2UgaWYoZS5rZXk9PT0iQmFja3NwYWNlIiYmISQoIiNkcmFmdCIpLnZhbHVlJiZzaG93cy5sZW5ndGgpe3Nob3dzLnBvcCgpO3JlbmRlckNoaXBzKCk7fQp9KTsKJCgiI2V4YW1wbGUiKS5vbmNsaWNrPSgpPT57c2hvd3M9Wy4uLkVYQU1QTEVdO3JlbmRlckNoaXBzKCk7fTsKJCgiI2dvIikub25jbGljaz1kaXNjb3ZlcjsKCgphc3luYyBmdW5jdGlvbiByZWFkSnNvbihyLGZhbGxiYWNrTXNnKXsKICB2YXIgY3Q9ci5oZWFkZXJzLmdldCgiY29udGVudC10eXBlIil8fCIiOwogIGlmKGN0LmluZGV4T2YoImFwcGxpY2F0aW9uL2pzb24iKT09PS0xKXsKICAgIHZhciB0PShhd2FpdCByLnRleHQoKSkudHJpbSgpOwogICAgaWYodC5jaGFyQXQoMCk9PT0iPCIpIHRocm93IG5ldyBFcnJvcigiVGhlIHNlcnZlciBpcyB3YWtpbmcgdXAgXHUyMDE0IHRoZSBmcmVlIGhvc3RpbmcgcGxhbiBzbGVlcHMgYWZ0ZXIgMTUgbWludXRlcyBvZiBubyB1c2UuIFBsZWFzZSB3YWl0IHVwIHRvIGEgbWludXRlLCB0aGVuIHByZXNzIHRoZSBidXR0b24gYWdhaW4uIik7CiAgICB0aHJvdyBuZXcgRXJyb3IodC5zbGljZSgwLDIwMCl8fGZhbGxiYWNrTXNnfHwoIlJlcXVlc3QgZmFpbGVkICgiK3Iuc3RhdHVzKyIpIikpOwogIH0KICB2YXIgaj1hd2FpdCByLmpzb24oKTsKICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKGouZXJyb3J8fGZhbGxiYWNrTXNnfHwiUmVxdWVzdCBmYWlsZWQiKTsKICByZXR1cm4gajsKfQoKYXN5bmMgZnVuY3Rpb24gZGlzY292ZXIoKXsKICBjb25zdCByZXN1bHRzPSQoIiNyZXN1bHRzIiksIGlucHV0PSQoIiNpbnB1dCIpOwogIGlucHV0LnN0eWxlLmRpc3BsYXk9Im5vbmUiO3Jlc3VsdHMuc3R5bGUuZGlzcGxheT0iYmxvY2siO3Nob3dMb2c9ZmFsc2U7ZXhoYXVzdGVkPWZhbHNlO2xvYWRpbmdNb3JlPWZhbHNlOwogIHJlc3VsdHMuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJsb2FkIiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0KTt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjQwcHggMCI+UmVhZGluZyB5b3VyIHRhc3RlLCBwdWxsaW5nIHJlYWwgcmF0aW5ncyAmYW1wOyBhdmFpbGFiaWxpdHnigKY8L2Rpdj4nOwogIGZpbHRlcnM9e3R5cGU6ImFsbCIsbWluOjAsbmV0OmZhbHNlLHNvcnQ6Im1hdGNoIn07CiAgdHJ5ewogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9kaXNjb3ZlciIse21ldGhvZDoiUE9TVCIsaGVhZGVyczp7IkNvbnRlbnQtVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7bG92ZWQ6c2hvd3MsY291bnRyeTpyZWdpb25TZWwudmFsdWUsdHlwZTp0eXBlU2VsLnZhbHVlLGdlbnJlOmdlbnJlU2VsLnZhbHVlLHdhdGNoZWQ6d2F0Y2hlZE1hcH0pfSk7CiAgICBjb25zdCBqPWF3YWl0IHJlYWRKc29uKHIsIlJlcXVlc3QgZmFpbGVkIik7CiAgICBkYXRhPWo7cmVuZGVyKCk7CiAgfWNhdGNoKGUpewogICAgcmVzdWx0cy5pbm5lckhUTUw9JzxkaXYgY2xhc3M9InJjIiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXIiPjxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206MTRweCI+Jytlc2MoZS5tZXNzYWdlKSsnPC9kaXY+PGJ1dHRvbiBjbGFzcz0iY3RhIiBvbmNsaWNrPSJkaXNjb3ZlcigpIj5UcnkgYWdhaW48L2J1dHRvbj48L2Rpdj4nOwogIH0KfQoKZnVuY3Rpb24gb2JzZXJ2ZVNlbnRpbmVsKCl7CiAgaWYoaW8paW8uZGlzY29ubmVjdCgpOwogIGNvbnN0IGVsPSQoIiNzZW50aW5lbCIpOyBpZighZWwpcmV0dXJuOwogIGlvPW5ldyBJbnRlcnNlY3Rpb25PYnNlcnZlcihlcz0+eyBpZihlc1swXS5pc0ludGVyc2VjdGluZykgbG9hZE1vcmUoKTsgfSx7cm9vdE1hcmdpbjoiNTAwcHgifSk7CiAgaW8ub2JzZXJ2ZShlbCk7Cn0KYXN5bmMgZnVuY3Rpb24gbG9hZE1vcmUoKXsKICBpZihsb2FkaW5nTW9yZXx8ZXhoYXVzdGVkfHwhZGF0YSlyZXR1cm47CiAgbG9hZGluZ01vcmU9dHJ1ZTsgcmVuZGVyKCk7CiAgdHJ5ewogICAgY29uc3QgZXhjbHVkZT1kYXRhLnJlc3VsdHMubWFwKHg9PngudGl0bGUpOwogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9kaXNjb3ZlciIse21ldGhvZDoiUE9TVCIsaGVhZGVyczp7IkNvbnRlbnQtVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7bG92ZWQ6c2hvd3MsY291bnRyeTpyZWdpb25TZWwudmFsdWUsZXhjbHVkZSx0eXBlOnR5cGVTZWwudmFsdWUsZ2VucmU6Z2VucmVTZWwudmFsdWUsd2F0Y2hlZDp3YXRjaGVkTWFwfSl9KTsKICAgIGNvbnN0IGo9YXdhaXQgcmVhZEpzb24ociwiQ291bGRuJ3QgbG9hZCBtb3JlIik7CiAgICBjb25zdCBoYXZlPW5ldyBTZXQoZGF0YS5yZXN1bHRzLm1hcCh4PT5ucm0oeC50aXRsZSkpKTsKICAgIGNvbnN0IGFkZD0oai5yZXN1bHRzfHxbXSkuZmlsdGVyKHg9PiFoYXZlLmhhcyhucm0oeC50aXRsZSkpKTsKICAgIGlmKGFkZC5sZW5ndGg9PT0wKXtleGhhdXN0ZWQ9dHJ1ZTt9IGVsc2Uge2RhdGEucmVzdWx0cz1kYXRhLnJlc3VsdHMuY29uY2F0KGFkZCk7fQogIH1jYXRjaChlKXsgZXhoYXVzdGVkPXRydWU7IH0KICBsb2FkaW5nTW9yZT1mYWxzZTsgcmVuZGVyKCk7Cn0KCmZ1bmN0aW9uIG1ldGVyKHZhbCxwY3QsZGlzcCxsYWIpewogIHJldHVybiAnPGRpdiBjbGFzcz0ic2MiPjxkaXYgY2xhc3M9ImxhYiI+JytsYWIrJzwvZGl2PjxkaXYgY2xhc3M9InZhbCIgc3R5bGU9ImNvbG9yOicrKHZhbD09bnVsbD8idmFyKC0tbXV0MikiOiJ2YXIoLS10ZXh0KSIpKyciPicrZGlzcCsnPC9kaXY+PGRpdiBjbGFzcz0ibWV0ZXIiPjxpIHN0eWxlPSJ3aWR0aDonKyhwY3Q9PW51bGw/MDpNYXRoLm1heCgzLE1hdGgubWluKDEwMCxwY3QpKSkrJyU7YmFja2dyb3VuZDonK3Njb3JlQ29sb3IocGN0KSsnIj48L2k+PC9kaXY+PC9kaXY+JzsKfQoKZnVuY3Rpb24gdmlkc0hUTUwoeCl7CiAgaWYoIXgudmlkZW9zfHwheC52aWRlb3MubGVuZ3RoKXJldHVybiAnJzsKICB2YXIgdD14LnZpZGVvcy5zbGljZSgwLDgpLm1hcChmdW5jdGlvbih2KXtyZXR1cm4gJzxidXR0b24gY2xhc3M9InZ0aHVtYiIgZGF0YS1hY3Q9InRyYWlsZXIiIGRhdGEta2V5PSInK2VzYyh2LmtleSkrJyIgdGl0bGU9IicrZXNjKHYubmFtZXx8di50eXBlfHwnVmlkZW8nKSsnIj48c3BhbiBjbGFzcz0idnRodW1iLWltZyIgc3R5bGU9ImJhY2tncm91bmQtaW1hZ2U6dXJsKGh0dHBzOi8vaW1nLnlvdXR1YmUuY29tL3ZpLycrZXNjKHYua2V5KSsnL21xZGVmYXVsdC5qcGcpIj48c3BhbiBjbGFzcz0idnBsYXkiPuKWtjwvc3Bhbj48L3NwYW4+PHNwYW4gY2xhc3M9InZjYXAiPicrZXNjKHYubmFtZXx8di50eXBlfHwnVmlkZW8nKSsnPC9zcGFuPjwvYnV0dG9uPic7fSkuam9pbignJyk7CiAgcmV0dXJuICc8ZGl2IGNsYXNzPSJociI+PC9kaXY+PGRpdiBjbGFzcz0ibGFiMiI+VHJhaWxlcnMgJiB0ZWFzZXJzPC9kaXY+PGRpdiBjbGFzcz0idnJvdyI+Jyt0Kyc8L2Rpdj4nOwp9CmZ1bmN0aW9uIGNhcmQoeCl7CiAgY29uc3QgaWQ9bnJtKHgudGl0bGUpLCB3PXdhdGNoZWRNYXBbaWRdOwogIGNvbnN0IFNWQ1M9W3tpZDoibmV0ZmxpeCIscmU6L25ldGZsaXgvaSxsYWJlbDoiTmV0ZmxpeCIsbWFyazoiTiIsYmc6IiNFNTA5MTQiLGZnOiIjZmZmIn0se2lkOiJwcmltZSIscmU6L3ByaW1lfGFtYXpvbi9pLGxhYmVsOiJQcmltZSBWaWRlbyIsbWFyazoiUCIsYmc6IiMwMEE4RTEiLGZnOiIjMDAyNDNkIn0se2lkOiJkaXNuZXkiLHJlOi9kaXNuZXkvaSxsYWJlbDoiRGlzbmV5KyIsbWFyazoiRCsiLGJnOiIjMEMxQTZCIixmZzoiI2ZmZiJ9LHtpZDoiYXBwbGUiLHJlOi9hcHBsZS9pLGxhYmVsOiJBcHBsZSBUViIsbWFyazoiVFYiLGJnOiIjMTExIixmZzoiI2ZmZiJ9XTsKICBjb25zdCBzdmNzPXguc2VydmljZXN8fFtdOwogIGNvbnN0IGljb25zPVNWQ1MubWFwKGZ1bmN0aW9uKHN2KXt2YXIgaGl0PXN2Y3MuZmluZChmdW5jdGlvbihzKXtyZXR1cm4gcyYmKChzLmlkPT09c3YuaWQpfHwocy5uYW1lJiZzdi5yZS50ZXN0KHMubmFtZSkpKTt9KTt2YXIgb249ISFoaXQsbGluaz1oaXQmJmhpdC5saW5rO3ZhciBpYz0nPHNwYW4gY2xhc3M9InN2Y2ljb24nKyhvbj8nJzonIG9mZicpKyciJysob24/JyBzdHlsZT0iYmFja2dyb3VuZDonK3N2LmJnKyc7Y29sb3I6Jytzdi5mZysnO2JvcmRlci1jb2xvcjp0cmFuc3BhcmVudCInOicnKSsnIHRpdGxlPSInK3N2LmxhYmVsKyhvbj8nIOKAlCBhdmFpbGFibGUnOicg4oCUIG5vdCBhdmFpbGFibGUnKSsnIj4nK3N2Lm1hcmsrJzwvc3Bhbj4nO3JldHVybiAob24mJmxpbmspPyc8YSBocmVmPSInK2VzYyhsaW5rKSsnIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciIgc3R5bGU9InRleHQtZGVjb3JhdGlvbjpub25lIj4nK2ljKyc8L2E+JzppYzt9KS5qb2luKCIiKTsKICBjb25zdCBleHRyYT1zdmNzLmZpbHRlcihmdW5jdGlvbihzKXtyZXR1cm4gcyYmIVNWQ1Muc29tZShmdW5jdGlvbihzdil7cmV0dXJuIChzLmlkPT09c3YuaWQpfHwocy5uYW1lJiZzdi5yZS50ZXN0KHMubmFtZSkpO30pO30pOwogIHZhciByZm91bmQ9UkVHSU9OUy5maW5kKGZ1bmN0aW9uKHIpe3JldHVybiByWzBdPT09KHguY291bnRyeXx8IiIpLnRvTG93ZXJDYXNlKCk7fSk7CiAgdmFyIHJlZ2lvbk5hbWU9cmZvdW5kP3Jmb3VuZFsxXTooKHguY291bnRyeXx8IiIpLnRvVXBwZXJDYXNlKCkpOwogIHZhciB3YXRjaD0nPGRpdiBjbGFzcz0ibGFiMiI+V2hlcmUgdG8gd2F0Y2ggaW4gJytlc2MocmVnaW9uTmFtZSkrJzwvZGl2PjxkaXYgY2xhc3M9InN2Y3JvdyI+JytpY29ucysnPC9kaXY+JzsKICBpZihleHRyYS5sZW5ndGgpd2F0Y2grPSc8ZGl2IHN0eWxlPSJmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tdG9wOjhweCI+QWxzbyBvbiAnK2V4dHJhLnNsaWNlKDAsNCkubWFwKGZ1bmN0aW9uKHMpe3JldHVybiBlc2Mocy5uYW1lKTt9KS5qb2luKCIsICIpKyc8L2Rpdj4nOwogIGlmKCFzdmNzLmxlbmd0aCl3YXRjaCs9JzxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi10b3A6OHB4Ij5ObyBzdHJlYW1pbmcgaW5mbyBmb3IgJytlc2MocmVnaW9uTmFtZSkrJyByaWdodCBub3cuPC9kaXY+JzsKICBjb25zdCBpbkxpc3RzPWxpc3RzRm9yVGl0bGUoaWQpLCBvbkFueT1pbkxpc3RzLmxlbmd0aD4wOwogIGNvbnN0IG1lbnVSb3dzPU9iamVjdC52YWx1ZXMod2F0Y2hsaXN0cykuc29ydCgoYSxiKT0+KGEudHN8fDApLShiLnRzfHwwKSkubWFwKEw9Pic8YnV0dG9uIGNsYXNzPSJsbWknKyh0aXRsZUluTGlzdChMLmlkLGlkKT8nIG9uJzonJykrJyIgZGF0YS1hY3Q9InRvbGlzdCIgZGF0YS1saXN0PSInK2VzYyhMLmlkKSsnIiBkYXRhLWlkPSInK2VzYyhpZCkrJyI+JysodGl0bGVJbkxpc3QoTC5pZCxpZCk/J+KckyAnOicrICcpK2VzYyhMLm5hbWUpKyc8L2J1dHRvbj4nKS5qb2luKCIiKTsKICBjb25zdCBsaXN0QnRuPSc8ZGl2IGNsYXNzPSJ3bHdyYXAiPjxidXR0b24gY2xhc3M9IndsJysob25Bbnk/JyBvbic6JycpKyciIGRhdGEtYWN0PSJtZW51IiBkYXRhLWlkPSInK2VzYyhpZCkrJyI+Jysob25Bbnk/J+KckyBPbiB5b3VyIGxpc3RzIOKWvic6JysgQWRkIHRvIGxpc3Qg4pa+JykrJzwvYnV0dG9uPjxkaXYgY2xhc3M9ImxtZW51Ij4nK21lbnVSb3dzKyc8YnV0dG9uIGNsYXNzPSJsbWkgbmV3IiBkYXRhLWFjdD0ibmV3bGlzdCIgZGF0YS1pZD0iJytlc2MoaWQpKyciPisgTmV3IGxpc3TigKY8L2J1dHRvbj48L2Rpdj48L2Rpdj4nOwogIGxldCBzZWVuOwogIGlmKHcpewogICAgc2Vlbj0nPGRpdiBjbGFzcz0ic2VlbnJvdyIgc3R5bGU9Imp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuIj48c3BhbiBjbGFzcz0id2F0Y2hlZHRhZyIgc3R5bGU9ImNvbG9yOicrKHcubGlrZWQ/J3ZhcigtLWdvb2QpJzondmFyKC0tYmFkKScpKyciPuKckyBXYXRjaGVkIMK3ICcrKHcubGlrZWQ/J0xvdmVkIGl0JzonTm90IGZvciBtZScpKyc8L3NwYW4+JwogICAgICArJzxidXR0b24gY2xhc3M9InVuZG8iIGRhdGEtYWN0PSJ1bndhdGNoIiBkYXRhLWlkPSInK2VzYyhpZCkrJyI+dW5kbzwvYnV0dG9uPjwvZGl2Pic7CiAgfWVsc2V7CiAgICBzZWVuPSc8ZGl2IGNsYXNzPSJzZWVucm93Ij48c3BhbiBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLXJpZ2h0OmF1dG8iPlNlZW4gaXQ/PC9zcGFuPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJyYXRlIHVwIiBkYXRhLWFjdD0ibGlrZSIgZGF0YS1pZD0iJytlc2MoaWQpKyciPvCfkY0gTG92ZWQgaXQ8L2J1dHRvbj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0icmF0ZSBkb3duIiBkYXRhLWFjdD0iZGlzbGlrZSIgZGF0YS1pZD0iJytlc2MoaWQpKyciPvCfkY4gTm90IGZvciBtZTwvYnV0dG9uPjwvZGl2Pic7CiAgfQogIGNvbnN0IGZvb3Q9JzxkaXYgY2xhc3M9ImZvb3QiPicrbGlzdEJ0bitzZWVuKyc8L2Rpdj4nOwogIHJldHVybiAnPGRpdiBjbGFzcz0icmMnKyh3Pycgc2Vlbic6JycpKyciPjxkaXYgY2xhc3M9ImhlYWQiPicrKHgucG9zdGVyPyc8aW1nIGNsYXNzPSJwb3N0ZXIiIHNyYz0iJytlc2MoeC5wb3N0ZXIpKyciIGFsdD0iIiBsb2FkaW5nPSJsYXp5IiBvbmVycm9yPSJ0aGlzLnN0eWxlLmRpc3BsYXk9XCdub25lXCciPic6JzxkaXYgY2xhc3M9InBvc3RlciBwaCI+bm8gYXJ0d29yazwvZGl2PicpKyc8ZGl2IGNsYXNzPSJoZWFkbWV0YSI+PGRpdiBjbGFzcz0ia2lja2VyIj4nK2VzYyh4LnR5cGUpKyh4LnllYXI/JyDCtyAnK2VzYyh4LnllYXIpOicnKSsnPC9kaXY+PGRpdiBjbGFzcz0icnQtdGl0bGUiPicrZXNjKHgudGl0bGUpKyc8L2Rpdj48ZGl2IGNsYXNzPSJyZWFzb24iPicrZXNjKHgucmVhc29uKSsnPC9kaXY+PC9kaXY+PC9kaXY+JwogICAgKyh4Lm92ZXJ2aWV3Pyc8ZGl2IGNsYXNzPSJ3cml0ZXVwIj4nK2VzYyh4Lm92ZXJ2aWV3KSsnPC9kaXY+JzonJykKICAgICsnPGRpdiBjbGFzcz0iaHIiPjwvZGl2PjxkaXYgY2xhc3M9InNjb3JlcyI+JwogICAgKyBtZXRlcih4LmltZGIsIHguaW1kYiE9bnVsbD94LmltZGIqMTA6bnVsbCwgeC5pbWRiIT1udWxsP051bWJlcih4LmltZGIpLnRvRml4ZWQoMSk6IuKAlCIsIklNRGIiKQogICAgKyBtZXRlcih4LnJ0Q3JpdGljcywgeC5ydENyaXRpY3MsIHgucnRDcml0aWNzIT1udWxsP01hdGgucm91bmQoeC5ydENyaXRpY3MpKyIlIjoi4oCUIiwiUlQgQ3JpdGljcyIpCiAgICArIG1ldGVyKHgudG1kYiwgeC50bWRiIT1udWxsP3gudG1kYioxMDpudWxsLCB4LnRtZGIhPW51bGw/TnVtYmVyKHgudG1kYikudG9GaXhlZCgxKToi4oCUIiwiVE1EYiIpCiAgICArJzwvZGl2PjxkaXYgY2xhc3M9ImhyIj48L2Rpdj4nK3dhdGNoK3ZpZHNIVE1MKHgpKyc8ZGl2IGNsYXNzPSJociI+PC9kaXY+Jytmb290Kyc8L2Rpdj4nOwp9CgpmdW5jdGlvbiBzZWcobmFtZSxvcHRzLGN1cil7CiAgcmV0dXJuICc8ZGl2PjxkaXYgY2xhc3M9ImxhYjIiPicrbmFtZS5sYWJlbCsnPC9kaXY+PGRpdiBjbGFzcz0ic2VnIj4nK29wdHMubWFwKG89PgogICAgJzxidXR0b24gY2xhc3M9IicrKG8udj09PWN1cj8ib24iOiIiKSsnIiBkYXRhLWs9IicrbmFtZS5rZXkrJyIgZGF0YS12PSInK28udisnIj4nK28udCsnPC9idXR0b24+Jykuam9pbigiIikrJzwvZGl2PjwvZGl2Pic7Cn0KCmZ1bmN0aW9uIHJlbmRlcigpewogIGNvbnN0IHJlc3VsdHM9JCgiI3Jlc3VsdHMiKTsKICBsZXQgbGlzdD1kYXRhLnJlc3VsdHMuZmlsdGVyKHg9PnsKICAgIGlmKGZpbHRlcnMudHlwZSE9PSJhbGwiJiZ4LnR5cGUudG9Mb3dlckNhc2UoKSE9PWZpbHRlcnMudHlwZSlyZXR1cm4gZmFsc2U7CiAgICBpZihmaWx0ZXJzLm5ldCYmeC5vbk5ldGZsaXghPT10cnVlKXJldHVybiBmYWxzZTsKICAgIGlmKGZpbHRlcnMubWluPjAmJih4LmltZGI9PW51bGx8fE51bWJlcih4LmltZGIpPGZpbHRlcnMubWluKSlyZXR1cm4gZmFsc2U7CiAgICByZXR1cm4gdHJ1ZTsKICB9KTsKICBpZihmaWx0ZXJzLnNvcnQ9PT0iaW1kYiIpbGlzdD1bLi4ubGlzdF0uc29ydCgoYSxiKT0+KGIuaW1kYnx8LTEpLShhLmltZGJ8fC0xKSk7CiAgaWYoZmlsdGVycy5zb3J0PT09InJ0IilsaXN0PVsuLi5saXN0XS5zb3J0KChhLGIpPT4oYi5ydENyaXRpY3N8fC0xKS0oYS5ydENyaXRpY3N8fC0xKSk7CgogIGNvbnN0IGJhcj0nPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTJweDttYXJnaW4tYm90dG9tOjE4cHg7ZmxleC13cmFwOndyYXAiPicKICAgICsnPGJ1dHRvbiBjbGFzcz0iZ2hvc3QiIGlkPSJiYWNrIj7ihpAgU3RhcnQgb3ZlcjwvYnV0dG9uPicKICAgICsnPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTJweDtmbGV4LXdyYXA6d3JhcCI+PHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMi41cHg7Y29sb3I6dmFyKC0tbXV0KSI+TWF0Y2hlZCB0byAnK3Nob3dzLmxlbmd0aCsnIGxvdmVzIMK3IE5ldGZsaXggJytlc2MoZGF0YS5jb3VudHJ5TmFtZSkrJzwvc3Bhbj4nK2xpc3RCdXR0b25IVE1MKCkrbG9nQnV0dG9uSFRNTCgpKyc8L2Rpdj48L2Rpdj4nOwoKICBjb25zdCBwYW5lbD1zaG93TG9nPyc8ZGl2IGNsYXNzPSJsb2dwYW5lbCI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjExcHg7bGV0dGVyLXNwYWNpbmc6LjFlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLWJvdHRvbToxMnB4Ij5Zb3VyIHdhdGNoIGhpc3Rvcnkgwrcgc2hhcGVzIGV2ZXJ5IHN1Z2dlc3Rpb248L2Rpdj4nK2xvZ0xpc3RIVE1MKCkrJzwvZGl2Pic6Jyc7CiAgY29uc3QgbGlzdFBhbmVsPXNob3dMaXN0Pyc8ZGl2IGNsYXNzPSJsb2dwYW5lbCI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjExcHg7bGV0dGVyLXNwYWNpbmc6LjFlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLWJvdHRvbToxMnB4Ij5Zb3VyIGxpc3RzPC9kaXY+Jyt3YXRjaGxpc3RzUGFuZWxIVE1MKCkrJzwvZGl2Pic6Jyc7CgogIGNvbnN0IHRvb2xiYXI9JzxkaXYgY2xhc3M9InRvb2xiYXIiPicKICAgICsgc2VnKHtsYWJlbDoiVHlwZSIsa2V5OiJ0eXBlIn0sW3t2OiJhbGwiLHQ6IkFsbCJ9LHt2OiJtb3ZpZSIsdDoiTW92aWVzIn0se3Y6InNlcmllcyIsdDoiU2VyaWVzIn1dLGZpbHRlcnMudHlwZSkKICAgICsgc2VnKHtsYWJlbDoiTWluIElNRGIiLGtleToibWluIn0sW3t2OjAsdDoiQW55In0se3Y6Nyx0OiI3KyJ9LHt2OjgsdDoiOCsifV0sZmlsdGVycy5taW4pCiAgICArIHNlZyh7bGFiZWw6IlNvcnQgYnkiLGtleToic29ydCJ9LFt7djoibWF0Y2giLHQ6Ik1hdGNoIn0se3Y6ImltZGIiLHQ6IklNRGIifSx7djoicnQiLHQ6IlJUIn1dLGZpbHRlcnMuc29ydCkKICAgICsgJzxsYWJlbCBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4O2ZvbnQtc2l6ZToxM3B4O2N1cnNvcjpwb2ludGVyO21hcmdpbi1sZWZ0OmF1dG87dXNlci1zZWxlY3Q6bm9uZSI+PGlucHV0IHR5cGU9ImNoZWNrYm94IiBpZD0ibmV0b25seSIgJysoZmlsdGVycy5uZXQ/ImNoZWNrZWQiOiIiKSsnIHN0eWxlPSJhY2NlbnQtY29sb3I6dmFyKC0tZ29sZCk7d2lkdGg6MTZweDtoZWlnaHQ6MTZweCI+IE9uIE5ldGZsaXggb25seTwvbGFiZWw+JwogICAgKyAnPC9kaXY+JzsKCiAgY29uc3QgYm9keT1saXN0Lmxlbmd0aAogICAgPyAnPGRpdiBjbGFzcz0iZ3JpZCI+JytsaXN0Lm1hcChjYXJkKS5qb2luKCIiKSsnPC9kaXY+JwogICAgOiAnPGRpdiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0KTt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjQwcHggMCI+Tm90aGluZyBtYXRjaGVzIHRoZXNlIGZpbHRlcnMuIExvb3NlbiB0aGVtIHRvIHNlZSBtb3JlLjwvZGl2Pic7CgogIGNvbnN0IG5vdGU9JzxwIGNsYXNzPSJub3RlIj5SYXRpbmdzIHZpYSBPTURiIChJTURiIMK3IFJvdHRlbiBUb21hdG9lcyDCtyBNZXRhY3JpdGljKS4gJwogICAgK2VzYyhkYXRhLmF0dHJpYnV0aW9uKSsnLiBNb3JlIGxvYWQgYXV0b21hdGljYWxseSBhcyB5b3Ugc2Nyb2xsLCBlYWNoIGJhdGNoIGF2b2lkaW5nIHdoYXQgeW91XCd2ZSBhbHJlYWR5IHNlZW4uIFlvdXIgd2F0Y2ggaGlzdG9yeSBpcyBzYXZlZCBzZXJ2ZXItc2lkZSBhbmQgZmVlZHMgZXZlcnkgc3VnZ2VzdGlvbi48L3A+JzsKCiAgY29uc3QgZm9vdGVyID0gZXhoYXVzdGVkCiAgICA/ICc8ZGl2IHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTNweDtwYWRkaW5nOjI0cHggMCA4cHgiPlRoYXRcJ3MgdGhlIGJlc3Qgb2Ygd2hhdCBmaXRzIHlvdXIgdGFzdGUgcmlnaHQgbm93LiBSYXRlIGEgZmV3IGFuZCBzdGFydCBvdmVyIGZvciBhIGZyZXNoIHJlYWQuPC9kaXY+JwogICAgOiAobG9hZGluZ01vcmUKICAgICAgICA/ICc8ZGl2IGNsYXNzPSJsb2FkIiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7Y29sb3I6dmFyKC0tbXV0KTtmb250LXNpemU6MTMuNXB4O3BhZGRpbmc6MjRweCAwIDhweCI+RmluZGluZyBtb3JlIGZvciB5b3XigKY8L2Rpdj4nCiAgICAgICAgOiAnPGRpdiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzoyMHB4IDAgNHB4Ij48YnV0dG9uIGNsYXNzPSJnaG9zdCIgaWQ9ImxvYWRtb3JlIj5Mb2FkIG1vcmU8L2J1dHRvbj48L2Rpdj4nKTsKICBjb25zdCBzZW50aW5lbD0nPGRpdiBpZD0ic2VudGluZWwiIHN0eWxlPSJoZWlnaHQ6MXB4Ij48L2Rpdj4nOwoKICByZXN1bHRzLmlubmVySFRNTD1iYXIrbGlzdFBhbmVsK3BhbmVsK3Rvb2xiYXIrYm9keStmb290ZXIrc2VudGluZWwrbm90ZTsKICAkKCIjYmFjayIpLm9uY2xpY2s9KCk9PntyZXN1bHRzLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyQoIiNpbnB1dCIpLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjt9OwogICQoIiNuZXRvbmx5Iikub25jaGFuZ2U9ZT0+e2ZpbHRlcnMubmV0PWUudGFyZ2V0LmNoZWNrZWQ7cmVuZGVyKCk7fTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoIi5zZWcgYnV0dG9uIikuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PnsKICAgIGNvbnN0IGs9Yi5kYXRhc2V0Lms7bGV0IHY9Yi5kYXRhc2V0LnY7aWYoaz09PSJtaW4iKXY9TnVtYmVyKHYpO2ZpbHRlcnNba109djtyZW5kZXIoKTsKICB9KTsKICAvLyB3YXRjaGVkIGNvbnRyb2xzCiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Imxpa2UiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57Y29uc3Qgcj1kYXRhLnJlc3VsdHMuZmluZCh4PT5ucm0oeC50aXRsZSk9PT1iLmRhdGFzZXQuaWQpO2lmKHIpbWFya1dhdGNoZWQocix0cnVlLHRydWUpO30pOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJ0cmFpbGVyIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+b3BlblRyYWlsZXIoYi5kYXRhc2V0LmtleSkpOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJkaXNsaWtlIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+e2NvbnN0IHI9ZGF0YS5yZXN1bHRzLmZpbmQoeD0+bnJtKHgudGl0bGUpPT09Yi5kYXRhc2V0LmlkKTtpZihyKW1hcmtXYXRjaGVkKHIsZmFsc2UsdHJ1ZSk7fSk7CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Im1lbnUiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57Y29uc3QgbW09Yi5wYXJlbnRFbGVtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sbWVudScpO2lmKG1tKW1tLmNsYXNzTGlzdC50b2dnbGUoJ29wZW4nKTt9KTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0idG9saXN0Il0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+e2NvbnN0IHI9ZGF0YS5yZXN1bHRzLmZpbmQoeD0+bnJtKHgudGl0bGUpPT09Yi5kYXRhc2V0LmlkKTtpZihyKXRvZ2dsZVRpdGxlSW5MaXN0KGIuZGF0YXNldC5saXN0LHIpO30pOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJuZXdsaXN0Il0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+e2NvbnN0IHI9ZGF0YS5yZXN1bHRzLmZpbmQoeD0+bnJtKHgudGl0bGUpPT09Yi5kYXRhc2V0LmlkKTtpZihyKW5ld0xpc3RGb3JDYXJkKHIpO30pOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJ1bndhdGNoIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+cmVtb3ZlV2F0Y2hlZChiLmRhdGFzZXQuaWQpKTsKICB3aXJlTG9nQ29udHJvbHMocmVzdWx0cyk7CiAgY29uc3QgbG09JCgiI2xvYWRtb3JlIik7IGlmKGxtKWxtLm9uY2xpY2s9bG9hZE1vcmU7CiAgb2JzZXJ2ZVNlbnRpbmVsKCk7Cn0KCmZ1bmN0aW9uIG9wZW5UcmFpbGVyKGtleSl7dmFyIGY9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRmcmFtZSIpO2lmKGYpZi5zcmM9Imh0dHBzOi8vd3d3LnlvdXR1YmUuY29tL2VtYmVkLyIra2V5KyI/YXV0b3BsYXk9MSI7dmFyIG1tPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0bW9kYWwiKTtpZihtbSltbS5jbGFzc0xpc3QuYWRkKCJvcGVuIik7fQpmdW5jdGlvbiBjbG9zZVRyYWlsZXIoKXt2YXIgZj1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidGZyYW1lIik7aWYoZilmLnNyYz0iIjt2YXIgbW09ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRtb2RhbCIpO2lmKG1tKW1tLmNsYXNzTGlzdC5yZW1vdmUoIm9wZW4iKTt9CndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJrZXlkb3duIixmdW5jdGlvbihlKXtpZihlLmtleT09PSJFc2NhcGUiKWNsb3NlVHJhaWxlcigpO30pOwpyZW5kZXJDaGlwcygpOwpsb2FkV2F0Y2hlZCgpOwpsb2FkV2F0Y2hsaXN0cygpOwoKdmFyIF9zPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzdGF0dXMiKTtpZihfcyl7X3Muc3R5bGUuZGlzcGxheT0iYmxvY2siO19zLnN0eWxlLmJhY2tncm91bmQ9IiMxMjI4MWMiO19zLnN0eWxlLmJvcmRlcj0iMXB4IHNvbGlkICMyZjVhM2QiO19zLnN0eWxlLmNvbG9yPSIjYmZlOGNmIjtfcy50ZXh0Q29udGVudD0iUmVhZHkgXHUyMDE0IHR5cGUgYSB0aXRsZSwgcHJlc3MgRW50ZXIsIGFkZCBhdCBsZWFzdCAzLiI7fQo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg==", "base64").toString("utf8");

app.get("/", (_req, res) => res.type("html").send(PAGE));

app.listen(PORT, () => console.log(`What Next server → http://localhost:${PORT}`));
