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

const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>What Next · Netflix taste-matcher</title>
<style>
  :root{
    --bg:#0E1116; --bg2:#12161C; --card:#171C24; --cardHi:#1C222B;
    --line:#272E39; --gold:#E8B44A; --text:#F2EDE3; --mut:#8B93A0; --mut2:#5C6470;
    --good:#4FB477; --mid:#E8B44A; --bad:#E0574B; --net:#4FB477;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;}
  .wrap{max-width:940px;margin:0 auto;padding:40px 22px 72px}
  .eyebrow{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);margin-bottom:10px}
  h1{font-family:ui-serif,Georgia,serif;font-size:46px;line-height:1.02;margin:0;font-weight:600;letter-spacing:-.01em}
  .sub{color:var(--mut);font-size:15px;margin-top:12px;max-width:520px;line-height:1.5}
  .panel{background:var(--bg2);border:1px solid var(--line);border-radius:18px;padding:24px}
  .row{display:flex;flex-wrap:wrap;gap:8px}
  .chip{display:inline-flex;align-items:center;gap:8px;background:var(--cardHi);border:1px solid var(--line);
    border-radius:999px;padding:7px 8px 7px 14px;font-size:13.5px}
  .chip button{cursor:pointer;border:none;background:transparent;color:var(--mut);font-size:15px;line-height:1;padding:0 2px}
  input.title{flex:1 0 160px;background:transparent;border:none;color:var(--text);font-size:14px;padding:8px 4px;min-width:140px;outline:none}
  input.title::placeholder{color:var(--mut2)}
  select{background:var(--cardHi);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:10px 14px;font-size:14px;cursor:pointer}
  .cta{background:var(--gold);color:#20180a;border:none;border-radius:10px;padding:13px 26px;font-size:14.5px;font-weight:700;cursor:pointer}
  .cta[disabled]{background:var(--cardHi);color:var(--mut2);cursor:not-allowed}
  .hr{height:1px;background:var(--line)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}
  .rc{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;display:flex;flex-direction:column;gap:12px}
  .rc.seen{border-color:rgba(232,180,74,.28)}
  .kicker{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--gold)}
  .rt-title{font-family:ui-serif,Georgia,serif;font-size:22px;line-height:1.15;font-weight:600}
  .reason{font-size:13.5px;line-height:1.5;color:var(--mut);margin-top:6px}
  .scores{display:flex;gap:16px}
  .sc{flex:1;min-width:0}
  .sc .lab{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut2);margin-bottom:4px}
  .sc .val{font-family:ui-monospace,Menlo,monospace;font-size:20px;font-weight:600;line-height:1}
  .meter{height:3px;border-radius:2px;background:var(--line);margin-top:8px;overflow:hidden}
  .meter>i{display:block;height:100%;border-radius:2px}
  .lab2{font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--mut2);margin-bottom:8px}
  .svc{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;border-radius:8px;padding:4px 9px;text-decoration:none}
  .svc.net{color:#bfe8cf;background:rgba(79,180,119,.14);border:1px solid rgba(79,180,119,.35)}
  .svc.plain{color:var(--mut);background:rgba(139,147,160,.08);border:1px solid var(--line)}
  .svc.plain:hover{color:var(--text)}
  .seenrow{display:flex;align-items:center;gap:8px}
  .rate{border-radius:8px;padding:6px 12px;font-size:12.5px;font-weight:600;cursor:pointer}
  .rate.up{background:rgba(79,180,119,.10);border:1px solid rgba(79,180,119,.3);color:#bfe8cf}
  .rate.down{background:rgba(224,87,75,.08);border:1px solid rgba(224,87,75,.28);color:#efb3ad}
  .watchedtag{font-size:12.5px;font-weight:600}
  .undo{background:transparent;border:none;color:var(--mut2);font-size:12px;cursor:pointer;text-decoration:underline;padding:2px}
  .toolbar{display:flex;flex-wrap:wrap;gap:18px;align-items:flex-end;padding:14px 16px;background:var(--bg2);border:1px solid var(--line);border-radius:12px;margin-bottom:20px}
  .seg{display:inline-flex;background:var(--bg2);border:1px solid var(--line);border-radius:9px;padding:3px;gap:2px}
  .seg button{border:none;cursor:pointer;border-radius:6px;padding:6px 12px;font-size:12.5px;background:transparent;color:var(--mut)}
  .seg button.on{background:var(--gold);color:#20180a;font-weight:700}
  .ghost{background:transparent;border:1px solid var(--line);color:var(--text);border-radius:999px;padding:8px 16px;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:7px}
  .dot{width:6px;height:6px;border-radius:999px;background:var(--mut2)}
  .logpanel{background:var(--bg2);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:20px}
  .logitem{display:flex;align-items:center;gap:10px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 12px}
  .note{color:var(--mut2);font-size:12px;line-height:1.6;margin-top:26px;max-width:640px}
  a.link{color:var(--gold);text-decoration:none;font-size:12.5px}
  button:focus-visible,input:focus-visible,select:focus-visible,.seg button:focus-visible{outline:2px solid var(--gold);outline-offset:2px}
  @keyframes p{0%,100%{opacity:.45}50%{opacity:.8}} .load{animation:p 1.4s ease-in-out infinite}
</style>
</head>
<body>
<div class="wrap">
  <div class="eyebrow">Netflix taste-matcher</div>
  <h1>What next.</h1>
  <p class="sub">Name a handful of things you watched and loved. Real IMDb &amp; Rotten Tomatoes scores, real regional availability, deep links to where it streams — and it learns from what you rate.</p>

  <div id="input" style="margin-top:30px" class="panel">
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:12px">
      <label style="font-size:13px;font-weight:600">Things you loved</label>
      <span id="count" style="font-family:ui-monospace,monospace;font-size:12px;color:var(--mut2)">0 / 10</span>
    </div>
    <div id="chips" class="row" style="margin-bottom:14px">
      <input class="title" id="draft" placeholder="Type a title, press Enter" />
    </div>
    <button id="example" style="background:none;border:none;color:var(--gold);font-size:12.5px;cursor:pointer;padding:0 0 8px">Need a spark? Load an example →</button>
    <div class="hr" style="margin:6px 0 18px"></div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-end;justify-content:space-between">
      <div>
        <label for="region" style="display:block;font-size:12px;color:var(--mut);margin-bottom:7px">Watching from</label>
        <select id="region"></select>
      </div>
      <button id="go" class="cta" disabled>Find my next watch</button>
    </div>
    <div id="hint" style="font-size:12px;color:var(--mut2);margin-top:12px">Add at least 3 titles for a good read on your taste.</div>
    <div id="inputlog"></div>
  </div>

  <div id="results" style="display:none;margin-top:30px"></div>
</div>

<script>
const REGIONS=[["za","South Africa"],["us","United States"],["gb","United Kingdom"],["ca","Canada"],["au","Australia"],["in","India"],["ng","Nigeria"],["ke","Kenya"],["de","Germany"],["fr","France"],["es","Spain"],["br","Brazil"],["mx","Mexico"],["jp","Japan"],["kr","South Korea"]];
const EXAMPLE=["Dark","The Bear","Breaking Bad","Parasite","Fleabag"];
let shows=[], data=null, watchedMap={}, showLog=false;
let loadingMore=false, exhausted=false, io=null;
let filters={type:"all",min:0,net:false,sort:"match"};

const $=s=>document.querySelector(s);
const nrm=s=>String(s||"").trim().toLowerCase();
const esc=s=>String(s).replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const watchedCount=()=>Object.keys(watchedMap).length;

const regionSel=$("#region");
REGIONS.forEach(([c,n])=>{const o=document.createElement("option");o.value=c;o.textContent=n;regionSel.appendChild(o);});

function scoreColor(p){if(p==null||isNaN(p))return"var(--mut2)";if(p>=75)return"var(--good)";if(p>=50)return"var(--mid)";return"var(--bad)";}

// ---- watch history (saved in this browser via localStorage) ----
const LS_KEY="wn_watchlog";
function persistWatched(){try{localStorage.setItem(LS_KEY,JSON.stringify(watchedMap));}catch(e){}}
function loadWatched(){
  try{const raw=localStorage.getItem(LS_KEY);watchedMap=raw?(JSON.parse(raw)||{}):{};}catch(e){watchedMap={};}
  renderInputLog();
}
function markWatched(rec,liked){
  watchedMap[nrm(rec.title)]={title:rec.title,year:rec.year,type:rec.type,liked,ts:Date.now()};
  persistWatched(); if(data)render(); renderInputLog();
}
function removeWatched(id){
  delete watchedMap[id]; persistWatched(); if(data)render(); renderInputLog();
}

function logListHTML(){
  const items=Object.entries(watchedMap).sort((a,b)=>(b[1].ts||0)-(a[1].ts||0));
  if(!items.length)return '<div style="font-size:13px;color:var(--mut2);padding:8px 2px">Nothing logged yet. Rate a suggestion and it\'ll shape what comes next.</div>';
  return items.map(([id,w])=>'<div class="logitem"><span class="dot" style="background:'+(w.liked?'var(--good)':w.liked===false?'var(--bad)':'var(--mut2)')+'"></span>'
    +'<span style="font-size:13.5px">'+esc(w.title)+'</span>'
    +'<span style="font-size:11.5px;color:var(--mut2)">'+(w.liked?'Loved it':w.liked===false?'Not for me':'Seen')+'</span>'
    +'<button class="chip" data-act="unwatch" data-id="'+esc(id)+'" style="margin-left:auto;background:transparent;border:none;color:var(--mut2);font-size:15px;padding:0 4px;cursor:pointer">&times;</button></div>').join("");
}
function logButtonHTML(){
  const c=watchedCount();
  return '<button class="ghost" id="logbtn"><span class="dot" style="background:'+(c?'var(--gold)':'var(--mut2)')+'"></span>Watched '+(c?'('+c+')':'')+' '+(showLog?'▴':'▾')+'</button>';
}
function wireLogControls(scope){
  scope.querySelectorAll('[data-act="unwatch"]').forEach(b=>b.onclick=()=>removeWatched(b.dataset.id));
  const lb=scope.querySelector("#logbtn"); if(lb)lb.onclick=()=>{showLog=!showLog; if(data)render(); renderInputLog();};
}
function renderInputLog(){
  const box=$("#inputlog");
  if(watchedCount()===0){box.innerHTML="";return;}
  box.innerHTML='<div class="hr" style="margin:20px 0 16px"></div>'+logButtonHTML()
    +(showLog?'<div style="margin-top:14px">'+logListHTML()+'</div>':'');
  wireLogControls(box);
}

// ---- input ----
function renderChips(){
  const box=$("#chips");
  box.querySelectorAll(".chip").forEach(e=>e.remove());
  const draft=$("#draft");
  shows.forEach((s,i)=>{
    const el=document.createElement("span");el.className="chip";
    el.innerHTML=esc(s)+' <button aria-label="Remove">&times;</button>';
    el.querySelector("button").onclick=()=>{shows.splice(i,1);renderChips();};
    box.insertBefore(el,draft);
  });
  draft.style.display=shows.length>=10?"none":"block";
  draft.placeholder=shows.length?"Add another…":"Type a title, press Enter";
  $("#count").textContent=shows.length+" / 10";
  $("#count").style.color=shows.length>=3?"var(--gold)":"var(--mut2)";
  const ok=shows.length>=3;
  $("#go").disabled=!ok;
  $("#hint").style.display=ok?"none":"block";
  $("#example").style.display=shows.length?"none":"block";
}
function addDraft(){const d=$("#draft");let v=d.value.trim().replace(/,$/,"").trim();
  if(!v)return;if(shows.some(s=>s.toLowerCase()===v.toLowerCase())){d.value="";return;}
  if(shows.length<10)shows.push(v);d.value="";renderChips();}
$("#draft").addEventListener("keydown",e=>{
  if(e.key==="Enter"||e.key===","){e.preventDefault();addDraft();}
  else if(e.key==="Backspace"&&!$("#draft").value&&shows.length){shows.pop();renderChips();}
});
$("#example").onclick=()=>{shows=[...EXAMPLE];renderChips();};
$("#go").onclick=discover;

async function discover(){
  const results=$("#results"), input=$("#input");
  input.style.display="none";results.style.display="block";showLog=false;exhausted=false;loadingMore=false;
  results.innerHTML='<div class="load" style="color:var(--mut);text-align:center;padding:40px 0">Reading your taste, pulling real ratings &amp; availability…</div>';
  filters={type:"all",min:0,net:false,sort:"match"};
  try{
    const r=await fetch("/api/discover",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({loved:shows,country:regionSel.value,watched:watchedMap})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||"Request failed");
    data=j;render();
  }catch(e){
    results.innerHTML='<div class="rc" style="text-align:center"><div style="margin-bottom:14px">'+esc(e.message)+'</div><button class="cta" onclick="discover()">Try again</button></div>';
  }
}

function observeSentinel(){
  if(io)io.disconnect();
  const el=$("#sentinel"); if(!el)return;
  io=new IntersectionObserver(es=>{ if(es[0].isIntersecting) loadMore(); },{rootMargin:"500px"});
  io.observe(el);
}
async function loadMore(){
  if(loadingMore||exhausted||!data)return;
  loadingMore=true; render();
  try{
    const exclude=data.results.map(x=>x.title);
    const r=await fetch("/api/discover",{method:"POST",headers:{"Content-Type":"application/json"},
      body:JSON.stringify({loved:shows,country:regionSel.value,exclude,watched:watchedMap})});
    const j=await r.json();
    if(!r.ok)throw new Error(j.error||"Couldn't load more");
    const have=new Set(data.results.map(x=>nrm(x.title)));
    const add=(j.results||[]).filter(x=>!have.has(nrm(x.title)));
    if(add.length===0){exhausted=true;} else {data.results=data.results.concat(add);}
  }catch(e){ exhausted=true; }
  loadingMore=false; render();
}

function meter(val,pct,disp,lab){
  return '<div class="sc"><div class="lab">'+lab+'</div><div class="val" style="color:'+(val==null?"var(--mut2)":"var(--text)")+'">'+disp+'</div><div class="meter"><i style="width:'+(pct==null?0:Math.max(3,Math.min(100,pct)))+'%;background:'+scoreColor(pct)+'"></i></div></div>';
}

function card(x){
  const id=nrm(x.title), w=watchedMap[id];
  const others=(x.services||[]).filter(s=>!/netflix/i.test(s.id||s.name)).slice(0,4);
  let watch;
  if(!x.onNetflix && others.length===0){
    watch='<div style="font-size:12px;color:var(--mut2)">No subscription stream found in '+x.country.toUpperCase()+'.</div>';
  }else{
    const label=x.onNetflix?"Where to watch":"Not on Netflix · watch on";
    let chips="";
    if(x.onNetflix){const l=x.netflixLink;chips+=(l?'<a class="svc net" target="_blank" rel="noopener" href="'+esc(l)+'">':'<span class="svc net">')+'Netflix '+x.country.toUpperCase()+(l?'</a>':'</span>');}
    others.forEach(s=>{chips+=(s.link?'<a class="svc plain" target="_blank" rel="noopener" href="'+esc(s.link)+'">':'<span class="svc plain">')+esc(s.name)+(s.link?'</a>':'</span>');});
    watch='<div class="lab2">'+label+'</div><div class="row" style="gap:6px">'+chips+'</div>';
  }
  let foot;
  if(w){
    foot='<div class="seenrow" style="justify-content:space-between"><span class="watchedtag" style="color:'+(w.liked?'var(--good)':'var(--bad)')+'">✓ Watched · '+(w.liked?'Loved it':'Not for me')+'</span>'
      +'<button class="undo" data-act="unwatch" data-id="'+esc(id)+'">undo</button></div>';
  }else{
    foot='<div class="seenrow"><span style="font-size:12px;color:var(--mut2);margin-right:auto">Seen it?</span>'
      +'<button class="rate up" data-act="like" data-id="'+esc(id)+'">👍 Loved it</button>'
      +'<button class="rate down" data-act="dislike" data-id="'+esc(id)+'">👎 Not for me</button></div>';
  }
  return '<div class="rc'+(w?' seen':'')+'"><div class="kicker">'+esc(x.type)+(x.year?' · '+esc(x.year):'')+'</div>'
    +'<div><div class="rt-title">'+esc(x.title)+'</div><div class="reason">'+esc(x.reason)+'</div></div>'
    +'<div class="hr"></div><div class="scores">'
    + meter(x.imdb, x.imdb!=null?x.imdb*10:null, x.imdb!=null?Number(x.imdb).toFixed(1):"—","IMDb")
    + meter(x.rtCritics, x.rtCritics, x.rtCritics!=null?Math.round(x.rtCritics)+"%":"—","RT Critics")
    + meter(x.metascore, x.metascore, x.metascore!=null?Math.round(x.metascore):"—","Metacritic")
    +'</div><div class="hr"></div>'+watch+'<div class="hr"></div>'+foot+'</div>';
}

function seg(name,opts,cur){
  return '<div><div class="lab2">'+name.label+'</div><div class="seg">'+opts.map(o=>
    '<button class="'+(o.v===cur?"on":"")+'" data-k="'+name.key+'" data-v="'+o.v+'">'+o.t+'</button>').join("")+'</div></div>';
}

function render(){
  const results=$("#results");
  let list=data.results.filter(x=>{
    if(filters.type!=="all"&&x.type.toLowerCase()!==filters.type)return false;
    if(filters.net&&x.onNetflix!==true)return false;
    if(filters.min>0&&(x.imdb==null||Number(x.imdb)<filters.min))return false;
    return true;
  });
  if(filters.sort==="imdb")list=[...list].sort((a,b)=>(b.imdb||-1)-(a.imdb||-1));
  if(filters.sort==="rt")list=[...list].sort((a,b)=>(b.rtCritics||-1)-(a.rtCritics||-1));

  const bar='<div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap">'
    +'<button class="ghost" id="back">← Start over</button>'
    +'<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap"><span style="font-size:12.5px;color:var(--mut)">Matched to '+shows.length+' loves · Netflix '+esc(data.countryName)+'</span>'+logButtonHTML()+'</div></div>';

  const panel=showLog?'<div class="logpanel"><div style="font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--mut2);margin-bottom:12px">Your watch history · shapes every suggestion</div>'+logListHTML()+'</div>':'';

  const toolbar='<div class="toolbar">'
    + seg({label:"Type",key:"type"},[{v:"all",t:"All"},{v:"movie",t:"Movies"},{v:"series",t:"Series"}],filters.type)
    + seg({label:"Min IMDb",key:"min"},[{v:0,t:"Any"},{v:7,t:"7+"},{v:8,t:"8+"}],filters.min)
    + seg({label:"Sort by",key:"sort"},[{v:"match",t:"Match"},{v:"imdb",t:"IMDb"},{v:"rt",t:"RT"}],filters.sort)
    + '<label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;margin-left:auto;user-select:none"><input type="checkbox" id="netonly" '+(filters.net?"checked":"")+' style="accent-color:var(--gold);width:16px;height:16px"> On Netflix only</label>'
    + '</div>';

  const body=list.length
    ? '<div class="grid">'+list.map(card).join("")+'</div>'
    : '<div style="color:var(--mut);text-align:center;padding:40px 0">Nothing matches these filters. Loosen them to see more.</div>';

  const note='<p class="note">Ratings via OMDb (IMDb · Rotten Tomatoes · Metacritic). '
    +esc(data.attribution)+'. More load automatically as you scroll, each batch avoiding what you\'ve already seen. Your watch history is saved server-side and feeds every suggestion.</p>';

  const footer = exhausted
    ? '<div style="text-align:center;color:var(--mut2);font-size:13px;padding:24px 0 8px">That\'s the best of what fits your taste right now. Rate a few and start over for a fresh read.</div>'
    : (loadingMore
        ? '<div class="load" style="text-align:center;color:var(--mut);font-size:13.5px;padding:24px 0 8px">Finding more for you…</div>'
        : '<div style="text-align:center;padding:20px 0 4px"><button class="ghost" id="loadmore">Load more</button></div>');
  const sentinel='<div id="sentinel" style="height:1px"></div>';

  results.innerHTML=bar+panel+toolbar+body+footer+sentinel+note;
  $("#back").onclick=()=>{results.style.display="none";$("#input").style.display="block";};
  $("#netonly").onchange=e=>{filters.net=e.target.checked;render();};
  results.querySelectorAll(".seg button").forEach(b=>b.onclick=()=>{
    const k=b.dataset.k;let v=b.dataset.v;if(k==="min")v=Number(v);filters[k]=v;render();
  });
  // watched controls
  results.querySelectorAll('[data-act="like"]').forEach(b=>b.onclick=()=>{const r=data.results.find(x=>nrm(x.title)===b.dataset.id);if(r)markWatched(r,true);});
  results.querySelectorAll('[data-act="dislike"]').forEach(b=>b.onclick=()=>{const r=data.results.find(x=>nrm(x.title)===b.dataset.id);if(r)markWatched(r,false);});
  results.querySelectorAll('[data-act="unwatch"]').forEach(b=>b.onclick=()=>removeWatched(b.dataset.id));
  wireLogControls(results);
  const lm=$("#loadmore"); if(lm)lm.onclick=loadMore;
  observeSentinel();
}

renderChips();
loadWatched();
</script>
</body>
</html>
`;

app.get("/", (_req, res) => res.type("html").send(PAGE));

app.listen(PORT, () => console.log(`What Next server → http://localhost:${PORT}`));
