# What Next — server build

The Netflix taste-matcher with **real** data. You give it titles you loved; it
recommends what to watch, attaches genuine IMDb / Rotten Tomatoes / Metacritic
scores, and tells you exactly where each title streams in your region — with a
deep link straight into the service.

Keys stay server-side. The browser never sees them.

## What it uses

- **Recommendations** — Anthropic API (taste-matching over your loved titles).
- **Ratings** — [OMDb](http://www.omdbapi.com/) → IMDb, Rotten Tomatoes (Tomatometer), Metacritic.
- **Availability + deep links** — [Streaming Availability API](https://www.movieofthenight.com/about/api) by Movie of the Night → real per-country catalogue, including "where else to watch."

## Setup

1. **Install** (Node 18+):
   ```bash
   npm install
   ```

2. **Get three keys** (all have free tiers):
   - Anthropic — https://console.anthropic.com
   - OMDb (free, 1,000/day) — http://www.omdbapi.com/apikey.aspx
   - Streaming Availability (free, 100/day) — subscribe on RapidAPI:
     https://rapidapi.com/movieofthenight-movieofthenight-default/api/streaming-availability

3. **Configure**:
   ```bash
   cp .env.example .env
   # paste your keys into .env
   ```

4. **Run**:
   ```bash
   npm start
   ```
   Open http://localhost:8787 — the reference UI is served from `public/`.
   Check keys loaded correctly at http://localhost:8787/api/health.

## Deploy to Render (free) — get a shareable URL

No terminal, nothing running on your own machine. ~5 minutes.

1. **Put this folder in a GitHub repo.** On github.com: New repository → then either
   drag-and-drop these files into the web uploader, or from the folder run
   `git init && git add . && git commit -m "what next" && git branch -M main &&
   git remote add origin <your-repo-url> && git push -u origin main`.
   (The included `.gitignore` keeps `node_modules`, `.env`, and `data/` out.)

2. **Create the service on Render.** Sign in at [render.com](https://render.com)
   with GitHub (no credit card). New → **Blueprint**, pick your repo. Render reads
   the included `render.yaml` and sets up a free web service automatically. (Or:
   New → Web Service → your repo → Runtime *Node*, Build `npm install`, Start
   `npm start`, Instance type *Free*.)

3. **Add your three keys.** During setup Render will ask for the values marked
   `sync: false` in the blueprint — paste `ANTHROPIC_API_KEY`, `OMDB_API_KEY`, and
   `RAPIDAPI_KEY`. (Later: dashboard → your service → **Environment**.)

4. **Deploy.** Render builds and gives you `https://what-next-xxxx.onrender.com`.
   Open it. Check `…/api/health` shows `true` for all three keys.

**Free-tier behaviour:** the service sleeps after ~15 minutes of no traffic, so the
first request after a quiet spell takes 30–60 seconds to wake, then it's snappy.
Your watch history is stored in your browser, so it's unaffected by sleeps or
redeploys. To kill the cold start entirely, bump the service to Render's Starter
plan (~$7/mo) — nothing in the code needs to change.

To ship an update later, just push to the repo; Render redeploys on its own.

## API

`POST /api/discover`
```json
{ "loved": ["Dark", "The Bear", "Parasite"], "country": "za", "limit": 8 }
```
Returns `{ country, countryName, results: [...], attribution }`. Each result:
```json
{
  "title": "…", "year": "…", "type": "Movie|Series", "reason": "…",
  "poster": "https://…",
  "imdb": 8.4, "rtCritics": 92, "metascore": 78,
  "onNetflix": true, "netflixLink": "https://…",
  "services": [{ "name": "Netflix", "link": "https://…", "id": "netflix" }],
  "country": "za"
}
```

### Watch history (the learning loop)

The server is **stateless** — it stores nothing. Your watch history lives in your
browser (`localStorage`), so it survives redeploys and works fine on hosts with an
ephemeral disk (like Render's free tier). The UI sends the history with every
`POST /api/discover` as a `watched` object, and the server injects it into the
recommendation prompt two ways: as a hard "never recommend these again" exclusion,
and as liked / disliked signals that steer the next batch. Watched titles are also
filtered out of results as a safety net.

Request shape:
```json
{
  "loved": ["Dark", "The Bear"],
  "country": "za",
  "watched": {
    "beef": { "title": "Beef", "liked": true },
    "emily in paris": { "title": "Emily in Paris", "liked": false }
  }
}
```

Rating a card in the UI updates that object and re-saves it locally — no server
round-trip. If you later want history shared across devices, add a store keyed by
a user id and have the client sync to it; the request shape stays the same.

## Notes & gotchas

- **Rotten Tomatoes audience score** isn't in OMDb — only the critics' Tomatometer
  is, so the UI shows IMDb / RT Critics / Metacritic. (There's no free, legitimate
  RT audience feed; if you need it, it'd come from a paid source.)
- **Free-tier limits**: the Streaming Availability free plan is ~100 requests/day.
  Each discovery does up to `limit` availability lookups (one per recommendation),
  so ~12 discoveries/day on the free tier. Add a cache if you go further.
- **Title matching** is done by OMDb title lookup (`?t=`). It's good but not
  perfect for ambiguous titles; passing the year (the recommender supplies it)
  tightens it. For production, resolve to an IMDb id up front.
- **Attribution is required** by the Streaming Availability API terms — the UI
  prints it under the results. Keep it if you ship this.
- Swap the recommender for your own model or `NSP AI Engine` by editing
  `recommend()` in `server.js` — everything downstream stays the same.

## Point your own React app at it

The reference UI is plain HTML so it "just runs," but the backend is the reusable
part. From a React app, hit the same endpoint:
```ts
const res = await fetch("http://localhost:8787/api/discover", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ loved, country }),
});
const { results } = await res.json();
```
Enable CORS is already on. In production, put this behind your own domain and add
rate-limiting + a cache (Redis or even a JSON file) keyed by `title+country`.
