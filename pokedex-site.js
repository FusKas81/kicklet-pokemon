// pokedex-site.js
// Public website for the Pokémon bot: animated top-10 catch leaderboard + every trainer's Pokédex
// with a separate column for the shinies they caught.
//
// Pages:   /pokedex            -> the website
// API:     /api/pokedex        -> public JSON (no secrets, no internal uids)

export default function registerPokedexSite(app, { getDB, GEN1, MAX_POKEMON_ID }) {
  const species = Object.entries(GEN1.mons)
    .map(([id, m]) => ({ id: Number(id), name: m.n, types: m.t }))
    .sort((a, b) => a.id - b.id);

  let cache = { at: 0, data: null };

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
              party: inv.map((p) => ({ id: p.id, name: p.name, shiny: Boolean(p.isShiny), level: p.level || 50 }))
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
  header { padding:28px 20px 10px; text-align:center; }
  h1 { font-size:clamp(18px,4vw,30px); letter-spacing:2px; color:var(--gold); text-shadow:3px 3px 0 #000; }
  .sub { font-size:9px; color:var(--mute); margin-top:10px; }
  .stats { display:flex; flex-wrap:wrap; justify-content:center; gap:10px; margin:20px auto 0; max-width:900px; padding:0 12px; }
  .stat { background:var(--panel); border:4px solid var(--line); border-radius:8px; padding:10px 14px; font-size:9px; text-align:center; }
  .stat b { display:block; font-size:16px; color:var(--gold); margin-bottom:4px; }

  section { max-width:1300px; margin:26px auto; padding:0 14px; }
  h2 { font-size:12px; color:var(--gold); margin-bottom:12px; display:flex; flex-wrap:wrap; gap:10px; align-items:center; justify-content:space-between; }

  /* ---------- animated leaderboard ---------- */
  .lb-wrap { position:relative; overflow:hidden; background:var(--panel); border:5px solid var(--line); border-radius:12px; padding:16px; }
  .lb-wrap::before { content:''; position:absolute; inset:0; pointer-events:none;
    background:linear-gradient(110deg, transparent 38%, rgba(248,192,48,.10) 50%, transparent 62%); background-size:250% 100%;
    animation:sweep 5s linear infinite; }
  @keyframes sweep { from { background-position:150% 0; } to { background-position:-100% 0; } }
  .lb-title { text-align:center; font-size:10px; color:var(--mute); margin-bottom:12px; }
  .lb-row { position:relative; display:grid; grid-template-columns:48px minmax(80px,220px) 1fr 70px; align-items:center; gap:10px;
    padding:9px 12px; border-radius:8px; margin-bottom:6px; background:#181a29; cursor:pointer; transition:transform .15s, background .15s; }
  .lb-row:hover { transform:translateX(6px); background:#222540; }
  .lb-row.empty { cursor:default; opacity:.35; }
  .lb-row.empty:hover { transform:none; background:#181a29; }
  .lb-row.enter { animation:slide-in .65s cubic-bezier(.2,.9,.3,1.25) both; animation-delay:calc(var(--i) * 90ms); }
  @keyframes slide-in { from { transform:translateX(-70px); opacity:0; } to { transform:none; opacity:1; } }
  .lb-row.bump { animation:bump 1.2s ease-out; }
  @keyframes bump { 0% { background:#365314; transform:scale(1.03); } 100% { background:#181a29; transform:none; } }
  .lb-rank { font-size:14px; text-align:center; color:var(--mute); }
  .lb-name { font-size:10px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .lb-bar { height:12px; background:#0b0c12; border-radius:6px; overflow:hidden; }
  .lb-bar i { display:block; height:100%; width:0; background:var(--green); border-radius:6px;
    transition:width 1.3s cubic-bezier(.2,.8,.2,1); transition-delay:calc(var(--i) * 90ms); }
  .lb-count { font-size:12px; text-align:right; color:var(--gold); }

  .lb-row.r1 { background:linear-gradient(90deg,#4a3a0a,#181a29 70%); }
  .lb-row.r2 { background:linear-gradient(90deg,#3b4048,#181a29 70%); }
  .lb-row.r3 { background:linear-gradient(90deg,#4a2e18,#181a29 70%); }
  .lb-row.r1 .lb-bar i, .lb-row.r2 .lb-bar i, .lb-row.r3 .lb-bar i { background-size:200% 100%; animation:shine 2.2s linear infinite; }
  .lb-row.r1 .lb-bar i { background-image:linear-gradient(90deg,#f8c030,#fff1b0,#f8c030); }
  .lb-row.r2 .lb-bar i { background-image:linear-gradient(90deg,#9ca3af,#f3f4f6,#9ca3af); }
  .lb-row.r3 .lb-bar i { background-image:linear-gradient(90deg,#b45309,#fdba74,#b45309); }
  @keyframes shine { from { background-position:0 0; } to { background-position:-200% 0; } }
  .lb-row.r1 .lb-rank { font-size:20px; animation:bob 1.4s ease-in-out infinite; display:inline-block; }
  .lb-row.r2 .lb-rank, .lb-row.r3 .lb-rank { font-size:18px; }
  @keyframes bob { 0%, 100% { transform:translateY(0) rotate(-6deg); } 50% { transform:translateY(-5px) rotate(6deg); } }
  .lb-row.r1 .lb-name { color:#fde68a; text-shadow:0 0 8px rgba(248,192,48,.6); }
  @media (max-width:560px) { .lb-row { grid-template-columns:38px 1fr 54px; } .lb-bar { display:none; } }

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
</style>
</head>
<body>
<header>
  <h1>POKÉDEX HALL</h1>
  <div class="sub">Every Pokémon caught in the stream, live!</div>
  <div class="stats" id="stats"></div>
</header>

<section>
  <h2><span>🏆 TOP 10 CATCHERS</span></h2>
  <div class="lb-wrap">
    <div class="lb-title">MOST POKÉMON CAUGHT</div>
    <div id="lb"></div>
  </div>
</section>

<section>
  <h2><span>TRAINERS</span> <input id="search" placeholder="search trainer..."></h2>
  <div id="trainers"></div>
</section>

<script>
  var BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
  var data = null, lastJson = '', byId = {}, prevCounts = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;'); }
  function png(id, shiny) { return BASE + (shiny ? '/shiny' : '') + '/' + id + '.png'; }
  function pretty(n) { return n ? n.charAt(0) + n.slice(1).toLowerCase() : '???'; }

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

  function renderLeaderboard() {
    var top = data.users.filter(function (u) { return u.totalCaught > 0; })
      .sort(function (a, b) { return b.totalCaught - a.totalCaught || b.pokedex.length - a.pokedex.length; })
      .slice(0, 10);
    var max = top.length ? Math.max(1, top[0].totalCaught) : 1;
    var first = prevCounts === null;
    var medals = ['🥇', '🥈', '🥉'];
    var html = '';
    for (var i = 0; i < 10; i++) {
      var u = top[i];
      if (!u) {
        html += '<div class="lb-row empty" style="--i:' + i + '"><span class="lb-rank">' + (i + 1) + '</span><span class="lb-name">- - - - -</span><div class="lb-bar"></div><span class="lb-count">0</span></div>';
        continue;
      }
      var known = prevCounts && prevCounts[u.name] !== undefined;
      var bump = !first && known && u.totalCaught > prevCounts[u.name];
      var from = known ? prevCounts[u.name] : 0;
      var pct = Math.max(3, (u.totalCaught / max) * 100);
      html += '<div class="lb-row r' + (i + 1) + (first ? ' enter' : '') + (bump ? ' bump' : '') + '" data-user="' + esc(u.name) + '" style="--i:' + i + '">' +
        '<span class="lb-rank">' + (i < 3 ? medals[i] : (i + 1)) + '</span>' +
        '<span class="lb-name">@' + esc(u.name) + '</span>' +
        '<div class="lb-bar"><i data-w="' + pct.toFixed(1) + '"></i></div>' +
        '<span class="lb-count" data-from="' + from + '" data-to="' + u.totalCaught + '">' + from + '</span></div>';
    }
    $('lb').innerHTML = html;

    // start the bar growth + number count-up one frame later so the transitions play
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      Array.prototype.forEach.call(document.querySelectorAll('#lb .lb-bar i'), function (b) { b.style.width = b.getAttribute('data-w') + '%'; });
      Array.prototype.forEach.call(document.querySelectorAll('#lb .lb-count'), function (c) {
        countUp(c, Number(c.getAttribute('data-from')), Number(c.getAttribute('data-to')));
      });
    }); });

    Array.prototype.forEach.call(document.querySelectorAll('#lb .lb-row[data-user]'), function (r) {
      r.onclick = function () { goToTrainer(r.getAttribute('data-user')); };
    });

    prevCounts = {};
    data.users.forEach(function (u) { prevCounts[u.name] = u.totalCaught; });
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
      return '<div class="card" data-card="' + esc(u.name) + '">' +
        '<div class="tname"><span class="rank">#' + rank + '</span> @' + esc(u.name) + '</div>' +
        '<div class="meta">CAUGHT ' + u.totalCaught + ' &middot; POKÉDEX ' + u.pokedex.length + '/' + data.max + ' &middot; PARTY ' + u.party.length + ' &middot; SHINIES ' + u.shinies.length + ' &middot; WINS ' + u.battleWins + '</div>' +
        '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
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
  load();
  setInterval(load, 30000);
</script>
</body>
</html>`;
