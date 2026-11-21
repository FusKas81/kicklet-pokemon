// pokedex-site.js
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
            return {
              name,
              totalCaught: u.totalCaught !== undefined ? u.totalCaught : inv.length,
              battleWins: u.battleWins || 0,
              pokedex: dex.slice().sort((a, b) => a - b),
              party: inv.map((p) => ({ id: p.id, name: p.name, shiny: Boolean(p.isShiny), level: p.level || 50 }))
            };
          })
          .filter((u) => u.totalCaught > 0 || u.pokedex.length > 0 || u.party.length > 0)
          .sort((a, b) => b.pokedex.length - a.pokedex.length || b.totalCaught - a.totalCaught);
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

// NOTE: plain template string. Do not use backticks or dollar-brace inside the script.
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
  .chip { font-size:8px; background:#7c3aed; color:#fff; padding:5px 8px; border-radius:4px; cursor:pointer; border:0; font-family:inherit; }
  .chip[hidden] { display:none; }

  #field { position:relative; height:440px; overflow:hidden; border:6px solid var(--line); border-radius:12px;
    background:
      radial-gradient(circle at 20% 30%, rgba(255,255,255,.05) 0 40px, transparent 41px),
      radial-gradient(circle at 70% 70%, rgba(255,255,255,.05) 0 60px, transparent 61px),
      repeating-linear-gradient(90deg, #4c9a3c 0 40px, #53a342 40px 80px);
    box-shadow: inset 0 0 60px rgba(0,0,0,.35); }
  .walker { position:absolute; left:0; top:0; will-change:transform; cursor:pointer; }
  .walker img { display:block; image-rendering:pixelated; height:64px; width:auto; transition:transform .15s; }
  .walker .tag { position:absolute; left:50%; bottom:-14px; transform:translateX(-50%); font-size:7px; white-space:nowrap;
    background:rgba(0,0,0,.75); padding:3px 5px; border-radius:3px; opacity:0; pointer-events:none; transition:opacity .15s; }
  .walker:hover .tag, .walker.pinned .tag { opacity:1; }
  .walker:hover { z-index:9999 !important; }
  .walker.shiny::after { content:'✨'; position:absolute; right:-6px; top:-8px; font-size:12px; }
  #field-empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; font-size:10px; color:#fff; text-shadow:2px 2px 0 #000; text-align:center; padding:20px; }
  .note { font-size:8px; color:var(--mute); margin-top:8px; }

  #search { width:100%; max-width:340px; background:var(--panel); border:4px solid var(--line); color:var(--ink); font-family:inherit; font-size:10px; padding:10px; border-radius:6px; outline:none; }
  #trainers { display:grid; grid-template-columns:repeat(auto-fill, minmax(420px, 1fr)); gap:14px; }
  @media (max-width:520px) { #trainers { grid-template-columns:1fr; } }
  .card { background:var(--panel); border:5px solid var(--line); border-radius:12px; padding:14px; }
  .card.sel { border-color:var(--gold); }
  .card-head { display:flex; justify-content:space-between; gap:10px; align-items:flex-start; cursor:pointer; }
  .tname { font-size:11px; word-break:break-all; }
  .rank { color:var(--gold); }
  .meta { font-size:8px; color:var(--mute); margin-top:6px; line-height:1.9; }
  .bar { height:10px; background:#0b0c12; border-radius:5px; overflow:hidden; margin:10px 0; border:2px solid #0b0c12; }
  .bar > i { display:block; height:100%; background:var(--green); }
  .grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(44px, 1fr)); gap:3px; max-height:290px; overflow-y:auto; padding:4px; background:#0f101a; border-radius:8px; }
  .cell { position:relative; aspect-ratio:1; background:var(--panel2); border-radius:6px; display:flex; align-items:center; justify-content:center; }
  .cell img { width:100%; height:100%; image-rendering:pixelated; object-fit:contain; }
  .cell.no img { filter:brightness(0); opacity:.35; }
  .cell.no { opacity:.6; }
  .cell.held { outline:2px solid var(--gold); }
  .cell .n { position:absolute; left:2px; top:1px; font-size:5px; color:#cbd5e1; }
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
  <h2><span id="field-title">THE FIELD</span> <button class="chip" id="clear" hidden>SHOW EVERYONE</button></h2>
  <div id="field"><div id="field-empty">LOADING...</div></div>
  <div class="note" id="field-note"></div>
</section>

<section>
  <h2><span>TRAINERS</span> <input id="search" placeholder="search trainer..."></h2>
  <div id="trainers"></div>
</section>

<script>
  var BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
  var MAX_WALKERS = 220;
  var data = null, lastJson = '', selected = null, walkers = [];

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;'); }
  function gif(id, shiny) { return BASE + '/versions/generation-v/black-white/animated/' + (shiny ? 'shiny/' : '') + id + '.gif'; }
  function png(id, shiny) { return BASE + (shiny ? '/shiny' : '') + '/' + id + '.png'; }
  function fallback(img, id, shiny) { img.onerror = function () { img.onerror = null; img.src = png(id, shiny); }; }

  function renderStats() {
    var trainers = data.users.length, caught = 0, species = {}, shinies = 0;
    data.users.forEach(function (u) {
      caught += u.totalCaught;
      u.pokedex.forEach(function (id) { species[id] = 1; });
      u.party.forEach(function (p) { if (p.shiny) shinies++; });
    });
    var items = [
      [trainers, 'TRAINERS'],
      [caught, 'TOTAL CAUGHT'],
      [Object.keys(species).length + '/' + data.max, 'SPECIES FOUND'],
      [shinies, 'SHINIES HELD']
    ];
    $('stats').innerHTML = items.map(function (i) { return '<div class="stat"><b>' + i[0] + '</b>' + i[1] + '</div>'; }).join('');
  }

  function fieldSize() { var f = $('field'); return { w: f.clientWidth, h: f.clientHeight }; }

  function buildField() {
    var f = $('field');
    walkers.forEach(function (w) { w.el.remove(); });
    walkers = [];
    var list = [];
    data.users.forEach(function (u) {
      if (selected && u.name !== selected) return;
      u.party.forEach(function (p) { list.push({ user: u.name, p: p }); });
    });
    var total = list.length;
    for (var i = list.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = list[i]; list[i] = list[j]; list[j] = t; }
    list = list.slice(0, MAX_WALKERS);

    $('field-empty').style.display = list.length ? 'none' : 'flex';
    $('field-empty').textContent = selected ? '@' + selected + ' has no Pokémon right now.' : 'NO POKÉMON CAUGHT YET. WAIT FOR A SPAWN!';
    $('field-title').textContent = selected ? '@' + selected.toUpperCase() + "'S POKÉMON" : 'THE FIELD';
    $('clear').hidden = !selected;
    $('field-note').textContent = total > MAX_WALKERS ? 'Showing ' + MAX_WALKERS + ' of ' + total + ' Pokémon (random pick, refreshes on reload). Click a trainer below to see just theirs.' : (total ? total + ' Pokémon wandering. Hover one to see its trainer!' : '');

    var s = fieldSize();
    list.forEach(function (it) {
      var el = document.createElement('div');
      el.className = 'walker' + (it.p.shiny ? ' shiny' : '');
      var img = document.createElement('img');
      img.alt = it.p.name;
      fallback(img, it.p.id, it.p.shiny);
      img.src = gif(it.p.id, it.p.shiny);
      var tag = document.createElement('div');
      tag.className = 'tag';
      tag.textContent = (it.p.shiny ? '✨' : '') + it.p.name + ' Lv' + it.p.level + ' - @' + it.user;
      el.appendChild(img); el.appendChild(tag);
      el.onclick = function () { selectTrainer(it.user); };
      f.appendChild(el);
      var w = {
        el: el, img: img,
        x: Math.random() * Math.max(10, s.w - 80), y: 20 + Math.random() * Math.max(10, s.h - 110),
        vx: 0, vy: 0, wait: Math.random() * 80, flip: false,
        speed: 0.3 + Math.random() * 0.7
      };
      pickDirection(w);
      walkers.push(w);
    });
  }

  function pickDirection(w) {
    if (Math.random() < 0.3) { w.vx = 0; w.vy = 0; w.wait = 40 + Math.random() * 160; return; }
    var a = Math.random() * Math.PI * 2;
    w.vx = Math.cos(a) * w.speed; w.vy = Math.sin(a) * w.speed * 0.6;
    w.wait = 80 + Math.random() * 260;
    if (Math.abs(w.vx) > 0.05) { w.flip = w.vx > 0; w.img.style.transform = w.flip ? 'scaleX(-1)' : 'none'; }
  }

  function loop() {
    var s = fieldSize();
    for (var i = 0; i < walkers.length; i++) {
      var w = walkers[i];
      w.wait--;
      if (w.wait <= 0) pickDirection(w);
      w.x += w.vx; w.y += w.vy;
      var maxX = s.w - 70, maxY = s.h - 70;
      if (w.x < 0) { w.x = 0; w.vx = Math.abs(w.vx); w.flip = true; w.img.style.transform = 'scaleX(-1)'; }
      if (w.x > maxX) { w.x = maxX; w.vx = -Math.abs(w.vx); w.flip = false; w.img.style.transform = 'none'; }
      if (w.y < 4) { w.y = 4; w.vy = Math.abs(w.vy); }
      if (w.y > maxY) { w.y = maxY; w.vy = -Math.abs(w.vy); }
      w.el.style.transform = 'translate3d(' + w.x.toFixed(1) + 'px,' + w.y.toFixed(1) + 'px,0)';
      w.el.style.zIndex = Math.floor(w.y);
    }
    requestAnimationFrame(loop);
  }

  function renderTrainers() {
    var q = $('search').value.trim().toLowerCase();
    var users = data.users.filter(function (u) { return !q || u.name.indexOf(q) !== -1; });
    if (!users.length) { $('trainers').innerHTML = '<div class="empty">' + (data.users.length ? 'NO TRAINER FOUND' : 'NOBODY HAS CAUGHT A POKÉMON YET!') + '</div>'; return; }

    $('trainers').innerHTML = users.map(function (u) {
      var rank = data.users.indexOf(u) + 1;
      var pct = Math.min(100, (u.pokedex.length / data.max) * 100);
      var dex = {}; u.pokedex.forEach(function (id) { dex[id] = 1; });
      var held = {}, shiny = {};
      u.party.forEach(function (p) { held[p.id] = 1; if (p.shiny) shiny[p.id] = 1; });
      var cells = data.species.map(function (sp) {
        var has = dex[sp.id] || held[sp.id];
        var cls = 'cell' + (has ? '' : ' no') + (held[sp.id] ? ' held' : '');
        var title = has ? sp.name + (held[sp.id] ? ' (in party)' : ' (caught before)') : '???';
        return '<div class="' + cls + '" title="' + esc(title) + '"><span class="n">' + sp.id + '</span><img loading="lazy" src="' + png(sp.id, shiny[sp.id]) + '" alt=""></div>';
      }).join('');
      return '<div class="card' + (selected === u.name ? ' sel' : '') + '">' +
        '<div class="card-head" data-user="' + esc(u.name) + '"><div><div class="tname"><span class="rank">#' + rank + '</span> @' + esc(u.name) + '</div>' +
        '<div class="meta">POKÉDEX ' + u.pokedex.length + '/' + data.max + ' &middot; CAUGHT ' + u.totalCaught + ' &middot; PARTY ' + u.party.length + ' &middot; WINS ' + u.battleWins + '</div></div></div>' +
        '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
        '<div class="grid">' + cells + '</div></div>';
    }).join('');

    Array.prototype.forEach.call(document.querySelectorAll('.card-head'), function (h) {
      h.onclick = function () { selectTrainer(h.getAttribute('data-user')); };
    });
  }

  function selectTrainer(name) {
    selected = (selected === name) ? null : name;
    buildField();
    renderTrainers();
    if (selected) $('field').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  async function load() {
    try {
      var res = await fetch('/api/pokedex');
      var d = await res.json();
      var json = JSON.stringify([d.users, d.max]);
      var first = !data;
      data = d;
      if (first || json !== lastJson) {
        lastJson = json;
        renderStats();
        buildField();
        renderTrainers();
      }
    } catch (e) {
      if (!data) $('field-empty').textContent = 'COULD NOT LOAD DATA. TRY AGAIN SOON.';
    }
  }

  $('clear').onclick = function () { selected = null; buildField(); renderTrainers(); };
  $('search').oninput = function () { if (data) renderTrainers(); };
  load();
  setInterval(load, 30000);
  requestAnimationFrame(loop);
</script>
</body>
</html>`;
