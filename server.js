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
    const r = await fetch(u);
    const d = await r.json();
    if (d.Response === "False") return null;
    return {
      imdb: d.imdbRating && d.imdbRating !== "N/A" ? Number(d.imdbRating) : null,
      rtCritics: pctFromRatings(d.Ratings, "Rotten Tomatoes"),
      metascore: d.Metascore && d.Metascore !== "N/A" ? Number(d.Metascore) : null,
      poster: d.Poster && d.Poster !== "N/A" ? d.Poster : null,
      plot: d.Plot && d.Plot !== "N/A" ? d.Plot : null,
    };
  } catch { return null; }
}

async function omdbByTitle(title, year, media) {
  if (!OMDB_API_KEY || !title) return null;
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
    return {
      imdb: d.imdbRating && d.imdbRating !== "N/A" ? Number(d.imdbRating) : null,
      rtCritics: pctFromRatings(d.Ratings, "Rotten Tomatoes"),
      metascore: d.Metascore && d.Metascore !== "N/A" ? Number(d.Metascore) : null,
      poster: d.Poster && d.Poster !== "N/A" ? d.Poster : null,
      plot: d.Plot && d.Plot !== "N/A" ? d.Plot : null,
    };
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
  let omdb = imdbID ? await omdbByImdb(imdbID) : null;
  if (!omdb) omdb = await omdbByTitle(tTitle(raw), tYear(raw), media);
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

const PAGE = Buffer.from("PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPgo8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEiIC8+Cjx0aXRsZT5XaGF0IE5leHQgwrcgTmV0ZmxpeCB0YXN0ZS1tYXRjaGVyPC90aXRsZT4KPHN0eWxlPgogIDpyb290ewogICAgLS1iZzojMEUxMTE2OyAtLWJnMjojMTIxNjFDOyAtLWNhcmQ6IzE3MUMyNDsgLS1jYXJkSGk6IzFDMjIyQjsKICAgIC0tbGluZTojMjcyRTM5OyAtLWdvbGQ6I0U4QjQ0QTsgLS10ZXh0OiNGMkVERTM7IC0tbXV0OiM4QjkzQTA7IC0tbXV0MjojNUM2NDcwOwogICAgLS1nb29kOiM0RkI0Nzc7IC0tbWlkOiNFOEI0NEE7IC0tYmFkOiNFMDU3NEI7IC0tbmV0OiM0RkI0Nzc7CiAgfQogICp7Ym94LXNpemluZzpib3JkZXItYm94fQogIGJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7CiAgICBmb250LWZhbWlseTotYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwnU2Vnb2UgVUknLFJvYm90byxzYW5zLXNlcmlmO30KICAud3JhcHttYXgtd2lkdGg6OTQwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjQwcHggMjJweCA3MnB4fQogIC5leWVicm93e2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4yMmVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1nb2xkKTttYXJnaW4tYm90dG9tOjEwcHh9CiAgaDF7Zm9udC1mYW1pbHk6dWktc2VyaWYsR2VvcmdpYSxzZXJpZjtmb250LXNpemU6NDZweDtsaW5lLWhlaWdodDoxLjAyO21hcmdpbjowO2ZvbnQtd2VpZ2h0OjYwMDtsZXR0ZXItc3BhY2luZzotLjAxZW19CiAgLnN1Yntjb2xvcjp2YXIoLS1tdXQpO2ZvbnQtc2l6ZToxNXB4O21hcmdpbi10b3A6MTJweDttYXgtd2lkdGg6NTIwcHg7bGluZS1oZWlnaHQ6MS41fQogIC5wYW5lbHtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE4cHg7cGFkZGluZzoyNHB4fQogIC5yb3d7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDo4cHh9CiAgLmNoaXB7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtiYWNrZ3JvdW5kOnZhcigtLWNhcmRIaSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsKICAgIGJvcmRlci1yYWRpdXM6OTk5cHg7cGFkZGluZzo3cHggOHB4IDdweCAxNHB4O2ZvbnQtc2l6ZToxMy41cHh9CiAgLmNoaXAgYnV0dG9ue2N1cnNvcjpwb2ludGVyO2JvcmRlcjpub25lO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6dmFyKC0tbXV0KTtmb250LXNpemU6MTVweDtsaW5lLWhlaWdodDoxO3BhZGRpbmc6MCAycHh9CiAgaW5wdXQudGl0bGV7ZmxleDoxIDAgMTYwcHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS10ZXh0KTtmb250LXNpemU6MTRweDtwYWRkaW5nOjhweCA0cHg7bWluLXdpZHRoOjE0MHB4O291dGxpbmU6bm9uZX0KICBpbnB1dC50aXRsZTo6cGxhY2Vob2xkZXJ7Y29sb3I6dmFyKC0tbXV0Mil9CiAgc2VsZWN0e2JhY2tncm91bmQ6dmFyKC0tY2FyZEhpKTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjEwcHggMTRweDtmb250LXNpemU6MTRweDtjdXJzb3I6cG9pbnRlcn0KICAuY3Rhe2JhY2tncm91bmQ6dmFyKC0tZ29sZCk7Y29sb3I6IzIwMTgwYTtib3JkZXI6bm9uZTtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzoxM3B4IDI2cHg7Zm9udC1zaXplOjE0LjVweDtmb250LXdlaWdodDo3MDA7Y3Vyc29yOnBvaW50ZXJ9CiAgLmN0YVtkaXNhYmxlZF17YmFja2dyb3VuZDp2YXIoLS1jYXJkSGkpO2NvbG9yOnZhcigtLW11dDIpO2N1cnNvcjpub3QtYWxsb3dlZH0KICAuaHJ7aGVpZ2h0OjFweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpfQogIC5ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMzAwcHgsMWZyKSk7Z2FwOjE2cHh9CiAgLnJje2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjEycHh9CiAgLnJjLnNlZW57Ym9yZGVyLWNvbG9yOnJnYmEoMjMyLDE4MCw3NCwuMjgpfQogIC5raWNrZXJ7Zm9udC1zaXplOjEwcHg7bGV0dGVyLXNwYWNpbmc6LjEyZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLWdvbGQpfQogIC5ydC10aXRsZXtmb250LWZhbWlseTp1aS1zZXJpZixHZW9yZ2lhLHNlcmlmO2ZvbnQtc2l6ZToyMnB4O2xpbmUtaGVpZ2h0OjEuMTU7Zm9udC13ZWlnaHQ6NjAwfQogIC5yZWFzb257Zm9udC1zaXplOjEzLjVweDtsaW5lLWhlaWdodDoxLjU7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tdG9wOjZweH0KICAud3JpdGV1cHtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU1O2NvbG9yOnZhcigtLW11dCl9CiAgLnRyYWlsZXJ7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2NvbG9yOnZhcigtLWdvbGQpO2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NXB4IDEycHg7Zm9udC1zaXplOjEyLjVweDtjdXJzb3I6cG9pbnRlcjttYXJnaW4tdG9wOjEwcHh9CiAgLnRyYWlsZXI6aG92ZXJ7YmFja2dyb3VuZDpyZ2JhKDIzMiwxODAsNzQsLjA4KX0KICAudG1vZGFse2Rpc3BsYXk6bm9uZTtwb3NpdGlvbjpmaXhlZDtpbnNldDowO2JhY2tncm91bmQ6cmdiYSg2LDgsMTEsLjg1KTt6LWluZGV4OjEwMDA7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7cGFkZGluZzoyMHB4fQogIC50bW9kYWwub3BlbntkaXNwbGF5OmZsZXh9CiAgLnRtYm94e3dpZHRoOjEwMCU7bWF4LXdpZHRoOjgyMHB4fQogIC50bWNsb3Nle2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjZweCAxNHB4O2ZvbnQtc2l6ZToxM3B4O2N1cnNvcjpwb2ludGVyO21hcmdpbi1ib3R0b206MTBweH0KICAudG1jbG9zZTpob3ZlcntiYWNrZ3JvdW5kOnZhcigtLWNhcmQpfQogIC50bWZyYW1le3Bvc2l0aW9uOnJlbGF0aXZlO3BhZGRpbmctYm90dG9tOjU2LjI1JTtoZWlnaHQ6MDtib3JkZXItcmFkaXVzOjEycHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6IzAwMDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpfQogIC50bWZyYW1lIGlmcmFtZXtwb3NpdGlvbjphYnNvbHV0ZTtpbnNldDowO3dpZHRoOjEwMCU7aGVpZ2h0OjEwMCU7Ym9yZGVyOjB9CiAgLmRtb2RhbHtkaXNwbGF5Om5vbmU7cG9zaXRpb246Zml4ZWQ7aW5zZXQ6MDtiYWNrZ3JvdW5kOnJnYmEoNiw4LDExLC44NSk7ei1pbmRleDo5OTA7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3BhZGRpbmc6MjRweDtvdmVyZmxvdzphdXRvfQogIC5kbW9kYWwub3BlbntkaXNwbGF5OmZsZXh9CiAgLmRtYm94e3dpZHRoOjEwMCU7bWF4LXdpZHRoOjQzMHB4fQogIC5pdGVtdGl0bGV7YmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2NvbG9yOnZhcigtLXRleHQpO2ZvbnQtc2l6ZToxMy41cHg7Y3Vyc29yOnBvaW50ZXI7cGFkZGluZzowO3RleHQtYWxpZ246bGVmdDtmb250LWZhbWlseTppbmhlcml0fQogIC5pdGVtdGl0bGU6aG92ZXJ7Y29sb3I6dmFyKC0tZ29sZCk7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZX0KICAuc2tpcHtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Y29sb3I6dmFyKC0tbXV0Mik7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzo2cHggMTJweDtmb250LXNpemU6MTIuNXB4O2N1cnNvcjpwb2ludGVyfQogIC5za2lwOmhvdmVye2NvbG9yOnZhcigtLXRleHQpO2JvcmRlci1jb2xvcjp2YXIoLS1tdXQyKX0KICAuc3ZjZmlsdGVyc3tkaXNwbGF5OmlubGluZS1mbGV4O2JhY2tncm91bmQ6dmFyKC0tYmcyKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6OXB4O3BhZGRpbmc6M3B4O2dhcDoycHg7ZmxleC13cmFwOndyYXB9CiAgLnN2Y2Z7Ym9yZGVyOm5vbmU7Y3Vyc29yOnBvaW50ZXI7Ym9yZGVyLXJhZGl1czo2cHg7cGFkZGluZzo2cHggMTBweDtmb250LXNpemU6MTJweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOnZhcigtLW11dCl9CiAgLnN2Y2Y6aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dCl9CiAgLnN2Y2Yub257YmFja2dyb3VuZDp2YXIoLS1nb2xkKTtjb2xvcjojMjAxODBhO2ZvbnQtd2VpZ2h0OjcwMH0KICAudnJvd3tkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHh9CiAgLnZ0aHVtYntiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjpub25lO3BhZGRpbmc6MDtjdXJzb3I6cG9pbnRlcjt3aWR0aDoxMzJweDt0ZXh0LWFsaWduOmxlZnR9CiAgLnZ0aHVtYi1pbWd7cG9zaXRpb246cmVsYXRpdmU7ZGlzcGxheTpibG9jazt3aWR0aDoxMzJweDtoZWlnaHQ6NzRweDtib3JkZXItcmFkaXVzOjhweDtiYWNrZ3JvdW5kLXNpemU6Y292ZXI7YmFja2dyb3VuZC1wb3NpdGlvbjpjZW50ZXI7YmFja2dyb3VuZC1jb2xvcjojMDAwO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSl9CiAgLnZwbGF5e3Bvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiNmZmY7Zm9udC1zaXplOjE1cHg7YmFja2dyb3VuZDpyZ2JhKDAsMCwwLC4zMCk7Ym9yZGVyLXJhZGl1czo4cHh9CiAgLnZ0aHVtYjpob3ZlciAudnBsYXl7YmFja2dyb3VuZDpyZ2JhKDAsMCwwLC4xMil9CiAgLnZjYXB7Zm9udC1zaXplOjExcHg7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tdG9wOjVweDtsaW5lLWhlaWdodDoxLjM7b3ZlcmZsb3c6aGlkZGVuO2Rpc3BsYXk6LXdlYmtpdC1ib3g7LXdlYmtpdC1saW5lLWNsYW1wOjI7LXdlYmtpdC1ib3gtb3JpZW50OnZlcnRpY2FsfQogIC5zdmNyb3d7ZGlzcGxheTpmbGV4O2dhcDo4cHg7YWxpZ24taXRlbXM6Y2VudGVyO2ZsZXgtd3JhcDp3cmFwfQogIC5zdmNpY29ue2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7bWluLXdpZHRoOjM0cHg7aGVpZ2h0OjI2cHg7cGFkZGluZzowIDhweDtib3JkZXItcmFkaXVzOjdweDtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo4MDA7bGV0dGVyLXNwYWNpbmc6LjAyZW07Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtiYWNrZ3JvdW5kOnZhcigtLWNhcmRIaSk7Y29sb3I6dmFyKC0tbXV0Mil9CiAgLnN2Y2ljb24ub2Zme29wYWNpdHk6LjM4O2ZpbHRlcjpncmF5c2NhbGUoMSl9CiAgYTpob3ZlciAuc3ZjaWNvbntmaWx0ZXI6YnJpZ2h0bmVzcygxLjA4KX0KICAuaGVhZHtkaXNwbGF5OmZsZXg7Z2FwOjE0cHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydH0KICAuaGVhZG1ldGF7bWluLXdpZHRoOjA7ZmxleDoxfQogIC5wb3N0ZXJ7d2lkdGg6NzJweDtoZWlnaHQ6MTA4cHg7Ym9yZGVyLXJhZGl1czo4cHg7b2JqZWN0LWZpdDpjb3ZlcjtiYWNrZ3JvdW5kOnZhcigtLWNhcmRIaSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtmbGV4Om5vbmU7ZGlzcGxheTpibG9ja30KICAucG9zdGVyLnBoe2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6OXB4O3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtsZXR0ZXItc3BhY2luZzouMDZlbTt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjRweH0KICAuc2NvcmVze2Rpc3BsYXk6ZmxleDtnYXA6MTZweH0KICAuc2N7ZmxleDoxO21pbi13aWR0aDowfQogIC5zYyAubGFie2ZvbnQtc2l6ZToxMHB4O2xldHRlci1zcGFjaW5nOi4wOGVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tYm90dG9tOjRweH0KICAuc2MgLnZhbHtmb250LWZhbWlseTp1aS1tb25vc3BhY2UsTWVubG8sbW9ub3NwYWNlO2ZvbnQtc2l6ZToyMHB4O2ZvbnQtd2VpZ2h0OjYwMDtsaW5lLWhlaWdodDoxfQogIC5tZXRlcntoZWlnaHQ6M3B4O2JvcmRlci1yYWRpdXM6MnB4O2JhY2tncm91bmQ6dmFyKC0tbGluZSk7bWFyZ2luLXRvcDo4cHg7b3ZlcmZsb3c6aGlkZGVufQogIC5tZXRlcj5pe2Rpc3BsYXk6YmxvY2s7aGVpZ2h0OjEwMCU7Ym9yZGVyLXJhZGl1czoycHh9CiAgLmxhYjJ7Zm9udC1zaXplOjEwcHg7bGV0dGVyLXNwYWNpbmc6LjA4ZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi1ib3R0b206OHB4fQogIC5zdmN7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjVweDtmb250LXNpemU6MTEuNXB4O2JvcmRlci1yYWRpdXM6OHB4O3BhZGRpbmc6NHB4IDlweDt0ZXh0LWRlY29yYXRpb246bm9uZX0KICAuc3ZjLm5ldHtjb2xvcjojYmZlOGNmO2JhY2tncm91bmQ6cmdiYSg3OSwxODAsMTE5LC4xNCk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDc5LDE4MCwxMTksLjM1KX0KICAuc3ZjLnBsYWlue2NvbG9yOnZhcigtLW11dCk7YmFja2dyb3VuZDpyZ2JhKDEzOSwxNDcsMTYwLC4wOCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKX0KICAuc3ZjLnBsYWluOmhvdmVye2NvbG9yOnZhcigtLXRleHQpfQogIC5zZWVucm93e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweH0KICAucmF0ZXtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjZweCAxMnB4O2ZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NjAwO2N1cnNvcjpwb2ludGVyfQogIC5yYXRlLnVwe2JhY2tncm91bmQ6cmdiYSg3OSwxODAsMTE5LC4xMCk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDc5LDE4MCwxMTksLjMpO2NvbG9yOiNiZmU4Y2Z9CiAgLnJhdGUuZG93bntiYWNrZ3JvdW5kOnJnYmEoMjI0LDg3LDc1LC4wOCk7Ym9yZGVyOjFweCBzb2xpZCByZ2JhKDIyNCw4Nyw3NSwuMjgpO2NvbG9yOiNlZmIzYWR9CiAgLndhdGNoZWR0YWd7Zm9udC1zaXplOjEyLjVweDtmb250LXdlaWdodDo2MDB9CiAgLnVuZG97YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTJweDtjdXJzb3I6cG9pbnRlcjt0ZXh0LWRlY29yYXRpb246dW5kZXJsaW5lO3BhZGRpbmc6MnB4fQogIC50b29sYmFye2Rpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6MThweDthbGlnbi1pdGVtczpmbGV4LWVuZDtwYWRkaW5nOjE0cHggMTZweDtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7bWFyZ2luLWJvdHRvbToyMHB4fQogIC5zZWd7ZGlzcGxheTppbmxpbmUtZmxleDtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjlweDtwYWRkaW5nOjNweDtnYXA6MnB4fQogIC5zZWcgYnV0dG9ue2JvcmRlcjpub25lO2N1cnNvcjpwb2ludGVyO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NnB4IDEycHg7Zm9udC1zaXplOjEyLjVweDtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2NvbG9yOnZhcigtLW11dCl9CiAgLnNlZyBidXR0b24ub257YmFja2dyb3VuZDp2YXIoLS1nb2xkKTtjb2xvcjojMjAxODBhO2ZvbnQtd2VpZ2h0OjcwMH0KICAuZ2hvc3R7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2NvbG9yOnZhcigtLXRleHQpO2JvcmRlci1yYWRpdXM6OTk5cHg7cGFkZGluZzo4cHggMTZweDtmb250LXNpemU6MTNweDtjdXJzb3I6cG9pbnRlcjtkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6N3B4fQogIC5kb3R7d2lkdGg6NnB4O2hlaWdodDo2cHg7Ym9yZGVyLXJhZGl1czo5OTlweDtiYWNrZ3JvdW5kOnZhcigtLW11dDIpfQogIC5sb2dwYW5lbHtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEycHg7cGFkZGluZzoxNnB4O21hcmdpbi1ib3R0b206MjBweH0KICAubG9naXRlbXtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMHB4O2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzo5cHggMTJweH0KICAuZm9vdHtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDoxMHB4fQogIC53bHtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Y29sb3I6dmFyKC0tbXV0KTtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjdweCAxMnB4O2ZvbnQtc2l6ZToxMi41cHg7Y3Vyc29yOnBvaW50ZXI7dGV4dC1hbGlnbjpjZW50ZXI7d2lkdGg6MTAwJX0KICAud2w6aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dCl9CiAgLndsLm9ue2JvcmRlci1jb2xvcjpyZ2JhKDIzMiwxODAsNzQsLjQpO2NvbG9yOnZhcigtLWdvbGQpO2JhY2tncm91bmQ6cmdiYSgyMzIsMTgwLDc0LC4wOCl9CiAgLndsd3JhcHtwb3NpdGlvbjpyZWxhdGl2ZX0KICAubG1lbnV7ZGlzcGxheTpub25lO2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6NHB4O21hcmdpbi10b3A6NnB4O3BhZGRpbmc6OHB4O2JhY2tncm91bmQ6dmFyKC0tYmcyKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6OHB4fQogIC5sbWVudS5vcGVue2Rpc3BsYXk6ZmxleH0KICAubG1pe2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtjb2xvcjp2YXIoLS1tdXQpO2JvcmRlci1yYWRpdXM6NnB4O3BhZGRpbmc6NnB4IDEwcHg7Zm9udC1zaXplOjEyLjVweDtjdXJzb3I6cG9pbnRlcjt0ZXh0LWFsaWduOmxlZnR9CiAgLmxtaTpob3Zlcntjb2xvcjp2YXIoLS10ZXh0KX0KICAubG1pLm9ue2JvcmRlci1jb2xvcjpyZ2JhKDIzMiwxODAsNzQsLjQpO2NvbG9yOnZhcigtLWdvbGQpfQogIC5sbWkubmV3e2NvbG9yOnZhcigtLWdvbGQpO2JvcmRlci1zdHlsZTpkYXNoZWR9CiAgLnRpbnlidG57YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTEuNXB4O2N1cnNvcjpwb2ludGVyO3RleHQtZGVjb3JhdGlvbjp1bmRlcmxpbmU7cGFkZGluZzoycHggNHB4fQogIC50aW55YnRuOmhvdmVye2NvbG9yOnZhcigtLXRleHQpfQogIC5ub3Rle2NvbG9yOnZhcigtLW11dDIpO2ZvbnQtc2l6ZToxMnB4O2xpbmUtaGVpZ2h0OjEuNjttYXJnaW4tdG9wOjI2cHg7bWF4LXdpZHRoOjY0MHB4fQogIGEubGlua3tjb2xvcjp2YXIoLS1nb2xkKTt0ZXh0LWRlY29yYXRpb246bm9uZTtmb250LXNpemU6MTIuNXB4fQogIGJ1dHRvbjpmb2N1cy12aXNpYmxlLGlucHV0OmZvY3VzLXZpc2libGUsc2VsZWN0OmZvY3VzLXZpc2libGUsLnNlZyBidXR0b246Zm9jdXMtdmlzaWJsZXtvdXRsaW5lOjJweCBzb2xpZCB2YXIoLS1nb2xkKTtvdXRsaW5lLW9mZnNldDoycHh9CiAgQGtleWZyYW1lcyBwezAlLDEwMCV7b3BhY2l0eTouNDV9NTAle29wYWNpdHk6Ljh9fSAubG9hZHthbmltYXRpb246cCAxLjRzIGVhc2UtaW4tb3V0IGluZmluaXRlfQo8L3N0eWxlPgo8L2hlYWQ+Cjxib2R5Pgo8ZGl2IGNsYXNzPSJ3cmFwIj4KICA8ZGl2IGlkPSJzdGF0dXMiIHN0eWxlPSJkaXNwbGF5Om5vbmU7bWFyZ2luOjAgMCAxOHB4O3BhZGRpbmc6MTBweCAxNHB4O2JvcmRlci1yYWRpdXM6MTBweDtmb250LXNpemU6MTMuNXB4Ij48L2Rpdj4KICA8ZGl2IGNsYXNzPSJleWVicm93Ij5OZXRmbGl4IHRhc3RlLW1hdGNoZXI8L2Rpdj4KICA8aDE+V2hhdCBuZXh0LjwvaDE+CiAgPHAgY2xhc3M9InN1YiI+TmFtZSBhIGhhbmRmdWwgb2YgdGhpbmdzIHlvdSB3YXRjaGVkIGFuZCBsb3ZlZC4gUmVhbCBJTURiICZhbXA7IFJvdHRlbiBUb21hdG9lcyBzY29yZXMsIHJlYWwgcmVnaW9uYWwgYXZhaWxhYmlsaXR5LCBkZWVwIGxpbmtzIHRvIHdoZXJlIGl0IHN0cmVhbXMg4oCUIGFuZCBpdCBsZWFybnMgZnJvbSB3aGF0IHlvdSByYXRlLjwvcD4KCiAgPGRpdiBpZD0iaW5wdXQiIHN0eWxlPSJtYXJnaW4tdG9wOjMwcHgiIGNsYXNzPSJwYW5lbCI+CiAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6YmFzZWxpbmU7bWFyZ2luLWJvdHRvbToxMnB4Ij4KICAgICAgPGxhYmVsIHN0eWxlPSJmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDAiPlRoaW5ncyB5b3UgbG92ZWQ8L2xhYmVsPgogICAgICA8c3BhbiBpZD0iY291bnQiIHN0eWxlPSJmb250LWZhbWlseTp1aS1tb25vc3BhY2UsbW9ub3NwYWNlO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dDIpIj4wIC8gMTA8L3NwYW4+CiAgICA8L2Rpdj4KICAgIDxkaXYgaWQ9ImNoaXBzIiBjbGFzcz0icm93IiBzdHlsZT0ibWFyZ2luLWJvdHRvbToxNHB4Ij4KICAgICAgPGlucHV0IGNsYXNzPSJ0aXRsZSIgaWQ9ImRyYWZ0IiBwbGFjZWhvbGRlcj0iVHlwZSBhIHRpdGxlLCBwcmVzcyBFbnRlciIgLz4KICAgIDwvZGl2PgogICAgPGJ1dHRvbiBpZD0iZXhhbXBsZSIgc3R5bGU9ImJhY2tncm91bmQ6bm9uZTtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS1nb2xkKTtmb250LXNpemU6MTIuNXB4O2N1cnNvcjpwb2ludGVyO3BhZGRpbmc6MCAwIDhweCI+TmVlZCBhIHNwYXJrPyBMb2FkIGFuIGV4YW1wbGUg4oaSPC9idXR0b24+CiAgICA8ZGl2IGNsYXNzPSJociIgc3R5bGU9Im1hcmdpbjo2cHggMCAxOHB4Ij48L2Rpdj4KICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6MTZweDthbGlnbi1pdGVtczpmbGV4LWVuZDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbiI+CiAgICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtmbGV4LXdyYXA6d3JhcDtnYXA6MTZweCI+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxsYWJlbCBmb3I9InJlZ2lvbiIgc3R5bGU9ImRpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tYm90dG9tOjdweCI+V2F0Y2hpbmcgZnJvbTwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJyZWdpb24iPjwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXY+CiAgICAgICAgICA8bGFiZWwgZm9yPSJ0eXBlIiBzdHlsZT0iZGlzcGxheTpibG9jaztmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQpO21hcmdpbi1ib3R0b206N3B4Ij5TaG93IG1lPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9InR5cGUiPjwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXY+CiAgICAgICAgICA8bGFiZWwgZm9yPSJnZW5yZSIgc3R5bGU9ImRpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tYm90dG9tOjdweCI+R2VucmU8L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBpZD0iZ2VucmUiPjwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBpZD0iZ28iIGNsYXNzPSJjdGEiIGRpc2FibGVkPkZpbmQgbXkgbmV4dCB3YXRjaDwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8ZGl2IGlkPSJoaW50IiBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLXRvcDoxMnB4Ij5BZGQgYXQgbGVhc3QgMyB0aXRsZXMgZm9yIGEgZ29vZCByZWFkIG9uIHlvdXIgdGFzdGUuPC9kaXY+CiAgICA8ZGl2IGlkPSJpbnB1dGxvZyI+PC9kaXY+CiAgPC9kaXY+CgogIDxkaXYgaWQ9InJlc3VsdHMiIHN0eWxlPSJkaXNwbGF5Om5vbmU7bWFyZ2luLXRvcDozMHB4Ij48L2Rpdj4KICA8ZGl2IGlkPSJ0bW9kYWwiIGNsYXNzPSJ0bW9kYWwiIG9uY2xpY2s9ImlmKGV2ZW50LnRhcmdldD09PXRoaXMpY2xvc2VUcmFpbGVyKCkiPjxkaXYgY2xhc3M9InRtYm94Ij48YnV0dG9uIGNsYXNzPSJ0bWNsb3NlIiBvbmNsaWNrPSJjbG9zZVRyYWlsZXIoKSI+4pyVIENsb3NlPC9idXR0b24+PGRpdiBjbGFzcz0idG1mcmFtZSI+PGlmcmFtZSBpZD0idGZyYW1lIiBhbGxvdz0iYXV0b3BsYXk7IGVuY3J5cHRlZC1tZWRpYTsgZnVsbHNjcmVlbiIgYWxsb3dmdWxsc2NyZWVuPjwvaWZyYW1lPjwvZGl2PjwvZGl2PjwvZGl2PgogIDxkaXYgaWQ9ImRtb2RhbCIgY2xhc3M9ImRtb2RhbCIgb25jbGljaz0iaWYoZXZlbnQudGFyZ2V0PT09dGhpcyljbG9zZURldGFpbCgpIj48ZGl2IGNsYXNzPSJkbWJveCI+PGJ1dHRvbiBjbGFzcz0idG1jbG9zZSIgb25jbGljaz0iY2xvc2VEZXRhaWwoKSI+4pyVIENsb3NlPC9idXR0b24+PGRpdiBpZD0iZGV0YWlsLWJvZHkiPjwvZGl2PjwvZGl2PjwvZGl2Pgo8L2Rpdj4KCjxzY3JpcHQ+CndpbmRvdy5vbmVycm9yPWZ1bmN0aW9uKG0pe3ZhciBzPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzdGF0dXMiKTtpZihzKXtzLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjtzLnN0eWxlLmJhY2tncm91bmQ9IiM1YjFhMWEiO3Muc3R5bGUuYm9yZGVyPSIxcHggc29saWQgI2EzMyI7cy5zdHlsZS5jb2xvcj0iI2ZmZDlkNCI7cy50ZXh0Q29udGVudD0iUHJvYmxlbSBzdGFydGluZyB0aGUgYXBwOiAiK207fXJldHVybiBmYWxzZTt9OwoKY29uc3QgUkVHSU9OUz1bWyJ6YSIsIlNvdXRoIEFmcmljYSJdLFsidXMiLCJVbml0ZWQgU3RhdGVzIl0sWyJnYiIsIlVuaXRlZCBLaW5nZG9tIl0sWyJjYSIsIkNhbmFkYSJdLFsiYXUiLCJBdXN0cmFsaWEiXSxbImluIiwiSW5kaWEiXSxbIm5nIiwiTmlnZXJpYSJdLFsia2UiLCJLZW55YSJdLFsiZGUiLCJHZXJtYW55Il0sWyJmciIsIkZyYW5jZSJdLFsiZXMiLCJTcGFpbiJdLFsiYnIiLCJCcmF6aWwiXSxbIm14IiwiTWV4aWNvIl0sWyJqcCIsIkphcGFuIl0sWyJrciIsIlNvdXRoIEtvcmVhIl1dOwpjb25zdCBFWEFNUExFPVsiRGFyayIsIlRoZSBCZWFyIiwiQnJlYWtpbmcgQmFkIiwiUGFyYXNpdGUiLCJGbGVhYmFnIl07CmxldCBzaG93cz1bXSwgZGF0YT1udWxsLCB3YXRjaGVkTWFwPXt9LCB3YXRjaGxpc3RzPXt9LCBzaG93TG9nPWZhbHNlLCBzaG93TGlzdD1mYWxzZSwgc2tpcHBlZD1bXTsKbGV0IGxvYWRpbmdNb3JlPWZhbHNlLCBleGhhdXN0ZWQ9ZmFsc2UsIGlvPW51bGw7CmxldCBmaWx0ZXJzPXt0eXBlOiJhbGwiLG1pbjowLHN2Y3M6W10sc29ydDoibWF0Y2gifTsKCmNvbnN0ICQ9cz0+ZG9jdW1lbnQucXVlcnlTZWxlY3RvcihzKTsKY29uc3QgbnJtPXM9PlN0cmluZyhzfHwiIikudHJpbSgpLnRvTG93ZXJDYXNlKCk7CmNvbnN0IGVzYz1zPT5TdHJpbmcocykucmVwbGFjZSgvWyY8PiJdL2csYz0+KHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsifVtjXSkpOwpjb25zdCB3YXRjaGVkQ291bnQ9KCk9Pk9iamVjdC5rZXlzKHdhdGNoZWRNYXApLmxlbmd0aDsKCmNvbnN0IHJlZ2lvblNlbD0kKCIjcmVnaW9uIik7ClJFR0lPTlMuZm9yRWFjaCgoW2Msbl0pPT57Y29uc3Qgbz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJvcHRpb24iKTtvLnZhbHVlPWM7by50ZXh0Q29udGVudD1uO3JlZ2lvblNlbC5hcHBlbmRDaGlsZChvKTt9KTsKY29uc3QgVFlQRVM9W1siIiwiTW92aWVzICYgc2VyaWVzIl0sWyJtb3ZpZSIsIk1vdmllcyBvbmx5Il0sWyJzZXJpZXMiLCJTZXJpZXMgb25seSJdXTsKY29uc3QgR0VOUkVTPVsiQW55IiwiQWN0aW9uIiwiQWR2ZW50dXJlIiwiQW5pbWF0aW9uIiwiQ29tZWR5IiwiQ3JpbWUiLCJEb2N1bWVudGFyeSIsIkRyYW1hIiwiRmFudGFzeSIsIkhvcnJvciIsIk15c3RlcnkiLCJSb21hbmNlIiwiU2NpLUZpIiwiVGhyaWxsZXIiXTsKY29uc3QgdHlwZVNlbD0kKCIjdHlwZSIpOyBUWVBFUy5mb3JFYWNoKChbdixuXSk9Pntjb25zdCBvPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoIm9wdGlvbiIpO28udmFsdWU9djtvLnRleHRDb250ZW50PW47dHlwZVNlbC5hcHBlbmRDaGlsZChvKTt9KTsKY29uc3QgZ2VucmVTZWw9JCgiI2dlbnJlIik7IEdFTlJFUy5mb3JFYWNoKGc9Pntjb25zdCBvPWRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoIm9wdGlvbiIpO28udmFsdWU9ZztvLnRleHRDb250ZW50PShnPT09IkFueSI/IkFueSBnZW5yZSI6Zyk7Z2VucmVTZWwuYXBwZW5kQ2hpbGQobyk7fSk7CgpmdW5jdGlvbiBzY29yZUNvbG9yKHApe2lmKHA9PW51bGx8fGlzTmFOKHApKXJldHVybiJ2YXIoLS1tdXQyKSI7aWYocD49NzUpcmV0dXJuInZhcigtLWdvb2QpIjtpZihwPj01MClyZXR1cm4idmFyKC0tbWlkKSI7cmV0dXJuInZhcigtLWJhZCkiO30KCi8vIC0tLS0gd2F0Y2ggaGlzdG9yeSAoc2F2ZWQgaW4gdGhpcyBicm93c2VyIHZpYSBsb2NhbFN0b3JhZ2UpIC0tLS0KY29uc3QgTFNfS0VZPSJ3bl93YXRjaGxvZyI7CmZ1bmN0aW9uIHBlcnNpc3RXYXRjaGVkKCl7dHJ5e2xvY2FsU3RvcmFnZS5zZXRJdGVtKExTX0tFWSxKU09OLnN0cmluZ2lmeSh3YXRjaGVkTWFwKSk7fWNhdGNoKGUpe319CmZ1bmN0aW9uIGxvYWRXYXRjaGVkKCl7CiAgdHJ5e2NvbnN0IHJhdz1sb2NhbFN0b3JhZ2UuZ2V0SXRlbShMU19LRVkpO3dhdGNoZWRNYXA9cmF3PyhKU09OLnBhcnNlKHJhdyl8fHt9KTp7fTt9Y2F0Y2goZSl7d2F0Y2hlZE1hcD17fTt9CiAgcmVuZGVySW5wdXRMb2coKTsKfQpmdW5jdGlvbiBza2lwVGl0bGUocmVjKXsKICBpZihkYXRhJiZkYXRhLnJlc3VsdHMpZGF0YS5yZXN1bHRzPWRhdGEucmVzdWx0cy5maWx0ZXIoZnVuY3Rpb24oeCl7cmV0dXJuIG5ybSh4LnRpdGxlKSE9PW5ybShyZWMudGl0bGUpO30pOwogIHNraXBwZWQucHVzaChyZWMudGl0bGUpOwogIGlmKGRhdGEpcmVuZGVyKCk7Cn0KZnVuY3Rpb24gbWFya1dhdGNoZWQocmVjLGxpa2VkLHJlbW92ZVRpbGUpewogIHdhdGNoZWRNYXBbbnJtKHJlYy50aXRsZSldPXt0aXRsZTpyZWMudGl0bGUseWVhcjpyZWMueWVhcix0eXBlOnJlYy50eXBlLGxpa2VkLHRzOkRhdGUubm93KCl9OwogIHBlcnNpc3RXYXRjaGVkKCk7CiAgaWYocmVtb3ZlVGlsZSYmZGF0YSYmZGF0YS5yZXN1bHRzKWRhdGEucmVzdWx0cz1kYXRhLnJlc3VsdHMuZmlsdGVyKHg9Pm5ybSh4LnRpdGxlKSE9PW5ybShyZWMudGl0bGUpKTsKICBpZihkYXRhKXJlbmRlcigpOyByZW5kZXJJbnB1dExvZygpOwp9CmZ1bmN0aW9uIHJlbW92ZVdhdGNoZWQoaWQpewogIGRlbGV0ZSB3YXRjaGVkTWFwW2lkXTsgcGVyc2lzdFdhdGNoZWQoKTsgaWYoZGF0YSlyZW5kZXIoKTsgcmVuZGVySW5wdXRMb2coKTsKfQpjb25zdCBMU19MSVNUUz0id25fd2F0Y2hsaXN0cyI7CmZ1bmN0aW9uIHBlcnNpc3RXYXRjaGxpc3RzKCl7dHJ5e2xvY2FsU3RvcmFnZS5zZXRJdGVtKExTX0xJU1RTLEpTT04uc3RyaW5naWZ5KHdhdGNobGlzdHMpKTt9Y2F0Y2goZSl7fX0KZnVuY3Rpb24gbG9hZFdhdGNobGlzdHMoKXsKICB0cnl7CiAgICBjb25zdCByYXc9bG9jYWxTdG9yYWdlLmdldEl0ZW0oTFNfTElTVFMpOwogICAgaWYocmF3KXt3YXRjaGxpc3RzPUpTT04ucGFyc2UocmF3KXx8e307cmV0dXJuO30KICAgIGNvbnN0IG9sZD1sb2NhbFN0b3JhZ2UuZ2V0SXRlbSgid25fd2F0Y2hsaXN0Iik7CiAgICBpZihvbGQpe2NvbnN0IGl0ZW1zPUpTT04ucGFyc2Uob2xkKXx8e307Y29uc3QgaWQ9ImwiK0RhdGUubm93KCk7d2F0Y2hsaXN0cz17W2lkXTp7aWQ6aWQsbmFtZToiTXkgV2F0Y2hsaXN0IixpdGVtczppdGVtcyx0czpEYXRlLm5vdygpfX07cGVyc2lzdFdhdGNobGlzdHMoKTtyZXR1cm47fQogICAgd2F0Y2hsaXN0cz17fTsKICB9Y2F0Y2goZSl7d2F0Y2hsaXN0cz17fTt9Cn0KZnVuY3Rpb24gbGlzdENvdW50KCl7cmV0dXJuIE9iamVjdC5rZXlzKHdhdGNobGlzdHMpLmxlbmd0aDt9CmZ1bmN0aW9uIG5ld0xpc3QobmFtZSl7Y29uc3Qgbm09KG5hbWV8fCIiKS50cmltKCk7aWYoIW5tKXJldHVybiBudWxsO2NvbnN0IGlkPSJsIitEYXRlLm5vdygpK01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSoxMDAwKTt3YXRjaGxpc3RzW2lkXT17aWQ6aWQsbmFtZTpubSxpdGVtczp7fSx0czpEYXRlLm5vdygpfTtwZXJzaXN0V2F0Y2hsaXN0cygpO3JldHVybiBpZDt9CmZ1bmN0aW9uIHJlbmFtZUxpc3QoaWQsbmFtZSl7Y29uc3Qgbm09KG5hbWV8fCIiKS50cmltKCk7aWYod2F0Y2hsaXN0c1tpZF0mJm5tKXt3YXRjaGxpc3RzW2lkXS5uYW1lPW5tO3BlcnNpc3RXYXRjaGxpc3RzKCk7fX0KZnVuY3Rpb24gZGVsZXRlTGlzdChpZCl7ZGVsZXRlIHdhdGNobGlzdHNbaWRdO3BlcnNpc3RXYXRjaGxpc3RzKCk7aWYoZGF0YSlyZW5kZXIoKTtyZW5kZXJJbnB1dExvZygpO30KZnVuY3Rpb24gdGl0bGVJbkxpc3QobGlzdElkLHRpdGxlSWQpe3JldHVybiAhISh3YXRjaGxpc3RzW2xpc3RJZF0mJndhdGNobGlzdHNbbGlzdElkXS5pdGVtcyYmd2F0Y2hsaXN0c1tsaXN0SWRdLml0ZW1zW3RpdGxlSWRdKTt9CmZ1bmN0aW9uIGxpc3RzRm9yVGl0bGUodGl0bGVJZCl7cmV0dXJuIE9iamVjdC52YWx1ZXMod2F0Y2hsaXN0cykuZmlsdGVyKGw9PmwuaXRlbXMmJmwuaXRlbXNbdGl0bGVJZF0pLm1hcChsPT5sLmlkKTt9CmZ1bmN0aW9uIHRvZ2dsZVRpdGxlSW5MaXN0KGxpc3RJZCxyZWMpe2NvbnN0IGlkPW5ybShyZWMudGl0bGUpO2NvbnN0IEw9d2F0Y2hsaXN0c1tsaXN0SWRdO2lmKCFMKXJldHVybjtpZighTC5pdGVtcylMLml0ZW1zPXt9O2lmKEwuaXRlbXNbaWRdKWRlbGV0ZSBMLml0ZW1zW2lkXTtlbHNlIEwuaXRlbXNbaWRdPXt0aXRsZTpyZWMudGl0bGUseWVhcjpyZWMueWVhcix0eXBlOnJlYy50eXBlLHRzOkRhdGUubm93KCl9O3BlcnNpc3RXYXRjaGxpc3RzKCk7aWYoZGF0YSlyZW5kZXIoKTtyZW5kZXJJbnB1dExvZygpO30KZnVuY3Rpb24gcmVtb3ZlSXRlbUZyb21MaXN0KGxpc3RJZCx0aXRsZUlkKXtjb25zdCBMPXdhdGNobGlzdHNbbGlzdElkXTtpZihMJiZMLml0ZW1zKWRlbGV0ZSBMLml0ZW1zW3RpdGxlSWRdO3BlcnNpc3RXYXRjaGxpc3RzKCk7aWYoZGF0YSlyZW5kZXIoKTtyZW5kZXJJbnB1dExvZygpO30KZnVuY3Rpb24gY3JlYXRlTGlzdFByb21wdCgpe2NvbnN0IG5tPXdpbmRvdy5wcm9tcHQoIk5hbWUgeW91ciBuZXcgbGlzdCAoZS5nLiBDb21lZHksIERhdGUgbmlnaHQpOiIpO2lmKG5tJiZubS50cmltKCkpe25ld0xpc3Qobm0pO2lmKGRhdGEpcmVuZGVyKCk7cmVuZGVySW5wdXRMb2coKTt9fQpmdW5jdGlvbiBuZXdMaXN0Rm9yQ2FyZChyZWMpe2NvbnN0IG5tPXdpbmRvdy5wcm9tcHQoIk5hbWUgeW91ciBuZXcgbGlzdCAoZS5nLiBDb21lZHksIERhdGUgbmlnaHQpOiIpO2lmKG5tJiZubS50cmltKCkpe2NvbnN0IGlkPW5ld0xpc3Qobm0pO2lmKGlkJiZyZWMpdG9nZ2xlVGl0bGVJbkxpc3QoaWQscmVjKTt9fQpmdW5jdGlvbiByZW5hbWVMaXN0UHJvbXB0KGlkKXtjb25zdCBjdXI9d2F0Y2hsaXN0c1tpZF0/d2F0Y2hsaXN0c1tpZF0ubmFtZToiIjtjb25zdCBubT13aW5kb3cucHJvbXB0KCJSZW5hbWUgdGhpcyBsaXN0OiIsY3VyKTtpZihubSYmbm0udHJpbSgpKXtyZW5hbWVMaXN0KGlkLG5tKTtpZihkYXRhKXJlbmRlcigpO3JlbmRlcklucHV0TG9nKCk7fX0KZnVuY3Rpb24gZGVsZXRlTGlzdENvbmZpcm0oaWQpe2NvbnN0IEw9d2F0Y2hsaXN0c1tpZF07aWYoIUwpcmV0dXJuO2lmKHdpbmRvdy5jb25maXJtKCdEZWxldGUgdGhlIGxpc3QgIicrTC5uYW1lKyciPyBUaGUgdGl0bGVzIGluIGl0IHdpbGwgYmUgcmVtb3ZlZCBmcm9tIHRoaXMgbGlzdC4nKSlkZWxldGVMaXN0KGlkKTt9CmZ1bmN0aW9uIGxpc3RCdXR0b25IVE1MKCl7Y29uc3QgYz1saXN0Q291bnQoKTtyZXR1cm4gJzxidXR0b24gY2xhc3M9Imdob3N0IiBpZD0ibGlzdGJ0biI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6JysoYz8ndmFyKC0tZ29sZCknOid2YXIoLS1tdXQyKScpKyciPjwvc3Bhbj5NeSBsaXN0cyAnKyhjPycoJytjKycpJzonJykrJyAnKyhzaG93TGlzdD8n4pa0Jzon4pa+JykrJzwvYnV0dG9uPic7fQpmdW5jdGlvbiB3YXRjaGxpc3RzUGFuZWxIVE1MKCl7CiAgY29uc3QgbGlzdHM9T2JqZWN0LnZhbHVlcyh3YXRjaGxpc3RzKS5zb3J0KChhLGIpPT4oYS50c3x8MCktKGIudHN8fDApKTsKICBsZXQgaD0nJzsKICBpZighbGlzdHMubGVuZ3RoKWgrPSc8ZGl2IHN0eWxlPSJmb250LXNpemU6MTNweDtjb2xvcjp2YXIoLS1tdXQyKTtwYWRkaW5nOjhweCAycHgiPllvdSBoYXZlIG5vIGxpc3RzIHlldC4gQ3JlYXRlIG9uZSwgdGhlbiB1c2UgIkFkZCB0byBsaXN0IiBvbiBhbnkgc3VnZ2VzdGlvbi48L2Rpdj4nOwogIGxpc3RzLmZvckVhY2goTD0+ewogICAgY29uc3QgaXRlbXM9T2JqZWN0LmVudHJpZXMoTC5pdGVtc3x8e30pLnNvcnQoKGEsYik9PihiWzFdLnRzfHwwKS0oYVsxXS50c3x8MCkpOwogICAgaCs9JzxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206MTZweCI+JzsKICAgIGgrPSc8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7bWFyZ2luLWJvdHRvbTo4cHgiPjxzcGFuIHN0eWxlPSJmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7Y29sb3I6dmFyKC0tdGV4dCkiPicrZXNjKEwubmFtZSkrJzwvc3Bhbj48c3BhbiBzdHlsZT0iZm9udC1zaXplOjExLjVweDtjb2xvcjp2YXIoLS1tdXQyKSI+JytpdGVtcy5sZW5ndGgrJyB0aXRsZScrKGl0ZW1zLmxlbmd0aD09PTE/Jyc6J3MnKSsnPC9zcGFuPjxidXR0b24gY2xhc3M9InRpbnlidG4iIGRhdGEtYWN0PSJsaXN0LXJlbmFtZSIgZGF0YS1saXN0PSInK2VzYyhMLmlkKSsnIiBzdHlsZT0ibWFyZ2luLWxlZnQ6YXV0byI+cmVuYW1lPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0idGlueWJ0biIgZGF0YS1hY3Q9Imxpc3QtZGVsZXRlIiBkYXRhLWxpc3Q9IicrZXNjKEwuaWQpKyciPmRlbGV0ZTwvYnV0dG9uPjwvZGl2Pic7CiAgICBpZighaXRlbXMubGVuZ3RoKWgrPSc8ZGl2IHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQyKTtwYWRkaW5nOjJweCAycHggNHB4Ij5ObyB0aXRsZXMgeWV0LjwvZGl2Pic7CiAgICBlbHNlIGgrPWl0ZW1zLm1hcCgoW2lkLHhdKT0+JzxkaXYgY2xhc3M9ImxvZ2l0ZW0iPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLWdvbGQpIj48L3NwYW4+PGJ1dHRvbiBjbGFzcz0iaXRlbXRpdGxlIiBkYXRhLWFjdD0iZXhwYW5kIiBkYXRhLXNyYz0ibGlzdCIgZGF0YS1saXN0PSInK2VzYyhMLmlkKSsnIiBkYXRhLWlkPSInK2VzYyhpZCkrJyI+Jytlc2MoeC50aXRsZSkrJzwvYnV0dG9uPjxzcGFuIHN0eWxlPSJmb250LXNpemU6MTEuNXB4O2NvbG9yOnZhcigtLW11dDIpIj4nK2VzYyh4LnR5cGV8fCcnKSsoeC55ZWFyPycgwrcgJytlc2MoeC55ZWFyKTonJykrJzwvc3Bhbj48YnV0dG9uIGNsYXNzPSJjaGlwIiBkYXRhLWFjdD0iaXRlbS1yZW1vdmUiIGRhdGEtbGlzdD0iJytlc2MoTC5pZCkrJyIgZGF0YS1pZD0iJytlc2MoaWQpKyciIHN0eWxlPSJtYXJnaW4tbGVmdDphdXRvO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjE1cHg7cGFkZGluZzowIDRweDtjdXJzb3I6cG9pbnRlciI+JnRpbWVzOzwvYnV0dG9uPjwvZGl2PicpLmpvaW4oIiIpOwogICAgaCs9JzwvZGl2Pic7CiAgfSk7CiAgaCs9JzxidXR0b24gY2xhc3M9IndsIiBkYXRhLWFjdD0ibGlzdC1uZXciIHN0eWxlPSJtYXJnaW4tdG9wOjRweCI+KyBOZXcgbGlzdDwvYnV0dG9uPic7CiAgcmV0dXJuIGg7Cn0KCmZ1bmN0aW9uIGxvZ0xpc3RIVE1MKCl7CiAgY29uc3QgaXRlbXM9T2JqZWN0LmVudHJpZXMod2F0Y2hlZE1hcCkuc29ydCgoYSxiKT0+KGJbMV0udHN8fDApLShhWzFdLnRzfHwwKSk7CiAgaWYoIWl0ZW1zLmxlbmd0aClyZXR1cm4gJzxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxM3B4O2NvbG9yOnZhcigtLW11dDIpO3BhZGRpbmc6OHB4IDJweCI+Tm90aGluZyBsb2dnZWQgeWV0LiBSYXRlIGEgc3VnZ2VzdGlvbiBhbmQgaXRcJ2xsIHNoYXBlIHdoYXQgY29tZXMgbmV4dC48L2Rpdj4nOwogIHJldHVybiBpdGVtcy5tYXAoKFtpZCx3XSk9Pic8ZGl2IGNsYXNzPSJsb2dpdGVtIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDonKyh3Lmxpa2VkPyd2YXIoLS1nb29kKSc6dy5saWtlZD09PWZhbHNlPyd2YXIoLS1iYWQpJzondmFyKC0tbXV0MiknKSsnIj48L3NwYW4+JwogICAgKyc8YnV0dG9uIGNsYXNzPSJpdGVtdGl0bGUiIGRhdGEtYWN0PSJleHBhbmQiIGRhdGEtc3JjPSJsb2ciIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj4nK2VzYyh3LnRpdGxlKSsnPC9idXR0b24+JwogICAgKyc8c3BhbiBzdHlsZT0iZm9udC1zaXplOjExLjVweDtjb2xvcjp2YXIoLS1tdXQyKSI+Jysody5saWtlZD8nTG92ZWQgaXQnOncubGlrZWQ9PT1mYWxzZT8nTm90IGZvciBtZSc6J1NlZW4nKSsnPC9zcGFuPicKICAgICsnPGJ1dHRvbiBjbGFzcz0iY2hpcCIgZGF0YS1hY3Q9InVud2F0Y2giIGRhdGEtaWQ9IicrZXNjKGlkKSsnIiBzdHlsZT0ibWFyZ2luLWxlZnQ6YXV0bztiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjpub25lO2NvbG9yOnZhcigtLW11dDIpO2ZvbnQtc2l6ZToxNXB4O3BhZGRpbmc6MCA0cHg7Y3Vyc29yOnBvaW50ZXIiPiZ0aW1lczs8L2J1dHRvbj48L2Rpdj4nKS5qb2luKCIiKTsKfQpmdW5jdGlvbiBsb2dCdXR0b25IVE1MKCl7CiAgY29uc3QgYz13YXRjaGVkQ291bnQoKTsKICByZXR1cm4gJzxidXR0b24gY2xhc3M9Imdob3N0IiBpZD0ibG9nYnRuIj48c3BhbiBjbGFzcz0iZG90IiBzdHlsZT0iYmFja2dyb3VuZDonKyhjPyd2YXIoLS1nb2xkKSc6J3ZhcigtLW11dDIpJykrJyI+PC9zcGFuPldhdGNoZWQgJysoYz8nKCcrYysnKSc6JycpKycgJysoc2hvd0xvZz8n4pa0Jzon4pa+JykrJzwvYnV0dG9uPic7Cn0KZnVuY3Rpb24gd2lyZUxvZ0NvbnRyb2xzKHNjb3BlKXsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9InVud2F0Y2giXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5yZW1vdmVXYXRjaGVkKGIuZGF0YXNldC5pZCkpOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0iaXRlbS1yZW1vdmUiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5yZW1vdmVJdGVtRnJvbUxpc3QoYi5kYXRhc2V0Lmxpc3QsYi5kYXRhc2V0LmlkKSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJsaXN0LXJlbmFtZSJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PnJlbmFtZUxpc3RQcm9tcHQoYi5kYXRhc2V0Lmxpc3QpKTsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Imxpc3QtZGVsZXRlIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+ZGVsZXRlTGlzdENvbmZpcm0oYi5kYXRhc2V0Lmxpc3QpKTsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Imxpc3QtbmV3Il0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+Y3JlYXRlTGlzdFByb21wdCgpKTsKICBjb25zdCBsYj1zY29wZS5xdWVyeVNlbGVjdG9yKCIjbG9nYnRuIik7IGlmKGxiKWxiLm9uY2xpY2s9KCk9PntzaG93TG9nPSFzaG93TG9nOyBpZihkYXRhKXJlbmRlcigpOyByZW5kZXJJbnB1dExvZygpO307CiAgY29uc3Qgd2I9c2NvcGUucXVlcnlTZWxlY3RvcigiI2xpc3RidG4iKTsgaWYod2Ipd2Iub25jbGljaz0oKT0+e3Nob3dMaXN0PSFzaG93TGlzdDsgaWYoZGF0YSlyZW5kZXIoKTsgcmVuZGVySW5wdXRMb2coKTt9OwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0iZXhwYW5kIl0nKS5mb3JFYWNoKGZ1bmN0aW9uKGIpe2Iub25jbGljaz1mdW5jdGlvbigpe3ZhciBvYmo9Yi5kYXRhc2V0LnNyYz09PSJsaXN0Ij8od2F0Y2hsaXN0c1tiLmRhdGFzZXQubGlzdF0mJndhdGNobGlzdHNbYi5kYXRhc2V0Lmxpc3RdLml0ZW1zJiZ3YXRjaGxpc3RzW2IuZGF0YXNldC5saXN0XS5pdGVtc1tiLmRhdGFzZXQuaWRdKTp3YXRjaGVkTWFwW2IuZGF0YXNldC5pZF07aWYob2JqKW9wZW5EZXRhaWwob2JqKTt9O30pOwp9CmZ1bmN0aW9uIHJlbmRlcklucHV0TG9nKCl7CiAgY29uc3QgYm94PSQoIiNpbnB1dGxvZyIpOwogIGlmKHdhdGNoZWRDb3VudCgpPT09MCYmbGlzdENvdW50KCk9PT0wKXtib3guaW5uZXJIVE1MPSIiO3JldHVybjt9CiAgbGV0IGg9JzxkaXYgY2xhc3M9ImhyIiBzdHlsZT0ibWFyZ2luOjIwcHggMCAxNnB4Ij48L2Rpdj48ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7ZmxleC13cmFwOndyYXAiPicrbGlzdEJ1dHRvbkhUTUwoKStsb2dCdXR0b25IVE1MKCkrJzwvZGl2Pic7CiAgaWYoc2hvd0xpc3QpaCs9JzxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+Jyt3YXRjaGxpc3RzUGFuZWxIVE1MKCkrJzwvZGl2Pic7CiAgaWYoc2hvd0xvZyloKz0nPGRpdiBzdHlsZT0ibWFyZ2luLXRvcDoxNHB4Ij4nK2xvZ0xpc3RIVE1MKCkrJzwvZGl2Pic7CiAgYm94LmlubmVySFRNTD1oOwogIHdpcmVMb2dDb250cm9scyhib3gpOwp9CgovLyAtLS0tIGlucHV0IC0tLS0KZnVuY3Rpb24gcmVuZGVyQ2hpcHMoKXsKICBjb25zdCBib3g9JCgiI2NoaXBzIik7CiAgYm94LnF1ZXJ5U2VsZWN0b3JBbGwoIi5jaGlwIikuZm9yRWFjaChlPT5lLnJlbW92ZSgpKTsKICBjb25zdCBkcmFmdD0kKCIjZHJhZnQiKTsKICBzaG93cy5mb3JFYWNoKChzLGkpPT57CiAgICBjb25zdCBlbD1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJzcGFuIik7ZWwuY2xhc3NOYW1lPSJjaGlwIjsKICAgIGVsLmlubmVySFRNTD1lc2MocykrJyA8YnV0dG9uIGFyaWEtbGFiZWw9IlJlbW92ZSI+JnRpbWVzOzwvYnV0dG9uPic7CiAgICBlbC5xdWVyeVNlbGVjdG9yKCJidXR0b24iKS5vbmNsaWNrPSgpPT57c2hvd3Muc3BsaWNlKGksMSk7cmVuZGVyQ2hpcHMoKTt9OwogICAgYm94Lmluc2VydEJlZm9yZShlbCxkcmFmdCk7CiAgfSk7CiAgZHJhZnQuc3R5bGUuZGlzcGxheT1zaG93cy5sZW5ndGg+PTEwPyJub25lIjoiYmxvY2siOwogIGRyYWZ0LnBsYWNlaG9sZGVyPXNob3dzLmxlbmd0aD8iQWRkIGFub3RoZXLigKYiOiJUeXBlIGEgdGl0bGUsIHByZXNzIEVudGVyIjsKICAkKCIjY291bnQiKS50ZXh0Q29udGVudD1zaG93cy5sZW5ndGgrIiAvIDEwIjsKICAkKCIjY291bnQiKS5zdHlsZS5jb2xvcj1zaG93cy5sZW5ndGg+PTM/InZhcigtLWdvbGQpIjoidmFyKC0tbXV0MikiOwogIGNvbnN0IG9rPXNob3dzLmxlbmd0aD49MzsKICAkKCIjZ28iKS5kaXNhYmxlZD0hb2s7CiAgJCgiI2hpbnQiKS5zdHlsZS5kaXNwbGF5PW9rPyJub25lIjoiYmxvY2siOwogICQoIiNleGFtcGxlIikuc3R5bGUuZGlzcGxheT1zaG93cy5sZW5ndGg/Im5vbmUiOiJibG9jayI7Cn0KZnVuY3Rpb24gYWRkRHJhZnQoKXtjb25zdCBkPSQoIiNkcmFmdCIpO2xldCB2PWQudmFsdWUudHJpbSgpLnJlcGxhY2UoLywkLywiIikudHJpbSgpOwogIGlmKCF2KXJldHVybjtpZihzaG93cy5zb21lKHM9PnMudG9Mb3dlckNhc2UoKT09PXYudG9Mb3dlckNhc2UoKSkpe2QudmFsdWU9IiI7cmV0dXJuO30KICBpZihzaG93cy5sZW5ndGg8MTApc2hvd3MucHVzaCh2KTtkLnZhbHVlPSIiO3JlbmRlckNoaXBzKCk7fQokKCIjZHJhZnQiKS5hZGRFdmVudExpc3RlbmVyKCJrZXlkb3duIixlPT57CiAgaWYoZS5rZXk9PT0iRW50ZXIifHxlLmtleT09PSIsIil7ZS5wcmV2ZW50RGVmYXVsdCgpO2FkZERyYWZ0KCk7fQogIGVsc2UgaWYoZS5rZXk9PT0iQmFja3NwYWNlIiYmISQoIiNkcmFmdCIpLnZhbHVlJiZzaG93cy5sZW5ndGgpe3Nob3dzLnBvcCgpO3JlbmRlckNoaXBzKCk7fQp9KTsKJCgiI2V4YW1wbGUiKS5vbmNsaWNrPSgpPT57c2hvd3M9Wy4uLkVYQU1QTEVdO3JlbmRlckNoaXBzKCk7fTsKJCgiI2dvIikub25jbGljaz1kaXNjb3ZlcjsKCgphc3luYyBmdW5jdGlvbiByZWFkSnNvbihyLGZhbGxiYWNrTXNnKXsKICB2YXIgY3Q9ci5oZWFkZXJzLmdldCgiY29udGVudC10eXBlIil8fCIiOwogIGlmKGN0LmluZGV4T2YoImFwcGxpY2F0aW9uL2pzb24iKT09PS0xKXsKICAgIHZhciB0PShhd2FpdCByLnRleHQoKSkudHJpbSgpOwogICAgaWYodC5jaGFyQXQoMCk9PT0iPCIpIHRocm93IG5ldyBFcnJvcigiVGhlIHNlcnZlciBpcyB3YWtpbmcgdXAgXHUyMDE0IHRoZSBmcmVlIGhvc3RpbmcgcGxhbiBzbGVlcHMgYWZ0ZXIgMTUgbWludXRlcyBvZiBubyB1c2UuIFBsZWFzZSB3YWl0IHVwIHRvIGEgbWludXRlLCB0aGVuIHByZXNzIHRoZSBidXR0b24gYWdhaW4uIik7CiAgICB0aHJvdyBuZXcgRXJyb3IodC5zbGljZSgwLDIwMCl8fGZhbGxiYWNrTXNnfHwoIlJlcXVlc3QgZmFpbGVkICgiK3Iuc3RhdHVzKyIpIikpOwogIH0KICB2YXIgaj1hd2FpdCByLmpzb24oKTsKICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKGouZXJyb3J8fGZhbGxiYWNrTXNnfHwiUmVxdWVzdCBmYWlsZWQiKTsKICByZXR1cm4gajsKfQoKYXN5bmMgZnVuY3Rpb24gZGlzY292ZXIoKXsKICBjb25zdCByZXN1bHRzPSQoIiNyZXN1bHRzIiksIGlucHV0PSQoIiNpbnB1dCIpOwogIGlucHV0LnN0eWxlLmRpc3BsYXk9Im5vbmUiO3Jlc3VsdHMuc3R5bGUuZGlzcGxheT0iYmxvY2siO3Nob3dMb2c9ZmFsc2U7ZXhoYXVzdGVkPWZhbHNlO2xvYWRpbmdNb3JlPWZhbHNlO3NraXBwZWQ9W107CiAgcmVzdWx0cy5pbm5lckhUTUw9JzxkaXYgY2xhc3M9ImxvYWQiIHN0eWxlPSJjb2xvcjp2YXIoLS1tdXQpO3RleHQtYWxpZ246Y2VudGVyO3BhZGRpbmc6NDBweCAwIj5SZWFkaW5nIHlvdXIgdGFzdGUsIHB1bGxpbmcgcmVhbCByYXRpbmdzICZhbXA7IGF2YWlsYWJpbGl0eeKApjwvZGl2Pic7CiAgZmlsdGVycz17dHlwZToiYWxsIixtaW46MCxzdmNzOltdLHNvcnQ6Im1hdGNoIn07CiAgdHJ5ewogICAgY29uc3Qgcj1hd2FpdCBmZXRjaCgiL2FwaS9kaXNjb3ZlciIse21ldGhvZDoiUE9TVCIsaGVhZGVyczp7IkNvbnRlbnQtVHlwZSI6ImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTpKU09OLnN0cmluZ2lmeSh7bG92ZWQ6c2hvd3MsY291bnRyeTpyZWdpb25TZWwudmFsdWUsdHlwZTp0eXBlU2VsLnZhbHVlLGdlbnJlOmdlbnJlU2VsLnZhbHVlLHdhdGNoZWQ6d2F0Y2hlZE1hcH0pfSk7CiAgICBjb25zdCBqPWF3YWl0IHJlYWRKc29uKHIsIlJlcXVlc3QgZmFpbGVkIik7CiAgICBkYXRhPWo7cmVuZGVyKCk7CiAgfWNhdGNoKGUpewogICAgcmVzdWx0cy5pbm5lckhUTUw9JzxkaXYgY2xhc3M9InJjIiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXIiPjxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206MTRweCI+Jytlc2MoZS5tZXNzYWdlKSsnPC9kaXY+PGJ1dHRvbiBjbGFzcz0iY3RhIiBvbmNsaWNrPSJkaXNjb3ZlcigpIj5UcnkgYWdhaW48L2J1dHRvbj48L2Rpdj4nOwogIH0KfQoKZnVuY3Rpb24gb2JzZXJ2ZVNlbnRpbmVsKCl7CiAgaWYoaW8paW8uZGlzY29ubmVjdCgpOwogIGNvbnN0IGVsPSQoIiNzZW50aW5lbCIpOyBpZighZWwpcmV0dXJuOwogIGlvPW5ldyBJbnRlcnNlY3Rpb25PYnNlcnZlcihlcz0+eyBpZihlc1swXS5pc0ludGVyc2VjdGluZykgbG9hZE1vcmUoKTsgfSx7cm9vdE1hcmdpbjoiNTAwcHgifSk7CiAgaW8ub2JzZXJ2ZShlbCk7Cn0KYXN5bmMgZnVuY3Rpb24gbG9hZE1vcmUoKXsKICBpZihsb2FkaW5nTW9yZXx8ZXhoYXVzdGVkfHwhZGF0YSlyZXR1cm47CiAgbG9hZGluZ01vcmU9dHJ1ZTsgcmVuZGVyKCk7CiAgdHJ5ewogICAgY29uc3QgZXhjbHVkZT1kYXRhLnJlc3VsdHMubWFwKHg9PngudGl0bGUpLmNvbmNhdChza2lwcGVkKTsKICAgIGNvbnN0IHI9YXdhaXQgZmV0Y2goIi9hcGkvZGlzY292ZXIiLHttZXRob2Q6IlBPU1QiLGhlYWRlcnM6eyJDb250ZW50LVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sCiAgICAgIGJvZHk6SlNPTi5zdHJpbmdpZnkoe2xvdmVkOnNob3dzLGNvdW50cnk6cmVnaW9uU2VsLnZhbHVlLGV4Y2x1ZGUsdHlwZTp0eXBlU2VsLnZhbHVlLGdlbnJlOmdlbnJlU2VsLnZhbHVlLHdhdGNoZWQ6d2F0Y2hlZE1hcH0pfSk7CiAgICBjb25zdCBqPWF3YWl0IHJlYWRKc29uKHIsIkNvdWxkbid0IGxvYWQgbW9yZSIpOwogICAgY29uc3QgaGF2ZT1uZXcgU2V0KGRhdGEucmVzdWx0cy5tYXAoeD0+bnJtKHgudGl0bGUpKSk7CiAgICBjb25zdCBhZGQ9KGoucmVzdWx0c3x8W10pLmZpbHRlcih4PT4haGF2ZS5oYXMobnJtKHgudGl0bGUpKSk7CiAgICBpZihhZGQubGVuZ3RoPT09MCl7ZXhoYXVzdGVkPXRydWU7fSBlbHNlIHtkYXRhLnJlc3VsdHM9ZGF0YS5yZXN1bHRzLmNvbmNhdChhZGQpO30KICB9Y2F0Y2goZSl7IGV4aGF1c3RlZD10cnVlOyB9CiAgbG9hZGluZ01vcmU9ZmFsc2U7IHJlbmRlcigpOwp9CgpmdW5jdGlvbiBtZXRlcih2YWwscGN0LGRpc3AsbGFiKXsKICByZXR1cm4gJzxkaXYgY2xhc3M9InNjIj48ZGl2IGNsYXNzPSJsYWIiPicrbGFiKyc8L2Rpdj48ZGl2IGNsYXNzPSJ2YWwiIHN0eWxlPSJjb2xvcjonKyh2YWw9PW51bGw/InZhcigtLW11dDIpIjoidmFyKC0tdGV4dCkiKSsnIj4nK2Rpc3ArJzwvZGl2PjxkaXYgY2xhc3M9Im1ldGVyIj48aSBzdHlsZT0id2lkdGg6JysocGN0PT1udWxsPzA6TWF0aC5tYXgoMyxNYXRoLm1pbigxMDAscGN0KSkpKyclO2JhY2tncm91bmQ6JytzY29yZUNvbG9yKHBjdCkrJyI+PC9pPjwvZGl2PjwvZGl2Pic7Cn0KCmZ1bmN0aW9uIHZpZHNIVE1MKHgpewogIGlmKCF4LnZpZGVvc3x8IXgudmlkZW9zLmxlbmd0aClyZXR1cm4gJyc7CiAgdmFyIHQ9eC52aWRlb3Muc2xpY2UoMCw4KS5tYXAoZnVuY3Rpb24odil7cmV0dXJuICc8YnV0dG9uIGNsYXNzPSJ2dGh1bWIiIGRhdGEtYWN0PSJ0cmFpbGVyIiBkYXRhLWtleT0iJytlc2Modi5rZXkpKyciIHRpdGxlPSInK2VzYyh2Lm5hbWV8fHYudHlwZXx8J1ZpZGVvJykrJyI+PHNwYW4gY2xhc3M9InZ0aHVtYi1pbWciIHN0eWxlPSJiYWNrZ3JvdW5kLWltYWdlOnVybChodHRwczovL2ltZy55b3V0dWJlLmNvbS92aS8nK2VzYyh2LmtleSkrJy9tcWRlZmF1bHQuanBnKSI+PHNwYW4gY2xhc3M9InZwbGF5Ij7ilrY8L3NwYW4+PC9zcGFuPjxzcGFuIGNsYXNzPSJ2Y2FwIj4nK2VzYyh2Lm5hbWV8fHYudHlwZXx8J1ZpZGVvJykrJzwvc3Bhbj48L2J1dHRvbj4nO30pLmpvaW4oJycpOwogIHJldHVybiAnPGRpdiBjbGFzcz0iaHIiPjwvZGl2PjxkaXYgY2xhc3M9ImxhYjIiPlRyYWlsZXJzICYgdGVhc2VyczwvZGl2PjxkaXYgY2xhc3M9InZyb3ciPicrdCsnPC9kaXY+JzsKfQpmdW5jdGlvbiBjYXJkKHgpewogIGNvbnN0IGlkPW5ybSh4LnRpdGxlKSwgdz13YXRjaGVkTWFwW2lkXTsKICBjb25zdCBTVkNTPVt7aWQ6Im5ldGZsaXgiLHJlOi9uZXRmbGl4L2ksbGFiZWw6Ik5ldGZsaXgiLG1hcms6Ik4iLGJnOiIjRTUwOTE0IixmZzoiI2ZmZiJ9LHtpZDoicHJpbWUiLHJlOi9wcmltZXxhbWF6b24vaSxsYWJlbDoiUHJpbWUgVmlkZW8iLG1hcms6IlAiLGJnOiIjMDBBOEUxIixmZzoiIzAwMjQzZCJ9LHtpZDoiZGlzbmV5IixyZTovZGlzbmV5L2ksbGFiZWw6IkRpc25leSsiLG1hcms6IkQrIixiZzoiIzBDMUE2QiIsZmc6IiNmZmYifSx7aWQ6ImFwcGxlIixyZTovYXBwbGUvaSxsYWJlbDoiQXBwbGUgVFYiLG1hcms6IlRWIixiZzoiIzExMSIsZmc6IiNmZmYifV07CiAgY29uc3Qgc3Zjcz14LnNlcnZpY2VzfHxbXTsKICBjb25zdCBpY29ucz1TVkNTLm1hcChmdW5jdGlvbihzdil7dmFyIGhpdD1zdmNzLmZpbmQoZnVuY3Rpb24ocyl7cmV0dXJuIHMmJigocy5pZD09PXN2LmlkKXx8KHMubmFtZSYmc3YucmUudGVzdChzLm5hbWUpKSk7fSk7dmFyIG9uPSEhaGl0LGxpbms9aGl0JiZoaXQubGluazt2YXIgaWM9JzxzcGFuIGNsYXNzPSJzdmNpY29uJysob24/Jyc6JyBvZmYnKSsnIicrKG9uPycgc3R5bGU9ImJhY2tncm91bmQ6Jytzdi5iZysnO2NvbG9yOicrc3YuZmcrJztib3JkZXItY29sb3I6dHJhbnNwYXJlbnQiJzonJykrJyB0aXRsZT0iJytzdi5sYWJlbCsob24/JyDigJQgYXZhaWxhYmxlJzonIOKAlCBub3QgYXZhaWxhYmxlJykrJyI+Jytzdi5tYXJrKyc8L3NwYW4+JztyZXR1cm4gKG9uJiZsaW5rKT8nPGEgaHJlZj0iJytlc2MobGluaykrJyIgdGFyZ2V0PSJfYmxhbmsiIHJlbD0ibm9vcGVuZXIiIHN0eWxlPSJ0ZXh0LWRlY29yYXRpb246bm9uZSI+JytpYysnPC9hPic6aWM7fSkuam9pbigiIik7CiAgY29uc3QgZXh0cmE9c3Zjcy5maWx0ZXIoZnVuY3Rpb24ocyl7cmV0dXJuIHMmJiFTVkNTLnNvbWUoZnVuY3Rpb24oc3Ype3JldHVybiAocy5pZD09PXN2LmlkKXx8KHMubmFtZSYmc3YucmUudGVzdChzLm5hbWUpKTt9KTt9KTsKICB2YXIgcmZvdW5kPVJFR0lPTlMuZmluZChmdW5jdGlvbihyKXtyZXR1cm4gclswXT09PSh4LmNvdW50cnl8fCIiKS50b0xvd2VyQ2FzZSgpO30pOwogIHZhciByZWdpb25OYW1lPXJmb3VuZD9yZm91bmRbMV06KCh4LmNvdW50cnl8fCIiKS50b1VwcGVyQ2FzZSgpKTsKICB2YXIgd2F0Y2g9JzxkaXYgY2xhc3M9ImxhYjIiPldoZXJlIHRvIHdhdGNoIGluICcrZXNjKHJlZ2lvbk5hbWUpKyc8L2Rpdj48ZGl2IGNsYXNzPSJzdmNyb3ciPicraWNvbnMrJzwvZGl2Pic7CiAgaWYoZXh0cmEubGVuZ3RoKXdhdGNoKz0nPGRpdiBzdHlsZT0iZm9udC1zaXplOjExcHg7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLXRvcDo4cHgiPkFsc28gb24gJytleHRyYS5zbGljZSgwLDQpLm1hcChmdW5jdGlvbihzKXtyZXR1cm4gZXNjKHMubmFtZSk7fSkuam9pbigiLCAiKSsnPC9kaXY+JzsKICBpZighc3Zjcy5sZW5ndGgpd2F0Y2grPSc8ZGl2IHN0eWxlPSJmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tdG9wOjhweCI+Tm8gc3RyZWFtaW5nIGluZm8gZm9yICcrZXNjKHJlZ2lvbk5hbWUpKycgcmlnaHQgbm93LjwvZGl2Pic7CiAgY29uc3QgaW5MaXN0cz1saXN0c0ZvclRpdGxlKGlkKSwgb25Bbnk9aW5MaXN0cy5sZW5ndGg+MDsKICBjb25zdCBtZW51Um93cz1PYmplY3QudmFsdWVzKHdhdGNobGlzdHMpLnNvcnQoKGEsYik9PihhLnRzfHwwKS0oYi50c3x8MCkpLm1hcChMPT4nPGJ1dHRvbiBjbGFzcz0ibG1pJysodGl0bGVJbkxpc3QoTC5pZCxpZCk/JyBvbic6JycpKyciIGRhdGEtYWN0PSJ0b2xpc3QiIGRhdGEtbGlzdD0iJytlc2MoTC5pZCkrJyIgZGF0YS1pZD0iJytlc2MoaWQpKyciPicrKHRpdGxlSW5MaXN0KEwuaWQsaWQpPyfinJMgJzonKyAnKStlc2MoTC5uYW1lKSsnPC9idXR0b24+Jykuam9pbigiIik7CiAgY29uc3QgbGlzdEJ0bj0nPGRpdiBjbGFzcz0id2x3cmFwIj48YnV0dG9uIGNsYXNzPSJ3bCcrKG9uQW55Pycgb24nOicnKSsnIiBkYXRhLWFjdD0ibWVudSIgZGF0YS1pZD0iJytlc2MoaWQpKyciPicrKG9uQW55PyfinJMgT24geW91ciBsaXN0cyDilr4nOicrIEFkZCB0byBsaXN0IOKWvicpKyc8L2J1dHRvbj48ZGl2IGNsYXNzPSJsbWVudSI+JyttZW51Um93cysnPGJ1dHRvbiBjbGFzcz0ibG1pIG5ldyIgZGF0YS1hY3Q9Im5ld2xpc3QiIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj4rIE5ldyBsaXN04oCmPC9idXR0b24+PC9kaXY+PC9kaXY+JzsKICBsZXQgc2VlbjsKICBpZih3KXsKICAgIHNlZW49JzxkaXYgY2xhc3M9InNlZW5yb3ciIHN0eWxlPSJqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbiI+PHNwYW4gY2xhc3M9IndhdGNoZWR0YWciIHN0eWxlPSJjb2xvcjonKyh3Lmxpa2VkPyd2YXIoLS1nb29kKSc6J3ZhcigtLWJhZCknKSsnIj7inJMgV2F0Y2hlZCDCtyAnKyh3Lmxpa2VkPydMb3ZlZCBpdCc6J05vdCBmb3IgbWUnKSsnPC9zcGFuPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJ1bmRvIiBkYXRhLWFjdD0idW53YXRjaCIgZGF0YS1pZD0iJytlc2MoaWQpKyciPnVuZG88L2J1dHRvbj48L2Rpdj4nOwogIH1lbHNlewogICAgc2Vlbj0nPGRpdiBjbGFzcz0ic2VlbnJvdyI+PGJ1dHRvbiBjbGFzcz0ic2tpcCIgZGF0YS1hY3Q9InNraXAiIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj7inJUgU2tpcDwvYnV0dG9uPicKICAgICAgKyc8c3BhbiBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLWxlZnQ6YXV0bzttYXJnaW4tcmlnaHQ6MnB4Ij5TZWVuIGl0Pzwvc3Bhbj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0icmF0ZSB1cCIgZGF0YS1hY3Q9Imxpa2UiIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj7wn5GNIExvdmVkIGl0PC9idXR0b24+JwogICAgICArJzxidXR0b24gY2xhc3M9InJhdGUgZG93biIgZGF0YS1hY3Q9ImRpc2xpa2UiIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj7wn5GOIE5vdCBmb3IgbWU8L2J1dHRvbj48L2Rpdj4nOwogIH0KICBjb25zdCBmb290PSc8ZGl2IGNsYXNzPSJmb290Ij4nK2xpc3RCdG4rc2VlbisnPC9kaXY+JzsKICByZXR1cm4gJzxkaXYgY2xhc3M9InJjJysodz8nIHNlZW4nOicnKSsnIj48ZGl2IGNsYXNzPSJoZWFkIj4nKyh4LnBvc3Rlcj8nPGltZyBjbGFzcz0icG9zdGVyIiBzcmM9IicrZXNjKHgucG9zdGVyKSsnIiBhbHQ9IiIgbG9hZGluZz0ibGF6eSIgb25lcnJvcj0idGhpcy5zdHlsZS5kaXNwbGF5PVwnbm9uZVwnIj4nOic8ZGl2IGNsYXNzPSJwb3N0ZXIgcGgiPm5vIGFydHdvcms8L2Rpdj4nKSsnPGRpdiBjbGFzcz0iaGVhZG1ldGEiPjxkaXYgY2xhc3M9ImtpY2tlciI+Jytlc2MoeC50eXBlKSsoeC55ZWFyPycgwrcgJytlc2MoeC55ZWFyKTonJykrJzwvZGl2PjxkaXYgY2xhc3M9InJ0LXRpdGxlIj4nK2VzYyh4LnRpdGxlKSsnPC9kaXY+PGRpdiBjbGFzcz0icmVhc29uIj4nK2VzYyh4LnJlYXNvbikrJzwvZGl2PjwvZGl2PjwvZGl2PicKICAgICsoeC5vdmVydmlldz8nPGRpdiBjbGFzcz0id3JpdGV1cCI+Jytlc2MoeC5vdmVydmlldykrJzwvZGl2Pic6JycpCiAgICArJzxkaXYgY2xhc3M9ImhyIj48L2Rpdj48ZGl2IGNsYXNzPSJzY29yZXMiPicKICAgICsgbWV0ZXIoeC5pbWRiLCB4LmltZGIhPW51bGw/eC5pbWRiKjEwOm51bGwsIHguaW1kYiE9bnVsbD9OdW1iZXIoeC5pbWRiKS50b0ZpeGVkKDEpOiLigJQiLCJJTURiIikKICAgICsgbWV0ZXIoeC50bWRiLCB4LnRtZGIhPW51bGw/eC50bWRiKjEwOm51bGwsIHgudG1kYiE9bnVsbD9OdW1iZXIoeC50bWRiKS50b0ZpeGVkKDEpOiLigJQiLCJUTURiIikKICAgICsnPC9kaXY+PGRpdiBjbGFzcz0iaHIiPjwvZGl2Picrd2F0Y2grJzxkaXYgY2xhc3M9ImhyIj48L2Rpdj4nK2Zvb3Qrdmlkc0hUTUwoeCkrJzwvZGl2Pic7Cn0KCmZ1bmN0aW9uIHNlZyhuYW1lLG9wdHMsY3VyKXsKICByZXR1cm4gJzxkaXY+PGRpdiBjbGFzcz0ibGFiMiI+JytuYW1lLmxhYmVsKyc8L2Rpdj48ZGl2IGNsYXNzPSJzZWciPicrb3B0cy5tYXAobz0+CiAgICAnPGJ1dHRvbiBjbGFzcz0iJysoby52PT09Y3VyPyJvbiI6IiIpKyciIGRhdGEtaz0iJytuYW1lLmtleSsnIiBkYXRhLXY9Iicrby52KyciPicrby50Kyc8L2J1dHRvbj4nKS5qb2luKCIiKSsnPC9kaXY+PC9kaXY+JzsKfQoKZnVuY3Rpb24gcmVuZGVyKCl7CiAgY29uc3QgcmVzdWx0cz0kKCIjcmVzdWx0cyIpOwogIGxldCBsaXN0PWRhdGEucmVzdWx0cy5maWx0ZXIoeD0+ewogICAgaWYoZmlsdGVycy50eXBlIT09ImFsbCImJngudHlwZS50b0xvd2VyQ2FzZSgpIT09ZmlsdGVycy50eXBlKXJldHVybiBmYWxzZTsKICAgIGlmKGZpbHRlcnMuc3Zjcy5sZW5ndGgpe3ZhciBva1M9ZmlsdGVycy5zdmNzLnNvbWUoZnVuY3Rpb24oaWQpe3ZhciByZT1pZD09PSJuZXRmbGl4Ij8vbmV0ZmxpeC9pOmlkPT09InByaW1lIj8vcHJpbWV8YW1hem9uL2k6aWQ9PT0iZGlzbmV5Ij8vZGlzbmV5L2k6L2FwcGxlL2k7cmV0dXJuICh4LnNlcnZpY2VzfHxbXSkuc29tZShmdW5jdGlvbihzKXtyZXR1cm4gcyYmKChzLmlkPT09aWQpfHwocy5uYW1lJiZyZS50ZXN0KHMubmFtZSkpKTt9KXx8KGlkPT09Im5ldGZsaXgiJiZ4Lm9uTmV0ZmxpeD09PXRydWUpO30pO2lmKCFva1MpcmV0dXJuIGZhbHNlO30KICAgIGlmKGZpbHRlcnMubWluPjAmJih4LmltZGI9PW51bGx8fE51bWJlcih4LmltZGIpPGZpbHRlcnMubWluKSlyZXR1cm4gZmFsc2U7CiAgICByZXR1cm4gdHJ1ZTsKICB9KTsKICBpZihmaWx0ZXJzLnNvcnQ9PT0iaW1kYiIpbGlzdD1bLi4ubGlzdF0uc29ydCgoYSxiKT0+KGIuaW1kYnx8LTEpLShhLmltZGJ8fC0xKSk7CiAgaWYoZmlsdGVycy5zb3J0PT09InJ0IilsaXN0PVsuLi5saXN0XS5zb3J0KChhLGIpPT4oYi5ydENyaXRpY3N8fC0xKS0oYS5ydENyaXRpY3N8fC0xKSk7CgogIGNvbnN0IGJhcj0nPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtnYXA6MTJweDttYXJnaW4tYm90dG9tOjE4cHg7ZmxleC13cmFwOndyYXAiPicKICAgICsnPGJ1dHRvbiBjbGFzcz0iZ2hvc3QiIGlkPSJiYWNrIj7ihpAgU3RhcnQgb3ZlcjwvYnV0dG9uPicKICAgICsnPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTJweDtmbGV4LXdyYXA6d3JhcCI+PHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMi41cHg7Y29sb3I6dmFyKC0tbXV0KSI+TWF0Y2hlZCB0byAnK3Nob3dzLmxlbmd0aCsnIGxvdmVzIMK3IE5ldGZsaXggJytlc2MoZGF0YS5jb3VudHJ5TmFtZSkrJzwvc3Bhbj4nK2xpc3RCdXR0b25IVE1MKCkrbG9nQnV0dG9uSFRNTCgpKyc8L2Rpdj48L2Rpdj4nOwoKICBjb25zdCBwYW5lbD1zaG93TG9nPyc8ZGl2IGNsYXNzPSJsb2dwYW5lbCI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjExcHg7bGV0dGVyLXNwYWNpbmc6LjFlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLWJvdHRvbToxMnB4Ij5Zb3VyIHdhdGNoIGhpc3Rvcnkgwrcgc2hhcGVzIGV2ZXJ5IHN1Z2dlc3Rpb248L2Rpdj4nK2xvZ0xpc3RIVE1MKCkrJzwvZGl2Pic6Jyc7CiAgY29uc3QgbGlzdFBhbmVsPXNob3dMaXN0Pyc8ZGl2IGNsYXNzPSJsb2dwYW5lbCI+PGRpdiBzdHlsZT0iZm9udC1zaXplOjExcHg7bGV0dGVyLXNwYWNpbmc6LjFlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLWJvdHRvbToxMnB4Ij5Zb3VyIGxpc3RzPC9kaXY+Jyt3YXRjaGxpc3RzUGFuZWxIVE1MKCkrJzwvZGl2Pic6Jyc7CgogIGNvbnN0IHRvb2xiYXI9JzxkaXYgY2xhc3M9InRvb2xiYXIiPicKICAgICsgc2VnKHtsYWJlbDoiVHlwZSIsa2V5OiJ0eXBlIn0sW3t2OiJhbGwiLHQ6IkFsbCJ9LHt2OiJtb3ZpZSIsdDoiTW92aWVzIn0se3Y6InNlcmllcyIsdDoiU2VyaWVzIn1dLGZpbHRlcnMudHlwZSkKICAgICsgc2VnKHtsYWJlbDoiTWluIElNRGIiLGtleToibWluIn0sW3t2OjAsdDoiQW55In0se3Y6Nyx0OiI3KyJ9LHt2OjgsdDoiOCsifV0sZmlsdGVycy5taW4pCiAgICArIHNlZyh7bGFiZWw6IlNvcnQgYnkiLGtleToic29ydCJ9LFt7djoibWF0Y2giLHQ6Ik1hdGNoIn0se3Y6ImltZGIiLHQ6IklNRGIifSx7djoicnQiLHQ6IlJUIn1dLGZpbHRlcnMuc29ydCkKICAgICsgJzxkaXYgc3R5bGU9Im1hcmdpbi1sZWZ0OmF1dG8iPjxkaXYgY2xhc3M9ImxhYjIiPkF2YWlsYWJsZSBvbjwvZGl2PjxkaXYgY2xhc3M9InN2Y2ZpbHRlcnMiPicrWyduZXRmbGl4JywncHJpbWUnLCdkaXNuZXknLCdhcHBsZSddLm1hcChmdW5jdGlvbihpZCl7dmFyIG5tPXtuZXRmbGl4OiJOZXRmbGl4IixwcmltZToiUHJpbWUiLGRpc25leToiRGlzbmV5KyIsYXBwbGU6IkFwcGxlIFRWIn1baWRdO3JldHVybiAnPGJ1dHRvbiBjbGFzcz0ic3ZjZicrKGZpbHRlcnMuc3Zjcy5pbmRleE9mKGlkKT4tMT8nIG9uJzonJykrJyIgZGF0YS1zdmM9IicraWQrJyI+JytubSsnPC9idXR0b24+Jzt9KS5qb2luKCIiKSsnPC9kaXY+PC9kaXY+JwogICAgKyAnPC9kaXY+JzsKCiAgY29uc3QgYm9keT1saXN0Lmxlbmd0aAogICAgPyAnPGRpdiBjbGFzcz0iZ3JpZCI+JytsaXN0Lm1hcChjYXJkKS5qb2luKCIiKSsnPC9kaXY+JwogICAgOiAnPGRpdiBzdHlsZT0iY29sb3I6dmFyKC0tbXV0KTt0ZXh0LWFsaWduOmNlbnRlcjtwYWRkaW5nOjQwcHggMCI+Tm90aGluZyBtYXRjaGVzIHRoZXNlIGZpbHRlcnMuIExvb3NlbiB0aGVtIHRvIHNlZSBtb3JlLjwvZGl2Pic7CgogIGNvbnN0IG5vdGU9JzxwIGNsYXNzPSJub3RlIj5SYXRpbmdzIHZpYSBPTURiIChJTURiIMK3IFJvdHRlbiBUb21hdG9lcyDCtyBNZXRhY3JpdGljKS4gJwogICAgK2VzYyhkYXRhLmF0dHJpYnV0aW9uKSsnLiBNb3JlIGxvYWQgYXV0b21hdGljYWxseSBhcyB5b3Ugc2Nyb2xsLCBlYWNoIGJhdGNoIGF2b2lkaW5nIHdoYXQgeW91XCd2ZSBhbHJlYWR5IHNlZW4uIFlvdXIgd2F0Y2ggaGlzdG9yeSBpcyBzYXZlZCBzZXJ2ZXItc2lkZSBhbmQgZmVlZHMgZXZlcnkgc3VnZ2VzdGlvbi48L3A+JzsKCiAgY29uc3QgZm9vdGVyID0gZXhoYXVzdGVkCiAgICA/ICc8ZGl2IHN0eWxlPSJ0ZXh0LWFsaWduOmNlbnRlcjtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTNweDtwYWRkaW5nOjI0cHggMCA4cHgiPlRoYXRcJ3MgdGhlIGJlc3Qgb2Ygd2hhdCBmaXRzIHlvdXIgdGFzdGUgcmlnaHQgbm93LiBSYXRlIGEgZmV3IGFuZCBzdGFydCBvdmVyIGZvciBhIGZyZXNoIHJlYWQuPC9kaXY+JwogICAgOiAobG9hZGluZ01vcmUKICAgICAgICA/ICc8ZGl2IGNsYXNzPSJsb2FkIiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7Y29sb3I6dmFyKC0tbXV0KTtmb250LXNpemU6MTMuNXB4O3BhZGRpbmc6MjRweCAwIDhweCI+RmluZGluZyBtb3JlIGZvciB5b3XigKY8L2Rpdj4nCiAgICAgICAgOiAnPGRpdiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzoyMHB4IDAgNHB4Ij48YnV0dG9uIGNsYXNzPSJnaG9zdCIgaWQ9ImxvYWRtb3JlIj5Mb2FkIG1vcmU8L2J1dHRvbj48L2Rpdj4nKTsKICBjb25zdCBzZW50aW5lbD0nPGRpdiBpZD0ic2VudGluZWwiIHN0eWxlPSJoZWlnaHQ6MXB4Ij48L2Rpdj4nOwoKICByZXN1bHRzLmlubmVySFRNTD1iYXIrbGlzdFBhbmVsK3BhbmVsK3Rvb2xiYXIrYm9keStmb290ZXIrc2VudGluZWwrbm90ZTsKICAkKCIjYmFjayIpLm9uY2xpY2s9KCk9PntyZXN1bHRzLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyQoIiNpbnB1dCIpLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjt9OwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnLnN2Y2YnKS5mb3JFYWNoKGZ1bmN0aW9uKGIpe2Iub25jbGljaz1mdW5jdGlvbigpe3ZhciBpZD1iLmRhdGFzZXQuc3ZjO3ZhciBpPWZpbHRlcnMuc3Zjcy5pbmRleE9mKGlkKTtpZihpPi0xKWZpbHRlcnMuc3Zjcy5zcGxpY2UoaSwxKTtlbHNlIGZpbHRlcnMuc3Zjcy5wdXNoKGlkKTtyZW5kZXIoKTt9O30pOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgiLnNlZyBidXR0b24iKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+ewogICAgY29uc3Qgaz1iLmRhdGFzZXQuaztsZXQgdj1iLmRhdGFzZXQudjtpZihrPT09Im1pbiIpdj1OdW1iZXIodik7ZmlsdGVyc1trXT12O3JlbmRlcigpOwogIH0pOwogIC8vIHdhdGNoZWQgY29udHJvbHMKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ibGlrZSJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9Pntjb25zdCByPWRhdGEucmVzdWx0cy5maW5kKHg9Pm5ybSh4LnRpdGxlKT09PWIuZGF0YXNldC5pZCk7aWYociltYXJrV2F0Y2hlZChyLHRydWUsdHJ1ZSk7fSk7CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9InRyYWlsZXIiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5vcGVuVHJhaWxlcihiLmRhdGFzZXQua2V5KSk7CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9ImRpc2xpa2UiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57Y29uc3Qgcj1kYXRhLnJlc3VsdHMuZmluZCh4PT5ucm0oeC50aXRsZSk9PT1iLmRhdGFzZXQuaWQpO2lmKHIpbWFya1dhdGNoZWQocixmYWxzZSx0cnVlKTt9KTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ic2tpcCJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9Pntjb25zdCByPWRhdGEucmVzdWx0cy5maW5kKHg9Pm5ybSh4LnRpdGxlKT09PWIuZGF0YXNldC5pZCk7aWYocilza2lwVGl0bGUocik7fSk7CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Im1lbnUiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57Y29uc3QgbW09Yi5wYXJlbnRFbGVtZW50LnF1ZXJ5U2VsZWN0b3IoJy5sbWVudScpO2lmKG1tKW1tLmNsYXNzTGlzdC50b2dnbGUoJ29wZW4nKTt9KTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0idG9saXN0Il0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+e2NvbnN0IHI9ZGF0YS5yZXN1bHRzLmZpbmQoeD0+bnJtKHgudGl0bGUpPT09Yi5kYXRhc2V0LmlkKTtpZihyKXRvZ2dsZVRpdGxlSW5MaXN0KGIuZGF0YXNldC5saXN0LHIpO30pOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJuZXdsaXN0Il0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+e2NvbnN0IHI9ZGF0YS5yZXN1bHRzLmZpbmQoeD0+bnJtKHgudGl0bGUpPT09Yi5kYXRhc2V0LmlkKTtpZihyKW5ld0xpc3RGb3JDYXJkKHIpO30pOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJ1bndhdGNoIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+cmVtb3ZlV2F0Y2hlZChiLmRhdGFzZXQuaWQpKTsKICB3aXJlTG9nQ29udHJvbHMocmVzdWx0cyk7CiAgY29uc3QgbG09JCgiI2xvYWRtb3JlIik7IGlmKGxtKWxtLm9uY2xpY2s9bG9hZE1vcmU7CiAgb2JzZXJ2ZVNlbnRpbmVsKCk7Cn0KCmZ1bmN0aW9uIG9wZW5UcmFpbGVyKGtleSl7dmFyIGY9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRmcmFtZSIpO2lmKGYpZi5zcmM9Imh0dHBzOi8vd3d3LnlvdXR1YmUuY29tL2VtYmVkLyIra2V5KyI/YXV0b3BsYXk9MSI7dmFyIG1tPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0bW9kYWwiKTtpZihtbSltbS5jbGFzc0xpc3QuYWRkKCJvcGVuIik7fQpmdW5jdGlvbiBjbG9zZVRyYWlsZXIoKXt2YXIgZj1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidGZyYW1lIik7aWYoZilmLnNyYz0iIjt2YXIgbW09ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRtb2RhbCIpO2lmKG1tKW1tLmNsYXNzTGlzdC5yZW1vdmUoIm9wZW4iKTt9CnZhciBkZXRhaWxPYmo9bnVsbDsKZnVuY3Rpb24gd2lyZURldGFpbChzY29wZSl7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJ0cmFpbGVyIl0nKS5mb3JFYWNoKGZ1bmN0aW9uKGIpe2Iub25jbGljaz1mdW5jdGlvbigpe29wZW5UcmFpbGVyKGIuZGF0YXNldC5rZXkpO307fSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJtZW51Il0nKS5mb3JFYWNoKGZ1bmN0aW9uKGIpe2Iub25jbGljaz1mdW5jdGlvbigpe3ZhciBtbT1iLnBhcmVudEVsZW1lbnQucXVlcnlTZWxlY3RvcignLmxtZW51Jyk7aWYobW0pbW0uY2xhc3NMaXN0LnRvZ2dsZSgnb3BlbicpO307fSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJ0b2xpc3QiXScpLmZvckVhY2goZnVuY3Rpb24oYil7Yi5vbmNsaWNrPWZ1bmN0aW9uKCl7aWYoZGV0YWlsT2JqKXRvZ2dsZVRpdGxlSW5MaXN0KGIuZGF0YXNldC5saXN0LGRldGFpbE9iaik7cmVmcmVzaERldGFpbCgpO307fSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJuZXdsaXN0Il0nKS5mb3JFYWNoKGZ1bmN0aW9uKGIpe2Iub25jbGljaz1mdW5jdGlvbigpe2lmKGRldGFpbE9iailuZXdMaXN0Rm9yQ2FyZChkZXRhaWxPYmopO3JlZnJlc2hEZXRhaWwoKTt9O30pOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ibGlrZSJdJykuZm9yRWFjaChmdW5jdGlvbihiKXtiLm9uY2xpY2s9ZnVuY3Rpb24oKXtpZihkZXRhaWxPYmopbWFya1dhdGNoZWQoZGV0YWlsT2JqLHRydWUpO3JlZnJlc2hEZXRhaWwoKTt9O30pOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0iZGlzbGlrZSJdJykuZm9yRWFjaChmdW5jdGlvbihiKXtiLm9uY2xpY2s9ZnVuY3Rpb24oKXtpZihkZXRhaWxPYmopbWFya1dhdGNoZWQoZGV0YWlsT2JqLGZhbHNlKTtyZWZyZXNoRGV0YWlsKCk7fTt9KTsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9InVud2F0Y2giXScpLmZvckVhY2goZnVuY3Rpb24oYil7Yi5vbmNsaWNrPWZ1bmN0aW9uKCl7dW53YXRjaChiLmRhdGFzZXQuaWQpO3JlZnJlc2hEZXRhaWwoKTt9O30pOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ic2tpcCJdJykuZm9yRWFjaChmdW5jdGlvbihiKXtiLm9uY2xpY2s9ZnVuY3Rpb24oKXtpZihkZXRhaWxPYmopc2tpcFRpdGxlKGRldGFpbE9iaik7Y2xvc2VEZXRhaWwoKTt9O30pOwp9CmZ1bmN0aW9uIHJlZnJlc2hEZXRhaWwoKXt2YXIgYm9keT1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZGV0YWlsLWJvZHkiKTtpZihib2R5JiZkZXRhaWxPYmope2JvZHkuaW5uZXJIVE1MPWNhcmQoZGV0YWlsT2JqKTt3aXJlRGV0YWlsKGJvZHkpO319CmZ1bmN0aW9uIG9wZW5EZXRhaWwoZW50cnkpewogIHZhciBib2R5PWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJkZXRhaWwtYm9keSIpLG1tPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJkbW9kYWwiKTsKICBpZighYm9keXx8IW1tfHwhZW50cnkpcmV0dXJuOwogIGJvZHkuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJsb2FkIiBzdHlsZT0icGFkZGluZzozNHB4IDIwcHg7dGV4dC1hbGlnbjpjZW50ZXI7Y29sb3I6dmFyKC0tbXV0KSI+TG9hZGluZyBkZXRhaWxz4oCmPC9kaXY+JzsKICBtbS5jbGFzc0xpc3QuYWRkKCJvcGVuIik7CiAgdmFyIHR5PShlbnRyeS50eXBlfHwiIikudG9Mb3dlckNhc2UoKTt0eT10eT09PSJzZXJpZXMiPyJzZXJpZXMiOnR5PT09Im1vdmllIj8ibW92aWUiOiIiOwogIGZldGNoKCIvYXBpL3RpdGxlIix7bWV0aG9kOiJQT1NUIixoZWFkZXJzOnsiQ29udGVudC1UeXBlIjoiYXBwbGljYXRpb24vanNvbiJ9LGJvZHk6SlNPTi5zdHJpbmdpZnkoe3RpdGxlOmVudHJ5LnRpdGxlLHllYXI6ZW50cnkueWVhcnx8IiIsdHlwZTp0eSxjb3VudHJ5OnJlZ2lvblNlbC52YWx1ZX0pfSkKICAgIC50aGVuKGZ1bmN0aW9uKHIpe3JldHVybiByLmpzb24oKS50aGVuKGZ1bmN0aW9uKGope2lmKCFyLm9rKXRocm93IG5ldyBFcnJvcihqLmVycm9yfHwiTG9va3VwIGZhaWxlZCIpO3JldHVybiBqO30pO30pCiAgICAudGhlbihmdW5jdGlvbihqKXtkZXRhaWxPYmo9ai5yZXN1bHQ7Ym9keS5pbm5lckhUTUw9Y2FyZChqLnJlc3VsdCk7d2lyZURldGFpbChib2R5KTt9KQogICAgLmNhdGNoKGZ1bmN0aW9uKGUpe2JvZHkuaW5uZXJIVE1MPSc8ZGl2IHN0eWxlPSJwYWRkaW5nOjI0cHg7dGV4dC1hbGlnbjpjZW50ZXIiPjxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206MTJweDtjb2xvcjp2YXIoLS10ZXh0KSI+Jytlc2MoZS5tZXNzYWdlKSsnPC9kaXY+PGJ1dHRvbiBjbGFzcz0iZ2hvc3QiIG9uY2xpY2s9ImNsb3NlRGV0YWlsKCkiPkNsb3NlPC9idXR0b24+PC9kaXY+Jzt9KTsKfQpmdW5jdGlvbiBjbG9zZURldGFpbCgpe2RldGFpbE9iaj1udWxsO3ZhciBtbT1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZG1vZGFsIik7aWYobW0pbW0uY2xhc3NMaXN0LnJlbW92ZSgib3BlbiIpO3ZhciBiPWRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJkZXRhaWwtYm9keSIpO2lmKGIpYi5pbm5lckhUTUw9IiI7fQp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsZnVuY3Rpb24oZSl7aWYoZS5rZXk9PT0iRXNjYXBlIil7dmFyIHQ9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRtb2RhbCIpO2lmKHQmJnQuY2xhc3NMaXN0LmNvbnRhaW5zKCJvcGVuIikpY2xvc2VUcmFpbGVyKCk7ZWxzZSBjbG9zZURldGFpbCgpO319KTsKcmVuZGVyQ2hpcHMoKTsKbG9hZFdhdGNoZWQoKTsKbG9hZFdhdGNobGlzdHMoKTsKCnZhciBfcz1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic3RhdHVzIik7aWYoX3Mpe19zLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjtfcy5zdHlsZS5iYWNrZ3JvdW5kPSIjMTIyODFjIjtfcy5zdHlsZS5ib3JkZXI9IjFweCBzb2xpZCAjMmY1YTNkIjtfcy5zdHlsZS5jb2xvcj0iI2JmZThjZiI7X3MudGV4dENvbnRlbnQ9IlJlYWR5IFx1MjAxNCB0eXBlIGEgdGl0bGUsIHByZXNzIEVudGVyLCBhZGQgYXQgbGVhc3QgMy4iO30KPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=", "base64").toString("utf8");

app.get("/", (_req, res) => res.type("html").send(PAGE));

app.listen(PORT, () => console.log(`What Next server → http://localhost:${PORT}`));
