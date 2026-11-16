import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';
import crypto from 'crypto';

const app = express();
app.use(express.json());

if (!process.env.MONGO_URI) {
  console.error('❌ ERROR: MONGO_URI is missing in Render!');
} else {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB!'))
    .catch(err => console.error('❌ MongoDB Error:', err.message));
}

const StateSchema = new mongoose.Schema({
  _id: String,
  users: { type: Object, default: {} },
  activeSpawn: { type: Object, default: null },
  pendingTrades: { type: Object, default: {} },
  activeBattles: { type: Object, default: {} },
  kickAuth: { type: Object, default: null }
}, { minimize: false });

const GameState = mongoose.model('GameState', StateSchema);

async function getDB() {
  let doc = await GameState.findById('main');
  if (!doc) doc = await GameState.create({ _id: 'main' });
  return doc;
}

async function saveDB(doc) {
  doc.markModified('users');
  doc.markModified('activeSpawn');
  doc.markModified('pendingTrades');
  doc.markModified('activeBattles');
  doc.markModified('kickAuth');
  await doc.save();
}

const POKEAPI = 'https://pokeapi.co/api/v2';
const MAX_POKEMON_ID = 1025;
const MAX_INVENTORY = 10;
const REDIRECT_URI = 'https://kicklet-pokemon.onrender.com/kick-callback';

// Store temporary PKCE verifier in memory during login
let tempPkceVerifier = null;

function checkSecret(req, res, next) {
  if (process.env.BOT_SECRET && req.query.secret !== process.env.BOT_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

// --- KICK OFFICIAL API & PKCE OAUTH HELPERS ---
async function getKickAccessToken(db) {
  if (!db.kickAuth || !db.kickAuth.refresh_token) return null;

  if (Date.now() > (db.kickAuth.expires_at - 120000)) {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.KICK_CLIENT_ID,
      client_secret: process.env.KICK_CLIENT_SECRET,
      refresh_token: db.kickAuth.refresh_token
    });
    const { data } = await axios.post('https://id.kick.com/oauth/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });
    db.kickAuth = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000
    };
    await saveDB(db);
  }
  return db.kickAuth.access_token;
}

async function sendKickChat(db, content) {
  try {
    const token = await getKickAccessToken(db);
    if (!token || !process.env.KICK_BROADCASTER_ID) return;

    await axios.post(
      'https://api.kick.com/public/v1/chat',
      {
        broadcaster_user_id: Number(process.env.KICK_BROADCASTER_ID),
        content: content.slice(0, 500),
        type: 'bot'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (err) {
    console.error('❌ Kick Chat Error:', err.response?.data || err.message);
  }
}

async function subscribeKickChatWebhook(token) {
  try {
    await axios.post(
      'https://api.kick.com/public/v1/events/subscriptions',
      {
        broadcaster_user_id: Number(process.env.KICK_BROADCASTER_ID),
        events: [{ name: 'chat.message.sent', version: 1 }],
        method: 'webhook'
      },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    console.log('✅ Subscribed to Kick chat.message.sent webhook!');
  } catch (err) {
    console.error('⚠️ Webhook subscription notice:', err.response?.data || err.message);
  }
}

// Step A: Visit /kick-login?secret=mysecret99 once to authorize
app.get('/kick-login', checkSecret, (req, res) => {
  tempPkceVerifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(tempPkceVerifier).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl =
    `https://id.kick.com/oauth/authorize?response_type=code` +
    `&client_id=${process.env.KICK_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&scope=${encodeURIComponent('chat:write user:read events:subscribe')}` +
    `&code_challenge=${challenge}` +
    `&code_challenge_method=S256` +
    `&state=${state}`;

  res.redirect(authUrl);
});

// Step B: Kick redirects back here with the authorization code
app.get('/kick-callback', async (req, res) => {
  try {
    const code = req.query.code;
    if (!code || !tempPkceVerifier) {
      return res.send('❌ Missing code or session expired. Open /kick-login?secret=mysecret99 again.');
    }

    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: process.env.KICK_CLIENT_ID,
      client_secret: process.env.KICK_CLIENT_SECRET,
      redirect_uri: REDIRECT_URI,
      code_verifier: tempPkceVerifier,
      code
    });

    const { data } = await axios.post('https://id.kick.com/oauth/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const db = await getDB();
    db.kickAuth = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000
    };
    await saveDB(db);
    await subscribeKickChatWebhook(data.access_token);

    res.send('✅ Kick connected! Your Pokémon bot is now listening to chat and posting directly.');
  } catch (err) {
    console.error('❌ OAuth Callback Error:', err.response?.data || err.message);
    res.send('❌ Kick login failed: ' + JSON.stringify(err.response?.data || err.message));
  }
});

// --- POKÉMON GAME LOGIC ---
const TYPE_CHART = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  electric: { water: 2, electric: 0.5, grass: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground: { fire: 2, electric: 2, grass: 0.5, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying: { electric: 0.5, grass: 2, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
};

function getTypeEffectiveness(moveType, defenderTypes) {
  let multiplier = 1;
  for (const defType of defenderTypes) {
    const chart = TYPE_CHART[moveType] || {};
    if (chart[defType] !== undefined) multiplier *= chart[defType];
  }
  return multiplier;
}

async function generatePokemon(idOrName, forceShiny = null) {
  const { data } = await axios.get(`${POKEAPI}/pokemon/${idOrName.toString().toLowerCase()}`);
  const types = data.types.map(t => t.type.name);
  const stats = {};
  data.stats.forEach(s => { stats[s.stat.name] = s.base_stat; });

  const isShiny = forceShiny !== null ? forceShiny : Math.random() < (1 / 50);
  const shuffledMoves = data.moves.sort(() => 0.5 - Math.random());
  const selectedMoves = [];

  for (const m of shuffledMoves) {
    if (selectedMoves.length >= 4) break;
    try {
      const moveRes = await axios.get(m.move.url);
      const md = moveRes.data;
      if (md.power && md.power > 0) {
        selectedMoves.push({
          name: md.name,
          type: md.type.name,
          power: md.power,
          accuracy: md.accuracy || 100
        });
      }
    } catch (e) {}
  }

  if (selectedMoves.length === 0) {
    selectedMoves.push({ name: 'struggle', type: 'normal', power: 50, accuracy: 100 });
  }

  return {
    uid: Math.random().toString(36).substring(2, 8).toUpperCase(),
    id: data.id,
    name: data.name.toUpperCase(),
    isShiny,
    types,
    hp: stats.hp * 2 + 50,
    maxHp: stats.hp * 2 + 50,
    atk: Math.max(stats.attack, stats['special-attack']),
    def: Math.max(stats.defense, stats['special-defense']),
    moves: selectedMoves
  };
}

async function checkEvolution(db, user) {
  const inv = db.users[user].inventory;
  const counts = {};
  inv.forEach(p => {
    const key = `${p.name}|${p.isShiny ? '1' : '0'}`;
    counts[key] = (counts[key] || 0) + 1;
  });

  for (const [key, count] of Object.entries(counts)) {
    if (count >= 3) {
      const [pokeName, shinyFlag] = key.split('|');
      const isShinyGroup = shinyFlag === '1';
      const sample = inv.find(p => p.name === pokeName && Boolean(p.isShiny) === isShinyGroup);

      const speciesRes = await axios.get(`${POKEAPI}/pokemon-species/${sample.id}`);
      const evoChainRes = await axios.get(speciesRes.data.evolution_chain.url);

      let nextSpecies = null;
      function findNext(node) {
        if (node.species.name.toUpperCase() === pokeName && node.evolves_to.length > 0) {
          const branch = node.evolves_to[Math.floor(Math.random() * node.evolves_to.length)];
          nextSpecies = branch.species.name;
          return;
        }
        node.evolves_to.forEach(findNext);
      }
      findNext(evoChainRes.data.chain);

      if (nextSpecies) {
        let removed = 0;
        db.users[user].inventory = inv.filter(p => {
          if (p.name === pokeName && Boolean(p.isShiny) === isShinyGroup && removed < 3) {
            removed++;
            return false;
          }
          return true;
        });

        const evolvedMon = await generatePokemon(nextSpecies, isShinyGroup);
        db.users[user].inventory.push(evolvedMon);
        if (!db.users[user].pokedex.includes(evolvedMon.id)) {
          db.users[user].pokedex.push(evolvedMon.id);
        }
        await saveDB(db);

        const shinyTag = isShinyGroup ? '✨SHINY ' : '';
        return `🌟 EVOLUTION! @${user}'s three ${shinyTag}${pokeName} merged into ${shinyTag}${evolvedMon.name}!`;
      }
    }
  }
  return null;
}

async function triggerSpawn(db) {
  const randomId = Math.floor(Math.random() * MAX_POKEMON_ID) + 1;
  const mon = await generatePokemon(randomId);
  db.activeSpawn = { ...mon, caughtBy: [], spawnedAt: Date.now() };
  await saveDB(db);

  const shinyTag = mon.isShiny ? '✨SHINY ' : '';
  return `🌿 A wild ${shinyTag}${mon.name} (${mon.types.join('/').toUpperCase()}) appeared! Type !catch to throw a Pokéball!`;
}

async function processCommand(db, rawUser, rawCmd, rawArgs, isMod = false) {
  const user = (rawUser || '').toLowerCase().replace('@', '');
  const cmd = (rawCmd || '').toLowerCase();
  const args = (rawArgs || '').trim().split(/\s+/).filter(Boolean);

  if (!user) return null;
  if (!db.users[user]) db.users[user] = { inventory: [], totalCaught: 0, pokedex: [] };
  if (db.users[user].totalCaught === undefined) db.users[user].totalCaught = db.users[user].inventory.length;
  if (!db.users[user].pokedex) db.users[user].pokedex = [...new Set(db.users[user].inventory.map(p => p.id))];

  if (cmd === 'spawn') {
    if (!isMod) return `@${user} Only moderators can use !spawn.`;
    return await triggerSpawn(db);
  }

  if (cmd === 'catch') {
    const spawn = db.activeSpawn;
    if (!spawn) return `@${user} No wild Pokémon right now!`;
    if (spawn.caughtBy.includes(user)) return `@${user} You already caught this ${spawn.name}!`;
    if (db.users[user].inventory.length >= MAX_INVENTORY) return `@${user} Party full (10/10)! Use !release <1-10>.`;
    if (Math.random() > 0.65) return `@${user} The wild ${spawn.name} broke free!`;

    const caughtMon = await generatePokemon(spawn.id, spawn.isShiny);
    db.users[user].inventory.push(caughtMon);
    db.users[user].totalCaught += 1;
    if (!db.users[user].pokedex.includes(caughtMon.id)) db.users[user].pokedex.push(caughtMon.id);
    spawn.caughtBy.push(user);
    await saveDB(db);

    const shinyTag = caughtMon.isShiny ? '✨SHINY ' : '';
    let reply = `🎉 @${user} caught ${shinyTag}${caughtMon.name} [${caughtMon.types.join('/')}]! (${db.users[user].inventory.length}/10)`;
    const evoMsg = await checkEvolution(db, user);
    if (evoMsg) reply += ` | ${evoMsg}`;
    return reply;
  }

  if (cmd === 'spawncheck' || cmd === 'wild') {
    const spawn = db.activeSpawn;
    if (!spawn) return `@${user} No wild Pokémon right now!`;
    spawn.spawnedAt = Date.now();
    await saveDB(db);
    const shinyTag = spawn.isShiny ? '✨SHINY ' : '';
    const status = spawn.caughtBy.includes(user) ? 'Already caught!' : 'Type !catch to throw a Pokéball!';
    return `🌿 Active Spawn: ${shinyTag}${spawn.name} (${spawn.types.join('/').toUpperCase()}) — ${status}`;
  }

  if (cmd === 'party') {
    const inv = db.users[user].inventory;
    if (inv.length === 0) return `@${user} Your party is empty!`;
    const list = inv.map((p, i) => `[${i + 1}] ${p.isShiny ? '✨' : ''}${p.name}`).join(' | ');
    return `@${user}'s Party (${inv.length}/10): ${list}`;
  }

  if (cmd === 'info') {
    const slot = parseInt(args[0]) - 1;
    const mon = db.users[user].inventory[slot];
    if (!mon) return `@${user} Use !info <1-10>.`;
    const shinyTag = mon.isShiny ? '✨SHINY ' : '';
    const movesStr = mon.moves.map((m, i) => `${i + 1}:${m.name}(${m.type}/${m.power}pwr)`).join(', ');
    return `@${user} #${slot + 1} ${shinyTag}${mon.name} | HP:${mon.maxHp} | Moves: ${movesStr}`;
  }

  if (cmd === 'release') {
    const slot = parseInt(args[0]) - 1;
    const inv = db.users[user].inventory;
    if (!inv[slot]) return `@${user} Use !release <1-10>.`;
    const released = inv.splice(slot, 1)[0];
    await saveDB(db);
    return `@${user} Released ${released.name}.`;
  }

  if (cmd === 'pokedex') {
    const uniqueCount = db.users[user].pokedex.length;
    const totalCaught = db.users[user].totalCaught;
    const percent = ((uniqueCount / MAX_POKEMON_ID) * 100).toFixed(1);
    return `📖 @${user}'s Pokédex: ${uniqueCount}/${MAX_POKEMON_ID} unique species (${percent}%) | Total Caught: ${totalCaught}`;
  }

  if (cmd === 'leaderboard') {
    const rankings = Object.entries(db.users)
      .map(([name, data]) => ({ name, caught: data.totalCaught ?? data.inventory.length }))
      .filter(entry => entry.caught > 0)
      .sort((a, b) => b.caught - a.caught)
      .slice(0, 5);

    if (rankings.length === 0) return '🏆 Nobody has caught any Pokémon yet! Be the first with !catch!';
    const board = rankings.map((entry, idx) => `#${idx + 1} @${entry.name} (${entry.caught})`).join(' | ');
    return `🏆 Top Pokémon Trainers: ${board}`;
  }

  if (cmd === 'trade') {
    const target = (args[0] || '').toLowerCase().replace('@', '');
    const slot = parseInt(args[1]) - 1;
    const mon = db.users[user].inventory[slot];
    if (!target || !db.users[target]) return `@${user} User not found.`;
    if (target === user) return `@${user} Can't trade with yourself!`;
    if (!mon) return `@${user} Usage: !trade @user <slot>`;

    db.pendingTrades[target] = { fromUser: user, offeredUid: mon.uid, offeredName: mon.name };
    await saveDB(db);
    return `🔄 @${user} wants to trade ${mon.isShiny ? '✨' : ''}${mon.name} to @${target}! Type !accept <yourSlot> to accept.`;
  }

  if (cmd === 'accept') {
    const trade = db.pendingTrades[user];
    if (!trade) return `@${user} No pending trades.`;
    const mySlot = parseInt(args[0]) - 1;
    const myInv = db.users[user].inventory;
    const senderInv = db.users[trade.fromUser].inventory;
    const myMon = myInv[mySlot];
    const senderIndex = senderInv.findIndex(p => p.uid === trade.offeredUid);

    if (!myMon || senderIndex === -1) {
      delete db.pendingTrades[user];
      await saveDB(db);
      return `@${user} Trade failed.`;
    }

    const senderMon = senderInv[senderIndex];
    senderInv[senderIndex] = myMon;
    myInv[mySlot] = senderMon;
    delete db.pendingTrades[user];

    if (!db.users[user].pokedex.includes(senderMon.id)) db.users[user].pokedex.push(senderMon.id);
    if (!db.users[trade.fromUser].pokedex) db.users[trade.fromUser].pokedex = [];
    if (!db.users[trade.fromUser].pokedex.includes(myMon.id)) db.users[trade.fromUser].pokedex.push(myMon.id);

    await saveDB(db);

    let reply = `🤝 Trade done! @${trade.fromUser} got ${myMon.name} & @${user} got ${senderMon.name}!`;
    const evo1 = await checkEvolution(db, user);
    const evo2 = await checkEvolution(db, trade.fromUser);
    if (evo1) reply += ` | ${evo1}`;
    if (evo2) reply += ` | ${evo2}`;
    return reply;
  }

  if (cmd === 'battle') {
    const opponent = (args[0] || '').toLowerCase().replace('@', '');
    const slot = parseInt(args[1]) - 1;
    const myMon = db.users[user].inventory[slot];
    if (!opponent || !db.users[opponent]) return `@${user} Opponent not found.`;
    if (!myMon) return `@${user} Usage: !battle @user <slot>`;

    const battleKey = [user, opponent].sort().join('_vs_');
    let battle = db.activeBattles[battleKey];

    if (!battle) {
      db.activeBattles[battleKey] = {
        p1: user,
        p2: opponent,
        p1Mon: { ...myMon, currentHp: myMon.maxHp },
        p2Mon: null,
        turn: user,
        lastLog: `@${user} challenged @${opponent}!`
      };
      await saveDB(db);
      return `⚔️ @${user} challenged @${opponent} with ${myMon.name}! @${opponent}, type !battle @${user} <slot> to accept!`;
    } else if (battle.p2 === user && !battle.p2Mon) {
      battle.p2Mon = { ...myMon, currentHp: myMon.maxHp };
      battle.lastLog = `What will ${battle.p1Mon.name} do?`;
      await saveDB(db);
      return `🔥 Battle started! ${battle.p1Mon.name} vs ${battle.p2Mon.name}! @${battle.turn}, use !move <1-4>!`;
    }
    return `@${user} Battle already active! Use !move <1-4>.`;
  }

  if (cmd === 'move') {
    const moveIdx = parseInt(args[0]) - 1;
    const battleKey = Object.keys(db.activeBattles).find(k => k.includes(user));
    const battle = db.activeBattles[battleKey];
    if (!battle || !battle.p2Mon) return `@${user} Not in a battle.`;
    if (battle.turn !== user) return `@${user} Not your turn!`;

    const isP1 = battle.p1 === user;
    const attacker = isP1 ? battle.p1Mon : battle.p2Mon;
    const defender = isP1 ? battle.p2Mon : battle.p1Mon;
    const opponentUser = isP1 ? battle.p2 : battle.p1;
    const move = attacker.moves[moveIdx];
    if (!move) return `@${user} Pick move 1-4.`;

    if (Math.random() * 100 > move.accuracy) {
      battle.turn = opponentUser;
      battle.lastLog = `${attacker.name} used ${move.name.toUpperCase()}... missed!`;
      await saveDB(db);
      return `💨 ${attacker.name} used ${move.name}, but missed! @${opponentUser}'s turn.`;
    }

    const stab = attacker.types.includes(move.type) ? 1.5 : 1.0;
    const effectiveness = getTypeEffectiveness(move.type, defender.types);
    const rawDamage = (((2 * 50 / 5 + 2) * move.power * (attacker.atk / defender.def)) / 50 + 2);
    const finalDamage = Math.max(1, Math.floor(rawDamage * stab * effectiveness * (0.85 + Math.random() * 0.15)));
    defender.currentHp = Math.max(0, defender.currentHp - finalDamage);

    let effText = effectiveness > 1 ? ' Super effective!' : (effectiveness === 0 ? ' No effect!' : (effectiveness < 1 ? ' Not very effective...' : ''));

    if (defender.currentHp === 0) {
      delete db.activeBattles[battleKey];
      await saveDB(db);
      return `💥 ${attacker.name} used ${move.name} (-${finalDamage} HP)!${effText} ${defender.name} fainted! 🏆 @${user} wins!`;
    }

    battle.turn = opponentUser;
    battle.lastLog = `${attacker.name} used ${move.name.toUpperCase()}!${effText}`;
    await saveDB(db);
    return `⚔️ ${attacker.name} used ${move.name} (-${finalDamage} HP)!${effText} ${defender.name} (${defender.currentHp}/${defender.maxHp} HP). @${opponentUser}'s turn!`;
  }

  if (cmd === 'forfeit') {
    const battleKey = Object.keys(db.activeBattles).find(k => k.split('_vs_').includes(user));
    if (!battleKey) return `@${user} Not in a battle.`;
    const battle = db.activeBattles[battleKey];
    const opponent = battle.p1 === user ? battle.p2 : battle.p1;
    const wasAccepted = Boolean(battle.p2Mon);
    delete db.activeBattles[battleKey];
    await saveDB(db);
    return wasAccepted ? `🏳️ @${user} forfeited! 🏆 @${opponent} wins!` : `🏳️ @${user} canceled the challenge.`;
  }

  if (cmd === 'help' || cmd === 'pokemon') {
    return '🎮 Commands: !catch | !spawncheck | !party | !info <1-10> | !release <1-10> | !pokedex | !leaderboard | !trade @user <slot> & !accept <slot> | !battle @user <slot>, !move <1-4>, !forfeit';
  }

  return null;
}

// --- ROUTES ---
app.get('/ping', (req, res) => res.send('Bot is awake!'));

// Triggered every 15 mins by cron-job.org (posts directly to Kick chat + OBS)
app.get('/spawn', checkSecret, async (req, res) => {
  try {
    const db = await getDB();
    const msg = await triggerSpawn(db);
    await sendKickChat(db, msg);
    res.send(msg);
  } catch (err) {
    console.error(err);
    res.send('⚠️ Spawn error.');
  }
});

// Direct Kick Webhook Receiver (Listens to Kick chat messages)
app.post('/kick-webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge Kick immediately
  try {
    const eventType = req.headers['kick-event-type'];
    if (eventType !== 'chat.message.sent') return;

    const payload = req.body;
    const content = (payload.content || '').trim();
    if (!content.startsWith('!')) return;

    const sender = payload.sender?.username || payload.sender?.slug;
    const badges = payload.sender?.identity?.badges || [];
    const isMod = badges.some(b => b.type === 'moderator' || b.type === 'broadcaster') ||
                  String(payload.sender?.user_id) === String(process.env.KICK_BROADCASTER_ID);

    const parts = content.slice(1).split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1).join(' ');

    const validCmds = ['spawn', 'catch', 'spawncheck', 'wild', 'party', 'info', 'release', 'pokedex', 'leaderboard', 'trade', 'accept', 'battle', 'move', 'forfeit', 'help', 'pokemon'];
    if (!validCmds.includes(cmd.toLowerCase())) return;

    const db = await getDB();
    const reply = await processCommand(db, sender, cmd, args, isMod);
    if (reply) await sendKickChat(db, reply);
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
  }
});

// Live JSON data for OBS Overlay
app.get('/battle-data', async (req, res) => {
  try {
    const db = await getDB();
    const keys = Object.keys(db.activeBattles || {});
    const activeKey = keys.find(k => db.activeBattles[k].p2Mon) || keys[0];
    res.json({
      active: Boolean(activeKey),
      battle: activeKey ? db.activeBattles[activeKey] : null,
      spawn: db.activeSpawn || null
    });
  } catch (e) {
    res.json({ active: false, battle: null, spawn: null });
  }
});

// Game Boy Color OBS Overlay Page
app.get('/overlay', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: transparent; font-family: 'Press Start 2P', monospace; overflow: hidden; display: flex; justify-content: center; align-items: center; height: 100vh; }
    #spawn-card, #gbc-frame { display: none; background: #2b2d42; border: 6px solid #1a1b26; border-radius: 16px 16px 40px 16px; padding: 18px 22px 24px; box-shadow: 0 12px 30px rgba(0,0,0,0.8); }
    #spawn-card { width: 440px; }
    #gbc-frame { width: 680px; }
    #spawn-screen, #screen { background: #f8f8f8; border: 5px solid #111; border-radius: 6px; padding: 14px; color: #181818; }
    #spawn-screen { text-align: center; }
    .spawn-banner { background: #181818; color: #fff; font-size: 10px; padding: 6px; border-radius: 4px; margin-bottom: 10px; }
    .spawn-banner.shiny { background: #d97706; }
    .sprite { width: 136px; height: 136px; image-rendering: pixelated; object-fit: contain; }
    #spawn-name { font-size: 15px; margin: 8px 0; }
    #spawn-types { font-size: 10px; color: #555; margin-bottom: 12px; }
    .spawn-cta { border-top: 3px dashed #999; padding-top: 10px; font-size: 11px; color: #16a34a; }
    .row { display: flex; justify-content: space-between; align-items: center; }
    .hud-box { border: 4px solid #181818; border-radius: 4px; padding: 8px 10px; width: 290px; }
    .name { font-size: 13px; margin-bottom: 4px; }
    .trainer { font-size: 9px; color: #555; margin-bottom: 6px; }
    .hp-wrap { display: flex; align-items: center; gap: 6px; }
    .hp-label { font-size: 9px; color: #d97706; }
    .hp-bar-bg { flex: 1; height: 10px; background: #ccc; border: 2px solid #181818; }
    .hp-bar-fill { height: 100%; background: #22c55e; transition: width 0.4s ease; }
    .hp-num { font-size: 10px; text-align: right; margin-top: 5px; }
    #dialog-box { margin-top: 10px; border: 4px solid #181818; border-radius: 6px; padding: 12px; background: #fff; min-height: 112px; }
    #log-text { font-size: 11px; line-height: 1.6; margin-bottom: 10px; }
    #moves-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; border-top: 2px dashed #999; padding-top: 8px; }
    .move-item { font-size: 10px; }
    .brand { text-align: center; margin-top: 12px; font-size: 13px; letter-spacing: 2px; color: #8d99ae; }
    .brand span:nth-child(1) { color: #ef4444; } .brand span:nth-child(2) { color: #a855f7; } .brand span:nth-child(3) { color: #22c55e; } .brand span:nth-child(4) { color: #eab308; } .brand span:nth-child(5) { color: #3b82f6; }
  </style>
</head>
<body>
  <div id="spawn-card">
    <div id="spawn-screen">
      <div id="spawn-banner" class="spawn-banner">WILD POKÉMON APPEARED!</div>
      <img id="spawn-sprite" class="sprite" src="">
      <div id="spawn-name"></div>
      <div id="spawn-types"></div>
      <div class="spawn-cta">TYPE !catch IN CHAT!</div>
    </div>
    <div class="brand">GAME BOY <span>C</span><span>O</span><span>L</span><span>O</span><span>R</span></div>
  </div>

  <div id="gbc-frame">
    <div id="screen">
      <div class="row">
        <div class="hud-box">
          <div class="name" id="p2-name"></div>
          <div class="trainer" id="p2-user"></div>
          <div class="hp-wrap"><span class="hp-label">HP</span><div class="hp-bar-bg"><div class="hp-bar-fill" id="p2-hp-bar"></div></div></div>
          <div class="hp-num" id="p2-hp-text"></div>
        </div>
        <img id="p2-sprite" class="sprite" src="">
      </div>
      <div class="row" style="margin-top: 6px;">
        <img id="p1-sprite" class="sprite" src="">
        <div class="hud-box">
          <div class="name" id="p1-name"></div>
          <div class="trainer" id="p1-user"></div>
          <div class="hp-wrap"><span class="hp-label">HP</span><div class="hp-bar-bg"><div class="hp-bar-fill" id="p1-hp-bar"></div></div></div>
          <div class="hp-num" id="p1-hp-text"></div>
        </div>
      </div>
      <div id="dialog-box">
        <div id="log-text"></div>
        <div id="moves-grid"></div>
      </div>
    </div>
    <div class="brand">GAME BOY <span>C</span><span>O</span><span>L</span><span>O</span><span>R</span></div>
  </div>

  <script>
    function setSprite(img, mon, back) {
      if (!mon) return;
      const base = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
      const front = base + (mon.isShiny ? '/shiny/' : '/') + mon.id + '.png';
      const rear = base + (mon.isShiny ? '/back/shiny/' : '/back/') + mon.id + '.png';
      img.onerror = () => { if (img.src !== front) img.src = front; };
      img.src = back ? rear : front;
    }
    function setHp(el, cur, max) {
      const pct = Math.max(0, Math.min(100, (cur / max) * 100));
      el.style.width = pct + '%';
      el.style.background = pct > 50 ? '#22c55e' : (pct > 20 ? '#eab308' : '#ef4444');
    }
    async function tick() {
      try {
        const res = await fetch('/battle-data');
        const data = await res.json();
        const frame = document.getElementById('gbc-frame');
        const card = document.getElementById('spawn-card');

        if (data.active && data.battle) {
          card.style.display = 'none';
          frame.style.display = 'block';
          const b = data.battle;
          document.getElementById('p1-name').textContent = (b.p1Mon.isShiny ? '✨' : '') + b.p1Mon.name;
          document.getElementById('p1-user').textContent = '@' + b.p1;
          document.getElementById('p1-hp-text').textContent = b.p1Mon.currentHp + '/' + b.p1Mon.maxHp;
          setSprite(document.getElementById('p1-sprite'), b.p1Mon, true);
          setHp(document.getElementById('p1-hp-bar'), b.p1Mon.currentHp, b.p1Mon.maxHp);

          if (b.p2Mon) {
            document.getElementById('p2-name').textContent = (b.p2Mon.isShiny ? '✨' : '') + b.p2Mon.name;
            document.getElementById('p2-user').textContent = '@' + b.p2;
            document.getElementById('p2-hp-text').textContent = b.p2Mon.currentHp + '/' + b.p2Mon.maxHp;
            setSprite(document.getElementById('p2-sprite'), b.p2Mon, false);
            document.getElementById('p2-sprite').style.visibility = 'visible';
            setHp(document.getElementById('p2-hp-bar'), b.p2Mon.currentHp, b.p2Mon.maxHp);
          } else {
            document.getElementById('p2-name').textContent = 'WAITING...';
            document.getElementById('p2-user').textContent = '@' + b.p2;
            document.getElementById('p2-hp-text').textContent = '--/--';
            document.getElementById('p2-sprite').style.visibility = 'hidden';
          }
          const activeMon = (b.turn === b.p2 && b.p2Mon) ? b.p2Mon : b.p1Mon;
          document.getElementById('log-text').textContent = (b.lastLog || '') + ' (@' + b.turn + '\\'s turn: !move 1-4)';
          document.getElementById('moves-grid').innerHTML = activeMon.moves.map((m, i) => '<div class="move-item">!' + (i + 1) + ' ' + m.name.toUpperCase() + '</div>').join('');
          return;
        }

        frame.style.display = 'none';
        const s = data.spawn;
        if (s && s.spawnedAt && (Date.now() - s.spawnedAt) < 20000) {
          card.style.display = 'block';
          const banner = document.getElementById('spawn-banner');
          banner.textContent = s.isShiny ? '✨ RARE SHINY APPEARED! ✨' : 'WILD POKÉMON APPEARED!';
          banner.classList.toggle('shiny', Boolean(s.isShiny));
          setSprite(document.getElementById('spawn-sprite'), s, false);
          document.getElementById('spawn-name').textContent = (s.isShiny ? '✨' : '') + s.name;
          document.getElementById('spawn-types').textContent = 'TYPE: ' + s.types.join(' / ').toUpperCase();
        } else {
          card.style.display = 'none';
        }
      } catch (e) {}
    }
    setInterval(tick, 1500);
    tick();
  </script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Bot online on port ${PORT}!`));
