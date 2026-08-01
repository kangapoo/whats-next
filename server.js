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
    const included = opts.filter((o) => ["subscription", "free", "addon"].includes(o.type));
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
      const seedList = [...e.seeds];
      return {
        title: tTitle(raw),
        year: tYear(raw),
        type: media === "tv" ? "Series" : "Movie",
        reason: seedList.length ? `Because you enjoyed ${seedList[0]}` : "A strong match for your taste",
        overview: raw.overview || omdb?.plot || null,
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

const PAGE = Buffer.from("PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04IiAvPgo8bWV0YSBuYW1lPSJ2aWV3cG9ydCIgY29udGVudD0id2lkdGg9ZGV2aWNlLXdpZHRoLCBpbml0aWFsLXNjYWxlPTEiIC8+Cjx0aXRsZT5XaGF0IE5leHQgwrcgTmV0ZmxpeCB0YXN0ZS1tYXRjaGVyPC90aXRsZT4KPHN0eWxlPgogIDpyb290ewogICAgLS1iZzojMEUxMTE2OyAtLWJnMjojMTIxNjFDOyAtLWNhcmQ6IzE3MUMyNDsgLS1jYXJkSGk6IzFDMjIyQjsKICAgIC0tbGluZTojMjcyRTM5OyAtLWdvbGQ6I0U4QjQ0QTsgLS10ZXh0OiNGMkVERTM7IC0tbXV0OiM4QjkzQTA7IC0tbXV0MjojNUM2NDcwOwogICAgLS1nb29kOiM0RkI0Nzc7IC0tbWlkOiNFOEI0NEE7IC0tYmFkOiNFMDU3NEI7IC0tbmV0OiM0RkI0Nzc7CiAgfQogICp7Ym94LXNpemluZzpib3JkZXItYm94fQogIGJvZHl7bWFyZ2luOjA7YmFja2dyb3VuZDp2YXIoLS1iZyk7Y29sb3I6dmFyKC0tdGV4dCk7CiAgICBmb250LWZhbWlseTotYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwnU2Vnb2UgVUknLFJvYm90byxzYW5zLXNlcmlmO30KICAud3JhcHttYXgtd2lkdGg6OTQwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjQwcHggMjJweCA3MnB4fQogIC5leWVicm93e2ZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4yMmVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1nb2xkKTttYXJnaW4tYm90dG9tOjEwcHh9CiAgaDF7Zm9udC1mYW1pbHk6dWktc2VyaWYsR2VvcmdpYSxzZXJpZjtmb250LXNpemU6NDZweDtsaW5lLWhlaWdodDoxLjAyO21hcmdpbjowO2ZvbnQtd2VpZ2h0OjYwMDtsZXR0ZXItc3BhY2luZzotLjAxZW19CiAgLnN1Yntjb2xvcjp2YXIoLS1tdXQpO2ZvbnQtc2l6ZToxNXB4O21hcmdpbi10b3A6MTJweDttYXgtd2lkdGg6NTIwcHg7bGluZS1oZWlnaHQ6MS41fQogIC5wYW5lbHtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE4cHg7cGFkZGluZzoyNHB4fQogIC5yb3d7ZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDo4cHh9CiAgLmNoaXB7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtiYWNrZ3JvdW5kOnZhcigtLWNhcmRIaSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTsKICAgIGJvcmRlci1yYWRpdXM6OTk5cHg7cGFkZGluZzo3cHggOHB4IDdweCAxNHB4O2ZvbnQtc2l6ZToxMy41cHh9CiAgLmNoaXAgYnV0dG9ue2N1cnNvcjpwb2ludGVyO2JvcmRlcjpub25lO2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Y29sb3I6dmFyKC0tbXV0KTtmb250LXNpemU6MTVweDtsaW5lLWhlaWdodDoxO3BhZGRpbmc6MCAycHh9CiAgaW5wdXQudGl0bGV7ZmxleDoxIDAgMTYwcHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS10ZXh0KTtmb250LXNpemU6MTRweDtwYWRkaW5nOjhweCA0cHg7bWluLXdpZHRoOjE0MHB4O291dGxpbmU6bm9uZX0KICBpbnB1dC50aXRsZTo6cGxhY2Vob2xkZXJ7Y29sb3I6dmFyKC0tbXV0Mil9CiAgc2VsZWN0e2JhY2tncm91bmQ6dmFyKC0tY2FyZEhpKTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjEwcHggMTRweDtmb250LXNpemU6MTRweDtjdXJzb3I6cG9pbnRlcn0KICAuY3Rhe2JhY2tncm91bmQ6dmFyKC0tZ29sZCk7Y29sb3I6IzIwMTgwYTtib3JkZXI6bm9uZTtib3JkZXItcmFkaXVzOjEwcHg7cGFkZGluZzoxM3B4IDI2cHg7Zm9udC1zaXplOjE0LjVweDtmb250LXdlaWdodDo3MDA7Y3Vyc29yOnBvaW50ZXJ9CiAgLmN0YVtkaXNhYmxlZF17YmFja2dyb3VuZDp2YXIoLS1jYXJkSGkpO2NvbG9yOnZhcigtLW11dDIpO2N1cnNvcjpub3QtYWxsb3dlZH0KICAuaHJ7aGVpZ2h0OjFweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpfQogIC5ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KGF1dG8tZmlsbCxtaW5tYXgoMzAwcHgsMWZyKSk7Z2FwOjE2cHh9CiAgLnJje2JhY2tncm91bmQ6dmFyKC0tY2FyZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjE0cHg7cGFkZGluZzoxOHB4O2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjEycHh9CiAgLnJjLnNlZW57Ym9yZGVyLWNvbG9yOnJnYmEoMjMyLDE4MCw3NCwuMjgpfQogIC5raWNrZXJ7Zm9udC1zaXplOjEwcHg7bGV0dGVyLXNwYWNpbmc6LjEyZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLWdvbGQpfQogIC5ydC10aXRsZXtmb250LWZhbWlseTp1aS1zZXJpZixHZW9yZ2lhLHNlcmlmO2ZvbnQtc2l6ZToyMnB4O2xpbmUtaGVpZ2h0OjEuMTU7Zm9udC13ZWlnaHQ6NjAwfQogIC5yZWFzb257Zm9udC1zaXplOjEzLjVweDtsaW5lLWhlaWdodDoxLjU7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tdG9wOjZweH0KICAud3JpdGV1cHtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU1O2NvbG9yOnZhcigtLW11dCl9CiAgLmhlYWR7ZGlzcGxheTpmbGV4O2dhcDoxNHB4O2FsaWduLWl0ZW1zOmZsZXgtc3RhcnR9CiAgLmhlYWRtZXRhe21pbi13aWR0aDowO2ZsZXg6MX0KICAucG9zdGVye3dpZHRoOjcycHg7aGVpZ2h0OjEwOHB4O2JvcmRlci1yYWRpdXM6OHB4O29iamVjdC1maXQ6Y292ZXI7YmFja2dyb3VuZDp2YXIoLS1jYXJkSGkpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7ZmxleDpub25lO2Rpc3BsYXk6YmxvY2t9CiAgLnBvc3Rlci5waHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjlweDt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7bGV0dGVyLXNwYWNpbmc6LjA2ZW07dGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzo0cHh9CiAgLnNjb3Jlc3tkaXNwbGF5OmZsZXg7Z2FwOjE2cHh9CiAgLnNje2ZsZXg6MTttaW4td2lkdGg6MH0KICAuc2MgLmxhYntmb250LXNpemU6MTBweDtsZXR0ZXItc3BhY2luZzouMDhlbTt0ZXh0LXRyYW5zZm9ybTp1cHBlcmNhc2U7Y29sb3I6dmFyKC0tbXV0Mik7bWFyZ2luLWJvdHRvbTo0cHh9CiAgLnNjIC52YWx7Zm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLE1lbmxvLG1vbm9zcGFjZTtmb250LXNpemU6MjBweDtmb250LXdlaWdodDo2MDA7bGluZS1oZWlnaHQ6MX0KICAubWV0ZXJ7aGVpZ2h0OjNweDtib3JkZXItcmFkaXVzOjJweDtiYWNrZ3JvdW5kOnZhcigtLWxpbmUpO21hcmdpbi10b3A6OHB4O292ZXJmbG93OmhpZGRlbn0KICAubWV0ZXI+aXtkaXNwbGF5OmJsb2NrO2hlaWdodDoxMDAlO2JvcmRlci1yYWRpdXM6MnB4fQogIC5sYWIye2ZvbnQtc2l6ZToxMHB4O2xldHRlci1zcGFjaW5nOi4wOGVtO3RleHQtdHJhbnNmb3JtOnVwcGVyY2FzZTtjb2xvcjp2YXIoLS1tdXQyKTttYXJnaW4tYm90dG9tOjhweH0KICAuc3Zje2Rpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo1cHg7Zm9udC1zaXplOjExLjVweDtib3JkZXItcmFkaXVzOjhweDtwYWRkaW5nOjRweCA5cHg7dGV4dC1kZWNvcmF0aW9uOm5vbmV9CiAgLnN2Yy5uZXR7Y29sb3I6I2JmZThjZjtiYWNrZ3JvdW5kOnJnYmEoNzksMTgwLDExOSwuMTQpO2JvcmRlcjoxcHggc29saWQgcmdiYSg3OSwxODAsMTE5LC4zNSl9CiAgLnN2Yy5wbGFpbntjb2xvcjp2YXIoLS1tdXQpO2JhY2tncm91bmQ6cmdiYSgxMzksMTQ3LDE2MCwuMDgpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSl9CiAgLnN2Yy5wbGFpbjpob3Zlcntjb2xvcjp2YXIoLS10ZXh0KX0KICAuc2VlbnJvd3tkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHh9CiAgLnJhdGV7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzo2cHggMTJweDtmb250LXNpemU6MTIuNXB4O2ZvbnQtd2VpZ2h0OjYwMDtjdXJzb3I6cG9pbnRlcn0KICAucmF0ZS51cHtiYWNrZ3JvdW5kOnJnYmEoNzksMTgwLDExOSwuMTApO2JvcmRlcjoxcHggc29saWQgcmdiYSg3OSwxODAsMTE5LC4zKTtjb2xvcjojYmZlOGNmfQogIC5yYXRlLmRvd257YmFja2dyb3VuZDpyZ2JhKDIyNCw4Nyw3NSwuMDgpO2JvcmRlcjoxcHggc29saWQgcmdiYSgyMjQsODcsNzUsLjI4KTtjb2xvcjojZWZiM2FkfQogIC53YXRjaGVkdGFne2ZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NjAwfQogIC51bmRve2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjEycHg7Y3Vyc29yOnBvaW50ZXI7dGV4dC1kZWNvcmF0aW9uOnVuZGVybGluZTtwYWRkaW5nOjJweH0KICAudG9vbGJhcntkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjE4cHg7YWxpZ24taXRlbXM6ZmxleC1lbmQ7cGFkZGluZzoxNHB4IDE2cHg7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMnB4O21hcmdpbi1ib3R0b206MjBweH0KICAuc2Vne2Rpc3BsYXk6aW5saW5lLWZsZXg7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czo5cHg7cGFkZGluZzozcHg7Z2FwOjJweH0KICAuc2VnIGJ1dHRvbntib3JkZXI6bm9uZTtjdXJzb3I6cG9pbnRlcjtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjZweCAxMnB4O2ZvbnQtc2l6ZToxMi41cHg7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtjb2xvcjp2YXIoLS1tdXQpfQogIC5zZWcgYnV0dG9uLm9ue2JhY2tncm91bmQ6dmFyKC0tZ29sZCk7Y29sb3I6IzIwMTgwYTtmb250LXdlaWdodDo3MDB9CiAgLmdob3N0e2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtjb2xvcjp2YXIoLS10ZXh0KTtib3JkZXItcmFkaXVzOjk5OXB4O3BhZGRpbmc6OHB4IDE2cHg7Zm9udC1zaXplOjEzcHg7Y3Vyc29yOnBvaW50ZXI7ZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjdweH0KICAuZG90e3dpZHRoOjZweDtoZWlnaHQ6NnB4O2JvcmRlci1yYWRpdXM6OTk5cHg7YmFja2dyb3VuZDp2YXIoLS1tdXQyKX0KICAubG9ncGFuZWx7YmFja2dyb3VuZDp2YXIoLS1iZzIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMnB4O3BhZGRpbmc6MTZweDttYXJnaW4tYm90dG9tOjIwcHh9CiAgLmxvZ2l0ZW17ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDtiYWNrZ3JvdW5kOnZhcigtLWNhcmQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Ym9yZGVyLXJhZGl1czoxMHB4O3BhZGRpbmc6OXB4IDEycHh9CiAgLmZvb3R7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6MTBweH0KICAud2x7YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWxpbmUpO2NvbG9yOnZhcigtLW11dCk7Ym9yZGVyLXJhZGl1czo4cHg7cGFkZGluZzo3cHggMTJweDtmb250LXNpemU6MTIuNXB4O2N1cnNvcjpwb2ludGVyO3RleHQtYWxpZ246Y2VudGVyO3dpZHRoOjEwMCV9CiAgLndsOmhvdmVye2NvbG9yOnZhcigtLXRleHQpfQogIC53bC5vbntib3JkZXItY29sb3I6cmdiYSgyMzIsMTgwLDc0LC40KTtjb2xvcjp2YXIoLS1nb2xkKTtiYWNrZ3JvdW5kOnJnYmEoMjMyLDE4MCw3NCwuMDgpfQogIC53bHdyYXB7cG9zaXRpb246cmVsYXRpdmV9CiAgLmxtZW51e2Rpc3BsYXk6bm9uZTtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjRweDttYXJnaW4tdG9wOjZweDtwYWRkaW5nOjhweDtiYWNrZ3JvdW5kOnZhcigtLWJnMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1saW5lKTtib3JkZXItcmFkaXVzOjhweH0KICAubG1lbnUub3BlbntkaXNwbGF5OmZsZXh9CiAgLmxtaXtiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O2JvcmRlcjoxcHggc29saWQgdmFyKC0tbGluZSk7Y29sb3I6dmFyKC0tbXV0KTtib3JkZXItcmFkaXVzOjZweDtwYWRkaW5nOjZweCAxMHB4O2ZvbnQtc2l6ZToxMi41cHg7Y3Vyc29yOnBvaW50ZXI7dGV4dC1hbGlnbjpsZWZ0fQogIC5sbWk6aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dCl9CiAgLmxtaS5vbntib3JkZXItY29sb3I6cmdiYSgyMzIsMTgwLDc0LC40KTtjb2xvcjp2YXIoLS1nb2xkKX0KICAubG1pLm5ld3tjb2xvcjp2YXIoLS1nb2xkKTtib3JkZXItc3R5bGU6ZGFzaGVkfQogIC50aW55YnRue2JhY2tncm91bmQ6dHJhbnNwYXJlbnQ7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjExLjVweDtjdXJzb3I6cG9pbnRlcjt0ZXh0LWRlY29yYXRpb246dW5kZXJsaW5lO3BhZGRpbmc6MnB4IDRweH0KICAudGlueWJ0bjpob3Zlcntjb2xvcjp2YXIoLS10ZXh0KX0KICAubm90ZXtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTJweDtsaW5lLWhlaWdodDoxLjY7bWFyZ2luLXRvcDoyNnB4O21heC13aWR0aDo2NDBweH0KICBhLmxpbmt7Y29sb3I6dmFyKC0tZ29sZCk7dGV4dC1kZWNvcmF0aW9uOm5vbmU7Zm9udC1zaXplOjEyLjVweH0KICBidXR0b246Zm9jdXMtdmlzaWJsZSxpbnB1dDpmb2N1cy12aXNpYmxlLHNlbGVjdDpmb2N1cy12aXNpYmxlLC5zZWcgYnV0dG9uOmZvY3VzLXZpc2libGV7b3V0bGluZToycHggc29saWQgdmFyKC0tZ29sZCk7b3V0bGluZS1vZmZzZXQ6MnB4fQogIEBrZXlmcmFtZXMgcHswJSwxMDAle29wYWNpdHk6LjQ1fTUwJXtvcGFjaXR5Oi44fX0gLmxvYWR7YW5pbWF0aW9uOnAgMS40cyBlYXNlLWluLW91dCBpbmZpbml0ZX0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KPGRpdiBjbGFzcz0id3JhcCI+CiAgPGRpdiBpZD0ic3RhdHVzIiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbjowIDAgMThweDtwYWRkaW5nOjEwcHggMTRweDtib3JkZXItcmFkaXVzOjEwcHg7Zm9udC1zaXplOjEzLjVweCI+PC9kaXY+CiAgPGRpdiBjbGFzcz0iZXllYnJvdyI+TmV0ZmxpeCB0YXN0ZS1tYXRjaGVyPC9kaXY+CiAgPGgxPldoYXQgbmV4dC48L2gxPgogIDxwIGNsYXNzPSJzdWIiPk5hbWUgYSBoYW5kZnVsIG9mIHRoaW5ncyB5b3Ugd2F0Y2hlZCBhbmQgbG92ZWQuIFJlYWwgSU1EYiAmYW1wOyBSb3R0ZW4gVG9tYXRvZXMgc2NvcmVzLCByZWFsIHJlZ2lvbmFsIGF2YWlsYWJpbGl0eSwgZGVlcCBsaW5rcyB0byB3aGVyZSBpdCBzdHJlYW1zIOKAlCBhbmQgaXQgbGVhcm5zIGZyb20gd2hhdCB5b3UgcmF0ZS48L3A+CgogIDxkaXYgaWQ9ImlucHV0IiBzdHlsZT0ibWFyZ2luLXRvcDozMHB4IiBjbGFzcz0icGFuZWwiPgogICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmJhc2VsaW5lO21hcmdpbi1ib3R0b206MTJweCI+CiAgICAgIDxsYWJlbCBzdHlsZT0iZm9udC1zaXplOjEzcHg7Zm9udC13ZWlnaHQ6NjAwIj5UaGluZ3MgeW91IGxvdmVkPC9sYWJlbD4KICAgICAgPHNwYW4gaWQ9ImNvdW50IiBzdHlsZT0iZm9udC1mYW1pbHk6dWktbW9ub3NwYWNlLG1vbm9zcGFjZTtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQyKSI+MCAvIDEwPC9zcGFuPgogICAgPC9kaXY+CiAgICA8ZGl2IGlkPSJjaGlwcyIgY2xhc3M9InJvdyIgc3R5bGU9Im1hcmdpbi1ib3R0b206MTRweCI+CiAgICAgIDxpbnB1dCBjbGFzcz0idGl0bGUiIGlkPSJkcmFmdCIgcGxhY2Vob2xkZXI9IlR5cGUgYSB0aXRsZSwgcHJlc3MgRW50ZXIiIC8+CiAgICA8L2Rpdj4KICAgIDxidXR0b24gaWQ9ImV4YW1wbGUiIHN0eWxlPSJiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tZ29sZCk7Zm9udC1zaXplOjEyLjVweDtjdXJzb3I6cG9pbnRlcjtwYWRkaW5nOjAgMCA4cHgiPk5lZWQgYSBzcGFyaz8gTG9hZCBhbiBleGFtcGxlIOKGkjwvYnV0dG9uPgogICAgPGRpdiBjbGFzcz0iaHIiIHN0eWxlPSJtYXJnaW46NnB4IDAgMThweCI+PC9kaXY+CiAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjE2cHg7YWxpZ24taXRlbXM6ZmxleC1lbmQ7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW4iPgogICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjE2cHgiPgogICAgICAgIDxkaXY+CiAgICAgICAgICA8bGFiZWwgZm9yPSJyZWdpb24iIHN0eWxlPSJkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCk7bWFyZ2luLWJvdHRvbTo3cHgiPldhdGNoaW5nIGZyb208L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBpZD0icmVnaW9uIj48L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGZvcj0idHlwZSIgc3R5bGU9ImRpc3BsYXk6YmxvY2s7Zm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0KTttYXJnaW4tYm90dG9tOjdweCI+U2hvdyBtZTwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJ0eXBlIj48L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2PgogICAgICAgICAgPGxhYmVsIGZvcj0iZ2VucmUiIHN0eWxlPSJkaXNwbGF5OmJsb2NrO2ZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dCk7bWFyZ2luLWJvdHRvbTo3cHgiPkdlbnJlPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImdlbnJlIj48L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gaWQ9ImdvIiBjbGFzcz0iY3RhIiBkaXNhYmxlZD5GaW5kIG15IG5leHQgd2F0Y2g8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBpZD0iaGludCIgc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi10b3A6MTJweCI+QWRkIGF0IGxlYXN0IDMgdGl0bGVzIGZvciBhIGdvb2QgcmVhZCBvbiB5b3VyIHRhc3RlLjwvZGl2PgogICAgPGRpdiBpZD0iaW5wdXRsb2ciPjwvZGl2PgogIDwvZGl2PgoKICA8ZGl2IGlkPSJyZXN1bHRzIiBzdHlsZT0iZGlzcGxheTpub25lO21hcmdpbi10b3A6MzBweCI+PC9kaXY+CjwvZGl2PgoKPHNjcmlwdD4Kd2luZG93Lm9uZXJyb3I9ZnVuY3Rpb24obSl7dmFyIHM9ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInN0YXR1cyIpO2lmKHMpe3Muc3R5bGUuZGlzcGxheT0iYmxvY2siO3Muc3R5bGUuYmFja2dyb3VuZD0iIzViMWExYSI7cy5zdHlsZS5ib3JkZXI9IjFweCBzb2xpZCAjYTMzIjtzLnN0eWxlLmNvbG9yPSIjZmZkOWQ0IjtzLnRleHRDb250ZW50PSJQcm9ibGVtIHN0YXJ0aW5nIHRoZSBhcHA6ICIrbTt9cmV0dXJuIGZhbHNlO307Cgpjb25zdCBSRUdJT05TPVtbInphIiwiU291dGggQWZyaWNhIl0sWyJ1cyIsIlVuaXRlZCBTdGF0ZXMiXSxbImdiIiwiVW5pdGVkIEtpbmdkb20iXSxbImNhIiwiQ2FuYWRhIl0sWyJhdSIsIkF1c3RyYWxpYSJdLFsiaW4iLCJJbmRpYSJdLFsibmciLCJOaWdlcmlhIl0sWyJrZSIsIktlbnlhIl0sWyJkZSIsIkdlcm1hbnkiXSxbImZyIiwiRnJhbmNlIl0sWyJlcyIsIlNwYWluIl0sWyJiciIsIkJyYXppbCJdLFsibXgiLCJNZXhpY28iXSxbImpwIiwiSmFwYW4iXSxbImtyIiwiU291dGggS29yZWEiXV07CmNvbnN0IEVYQU1QTEU9WyJEYXJrIiwiVGhlIEJlYXIiLCJCcmVha2luZyBCYWQiLCJQYXJhc2l0ZSIsIkZsZWFiYWciXTsKbGV0IHNob3dzPVtdLCBkYXRhPW51bGwsIHdhdGNoZWRNYXA9e30sIHdhdGNobGlzdHM9e30sIHNob3dMb2c9ZmFsc2UsIHNob3dMaXN0PWZhbHNlOwpsZXQgbG9hZGluZ01vcmU9ZmFsc2UsIGV4aGF1c3RlZD1mYWxzZSwgaW89bnVsbDsKbGV0IGZpbHRlcnM9e3R5cGU6ImFsbCIsbWluOjAsbmV0OmZhbHNlLHNvcnQ6Im1hdGNoIn07Cgpjb25zdCAkPXM9PmRvY3VtZW50LnF1ZXJ5U2VsZWN0b3Iocyk7CmNvbnN0IG5ybT1zPT5TdHJpbmcoc3x8IiIpLnRyaW0oKS50b0xvd2VyQ2FzZSgpOwpjb25zdCBlc2M9cz0+U3RyaW5nKHMpLnJlcGxhY2UoL1smPD4iXS9nLGM9Pih7IiYiOiImYW1wOyIsIjwiOiImbHQ7IiwiPiI6IiZndDsiLCciJzoiJnF1b3Q7In1bY10pKTsKY29uc3Qgd2F0Y2hlZENvdW50PSgpPT5PYmplY3Qua2V5cyh3YXRjaGVkTWFwKS5sZW5ndGg7Cgpjb25zdCByZWdpb25TZWw9JCgiI3JlZ2lvbiIpOwpSRUdJT05TLmZvckVhY2goKFtjLG5dKT0+e2NvbnN0IG89ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgib3B0aW9uIik7by52YWx1ZT1jO28udGV4dENvbnRlbnQ9bjtyZWdpb25TZWwuYXBwZW5kQ2hpbGQobyk7fSk7CmNvbnN0IFRZUEVTPVtbIiIsIk1vdmllcyAmIHNlcmllcyJdLFsibW92aWUiLCJNb3ZpZXMgb25seSJdLFsic2VyaWVzIiwiU2VyaWVzIG9ubHkiXV07CmNvbnN0IEdFTlJFUz1bIkFueSIsIkFjdGlvbiIsIkFkdmVudHVyZSIsIkFuaW1hdGlvbiIsIkNvbWVkeSIsIkNyaW1lIiwiRG9jdW1lbnRhcnkiLCJEcmFtYSIsIkZhbnRhc3kiLCJIb3Jyb3IiLCJNeXN0ZXJ5IiwiUm9tYW5jZSIsIlNjaS1GaSIsIlRocmlsbGVyIl07CmNvbnN0IHR5cGVTZWw9JCgiI3R5cGUiKTsgVFlQRVMuZm9yRWFjaCgoW3Ysbl0pPT57Y29uc3Qgbz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJvcHRpb24iKTtvLnZhbHVlPXY7by50ZXh0Q29udGVudD1uO3R5cGVTZWwuYXBwZW5kQ2hpbGQobyk7fSk7CmNvbnN0IGdlbnJlU2VsPSQoIiNnZW5yZSIpOyBHRU5SRVMuZm9yRWFjaChnPT57Y29uc3Qgbz1kb2N1bWVudC5jcmVhdGVFbGVtZW50KCJvcHRpb24iKTtvLnZhbHVlPWc7by50ZXh0Q29udGVudD0oZz09PSJBbnkiPyJBbnkgZ2VucmUiOmcpO2dlbnJlU2VsLmFwcGVuZENoaWxkKG8pO30pOwoKZnVuY3Rpb24gc2NvcmVDb2xvcihwKXtpZihwPT1udWxsfHxpc05hTihwKSlyZXR1cm4idmFyKC0tbXV0MikiO2lmKHA+PTc1KXJldHVybiJ2YXIoLS1nb29kKSI7aWYocD49NTApcmV0dXJuInZhcigtLW1pZCkiO3JldHVybiJ2YXIoLS1iYWQpIjt9CgovLyAtLS0tIHdhdGNoIGhpc3RvcnkgKHNhdmVkIGluIHRoaXMgYnJvd3NlciB2aWEgbG9jYWxTdG9yYWdlKSAtLS0tCmNvbnN0IExTX0tFWT0id25fd2F0Y2hsb2ciOwpmdW5jdGlvbiBwZXJzaXN0V2F0Y2hlZCgpe3RyeXtsb2NhbFN0b3JhZ2Uuc2V0SXRlbShMU19LRVksSlNPTi5zdHJpbmdpZnkod2F0Y2hlZE1hcCkpO31jYXRjaChlKXt9fQpmdW5jdGlvbiBsb2FkV2F0Y2hlZCgpewogIHRyeXtjb25zdCByYXc9bG9jYWxTdG9yYWdlLmdldEl0ZW0oTFNfS0VZKTt3YXRjaGVkTWFwPXJhdz8oSlNPTi5wYXJzZShyYXcpfHx7fSk6e307fWNhdGNoKGUpe3dhdGNoZWRNYXA9e307fQogIHJlbmRlcklucHV0TG9nKCk7Cn0KZnVuY3Rpb24gbWFya1dhdGNoZWQocmVjLGxpa2VkLHJlbW92ZVRpbGUpewogIHdhdGNoZWRNYXBbbnJtKHJlYy50aXRsZSldPXt0aXRsZTpyZWMudGl0bGUseWVhcjpyZWMueWVhcix0eXBlOnJlYy50eXBlLGxpa2VkLHRzOkRhdGUubm93KCl9OwogIHBlcnNpc3RXYXRjaGVkKCk7CiAgaWYocmVtb3ZlVGlsZSYmZGF0YSYmZGF0YS5yZXN1bHRzKWRhdGEucmVzdWx0cz1kYXRhLnJlc3VsdHMuZmlsdGVyKHg9Pm5ybSh4LnRpdGxlKSE9PW5ybShyZWMudGl0bGUpKTsKICBpZihkYXRhKXJlbmRlcigpOyByZW5kZXJJbnB1dExvZygpOwp9CmZ1bmN0aW9uIHJlbW92ZVdhdGNoZWQoaWQpewogIGRlbGV0ZSB3YXRjaGVkTWFwW2lkXTsgcGVyc2lzdFdhdGNoZWQoKTsgaWYoZGF0YSlyZW5kZXIoKTsgcmVuZGVySW5wdXRMb2coKTsKfQpjb25zdCBMU19MSVNUUz0id25fd2F0Y2hsaXN0cyI7CmZ1bmN0aW9uIHBlcnNpc3RXYXRjaGxpc3RzKCl7dHJ5e2xvY2FsU3RvcmFnZS5zZXRJdGVtKExTX0xJU1RTLEpTT04uc3RyaW5naWZ5KHdhdGNobGlzdHMpKTt9Y2F0Y2goZSl7fX0KZnVuY3Rpb24gbG9hZFdhdGNobGlzdHMoKXsKICB0cnl7CiAgICBjb25zdCByYXc9bG9jYWxTdG9yYWdlLmdldEl0ZW0oTFNfTElTVFMpOwogICAgaWYocmF3KXt3YXRjaGxpc3RzPUpTT04ucGFyc2UocmF3KXx8e307cmV0dXJuO30KICAgIGNvbnN0IG9sZD1sb2NhbFN0b3JhZ2UuZ2V0SXRlbSgid25fd2F0Y2hsaXN0Iik7CiAgICBpZihvbGQpe2NvbnN0IGl0ZW1zPUpTT04ucGFyc2Uob2xkKXx8e307Y29uc3QgaWQ9ImwiK0RhdGUubm93KCk7d2F0Y2hsaXN0cz17W2lkXTp7aWQ6aWQsbmFtZToiTXkgV2F0Y2hsaXN0IixpdGVtczppdGVtcyx0czpEYXRlLm5vdygpfX07cGVyc2lzdFdhdGNobGlzdHMoKTtyZXR1cm47fQogICAgd2F0Y2hsaXN0cz17fTsKICB9Y2F0Y2goZSl7d2F0Y2hsaXN0cz17fTt9Cn0KZnVuY3Rpb24gbGlzdENvdW50KCl7cmV0dXJuIE9iamVjdC5rZXlzKHdhdGNobGlzdHMpLmxlbmd0aDt9CmZ1bmN0aW9uIG5ld0xpc3QobmFtZSl7Y29uc3Qgbm09KG5hbWV8fCIiKS50cmltKCk7aWYoIW5tKXJldHVybiBudWxsO2NvbnN0IGlkPSJsIitEYXRlLm5vdygpK01hdGguZmxvb3IoTWF0aC5yYW5kb20oKSoxMDAwKTt3YXRjaGxpc3RzW2lkXT17aWQ6aWQsbmFtZTpubSxpdGVtczp7fSx0czpEYXRlLm5vdygpfTtwZXJzaXN0V2F0Y2hsaXN0cygpO3JldHVybiBpZDt9CmZ1bmN0aW9uIHJlbmFtZUxpc3QoaWQsbmFtZSl7Y29uc3Qgbm09KG5hbWV8fCIiKS50cmltKCk7aWYod2F0Y2hsaXN0c1tpZF0mJm5tKXt3YXRjaGxpc3RzW2lkXS5uYW1lPW5tO3BlcnNpc3RXYXRjaGxpc3RzKCk7fX0KZnVuY3Rpb24gZGVsZXRlTGlzdChpZCl7ZGVsZXRlIHdhdGNobGlzdHNbaWRdO3BlcnNpc3RXYXRjaGxpc3RzKCk7aWYoZGF0YSlyZW5kZXIoKTtyZW5kZXJJbnB1dExvZygpO30KZnVuY3Rpb24gdGl0bGVJbkxpc3QobGlzdElkLHRpdGxlSWQpe3JldHVybiAhISh3YXRjaGxpc3RzW2xpc3RJZF0mJndhdGNobGlzdHNbbGlzdElkXS5pdGVtcyYmd2F0Y2hsaXN0c1tsaXN0SWRdLml0ZW1zW3RpdGxlSWRdKTt9CmZ1bmN0aW9uIGxpc3RzRm9yVGl0bGUodGl0bGVJZCl7cmV0dXJuIE9iamVjdC52YWx1ZXMod2F0Y2hsaXN0cykuZmlsdGVyKGw9PmwuaXRlbXMmJmwuaXRlbXNbdGl0bGVJZF0pLm1hcChsPT5sLmlkKTt9CmZ1bmN0aW9uIHRvZ2dsZVRpdGxlSW5MaXN0KGxpc3RJZCxyZWMpe2NvbnN0IGlkPW5ybShyZWMudGl0bGUpO2NvbnN0IEw9d2F0Y2hsaXN0c1tsaXN0SWRdO2lmKCFMKXJldHVybjtpZighTC5pdGVtcylMLml0ZW1zPXt9O2lmKEwuaXRlbXNbaWRdKWRlbGV0ZSBMLml0ZW1zW2lkXTtlbHNlIEwuaXRlbXNbaWRdPXt0aXRsZTpyZWMudGl0bGUseWVhcjpyZWMueWVhcix0eXBlOnJlYy50eXBlLHRzOkRhdGUubm93KCl9O3BlcnNpc3RXYXRjaGxpc3RzKCk7aWYoZGF0YSlyZW5kZXIoKTtyZW5kZXJJbnB1dExvZygpO30KZnVuY3Rpb24gcmVtb3ZlSXRlbUZyb21MaXN0KGxpc3RJZCx0aXRsZUlkKXtjb25zdCBMPXdhdGNobGlzdHNbbGlzdElkXTtpZihMJiZMLml0ZW1zKWRlbGV0ZSBMLml0ZW1zW3RpdGxlSWRdO3BlcnNpc3RXYXRjaGxpc3RzKCk7aWYoZGF0YSlyZW5kZXIoKTtyZW5kZXJJbnB1dExvZygpO30KZnVuY3Rpb24gY3JlYXRlTGlzdFByb21wdCgpe2NvbnN0IG5tPXdpbmRvdy5wcm9tcHQoIk5hbWUgeW91ciBuZXcgbGlzdCAoZS5nLiBDb21lZHksIERhdGUgbmlnaHQpOiIpO2lmKG5tJiZubS50cmltKCkpe25ld0xpc3Qobm0pO2lmKGRhdGEpcmVuZGVyKCk7cmVuZGVySW5wdXRMb2coKTt9fQpmdW5jdGlvbiBuZXdMaXN0Rm9yQ2FyZChyZWMpe2NvbnN0IG5tPXdpbmRvdy5wcm9tcHQoIk5hbWUgeW91ciBuZXcgbGlzdCAoZS5nLiBDb21lZHksIERhdGUgbmlnaHQpOiIpO2lmKG5tJiZubS50cmltKCkpe2NvbnN0IGlkPW5ld0xpc3Qobm0pO2lmKGlkJiZyZWMpdG9nZ2xlVGl0bGVJbkxpc3QoaWQscmVjKTt9fQpmdW5jdGlvbiByZW5hbWVMaXN0UHJvbXB0KGlkKXtjb25zdCBjdXI9d2F0Y2hsaXN0c1tpZF0/d2F0Y2hsaXN0c1tpZF0ubmFtZToiIjtjb25zdCBubT13aW5kb3cucHJvbXB0KCJSZW5hbWUgdGhpcyBsaXN0OiIsY3VyKTtpZihubSYmbm0udHJpbSgpKXtyZW5hbWVMaXN0KGlkLG5tKTtpZihkYXRhKXJlbmRlcigpO3JlbmRlcklucHV0TG9nKCk7fX0KZnVuY3Rpb24gZGVsZXRlTGlzdENvbmZpcm0oaWQpe2NvbnN0IEw9d2F0Y2hsaXN0c1tpZF07aWYoIUwpcmV0dXJuO2lmKHdpbmRvdy5jb25maXJtKCdEZWxldGUgdGhlIGxpc3QgIicrTC5uYW1lKyciPyBUaGUgdGl0bGVzIGluIGl0IHdpbGwgYmUgcmVtb3ZlZCBmcm9tIHRoaXMgbGlzdC4nKSlkZWxldGVMaXN0KGlkKTt9CmZ1bmN0aW9uIGxpc3RCdXR0b25IVE1MKCl7Y29uc3QgYz1saXN0Q291bnQoKTtyZXR1cm4gJzxidXR0b24gY2xhc3M9Imdob3N0IiBpZD0ibGlzdGJ0biI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6JysoYz8ndmFyKC0tZ29sZCknOid2YXIoLS1tdXQyKScpKyciPjwvc3Bhbj5NeSBsaXN0cyAnKyhjPycoJytjKycpJzonJykrJyAnKyhzaG93TGlzdD8n4pa0Jzon4pa+JykrJzwvYnV0dG9uPic7fQpmdW5jdGlvbiB3YXRjaGxpc3RzUGFuZWxIVE1MKCl7CiAgY29uc3QgbGlzdHM9T2JqZWN0LnZhbHVlcyh3YXRjaGxpc3RzKS5zb3J0KChhLGIpPT4oYS50c3x8MCktKGIudHN8fDApKTsKICBsZXQgaD0nJzsKICBpZighbGlzdHMubGVuZ3RoKWgrPSc8ZGl2IHN0eWxlPSJmb250LXNpemU6MTNweDtjb2xvcjp2YXIoLS1tdXQyKTtwYWRkaW5nOjhweCAycHgiPllvdSBoYXZlIG5vIGxpc3RzIHlldC4gQ3JlYXRlIG9uZSwgdGhlbiB1c2UgIkFkZCB0byBsaXN0IiBvbiBhbnkgc3VnZ2VzdGlvbi48L2Rpdj4nOwogIGxpc3RzLmZvckVhY2goTD0+ewogICAgY29uc3QgaXRlbXM9T2JqZWN0LmVudHJpZXMoTC5pdGVtc3x8e30pLnNvcnQoKGEsYik9PihiWzFdLnRzfHwwKS0oYVsxXS50c3x8MCkpOwogICAgaCs9JzxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206MTZweCI+JzsKICAgIGgrPSc8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo4cHg7bWFyZ2luLWJvdHRvbTo4cHgiPjxzcGFuIHN0eWxlPSJmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7Y29sb3I6dmFyKC0tdGV4dCkiPicrZXNjKEwubmFtZSkrJzwvc3Bhbj48c3BhbiBzdHlsZT0iZm9udC1zaXplOjExLjVweDtjb2xvcjp2YXIoLS1tdXQyKSI+JytpdGVtcy5sZW5ndGgrJyB0aXRsZScrKGl0ZW1zLmxlbmd0aD09PTE/Jyc6J3MnKSsnPC9zcGFuPjxidXR0b24gY2xhc3M9InRpbnlidG4iIGRhdGEtYWN0PSJsaXN0LXJlbmFtZSIgZGF0YS1saXN0PSInK2VzYyhMLmlkKSsnIiBzdHlsZT0ibWFyZ2luLWxlZnQ6YXV0byI+cmVuYW1lPC9idXR0b24+PGJ1dHRvbiBjbGFzcz0idGlueWJ0biIgZGF0YS1hY3Q9Imxpc3QtZGVsZXRlIiBkYXRhLWxpc3Q9IicrZXNjKEwuaWQpKyciPmRlbGV0ZTwvYnV0dG9uPjwvZGl2Pic7CiAgICBpZighaXRlbXMubGVuZ3RoKWgrPSc8ZGl2IHN0eWxlPSJmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS1tdXQyKTtwYWRkaW5nOjJweCAycHggNHB4Ij5ObyB0aXRsZXMgeWV0LjwvZGl2Pic7CiAgICBlbHNlIGgrPWl0ZW1zLm1hcCgoW2lkLHhdKT0+JzxkaXYgY2xhc3M9ImxvZ2l0ZW0iPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOnZhcigtLWdvbGQpIj48L3NwYW4+PHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMy41cHgiPicrZXNjKHgudGl0bGUpKyc8L3NwYW4+PHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMS41cHg7Y29sb3I6dmFyKC0tbXV0MikiPicrZXNjKHgudHlwZXx8JycpKyh4LnllYXI/JyDCtyAnK2VzYyh4LnllYXIpOicnKSsnPC9zcGFuPjxidXR0b24gY2xhc3M9ImNoaXAiIGRhdGEtYWN0PSJpdGVtLXJlbW92ZSIgZGF0YS1saXN0PSInK2VzYyhMLmlkKSsnIiBkYXRhLWlkPSInK2VzYyhpZCkrJyIgc3R5bGU9Im1hcmdpbi1sZWZ0OmF1dG87YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTVweDtwYWRkaW5nOjAgNHB4O2N1cnNvcjpwb2ludGVyIj4mdGltZXM7PC9idXR0b24+PC9kaXY+Jykuam9pbigiIik7CiAgICBoKz0nPC9kaXY+JzsKICB9KTsKICBoKz0nPGJ1dHRvbiBjbGFzcz0id2wiIGRhdGEtYWN0PSJsaXN0LW5ldyIgc3R5bGU9Im1hcmdpbi10b3A6NHB4Ij4rIE5ldyBsaXN0PC9idXR0b24+JzsKICByZXR1cm4gaDsKfQoKZnVuY3Rpb24gbG9nTGlzdEhUTUwoKXsKICBjb25zdCBpdGVtcz1PYmplY3QuZW50cmllcyh3YXRjaGVkTWFwKS5zb3J0KChhLGIpPT4oYlsxXS50c3x8MCktKGFbMV0udHN8fDApKTsKICBpZighaXRlbXMubGVuZ3RoKXJldHVybiAnPGRpdiBzdHlsZT0iZm9udC1zaXplOjEzcHg7Y29sb3I6dmFyKC0tbXV0Mik7cGFkZGluZzo4cHggMnB4Ij5Ob3RoaW5nIGxvZ2dlZCB5ZXQuIFJhdGUgYSBzdWdnZXN0aW9uIGFuZCBpdFwnbGwgc2hhcGUgd2hhdCBjb21lcyBuZXh0LjwvZGl2Pic7CiAgcmV0dXJuIGl0ZW1zLm1hcCgoW2lkLHddKT0+JzxkaXYgY2xhc3M9ImxvZ2l0ZW0iPjxzcGFuIGNsYXNzPSJkb3QiIHN0eWxlPSJiYWNrZ3JvdW5kOicrKHcubGlrZWQ/J3ZhcigtLWdvb2QpJzp3Lmxpa2VkPT09ZmFsc2U/J3ZhcigtLWJhZCknOid2YXIoLS1tdXQyKScpKyciPjwvc3Bhbj4nCiAgICArJzxzcGFuIHN0eWxlPSJmb250LXNpemU6MTMuNXB4Ij4nK2VzYyh3LnRpdGxlKSsnPC9zcGFuPicKICAgICsnPHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMS41cHg7Y29sb3I6dmFyKC0tbXV0MikiPicrKHcubGlrZWQ/J0xvdmVkIGl0Jzp3Lmxpa2VkPT09ZmFsc2U/J05vdCBmb3IgbWUnOidTZWVuJykrJzwvc3Bhbj4nCiAgICArJzxidXR0b24gY2xhc3M9ImNoaXAiIGRhdGEtYWN0PSJ1bndhdGNoIiBkYXRhLWlkPSInK2VzYyhpZCkrJyIgc3R5bGU9Im1hcmdpbi1sZWZ0OmF1dG87YmFja2dyb3VuZDp0cmFuc3BhcmVudDtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS1tdXQyKTtmb250LXNpemU6MTVweDtwYWRkaW5nOjAgNHB4O2N1cnNvcjpwb2ludGVyIj4mdGltZXM7PC9idXR0b24+PC9kaXY+Jykuam9pbigiIik7Cn0KZnVuY3Rpb24gbG9nQnV0dG9uSFRNTCgpewogIGNvbnN0IGM9d2F0Y2hlZENvdW50KCk7CiAgcmV0dXJuICc8YnV0dG9uIGNsYXNzPSJnaG9zdCIgaWQ9ImxvZ2J0biI+PHNwYW4gY2xhc3M9ImRvdCIgc3R5bGU9ImJhY2tncm91bmQ6JysoYz8ndmFyKC0tZ29sZCknOid2YXIoLS1tdXQyKScpKyciPjwvc3Bhbj5XYXRjaGVkICcrKGM/JygnK2MrJyknOicnKSsnICcrKHNob3dMb2c/J+KWtCc6J+KWvicpKyc8L2J1dHRvbj4nOwp9CmZ1bmN0aW9uIHdpcmVMb2dDb250cm9scyhzY29wZSl7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJ1bndhdGNoIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+cmVtb3ZlV2F0Y2hlZChiLmRhdGFzZXQuaWQpKTsKICBzY29wZS5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Iml0ZW0tcmVtb3ZlIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+cmVtb3ZlSXRlbUZyb21MaXN0KGIuZGF0YXNldC5saXN0LGIuZGF0YXNldC5pZCkpOwogIHNjb3BlLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ibGlzdC1yZW5hbWUiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5yZW5hbWVMaXN0UHJvbXB0KGIuZGF0YXNldC5saXN0KSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJsaXN0LWRlbGV0ZSJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PmRlbGV0ZUxpc3RDb25maXJtKGIuZGF0YXNldC5saXN0KSk7CiAgc2NvcGUucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJsaXN0LW5ldyJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9PmNyZWF0ZUxpc3RQcm9tcHQoKSk7CiAgY29uc3QgbGI9c2NvcGUucXVlcnlTZWxlY3RvcigiI2xvZ2J0biIpOyBpZihsYilsYi5vbmNsaWNrPSgpPT57c2hvd0xvZz0hc2hvd0xvZzsgaWYoZGF0YSlyZW5kZXIoKTsgcmVuZGVySW5wdXRMb2coKTt9OwogIGNvbnN0IHdiPXNjb3BlLnF1ZXJ5U2VsZWN0b3IoIiNsaXN0YnRuIik7IGlmKHdiKXdiLm9uY2xpY2s9KCk9PntzaG93TGlzdD0hc2hvd0xpc3Q7IGlmKGRhdGEpcmVuZGVyKCk7IHJlbmRlcklucHV0TG9nKCk7fTsKfQpmdW5jdGlvbiByZW5kZXJJbnB1dExvZygpewogIGNvbnN0IGJveD0kKCIjaW5wdXRsb2ciKTsKICBpZih3YXRjaGVkQ291bnQoKT09PTAmJmxpc3RDb3VudCgpPT09MCl7Ym94LmlubmVySFRNTD0iIjtyZXR1cm47fQogIGxldCBoPSc8ZGl2IGNsYXNzPSJociIgc3R5bGU9Im1hcmdpbjoyMHB4IDAgMTZweCI+PC9kaXY+PGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2dhcDoxMHB4O2ZsZXgtd3JhcDp3cmFwIj4nK2xpc3RCdXR0b25IVE1MKCkrbG9nQnV0dG9uSFRNTCgpKyc8L2Rpdj4nOwogIGlmKHNob3dMaXN0KWgrPSc8ZGl2IHN0eWxlPSJtYXJnaW4tdG9wOjE0cHgiPicrd2F0Y2hsaXN0c1BhbmVsSFRNTCgpKyc8L2Rpdj4nOwogIGlmKHNob3dMb2cpaCs9JzxkaXYgc3R5bGU9Im1hcmdpbi10b3A6MTRweCI+Jytsb2dMaXN0SFRNTCgpKyc8L2Rpdj4nOwogIGJveC5pbm5lckhUTUw9aDsKICB3aXJlTG9nQ29udHJvbHMoYm94KTsKfQoKLy8gLS0tLSBpbnB1dCAtLS0tCmZ1bmN0aW9uIHJlbmRlckNoaXBzKCl7CiAgY29uc3QgYm94PSQoIiNjaGlwcyIpOwogIGJveC5xdWVyeVNlbGVjdG9yQWxsKCIuY2hpcCIpLmZvckVhY2goZT0+ZS5yZW1vdmUoKSk7CiAgY29uc3QgZHJhZnQ9JCgiI2RyYWZ0Iik7CiAgc2hvd3MuZm9yRWFjaCgocyxpKT0+ewogICAgY29uc3QgZWw9ZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgic3BhbiIpO2VsLmNsYXNzTmFtZT0iY2hpcCI7CiAgICBlbC5pbm5lckhUTUw9ZXNjKHMpKycgPGJ1dHRvbiBhcmlhLWxhYmVsPSJSZW1vdmUiPiZ0aW1lczs8L2J1dHRvbj4nOwogICAgZWwucXVlcnlTZWxlY3RvcigiYnV0dG9uIikub25jbGljaz0oKT0+e3Nob3dzLnNwbGljZShpLDEpO3JlbmRlckNoaXBzKCk7fTsKICAgIGJveC5pbnNlcnRCZWZvcmUoZWwsZHJhZnQpOwogIH0pOwogIGRyYWZ0LnN0eWxlLmRpc3BsYXk9c2hvd3MubGVuZ3RoPj0xMD8ibm9uZSI6ImJsb2NrIjsKICBkcmFmdC5wbGFjZWhvbGRlcj1zaG93cy5sZW5ndGg/IkFkZCBhbm90aGVy4oCmIjoiVHlwZSBhIHRpdGxlLCBwcmVzcyBFbnRlciI7CiAgJCgiI2NvdW50IikudGV4dENvbnRlbnQ9c2hvd3MubGVuZ3RoKyIgLyAxMCI7CiAgJCgiI2NvdW50Iikuc3R5bGUuY29sb3I9c2hvd3MubGVuZ3RoPj0zPyJ2YXIoLS1nb2xkKSI6InZhcigtLW11dDIpIjsKICBjb25zdCBvaz1zaG93cy5sZW5ndGg+PTM7CiAgJCgiI2dvIikuZGlzYWJsZWQ9IW9rOwogICQoIiNoaW50Iikuc3R5bGUuZGlzcGxheT1vaz8ibm9uZSI6ImJsb2NrIjsKICAkKCIjZXhhbXBsZSIpLnN0eWxlLmRpc3BsYXk9c2hvd3MubGVuZ3RoPyJub25lIjoiYmxvY2siOwp9CmZ1bmN0aW9uIGFkZERyYWZ0KCl7Y29uc3QgZD0kKCIjZHJhZnQiKTtsZXQgdj1kLnZhbHVlLnRyaW0oKS5yZXBsYWNlKC8sJC8sIiIpLnRyaW0oKTsKICBpZighdilyZXR1cm47aWYoc2hvd3Muc29tZShzPT5zLnRvTG93ZXJDYXNlKCk9PT12LnRvTG93ZXJDYXNlKCkpKXtkLnZhbHVlPSIiO3JldHVybjt9CiAgaWYoc2hvd3MubGVuZ3RoPDEwKXNob3dzLnB1c2godik7ZC52YWx1ZT0iIjtyZW5kZXJDaGlwcygpO30KJCgiI2RyYWZ0IikuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsZT0+ewogIGlmKGUua2V5PT09IkVudGVyInx8ZS5rZXk9PT0iLCIpe2UucHJldmVudERlZmF1bHQoKTthZGREcmFmdCgpO30KICBlbHNlIGlmKGUua2V5PT09IkJhY2tzcGFjZSImJiEkKCIjZHJhZnQiKS52YWx1ZSYmc2hvd3MubGVuZ3RoKXtzaG93cy5wb3AoKTtyZW5kZXJDaGlwcygpO30KfSk7CiQoIiNleGFtcGxlIikub25jbGljaz0oKT0+e3Nob3dzPVsuLi5FWEFNUExFXTtyZW5kZXJDaGlwcygpO307CiQoIiNnbyIpLm9uY2xpY2s9ZGlzY292ZXI7CgoKYXN5bmMgZnVuY3Rpb24gcmVhZEpzb24ocixmYWxsYmFja01zZyl7CiAgdmFyIGN0PXIuaGVhZGVycy5nZXQoImNvbnRlbnQtdHlwZSIpfHwiIjsKICBpZihjdC5pbmRleE9mKCJhcHBsaWNhdGlvbi9qc29uIik9PT0tMSl7CiAgICB2YXIgdD0oYXdhaXQgci50ZXh0KCkpLnRyaW0oKTsKICAgIGlmKHQuY2hhckF0KDApPT09IjwiKSB0aHJvdyBuZXcgRXJyb3IoIlRoZSBzZXJ2ZXIgaXMgd2FraW5nIHVwIFx1MjAxNCB0aGUgZnJlZSBob3N0aW5nIHBsYW4gc2xlZXBzIGFmdGVyIDE1IG1pbnV0ZXMgb2Ygbm8gdXNlLiBQbGVhc2Ugd2FpdCB1cCB0byBhIG1pbnV0ZSwgdGhlbiBwcmVzcyB0aGUgYnV0dG9uIGFnYWluLiIpOwogICAgdGhyb3cgbmV3IEVycm9yKHQuc2xpY2UoMCwyMDApfHxmYWxsYmFja01zZ3x8KCJSZXF1ZXN0IGZhaWxlZCAoIityLnN0YXR1cysiKSIpKTsKICB9CiAgdmFyIGo9YXdhaXQgci5qc29uKCk7CiAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcihqLmVycm9yfHxmYWxsYmFja01zZ3x8IlJlcXVlc3QgZmFpbGVkIik7CiAgcmV0dXJuIGo7Cn0KCmFzeW5jIGZ1bmN0aW9uIGRpc2NvdmVyKCl7CiAgY29uc3QgcmVzdWx0cz0kKCIjcmVzdWx0cyIpLCBpbnB1dD0kKCIjaW5wdXQiKTsKICBpbnB1dC5zdHlsZS5kaXNwbGF5PSJub25lIjtyZXN1bHRzLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjtzaG93TG9nPWZhbHNlO2V4aGF1c3RlZD1mYWxzZTtsb2FkaW5nTW9yZT1mYWxzZTsKICByZXN1bHRzLmlubmVySFRNTD0nPGRpdiBjbGFzcz0ibG9hZCIgc3R5bGU9ImNvbG9yOnZhcigtLW11dCk7dGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzo0MHB4IDAiPlJlYWRpbmcgeW91ciB0YXN0ZSwgcHVsbGluZyByZWFsIHJhdGluZ3MgJmFtcDsgYXZhaWxhYmlsaXR54oCmPC9kaXY+JzsKICBmaWx0ZXJzPXt0eXBlOiJhbGwiLG1pbjowLG5ldDpmYWxzZSxzb3J0OiJtYXRjaCJ9OwogIHRyeXsKICAgIGNvbnN0IHI9YXdhaXQgZmV0Y2goIi9hcGkvZGlzY292ZXIiLHttZXRob2Q6IlBPU1QiLGhlYWRlcnM6eyJDb250ZW50LVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sCiAgICAgIGJvZHk6SlNPTi5zdHJpbmdpZnkoe2xvdmVkOnNob3dzLGNvdW50cnk6cmVnaW9uU2VsLnZhbHVlLHR5cGU6dHlwZVNlbC52YWx1ZSxnZW5yZTpnZW5yZVNlbC52YWx1ZSx3YXRjaGVkOndhdGNoZWRNYXB9KX0pOwogICAgY29uc3Qgaj1hd2FpdCByZWFkSnNvbihyLCJSZXF1ZXN0IGZhaWxlZCIpOwogICAgZGF0YT1qO3JlbmRlcigpOwogIH1jYXRjaChlKXsKICAgIHJlc3VsdHMuaW5uZXJIVE1MPSc8ZGl2IGNsYXNzPSJyYyIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyIj48ZGl2IHN0eWxlPSJtYXJnaW4tYm90dG9tOjE0cHgiPicrZXNjKGUubWVzc2FnZSkrJzwvZGl2PjxidXR0b24gY2xhc3M9ImN0YSIgb25jbGljaz0iZGlzY292ZXIoKSI+VHJ5IGFnYWluPC9idXR0b24+PC9kaXY+JzsKICB9Cn0KCmZ1bmN0aW9uIG9ic2VydmVTZW50aW5lbCgpewogIGlmKGlvKWlvLmRpc2Nvbm5lY3QoKTsKICBjb25zdCBlbD0kKCIjc2VudGluZWwiKTsgaWYoIWVsKXJldHVybjsKICBpbz1uZXcgSW50ZXJzZWN0aW9uT2JzZXJ2ZXIoZXM9PnsgaWYoZXNbMF0uaXNJbnRlcnNlY3RpbmcpIGxvYWRNb3JlKCk7IH0se3Jvb3RNYXJnaW46IjUwMHB4In0pOwogIGlvLm9ic2VydmUoZWwpOwp9CmFzeW5jIGZ1bmN0aW9uIGxvYWRNb3JlKCl7CiAgaWYobG9hZGluZ01vcmV8fGV4aGF1c3RlZHx8IWRhdGEpcmV0dXJuOwogIGxvYWRpbmdNb3JlPXRydWU7IHJlbmRlcigpOwogIHRyeXsKICAgIGNvbnN0IGV4Y2x1ZGU9ZGF0YS5yZXN1bHRzLm1hcCh4PT54LnRpdGxlKTsKICAgIGNvbnN0IHI9YXdhaXQgZmV0Y2goIi9hcGkvZGlzY292ZXIiLHttZXRob2Q6IlBPU1QiLGhlYWRlcnM6eyJDb250ZW50LVR5cGUiOiJhcHBsaWNhdGlvbi9qc29uIn0sCiAgICAgIGJvZHk6SlNPTi5zdHJpbmdpZnkoe2xvdmVkOnNob3dzLGNvdW50cnk6cmVnaW9uU2VsLnZhbHVlLGV4Y2x1ZGUsdHlwZTp0eXBlU2VsLnZhbHVlLGdlbnJlOmdlbnJlU2VsLnZhbHVlLHdhdGNoZWQ6d2F0Y2hlZE1hcH0pfSk7CiAgICBjb25zdCBqPWF3YWl0IHJlYWRKc29uKHIsIkNvdWxkbid0IGxvYWQgbW9yZSIpOwogICAgY29uc3QgaGF2ZT1uZXcgU2V0KGRhdGEucmVzdWx0cy5tYXAoeD0+bnJtKHgudGl0bGUpKSk7CiAgICBjb25zdCBhZGQ9KGoucmVzdWx0c3x8W10pLmZpbHRlcih4PT4haGF2ZS5oYXMobnJtKHgudGl0bGUpKSk7CiAgICBpZihhZGQubGVuZ3RoPT09MCl7ZXhoYXVzdGVkPXRydWU7fSBlbHNlIHtkYXRhLnJlc3VsdHM9ZGF0YS5yZXN1bHRzLmNvbmNhdChhZGQpO30KICB9Y2F0Y2goZSl7IGV4aGF1c3RlZD10cnVlOyB9CiAgbG9hZGluZ01vcmU9ZmFsc2U7IHJlbmRlcigpOwp9CgpmdW5jdGlvbiBtZXRlcih2YWwscGN0LGRpc3AsbGFiKXsKICByZXR1cm4gJzxkaXYgY2xhc3M9InNjIj48ZGl2IGNsYXNzPSJsYWIiPicrbGFiKyc8L2Rpdj48ZGl2IGNsYXNzPSJ2YWwiIHN0eWxlPSJjb2xvcjonKyh2YWw9PW51bGw/InZhcigtLW11dDIpIjoidmFyKC0tdGV4dCkiKSsnIj4nK2Rpc3ArJzwvZGl2PjxkaXYgY2xhc3M9Im1ldGVyIj48aSBzdHlsZT0id2lkdGg6JysocGN0PT1udWxsPzA6TWF0aC5tYXgoMyxNYXRoLm1pbigxMDAscGN0KSkpKyclO2JhY2tncm91bmQ6JytzY29yZUNvbG9yKHBjdCkrJyI+PC9pPjwvZGl2PjwvZGl2Pic7Cn0KCmZ1bmN0aW9uIGNhcmQoeCl7CiAgY29uc3QgaWQ9bnJtKHgudGl0bGUpLCB3PXdhdGNoZWRNYXBbaWRdOwogIGNvbnN0IG90aGVycz0oeC5zZXJ2aWNlc3x8W10pLmZpbHRlcihzPT4hL25ldGZsaXgvaS50ZXN0KHMuaWR8fHMubmFtZSkpLnNsaWNlKDAsNCk7CiAgbGV0IHdhdGNoOwogIGlmKCF4Lm9uTmV0ZmxpeCAmJiBvdGhlcnMubGVuZ3RoPT09MCl7CiAgICB3YXRjaD0nPGRpdiBzdHlsZT0iZm9udC1zaXplOjEycHg7Y29sb3I6dmFyKC0tbXV0MikiPk5vIHN1YnNjcmlwdGlvbiBzdHJlYW0gZm91bmQgaW4gJyt4LmNvdW50cnkudG9VcHBlckNhc2UoKSsnLjwvZGl2Pic7CiAgfWVsc2V7CiAgICBjb25zdCBsYWJlbD14Lm9uTmV0ZmxpeD8iV2hlcmUgdG8gd2F0Y2giOiJOb3Qgb24gTmV0ZmxpeCDCtyB3YXRjaCBvbiI7CiAgICBsZXQgY2hpcHM9IiI7CiAgICBpZih4Lm9uTmV0ZmxpeCl7Y29uc3QgbD14Lm5ldGZsaXhMaW5rO2NoaXBzKz0obD8nPGEgY2xhc3M9InN2YyBuZXQiIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIiBocmVmPSInK2VzYyhsKSsnIj4nOic8c3BhbiBjbGFzcz0ic3ZjIG5ldCI+JykrJ05ldGZsaXggJyt4LmNvdW50cnkudG9VcHBlckNhc2UoKSsobD8nPC9hPic6Jzwvc3Bhbj4nKTt9CiAgICBvdGhlcnMuZm9yRWFjaChzPT57Y2hpcHMrPShzLmxpbms/JzxhIGNsYXNzPSJzdmMgcGxhaW4iIHRhcmdldD0iX2JsYW5rIiByZWw9Im5vb3BlbmVyIiBocmVmPSInK2VzYyhzLmxpbmspKyciPic6JzxzcGFuIGNsYXNzPSJzdmMgcGxhaW4iPicpK2VzYyhzLm5hbWUpKyhzLmxpbms/JzwvYT4nOic8L3NwYW4+Jyk7fSk7CiAgICB3YXRjaD0nPGRpdiBjbGFzcz0ibGFiMiI+JytsYWJlbCsnPC9kaXY+PGRpdiBjbGFzcz0icm93IiBzdHlsZT0iZ2FwOjZweCI+JytjaGlwcysnPC9kaXY+JzsKICB9CiAgY29uc3QgaW5MaXN0cz1saXN0c0ZvclRpdGxlKGlkKSwgb25Bbnk9aW5MaXN0cy5sZW5ndGg+MDsKICBjb25zdCBtZW51Um93cz1PYmplY3QudmFsdWVzKHdhdGNobGlzdHMpLnNvcnQoKGEsYik9PihhLnRzfHwwKS0oYi50c3x8MCkpLm1hcChMPT4nPGJ1dHRvbiBjbGFzcz0ibG1pJysodGl0bGVJbkxpc3QoTC5pZCxpZCk/JyBvbic6JycpKyciIGRhdGEtYWN0PSJ0b2xpc3QiIGRhdGEtbGlzdD0iJytlc2MoTC5pZCkrJyIgZGF0YS1pZD0iJytlc2MoaWQpKyciPicrKHRpdGxlSW5MaXN0KEwuaWQsaWQpPyfinJMgJzonKyAnKStlc2MoTC5uYW1lKSsnPC9idXR0b24+Jykuam9pbigiIik7CiAgY29uc3QgbGlzdEJ0bj0nPGRpdiBjbGFzcz0id2x3cmFwIj48YnV0dG9uIGNsYXNzPSJ3bCcrKG9uQW55Pycgb24nOicnKSsnIiBkYXRhLWFjdD0ibWVudSIgZGF0YS1pZD0iJytlc2MoaWQpKyciPicrKG9uQW55PyfinJMgT24geW91ciBsaXN0cyDilr4nOicrIEFkZCB0byBsaXN0IOKWvicpKyc8L2J1dHRvbj48ZGl2IGNsYXNzPSJsbWVudSI+JyttZW51Um93cysnPGJ1dHRvbiBjbGFzcz0ibG1pIG5ldyIgZGF0YS1hY3Q9Im5ld2xpc3QiIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj4rIE5ldyBsaXN04oCmPC9idXR0b24+PC9kaXY+PC9kaXY+JzsKICBsZXQgc2VlbjsKICBpZih3KXsKICAgIHNlZW49JzxkaXYgY2xhc3M9InNlZW5yb3ciIHN0eWxlPSJqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbiI+PHNwYW4gY2xhc3M9IndhdGNoZWR0YWciIHN0eWxlPSJjb2xvcjonKyh3Lmxpa2VkPyd2YXIoLS1nb29kKSc6J3ZhcigtLWJhZCknKSsnIj7inJMgV2F0Y2hlZCDCtyAnKyh3Lmxpa2VkPydMb3ZlZCBpdCc6J05vdCBmb3IgbWUnKSsnPC9zcGFuPicKICAgICAgKyc8YnV0dG9uIGNsYXNzPSJ1bmRvIiBkYXRhLWFjdD0idW53YXRjaCIgZGF0YS1pZD0iJytlc2MoaWQpKyciPnVuZG88L2J1dHRvbj48L2Rpdj4nOwogIH1lbHNlewogICAgc2Vlbj0nPGRpdiBjbGFzcz0ic2VlbnJvdyI+PHNwYW4gc3R5bGU9ImZvbnQtc2l6ZToxMnB4O2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi1yaWdodDphdXRvIj5TZWVuIGl0Pzwvc3Bhbj4nCiAgICAgICsnPGJ1dHRvbiBjbGFzcz0icmF0ZSB1cCIgZGF0YS1hY3Q9Imxpa2UiIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj7wn5GNIExvdmVkIGl0PC9idXR0b24+JwogICAgICArJzxidXR0b24gY2xhc3M9InJhdGUgZG93biIgZGF0YS1hY3Q9ImRpc2xpa2UiIGRhdGEtaWQ9IicrZXNjKGlkKSsnIj7wn5GOIE5vdCBmb3IgbWU8L2J1dHRvbj48L2Rpdj4nOwogIH0KICBjb25zdCBmb290PSc8ZGl2IGNsYXNzPSJmb290Ij4nK2xpc3RCdG4rc2VlbisnPC9kaXY+JzsKICByZXR1cm4gJzxkaXYgY2xhc3M9InJjJysodz8nIHNlZW4nOicnKSsnIj48ZGl2IGNsYXNzPSJoZWFkIj4nKyh4LnBvc3Rlcj8nPGltZyBjbGFzcz0icG9zdGVyIiBzcmM9IicrZXNjKHgucG9zdGVyKSsnIiBhbHQ9IiIgbG9hZGluZz0ibGF6eSIgb25lcnJvcj0idGhpcy5zdHlsZS5kaXNwbGF5PVwnbm9uZVwnIj4nOic8ZGl2IGNsYXNzPSJwb3N0ZXIgcGgiPm5vIGFydHdvcms8L2Rpdj4nKSsnPGRpdiBjbGFzcz0iaGVhZG1ldGEiPjxkaXYgY2xhc3M9ImtpY2tlciI+Jytlc2MoeC50eXBlKSsoeC55ZWFyPycgwrcgJytlc2MoeC55ZWFyKTonJykrJzwvZGl2PjxkaXYgY2xhc3M9InJ0LXRpdGxlIj4nK2VzYyh4LnRpdGxlKSsnPC9kaXY+PGRpdiBjbGFzcz0icmVhc29uIj4nK2VzYyh4LnJlYXNvbikrJzwvZGl2PjwvZGl2PjwvZGl2PicKICAgICsoeC5vdmVydmlldz8nPGRpdiBjbGFzcz0id3JpdGV1cCI+Jytlc2MoeC5vdmVydmlldykrJzwvZGl2Pic6JycpCiAgICArJzxkaXYgY2xhc3M9ImhyIj48L2Rpdj48ZGl2IGNsYXNzPSJzY29yZXMiPicKICAgICsgbWV0ZXIoeC5pbWRiLCB4LmltZGIhPW51bGw/eC5pbWRiKjEwOm51bGwsIHguaW1kYiE9bnVsbD9OdW1iZXIoeC5pbWRiKS50b0ZpeGVkKDEpOiLigJQiLCJJTURiIikKICAgICsgbWV0ZXIoeC5ydENyaXRpY3MsIHgucnRDcml0aWNzLCB4LnJ0Q3JpdGljcyE9bnVsbD9NYXRoLnJvdW5kKHgucnRDcml0aWNzKSsiJSI6IuKAlCIsIlJUIENyaXRpY3MiKQogICAgKyBtZXRlcih4LnRtZGIsIHgudG1kYiE9bnVsbD94LnRtZGIqMTA6bnVsbCwgeC50bWRiIT1udWxsP051bWJlcih4LnRtZGIpLnRvRml4ZWQoMSk6IuKAlCIsIlRNRGIiKQogICAgKyc8L2Rpdj48ZGl2IGNsYXNzPSJociI+PC9kaXY+Jyt3YXRjaCsnPGRpdiBjbGFzcz0iaHIiPjwvZGl2PicrZm9vdCsnPC9kaXY+JzsKfQoKZnVuY3Rpb24gc2VnKG5hbWUsb3B0cyxjdXIpewogIHJldHVybiAnPGRpdj48ZGl2IGNsYXNzPSJsYWIyIj4nK25hbWUubGFiZWwrJzwvZGl2PjxkaXYgY2xhc3M9InNlZyI+JytvcHRzLm1hcChvPT4KICAgICc8YnV0dG9uIGNsYXNzPSInKyhvLnY9PT1jdXI/Im9uIjoiIikrJyIgZGF0YS1rPSInK25hbWUua2V5KyciIGRhdGEtdj0iJytvLnYrJyI+JytvLnQrJzwvYnV0dG9uPicpLmpvaW4oIiIpKyc8L2Rpdj48L2Rpdj4nOwp9CgpmdW5jdGlvbiByZW5kZXIoKXsKICBjb25zdCByZXN1bHRzPSQoIiNyZXN1bHRzIik7CiAgbGV0IGxpc3Q9ZGF0YS5yZXN1bHRzLmZpbHRlcih4PT57CiAgICBpZihmaWx0ZXJzLnR5cGUhPT0iYWxsIiYmeC50eXBlLnRvTG93ZXJDYXNlKCkhPT1maWx0ZXJzLnR5cGUpcmV0dXJuIGZhbHNlOwogICAgaWYoZmlsdGVycy5uZXQmJngub25OZXRmbGl4IT09dHJ1ZSlyZXR1cm4gZmFsc2U7CiAgICBpZihmaWx0ZXJzLm1pbj4wJiYoeC5pbWRiPT1udWxsfHxOdW1iZXIoeC5pbWRiKTxmaWx0ZXJzLm1pbikpcmV0dXJuIGZhbHNlOwogICAgcmV0dXJuIHRydWU7CiAgfSk7CiAgaWYoZmlsdGVycy5zb3J0PT09ImltZGIiKWxpc3Q9Wy4uLmxpc3RdLnNvcnQoKGEsYik9PihiLmltZGJ8fC0xKS0oYS5pbWRifHwtMSkpOwogIGlmKGZpbHRlcnMuc29ydD09PSJydCIpbGlzdD1bLi4ubGlzdF0uc29ydCgoYSxiKT0+KGIucnRDcml0aWNzfHwtMSktKGEucnRDcml0aWNzfHwtMSkpOwoKICBjb25zdCBiYXI9JzxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjEycHg7bWFyZ2luLWJvdHRvbToxOHB4O2ZsZXgtd3JhcDp3cmFwIj4nCiAgICArJzxidXR0b24gY2xhc3M9Imdob3N0IiBpZD0iYmFjayI+4oaQIFN0YXJ0IG92ZXI8L2J1dHRvbj4nCiAgICArJzxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEycHg7ZmxleC13cmFwOndyYXAiPjxzcGFuIHN0eWxlPSJmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLW11dCkiPk1hdGNoZWQgdG8gJytzaG93cy5sZW5ndGgrJyBsb3ZlcyDCtyBOZXRmbGl4ICcrZXNjKGRhdGEuY291bnRyeU5hbWUpKyc8L3NwYW4+JytsaXN0QnV0dG9uSFRNTCgpK2xvZ0J1dHRvbkhUTUwoKSsnPC9kaXY+PC9kaXY+JzsKCiAgY29uc3QgcGFuZWw9c2hvd0xvZz8nPGRpdiBjbGFzcz0ibG9ncGFuZWwiPjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi1ib3R0b206MTJweCI+WW91ciB3YXRjaCBoaXN0b3J5IMK3IHNoYXBlcyBldmVyeSBzdWdnZXN0aW9uPC9kaXY+Jytsb2dMaXN0SFRNTCgpKyc8L2Rpdj4nOicnOwogIGNvbnN0IGxpc3RQYW5lbD1zaG93TGlzdD8nPGRpdiBjbGFzcz0ibG9ncGFuZWwiPjxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMXB4O2xldHRlci1zcGFjaW5nOi4xZW07dGV4dC10cmFuc2Zvcm06dXBwZXJjYXNlO2NvbG9yOnZhcigtLW11dDIpO21hcmdpbi1ib3R0b206MTJweCI+WW91ciBsaXN0czwvZGl2Picrd2F0Y2hsaXN0c1BhbmVsSFRNTCgpKyc8L2Rpdj4nOicnOwoKICBjb25zdCB0b29sYmFyPSc8ZGl2IGNsYXNzPSJ0b29sYmFyIj4nCiAgICArIHNlZyh7bGFiZWw6IlR5cGUiLGtleToidHlwZSJ9LFt7djoiYWxsIix0OiJBbGwifSx7djoibW92aWUiLHQ6Ik1vdmllcyJ9LHt2OiJzZXJpZXMiLHQ6IlNlcmllcyJ9XSxmaWx0ZXJzLnR5cGUpCiAgICArIHNlZyh7bGFiZWw6Ik1pbiBJTURiIixrZXk6Im1pbiJ9LFt7djowLHQ6IkFueSJ9LHt2OjcsdDoiNysifSx7djo4LHQ6IjgrIn1dLGZpbHRlcnMubWluKQogICAgKyBzZWcoe2xhYmVsOiJTb3J0IGJ5IixrZXk6InNvcnQifSxbe3Y6Im1hdGNoIix0OiJNYXRjaCJ9LHt2OiJpbWRiIix0OiJJTURiIn0se3Y6InJ0Iix0OiJSVCJ9XSxmaWx0ZXJzLnNvcnQpCiAgICArICc8bGFiZWwgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjhweDtmb250LXNpemU6MTNweDtjdXJzb3I6cG9pbnRlcjttYXJnaW4tbGVmdDphdXRvO3VzZXItc2VsZWN0Om5vbmUiPjxpbnB1dCB0eXBlPSJjaGVja2JveCIgaWQ9Im5ldG9ubHkiICcrKGZpbHRlcnMubmV0PyJjaGVja2VkIjoiIikrJyBzdHlsZT0iYWNjZW50LWNvbG9yOnZhcigtLWdvbGQpO3dpZHRoOjE2cHg7aGVpZ2h0OjE2cHgiPiBPbiBOZXRmbGl4IG9ubHk8L2xhYmVsPicKICAgICsgJzwvZGl2Pic7CgogIGNvbnN0IGJvZHk9bGlzdC5sZW5ndGgKICAgID8gJzxkaXYgY2xhc3M9ImdyaWQiPicrbGlzdC5tYXAoY2FyZCkuam9pbigiIikrJzwvZGl2PicKICAgIDogJzxkaXYgc3R5bGU9ImNvbG9yOnZhcigtLW11dCk7dGV4dC1hbGlnbjpjZW50ZXI7cGFkZGluZzo0MHB4IDAiPk5vdGhpbmcgbWF0Y2hlcyB0aGVzZSBmaWx0ZXJzLiBMb29zZW4gdGhlbSB0byBzZWUgbW9yZS48L2Rpdj4nOwoKICBjb25zdCBub3RlPSc8cCBjbGFzcz0ibm90ZSI+UmF0aW5ncyB2aWEgT01EYiAoSU1EYiDCtyBSb3R0ZW4gVG9tYXRvZXMgwrcgTWV0YWNyaXRpYykuICcKICAgICtlc2MoZGF0YS5hdHRyaWJ1dGlvbikrJy4gTW9yZSBsb2FkIGF1dG9tYXRpY2FsbHkgYXMgeW91IHNjcm9sbCwgZWFjaCBiYXRjaCBhdm9pZGluZyB3aGF0IHlvdVwndmUgYWxyZWFkeSBzZWVuLiBZb3VyIHdhdGNoIGhpc3RvcnkgaXMgc2F2ZWQgc2VydmVyLXNpZGUgYW5kIGZlZWRzIGV2ZXJ5IHN1Z2dlc3Rpb24uPC9wPic7CgogIGNvbnN0IGZvb3RlciA9IGV4aGF1c3RlZAogICAgPyAnPGRpdiBzdHlsZT0idGV4dC1hbGlnbjpjZW50ZXI7Y29sb3I6dmFyKC0tbXV0Mik7Zm9udC1zaXplOjEzcHg7cGFkZGluZzoyNHB4IDAgOHB4Ij5UaGF0XCdzIHRoZSBiZXN0IG9mIHdoYXQgZml0cyB5b3VyIHRhc3RlIHJpZ2h0IG5vdy4gUmF0ZSBhIGZldyBhbmQgc3RhcnQgb3ZlciBmb3IgYSBmcmVzaCByZWFkLjwvZGl2PicKICAgIDogKGxvYWRpbmdNb3JlCiAgICAgICAgPyAnPGRpdiBjbGFzcz0ibG9hZCIgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLW11dCk7Zm9udC1zaXplOjEzLjVweDtwYWRkaW5nOjI0cHggMCA4cHgiPkZpbmRpbmcgbW9yZSBmb3IgeW914oCmPC9kaXY+JwogICAgICAgIDogJzxkaXYgc3R5bGU9InRleHQtYWxpZ246Y2VudGVyO3BhZGRpbmc6MjBweCAwIDRweCI+PGJ1dHRvbiBjbGFzcz0iZ2hvc3QiIGlkPSJsb2FkbW9yZSI+TG9hZCBtb3JlPC9idXR0b24+PC9kaXY+Jyk7CiAgY29uc3Qgc2VudGluZWw9JzxkaXYgaWQ9InNlbnRpbmVsIiBzdHlsZT0iaGVpZ2h0OjFweCI+PC9kaXY+JzsKCiAgcmVzdWx0cy5pbm5lckhUTUw9YmFyK2xpc3RQYW5lbCtwYW5lbCt0b29sYmFyK2JvZHkrZm9vdGVyK3NlbnRpbmVsK25vdGU7CiAgJCgiI2JhY2siKS5vbmNsaWNrPSgpPT57cmVzdWx0cy5zdHlsZS5kaXNwbGF5PSJub25lIjskKCIjaW5wdXQiKS5zdHlsZS5kaXNwbGF5PSJibG9jayI7fTsKICAkKCIjbmV0b25seSIpLm9uY2hhbmdlPWU9PntmaWx0ZXJzLm5ldD1lLnRhcmdldC5jaGVja2VkO3JlbmRlcigpO307CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCIuc2VnIGJ1dHRvbiIpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57CiAgICBjb25zdCBrPWIuZGF0YXNldC5rO2xldCB2PWIuZGF0YXNldC52O2lmKGs9PT0ibWluIil2PU51bWJlcih2KTtmaWx0ZXJzW2tdPXY7cmVuZGVyKCk7CiAgfSk7CiAgLy8gd2F0Y2hlZCBjb250cm9scwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJsaWtlIl0nKS5mb3JFYWNoKGI9PmIub25jbGljaz0oKT0+e2NvbnN0IHI9ZGF0YS5yZXN1bHRzLmZpbmQoeD0+bnJtKHgudGl0bGUpPT09Yi5kYXRhc2V0LmlkKTtpZihyKW1hcmtXYXRjaGVkKHIsdHJ1ZSk7fSk7CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9ImRpc2xpa2UiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57Y29uc3Qgcj1kYXRhLnJlc3VsdHMuZmluZCh4PT5ucm0oeC50aXRsZSk9PT1iLmRhdGFzZXQuaWQpO2lmKHIpbWFya1dhdGNoZWQocixmYWxzZSx0cnVlKTt9KTsKICByZXN1bHRzLnF1ZXJ5U2VsZWN0b3JBbGwoJ1tkYXRhLWFjdD0ibWVudSJdJykuZm9yRWFjaChiPT5iLm9uY2xpY2s9KCk9Pntjb25zdCBtbT1iLnBhcmVudEVsZW1lbnQucXVlcnlTZWxlY3RvcignLmxtZW51Jyk7aWYobW0pbW0uY2xhc3NMaXN0LnRvZ2dsZSgnb3BlbicpO30pOwogIHJlc3VsdHMucXVlcnlTZWxlY3RvckFsbCgnW2RhdGEtYWN0PSJ0b2xpc3QiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57Y29uc3Qgcj1kYXRhLnJlc3VsdHMuZmluZCh4PT5ucm0oeC50aXRsZSk9PT1iLmRhdGFzZXQuaWQpO2lmKHIpdG9nZ2xlVGl0bGVJbkxpc3QoYi5kYXRhc2V0Lmxpc3Qscik7fSk7CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9Im5ld2xpc3QiXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT57Y29uc3Qgcj1kYXRhLnJlc3VsdHMuZmluZCh4PT5ucm0oeC50aXRsZSk9PT1iLmRhdGFzZXQuaWQpO2lmKHIpbmV3TGlzdEZvckNhcmQocik7fSk7CiAgcmVzdWx0cy5xdWVyeVNlbGVjdG9yQWxsKCdbZGF0YS1hY3Q9InVud2F0Y2giXScpLmZvckVhY2goYj0+Yi5vbmNsaWNrPSgpPT5yZW1vdmVXYXRjaGVkKGIuZGF0YXNldC5pZCkpOwogIHdpcmVMb2dDb250cm9scyhyZXN1bHRzKTsKICBjb25zdCBsbT0kKCIjbG9hZG1vcmUiKTsgaWYobG0pbG0ub25jbGljaz1sb2FkTW9yZTsKICBvYnNlcnZlU2VudGluZWwoKTsKfQoKcmVuZGVyQ2hpcHMoKTsKbG9hZFdhdGNoZWQoKTsKbG9hZFdhdGNobGlzdHMoKTsKCnZhciBfcz1kb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic3RhdHVzIik7aWYoX3Mpe19zLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjtfcy5zdHlsZS5iYWNrZ3JvdW5kPSIjMTIyODFjIjtfcy5zdHlsZS5ib3JkZXI9IjFweCBzb2xpZCAjMmY1YTNkIjtfcy5zdHlsZS5jb2xvcj0iI2JmZThjZiI7X3MudGV4dENvbnRlbnQ9IlJlYWR5IFx1MjAxNCB0eXBlIGEgdGl0bGUsIHByZXNzIEVudGVyLCBhZGQgYXQgbGVhc3QgMy4iO30KPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo=", "base64").toString("utf8");

app.get("/", (_req, res) => res.type("html").send(PAGE));

app.listen(PORT, () => console.log(`What Next server → http://localhost:${PORT}`));
