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
const omdbCache = new Map(); // avoid re-spending the daily OMDb quota on titles we've already looked up
function pctFromRatings(ratings, source) {
  const r = (ratings || []).find((x) => x.Source === source);
  if (!r) return null;
  const m = String(r.Value).match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}
async function omdbByImdb(imdbID) {
  if (!OMDB_API_KEY || !imdbID) return null;
  const ck = "i:" + imdbID;
  if (omdbCache.has(ck)) return omdbCache.get(ck);
  try {
    const u = new URL("https://www.omdbapi.com/");
    u.searchParams.set("apikey", OMDB_API_KEY);
    u.searchParams.set("i", imdbID);
    const r = await fetch(u);
    const d = await r.json();
    if (d.Response === "False") return null;
    const result = {
      imdb: d.imdbRating && d.imdbRating !== "N/A" ? Number(d.imdbRating) : null,
      rtCritics: pctFromRatings(d.Ratings, "Rotten Tomatoes"),
      metascore: d.Metascore && d.Metascore !== "N/A" ? Number(d.Metascore) : null,
      poster: d.Poster && d.Poster !== "N/A" ? d.Poster : null,
      plot: d.Plot && d.Plot !== "N/A" ? d.Plot : null,
    };
    omdbCache.set(ck, result);
    return result;
  } catch { return null; }
}

async function omdbByTitle(title, year, media) {
  if (!OMDB_API_KEY || !title) return null;
  const ck = "t:" + title + ":" + (year || "") + ":" + (media || "");
  if (omdbCache.has(ck)) return omdbCache.get(ck);
  try {
    const u = new URL("https://www.omdbapi.com/");
    u.searchParams.set("apikey", OMDB_API_KEY);
    u.searchParams.set("t", title);
    if (year) u.searchParams.set("y", String(year));
    if (media === "tv") u.searchParams.set("type", "series");
    else if (media === "movie") u.searchParams.set("type", "movie");
    const r = await fetch(u);
    const d = await r.json();
    if (d.Response === "False") return null;
    const result = {
      imdb: d.imdbRating && d.imdbRating !== "N/A" ? Number(d.imdbRating) : null,
      rtCritics: pctFromRatings(d.Ratings, "Rotten Tomatoes"),
      metascore: d.Metascore && d.Metascore !== "N/A" ? Number(d.Metascore) : null,
      poster: d.Poster && d.Poster !== "N/A" ? d.Poster : null,
      plot: d.Plot && d.Plot !== "N/A" ? d.Plot : null,
    };
    omdbCache.set(ck, result);
    return result;
  } catch { return null; }
}

// ---------- streaming availability via TMDb watch providers (JustWatch data) — free, region-aware ----------
async function tmdbProviders(media, id, country) {
  try {
    const wp = await tmdb(`/${media}/${id}/watch/providers`, {});
    const c = wp.results && wp.results[String(country).toUpperCase()];
    if (!c) return { onNetflix: false, netflixLink: null, services: [] };
    const link = c.link || null; // region-specific JustWatch page for this title
    // Accuracy: only "included with subscription" (flatrate), free, or free-with-ads count as available
    // in this region — never rent or buy.
    const flat = [...(c.flatrate || []), ...(c.free || []), ...(c.ads || [])];
    const byName = new Map();
    for (const p of flat) {
      const name = p.provider_name;
      if (name && !byName.has(name)) byName.set(name, { name, id: null, link });
    }
    const services = [...byName.values()];
    const netflix = services.find((s) => /netflix/i.test(s.name));
    return { onNetflix: !!netflix, netflixLink: netflix ? link : null, services };
  } catch { return { onNetflix: false, netflixLink: null, services: [] }; }
}

// ---------- enrich one title (shared by discover and single-title lookup) ----------
async function enrichTitle(media, id, raw, country, reason) {
  let imdbID = null;
  try { const ext = await tmdb(`/${media}/${id}/external_ids`, {}); imdbID = ext.imdb_id || null; } catch {}
  const omdb = imdbID ? await omdbByImdb(imdbID) : await omdbByTitle(tTitle(raw), tYear(raw), media);
  const sa = await tmdbProviders(media, id, country);
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
  return {
    title: tTitle(raw),
    year: tYear(raw),
    type: media === "tv" ? "Series" : "Movie",
    reason: reason || "",
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
    const focus = req.body?.focus === true; // single-title "more like this" — don't blend in watch history
    const likedWatched = focus ? [] : Object.values(watched).filter((w) => w.liked).map((w) => w.title);
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
      const seedList = [...e.seeds];
      return enrichTitle(e.media, e.id, e.raw, country, seedList.length ? `Because you enjoyed ${seedList[0]}` : "A strong match for your taste");
    });

    res.json({
      country,
      countryName: COUNTRY_NAMES[country] || country.toUpperCase(),
      results,
      attribution: "Suggestions & streaming availability from TMDB (this product uses the TMDB API but is not endorsed or certified by TMDB); availability data powered by JustWatch. Ratings via OMDb.",
    });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message || "Something broke while building recommendations." });
  }
});

// ---------- single title lookup (for expanding a saved title into a full card) ----------
app.post("/api/title", async (req, res) => {
  try {
    const title = String(req.body?.title || "").trim();
    const wantType = String(req.body?.type || "").toLowerCase(); // movie | series | ""
    const year = req.body?.year ? String(req.body.year) : "";
    const country = String(req.body?.country || "za").toLowerCase();
    if (!title) return res.status(400).json({ error: "No title provided." });
    if (!TMDB_API_KEY) return res.status(500).json({ error: "Server missing TMDB_API_KEY." });

    const s = await tmdb("/search/multi", { query: title, include_adult: "false" });
    const found = (s.results || []).filter((x) => (x.media_type === "movie" || x.media_type === "tv") && tTitle(x));
    if (!found.length) return res.status(404).json({ error: "Couldn't find that title." });
    const wantMedia = wantType === "series" ? "tv" : wantType === "movie" ? "movie" : null;
    let pick = (wantMedia ? found.find((x) => x.media_type === wantMedia) : null) || found[0];
    if (year) {
      const better = found.find((x) => x.media_type === pick.media_type && tYear(x) === year);
      if (better) pick = better;
    }
    const result = await enrichTitle(pick.media_type, pick.id, pick, country, "");
    res.json({ result });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message || "Lookup failed." });
  }
});

// ---------- provider coverage check (are non-Netflix services present in this region's data?) ----------
app.get("/api/providers-check", async (req, res) => {
  const country = String(req.query.country || "za").toLowerCase();
  // Titles strongly tied to each service — if the data is healthy, each should list its home service.
  const tests = { "Stranger Things": "Netflix", "The Boys": "Prime Video", "Loki": "Disney+", "Ted Lasso": "Apple TV+" };
  const out = { country: country.toUpperCase(), note: "each title's subscription providers as TMDb/JustWatch reports them", results: {} };
  for (const t of Object.keys(tests)) {
    try {
      const s = await tmdb("/search/multi", { query: t, include_adult: "false" });
      const found = (s.results || []).find((x) => (x.media_type === "movie" || x.media_type === "tv") && tTitle(x));
      if (!found) { out.results[t] = "(not found)"; continue; }
      const wp = await tmdb(`/${found.media_type}/${found.id}/watch/providers`, {});
      const c = wp.results && wp.results[country.toUpperCase()];
      out.results[t] = { expected: tests[t], subscription: c && c.flatrate ? c.flatrate.map((p) => p.provider_name) : [] };
    } catch (e) { out.results[t] = "error: " + e.message; }
  }
  res.json(out);
});

// ---------- diagnostics ----------
app.get("/api/diag", async (_req, res) => {
  const out = {
    tmdb: {},
    omdb: {},
    streaming: {},
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
  // Streaming availability now comes free from TMDb (JustWatch) — no separate key or quota.
  try {
    if (!TMDB_API_KEY) out.streaming = { working: false, note: "No TMDB key saved." };
    else {
      const wp = await tmdb("/movie/603/watch/providers", {}); // The Matrix
      const us = wp.results && wp.results.US;
      out.streaming = {
        working: true,
        source: "TMDb / JustWatch (free, no quota)",
        testedWith: "The Matrix (US)",
        servicesFound: us ? [...new Set([...(us.flatrate || []), ...(us.free || []), ...(us.ads || [])].map((p) => p.provider_name))].slice(0, 8) : [],
      };
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
      streaming: !!TMDB_API_KEY,
    },
  });
});

const PAGE = Buffer.from("PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPgo8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEiIC8+Cjx0aXRsZT5XaGF0IE5leHQgwrcgTmV0ZmxpeCB0YXN0ZS1tYXRjaGVyPC90aXRsZT4KPHN0eWxlPgogIDpyb290ewogICAgLS1iZzojMEUxMTE2OyAtLWJnMjojMTIxNjFDOyAtLWNhcmQ6IzE3MUMyNDsgLS1jYXJkSGk6IzFDMjIyQjsKICAgIC0tbGluZTojMjcyRTM5OyAtLWdvbGQ6I0U4QjQ0QTsgLS10ZXh0OiNGMkVERTM7IC0tbXV0OiM4QjkzQTA7IC0tbXV0MjojNUM2NDcwOwogICAgLS1nb29kOiM0RkI0Nzc7IC0tbWlkOiNFOEI0NEE7IC0tYmFkOiNFMDU3NEI7IC0tbmV0OiM0RkI0Nzc7CiAgfQogICp7Ym94LXNpemluZzpib3JkZXItYm94fQogIGJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7CiAgICBmb250LWZhbWlseTotYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwnU2Vnb2UgVUknLFJvYm90byxzYW5zLXNlcmlmO30KICAud3JhcHttYXgtd2lkdGg6OTQwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjQwcHggMjJweCA3MnB4fQogIC5leWVicm93e2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4yMmVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1nb2xkKTttYXJnaW4tYm90dG9tOjEwcHh9CiAgaDF7Zm9udC1mYW1pbHk6dWktc2VyaWYsR2VvcmdpYSxzZXJpZjtmb250LXNpemU6NDZweDtsaW5lLWhlaWdodDoxLjAyO21hcmdpbjowO2ZvbnQtd2VpZ2h0OjYwMDtsZXR0ZXItc3BhY2luZzotLjAxZW19CiAgLnN1Yntjb2xvcjp2YXIoLS1tdXQpO2ZvbnQtc2l6ZToxNXB4O21hcmdpbi10b3A6MTJweDttYXgtd2lkdGg6NTIwcHg7bGluZS1oZWlnaHQ6MS41fQogIC5wYW5lbHtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE4cHg7cGFkZGluZzoyNHB4fQogIC5yb3d7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDo4cHh9CiAgLmNoaXB7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtiYWNrZ3JvdW5kOnZhcigtLWNhcmRIaSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsKICAgIGJvcmRlci1yYWRpdXM6OTk5cHg7cGFkZGluZzo3cHggOHB4IDdweCAxNHB4O2ZvbnQtc2l6ZToxMy41cHh9CiAgLmNoaXAgYnV0dG9ue2N1cnNvcjpwb2ludGVyO2JvcmRlcjpub25lO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6dmFyKC0tbXV0KTtmb250LXNpemU6MTVweDtsaW5lLWhlaWdodDoxO3BhZGRpbmc6MCAycHh9CiAgaW5wdXQudGl0bGV7ZmxleDoxIDAgMTYwcHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS10ZXh0KTtmb250LXNpemU6MTRweDtwYWRkaW5nOjhweCA0cHg7bWluLXdpZHRoOjE0MHB4O291dGxpbmU6bm9uZX0KICBpbnB1dC50aXRsZTo6cGxhY2Vob2xkZXJ7Y29sb3I6dmFyKC0tbXV0Mil9CiAgc2VsZWN0e2JhY2tncm91bmQ6dmFyKC0tY2FyZEhpKTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjEwcHggMTRweDtmb250LXNpemU6MTRweDtjdXJzb3I6cG9pbnRlcn0KICAuY3Rhe2JhY2tncm91bmQ6dmFyKC0tZ29sZCk7Y29sb3I6IzIwMTgwYTtib3JkZXI6bm9uZTtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzoxM3B4IDI2cHg7Zm9udC1zaXplOjE0LjVweDtmb250LXdlaWdodDo3MDA7Y3Vyc29yOnBvaW50ZXJ9CiAgLmN0YVtkaXNhYmxlZF17YmFja2dyb3VuZDp2YXIoLS1jYXJkSGkpO2NvbG9yOnZhcigtLW11dDIpO2N1cnNvcjpub3QtYWxsb3dlZH0KICAuaHJ7aGVpZ2h0OjFweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpfQogIC5ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMzAwcHgsMWZyKSk7Z2FwOjE2cHh9CiAgLnJje2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjEycHh9CiAgLnJjLnNlZW57Ym9yZGVyLWNvbG9yOnJnYmEoMjMyLDE4MCw3NCwuMjgpfQogIC5raWNrZXJ7Zm9udC1zaXplOjEwcHg7bGV0dGVyLXNwYWNpbmc6LjEyZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLWdvbGQpfQogIC5ydC10aXRsZXtmb250LWZhbWlseTp1aS1zZXJpZixHZW9yZ2lhLHNlcmlmO2ZvbnQtc2l6ZToyMnB4O2xpbmUtaGVpZ2h0OjEuMTU7Zm9udC13ZWlnaHQ6NjAwfQogIC5yZWFzb257Zm9udC1zaXplOjEzLjVweDtsaW5lLWhlaWdodDoxLjU7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tdG9wOjZweH0KICAud3JpdGV1cHtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU1O2NvbG9yOnZhcigtLW11dCl9CiAgLnRyYWlsZXJ7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2NvbG9yOnZhcigtLWdvbGQpO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NXB4IDEycHg7Zm9udC1zaXplOjEyLjVweDtjdXJzb3I6cG9pbnRlcjttYXJnaW4tdG9wOjEwcHh9CiAgLnRyYWlsZXI6aG92ZXJ7YmFja2dyb3VuZDpyZ2JhKDIzMiwxODAsNzQsLjA4KX0KICAudG1vZGFse2Rpc3BsYXk6bm9uZTtwb3NpdGlvbjpmaXhlZDtpbnNldDowO2JhY2tncm91bmQ6cmdiYSg2LDgsMTEsLjg1KTt6LWluZGV4OjEwMDA7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7cGFkZGluZzoyMHB4fQogIC50bW9kYWwub3BlbntkaXNwbGF5OmZsZXh9CiAgLnRtYm94e3dpZHRoOjEwMCU7bWF4LXdpZHRoOjgyMHB4fQogIC50bWNsb3Nle2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjZweCAxNHB4O2ZvbnQtc2l6ZToxM3B4O2N1cnNvcjpwb2ludGVyO21hcmdpbi1ib3R0b206MTBweH0KICAudG1jbG9zZTpob3ZlcntiYWNrZ3JvdW5kOnZhcigtLWNhcmQpfQogIC50bWZyYW1le3Bvc2l0aW9uOnJlbGF0aXZlO3BhZGRpbmctYm90dG9tOjU2LjI1JTtoZWlnaHQ6MDtib3JkZXItcmFkaXVzOjEycHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzAwMDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpfQogIC50bWZyYW1lIGlmcmFtZXtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7Ym9yZGVyOjB9CiAgLmRtb2RhbHtkaXNwbGF5Om5vbmU7cG9zaXRpb246Zml4ZWQ7aW5zZXQ6MDtiYWNrZ3JvdW5kOnJnYmEoNiw4LDExLC44NSk7ei1pbmRleDo5OTA7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3BhZGRpbmc6MjRweDtvdmVyZmxvdzphdXRvfQogIC5kbW9kYWwub3BlbntkaXNwbGF5OmZsZXh9CiAgLmRtYm94e3dpZHRoOjEwMCU7bWF4LXdpZHRoOjQzMHB4fQogIC5pdGVtdGl0bGV7YmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2NvbG9yOnZhcigtLXRleHQpO2ZvbnQtc2l6ZToxMy41cHg7Y3Vyc29yOnBvaW50ZXI7cGFkZGluZzowO3RleHQtYWxpZ246bGVmdDtmb250LWZhbWlseTppbmhlcml0fQogIC5pdGVtdGl0bGU6aG92ZXJ7Y29sb3I6dmFyKC0tZ29sZCk7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZX0KICAuc2tpcHtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Y29sb3I6dmFyKC0tbXV0Mik7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzo2cHggMTJweDtmb250LXNpemU6MTIuNXB4O2N1cnNvcjpwb2ludGVyfQogIC5za2lwOmhvdmVye2NvbG9yOnZhcigtLXRleHQpO2JvcmRlci1jb2xvcjp2YXIoLS1tdXQyKX0KICAubW9yZWxpa2V7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2NvbG9yOnZhcigtLWdvbGQpO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6N3B4IDEycHg7Zm9udC1zaXplOjEyLjVweDtjdXJzb3I6cG9pbnRlcjt0ZXh0LWFsaWduOmNlbnRlcjt3aWR0aDoxMDAlfQogIC5tb3JlbGlrZTpob3ZlcntiYWNrZ3JvdW5kOnJnYmEoMjMyLDE4MCw3NCwuMDgpfQogIC5zdmNmaWx0ZXJze2Rpc3BsYXk6aW5saW5lLWZsZXg7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo5cHg7cGFkZGluZzozcHg7Z2FwOjJweDtmbGV4LXdyYXA6d3JhcH0KICAuc3ZjZntib3JkZXI6bm9uZTtjdXJzb3I6cG9pbnRlcjtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjZweCAxMHB4O2ZvbnQtc2l6ZToxMnB4O2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6dmFyKC0tbXV0KX0KICAuc3ZjZjpob3Zlcntjb2xvcjp2YXIoLS10ZXh0KX0KICAuc3ZjZi5vbntiYWNrZ3JvdW5kOnZhcigtLWdvbGQpO2NvbG9yOiMyMDE4MGE7Zm9udC13ZWlnaHQ6NzAwfQogIC52cm93e2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6MTBweH0KICAudnRodW1ie2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOm5vbmU7cGFkZGluZzowO2N1cnNvcjpwb2ludGVyO3dpZHRoOjEzMnB4O3RleHQtYWxpZ246bGVmdH0KICAudnRodW1iLWltZ3twb3NpdGlvbjpyZWxhdGl2ZTtkaXNwbGF5OmJsb2NrO3dpZHRoOjEzMnB4O2hlaWdodDo3NHB4O2JvcmRlci1yYWRpdXM6OHB4O2JhY2tncm91bmQtc2l6ZTpjb3ZlcjtiYWNrZ3JvdW5kLXBvc2l0aW9uOmNlbnRlcjtiYWNrZ3JvdW5kLWNvbG9yOiMwMDA7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0KICAudnBsYXl7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6MDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6I2ZmZjtmb250LXNpemU6MTVweDtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjMwKTtib3JkZXItcmFkaXVzOjhweH0KICAudnRodW1iOmhvdmVyIC52cGxheXtiYWNrZ3JvdW5kOnJnYmEoMCwwLDAsLjEyKX0KICAudmNhcHtmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS1tdXQpO21hcmdpbi10b3A6NXB4O2xpbmUtaGVpZ2h0OjEuMztvdmVyZmxvdzpoaWRkZW47ZGlzcGxheTotd2Via2l0LWJveDstd2Via2l0LWxpbmUtY2xhbXA6Mjstd2Via2l0LWJveC1vcmllbnQ6dmVydGljYWx9CiAgLnN2Y3Jvd3tkaXNwbGF5OmZsZXg7Z2FwOjhweDthbGlnbi1pdGVtczpjZW50ZXI7ZmxleC13cmFwOndyYXB9CiAgLnN2Y2ljb257ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjttaW4td2lkdGg6MzRweDtoZWlnaHQ6MjZweDtwYWRkaW5nOjAgOHB4O2JvcmRlci1yYWRpdXM6N3B4O2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0ZXItc3BhY2luZzouMDJlbTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JhY2tncm91bmQ6dmFyKC0tY2FyZEhpKTtjb2xvcjp2YXIoLS1tdXQyKX0KICAuc3ZjaWNvbi5vZmZ7b3BhY2l0eTouMzg7ZmlsdGVyOmdyYXlzY2FsZSgxKX0KICBhOmhvdmVyIC5zdmNpY29ue2ZpbHRlcjpicmlnaHRuZXNzKDEuMDgpfQogIC5oZWFke2Rpc3BsYXk6ZmxleDtnYXA6MTRweDthbGlnbi1pdGVtczpmbGV4LXN0YXJ0fQogIC5oZWFkbWV0YXttaW4td2lkdGg6MDtmbGV4OjF9CiAgLnBvc3Rlcnt3aWR0aDo3MnB4O2hlaWdodDoxMDhweDtib3JkZXItcmFkaXVzOjhweDtvYmplY3QtZml0OmNvdmVyO2JhY2tncm91bmQ6dmFyKC0tY2FyZEhpKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2ZsZXg6bm9uZTtkaXNwbGF5OmJsb2NrfQogIC5wb3N0ZXIucGh7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOnZhcigtLW11dDIpO2ZvbnQtc2l6ZTo5cHg7dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2xldHRlci1zcGFjaW5nOi4wNmVtO3RleHQtYWxpZ246Y2VudGVyO3BhZGRpbmc6NHB4fQogIC5zY29yZXN7ZGlzcGxheTpmbGV4O2dhcDoxNnB4fQogIC5zY3tmbGV4OjE7bWluLXdpZHRoOjB9CiAgLnNjIC5sYWJ7Zm9udC1zaXplOjEwcHg7bGV0dGVyLXNwYWNpbmc6LjA4ZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi1ib3R0b206NHB4fQogIC5zYyAudmFse2ZvbnQtZmFtaWx5OnVpLW1vbm9zcGFjZSxNZW5sbyxtb25vc3BhY2U7Zm9udC1zaXplOjIwcHg7Zm9udC13ZWlnaHQ6NjAwO2xpbmUtaGVpZ2h0OjF9CiAgLm1ldGVye2hlaWdodDozcHg7Ym9yZGVyLXJhZGl1czoycHg7YmFja2dyb3VuZDp2YXIoLS1saW5lKTttYXJnaW4tdG9wOjhweDtvdmVyZmxvdzpoaWRkZW59CiAgLm1ldGVyPml7ZGlzcGxheTpibG9jaztoZWlnaHQ6MTAwJTtib3JkZXItcmFkaXVzOjJweH0KICAubGFiMntmb250LXNpemU6MTBweDtsZXR0ZXItc3BhY2luZzouMDhlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLWJvdHRvbTo4cHh9CiAgLnN2Y3tkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6NXB4O2ZvbnQtc2l6ZToxMS41cHg7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzo0cHggOXB4O3RleHQtZGVjb3JhdGlvbjpub25lfQogIC5zdmMubmV0e2NvbG9yOiNiZmU4Y2Y7YmFja2dyb3VuZDpyZ2JhKDc5LDE4MCwxMTksLjE0KTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNzksMTgwLDExOSwuMzUpfQogIC5zdmMucGxhaW57Y29sb3I6dmFyKC0tbXV0KTtiYWNrZ3JvdW5kOnJnYmEoMTM5LDE0NywxNjAsLjA4KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpfQogIC5zdmMucGxhaW46aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dCl9CiAgLnNlZW5yb3d7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6OHB4fQogIC5yYXRle2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NnB4IDEycHg7Zm9udC1zaXplOjEyLjVweDtmb250LXdlaWdodDo2MDA7Y3Vyc29yOnBvaW50ZXJ9CiAgLnJhdGUudXB7YmFja2dyb3VuZDpyZ2JhKDc5LDE4MCwxMTksLjEwKTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoNzksMTgwLDExOSwuMyk7Y29sb3I6I2JmZThjZn0KICAucmF0ZS5kb3due2JhY2tncm91bmQ6cmdiYSgyMjQsODcsNzUsLjA4KTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjI0LDg3LDc1LC4yOCk7Y29sb3I6I2VmYjNhZH0KICAud2F0Y2hlZHRhZ3tmb250LXNpemU6MTIuNXB4O2ZvbnQtd2VpZ2h0OjYwMH0KICAudW5kb3tiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjpub25lO2NvbG9yOnZhcigtLW11dDIpO2ZvbnQtc2l6ZToxMnB4O2N1cnNvcjpwb2ludGVyO3RleHQtZGVjb3JhdGlvbjp1bmRlcmxpbmU7cGFkZGluZzoycHh9CiAgLnRvb2xiYXJ7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxOHB4O2FsaWduLWl0ZW1zOmZsZXgtZW5kO3BhZGRpbmc6MTRweCAxNnB4O2JhY2tncm91bmQ6dmFyKC0tYmcyKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDttYXJnaW4tYm90dG9tOjIwcHh9CiAgLnNlZ3tkaXNwbGF5OmlubGluZS1mbGV4O2JhY2tncm91bmQ6dmFyKC0tYmcyKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6OXB4O3BhZGRpbmc6M3B4O2dhcDoycHh9CiAgLnNlZyBidXR0b257Ym9yZGVyOm5vbmU7Y3Vyc29yOnBvaW50ZXI7Ym9yZGVyLXJhZGl1czo2cHg7cGFkZGluZzo2cHggMTJweDtmb250LXNpemU6MTIuNXB4O2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6dmFyKC0tbXV0KX0KICAuc2VnIGJ1dHRvbi5vbntiYWNrZ3JvdW5kOnZhcigtLWdvbGQpO2NvbG9yOiMyMDE4MGE7Zm9udC13ZWlnaHQ6NzAwfQogIC5naG9zdHtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Y29sb3I6dmFyKC0tdGV4dCk7Ym9yZGVyLXJhZGl1czo5OTlweDtwYWRkaW5nOjhweCAxNnB4O2ZvbnQtc2l6ZToxM3B4O2N1cnNvcjpwb2ludGVyO2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo3cHh9CiAgLmRvdHt3aWR0aDo2cHg7aGVpZ2h0OjZweDtib3JkZXItcmFkaXVzOjk5OXB4O2JhY2tncm91bmQ6dmFyKC0tbXV0Mil9CiAgLmxvZ3BhbmVse2JhY2tncm91bmQ6dmFyKC0tYmcyKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTJweDtwYWRkaW5nOjE2cHg7bWFyZ2luLWJvdHRvbToyMHB4fQogIC5sb2dpdGVte2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEwcHg7YmFja2dyb3VuZDp2YXIoLS1jYXJkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjlweCAxMnB4fQogIC5mb290e2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjEwcHh9CiAgLndse2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtjb2xvcjp2YXIoLS1tdXQpO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6N3B4IDEycHg7Zm9udC1zaXplOjEyLjVweDtjdXJzb3I6cG9pbnRlcjt0ZXh0LWFsaWduOmNlbnRlcjt3aWR0aDoxMDAlfQogIC53bDpob3Zlcntjb2xvcjp2YXIoLS10ZXh0KX0KICAud2wub257Ym9yZGVyLWNvbG9yOnJnYmEoMjMyLDE4MCw3NCwuNCk7Y29sb3I6dmFyKC0tZ29sZCk7YmFja2dyb3VuZDpyZ2JhKDIzMiwxODAsNzQsLjA4KX0KICAud2x3cmFwe3Bvc2l0aW9uOnJlbGF0aXZlfQogIC5sbWVudXtkaXNwbGF5Om5vbmU7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDo0cHg7bWFyZ2luLXRvcDo2cHg7cGFkZGluZzo4cHg7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo4cHh9CiAgLmxtZW51Lm9wZW57ZGlzcGxheTpmbGV4fQogIC5sbWl7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2NvbG9yOnZhcigtLW11dCk7Ym9yZGVyLXJhZGl1czo2cHg7cGFkZGluZzo2cHggMTBweDtmb250LXNpemU6MTIuNXB4O2N1cnNvcjpwb2ludGVyO3RleHQtYWxpZ246bGVmdH0KICAubG1pOmhvdmVye2NvbG9yOnZhcigtLXRleHQpfQogIC5sbWkub257Ym9yZGVyLWNvbG9yOnJnYmEoMjMyLDE4MCw3NCwuNCk7Y29sb3I6dmFyKC0tZ29sZCl9CiAgLmxtaS5uZXd7Y29sb3I6dmFyKC0tZ29sZCk7Ym9yZGVyLXN0eWxlOmRhc2hlZH0KICAudGlueWJ0bntiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjpub25lO2NvbG9yOnZhcigtLW11dDIpO2ZvbnQtc2l6ZToxMS41cHg7Y3Vyc29yOnBvaW50ZXI7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZTtwYWRkaW5nOjJweCA0cHh9CiAgLnRpbnlidG46aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dCl9CiAgLm5vdGV7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjEycHg7bGluZS1oZWlnaHQ6MS42O21hcmdpbi10b3A6MjZweDttYXgtd2lkdGg6NjQwcHh9CiAgYS5saW5re2NvbG9yOnZhcigtLWdvbGQpO3RleHQtZGVjb3JhdGlvbjpub25lO2ZvbnQtc2l6ZToxMi41cHh9CiAgYnV0dG9uOmZvY3VzLXZpc2libGUsaW5wdXQ6Zm9jdXMtdmlzaWJsZSxzZWxlY3Q6Zm9jdXMtdmlzaWJsZSwuc2VnIGJ1dHRvbjpmb2N1cy12aXNpYmxle291dGxpbmU6MnB4IHNvbGlkIHZhcigtLWdvbGQpO291dGxpbmUtb2Zmc2V0OjJweH0KICBAa2V5ZnJhbWVzIHB7MCUsMTAwJXtvcGFjaXR5Oi40NX01MCV7b3BhY2l0eTouOH19IC5sb2Fke2FuaW1hdGlvbjpwIDEuNHMgZWFzZS1pbi1vdXQgaW5maW5pdGV9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+CjxkaXYgY2xhc3M9IndyYXAiPgogIDxkaXYgaWQ9InN0YXR1cyIgc3R5bGU9ImRpc3BsYXk6bm9uZTttYXJnaW46MCAwIDE4cHg7cGFkZGluZzoxMHB4IDE0cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2ZvbnQtc2l6ZToxMy41cHgiPjwvZGl2PgogIDxkaXYgY2xhc3M9ImV5ZWJyb3ciPk5ldGZsaXggdGFzdGUtbWF0Y2hlcjwvZGl2PgogIDxoMT5XaGF0IG5leHQuPC9oMT4KICA8cCBjbGFzcz0ic3ViIj5OYW1lIGEgaGFuZGZ1bCBvZiB0aGluZ3MgeW91IHdhdGNoZWQgYW5kIGxvdmVkLiBSZWFsIElNRGIgJmFtcDsgUm90dGVuIFRvbWF0b2VzIHNjb3JlcywgcmVhbCByZWdpb25hbCBhdmFpbGFiaWxpdHksIGRlZXAgbGlua3MgdG8gd2hlcmUgaXQgc3RyZWFtcyDigJQgYW5kIGl0IGxlYXJucyBmcm9tIHdoYXQgeW91IHJhdGUuPC9wPgoKICA8ZGl2IGlkPSJpbnB1dCIgc3R5bGU9Im1hcmdpbi10b3A6MzBweCIgY2xhc3M9InBhbmVsIj4KICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpiYXNlbGluZTttYXJnaW4tYm90dG9tOjEycHgiPgogICAgICA8bGFiZWwgc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0OjYwMCI+VGhpbmdzIHlvdSBsb3ZlZDwvbGFiZWw+CiAgICAgIDxzcGFuIGlkPSJjb3VudCIgc3R5bGU9ImZvbnQtZmFtaWx5OnVpLW1vbm9zcGFjZSxtb25vc3BhY2U7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0MikiPjAgLyAxMDwvc3Bhbj4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0iY2hpcHMiIGNsYXNzPSJyb3ciIHN0eWxlPSJtYXJnaW4tYm90dG9tOjE0cHgiPgogICAgICA8aW5wdXQgY2xhc3M9InRpdGxlIiBpZD0iZHJhZnQiIHBsYWNlaG9sZGVyPSJUeXBlIGEgdGl0bGUsIHByZXNzIEVudGVyIiAvPgogICAgPC9kaXY+CiAgICA8YnV0dG9uIGlkPSJleGFtcGxlIiBzdHlsZT0iYmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2NvbG9yOnZhcigtLWdvbGQpO2ZvbnQtc2l6ZToxMi41cHg7Y3Vyc29yOnBvaW50ZXI7cGFkZGluZzowIDAgOHB4Ij5OZWVkIGEgc3Bhcms/IExvYWQgYW4gZXhhbXBsZSDihpI8L2J1dHRvbj4KICAgIDxkaXYgY2xhc3M9ImhyIiBzdHlsZT0ibWFyZ2luOjZweCAwIDE4cHgiPjwvZGl2PgogICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxNnB4O2FsaWduLWl0ZW1zOmZsZXgtZW5kO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuIj4KICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxNnB4Ij4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGZvcj0icmVnaW9uIiBzdHlsZT0iZGlzcGxheTpibG9jaztmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQpO21hcmdpbi1ib3R0b206N3B4Ij5XYXRjaGluZyBmcm9tPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9InJlZ2lvbiI+PC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbCBmb3I9InR5cGUiIHN0eWxlPSJkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCk7bWFyZ2luLWJvdHRvbTo3cHgiPlNob3cgbWU8L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBpZD0idHlwZSI+PC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbCBmb3I9ImdlbnJlIiBzdHlsZT0iZGlzcGxheTpibG9jaztmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQpO21hcmdpbi1ib3R0b206N3B4Ij5HZW5yZTwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJnZW5yZSI+PC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8YnV0dG9uIGlkPSJnbyIgY2xhc3M9ImN0YSIgZGlzYWJsZWQ+RmluZCBteSBuZXh0IHdhdGNoPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgaWQ9ImhpbnQiIHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tdG9wOjEycHgiPkFkZCBvbmUgdGl0bGUgdG8gZmluZCB0aGluZ3Mgc2ltaWxhciB0byBpdCwgb3Igc2V2ZXJhbCBmb3IgYSB0YXN0ZS1iYXNlZCBtaXguPC9kaXY+CiAgICA8ZGl2IGlkPSJpbnB1dGxvZyI+PC9kaXY+CiAgPC9kaXY+CgogIDxkaXYgaWQ9InJlc3VsdHMiIHN0eWxlPSJkaXNwbGF5Om5vbmU7bWFyZ2luLXRvcDozMHB4Ij48L2Rpdj4KICA8ZGl2IGlkPSJ0bW9kYWwiIGNsYXNzPSJ0bW9kYWwiIG9uY2xpY2s9ImlmKGV2ZW50LnRhcmdldD09PXRoaXMpY2xvc2VUcmFpbGVyKCkiPjxkaXYgY2xhc3M9InRtYm94Ij48YnV0dG9uIGNsYXNzPSJ0bWNsb3NlIiBvbmNsaWNrPSJjbG9zZVRyYWlsZXIoKSI+4pyVIENsb3NlPC9idXR0b24+PGRpdiBjbGFzcz0idG1mcmFtZSI+PGlmcmFtZSBpZD0idGZyYW1lIiBhbGxvdz0iYXV0b3BsYXk7IGVuY3J5cHRlZC1tZWRpYTsgZnVsbHNjcmVlbiIgYWxsb3dmdWxsc2NyZWVuPjwvaWZyYW1lPjwvZGl2PjwvZGl2PjwvZGl2PgogIDxkaXYgaWQ9ImRtb2RhbCIgY2xhc3M9ImRtb2RhbCIgb25jbGljaz0iaWYoZXZlbnQudGFyZ2V0PT09dGhpcyljbG9zZURldGFpbCgpIj48ZGl2IGNsYXNzPSJkbWJveCI+PGJ1dHRvbiBjbGFzcz0idG1jbG9zZSIgb25jbGljaz0iY2xvc2VEZXRhaWwoKSI+4pyVIENsb3NlPC9idXR0b24+PGRpdiBpZD0iZGV0YWlsLWJvZHkiPjwvZGl2PjwvZGl2PjwvZGl2Pgo8L2Rpdj4KCjxzY3JpcHQ+CndpbmRvdy5vbmVycm9yPWZ1bmN0aW9uKG0pe3ZhciBzPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzdGF0dXMiKTtpZihzKXtzLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjtzLnN0eWxlLmJhY2tncm91bmQ9IiM1YjFhMWEiO3Muc3R5bGUuYm9yZGVyPSIxcHggc29saWQgI2EzMyI7cy5zdHlsZS5jb2xvcj0iI2ZmZDlkNCI7cy50ZXh0Q29udGVudD0iUHJvYmxlbSBzdGFydGluZyB0aGUgYXBwOiAiK207fXJldHVybiBmYWxzZTt9OwoKY29uc3QgUkVHSU9OUz1bWyJ6YSIsIlNvdXRoIEFmcmljYSJdLFsidXMiLCJVbml0ZWQgU3RhdGVzIl0sWyJnYiIsIlVuaXRlZCBLaW5nZG9tIl0sWyJjYSIsIkNhbmFkYSJdLFsiYXUiLCJBdXN0cmFsaWEiXSxbImluIiwiSW5kaWEiXSxbIm5nIiwiTmlnZXJpYSJdLFsia2UiLCJLZW55YSJdLFsiZGUiLCJHZXJtYW55Il0sWyJmciIsIkZyYW5jZSJdLFsiZXMiLCJTcGFpbiJdLFsiYnIiLCJCcmF6aWwiXSxbIm14IiwiTWV4aWNvIl0sWyJqcCIsIkphcGFuIl0sWyJrciIsIlNvdXRoIEtvcmVhIl1dOwpjb25zdCBFWEFNUExFPVsiRGFyayIsIlRoZSBCZWFyIiwiQnJlYWtpbmcgQmFkIiwiUGFyYXNpdGUiLCJGbGVhYmFnIl07CmxldCBzaG93cz1bXSwgZGF0YT1udWxsLCB3YXRjaGVkTWFwPXt9LCB3YXRjaGxpc3RzPXt9LCBzaG93TG9nPWZhbHNlLCBzaG93TGlzdD1mYWxzZSwgc2tpcHBlZD1bXSwgYWN0aXZlU2VlZHM9W10sIGFjdGl2ZUZvY3VzPWZhbHNlOwpsZXQgbG9hZGluZ01vcmU9ZmFsc2UsIGV4aGF1c3RlZD1mYWxzZSwgaW89bnVsbDsKbGV0IGZpbHRlcnM9e3R5cGU6ImFsbCIsbWluOjAsc3ZjczpbXSxzb3J0OiJtYXRjaCJ9OwoKY29uc3QgJD1zPT5kb2N1bWVudC5xdWVyeVNlbGVjdG9yKHMpOwpjb25zdCBucm09cz0+U3RyaW5nKHN8fCIiKS50cmltKCkudG9Mb3dlckNhc2UoKTsKY29uc3QgZXNjPXM9PlN0cmluZyhzKS5yZXBsYWNlKC9bJjw+Il0vZyxjPT4oeyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwnIic6IiZxdW90OyJ9W2NdKSk7CmNvbnN0IHdhdGNoZWRDb3VudD0oKT0+T2JqZWN0LmtleXMod2F0Y2hlZE1hcCkubGVuZ3RoOwoKY29uc3QgcmVnaW9uU2VsPSQoIiNyZWdpb24iKTsKUkVHSU9OUy5mb3JFYWNoKChbYyxuXSk9Pntjb25zdCBvPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoIm9wdGlvbiIpO28udmFsdWU9YztvLnRleHRDb250ZW50PW47cmVnaW9uU2VsLmFwcGVuZENoaWxkKG8pO30pOwpjb25zdCBUWVBFUz1bWyIiLCJNb3ZpZXMgJiBzZXJpZXMiXSxbIm1vdmllIiwiTW92aWVzIG9ubHkiXSxbInNlcmllcyIsIlNlcmllcyBvbmx5Il1dOwpjb25zdCBHRU5SRVM9WyJBbnkiLCJBY3Rpb24iLCJBZHZlbnR1cmUiLCJBbmltYXRpb24iLCJDb21lZHkiLCJDcmltZSIsIkRvY3VtZW50YXJ5IiwiRHJhbWEiLCJGYW50YXN5IiwiSG9ycm9yIiwiTXlzdGVyeSIsIlJvbWFuY2UiLCJTY2ktRmkiLCJUaHJpbGxlciJdOwpjb25zdCB0eXBlU2VsPSQoIiN0eXBlIik7IFRZUEVTLmZvckVhY2goKFt2LG5dKT0+e2NvbnN0IG89ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgib3B0aW9uIik7by52YWx1ZT12O28udGV4dENvbnRlbnQ9bjt0eXBlU2VsLmFwcGVuZENoaWxkKG8pO30pOwpjb25zdCBnZW5yZVNlbD0kKCIjZ2VucmUiKTsgR0VOUkVTLmZvckVhY2goZz0+e2NvbnN0IG89ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgib3B0aW9uIik7by52YWx1ZT1nO28udGV4dENvbnRlbnQ9KGc9PT0iQW55Ij8iQW55IGdlbnJlIjpnKTtnZW5yZVNlbC5hcHBlbmRDaGlsZChvKTt9KTsKCmZ1bmN0aW9uIHNjb3JlQ29sb3IocCl7aWYocD09bnVsbHx8aXNOYU4ocCkpcmV0dXJuInZhcigtLW11dDIpIjtpZihwPj03NSlyZXR1cm4idmFyKC0tZ29vZCkiO2lmKHA+PTUwKXJldHVybiJ2YXIoLS1taWQpIjtyZXR1cm4idmFyKC0tYmFkKSI7fQoKLy8gLS0tLSB3YXRjaCBoaXN0b3J5IChzYXZlZCBpbiB0aGlzIGJyb3dzZXIgdmlhIGxvY2FsU3RvcmFnZSkgLS0tLQpjb25zdCBMU19LRVk9InduX3dhdGNobG9nIjsKZnVuY3Rpb24gcGVyc2lzdFdhdGNoZWQoKXt0cnl7bG9jYWxTdG9yYWdlLnNldEl0ZW0oTFNfS0VZLEpTT04uc3RyaW5naWZ5KHdhdGNoZWRNYXApKTt9Y2F0Y2goZSl7fX0KZnVuY3Rpb24gbG9hZFdhdGNoZWQoKXsKICB0cnl7Y29uc3QgcmF3PWxvY2FsU3RvcmFnZS5nZXRJdGVtKExTX0tFWSk7d2F0Y2hlZE1hcD1yYXc/KEpTT04ucGFyc2UocmF3KXx8e30pOnt9O31jYXRjaChlKXt3YXRjaGVkTWFwPXt9O30KICByZW5kZXJJbnB1dExvZygpOwp9CmZ1bmN0aW9uIHNraXBUaXRsZShyZWMpewogIGlmKGRhdGEmJmRhdGEucmVzdWx0cylkYXRhLnJlc3VsdHM9ZGF0YS5yZXN1bHRzLmZpbHRlcihmdW5jdGlvbih4KXtyZXR1cm4gbnJtKHgudGl0bGUpIT09bnJtKHJlYy50aXRsZSk7fSk7CiAgc2tpcHBlZC5wdXNoKHJlYy50aXRsZSk7CiAgaWYoZGF0YSlyZW5kZXIoKTsKfQpmdW5jdGlvbiBtYXJrV2F0Y2hlZChyZWMsbGlrZWQscmVtb3ZlVGlsZSl7CiAgd2F0Y2hlZE1hcFtucm0ocmVjLnRpdGxlKV09e3RpdGxlOnJlYy50aXRsZSx5ZWFyOnJlYy55ZWFyLHR5cGU6cmVjLnR5cGUsbGlrZWQsdHM6RGF0ZS5ub3coKX07CiAgcGVyc2lzdFdhdGNoZWQoKTsKICBpZihyZW1vdmVUaWxlJiZkYXRhJiZkYXRhLnJlc3VsdHMpZGF0YS5yZXN1bHRzPWRhdGEucmVzdWx0cy5maWx0ZXIoeD0+bnJtKHgudGl0bGUpIT09bnJtKHJlYy50aXRsZSkpOwogIGlmKGRhdGEpcmVuZGVyKCk7IHJlbmRlcklucHV0TG9nKCk7Cn0KZnVuY3Rpb24gcmVtb3ZlV2F0Y2hlZChpZCl7CiAgZGVsZXRlIHdhdGNoZWRNYXBbaWRdOyBwZXJzaXN0V2F0Y2hlZCgpOyBpZihkYXRhKXJlbmRlcigpOyByZW5kZXJJbnB1dExvZygpOwp9CmNvbnN0IExTX0xJU1RTPSJ3bl93YXRjaGxpc3RzIjsKZnVuY3Rpb24gcGVyc2lzdFdhdGNobGlzdHMoKXt0cnl7bG9jYWxTdG9yYWdlLnNldEl0ZW0oTFNfTElTVFMsSlNPTi5zdHJpbmdpZnkod2F0Y2hsaXN0cykpO31jYXRjaChlKXt9fQpmdW5jdGlvbiBsb2FkV2F0Y2hsaXN0cygpewogIHRyeXsKICAgIGNvbnN0IHJhdz1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShMU19MSVNUUyk7CiAgICBpZihyYXcpe3dhdGNobGlzdHM9SlNPTi5wYXJzZShyYXcpfHx7fTtyZXR1cm47fQogICAgY29uc3Qgb2xkPWxvY2FsU3RvcmFnZS5nZXRJdGVtKCJ3bl93YXRjaGxpc3QiKTsKICAgIGlmKG9sZCl7Y29uc3QgaXRlbXM9SlNPTi5wYXJzZShvbGQpfHx7fTtjb25zdCBpZD0ibCIrRGF0ZS5ub3coKTt3YXRjaGxpc3RzPXtbaWRdOntpZDppZCxuYW1lOiJNeSBXYXRjaGxpc3QiLGl0ZW1zOml0ZW1zLHRzOkRhdGUubm93KCl9fTtwZXJzaXN0V2F0Y2hsaXN0cygpO3JldHVybjt9CiAgICB3YXRjaGxpc3RzPXt9OwogIH1jYXRjaChlKXt3YXRjaGxpc3RzPXt9O30KfQpmdW5jdGlvbiBsaXN0Q291bnQoKXtyZXR1cm4gT2JqZWN0LmtleXMod2F0Y2hsaXN0cykubGVuZ3RoO30KZnVuY3Rpb24gbmV3TGlzdChuYW1lKXtjb25zdCBubT0obmFtZXx8IiIpLnRyaW0oKTtpZighbm0pcmV0dXJuIG51bGw7Y29uc3QgaWQ9ImwiK0RhdGUubm93KCkrTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpKjEwMDApO3dhdGNobGlzdHNbaWRdPXtpZDppZCxuYW1lOm5tLGl0ZW1zOnt9LHRzOkRhdGUubm93KCl9O3BlcnNpc3RXYXRjaGxpc3RzKCk7cmV0dXJuIGlkO30KZnVuY3Rpb24gcmVuYW1lTGlzdChpZCxuYW1lKXtjb25zdCBubT0obmFtZXx8IiIpLnRyaW0oKTtpZih3YXRjaGxpc3RzW2lkXSYmbm0pe3dhdGNobGlzdHNbaWRdLm5hbWU9bm07cGVyc2lzdFdhdGNobGlzdHMoKTt9fQpmdW5jdGlvbiBkZWxldGVMaXN0KGlkKXtkZWxldGUgd2F0Y2hsaXN0c1tpZF07cGVyc2lzdFdhdGNobGlzdHMoKTtpZihkYXRhKXJlbmRlcigpO3JlbmRlcklucHV0TG9nKCk7fQpmdW5jdGlvbiB0aXRsZUluTGlzdChsaXN0SWQsdGl0bGVJZCl7cmV0dXJuICEhKHdhdGNobGlzdHNbbGlzdElkXSYmd2F0Y2hsaXN0c1tsaXN0SWRdLml0ZW1zJiZ3YXRjaGxpc3RzW2xpc3RJZF0uaXRlbXNbdGl0bGVJZF0pO30KZnVuY3Rpb24gbGlzdHNGb3JUaXRsZSh0aXRsZUlkKXtyZXR1cm4gT2JqZWN0LnZhbHVlcyh3YXRjaGxpc3RzKS5maWx0ZXIobD0+bC5pdGVtcyYmbC5pdGVtc1t0aXRsZUlkXSkubWFwKGw9PmwuaWQpO30KZnVuY3Rpb24gdG9nZ2xlVGl0bGVJbkxpc3QobGlzdElkLHJlYyl7Y29uc3QgaWQ9bnJtKHJlYy50aXRsZSk7Y29uc3QgTD13YXRjaGxpc3RzW2xpc3RJZF07aWYoIUwpcmV0dXJuO2lmKCFMLml0ZW1zKUwuaXRlbXM9e307aWYoTC5pdGVtc1tpZF0pZGVsZXRlIEwuaXRlbXNbaWRdO2Vsc2UgTC5pdGVtc1tpZF09e3RpdGxlOnJlYy50aXRsZSx5ZWFyOnJlYy55ZWFyLHR5cGU6cmVjLnR5cGUsdHM6RGF0ZS5ub3coKX07cGVyc2lzdFdhdGNobGlzdHMoKTtpZihkYXRhKXJlbmRlcigpO3JlbmRlcklucHV0TG9nKCk7fQpmdW5jdGlvbiByZW1vdmVJdGVtRnJvbUxpc3QobGlzdElkLHRpdGxlSWQpe2NvbnN0IEw9d2F0Y2hsaXN0c1tsaXN0SWRdO2lmKEwmJkwuaXRlbXMpZGVsZXRlIEwuaXRlbXNbdGl0bGVJZF07cGVyc2lzdFdhdGNobGlzdHMoKTtpZihkYXRhKXJlbmRlcigpO3JlbmRlcklucHV0TG9nKCk7fQpmdW5jdGlvbiBjcmVhdGVMaXN0UHJvbXB0KCl7Y29uc3Qgbm09d2luZG93LnByb21wdCgiTmFtZSB5b3VyIG5ldyBsaXN0IChlLmcuIENvbWVkeSwgRGF0ZSBuaWdodCk6Iik7aWYobm0mJm5tLnRyaW0oKSl7bmV3TGlzdChubSk7aWYoZGF0YSlyZW5kZXIoKTtyZW5kZXJJbnB1dExvZygpO319CmZ1bmN0aW9uIG5ld0xpc3RGb3JDYXJkKHJlYyl7Y29uc3Qgbm09d2luZG93LnByb21wdCgiTmFtZSB5b3VyIG5ldyBsaXN0IChlLmcuIENvbWVkeSwgRGF0ZSBuaWdodCk6Iik7aWYobm0mJm5tLnRyaW0oKSl7Y29uc3QgaWQ9bmV3TGlzdChubSk7aWYoaWQmJnJlYyl0b2dnbGVUaXRsZUluTGlzdChpZCxyZWMpO319CmZ1bmN0aW9uIHJlbmFtZUxpc3RQcm9tcHQoaWQpe2NvbnN0IGN1cj13YXRjaGxpc3RzW2lkXT93YXRjaGxpc3RzW2lkXS5uYW1lOiIiO2NvbnN0IG5tPXdpbmRvdy5wcm9tcHQoIlJlbmFtZSB0aGlzIGxpc3Q6IixjdXIpO2lmKG5tJiZubS50cmltKCkpe3JlbmFtZUxpc3QoaWQsbm0pO2lmKGRhdGEpcmVuZGVyKCk7cmVuZGVySW5wdXRMb2coKTt9fQpmdW5jdGlvbiBkZWxldGVMaXN0Q29uZmlybShpZCl7Y29uc3QgTD13YXRjaGxpc3RzW2lkXTtpZighTClyZXR1cm47aWYod2luZG93LmNvbmZpcm0oJ0RlbGV0ZSB0aGUgbGlzdCAiJytMLm5hbWUrJyI/IFRoZSB0aXRsZXMgaW4gaXQgd2lsbCBiZSByZW1vdmVkIGZyb20gdGhpcyBsaXN0LicpKWRlbGV0ZUxpc3QoaWQpO30KZnVuY3Rpb24gbGlzdEJ1dHRvbkhUTUwoKXtjb25zdCBjPWxpc3RDb3VudCgpO3JldHVybiAnPGJ1dHRvbiBjbGFzcz0iZ2hvc3QiIGlkPSJsaXN0YnRuIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDonKyhjPyd2YXIoLS1nb2xkKSc6J3ZhcigtLW11dDIpJykrJyI+PC9zcGFuPk15IGxpc3RzICcrKGM/JygnK2MrJyknOicnKSsnICcrKHNob3dMaXN0PyfilrQnOifilr4nKSsnPC9idXR0b24+Jzt9CmZ1bmN0aW9uIHdhdGNobGlzdHNQYW5lbEhUTUwoKXsKICBjb25zdCBsaXN0cz1PYmplY3QudmFsdWVzKHdhdGNobGlzdHMpLnNvcnQoKGEsYik9PihhLnRzfHwwKS0oYi50c3x8MCkpOwogIGxldCBoPScnOwogIGlmKCFsaXN0cy5sZW5ndGgpaCs9JzxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2NvbG9yOnZhcigtLW11dDIpO3BhZGRpbmc6OHB4IDJweCI+WW91IGhhdmUgbm8gbGlzdHMgeWV0LiBDcmVhdGUgb25lLCB0aGVuIHVzZSAiQWRkIHRvIGxpc3QiIG9uIGFueSBzdWdnZXN0aW9uLjwvZGl2Pic7CiAgbGlzdHMuZm9yRWFjaChMPT57CiAgICBjb25zdCBpdGVtcz1PYmplY3QuZW50cmllcyhMLml0ZW1zfHx7fSkuc29ydCgoYSxiKT0+KGJbMV0udHN8fDApLShhWzFdLnRzfHwwKSk7CiAgICBoKz0nPGRpdiBzdHlsZT0ibWFyZ2luLWJvdHRvbToxNnB4Ij4nOwogICAgaCs9JzxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDttYXJnaW4tYm90dG9tOjhweCI+PHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS10ZXh0KSI+Jytlc2MoTC5uYW1lKSsnPC9zcGFuPjxzcGFuIHN0eWxlPSJmb250LXNpemU6MTEuNXB4O2NvbG9yOnZhcigtLW11dDIpIj4nK2l0ZW1zLmxlbmd0aCsnIHRpdGxlJysoaXRlbXMubGVuZ3RoPT09MT8nJzoncycpKyc8L3NwYW4+PGJ1dHRvbiBjbGFzcz0idGlueWJ0biIgZGF0YS1hY3Q9Imxpc3QtcmVuYW1lIiBkYXRhLWxpc3Q9IicrZXNjKEwuaWQpKyciIHN0eWxlPSJtYXJnaW4tbGVmdDphdXRvIj5yZW5hbWU8L2J1dHRvbj48YnV0dG9uIGNsYXNzPSJ0aW55YnRuIiBkYXRhLWFjdD0ibGlzdC1kZWxldGUiIGRhdGEtbGlzdD0iJytlc2MoTC5pZCkrJyI+ZGVsZXRlPC9idXR0b24+PC9kaXY+JzsKICAgIGlmKCFpdGVtcy5sZW5ndGgpaCs9JzxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dDIpO3BhZGRpbmc6MnB4IDJweCA0cHgiPk5vIHRpdGxlcyB5ZXQuPC9kaXY+JzsKICAgIGVsc2UgaCs9aXRlbXMubWFwKChbaWQseF0pPT4nPGRpdiBjbGFzcz0ibG9naXRlbSI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6dmFyKC0tZ29sZCkiPjwvc3Bhbj48YnV0dG9uIGNsYXNzPSJpdGVtdGl0bGUiIGRhdGEtYWN0PSJleHBhbmQiIGRhdGEtc3JjPSJsaXN0IiBkYXRhLWxpc3Q9IicrZXNjKEwuaWQpKyciIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj4nK2VzYyh4LnRpdGxlKSsnPC9idXR0b24+PHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMS41cHg7Y29sb3I6dmFyKC0tbXV0MikiPicrZXNjKHgudHlwZXx8JycpKyh4LnllYXI/JyDCtyAnK2VzYyh4LnllYXIpOicnKSsnPC9zcGFuPjxidXR0b24gY2xhc3M9ImNoaXAiIGRhdGEtYWN0PSJpdGVtLXJlbW92ZSIgZGF0YS1saXN0PSInK2VzYyhMLmlkKSsnIiBkYXRhLWlkPSInK2VzYyhpZCkrJyIgc3R5bGU9Im1hcmdpbi1sZWZ0OmF1dG87YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTVweDtwYWRkaW5nOjAgNHB4O2N1cnNvcjpwb2ludGVyIj4mdGltZXM7PC9idXR0b24+PC9kaXY+Jykuam9pbigiIik7CiAgICBoKz0nPC9kaXY+JzsKICB9KTsKICBoKz0nPGJ1dHRvbiBjbGFzcz0id2wiIGRhdGEtYWN0PSJsaXN0LW5ldyIgc3R5bGU9Im1hcmdpbi10b3A6NHB4Ij4rIE5ldyBsaXN0PC9idXR0b24+JzsKICByZXR1cm4gaDsKfQoKZnVuY3Rpb24gbG9nTGlzdEhUTUwoKXsKICBjb25zdCBpdGVtcz1PYmplY3QuZW50cmllcyh3YXRjaGVkTWFwKS5zb3J0KChhLGIpPT4oYlsxXS50c3x8MCktKGFbMV0udHN8fDApKTsKICBpZighaXRlbXMubGVuZ3RoKXJldHVybiAnPGRpdiBzdHlsZT0iZm9udC1zaXplOjEzcHg7Y29sb3I6dmFyKC0tbXV0Mik7cGFkZGluZzo4cHggMnB4Ij5Ob3RoaW5nIGxvZ2dlZCB5ZXQuIFJhdGUgYSBzdWdnZXN0aW9uIGFuZCBpdFwnbGwgc2hhcGUgd2hhdCBjb21lcyBuZXh0LjwvZGl2Pic7CiAgcmV0dXJuIGl0ZW1zLm1hcCgoW2lkLHddKT0+JzxkaXYgY2xhc3M9ImxvZ2l0ZW0iPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOicrKHcubGlrZWQ/J3ZhcigtLWdvb2QpJzp3Lmxpa2VkPT09ZmFsc2U/J3ZhcigtLWJhZCknOid2YXIoLS1tdXQyKScpKyciPjwvc3Bhbj4nCiAgICArJzxidXR0b24gY2xhc3M9Iml0ZW10aXRsZSIgZGF0YS1hY3Q9ImV4cGFuZCIgZGF0YS1zcmM9ImxvZyIgZGF0YS1pZD0iJytlc2MoaWQpKyciPicrZXNjKHcudGl0bGUpKyc8L2J1dHRvbj4nCiAgICArJzxzcGFuIHN0eWxlPSJmb250LXNpemU6MTEuNXB4O2NvbG9yOnZhcigtLW11dDIpIj4nKyh3Lmxpa2VkPydMb3ZlZCBpdCc6dy5saWtlZD09PWZhbHNlPydOb3QgZm9yIG1lJzonU2VlbicpKyc8L3NwYW4+JwogICAgKyc8YnV0dG9uIGNsYXNzPSJjaGlwIiBkYXRhLWFjdD0idW53YXRjaCIgZGF0YS1pZD0iJytlc2MoaWQpKyciIHN0eWxlPSJtYXJnaW4tbGVmdDphdXRvO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjE1cHg7cGFkZGluZzowIDRweDtjdXJzb3I6cG9pbnRlciI+JnRpbWVzOzwvYnV0dG9uPjwvZGl2PicpLmpvaW4oIiIpOwp9CmZ1bmN0aW9uIGxvZ0J1dHRvbkhUTUwoKXsKICBjb25zdCBjPXdhdGNoZWRDb3VudCgpOwogIHJldHVybiAnPGJ1dHRvbiBjbGFzcz0iZ2hvc3QiIGlkPSJsb2didG4iPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOicrKGM/J3ZhcigtLWdvbGQpJzondmFyKC0tbXV0MiknKSsnIj48L3NwYW4+V2F0Y2hlZCAnKyhjPycoJytjKycpJzonJykrJyAnKyhzaG93TG9nPyfilrQnOifilr4nKSsnPC9idXR0b24+JzsKfQpmdW5jdGlvbiB3aXJlTG9nQ29udHJvbHMoc2NvcGUpewogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0idW53YXRjaCJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PnJlbW92ZVdhdGNoZWQoYi5kYXRhc2V0LmlkKSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJpdGVtLXJlbW92ZSJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PnJlbW92ZUl0ZW1Gcm9tTGlzdChiLmRhdGFzZXQubGlzdCxiLmRhdGFzZXQuaWQpKTsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Imxpc3QtcmVuYW1lIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+cmVuYW1lTGlzdFByb21wdChiLmRhdGFzZXQubGlzdCkpOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ibGlzdC1kZWxldGUiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5kZWxldGVMaXN0Q29uZmlybShiLmRhdGFzZXQubGlzdCkpOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ibGlzdC1uZXciXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5jcmVhdGVMaXN0UHJvbXB0KCkpOwogIGNvbnN0IGxiPXNjb3BlLnF1ZXJ5U2VsZWN0b3IoIiNsb2didG4iKTsgaWYobGIpbGIub25jbGljaz0oKT0+e3Nob3dMb2c9IXNob3dMb2c7IGlmKGRhdGEpcmVuZGVyKCk7IHJlbmRlcklucHV0TG9nKCk7fTsKICBjb25zdCB3Yj1zY29wZS5xdWVyeVNlbGVjdG9yKCIjbGlzdGJ0biIpOyBpZih3Yil3Yi5vbmNsaWNrPSgpPT57c2hvd0xpc3Q9IXNob3dMaXN0OyBpZihkYXRhKXJlbmRlcigpOyByZW5kZXJJbnB1dExvZygpO307CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJleHBhbmQiXScpLmZvckVhY2goZnVuY3Rpb24oYil7Yi5vbmNsaWNrPWZ1bmN0aW9uKCl7dmFyIG9iaj1iLmRhdGFzZXQuc3JjPT09Imxpc3QiPyh3YXRjaGxpc3RzW2IuZGF0YXNldC5saXN0XSYmd2F0Y2hsaXN0c1tiLmRhdGFzZXQubGlzdF0uaXRlbXMmJndhdGNobGlzdHNbYi5kYXRhc2V0Lmxpc3RdLml0ZW1zW2IuZGF0YXNldC5pZF0pOndhdGNoZWRNYXBbYi5kYXRhc2V0LmlkXTtpZihvYmopb3BlbkRldGFpbChvYmopO307fSk7Cn0KZnVuY3Rpb24gcmVuZGVySW5wdXRMb2coKXsKICBjb25zdCBib3g9JCgiI2lucHV0bG9nIik7CiAgaWYod2F0Y2hlZENvdW50KCk9PT0wJiZsaXN0Q291bnQoKT09PTApe2JveC5pbm5lckhUTUw9IiI7cmV0dXJuO30KICBsZXQgaD0nPGRpdiBjbGFzcz0iaHIiIHN0eWxlPSJtYXJnaW46MjBweCAwIDE2cHgiPjwvZGl2PjxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtnYXA6MTBweDtmbGV4LXdyYXA6d3JhcCI+JytsaXN0QnV0dG9uSFRNTCgpK2xvZ0J1dHRvbkhUTUwoKSsnPC9kaXY+JzsKICBpZihzaG93TGlzdCloKz0nPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4nK3dhdGNobGlzdHNQYW5lbEhUTUwoKSsnPC9kaXY+JzsKICBpZihzaG93TG9nKWgrPSc8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPicrbG9nTGlzdEhUTUwoKSsnPC9kaXY+JzsKICBib3guaW5uZXJIVE1MPWg7CiAgd2lyZUxvZ0NvbnRyb2xzKGJveCk7Cn0KCi8vIC0tLS0gaW5wdXQgLS0tLQpmdW5jdGlvbiByZW5kZXJDaGlwcygpewogIGNvbnN0IGJveD0kKCIjY2hpcHMiKTsKICBib3gucXVlcnlTZWxlY3RvckFsbCgiLmNoaXAiKS5mb3JFYWNoKGU9PmUucmVtb3ZlKCkpOwogIGNvbnN0IGRyYWZ0PSQoIiNkcmFmdCIpOwogIHNob3dzLmZvckVhY2goKHMsaSk9PnsKICAgIGNvbnN0IGVsPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoInNwYW4iKTtlbC5jbGFzc05hbWU9ImNoaXAiOwogICAgZWwuaW5uZXJIVE1MPWVzYyhzKSsnIDxidXR0b24gYXJpYS1sYWJlbD0iUmVtb3ZlIj4mdGltZXM7PC9idXR0b24+JzsKICAgIGVsLnF1ZXJ5U2VsZWN0b3IoImJ1dHRvbiIpLm9uY2xpY2s9KCk9PntzaG93cy5zcGxpY2UoaSwxKTtyZW5kZXJDaGlwcygpO307CiAgICBib3guaW5zZXJ0QmVmb3JlKGVsLGRyYWZ0KTsKICB9KTsKICBkcmFmdC5zdHlsZS5kaXNwbGF5PXNob3dzLmxlbmd0aD49MTA/Im5vbmUiOiJibG9jayI7CiAgZHJhZnQucGxhY2Vob2xkZXI9c2hvd3MubGVuZ3RoPyJBZGQgYW5vdGhlcuKApiI6IlR5cGUgYSB0aXRsZSwgcHJlc3MgRW50ZXIiOwogICQoIiNjb3VudCIpLnRleHRDb250ZW50PXNob3dzLmxlbmd0aCsiIC8gMTAiOwogICQoIiNjb3VudCIpLnN0eWxlLmNvbG9yPXNob3dzLmxlbmd0aD49MT8idmFyKC0tZ29sZCkiOiJ2YXIoLS1tdXQyKSI7CiAgY29uc3Qgb2s9c2hvd3MubGVuZ3RoPj0xOwogICQoIiNnbyIpLmRpc2FibGVkPSFvazsKICAkKCIjaGludCIpLnN0eWxlLmRpc3BsYXk9b2s/Im5vbmUiOiJibG9jayI7CiAgJCgiI2V4YW1wbGUiKS5zdHlsZS5kaXNwbGF5PXNob3dzLmxlbmd0aD8ibm9uZSI6ImJsb2NrIjsKfQpmdW5jdGlvbiBhZGREcmFmdCgpe2NvbnN0IGQ9JCgiI2RyYWZ0Iik7bGV0IHY9ZC52YWx1ZS50cmltKCkucmVwbGFjZSgvLCQvLCIiKS50cmltKCk7CiAgaWYoIXYpcmV0dXJuO2lmKHNob3dzLnNvbWUocz0+cy50b0xvd2VyQ2FzZSgpPT09di50b0xvd2VyQ2FzZSgpKSl7ZC52YWx1ZT0iIjtyZXR1cm47fQogIGlmKHNob3dzLmxlbmd0aDwxMClzaG93cy5wdXNoKHYpO2QudmFsdWU9IiI7cmVuZGVyQ2hpcHMoKTt9CiQoIiNkcmFmdCIpLmFkZEV2ZW50TGlzdGVuZXIoImtleWRvd24iLGU9PnsKICBpZihlLmtleT09PSJFbnRlciJ8fGUua2V5PT09IiwiKXtlLnByZXZlbnREZWZhdWx0KCk7YWRkRHJhZnQoKTt9CiAgZWxzZSBpZihlLmtleT09PSJCYWNrc3BhY2UiJiYhJCgiI2RyYWZ0IikudmFsdWUmJnNob3dzLmxlbmd0aCl7c2hvd3MucG9wKCk7cmVuZGVyQ2hpcHMoKTt9Cn0pOwokKCIjZXhhbXBsZSIpLm9uY2xpY2s9KCk9PntzaG93cz1bLi4uRVhBTVBMRV07cmVuZGVyQ2hpcHMoKTt9OwokKCIjZ28iKS5vbmNsaWNrPWRpc2NvdmVyOwoKCmFzeW5jIGZ1bmN0aW9uIHJlYWRKc29uKHIsZmFsbGJhY2tNc2cpewogIHZhciBjdD1yLmhlYWRlcnMuZ2V0KCJjb250ZW50LXR5cGUiKXx8IiI7CiAgaWYoY3QuaW5kZXhPZigiYXBwbGljYXRpb24vanNvbiIpPT09LTEpewogICAgdmFyIHQ9KGF3YWl0IHIudGV4dCgpKS50cmltKCk7CiAgICBpZih0LmNoYXJBdCgwKT09PSI8IikgdGhyb3cgbmV3IEVycm9yKCJUaGUgc2VydmVyIGlzIHdha2luZyB1cCBcdTIwMTQgdGhlIGZyZWUgaG9zdGluZyBwbGFuIHNsZWVwcyBhZnRlciAxNSBtaW51dGVzIG9mIG5vIHVzZS4gUGxlYXNlIHdhaXQgdXAgdG8gYSBtaW51dGUsIHRoZW4gcHJlc3MgdGhlIGJ1dHRvbiBhZ2Fpbi4iKTsKICAgIHRocm93IG5ldyBFcnJvcih0LnNsaWNlKDAsMjAwKXx8ZmFsbGJhY2tNc2d8fCgiUmVxdWVzdCBmYWlsZWQgKCIrci5zdGF0dXMrIikiKSk7CiAgfQogIHZhciBqPWF3YWl0IHIuanNvbigpOwogIGlmKCFyLm9rKSB0aHJvdyBuZXcgRXJyb3Ioai5lcnJvcnx8ZmFsbGJhY2tNc2d8fCJSZXF1ZXN0IGZhaWxlZCIpOwogIHJldHVybiBqOwp9Cgphc3luYyBmdW5jdGlvbiBkaXNjb3ZlcihvdmVycmlkZVNlZWRzLGZvY3VzKXsKICBhY3RpdmVTZWVkcz0ob3ZlcnJpZGVTZWVkcyYmb3ZlcnJpZGVTZWVkcy5sZW5ndGgpP292ZXJyaWRlU2VlZHM6c2hvd3Muc2xpY2UoKTthY3RpdmVGb2N1cz0hIWZvY3VzOwogIGNvbnN0IHJlc3VsdHM9JCgiI3Jlc3VsdHMiKSwgaW5wdXQ9JCgiI2lucHV0Iik7CiAgaW5wdXQuc3R5bGUuZGlzcGxheT0ibm9uZSI7cmVzdWx0cy5zdHlsZS5kaXNwbGF5PSJibG9jayI7c2hvd0xvZz1mYWxzZTtleGhhdXN0ZWQ9ZmFsc2U7bG9hZGluZ01vcmU9ZmFsc2U7c2tpcHBlZD1bXTsKICByZXN1bHRzLmlubmVySFRNTD0nPGRpdiBjbGFzcz0ibG9hZCIgc3R5bGU9ImNvbG9yOnZhcigtLW11dCk7dGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzo0MHB4IDAiPlJlYWRpbmcgeW91ciB0YXN0ZSwgcHVsbGluZyByZWFsIHJhdGluZ3MgJmFtcDsgYXZhaWxhYmlsaXR54oCmPC9kaXY+JzsKICBmaWx0ZXJzPXt0eXBlOiJhbGwiLG1pbjowLHN2Y3M6W10sc29ydDoibWF0Y2gifTsKICB0cnl7CiAgICBjb25zdCByPWF3YWl0IGZldGNoKCIvYXBpL2Rpc2NvdmVyIix7bWV0aG9kOiJQT1NUIixoZWFkZXJzOnsiQ29udGVudC1UeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LAogICAgICBib2R5OkpTT04uc3RyaW5naWZ5KHtsb3ZlZDphY3RpdmVTZWVkcyxmb2N1czphY3RpdmVGb2N1cyxjb3VudHJ5OnJlZ2lvblNlbC52YWx1ZSx0eXBlOnR5cGVTZWwudmFsdWUsZ2VucmU6Z2VucmVTZWwudmFsdWUsd2F0Y2hlZDp3YXRjaGVkTWFwfSl9KTsKICAgIGNvbnN0IGo9YXdhaXQgcmVhZEpzb24ociwiUmVxdWVzdCBmYWlsZWQiKTsKICAgIGRhdGE9ajtyZW5kZXIoKTsKICB9Y2F0Y2goZSl7CiAgICByZXN1bHRzLmlubmVySFRNTD0nPGRpdiBjbGFzcz0icmMiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlciI+PGRpdiBzdHlsZT0ibWFyZ2luLWJvdHRvbToxNHB4Ij4nK2VzYyhlLm1lc3NhZ2UpKyc8L2Rpdj48YnV0dG9uIGNsYXNzPSJjdGEiIG9uY2xpY2s9ImRpc2NvdmVyKCkiPlRyeSBhZ2FpbjwvYnV0dG9uPjwvZGl2Pic7CiAgfQp9CgpmdW5jdGlvbiBvYnNlcnZlU2VudGluZWwoKXsKICBpZihpbylpby5kaXNjb25uZWN0KCk7CiAgY29uc3QgZWw9JCgiI3NlbnRpbmVsIik7IGlmKCFlbClyZXR1cm47CiAgaW89bmV3IEludGVyc2VjdGlvbk9ic2VydmVyKGVzPT57IGlmKGVzWzBdLmlzSW50ZXJzZWN0aW5nKSBsb2FkTW9yZSgpOyB9LHtyb290TWFyZ2luOiI1MDBweCJ9KTsKICBpby5vYnNlcnZlKGVsKTsKfQphc3luYyBmdW5jdGlvbiBsb2FkTW9yZSgpewogIGlmKGxvYWRpbmdNb3JlfHxleGhhdXN0ZWR8fCFkYXRhKXJldHVybjsKICBsb2FkaW5nTW9yZT10cnVlOyByZW5kZXIoKTsKICB0cnl7CiAgICBjb25zdCBleGNsdWRlPWRhdGEucmVzdWx0cy5tYXAoeD0+eC50aXRsZSkuY29uY2F0KHNraXBwZWQpOwogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9kaXNjb3ZlciIse21ldGhvZDoiUE9TVCIsaGVhZGVyczp7IkNvbnRlbnQtVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7bG92ZWQ6YWN0aXZlU2VlZHMsZm9jdXM6YWN0aXZlRm9jdXMsY291bnRyeTpyZWdpb25TZWwudmFsdWUsZXhjbHVkZSx0eXBlOnR5cGVTZWwudmFsdWUsZ2VucmU6Z2VucmVTZWwudmFsdWUsd2F0Y2hlZDp3YXRjaGVkTWFwfSl9KTsKICAgIGNvbnN0IGo9YXdhaXQgcmVhZEpzb24ociwiQ291bGRuJ3QgbG9hZCBtb3JlIik7CiAgICBjb25zdCBoYXZlPW5ldyBTZXQoZGF0YS5yZXN1bHRzLm1hcCh4PT5ucm0oeC50aXRsZSkpKTsKICAgIGNvbnN0IGFkZD0oai5yZXN1bHRzfHxbXSkuZmlsdGVyKHg9PiFoYXZlLmhhcyhucm0oeC50aXRsZSkpKTsKICAgIGlmKGFkZC5sZW5ndGg9PT0wKXtleGhhdXN0ZWQ9dHJ1ZTt9IGVsc2Uge2RhdGEucmVzdWx0cz1kYXRhLnJlc3VsdHMuY29uY2F0KGFkZCk7fQogIH1jYXRjaChlKXsgZXhoYXVzdGVkPXRydWU7IH0KICBsb2FkaW5nTW9yZT1mYWxzZTsgcmVuZGVyKCk7Cn0KCmZ1bmN0aW9uIG1ldGVyKHZhbCxwY3QsZGlzcCxsYWIpewogIHJldHVybiAnPGRpdiBjbGFzcz0ic2MiPjxkaXYgY2xhc3M9ImxhYiI+JytsYWIrJzwvZGl2PjxkaXYgY2xhc3M9InZhbCIgc3R5bGU9ImNvbG9yOicrKHZhbD09bnVsbD8idmFyKC0tbXV0MikiOiJ2YXIoLS10ZXh0KSIpKyciPicrZGlzcCsnPC9kaXY+PGRpdiBjbGFzcz0ibWV0ZXIiPjxpIHN0eWxlPSJ3aWR0aDonKyhwY3Q9PW51bGw/MDpNYXRoLm1heCgzLE1hdGgubWluKDEwMCxwY3QpKSkrJyU7YmFja2dyb3VuZDonK3Njb3JlQ29sb3IocGN0KSsnIj48L2k+PC9kaXY+PC9kaXY+JzsKfQoKZnVuY3Rpb24gdmlkc0hUTUwoeCl7CiAgaWYoIXgudmlkZW9zfHwheC52aWRlb3MubGVuZ3RoKXJldHVybiAnJzsKICB2YXIgdD14LnZpZGVvcy5zbGljZSgwLDgpLm1hcChmdW5jdGlvbih2KXtyZXR1cm4gJzxidXR0b24gY2xhc3M9InZ0aHVtYiIgZGF0YS1hY3Q9InRyYWlsZXIiIGRhdGEta2V5PSInK2VzYyh2LmtleSkrJyIgdGl0bGU9IicrZXNjKHYubmFtZXx8di50eXBlfHwnVmlkZW8nKSsnIj48c3BhbiBjbGFzcz0idnRodW1iLWltZyIgc3R5bGU9ImJhY2tncm91bmQtaW1hZ2U6dXJsKGh0dHBzOi8vaW1nLnlvdXR1YmUuY29tL3ZpLycrZXNjKHYua2V5KSsnL21xZGVmYXVsdC5qcGcpIj48c3BhbiBjbGFzcz0idnBsYXkiPuKWtjwvc3Bhbj48L3NwYW4+PHNwYW4gY2xhc3M9InZjYXAiPicrZXNjKHYubmFtZXx8di50eXBlfHwnVmlkZW8nKSsnPC9zcGFuPjwvYnV0dG9uPic7fSkuam9pbignJyk7CiAgcmV0dXJuICc8ZGl2IGNsYXNzPSJociI+PC9kaXY+PGRpdiBjbGFzcz0ibGFiMiI+VHJhaWxlcnMgJiB0ZWFzZXJzPC9kaXY+PGRpdiBjbGFzcz0idnJvdyI+Jyt0Kyc8L2Rpdj4nOwp9CmZ1bmN0aW9uIGNhcmQoeCl7CiAgY29uc3QgaWQ9bnJtKHgudGl0bGUpLCB3PXdhdGNoZWRNYXBbaWRdOwogIGNvbnN0IFNWQ1M9W3tpZDoibmV0ZmxpeCIscmU6L25ldGZsaXgvaSxsYWJlbDoiTmV0ZmxpeCIsbWFyazoiTiIsYmc6IiNFNTA5MTQiLGZnOiIjZmZmIn0se2lkOiJwcmltZSIscmU6L3ByaW1lfGFtYXpvbi9pLGxhYmVsOiJQcmltZSBWaWRlbyIsbWFyazoiUCIsYmc6IiMwMEE4RTEiLGZnOiIjMDAyNDNkIn0se2lkOiJkaXNuZXkiLHJlOi9kaXNuZXkvaSxsYWJlbDoiRGlzbmV5KyIsbWFyazoiRCsiLGJnOiIjMEMxQTZCIixmZzoiI2ZmZiJ9LHtpZDoiYXBwbGUiLHJlOi9hcHBsZS9pLGxhYmVsOiJBcHBsZSBUViIsbWFyazoiVFYiLGJnOiIjMTExIixmZzoiI2ZmZiJ9XTsKICBjb25zdCBzdmNzPXguc2VydmljZXN8fFtdOwogIGNvbnN0IGljb25zPVNWQ1MubWFwKGZ1bmN0aW9uKHN2KXt2YXIgaGl0PXN2Y3MuZmluZChmdW5jdGlvbihzKXtyZXR1cm4gcyYmKChzLmlkPT09c3YuaWQpfHwocy5uYW1lJiZzdi5yZS50ZXN0KHMubmFtZSkpKTt9KTt2YXIgb249ISFoaXQsbGluaz1oaXQmJmhpdC5saW5rO3ZhciBpYz0nPHNwYW4gY2xhc3M9InN2Y2ljb24nKyhvbj8nJzonIG9mZicpKyciJysob24/JyBzdHlsZT0iYmFja2dyb3VuZDonK3N2LmJnKyc7Y29sb3I6Jytzdi5mZysnO2JvcmRlci1jb2xvcjp0cmFuc3BhcmVudCInOicnKSsnIHRpdGxlPSInK3N2LmxhYmVsKyhvbj8nIOKAlCBhdmFpbGFibGUnOicg4oCUIG5vdCBhdmFpbGFibGUnKSsnIj4nK3N2Lm1hcmsrJzwvc3Bhbj4nO3JldHVybiAob24mJmxpbmspPyc8YSBocmVmPSInK2VzYyhsaW5rKSsnIiB0YXJnZXQ9Il9ibGFuayIgcmVsPSJub29wZW5lciIgc3R5bGU9InRleHQtZGVjb3JhdGlvbjpub25lIj4nK2ljKyc8L2E+JzppYzt9KS5qb2luKCIiKTsKICBjb25zdCBleHRyYT1zdmNzLmZpbHRlcihmdW5jdGlvbihzKXtyZXR1cm4gcyYmIVNWQ1Muc29tZShmdW5jdGlvbihzdil7cmV0dXJuIChzLmlkPT09c3YuaWQpfHwocy5uYW1lJiZzdi5yZS50ZXN0KHMubmFtZSkpO30pO30pOwogIHZhciByZm91bmQ9UkVHSU9OUy5maW5kKGZ1bmN0aW9uKHIpe3JldHVybiByWzBdPT09KHguY291bnRyeXx8IiIpLnRvTG93ZXJDYXNlKCk7fSk7CiAgdmFyIHJlZ2lvbk5hbWU9cmZvdW5kP3Jmb3VuZFsxXTooKHguY291bnRyeXx8IiIpLnRvVXBwZXJDYXNlKCkpOwogIHZhciB3YXRjaD0nPGRpdiBjbGFzcz0ibGFiMiI+V2hlcmUgdG8gd2F0Y2ggaW4gJytlc2MocmVnaW9uTmFtZSkrJzwvZGl2PjxkaXYgY2xhc3M9InN2Y3JvdyI+JytpY29ucysnPC9kaXY+JzsKICBpZihleHRyYS5sZW5ndGgpd2F0Y2grPSc8ZGl2IHN0eWxlPSJmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tdG9wOjhweCI+QWxzbyBvbiAnK2V4dHJhLnNsaWNlKDAsNCkubWFwKGZ1bmN0aW9uKHMpe3JldHVybiBlc2Mocy5uYW1lKTt9KS5qb2luKCIsICIpKyc8L2Rpdj4nOwogIGlmKCFzdmNzLmxlbmd0aCl3YXRjaCs9JzxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi10b3A6OHB4Ij5ObyBzdHJlYW1pbmcgaW5mbyBmb3IgJytlc2MocmVnaW9uTmFtZSkrJyByaWdodCBub3cuPC9kaXY+JzsKICBjb25zdCBpbkxpc3RzPWxpc3RzRm9yVGl0bGUoaWQpLCBvbkFueT1pbkxpc3RzLmxlbmd0aD4wOwogIGNvbnN0IG1lbnVSb3dzPU9iamVjdC52YWx1ZXMod2F0Y2hsaXN0cykuc29ydCgoYSxiKT0+KGEudHN8fDApLShiLnRzfHwwKSkubWFwKEw9Pic8YnV0dG9uIGNsYXNzPSJsbWknKyh0aXRsZUluTGlzdChMLmlkLGlkKT8nIG9uJzonJykrJyIgZGF0YS1hY3Q9InRvbGlzdCIgZGF0YS1saXN0PSInK2VzYyhMLmlkKSsnIiBkYXRhLWlkPSInK2VzYyhpZCkrJyI+JysodGl0bGVJbkxpc3QoTC5pZCxpZCk/J+KckyAnOicrICcpK2VzYyhMLm5hbWUpKyc8L2J1dHRvbj4nKS5qb2luKCIiKTsKICBjb25zdCBsaXN0QnRuPSc8ZGl2IGNsYXNzPSJ3bHdyYXAiPjxidXR0b24gY2xhc3M9IndsJysob25Bbnk/JyBvbic6JycpKyciIGRhdGEtYWN0PSJtZW51IiBkYXRhLWlkPSInK2VzYyhpZCkrJyI+Jysob25Bbnk/J+KckyBPbiB5b3VyIGxpc3RzIOKWvic6JysgQWRkIHRvIGxpc3Qg4pa+JykrJzwvYnV0dG9uPjxkaXYgY2xhc3M9ImxtZW51Ij4nK21lbnVSb3dzKyc8YnV0dG9uIGNsYXNzPSJsbWkgbmV3IiBkYXRhLWFjdD0ibmV3bGlzdCIgZGF0YS1pZD0iJytlc2MoaWQpKyciPisgTmV3IGxpc3TigKY8L2J1dHRvbj48L2Rpdj48L2Rpdj4nOwogIGxldCBzZWVuOwogIGlmKHcpewogICAgc2Vlbj0nPGRpdiBjbGFzcz0ic2VlbnJvdyIgc3R5bGU9Imp1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuIj48c3BhbiBjbGFzcz0id2F0Y2hlZHRhZyIgc3R5bGU9ImNvbG9yOicrKHcubGlrZWQ/J3ZhcigtLWdvb2QpJzondmFyKC0tYmFkKScpKyciPuKckyBXYXRjaGVkIMK3ICcrKHcubGlrZWQ/J0xvdmVkIGl0JzonTm90IGZvciBtZScpKyc8L3NwYW4+JwogICAgICArJzxidXR0b24gY2xhc3M9InVuZG8iIGRhdGEtYWN0PSJ1bndhdGNoIiBkYXRhLWlkPSInK2VzYyhpZCkrJyI+dW5kbzwvYnV0dG9uPjwvZGl2Pic7CiAgfWVsc2V7CiAgICBzZWVuPSc8ZGl2IGNsYXNzPSJzZWVucm93Ij48YnV0dG9uIGNsYXNzPSJza2lwIiBkYXRhLWFjdD0ic2tpcCIgZGF0YS1pZD0iJytlc2MoaWQpKyciPuKclSBTa2lwPC9idXR0b24+JwogICAgICArJzxzcGFuIHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tbGVmdDphdXRvO21hcmdpbi1yaWdodDoycHgiPlNlZW4gaXQ/PC9zcGFuPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJyYXRlIHVwIiBkYXRhLWFjdD0ibGlrZSIgZGF0YS1pZD0iJytlc2MoaWQpKyciPvCfkY0gTG92ZWQgaXQ8L2J1dHRvbj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0icmF0ZSBkb3duIiBkYXRhLWFjdD0iZGlzbGlrZSIgZGF0YS1pZD0iJytlc2MoaWQpKyciPvCfkY4gTm90IGZvciBtZTwvYnV0dG9uPjwvZGl2Pic7CiAgfQogIGNvbnN0IGZvb3Q9JzxkaXYgY2xhc3M9ImZvb3QiPicrbGlzdEJ0bisnPGJ1dHRvbiBjbGFzcz0ibW9yZWxpa2UiIGRhdGEtYWN0PSJtb3JlbGlrZSIgZGF0YS10aXRsZT0iJytlc2MoeC50aXRsZSkrJyI+4pyoIE1vcmUgbGlrZSB0aGlzPC9idXR0b24+JytzZWVuKyc8L2Rpdj4nOwogIHJldHVybiAnPGRpdiBjbGFzcz0icmMnKyh3Pycgc2Vlbic6JycpKyciPjxkaXYgY2xhc3M9ImhlYWQiPicrKHgucG9zdGVyPyc8aW1nIGNsYXNzPSJwb3N0ZXIiIHNyYz0iJytlc2MoeC5wb3N0ZXIpKyciIGFsdD0iIiBsb2FkaW5nPSJsYXp5IiBvbmVycm9yPSJ0aGlzLnN0eWxlLmRpc3BsYXk9XCdub25lXCciPic6JzxkaXYgY2xhc3M9InBvc3RlciBwaCI+bm8gYXJ0d29yazwvZGl2PicpKyc8ZGl2IGNsYXNzPSJoZWFkbWV0YSI+PGRpdiBjbGFzcz0ia2lja2VyIj4nK2VzYyh4LnR5cGUpKyh4LnllYXI/JyDCtyAnK2VzYyh4LnllYXIpOicnKSsnPC9kaXY+PGRpdiBjbGFzcz0icnQtdGl0bGUiPicrZXNjKHgudGl0bGUpKyc8L2Rpdj48ZGl2IGNsYXNzPSJyZWFzb24iPicrZXNjKHgucmVhc29uKSsnPC9kaXY+PC9kaXY+PC9kaXY+JwogICAgKyh4Lm92ZXJ2aWV3Pyc8ZGl2IGNsYXNzPSJ3cml0ZXVwIj4nK2VzYyh4Lm92ZXJ2aWV3KSsnPC9kaXY+JzonJykKICAgICsnPGRpdiBjbGFzcz0iaHIiPjwvZGl2PjxkaXYgY2xhc3M9InNjb3JlcyI+JwogICAgKyBtZXRlcih4LmltZGIsIHguaW1kYiE9bnVsbD94LmltZGIqMTA6bnVsbCwgeC5pbWRiIT1udWxsP051bWJlcih4LmltZGIpLnRvRml4ZWQoMSk6IuKAlCIsIklNRGIiKQogICAgKyBtZXRlcih4LnRtZGIsIHgudG1kYiE9bnVsbD94LnRtZGIqMTA6bnVsbCwgeC50bWRiIT1udWxsP051bWJlcih4LnRtZGIpLnRvRml4ZWQoMSk6IuKAlCIsIlRNRGIiKQogICAgKyc8L2Rpdj48ZGl2IGNsYXNzPSJociI+PC9kaXY+Jyt3YXRjaCsnPGRpdiBjbGFzcz0iaHIiPjwvZGl2PicrZm9vdCt2aWRzSFRNTCh4KSsnPC9kaXY+JzsKfQoKZnVuY3Rpb24gc2VnKG5hbWUsb3B0cyxjdXIpewogIHJldHVybiAnPGRpdj48ZGl2IGNsYXNzPSJsYWIyIj4nK25hbWUubGFiZWwrJzwvZGl2PjxkaXYgY2xhc3M9InNlZyI+JytvcHRzLm1hcChvPT4KICAgICc8YnV0dG9uIGNsYXNzPSInKyhvLnY9PT1jdXI/Im9uIjoiIikrJyIgZGF0YS1rPSInK25hbWUua2V5KyciIGRhdGEtdj0iJytvLnYrJyI+JytvLnQrJzwvYnV0dG9uPicpLmpvaW4oIiIpKyc8L2Rpdj48L2Rpdj4nOwp9CgpmdW5jdGlvbiByZW5kZXIoKXsKICBjb25zdCByZXN1bHRzPSQoIiNyZXN1bHRzIik7CiAgbGV0IGxpc3Q9ZGF0YS5yZXN1bHRzLmZpbHRlcih4PT57CiAgICBpZihmaWx0ZXJzLnR5cGUhPT0iYWxsIiYmeC50eXBlLnRvTG93ZXJDYXNlKCkhPT1maWx0ZXJzLnR5cGUpcmV0dXJuIGZhbHNlOwogICAgaWYoZmlsdGVycy5zdmNzLmxlbmd0aCl7dmFyIG9rUz1maWx0ZXJzLnN2Y3Muc29tZShmdW5jdGlvbihpZCl7dmFyIHJlPWlkPT09Im5ldGZsaXgiPy9uZXRmbGl4L2k6aWQ9PT0icHJpbWUiPy9wcmltZXxhbWF6b24vaTppZD09PSJkaXNuZXkiPy9kaXNuZXkvaTovYXBwbGUvaTtyZXR1cm4gKHguc2VydmljZXN8fFtdKS5zb21lKGZ1bmN0aW9uKHMpe3JldHVybiBzJiYoKHMuaWQ9PT1pZCl8fChzLm5hbWUmJnJlLnRlc3Qocy5uYW1lKSkpO30pfHwoaWQ9PT0ibmV0ZmxpeCImJngub25OZXRmbGl4PT09dHJ1ZSk7fSk7aWYoIW9rUylyZXR1cm4gZmFsc2U7fQogICAgaWYoZmlsdGVycy5taW4+MCYmKHguaW1kYj09bnVsbHx8TnVtYmVyKHguaW1kYik8ZmlsdGVycy5taW4pKXJldHVybiBmYWxzZTsKICAgIHJldHVybiB0cnVlOwogIH0pOwogIGlmKGZpbHRlcnMuc29ydD09PSJpbWRiIilsaXN0PVsuLi5saXN0XS5zb3J0KChhLGIpPT4oYi5pbWRifHwtMSktKGEuaW1kYnx8LTEpKTsKICBpZihmaWx0ZXJzLnNvcnQ9PT0icnQiKWxpc3Q9Wy4uLmxpc3RdLnNvcnQoKGEsYik9PihiLnJ0Q3JpdGljc3x8LTEpLShhLnJ0Q3JpdGljc3x8LTEpKTsKCiAgY29uc3QgYmFyPSc8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2dhcDoxMnB4O21hcmdpbi1ib3R0b206MThweDtmbGV4LXdyYXA6d3JhcCI+JwogICAgKyc8YnV0dG9uIGNsYXNzPSJnaG9zdCIgaWQ9ImJhY2siPuKGkCBTdGFydCBvdmVyPC9idXR0b24+JwogICAgKyc8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMnB4O2ZsZXgtd3JhcDp3cmFwIj48c3BhbiBzdHlsZT0iZm9udC1zaXplOjEyLjVweDtjb2xvcjp2YXIoLS1tdXQpIj4nKyhhY3RpdmVTZWVkcy5sZW5ndGg9PT0xPygnU2ltaWxhciB0byAnK2VzYyhhY3RpdmVTZWVkc1swXSkpOignTWF0Y2hlZCB0byAnK2FjdGl2ZVNlZWRzLmxlbmd0aCsnIGxvdmVzJykpKycgwrcgTmV0ZmxpeCAnK2VzYyhkYXRhLmNvdW50cnlOYW1lKSsnPC9zcGFuPicrbGlzdEJ1dHRvbkhUTUwoKStsb2dCdXR0b25IVE1MKCkrJzwvZGl2PjwvZGl2Pic7CgogIGNvbnN0IHBhbmVsPXNob3dMb2c/JzxkaXYgY2xhc3M9ImxvZ3BhbmVsIj48ZGl2IHN0eWxlPSJmb250LXNpemU6MTFweDtsZXR0ZXItc3BhY2luZzouMWVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tYm90dG9tOjEycHgiPllvdXIgd2F0Y2ggaGlzdG9yeSDCtyBzaGFwZXMgZXZlcnkgc3VnZ2VzdGlvbjwvZGl2PicrbG9nTGlzdEhUTUwoKSsnPC9kaXY+JzonJzsKICBjb25zdCBsaXN0UGFuZWw9c2hvd0xpc3Q/JzxkaXYgY2xhc3M9ImxvZ3BhbmVsIj48ZGl2IHN0eWxlPSJmb250LXNpemU6MTFweDtsZXR0ZXItc3BhY2luZzouMWVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tYm90dG9tOjEycHgiPllvdXIgbGlzdHM8L2Rpdj4nK3dhdGNobGlzdHNQYW5lbEhUTUwoKSsnPC9kaXY+JzonJzsKCiAgY29uc3QgdG9vbGJhcj0nPGRpdiBjbGFzcz0idG9vbGJhciI+JwogICAgKyBzZWcoe2xhYmVsOiJUeXBlIixrZXk6InR5cGUifSxbe3Y6ImFsbCIsdDoiQWxsIn0se3Y6Im1vdmllIix0OiJNb3ZpZXMifSx7djoic2VyaWVzIix0OiJTZXJpZXMifV0sZmlsdGVycy50eXBlKQogICAgKyBzZWcoe2xhYmVsOiJNaW4gSU1EYiIsa2V5OiJtaW4ifSxbe3Y6MCx0OiJBbnkifSx7djo3LHQ6IjcrIn0se3Y6OCx0OiI4KyJ9XSxmaWx0ZXJzLm1pbikKICAgICsgc2VnKHtsYWJlbDoiU29ydCBieSIsa2V5OiJzb3J0In0sW3t2OiJtYXRjaCIsdDoiTWF0Y2gifSx7djoiaW1kYiIsdDoiSU1EYiJ9LHt2OiJydCIsdDoiUlQifV0sZmlsdGVycy5zb3J0KQogICAgKyAnPGRpdiBzdHlsZT0ibWFyZ2luLWxlZnQ6YXV0byI+PGRpdiBjbGFzcz0ibGFiMiI+QXZhaWxhYmxlIG9uPC9kaXY+PGRpdiBjbGFzcz0ic3ZjZmlsdGVycyI+JytbJ25ldGZsaXgnLCdwcmltZScsJ2Rpc25leScsJ2FwcGxlJ10ubWFwKGZ1bmN0aW9uKGlkKXt2YXIgbm09e25ldGZsaXg6Ik5ldGZsaXgiLHByaW1lOiJQcmltZSIsZGlzbmV5OiJEaXNuZXkrIixhcHBsZToiQXBwbGUgVFYifVtpZF07cmV0dXJuICc8YnV0dG9uIGNsYXNzPSJzdmNmJysoZmlsdGVycy5zdmNzLmluZGV4T2YoaWQpPi0xPycgb24nOicnKSsnIiBkYXRhLXN2Yz0iJytpZCsnIj4nK25tKyc8L2J1dHRvbj4nO30pLmpvaW4oIiIpKyc8L2Rpdj48L2Rpdj4nCiAgICArICc8L2Rpdj4nOwoKICBjb25zdCBib2R5PWxpc3QubGVuZ3RoCiAgICA/ICc8ZGl2IGNsYXNzPSJncmlkIj4nK2xpc3QubWFwKGNhcmQpLmpvaW4oIiIpKyc8L2Rpdj4nCiAgICA6ICc8ZGl2IHN0eWxlPSJjb2xvcjp2YXIoLS1tdXQpO3RleHQtYWxpZ246Y2VudGVyO3BhZGRpbmc6NDBweCAwIj5Ob3RoaW5nIG1hdGNoZXMgdGhlc2UgZmlsdGVycy4gTG9vc2VuIHRoZW0gdG8gc2VlIG1vcmUuPC9kaXY+JzsKCiAgY29uc3Qgbm90ZT0nPHAgY2xhc3M9Im5vdGUiPlJhdGluZ3MgdmlhIE9NRGIgKElNRGIgwrcgUm90dGVuIFRvbWF0b2VzIMK3IE1ldGFjcml0aWMpLiAnCiAgICArZXNjKGRhdGEuYXR0cmlidXRpb24pKycuIE1vcmUgbG9hZCBhdXRvbWF0aWNhbGx5IGFzIHlvdSBzY3JvbGwsIGVhY2ggYmF0Y2ggYXZvaWRpbmcgd2hhdCB5b3VcJ3ZlIGFscmVhZHkgc2Vlbi4gWW91ciB3YXRjaCBoaXN0b3J5IGlzIHNhdmVkIHNlcnZlci1zaWRlIGFuZCBmZWVkcyBldmVyeSBzdWdnZXN0aW9uLjwvcD4nOwoKICBjb25zdCBmb290ZXIgPSBleGhhdXN0ZWQKICAgID8gJzxkaXYgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLW11dDIpO2ZvbnQtc2l6ZToxM3B4O3BhZGRpbmc6MjRweCAwIDhweCI+VGhhdFwncyB0aGUgYmVzdCBvZiB3aGF0IGZpdHMgeW91ciB0YXN0ZSByaWdodCBub3cuIFJhdGUgYSBmZXcgYW5kIHN0YXJ0IG92ZXIgZm9yIGEgZnJlc2ggcmVhZC48L2Rpdj4nCiAgICA6IChsb2FkaW5nTW9yZQogICAgICAgID8gJzxkaXYgY2xhc3M9ImxvYWQiIHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjp2YXIoLS1tdXQpO2ZvbnQtc2l6ZToxMy41cHg7cGFkZGluZzoyNHB4IDAgOHB4Ij5GaW5kaW5nIG1vcmUgZm9yIHlvdeKApjwvZGl2PicKICAgICAgICA6ICc8ZGl2IHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjIwcHggMCA0cHgiPjxidXR0b24gY2xhc3M9Imdob3N0IiBpZD0ibG9hZG1vcmUiPkxvYWQgbW9yZTwvYnV0dG9uPjwvZGl2PicpOwogIGNvbnN0IHNlbnRpbmVsPSc8ZGl2IGlkPSJzZW50aW5lbCIgc3R5bGU9ImhlaWdodDoxcHgiPjwvZGl2Pic7CgogIHJlc3VsdHMuaW5uZXJIVE1MPWJhcitsaXN0UGFuZWwrcGFuZWwrdG9vbGJhcitib2R5K2Zvb3RlcitzZW50aW5lbCtub3RlOwogICQoIiNiYWNrIikub25jbGljaz0oKT0+e3Jlc3VsdHMuc3R5bGUuZGlzcGxheT0ibm9uZSI7JCgiI2lucHV0Iikuc3R5bGUuZGlzcGxheT0iYmxvY2siO307CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCcuc3ZjZicpLmZvckVhY2goZnVuY3Rpb24oYil7Yi5vbmNsaWNrPWZ1bmN0aW9uKCl7dmFyIGlkPWIuZGF0YXNldC5zdmM7dmFyIGk9ZmlsdGVycy5zdmNzLmluZGV4T2YoaWQpO2lmKGk+LTEpZmlsdGVycy5zdmNzLnNwbGljZShpLDEpO2Vsc2UgZmlsdGVycy5zdmNzLnB1c2goaWQpO3JlbmRlcigpO307fSk7CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCIuc2VnIGJ1dHRvbiIpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57CiAgICBjb25zdCBrPWIuZGF0YXNldC5rO2xldCB2PWIuZGF0YXNldC52O2lmKGs9PT0ibWluIil2PU51bWJlcih2KTtmaWx0ZXJzW2tdPXY7cmVuZGVyKCk7CiAgfSk7CiAgLy8gd2F0Y2hlZCBjb250cm9scwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJsaWtlIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+e2NvbnN0IHI9ZGF0YS5yZXN1bHRzLmZpbmQoeD0+bnJtKHgudGl0bGUpPT09Yi5kYXRhc2V0LmlkKTtpZihyKW1hcmtXYXRjaGVkKHIsdHJ1ZSx0cnVlKTt9KTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0idHJhaWxlciJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9Pm9wZW5UcmFpbGVyKGIuZGF0YXNldC5rZXkpKTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0iZGlzbGlrZSJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9Pntjb25zdCByPWRhdGEucmVzdWx0cy5maW5kKHg9Pm5ybSh4LnRpdGxlKT09PWIuZGF0YXNldC5pZCk7aWYociltYXJrV2F0Y2hlZChyLGZhbHNlLHRydWUpO30pOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJza2lwIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+e2NvbnN0IHI9ZGF0YS5yZXN1bHRzLmZpbmQoeD0+bnJtKHgudGl0bGUpPT09Yi5kYXRhc2V0LmlkKTtpZihyKXNraXBUaXRsZShyKTt9KTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ibW9yZWxpa2UiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5kaXNjb3ZlcihbYi5kYXRhc2V0LnRpdGxlXSx0cnVlKSk7CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Im1lbnUiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57Y29uc3QgbW09Yi5wYXJlbnRFbGVtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sbWVudScpO2lmKG1tKW1tLmNsYXNzTGlzdC50b2dnbGUoJ29wZW4nKTt9KTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0idG9saXN0Il0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+e2NvbnN0IHI9ZGF0YS5yZXN1bHRzLmZpbmQoeD0+bnJtKHgudGl0bGUpPT09Yi5kYXRhc2V0LmlkKTtpZihyKXRvZ2dsZVRpdGxlSW5MaXN0KGIuZGF0YXNldC5saXN0LHIpO30pOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJuZXdsaXN0Il0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+e2NvbnN0IHI9ZGF0YS5yZXN1bHRzLmZpbmQoeD0+bnJtKHgudGl0bGUpPT09Yi5kYXRhc2V0LmlkKTtpZihyKW5ld0xpc3RGb3JDYXJkKHIpO30pOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJ1bndhdGNoIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+cmVtb3ZlV2F0Y2hlZChiLmRhdGFzZXQuaWQpKTsKICB3aXJlTG9nQ29udHJvbHMocmVzdWx0cyk7CiAgY29uc3QgbG09JCgiI2xvYWRtb3JlIik7IGlmKGxtKWxtLm9uY2xpY2s9bG9hZE1vcmU7CiAgb2JzZXJ2ZVNlbnRpbmVsKCk7Cn0KCmZ1bmN0aW9uIG9wZW5UcmFpbGVyKGtleSl7dmFyIGY9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRmcmFtZSIpO2lmKGYpZi5zcmM9Imh0dHBzOi8vd3d3LnlvdXR1YmUuY29tL2VtYmVkLyIra2V5KyI/YXV0b3BsYXk9MSI7dmFyIG1tPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0bW9kYWwiKTtpZihtbSltbS5jbGFzc0xpc3QuYWRkKCJvcGVuIik7fQpmdW5jdGlvbiBjbG9zZVRyYWlsZXIoKXt2YXIgZj1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidGZyYW1lIik7aWYoZilmLnNyYz0iIjt2YXIgbW09ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRtb2RhbCIpO2lmKG1tKW1tLmNsYXNzTGlzdC5yZW1vdmUoIm9wZW4iKTt9CnZhciBkZXRhaWxPYmo9bnVsbDsKZnVuY3Rpb24gd2lyZURldGFpbChzY29wZSl7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJ0cmFpbGVyIl0nKS5mb3JFYWNoKGZ1bmN0aW9uKGIpe2Iub25jbGljaz1mdW5jdGlvbigpe29wZW5UcmFpbGVyKGIuZGF0YXNldC5rZXkpO307fSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJtZW51Il0nKS5mb3JFYWNoKGZ1bmN0aW9uKGIpe2Iub25jbGljaz1mdW5jdGlvbigpe3ZhciBtbT1iLnBhcmVudEVsZW1lbnQucXVlcnlTZWxlY3RvcignLmxtZW51Jyk7aWYobW0pbW0uY2xhc3NMaXN0LnRvZ2dsZSgnb3BlbicpO307fSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJ0b2xpc3QiXScpLmZvckVhY2goZnVuY3Rpb24oYil7Yi5vbmNsaWNrPWZ1bmN0aW9uKCl7aWYoZGV0YWlsT2JqKXRvZ2dsZVRpdGxlSW5MaXN0KGIuZGF0YXNldC5saXN0LGRldGFpbE9iaik7cmVmcmVzaERldGFpbCgpO307fSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJuZXdsaXN0Il0nKS5mb3JFYWNoKGZ1bmN0aW9uKGIpe2Iub25jbGljaz1mdW5jdGlvbigpe2lmKGRldGFpbE9iailuZXdMaXN0Rm9yQ2FyZChkZXRhaWxPYmopO3JlZnJlc2hEZXRhaWwoKTt9O30pOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ibGlrZSJdJykuZm9yRWFjaChmdW5jdGlvbihiKXtiLm9uY2xpY2s9ZnVuY3Rpb24oKXtpZihkZXRhaWxPYmopbWFya1dhdGNoZWQoZGV0YWlsT2JqLHRydWUpO3JlZnJlc2hEZXRhaWwoKTt9O30pOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0iZGlzbGlrZSJdJykuZm9yRWFjaChmdW5jdGlvbihiKXtiLm9uY2xpY2s9ZnVuY3Rpb24oKXtpZihkZXRhaWxPYmopbWFya1dhdGNoZWQoZGV0YWlsT2JqLGZhbHNlKTtyZWZyZXNoRGV0YWlsKCk7fTt9KTsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9InVud2F0Y2giXScpLmZvckVhY2goZnVuY3Rpb24oYil7Yi5vbmNsaWNrPWZ1bmN0aW9uKCl7dW53YXRjaChiLmRhdGFzZXQuaWQpO3JlZnJlc2hEZXRhaWwoKTt9O30pOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ic2tpcCJdJykuZm9yRWFjaChmdW5jdGlvbihiKXtiLm9uY2xpY2s9ZnVuY3Rpb24oKXtpZihkZXRhaWxPYmopc2tpcFRpdGxlKGRldGFpbE9iaik7Y2xvc2VEZXRhaWwoKTt9O30pOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ibW9yZWxpa2UiXScpLmZvckVhY2goZnVuY3Rpb24oYil7Yi5vbmNsaWNrPWZ1bmN0aW9uKCl7Y2xvc2VEZXRhaWwoKTtkaXNjb3ZlcihbYi5kYXRhc2V0LnRpdGxlXSx0cnVlKTt9O30pOwp9CmZ1bmN0aW9uIHJlZnJlc2hEZXRhaWwoKXt2YXIgYm9keT1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZGV0YWlsLWJvZHkiKTtpZihib2R5JiZkZXRhaWxPYmope2JvZHkuaW5uZXJIVE1MPWNhcmQoZGV0YWlsT2JqKTt3aXJlRGV0YWlsKGJvZHkpO319CmZ1bmN0aW9uIG9wZW5EZXRhaWwoZW50cnkpewogIHZhciBib2R5PWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJkZXRhaWwtYm9keSIpLG1tPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJkbW9kYWwiKTsKICBpZighYm9keXx8IW1tfHwhZW50cnkpcmV0dXJuOwogIGJvZHkuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJsb2FkIiBzdHlsZT0icGFkZGluZzozNHB4IDIwcHg7dGV4dC1hbGlnbjpjZW50ZXI7Y29sb3I6dmFyKC0tbXV0KSI+TG9hZGluZyBkZXRhaWxz4oCmPC9kaXY+JzsKICBtbS5jbGFzc0xpc3QuYWRkKCJvcGVuIik7CiAgdmFyIHR5PShlbnRyeS50eXBlfHwiIikudG9Mb3dlckNhc2UoKTt0eT10eT09PSJzZXJpZXMiPyJzZXJpZXMiOnR5PT09Im1vdmllIj8ibW92aWUiOiIiOwogIGZldGNoKCIvYXBpL3RpdGxlIix7bWV0aG9kOiJQT1NUIixoZWFkZXJzOnsiQ29udGVudC1UeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LGJvZHk6SlNPTi5zdHJpbmdpZnkoe3RpdGxlOmVudHJ5LnRpdGxlLHllYXI6ZW50cnkueWVhcnx8IiIsdHlwZTp0eSxjb3VudHJ5OnJlZ2lvblNlbC52YWx1ZX0pfSkKICAgIC50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiByLmpzb24oKS50aGVuKGZ1bmN0aW9uKGope2lmKCFyLm9rKXRocm93IG5ldyBFcnJvcihqLmVycm9yfHwiTG9va3VwIGZhaWxlZCIpO3JldHVybiBqO30pO30pCiAgICAudGhlbihmdW5jdGlvbihqKXtkZXRhaWxPYmo9ai5yZXN1bHQ7Ym9keS5pbm5lckhUTUw9Y2FyZChqLnJlc3VsdCk7d2lyZURldGFpbChib2R5KTt9KQogICAgLmNhdGNoKGZ1bmN0aW9uKGUpe2JvZHkuaW5uZXJIVE1MPSc8ZGl2IHN0eWxlPSJwYWRkaW5nOjI0cHg7dGV4dC1hbGlnbjpjZW50ZXIiPjxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206MTJweDtjb2xvcjp2YXIoLS10ZXh0KSI+Jytlc2MoZS5tZXNzYWdlKSsnPC9kaXY+PGJ1dHRvbiBjbGFzcz0iZ2hvc3QiIG9uY2xpY2s9ImNsb3NlRGV0YWlsKCkiPkNsb3NlPC9idXR0b24+PC9kaXY+Jzt9KTsKfQpmdW5jdGlvbiBjbG9zZURldGFpbCgpe2RldGFpbE9iaj1udWxsO3ZhciBtbT1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZG1vZGFsIik7aWYobW0pbW0uY2xhc3NMaXN0LnJlbW92ZSgib3BlbiIpO3ZhciBiPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJkZXRhaWwtYm9keSIpO2lmKGIpYi5pbm5lckhUTUw9IiI7fQp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsZnVuY3Rpb24oZSl7aWYoZS5rZXk9PT0iRXNjYXBlIil7dmFyIHQ9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRtb2RhbCIpO2lmKHQmJnQuY2xhc3NMaXN0LmNvbnRhaW5zKCJvcGVuIikpY2xvc2VUcmFpbGVyKCk7ZWxzZSBjbG9zZURldGFpbCgpO319KTsKcmVuZGVyQ2hpcHMoKTsKbG9hZFdhdGNoZWQoKTsKbG9hZFdhdGNobGlzdHMoKTsKCnZhciBfcz1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic3RhdHVzIik7aWYoX3Mpe19zLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjtfcy5zdHlsZS5iYWNrZ3JvdW5kPSIjMTIyODFjIjtfcy5zdHlsZS5ib3JkZXI9IjFweCBzb2xpZCAjMmY1YTNkIjtfcy5zdHlsZS5jb2xvcj0iI2JmZThjZiI7X3MudGV4dENvbnRlbnQ9IlJlYWR5IFx1MjAxNCB0eXBlIGEgdGl0bGUsIHByZXNzIEVudGVyLCBhZGQgYXQgbGVhc3QgMy4iO30KPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=", "base64").toString("utf8");

app.get("/", (_req, res) => res.type("html").send(PAGE));

app.listen(PORT, () => console.log(`What Next server → http://localhost:${PORT}`));
