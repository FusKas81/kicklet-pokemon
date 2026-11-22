// pokedex-site.js
// Public website for the Pokémon bot: animated top-10 catch leaderboard, every trainer's Pokédex,
// a shinies column, and a chat-verified login so trainers can release Pokémon from their party.
//
// Pages:   /pokedex            -> the website
// API:     /api/pokedex        -> public JSON (no secrets, no internal uids)
//          /api/login/start, /api/login/status, /api/me, /api/logout, /api/release

export default function registerPokedexSite(app, { getDB, saveDB, GEN1, MAX_POKEMON_ID, webLogins, crypto }) {
  const species = Object.entries(GEN1.mons)
    .map(([id, m]) => ({ id: Number(id), name: m.n, types: m.t }))
    .sort((a, b) => a.id - b.id);

  let cache = { at: 0, data: null };

  const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
  const SESSION_MS = 365 * 24 * 60 * 60 * 1000; // website login lasts 1 year and renews every time you open the site
  const LOGIN_MS = 5 * 60 * 1000;             // time to type !verify in chat
  const startHits = new Map();                // ip -> timestamps (rate limit)

  // ---------- public data ----------
  app.get('/api/pokedex', async (req, res) => {
    try {
      if (!cache.data || Date.now() - cache.at > 5000) {
        const db = await getDB();
        const users = Object.entries(db.users || {})
          .map(([name, u]) => {
            const inv = Array.isArray(u.inventory) ? u.inventory : [];
            const dex = Array.isArray(u.pokedex) ? u.pokedex : [...new Set(inv.map((p) => p.id))];
            // shiny species ever caught (tracked in u.shinies) + any shiny currently in the party
            const shinySet = new Set(Array.isArray(u.shinies) ? u.shinies : []);
            inv.forEach((p) => { if (p.isShiny) shinySet.add(p.id); });
            return {
              name,
              totalCaught: u.totalCaught !== undefined ? u.totalCaught : inv.length,
              battleWins: u.battleWins || 0,
              pokedex: dex.slice().sort((a, b) => a - b),
              shinies: [...shinySet].sort((a, b) => a - b),
              party: inv.map((p, i) => ({ slot: i, id: p.id, name: p.name, shiny: Boolean(p.isShiny), level: p.level || 50, moves: (Array.isArray(p.moves) ? p.moves : []).map((m) => ({ n: m.name, t: m.type, p: m.power, pp: m.maxPp })) }))
            };
          })
          .filter((u) => u.totalCaught > 0 || u.pokedex.length > 0 || u.party.length > 0)
          .sort((a, b) => b.totalCaught - a.totalCaught || b.pokedex.length - a.pokedex.length);
        cache = { at: Date.now(), data: { max: MAX_POKEMON_ID, species, users, now: Date.now() } };
      }
      res.set('Cache-Control', 'no-store');
      res.json(cache.data);
    } catch (e) {
      console.error('❌ /api/pokedex error:', e.message);
      res.status(500).json({ error: 'failed' });
    }
  });

  // ---------- login (verified through the stream chat) ----------
  // 1) site asks for a code for a username  2) the trainer types "!verify CODE" in chat  3) site gets a session token
  app.post('/api/login/start', async (req, res) => {
    try {
      const now = Date.now();
      const ip = req.ip || 'x';
      if (startHits.size > 2000) startHits.clear();
      const hits = (startHits.get(ip) || []).filter((t) => now - t < 60000);
      if (hits.length >= 6) return res.status(429).json({ error: 'Too many tries, wait a minute.' });
      hits.push(now);
      startHits.set(ip, hits);

      const username = String((req.body && req.body.username) || '').toLowerCase().replace('@', '').trim();
      if (!username || username.length > 40) return res.status(400).json({ error: 'Type your Kick username.' });

      const db = await getDB();
      if (!db.users || !db.users[username]) {
        return res.status(404).json({ error: 'No trainer with that name yet. Catch a Pokémon in chat first!' });
      }

      for (const [c, e] of webLogins) if (e.expires < now) webLogins.delete(c);
      if (webLogins.size > 500) return res.status(429).json({ error: 'Busy right now, try again in a few minutes.' });

      let code;
      do { code = crypto.randomBytes(3).toString('hex').toUpperCase(); } while (webLogins.has(code));
      const secret = crypto.randomBytes(24).toString('hex'); // only this browser knows it (the code is public in chat)
      webLogins.set(code, { user: username, secretHash: sha(secret), expires: now + LOGIN_MS, verified: false });
      res.json({ code, secret, expiresIn: LOGIN_MS / 1000 });
    } catch (e) {
      console.error('❌ /api/login/start error:', e.message);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });

  app.post('/api/login/status', async (req, res) => {
    try {
      const body = req.body || {};
      const code = String(body.code || '').toUpperCase();
      const entry = webLogins.get(code);
      if (!entry || entry.secretHash !== sha(body.secret || '')) return res.json({ status: 'expired' });
      const now = Date.now();
      if (entry.expires < now) { webLogins.delete(code); return res.json({ status: 'expired' }); }
      if (!entry.verified) return res.json({ status: 'pending' });

      webLogins.delete(code);
      const db = await getDB();
      if (!db.webSessions) db.webSessions = {};
      for (const k of Object.keys(db.webSessions)) if (db.webSessions[k].expires < now) delete db.webSessions[k];
      const token = crypto.randomBytes(24).toString('hex');
      db.webSessions[sha(token)] = { user: entry.user, expires: now + SESSION_MS };
      await saveDB(db);
      res.json({ status: 'verified', token, user: entry.user });
    } catch (e) {
      console.error('❌ /api/login/status error:', e.message);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });

  function sessionUser(db, req) {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    if (!token || !db.webSessions) return null;
    const s = db.webSessions[sha(token)];
    if (!s || s.expires < Date.now()) return null;
    return s.user;
  }

  app.get('/api/me', async (req, res) => {
    try {
      const db = await getDB();
      const user = sessionUser(db, req);
      if (!user) return res.status(401).json({ error: 'not logged in' });
      // sliding expiry: every visit pushes the expiry a full year ahead (saved at most once a day)
      const h = req.headers.authorization || '';
      const s = db.webSessions[sha(h.slice(7))];
      if (s && s.expires - Date.now() < SESSION_MS - 24 * 60 * 60 * 1000) {
        s.expires = Date.now() + SESSION_MS;
        await saveDB(db);
      }
      res.json({ user });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
  });

  app.post('/api/logout', async (req, res) => {
    try {
      const db = await getDB();
      const h = req.headers.authorization || '';
      const token = h.startsWith('Bearer ') ? h.slice(7) : '';
      if (token && db.webSessions && db.webSessions[sha(token)]) {
        delete db.webSessions[sha(token)];
        await saveDB(db);
      }
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: 'failed' });
    }
  });

  // ---------- release a Pokémon from your own party ----------
  app.post('/api/release', async (req, res) => {
    try {
      const db = await getDB();
      const user = sessionUser(db, req);
      if (!user) return res.status(401).json({ error: 'Please log in again.' });

      const body = req.body || {};
      const i = Number(body.slot);
      const inv = db.users && db.users[user] && db.users[user].inventory;
      if (!Array.isArray(inv) || !Number.isInteger(i) || i < 0 || !inv[i] ||
          inv[i].id !== Number(body.id) || Boolean(inv[i].isShiny) !== Boolean(body.shiny)) {
        return res.status(409).json({ error: 'Your party changed. Refresh the page and try again.' });
      }
      const gone = inv.splice(i, 1)[0];
      await saveDB(db);
      cache = { at: 0, data: null };
      res.json({ ok: true, name: gone.name });
    } catch (e) {
      console.error('❌ /api/release error:', e.message);
      res.status(500).json({ error: 'Something went wrong.' });
    }
  });

  app.get(['/pokedex', '/pokedex/'], (req, res) => res.type('html').send(PAGE));
}

// NOTE: this page is a plain template string. Do not use backticks or dollar-brace inside the script.
const PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pokédex Hall</title>
<link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
<style>
  :root { --bg:#14151f; --panel:#1f2133; --panel2:#2b2d42; --ink:#f1f1f5; --mute:#8d99ae; --line:#0b0c12; --gold:#f8c030; --green:#22c55e; --red:#ef4444; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--bg); color:var(--ink); font-family:'Press Start 2P', monospace; line-height:1.6; }
  header { padding:28px 20px 10px; text-align:center; position:relative; }
  h1 { font-size:clamp(18px,4vw,30px); letter-spacing:2px; color:var(--gold); text-shadow:3px 3px 0 #000; }
  .sub { font-size:9px; color:var(--mute); margin-top:10px; }
  #auth { margin-top:22px; text-align:center; font-size:14px; }
  .who { color:var(--gold); margin-right:12px; font-size:13px; }
  .btn.login-btn { font-size:13.5px; padding:14px 20px; border-width:4px; border-radius:9px; letter-spacing:1px;
    animation:loginflash 1.1s ease-in-out infinite, loginbob 2.2s ease-in-out infinite; }
  .btn.login-btn:hover { animation-play-state:paused; transform:scale(1.06); filter:brightness(1.2); }
  @keyframes loginflash {
    0%, 100% { background:#7c3aed; color:#fff; box-shadow:0 0 0 0 rgba(124,58,237,.7), 0 0 14px rgba(124,58,237,.6); }
    50% { background:#f8c030; color:#14151f; box-shadow:0 0 0 12px rgba(248,192,48,0), 0 0 30px rgba(248,192,48,.95); }
  }
  @keyframes loginbob { 0%, 100% { transform:translateY(0) scale(1); } 50% { transform:translateY(-4px) scale(1.04); } }
  @media (prefers-reduced-motion: reduce) { .btn.login-btn { animation:none; } }
  .btn { font-family:inherit; font-size:9px; background:#7c3aed; color:#fff; border:3px solid var(--line); border-radius:6px; padding:9px 12px; cursor:pointer; }
  .btn:hover { filter:brightness(1.15); }
  .btn.sm { font-size:8px; padding:6px 8px; background:#374151; }
  .btn.yes { background:#16a34a; }
  .btn.no { background:#b91c1c; }
  .btn:disabled { opacity:.5; cursor:wait; }
  .stats { display:flex; flex-wrap:wrap; justify-content:center; gap:10px; margin:20px auto 0; max-width:900px; padding:0 12px; }
  .stat { background:var(--panel); border:4px solid var(--line); border-radius:8px; padding:10px 14px; font-size:9px; text-align:center; }
  .stat b { display:block; font-size:16px; color:var(--gold); margin-bottom:4px; }

  section { max-width:1300px; margin:26px auto; padding:0 14px; }
  h2 { font-size:12px; color:var(--gold); margin-bottom:12px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; }

  /* ---------- three equal columns: catches / fight wins / chat commands ---------- */
  .boards { display:grid; grid-template-columns:repeat(3, minmax(0,1fr)); gap:14px; align-items:stretch; }
  @media (max-width:1050px) { .boards { grid-template-columns:1fr; } }
  .lb-wrap { position:relative; overflow:hidden; background:var(--panel); border:5px solid var(--line); border-radius:12px; padding:14px; height:660px; display:flex; flex-direction:column; }
  @media (max-width:1050px) { .lb-wrap { height:auto; } }
  .lb-wrap::before { content:''; position:absolute; inset:0; pointer-events:none;
    background:linear-gradient(110deg, transparent 38%, rgba(248,192,48,.10) 50%, transparent 62%); background-size:250% 100%;
    animation:sweep 5s linear infinite; }
  @keyframes sweep { from { background-position:150% 0; } to { background-position:-100% 0; } }
  .lb-title { text-align:center; font-size:10px; color:var(--gold); margin-bottom:12px; line-height:1.7; }
  .lb-list { flex:1; min-height:0; }
  .lb-row { position:relative; display:grid; grid-template-columns:38px minmax(0,1fr) 56px; align-items:center; gap:8px;
    padding:8px 10px; border-radius:8px; margin-bottom:6px; background:#181a29; cursor:pointer; transition:transform .15s, background .15s; }
  .lb-row:hover { transform:translateX(6px); background:#222540; }
  .lb-row.empty { cursor:default; opacity:.35; }
  .lb-row.empty:hover { transform:none; background:#181a29; }
  .lb-row.enter { animation:slide-in .65s cubic-bezier(.2,.9,.3,1.25) both; animation-delay:calc(var(--i) * 90ms); }
  @keyframes slide-in { from { transform:translateX(-70px); opacity:0; } to { transform:none; opacity:1; } }
  .lb-row.bump { animation:bump 1.2s ease-out; }
  @keyframes bump { 0% { background:#365314; transform:scale(1.03); } 100% { background:#181a29; transform:none; } }
  .lb-rank { font-size:13px; text-align:center; color:var(--mute); }
  .lb-mid { min-width:0; }
  .lb-name { display:block; font-size:9px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-bottom:5px; }
  .lb-bar { height:10px; background:#0b0c12; border-radius:5px; overflow:hidden; }
  .lb-bar i { display:block; height:100%; width:0; background:var(--green); border-radius:5px;
    transition:width 1.3s cubic-bezier(.2,.8,.2,1); transition-delay:calc(var(--i) * 90ms); }
  .lb-count { font-size:11px; text-align:right; color:var(--gold); }
  .lb-row.r1 { background:linear-gradient(90deg,#4a3a0a,#181a29 70%); }
  .lb-row.r2 { background:linear-gradient(90deg,#3b4048,#181a29 70%); }
  .lb-row.r3 { background:linear-gradient(90deg,#4a2e18,#181a29 70%); }
  .lb-row.r1 .lb-bar i, .lb-row.r2 .lb-bar i, .lb-row.r3 .lb-bar i { background-size:200% 100%; animation:shine 2.2s linear infinite; }
  .lb-row.r1 .lb-bar i { background-image:linear-gradient(90deg,#f8c030,#fff1b0,#f8c030); }
  .lb-row.r2 .lb-bar i { background-image:linear-gradient(90deg,#9ca3af,#f3f4f6,#9ca3af); }
  .lb-row.r3 .lb-bar i { background-image:linear-gradient(90deg,#b45309,#fdba74,#b45309); }
  @keyframes shine { from { background-position:0 0; } to { background-position:-200% 0; } }
  .lb-row.r1 .lb-rank { font-size:19px; animation:bob 1.4s ease-in-out infinite; display:inline-block; }
  .lb-row.r2 .lb-rank, .lb-row.r3 .lb-rank { font-size:17px; }
  @keyframes bob { 0%, 100% { transform:translateY(0) rotate(-6deg); } 50% { transform:translateY(-5px) rotate(6deg); } }
  .lb-row.r1 .lb-name { color:#fde68a; text-shadow:0 0 8px rgba(248,192,48,.6); }

  /* chat commands column */
  .cmd-list { flex:1; min-height:0; overflow-y:auto; padding-right:4px; position:relative; }
  @media (max-width:1050px) { .cmd-list { max-height:460px; } }
  .cmd { display:block; background:#181a29; border-radius:8px; padding:8px 10px; margin-bottom:6px; cursor:help; transition:transform .15s, background .15s; }
  .cmd:hover { background:#222540; transform:translateX(5px); }
  .cmd b { color:var(--gold); font-size:10px; font-weight:normal; }
  .cmd span { display:block; font-size:7px; color:var(--mute); margin-top:4px; line-height:1.7; }

  /* ---------- trainers ---------- */
  #search { width:100%; max-width:340px; background:var(--panel); border:4px solid var(--line); color:var(--ink); font-family:inherit; font-size:10px; padding:10px; border-radius:6px; outline:none; }
  #trainers { display:grid; grid-template-columns:repeat(auto-fill, minmax(520px, 1fr)); gap:14px; }
  @media (max-width:600px) { #trainers { grid-template-columns:1fr; } }
  .card { background:var(--panel); border:5px solid var(--line); border-radius:12px; padding:14px; }
  .card.flash { animation:cardflash 1.6s ease-out; }
  @keyframes cardflash { 0%, 40% { border-color:var(--gold); box-shadow:0 0 24px rgba(248,192,48,.7); } 100% { border-color:var(--line); box-shadow:none; } }
  .tname { font-size:11px; word-break:break-all; }
  .rank { color:var(--gold); }
  .meta { font-size:8px; color:var(--mute); margin-top:6px; line-height:1.9; }
  .bar { height:10px; background:#0b0c12; border-radius:5px; overflow:hidden; margin:10px 0; border:2px solid #0b0c12; }
  .bar > i { display:block; height:100%; background:var(--green); }
  .body { display:flex; gap:10px; align-items:stretch; }
  .col-title { font-size:8px; margin-bottom:6px; color:var(--mute); }
  .col-dex { flex:1; min-width:0; }
  .col-shiny { width:150px; flex:none; }
  @media (max-width:600px) { .body { flex-direction:column; } .col-shiny { width:100%; } }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(44px, 1fr)); gap:3px; max-height:290px; overflow-y:auto; padding:4px; background:#0f101a; border-radius:8px; }
  .cell { position:relative; aspect-ratio:1; background:var(--panel2); border-radius:6px; display:flex; align-items:center; justify-content:center; }
  .cell img { width:100%; height:100%; image-rendering:pixelated; object-fit:contain; }
  .cell.no img { filter:brightness(0); opacity:.35; }
  .cell.no { opacity:.6; }
  .cell.held { outline:2px solid var(--gold); }
  .cell .n { position:absolute; left:2px; top:1px; font-size:5px; color:#cbd5e1; }
  .col-shiny .col-title { color:var(--gold); }
  .shinybox { max-height:310px; overflow-y:auto; padding:4px; background:linear-gradient(180deg,#2a220a,#0f101a); border:2px solid #7a5c10; border-radius:8px; }
  .scell { display:flex; align-items:center; gap:6px; background:#1b1708; border-radius:6px; padding:3px 6px 3px 3px; margin-bottom:4px; }
  .scell img { width:36px; height:36px; image-rendering:pixelated; object-fit:contain; }
  .scell span { font-size:7px; color:#fde68a; word-break:break-all; line-height:1.4; }
  .sempty { font-size:7px; color:#7a6a3a; text-align:center; padding:16px 4px; line-height:1.8; }
  .empty { font-size:10px; color:var(--mute); padding:30px; text-align:center; }

  /* party strip (individual Pokémon you can release) */
  .party { display:flex; flex-wrap:wrap; gap:4px; padding:6px; background:#0f101a; border-radius:8px; margin-bottom:10px; min-height:52px; }
  .pm { width:46px; height:46px; background:var(--panel2); border-radius:8px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:transform .12s, box-shadow .12s; }
  .pm img { width:100%; height:100%; image-rendering:pixelated; object-fit:contain; pointer-events:none; }
  .pm.sh { outline:2px solid var(--gold); background:#2a220a; }
  .pm:hover { transform:translateY(-4px) scale(1.12); box-shadow:0 6px 14px rgba(0,0,0,.6); }
  .pm.mine { outline:2px dashed #fca5a5; }

  /* tooltip, modal, toast */
  #tip { position:fixed; z-index:99999; display:none; max-width:260px; background:#000; border:3px solid var(--gold); border-radius:8px; padding:8px 10px; font-size:8px; line-height:1.8; pointer-events:none; }
  #tip b { color:var(--gold); }
  #tip em { color:#fca5a5; font-style:normal; }
  #ov { position:fixed; inset:0; z-index:100000; background:rgba(0,0,0,.75); display:none; align-items:center; justify-content:center; padding:16px; }
  #modal { background:var(--panel); border:5px solid var(--gold); border-radius:12px; padding:20px; width:100%; max-width:480px; text-align:center; font-size:10px; line-height:1.9; animation:pop .25s cubic-bezier(.2,1.5,.4,1); }
  @keyframes pop { from { transform:scale(.7); opacity:0; } to { transform:none; opacity:1; } }
  #modal .mt { color:var(--gold); font-size:12px; margin-bottom:12px; }
  #modal img.big { width:96px; height:96px; image-rendering:pixelated; object-fit:contain; margin:6px auto; display:block; }
  #modal .mb { display:flex; gap:12px; justify-content:center; margin-top:16px; }
  #modal input { width:100%; background:#0f101a; border:3px solid var(--line); color:var(--ink); font-family:inherit; font-size:10px; padding:10px; border-radius:6px; margin:10px 0; outline:none; }
  #modal .code { font-size:15px; color:var(--gold); background:#0f101a; border:3px dashed var(--gold); border-radius:8px; padding:12px 6px; margin:12px 0; word-break:break-all; }
  #modal .err { color:#fca5a5; font-size:8px; min-height:14px; }
  #modal .hint { color:var(--mute); font-size:8px; }
  #modal .steps { text-align:left; font-size:8px; line-height:2; background:#0f101a; border-radius:8px; padding:12px 14px 12px 30px; margin:10px 0; }
  #modal .steps li { margin-bottom:6px; }
  #modal .steps b { color:var(--gold); }
  #modal .note { text-align:left; font-size:8px; line-height:1.9; color:var(--mute); }
  #toast { position:fixed; left:50%; bottom:24px; transform:translateX(-50%) translateY(80px); background:#000; border:3px solid var(--gold); border-radius:8px; padding:10px 14px; font-size:9px; z-index:100001; transition:transform .3s; max-width:90vw; }
  #toast.show { transform:translateX(-50%) translateY(0); }
</style>
</head>
<body>
<header>
  <h1>POKÉDEX HALL</h1>
  <div class="sub">Every Pokémon caught in the stream, live!</div>
  <div class="stats" id="stats"></div>
</header>

<section>
  <h2><span>🏆 LEADERBOARDS &amp; CHAT COMMANDS</span></h2>
  <div class="boards">
    <div class="lb-wrap">
      <div class="lb-title">🏆 TOP 10<br>MOST CATCHES</div>
      <div class="lb-list" id="lb"></div>
    </div>
    <div class="lb-wrap">
      <div class="lb-title">⚔️ TOP 10<br>MOST FIGHT WINS</div>
      <div class="lb-list" id="lb2"></div>
    </div>
    <div class="lb-wrap">
      <div class="lb-title">💬 ALL CHAT COMMANDS<br><span style="font-size:7px;color:var(--mute)">HOVER A COMMAND TO SEE HOW IT WORKS</span></div>
      <div class="cmd-list" id="cmds"></div>
    </div>
  </div>
  <div id="auth"></div>
</section>

<section>
  <h2><span>TRAINERS</span> <input id="search" placeholder="search trainer..."></h2>
  <div id="trainers"></div>
</section>

<div id="tip"></div>
<div id="ov"><div id="modal"></div></div>
<div id="toast"></div>

<script>
  var BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
  var data = null, lastJson = '', byId = {}, prevBoards = {};
  var me = null, token = null, loginTimer = null, loginState = null, toastTimer = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;'); }
  function png(id, shiny) { return BASE + (shiny ? '/shiny' : '') + '/' + id + '.png'; }
  function pretty(n) { return n ? n.charAt(0) + n.slice(1).toLowerCase() : '???'; }
  function store(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function readStore(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3500);
  }

  // ---------- modal ----------
  function openModal(html) { $('modal').innerHTML = html; $('ov').style.display = 'flex'; }
  function closeModal() {
    $('ov').style.display = 'none';
    $('modal').innerHTML = '';
    if (loginTimer) { clearInterval(loginTimer); loginTimer = null; }
    loginState = null;
  }
  $('ov').addEventListener('mousedown', function (e) { if (e.target === $('ov')) closeModal(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeModal(); });

  // ---------- login (verified in the stream chat) ----------
  function renderAuth() {
    if (me) {
      $('auth').innerHTML = '<span class="who">LOGGED IN: @' + esc(me) + '</span><button class="btn sm" id="b-out">LOG OUT</button>';
      $('b-out').onclick = logout;
    } else {
      $('auth').innerHTML = '<button class="btn login-btn" id="b-in">LOGIN TO MANAGE YOUR PARTY</button>';
      $('b-in').onclick = openLogin;
    }
  }

  function openLogin(note) {
    openModal('<div class="mt">LOGIN TO MANAGE YOUR PARTY</div>' +
      (typeof note === 'string' ? '<div class="err" style="color:#fde68a;font-size:8px;line-height:1.9">' + esc(note) + '</div>' : '') +
      '<div class="note">You log in by proving you own your Kick account, using the stream chat. No password is needed. Here is everything you have to do:</div>' +
      '<ol class="steps">' +
        '<li><b>Type your Kick username below</b> and press CONTINUE. It must be the exact account you use in the stream chat, and it must have caught at least one Pokémon with !catch.</li>' +
        '<li>The site will show you a <b>secret code</b> that looks like <b>!verify AB12CD</b>.</li>' +
        '<li><b>Open the stream chat on Kick</b> while logged in to that same Kick account, and send the message exactly as shown, for example <b>!verify AB12CD</b>. Copy and paste it so there are no typos.</li>' +
        '<li><b>Keep this page open.</b> It checks automatically, and within a few seconds the bot answers in chat with a green check and you are logged in.</li>' +
        '<li>The code only works for <b>5 minutes</b> and only for your own account. If it expires, press LOGIN again to get a new one.</li>' +
      '</ol>' +
      '<div class="note">Once logged in you stay logged in on this browser for up to a year, and the time renews every time you visit. You only need to log in again if you press LOG OUT, clear your browser data, or use another device or browser.</div>' +
      '<input id="lg-name" placeholder="your kick username" maxlength="40" autocomplete="off">' +
      '<div class="err" id="lg-err"></div>' +
      '<div class="mb"><button class="btn yes" id="lg-go">CONTINUE</button><button class="btn no" id="lg-x">CANCEL</button></div>');
    $('lg-go').onclick = startLogin;
    $('lg-x').onclick = closeModal;
    $('lg-name').onkeydown = function (e) { if (e.key === 'Enter') startLogin(); };
    $('lg-name').focus();
  }

  async function startLogin() {
    var name = $('lg-name').value.trim().toLowerCase().replace('@', '');
    if (!name) return;
    $('lg-go').disabled = true;
    try {
      var r = await fetch('/api/login/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name }) });
      var j = await r.json();
      if (!r.ok) { $('lg-err').textContent = j.error || 'Something went wrong.'; $('lg-go').disabled = false; return; }
      loginState = { code: j.code, secret: j.secret, until: Date.now() + j.expiresIn * 1000, user: name };
      openModal('<div class="mt">NOW VERIFY IN THE STREAM CHAT</div>' +
        '<div class="note">Your code for @' + esc(name) + ' is:</div>' +
        '<div class="code">!verify ' + esc(j.code) + '</div>' +
        '<ol class="steps">' +
          '<li>Open the <b>stream chat on Kick</b> in another tab or on your phone.</li>' +
          '<li>Make sure you are logged in to Kick as <b>@' + esc(name) + '</b>. Another account will not work.</li>' +
          '<li>Send exactly <b>!verify ' + esc(j.code) + '</b> as a chat message.</li>' +
          '<li>Come back to this page and <b>leave it open</b>. When the bot replies with a green check in chat, this window closes by itself and you are logged in.</li>' +
        '</ol>' +
        '<div class="hint" id="lg-wait">Waiting for you... </div>' +
        '<div class="note">Nothing happening? Check that you typed the code exactly, that the bot is online, and that the code has not expired (5 minutes). You can cancel and press LOGIN again for a new code.</div>' +
        '<div class="mb"><button class="btn no" id="lg-x">CANCEL</button></div>');
      $('lg-x').onclick = closeModal;
      loginTimer = setInterval(pollLogin, 2000);
    } catch (e) {
      $('lg-err').textContent = 'Could not reach the server.';
      $('lg-go').disabled = false;
    }
  }

  async function pollLogin() {
    if (!loginState) return;
    var left = Math.max(0, Math.ceil((loginState.until - Date.now()) / 1000));
    if ($('lg-wait')) $('lg-wait').textContent = 'Waiting for you... code expires in ' + Math.floor(left / 60) + ':' + (left % 60 < 10 ? '0' : '') + (left % 60);
    try {
      var r = await fetch('/api/login/status', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: loginState.code, secret: loginState.secret }) });
      var j = await r.json();
      if (j.status === 'verified') {
        token = j.token; me = j.user;
        store('ph_token', token);
        closeModal();
        renderAuth();
        if (data) { renderTrainers(); goToTrainer(me); }
        toast('Logged in as @' + me + '! You will stay logged in on this browser. Press a Pokémon in your party to release it.');
      } else if (j.status === 'expired') {
        closeModal();
        toast('The code expired. Press LOGIN to try again.');
      }
    } catch (e) {}
  }

  async function logout() {
    try { await fetch('/api/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } }); } catch (e) {}
    me = null; token = null; store('ph_token', null);
    renderAuth();
    if (data) renderTrainers();
    toast('Logged out.');
  }

  async function restoreLogin() {
    token = readStore('ph_token');
    if (!token) { renderAuth(); return; }
    try {
      var r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + token } });
      if (r.ok) { me = (await r.json()).user; } else { token = null; store('ph_token', null); }
    } catch (e) {}
    renderAuth();
    if (data) renderTrainers();
  }

  // ---------- party tooltip + release ----------
  function partyOf(owner, slot) {
    for (var i = 0; i < data.users.length; i++) {
      if (data.users[i].name === owner) {
        var pt = data.users[i].party;
        for (var j = 0; j < pt.length; j++) if (pt[j].slot === slot) return pt[j];
      }
    }
    return null;
  }

  function tipHtml(el) {
    var name = pretty(el.getAttribute('data-name'));
    var owner = el.getAttribute('data-user');
    var head = '<b>' + esc(name) + '</b> Lv' + esc(el.getAttribute('data-level')) + (el.getAttribute('data-shiny') === '1' ? ' ✨' : '') + ' (@' + esc(owner) + ')';
    var p = partyOf(owner, Number(el.getAttribute('data-slot')));
    var mv = '';
    if (p && p.moves && p.moves.length) {
      mv = '<br><br><em>MOVES</em>' + p.moves.map(function (m, i) {
        var power = m.p > 1 ? 'PWR ' + m.p : 'status / special';
        return '<br>' + (i + 1) + '. ' + esc(m.n) + ' - ' + esc(pretty(m.t)) + ', ' + power + ', ' + m.pp + ' PP';
      }).join('');
    } else {
      mv = '<br><br><em>MOVES</em><br>Not known yet (shown after the trainer uses a command)';
    }
    if (me && me === owner) return head + mv + '<br><br><em>Press this Pokémon to remove it from your party</em>';
    if (me) return head + mv;
    return head + mv + '<br><br>Log in (button below the leaderboards) to manage your party';
  }

  function releaseConfirm(el) {
    var name = pretty(el.getAttribute('data-name'));
    var shiny = el.getAttribute('data-shiny') === '1';
    openModal('<div class="mt">REMOVE FROM PARTY?</div>' +
      '<img class="big" src="' + png(el.getAttribute('data-id'), shiny) + '" alt="">' +
      '<div>' + (shiny ? '✨ ' : '') + esc(name) + ' Lv' + esc(el.getAttribute('data-level')) + '<br>will be released. This cannot be undone.</div>' +
      '<div class="err" id="rl-err"></div>' +
      '<div class="mb"><button class="btn yes" id="rl-yes">YES</button><button class="btn no" id="rl-no">NO</button></div>');
    $('rl-no').onclick = closeModal;
    $('rl-yes').onclick = async function () {
      $('rl-yes').disabled = true; $('rl-no').disabled = true;
      try {
        var r = await fetch('/api/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
          body: JSON.stringify({ slot: Number(el.getAttribute('data-slot')), id: Number(el.getAttribute('data-id')), shiny: shiny })
        });
        var j = await r.json();
        if (r.status === 401) { me = null; token = null; store('ph_token', null); renderAuth(); openLogin('Your login expired. Please log in again.'); return; }
        if (!r.ok) { $('rl-err').textContent = j.error || 'Something went wrong.'; $('rl-yes').disabled = false; $('rl-no').disabled = false; return; }
        closeModal();
        toast(pretty(j.name) + ' was released from your party.');
        lastJson = '';
        load();
      } catch (e) {
        $('rl-err').textContent = 'Could not reach the server.';
        $('rl-yes').disabled = false; $('rl-no').disabled = false;
      }
    };
  }

  function clickMon(el) {
    var owner = el.getAttribute('data-user');
    if (!me) { openLogin('Log in to manage your party. Type your Kick username and confirm it in the stream chat.'); return; }
    if (me !== owner) { toast('That Pokémon belongs to @' + owner + '. Only its trainer can release it.'); return; }
    releaseConfirm(el);
  }

  // ---------- chat commands list ----------
  var COMMANDS = [
    { n: '!catch', s: 'Throw a Pokéball at the wild Pokémon',
      what: 'Tries to catch the wild Pokémon that is on screen right now. You have 60 seconds after it appears. Each trainer gets 3 tries per spawn and every try has a 65% chance to work. You cannot catch if your party is full (15). Catching 3 of the same species merges them into its evolution.',
      use: '!catch', ex: '!catch' },
    { n: '!spawncheck / !wild', s: 'See the wild Pokémon right now',
      what: 'Shows the Pokémon that is currently available, its type, how many catch tries you have left and how many seconds remain. If nothing is there it tells you when the next one appears.',
      use: '!spawncheck  (or !wild)', ex: '!wild' },
    { n: '!spawn', s: 'Summon a wild Pokémon (owner, mods, subs)',
      what: 'Spawns a random Pokémon right away. Only the channel owner, moderators and subscribers can use it, only when no Pokémon is catchable, and each user has a 10 minute cooldown. It also delays the next automatic spawn by 5 minutes.',
      use: '!spawn', ex: '!spawn' },
    { n: '!party', s: 'List your Pokémon and slot numbers',
      what: 'Shows every Pokémon you own with its slot number (max 15). The slot numbers are used by !info, !release, !trade and !battle. Shiny Pokémon have a star. You can also manage your party on this website.',
      use: '!party  (or !party <page> if you have more than 15)', ex: '!party' },
    { n: '!info', s: 'Stats and moves of one Pokémon',
      what: 'Shows the level, type, stats (HP, ATK, DEF, SPD, SPC) and the 4 moves of the Pokémon in a slot, including move type, power and PP.',
      use: '!info <slot number>', ex: '!info 1' },
    { n: '!release', s: 'Release a Pokémon from your party',
      what: 'Permanently removes the Pokémon in that slot from your party to free space. It cannot be undone, but the species stays in your Pokédex. You can also release Pokémon on this website by pressing them.',
      use: '!release <slot number>', ex: '!release 3' },
    { n: '!pokedex', s: 'Your Pokédex progress',
      what: 'Shows how many different species you have found out of 151, the percentage, and your total number of catches.',
      use: '!pokedex', ex: '!pokedex' },
    { n: '!leaderboard', s: 'Top catchers and battle winners in chat',
      what: 'Shows the top 3 trainers by catches and by battle wins. Add catches or wins to see only one of them. The full Top 10 lists are on this website.',
      use: '!leaderboard  (or !leaderboard catches / !leaderboard wins)', ex: '!leaderboard wins' },
    { n: '!trade', s: 'Offer a Pokémon to another trainer',
      what: 'Offers the Pokémon in one of your slots to another trainer who has played before. They must answer with !accept and pick one of their own Pokémon to swap with you.',
      use: '!trade @username <your slot>', ex: '!trade @ash 2' },
    { n: '!accept', s: 'Accept a trade offer',
      what: 'Accepts a trade someone offered you. You choose which of your Pokémon to give in exchange. Both trainers swap Pokémon right away and a trade can trigger evolutions.',
      use: '!accept <your slot>', ex: '!accept 1' },
    { n: '!battle', s: 'Challenge a trainer or accept a challenge',
      what: 'Challenges another trainer with the Pokémon in your slot, or accepts a challenge you received. The other trainer has 5 minutes to accept. Battles use Pokémon Red and Blue rules at level 50 and last 5 minutes at most. When time runs out the Pokémon with more HP left wins.',
      use: '!battle @username <your slot>', ex: '!battle @ash 1' },
    { n: '!move', s: 'Pick your attack in a battle',
      what: 'Every round both trainers choose a move within 30 seconds. If you do not choose, your Pokémon does not attack that round. The faster Pokémon moves first. Use it without a number to see your moves and their PP.',
      use: '!move <1-4>', ex: '!move 2' },
    { n: '!forfeit', s: 'Quit a battle or cancel a challenge',
      what: 'Gives up your current battle so your opponent wins, or cancels a challenge nobody accepted yet.',
      use: '!forfeit', ex: '!forfeit' },
    { n: '!verify', s: 'Log in on this website',
      what: 'Proves that you own your Kick account so you can manage your party on the website. Press the login button on the site, it gives you a code, then send it in chat. The code works for 5 minutes.',
      use: '!verify <code>', ex: '!verify AB12CD' },
    { n: '!help / !pokemon', s: 'Show the list of commands',
      what: 'Posts a short list of every command and the website link in chat.',
      use: '!help  (or !pokemon)', ex: '!help' }
  ];

  function renderCommands() {
    $('cmds').innerHTML = COMMANDS.map(function (c, i) {
      return '<div class="cmd" data-i="' + i + '"><b>' + esc(c.n) + '</b><span>' + esc(c.s) + '</span></div>';
    }).join('');
  }

  function cmdTip(el) {
    var c = COMMANDS[Number(el.getAttribute('data-i'))];
    return '<b>' + esc(c.n) + '</b><br>' + esc(c.what) + '<br><br><em>HOW TO USE</em><br>' + esc(c.use) +
      (c.ex ? '<br><br><em>EXAMPLE</em><br>' + esc(c.ex) : '');
  }

  // ---------- tooltips + party click ----------
  (function wireTips() {
    var tip = $('tip');
    function hide() { tip.style.display = 'none'; }
    function show(e, html, wide) {
      tip.style.maxWidth = wide ? '360px' : '280px';
      tip.innerHTML = html;
      tip.style.display = 'block';
      var x = Math.min(e.clientX + 16, window.innerWidth - tip.offsetWidth - 8);
      var y = e.clientY + 20;
      if (y + tip.offsetHeight > window.innerHeight - 8) y = e.clientY - tip.offsetHeight - 12;
      tip.style.left = Math.max(4, x) + 'px';
      tip.style.top = Math.max(4, y) + 'px';
    }
    var box = $('trainers'), cmds = $('cmds');
    box.addEventListener('mousemove', function (e) {
      var el = e.target.closest ? e.target.closest('.pm') : null;
      if (!el) { hide(); return; }
      show(e, tipHtml(el), false);
    });
    box.addEventListener('mouseleave', hide);
    box.addEventListener('click', function (e) {
      var el = e.target.closest ? e.target.closest('.pm') : null;
      if (el) { hide(); clickMon(el); }
    });
    cmds.addEventListener('mousemove', function (e) {
      var el = e.target.closest ? e.target.closest('.cmd') : null;
      if (!el) { hide(); return; }
      show(e, cmdTip(el), true);
    });
    cmds.addEventListener('mouseleave', hide);
    window.addEventListener('scroll', hide, true);
  })();

  // ---------- stats ----------
  function renderStats() {
    var trainers = data.users.length, caught = 0, species = {}, shinies = 0;
    data.users.forEach(function (u) {
      caught += u.totalCaught;
      u.pokedex.forEach(function (id) { species[id] = 1; });
      shinies += u.shinies.length;
    });
    var items = [
      [trainers, 'TRAINERS'],
      [caught, 'TOTAL CAUGHT'],
      [Object.keys(species).length + '/' + data.max, 'SPECIES FOUND'],
      [shinies, 'SHINIES CAUGHT']
    ];
    $('stats').innerHTML = items.map(function (i) { return '<div class="stat"><b>' + i[0] + '</b>' + i[1] + '</div>'; }).join('');
  }

  // ---------- animated leaderboard ----------
  function countUp(el, from, to) {
    var start = Date.now(), dur = 1300;
    var t = setInterval(function () {
      var p = Math.min(1, (Date.now() - start) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (to - from) * e);
      if (p >= 1) clearInterval(t);
    }, 30);
  }

  function renderBoard(elId, rows, valueOf) {
    var max = rows.length ? Math.max(1, valueOf(rows[0])) : 1;
    var first = prevBoards[elId] === undefined;
    var prev = prevBoards[elId] || {};
    var medals = ['🥇', '🥈', '🥉'];
    var html = '';
    for (var i = 0; i < 10; i++) {
      var u = rows[i];
      if (!u) {
        html += '<div class="lb-row empty" style="--i:' + i + '"><span class="lb-rank">' + (i + 1) + '</span><div class="lb-mid"><span class="lb-name">- - - - -</span><div class="lb-bar"></div></div><span class="lb-count">0</span></div>';
        continue;
      }
      var val = valueOf(u);
      var known = prev[u.name] !== undefined;
      var bump = !first && known && val > prev[u.name];
      var from = known ? prev[u.name] : 0;
      var pct = Math.max(3, (val / max) * 100);
      html += '<div class="lb-row r' + (i + 1) + (first ? ' enter' : '') + (bump ? ' bump' : '') + '" data-user="' + esc(u.name) + '" style="--i:' + i + '">' +
        '<span class="lb-rank">' + (i < 3 ? medals[i] : (i + 1)) + '</span>' +
        '<div class="lb-mid"><span class="lb-name">@' + esc(u.name) + '</span><div class="lb-bar"><i data-w="' + pct.toFixed(1) + '"></i></div></div>' +
        '<span class="lb-count" data-from="' + from + '" data-to="' + val + '">' + from + '</span></div>';
    }
    $(elId).innerHTML = html;

    requestAnimationFrame(function () { requestAnimationFrame(function () {
      Array.prototype.forEach.call(document.querySelectorAll('#' + elId + ' .lb-bar i'), function (b) { b.style.width = b.getAttribute('data-w') + '%'; });
      Array.prototype.forEach.call(document.querySelectorAll('#' + elId + ' .lb-count'), function (c) {
        countUp(c, Number(c.getAttribute('data-from')), Number(c.getAttribute('data-to')));
      });
    }); });

    Array.prototype.forEach.call(document.querySelectorAll('#' + elId + ' .lb-row[data-user]'), function (r) {
      r.onclick = function () { goToTrainer(r.getAttribute('data-user')); };
    });

    prevBoards[elId] = {};
    data.users.forEach(function (u) { prevBoards[elId][u.name] = valueOf(u); });
  }

  function renderLeaderboard() {
    var byCatch = data.users.filter(function (u) { return u.totalCaught > 0; })
      .sort(function (a, b) { return b.totalCaught - a.totalCaught || b.pokedex.length - a.pokedex.length; });
    var byWins = data.users.filter(function (u) { return u.battleWins > 0; })
      .sort(function (a, b) { return b.battleWins - a.battleWins || b.totalCaught - a.totalCaught; });
    renderBoard('lb', byCatch.slice(0, 10), function (u) { return u.totalCaught; });
    renderBoard('lb2', byWins.slice(0, 10), function (u) { return u.battleWins; });
  }

  function goToTrainer(name) {
    $('search').value = '';
    renderTrainers();
    var cards = document.querySelectorAll('.card');
    for (var i = 0; i < cards.length; i++) {
      if (cards[i].getAttribute('data-card') === name) {
        cards[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
        cards[i].classList.remove('flash');
        void cards[i].offsetWidth;
        cards[i].classList.add('flash');
        break;
      }
    }
  }

  // ---------- trainers + pokédex grids ----------
  function renderTrainers() {
    var q = $('search').value.trim().toLowerCase();
    var users = data.users.filter(function (u) { return !q || u.name.indexOf(q) !== -1; });
    // the logged-in trainer always goes first (other trainers keep their rank order)
    if (me) users = users.filter(function (u) { return u.name === me; }).concat(users.filter(function (u) { return u.name !== me; }));
    if (!users.length) { $('trainers').innerHTML = '<div class="empty">' + (data.users.length ? 'NO TRAINER FOUND' : 'NOBODY HAS CAUGHT A POKÉMON YET!') + '</div>'; return; }

    $('trainers').innerHTML = users.map(function (u) {
      var rank = data.users.indexOf(u) + 1;
      var pct = Math.min(100, (u.pokedex.length / data.max) * 100);
      var dex = {}; u.pokedex.forEach(function (id) { dex[id] = 1; });
      var held = {}; u.party.forEach(function (p) { held[p.id] = 1; });
      var cells = data.species.map(function (sp) {
        var has = dex[sp.id] || held[sp.id];
        var cls = 'cell' + (has ? '' : ' no') + (held[sp.id] ? ' held' : '');
        var title = has ? pretty(sp.name) + (held[sp.id] ? ' (in party)' : ' (caught before)') : '???';
        return '<div class="' + cls + '" title="' + esc(title) + '"><span class="n">' + sp.id + '</span><img loading="lazy" src="' + png(sp.id, false) + '" alt=""></div>';
      }).join('');
      var shinyHtml = u.shinies.length
        ? u.shinies.map(function (id) {
            var nm = byId[id] ? pretty(byId[id].name) : '#' + id;
            return '<div class="scell" title="' + esc(nm) + '"><img loading="lazy" src="' + png(id, true) + '" alt=""><span>' + esc(nm) + '</span></div>';
          }).join('')
        : '<div class="sempty">NO SHINIES YET</div>';
      var partyHtml = u.party.length
        ? u.party.map(function (p) {
            return '<div class="pm' + (p.shiny ? ' sh' : '') + (me && me === u.name ? ' mine' : '') + '"' +
              ' data-user="' + esc(u.name) + '" data-slot="' + p.slot + '" data-id="' + p.id + '" data-shiny="' + (p.shiny ? 1 : 0) + '"' +
              ' data-name="' + esc(p.name) + '" data-level="' + p.level + '"><img loading="lazy" src="' + png(p.id, p.shiny) + '" alt=""></div>';
          }).join('')
        : '<div class="sempty" style="padding:8px">PARTY IS EMPTY</div>';
      return '<div class="card" data-card="' + esc(u.name) + '">' +
        '<div class="tname"><span class="rank">#' + rank + '</span> @' + esc(u.name) + '</div>' +
        '<div class="meta">CAUGHT ' + u.totalCaught + ' &middot; POKÉDEX ' + u.pokedex.length + '/' + data.max + ' &middot; PARTY ' + u.party.length + ' &middot; SHINIES ' + u.shinies.length + ' &middot; WINS ' + u.battleWins + '</div>' +
        '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
        '<div class="col-title">PARTY (' + u.party.length + ')</div><div class="party">' + partyHtml + '</div>' +
        '<div class="body">' +
          '<div class="col-dex"><div class="col-title">POKÉDEX</div><div class="grid">' + cells + '</div></div>' +
          '<div class="col-shiny"><div class="col-title">✨ SHINIES CAUGHT</div><div class="shinybox">' + shinyHtml + '</div></div>' +
        '</div></div>';
    }).join('');
  }

  // ---------- load ----------
  async function load() {
    try {
      var res = await fetch('/api/pokedex');
      var d = await res.json();
      var json = JSON.stringify([d.users, d.max]);
      var first = !data;
      data = d;
      if (first) { byId = {}; d.species.forEach(function (s) { byId[s.id] = s; }); }
      if (first || json !== lastJson) {
        lastJson = json;
        renderStats();
        renderLeaderboard();
        renderTrainers();
      }
    } catch (e) {
      if (!data) $('lb').innerHTML = '<div class="empty">COULD NOT LOAD DATA. TRY AGAIN SOON.</div>';
    }
  }

  $('search').oninput = function () { if (data) renderTrainers(); };
  renderAuth();
  renderCommands();
  load().then(restoreLogin);
  setInterval(load, 30000);
</script>
</body>
</html>`;
