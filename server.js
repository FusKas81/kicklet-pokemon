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
  kickAuth: { type: Object, default: null },
  lastBattleResult: { type: Object, default: null }
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
  doc.markModified('lastBattleResult');
  await doc.save();
}

const POKEAPI = 'https://pokeapi.co/api/v2';
const MAX_POKEMON_ID = 151; // Generation 1 only (Bulbasaur #1 - Mew #151)
const MAX_INVENTORY = 10;
const MAX_CATCH_TRIES = 3; // !catch attempts per trainer for each spawn
const SPAWN_INTERVAL_MINUTES = 5;  // keep in sync with the cron-job.org schedule (only used in chat messages)
const CATCH_WINDOW_MS = 60 * 1000; // how long a spawned Pokémon can be caught (and stays on the overlay)

function spawnExpiresAt(spawn) {
  return spawn.expiresAt || (spawn.spawnedAt + CATCH_WINDOW_MS);
}
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
        type: 'user'
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

function speciesIdFromUrl(url) {
  return parseInt(url.split('/').filter(Boolean).pop(), 10);
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
          // Only allow evolutions that are still Generation 1
          const validBranches = node.evolves_to.filter(
            b => speciesIdFromUrl(b.species.url) <= MAX_POKEMON_ID
          );
          if (validBranches.length > 0) {
            const branch = validBranches[Math.floor(Math.random() * validBranches.length)];
            nextSpecies = branch.species.name;
          }
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

// Remember how the last battle ended so the OBS overlay can play the ending animation
function recordBattleEnd(db, battle, winner, reason, message) {
  db.lastBattleResult = {
    at: Date.now(),
    p1: battle.p1,
    p2: battle.p2,
    createdAt: battle.createdAt || 0,
    startedAt: battle.startedAt || 0,
    turnStartedAt: battle.turnStartedAt || 0,
    turn: battle.turn,
    p1Mon: battle.p1Mon,
    p2Mon: battle.p2Mon,
    lastLog: message,
    winner,
    reason,
    message
  };
}

// --- BATTLE TIMERS ---
const BATTLE_LIMIT_MS = 5 * 60 * 1000; // max battle length (and max wait for a challenge to be accepted)
const MOVE_LIMIT_MS = 30 * 1000;       // time each player has to use !move
const MOVE_LIMIT_SECS = MOVE_LIMIT_MS / 1000;
const BATTLE_RULES = `📜 Rules: a battle lasts max 5 min, and you have ${MOVE_LIMIT_SECS}s to !move or your turn is skipped!`;

// Applies time limits to one battle. Mutates db and returns a chat message, or null if nothing happened.
function applyBattleTimers(db, key, battle) {
  const now = Date.now();

  // Challenge that nobody accepted
  if (!battle.p2Mon) {
    if (!battle.createdAt) battle.createdAt = now;
    if (now - battle.createdAt > BATTLE_LIMIT_MS) {
      delete db.activeBattles[key];
      return `⏰ @${battle.p2} didn't accept in time, so @${battle.p1}'s challenge has expired.`;
    }
    return null;
  }

  if (!battle.startedAt) battle.startedAt = now;
  if (!battle.turnStartedAt) battle.turnStartedAt = now;

  // 5 minute battle limit: higher remaining HP% wins
  if (now - battle.startedAt > BATTLE_LIMIT_MS) {
    delete db.activeBattles[key];
    const p1Pct = battle.p1Mon.currentHp / battle.p1Mon.maxHp;
    const p2Pct = battle.p2Mon.currentHp / battle.p2Mon.maxHp;
    const p1Txt = `${battle.p1Mon.name} ${Math.round(p1Pct * 100)}%`;
    const p2Txt = `${battle.p2Mon.name} ${Math.round(p2Pct * 100)}%`;
    if (p1Pct === p2Pct) {
      recordBattleEnd(db, battle, null, 'time', "Time is up! It is a draw!");
      return `⏰ Time's up! The 5 minute limit is over (${p1Txt} vs ${p2Txt}). It's a draw between @${battle.p1} and @${battle.p2}!`;
    }
    const winner = p1Pct > p2Pct ? battle.p1 : battle.p2;
    recordBattleEnd(db, battle, winner, 'time', `Time is up! @${winner} wins on remaining HP!`);
    return `⏰ Time's up! The 5 minute limit is over (${p1Txt} vs ${p2Txt}). 🏆 @${winner} wins on remaining HP!`;
  }

  // 20 second move limit: skip the turn
  if (now - battle.turnStartedAt > MOVE_LIMIT_MS) {
    const late = battle.turn;
    const next = late === battle.p1 ? battle.p2 : battle.p1;
    battle.turn = next;
    battle.turnStartedAt = now;
    battle.lastLog = `@${late} ran out of time!`;
    return `⏰ @${late}, time has passed (${MOVE_LIMIT_SECS}s)! Your turn is skipped. @${next}, it's your turn, use !move <1-4> within ${MOVE_LIMIT_SECS} seconds!`;
  }

  return null;
}

// --- BATTLE COMMENTATOR ---
function pickLine(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function battleCommentary({ attacker, defender, damage = 0, effectiveness = 1, missed = false, fainted = false }) {
  if (missed) {
    return pickLine([
      `${defender.name} dodged it with ease!`,
      `What a whiff! ${attacker.name} hits nothing but air!`,
      `So close, yet so far!`
    ]);
  }
  if (fainted) {
    return pickLine([
      `And that's the match! What a finish!`,
      `Down goes ${defender.name}! Incredible battle, chat!`,
      `${defender.name} gave it everything, but it's over!`
    ]);
  }

  const hpPct = defender.currentHp / defender.maxHp;
  const bigHit = damage >= defender.maxHp * 0.35;

  if (hpPct <= 0.2) {
    return pickLine([
      `${defender.name} is hanging by a thread!`,
      `${defender.name} is almost out, one more hit could end it!`,
      `Danger zone! ${defender.name} is barely standing!`
    ]);
  }
  if (effectiveness === 0) return `It doesn't affect ${defender.name} at all... awkward!`;
  if (effectiveness > 1 && bigHit) return `A devastating, super effective blow! ${defender.name} is shaken!`;
  if (effectiveness > 1) return pickLine([`Right on the weakness, smart pick!`, `${attacker.name} found the weak spot!`]);
  if (bigHit) return pickLine([`That one really hurt!`, `Massive damage, chat, did you see that?!`]);
  if (effectiveness < 1) return pickLine([`${defender.name} shrugs it off.`, `Barely a scratch, that was a poor matchup.`]);
  if (hpPct <= 0.5) return `${defender.name} is below half health, the pressure is on!`;
  return pickLine([`Solid hit!`, `The battle is heating up!`, `Neither side is backing down!`]);
}

async function triggerSpawn(db) {
  const randomId = Math.floor(Math.random() * MAX_POKEMON_ID) + 1;
  const mon = await generatePokemon(randomId);
  const now = Date.now();
  db.activeSpawn = { ...mon, caughtBy: [], attempts: {}, spawnedAt: now, expiresAt: now + CATCH_WINDOW_MS };
  await saveDB(db);

  const shinyTag = mon.isShiny ? '✨SHINY ' : '';
  return `🌿 A wild ${shinyTag}${mon.name} (${mon.types.join('/').toUpperCase()}) appeared! Type !catch within ${CATCH_WINDOW_MS / 1000} seconds to throw a Pokéball! (${MAX_CATCH_TRIES} tries each)`;
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
    if (Date.now() > spawnExpiresAt(spawn)) return `@${user} Too late, the wild ${spawn.name} fled! Wait for the next spawn.`;
    if (spawn.caughtBy.includes(user)) return `@${user} You already caught this ${spawn.name}!`;
    if (db.users[user].inventory.length >= MAX_INVENTORY) return `@${user} Party full (10/10)! Use !release <1-10>.`;

    // Each trainer gets MAX_CATCH_TRIES attempts per spawn
    if (!spawn.attempts) spawn.attempts = {};
    const used = spawn.attempts[user] || 0;
    if (used >= MAX_CATCH_TRIES) return `@${user} You're out of tries for this ${spawn.name}! Wait for the next spawn.`;

    spawn.attempts[user] = used + 1;
    if (Math.random() > 0.65) {
      await saveDB(db);
      const left = MAX_CATCH_TRIES - spawn.attempts[user];
      return left > 0
        ? `@${user} The wild ${spawn.name} broke free! You have ${left} ${left === 1 ? 'try' : 'tries'} left (${spawn.attempts[user]}/${MAX_CATCH_TRIES} used).`
        : `@${user} The wild ${spawn.name} broke free and you're out of tries (${MAX_CATCH_TRIES}/${MAX_CATCH_TRIES} used)! Better luck on the next spawn.`;
    }

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
    if (!spawn || Date.now() > spawnExpiresAt(spawn)) return `@${user} No wild Pokémon right now!`;
    const secsLeft = Math.max(1, Math.ceil((spawnExpiresAt(spawn) - Date.now()) / 1000));
    const shinyTag = spawn.isShiny ? '✨SHINY ' : '';
    const triesLeft = MAX_CATCH_TRIES - ((spawn.attempts && spawn.attempts[user]) || 0);
    const status = spawn.caughtBy.includes(user)
      ? 'Already caught!'
      : (triesLeft <= 0 ? 'No tries left!' : `Type !catch to throw a Pokéball! (${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left, ${secsLeft}s remaining)`);
    return `🌿 Active Spawn: ${shinyTag}${spawn.name} (${spawn.types.join('/').toUpperCase()}) — ${status}`;
  }

  if (cmd === 'party') {
    const inv = db.users[user].inventory;
    if (inv.length === 0) return `@${user} Your party is empty! Use !catch when a wild Pokémon appears. 💡 Catch 3 of the same Pokémon and they evolve (if they have an evolution)!`;
    const list = inv.map((p, i) => `[${i + 1}] ${p.isShiny ? '✨' : ''}${p.name}`).join(' | ');
    return `@${user}'s Party (${inv.length}/10): ${list} | 💡 Have 3 of the same Pokémon and they evolve (if they have an evolution)!`;
  }

  if (cmd === 'info') {
    const inv = db.users[user].inventory;
    if (inv.length === 0) return `@${user} Your party is empty! Catch a Pokémon with !catch first.`;
    const slot = parseInt(args[0]) - 1;
    if (args.length === 0 || Number.isNaN(slot)) {
      return `@${user} To see a Pokémon's HP and moves, type !info <slot number>, e.g. !info 1 shows the Pokémon in slot 1. Type !party to see your slots (1-${inv.length}).`;
    }
    const mon = inv[slot];
    if (!mon) return `@${user} You have no Pokémon in slot ${slot + 1}. Pick a slot from 1-${inv.length} (check !party), e.g. !info 1.`;
    const shinyTag = mon.isShiny ? '✨SHINY ' : '';
    const movesStr = mon.moves.map((m, i) => `${i + 1}:${m.name}(${m.type}/${m.power}pwr)`).join(', ');
    return `@${user} #${slot + 1} ${shinyTag}${mon.name} | HP:${mon.maxHp} | Moves: ${movesStr}`;
  }

  if (cmd === 'release') {
    const inv = db.users[user].inventory;
    if (inv.length === 0) return `@${user} Your party is empty, nothing to release!`;
    const slot = parseInt(args[0]) - 1;
    if (args.length === 0 || Number.isNaN(slot)) {
      return `@${user} To release a Pokémon, type !release <slot number>, e.g. !release 3 releases the Pokémon in slot 3. Type !party to see your slots (1-${inv.length}).`;
    }
    if (!inv[slot]) return `@${user} You have no Pokémon in slot ${slot + 1}. Pick a slot from 1-${inv.length} (check !party), e.g. !release 1.`;
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
    if (args.length === 0) {
      return `@${user} To trade, type !trade @username <slot>, e.g. !trade @ash 2 offers your slot 2 Pokémon to @ash. They accept with !accept <their slot> and you swap Pokémon. Type !party to see your slots.`;
    }
    const target = (args[0] || '').toLowerCase().replace('@', '');
    const slot = parseInt(args[1]) - 1;
    const mon = db.users[user].inventory[slot];
    if (!target || !db.users[target]) return `@${user} User not found. Use !trade @username <slot>, e.g. !trade @ash 2.`;
    if (target === user) return `@${user} Can't trade with yourself!`;
    if (args.length < 2 || Number.isNaN(slot) || !mon) {
      return `@${user} Pick which Pokémon to offer: !trade @${target} <slot>, e.g. !trade @${target} 1. Type !party to see your slots (1-${db.users[user].inventory.length}).`;
    }

    db.pendingTrades[target] = { fromUser: user, offeredUid: mon.uid, offeredName: mon.name };
    await saveDB(db);
    return `🔄 @${user} wants to trade ${mon.isShiny ? '✨' : ''}${mon.name} to @${target}! Type !accept <yourSlot> to accept.`;
  }

  if (cmd === 'accept') {
    const trade = db.pendingTrades[user];
    if (!trade) return `@${user} No pending trades. When someone offers you a trade with !trade @${user} <slot>, reply with !accept <your slot> to swap Pokémon.`;
    const mySlot = parseInt(args[0]) - 1;
    const myInv = db.users[user].inventory;
    const senderInv = db.users[trade.fromUser].inventory;
    const myMon = myInv[mySlot];
    const senderIndex = senderInv.findIndex(p => p.uid === trade.offeredUid);

    if (args.length === 0 || Number.isNaN(mySlot) || !myMon) {
      return `@${user} @${trade.fromUser} offered you ${trade.offeredName}! To accept, type !accept <slot>, e.g. !accept 1 swaps your slot 1 Pokémon for it. Type !party to see your slots (1-${myInv.length}).`;
    }
    if (senderIndex === -1) {
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
    if (args.length === 0) {
      return `@${user} To battle another trainer, type !battle @username <slot>, e.g. !battle @ash 1 challenges @ash with the Pokémon in your slot 1. Type !party to see your slots. Your opponent accepts with !battle @${user} <slot>, then take turns with !move <1-4>. Use !forfeit to quit.`;
    }
    if (!opponent || !db.users[opponent]) return `@${user} Opponent not found. Use !battle @username <slot>, e.g. !battle @ash 1.`;
    if (Number.isNaN(slot) || !myMon) return `@${user} Pick one of your Pokémon: !battle @${opponent} <slot>, e.g. !battle @${opponent} 1. Type !party to see your slots.`;

    const battleKey = [user, opponent].sort().join('_vs_');
    let battle = db.activeBattles[battleKey];

    if (!battle) {
      db.activeBattles[battleKey] = {
        p1: user,
        p2: opponent,
        p1Mon: { ...myMon, currentHp: myMon.maxHp },
        p2Mon: null,
        turn: user,
        lastLog: `@${user} challenged @${opponent}!`,
        createdAt: Date.now(),
        startedAt: null,
        turnStartedAt: null
      };
      await saveDB(db);
      return `⚔️ @${user} challenged @${opponent} with ${myMon.name}! @${opponent}, type !battle @${user} <slot> within 5 min to accept! ${BATTLE_RULES}`;
    } else if (battle.p2 === user && !battle.p2Mon) {
      battle.p2Mon = { ...myMon, currentHp: myMon.maxHp };
      battle.lastLog = `What will ${battle.p1Mon.name} do?`;
      battle.startedAt = Date.now();
      battle.turnStartedAt = Date.now();
      await saveDB(db);
      return `🔥 Battle started! ${battle.p1Mon.name} (@${battle.p1}) vs ${battle.p2Mon.name} (@${battle.p2})! ${BATTLE_RULES} @${battle.turn}, you move first, use !move <1-4>!`;
    }
    return `@${user} Battle already active! Use !move <1-4>.`;
  }

  if (cmd === 'move') {
    const moveIdx = parseInt(args[0]) - 1;
    const battleKey = Object.keys(db.activeBattles).find(k => k.includes(user));
    const battle = db.activeBattles[battleKey];
    if (!battle || !battle.p2Mon) return `@${user} Not in a battle.`;

    // Enforce time limits even if the background check hasn't caught up yet
    const timerMsg = applyBattleTimers(db, battleKey, battle);
    if (timerMsg) {
      await saveDB(db);
      return timerMsg;
    }
    if (battle.turn !== user) return `@${user} Not your turn!`;

    const isP1 = battle.p1 === user;
    const attacker = isP1 ? battle.p1Mon : battle.p2Mon;
    const defender = isP1 ? battle.p2Mon : battle.p1Mon;
    const opponentUser = isP1 ? battle.p2 : battle.p1;
    const move = attacker.moves[moveIdx];
    if (args.length === 0 || Number.isNaN(moveIdx) || !move) {
      const movesList = attacker.moves.map((m, i) => `${i + 1}:${m.name}`).join(', ');
      const prefix = args.length === 0
        ? `To attack, type !move <number>, e.g. !move 1 uses move 1.`
        : `"${args[0]}" isn't a valid move. Type !move <number>, e.g. !move 1.`;
      return `@${user} ${prefix} Your ${attacker.name}'s moves: ${movesList}. You have ${MOVE_LIMIT_SECS}s per turn!`;
    }

    if (Math.random() * 100 > move.accuracy) {
      battle.turn = opponentUser;
      battle.lastLog = `${attacker.name} used ${move.name.toUpperCase()}... missed!`;
      battle.turnStartedAt = Date.now();
      await saveDB(db);
      const missComment = battleCommentary({ attacker, defender, missed: true });
      return `💨 ${attacker.name} used ${move.name}, but missed! 🎙️ ${missComment} @${opponentUser}'s turn (${MOVE_LIMIT_SECS}s)!`;
    }

    const stab = attacker.types.includes(move.type) ? 1.5 : 1.0;
    const effectiveness = getTypeEffectiveness(move.type, defender.types);
    const rawDamage = (((2 * 50 / 5 + 2) * move.power * (attacker.atk / defender.def)) / 50 + 2);
    const finalDamage = Math.max(1, Math.floor(rawDamage * stab * effectiveness * (0.85 + Math.random() * 0.15)));
    defender.currentHp = Math.max(0, defender.currentHp - finalDamage);

    let effText = effectiveness > 1 ? ' Super effective!' : (effectiveness === 0 ? ' No effect!' : (effectiveness < 1 ? ' Not very effective...' : ''));

    if (defender.currentHp === 0) {
      recordBattleEnd(db, battle, user, 'faint', `${defender.name} fainted! @${user} wins!`);
      delete db.activeBattles[battleKey];
      await saveDB(db);
      const koComment = battleCommentary({ attacker, defender, damage: finalDamage, effectiveness, fainted: true });
      return `💥 ${attacker.name} used ${move.name} (-${finalDamage} HP)!${effText} ${defender.name} fainted! 🏆 @${user} wins! 🎙️ ${koComment}`;
    }

    battle.turn = opponentUser;
    battle.lastLog = `${attacker.name} used ${move.name.toUpperCase()}!${effText}`;
    battle.turnStartedAt = Date.now();
    await saveDB(db);
    const comment = battleCommentary({ attacker, defender, damage: finalDamage, effectiveness });
    return `⚔️ ${attacker.name} used ${move.name} (-${finalDamage} HP)!${effText} ${defender.name} (${defender.currentHp}/${defender.maxHp} HP). 🎙️ ${comment} @${opponentUser}'s turn (${MOVE_LIMIT_SECS}s)!`;
  }

  if (cmd === 'forfeit') {
    const battleKey = Object.keys(db.activeBattles).find(k => k.split('_vs_').includes(user));
    if (!battleKey) return `@${user} Not in a battle.`;
    const battle = db.activeBattles[battleKey];
    const opponent = battle.p1 === user ? battle.p2 : battle.p1;
    const wasAccepted = Boolean(battle.p2Mon);
    if (wasAccepted) recordBattleEnd(db, battle, opponent, 'forfeit', `@${user} forfeited! @${opponent} wins!`);
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

// Triggered every 5 mins by cron-job.org (posts directly to Kick chat + OBS)
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
      spawn: db.activeSpawn || null,
      result: db.lastBattleResult || null,
      now: Date.now(),
      limits: { move: MOVE_LIMIT_MS, battle: BATTLE_LIMIT_MS }
    });
  } catch (e) {
    res.json({ active: false, battle: null, spawn: null, result: null, now: Date.now() });
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
    #gbc-frame { width: 700px; }
    #spawn-screen { background: #f8f8f8; border: 5px solid #111; border-radius: 6px; padding: 14px; color: #181818; text-align: center; }
    .spawn-banner { background: #181818; color: #fff; font-size: 10px; padding: 6px; border-radius: 4px; margin-bottom: 10px; }
    .spawn-banner.shiny { background: #d97706; }
    .sprite { width: 136px; height: 136px; image-rendering: pixelated; object-fit: contain; }
    #spawn-sprite { width: 160px; height: 160px; }
    #spawn-name { font-size: 18px; margin: 10px 0 8px; letter-spacing: 1px; }
    #spawn-types { font-size: 10px; color: #555; margin-bottom: 12px; }
    #spawn-timer { font-size: 12px; margin-bottom: 6px; }
    #spawn-bar-bg { height: 10px; background: #ddd; border: 3px solid #181818; border-radius: 6px; overflow: hidden; margin: 0 20px 12px; }
    #spawn-bar { height: 100%; width: 100%; background: #22c55e; }
    .spawn-cta { border-top: 3px dashed #999; padding-top: 10px; font-size: 11px; color: #16a34a; }
    .brand { text-align: center; margin-top: 12px; font-size: 13px; letter-spacing: 2px; color: #8d99ae; }
    .brand span:nth-child(1) { color: #ef4444; } .brand span:nth-child(2) { color: #a855f7; } .brand span:nth-child(3) { color: #22c55e; } .brand span:nth-child(4) { color: #eab308; } .brand span:nth-child(5) { color: #3b82f6; }

    /* ---------- BATTLE SCREEN ---------- */
    #screen { background: #f8f8f8; border: 5px solid #111; border-radius: 6px; color: #181818; overflow: hidden; }
    #scene { position: relative; height: 300px; overflow: hidden; border-bottom: 4px solid #181818; }
    .platform { position: absolute; width: 200px; height: 34px; border-radius: 50%; background: radial-gradient(ellipse at center, #cfcfcf 0%, #cfcfcf 60%, rgba(207,207,207,0) 72%); }
    #p1-platform { left: 20px; bottom: 2px; width: 230px; }
    #p2-platform { right: 24px; top: 140px; }

    .spr { position: absolute; width: 220px; display: flex; justify-content: center; align-items: flex-end; }
    #p1-spr { left: 20px; bottom: 16px; height: 190px; }
    #p2-spr { right: 34px; top: 20px; height: 140px; }
    .spr-fx, .spr-bob { width: 100%; height: 100%; display: flex; justify-content: center; align-items: flex-end; }
    .spr-bob { animation: bob 1.6s ease-in-out infinite; }
    #p2-spr .spr-bob { animation-delay: -0.8s; }
    .spr img { display: block; image-rendering: pixelated; transform-origin: 50% 100%; }

    .hud { position: absolute; width: 290px; background: #fff; border: 4px solid #181818; border-radius: 8px 8px 8px 22px; padding: 8px 10px 8px; }
    #p2-hud { left: 12px; top: 14px; }
    #p1-hud { right: 12px; bottom: 16px; border-radius: 8px 8px 22px 8px; }
    .hud-name { font-size: 13px; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hud-user { font-size: 8px; color: #666; margin-bottom: 7px; }
    .hp-row { display: flex; align-items: center; gap: 6px; }
    .hp-tag { background: #181818; color: #f8c030; font-size: 8px; padding: 3px 4px; border-radius: 3px; }
    .hp-bg { flex: 1; height: 12px; background: #ddd; border: 3px solid #181818; border-radius: 6px; overflow: hidden; }
    .hp-fill { height: 100%; width: 100%; background: #22c55e; transition: width 0.9s linear, background 0.4s; }
    .hp-num { font-size: 11px; text-align: right; margin-top: 6px; }
    .hide { visibility: hidden; }

    #flash { position: absolute; inset: 0; background: #181818; opacity: 0; pointer-events: none; }
    #banner { position: absolute; left: 50%; top: 46%; transform: translate(-50%, -50%) scale(0); background: #181818; color: #f8c030; border: 4px solid #f8c030; border-radius: 8px; padding: 16px 22px; font-size: 18px; white-space: nowrap; display: none; }
    #banner.show { display: block; animation: banner-pop 0.6s cubic-bezier(.2,1.6,.4,1) forwards; }

    #bottom { display: flex; gap: 8px; padding: 8px; background: #f8f8f8; }
    #dialog-box { flex: 1; border: 4px solid #181818; border-radius: 6px; padding: 10px 12px; background: #fff; min-height: 156px; display: flex; flex-direction: column; justify-content: space-between; }
    #log-text { font-size: 11px; line-height: 1.7; min-height: 78px; }
    #turn-line { border-top: 2px dashed #999; padding-top: 8px; }
    #turn-text { font-size: 9px; margin-bottom: 6px; min-height: 12px; }
    #timer-bg { height: 8px; background: #ddd; border: 2px solid #181818; border-radius: 4px; overflow: hidden; }
    #timer-fill { height: 100%; width: 0%; background: #3b82f6; }
    #moves-box { width: 290px; border: 4px solid #181818; border-radius: 6px; padding: 8px 10px; background: #fff; }
    #moves-title { font-size: 8px; color: #555; margin-bottom: 8px; min-height: 10px; }
    .mv { display: flex; align-items: center; gap: 8px; height: 28px; font-size: 10px; }
    .mv-num { min-width: 22px; text-align: center; background: #181818; color: #fff; border-radius: 3px; padding: 5px 5px; font-size: 10px; }
    .mv-name { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mv-info { font-size: 7px; color: #666; }
    .mv-hint { font-size: 9px; line-height: 1.7; color: #444; }

    @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-5px); } }
    @keyframes lunge-p1 { 0% { transform: translate(0, 0); } 35% { transform: translate(90px, -40px); } 100% { transform: translate(0, 0); } }
    @keyframes lunge-p2 { 0% { transform: translate(0, 0); } 35% { transform: translate(-90px, 40px); } 100% { transform: translate(0, 0); } }
    @keyframes hit { 0%, 100% { opacity: 1; transform: translateX(0); } 10% { opacity: 0; } 20% { opacity: 1; transform: translateX(-10px); } 30% { opacity: 0; } 40% { opacity: 1; transform: translateX(10px); } 50% { opacity: 0; } 60% { opacity: 1; transform: translateX(-6px); } 80% { transform: translateX(4px); } }
    @keyframes faint { 0% { transform: translateY(0); opacity: 1; } 100% { transform: translateY(110px); opacity: 0; } }
    @keyframes enter-left { 0% { transform: translateX(-340px); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
    @keyframes enter-right { 0% { transform: translateX(340px); opacity: 0; } 100% { transform: translateX(0); opacity: 1; } }
    @keyframes hud-in { 0% { transform: translateY(-24px); opacity: 0; } 100% { transform: translateY(0); opacity: 1; } }
    @keyframes flash { 0% { opacity: 0.5; } 100% { opacity: 0; } }
    @keyframes banner-pop { 0% { transform: translate(-50%, -50%) scale(0); } 100% { transform: translate(-50%, -50%) scale(1); } }
    .lunge-p1 { animation: lunge-p1 0.6s ease-in-out; }
    .lunge-p2 { animation: lunge-p2 0.6s ease-in-out; }
    .hit { animation: hit 0.7s linear; }
    .faint { animation: faint 0.8s ease-in forwards; }
    .enter-left { animation: enter-left 0.9s ease-out; }
    .enter-right { animation: enter-right 0.9s ease-out; }
    .hud-in { animation: hud-in 0.6s ease-out; }
    .flash { animation: flash 0.3s ease-out; }
  </style>
</head>
<body>
  <div id="spawn-card">
    <div id="spawn-screen">
      <div id="spawn-banner" class="spawn-banner">WILD POKÉMON APPEARED!</div>
      <img id="spawn-sprite" class="sprite" src="">
      <div id="spawn-name"></div>
      <div id="spawn-types"></div>
      <div id="spawn-timer"></div>
      <div id="spawn-bar-bg"><div id="spawn-bar"></div></div>
      <div class="spawn-cta">TYPE !catch IN CHAT!</div>
    </div>
    <div class="brand">GAME BOY <span>C</span><span>O</span><span>L</span><span>O</span><span>R</span></div>
  </div>

  <div id="gbc-frame">
    <div id="screen">
      <div id="scene">
        <div class="platform" id="p2-platform"></div>
        <div class="platform" id="p1-platform"></div>

        <div class="spr" id="p2-spr"><div class="spr-fx" id="p2-fx"><div class="spr-bob"><img id="p2-img" src=""></div></div></div>
        <div class="spr" id="p1-spr"><div class="spr-fx" id="p1-fx"><div class="spr-bob"><img id="p1-img" src=""></div></div></div>

        <div class="hud" id="p2-hud">
          <div class="hud-name" id="p2-name"></div>
          <div class="hud-user" id="p2-user"></div>
          <div class="hp-row"><span class="hp-tag">HP</span><div class="hp-bg"><div class="hp-fill" id="p2-hp-bar"></div></div></div>
          <div class="hp-num" id="p2-hp-text"></div>
        </div>
        <div class="hud" id="p1-hud">
          <div class="hud-name" id="p1-name"></div>
          <div class="hud-user" id="p1-user"></div>
          <div class="hp-row"><span class="hp-tag">HP</span><div class="hp-bg"><div class="hp-fill" id="p1-hp-bar"></div></div></div>
          <div class="hp-num" id="p1-hp-text"></div>
        </div>

        <div id="flash"></div>
        <div id="banner"></div>
      </div>

      <div id="bottom">
        <div id="dialog-box">
          <div id="log-text"></div>
          <div id="turn-line">
            <div id="turn-text"></div>
            <div id="timer-bg"><div id="timer-fill"></div></div>
          </div>
        </div>
        <div id="moves-box">
          <div id="moves-title"></div>
          <div id="moves-list"></div>
        </div>
      </div>
    </div>
    <div class="brand">GAME BOY <span>C</span><span>O</span><span>L</span><span>O</span><span>R</span></div>
  </div>

  <script>
    var BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon';
    var offset = 0;                 // server clock minus browser clock
    var limits = { move: 30000, battle: 300000 };
    var cur = null;                 // what is currently drawn on the battle screen
    var lastB = null;               // last battle shown (used by the countdown)
    var showingResult = false;
    var lastSpawn = null;           // spawn currently on screen (used by the countdown)

    function $(id) { return document.getElementById(id); }
    function serverNow() { return Date.now() + offset; }
    function esc(s) { return String(s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;'); }

    function play(el, cls, ms) {
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
      if (ms) setTimeout(function () { el.classList.remove(cls); }, ms);
    }

    function typeText(el, text) {
      if (el.getAttribute('data-full') === text) return;
      el.setAttribute('data-full', text);
      if (el._t) clearInterval(el._t);
      var i = 0;
      el.textContent = '';
      el._t = setInterval(function () {
        i++;
        el.textContent = text.slice(0, i);
        if (i >= text.length) clearInterval(el._t);
      }, 28);
    }

    // ---------- sprites ----------
    function spriteUrls(mon, back) {
      var shiny = Boolean(mon.isShiny);
      return {
        anim: BASE + '/versions/generation-v/black-white/animated/' + (back ? 'back/' : '') + (shiny ? 'shiny/' : '') + mon.id + '.gif',
        still: BASE + (back ? '/back' : '') + (shiny ? '/shiny' : '') + '/' + mon.id + '.png'
      };
    }
    function fitSprite(img, maxH) {
      var h = img.naturalHeight || 64;
      var s = Math.min(3, maxH / h);
      img.style.transform = 'scale(' + s + ')';
    }
    function setBattleSprite(img, mon, back, maxH) {
      var u = spriteUrls(mon, back);
      if (img.getAttribute('data-key') === u.anim) return; // keep the animation running between polls
      img.setAttribute('data-key', u.anim);
      img.onload = function () { fitSprite(img, maxH); };
      img.onerror = function () {
        img.onerror = null;
        img.onload = function () { fitSprite(img, maxH * 0.85); };
        img.src = u.still;
      };
      img.src = u.anim;
    }
    function setAnimatedSprite(img, mon) {
      var staticUrl = BASE + (mon.isShiny ? '/shiny/' : '/') + mon.id + '.png';
      var gifUrl = BASE + '/versions/generation-v/black-white/animated/' + (mon.isShiny ? 'shiny/' : '') + mon.id + '.gif';
      var key = gifUrl + '|' + mon.spawnedAt;
      if (img.dataset.key === key) return;
      img.dataset.key = key;
      img.onerror = function () { img.onerror = null; img.src = staticUrl; };
      img.src = gifUrl;
    }

    // ---------- HP ----------
    function showHpNum(el, hp, max, instant) {
      var from = el._cur;
      if (el._timer) clearInterval(el._timer);
      if (instant || from === undefined || from === hp) {
        el._cur = hp;
        el.textContent = hp + ' / ' + max;
        return;
      }
      var start = Date.now();
      el._timer = setInterval(function () {
        var t = Math.min(1, (Date.now() - start) / 900);
        var v = Math.round(from + (hp - from) * t);
        el._cur = v;
        el.textContent = v + ' / ' + max;
        if (t >= 1) { clearInterval(el._timer); el._cur = hp; }
      }, 40);
    }
    function setHp(prefix, hp, max, instant) {
      var pct = Math.max(0, Math.min(100, (hp / max) * 100));
      var bar = $(prefix + '-hp-bar');
      if (instant) bar.style.transition = 'none';
      bar.style.width = pct + '%';
      bar.style.background = pct > 50 ? '#22c55e' : (pct > 20 ? '#eab308' : '#ef4444');
      if (instant) { void bar.offsetWidth; bar.style.transition = ''; }
      showHpNum($(prefix + '-hp-text'), hp, max, instant);
    }

    // ---------- attack animation ----------
    function attackAnim(att, def) {
      play($(att + '-fx'), 'lunge-' + att, 650);
      setTimeout(function () {
        play($(def + '-fx'), 'hit', 750);
        play($('flash'), 'flash', 350);
      }, 260);
    }

    // ---------- moves menu + timers ----------
    function renderMoves(b, isResult) {
      var title = $('moves-title');
      var list = $('moves-list');
      if (isResult) { title.textContent = 'BATTLE OVER'; list.innerHTML = ''; return; }
      if (!b.p2Mon) {
        title.textContent = 'WAITING...';
        list.innerHTML = '<div class="mv-hint">@' + esc(b.p2) + ' type<br>!battle @' + esc(b.p1) + ' &lt;slot&gt;<br>to accept!</div>';
        return;
      }
      var mon = (b.turn === b.p2) ? b.p2Mon : b.p1Mon;
      title.textContent = '@' + b.turn + ' - type !move <number>';
      list.innerHTML = mon.moves.map(function (m, i) {
        return '<div class="mv"><span class="mv-num">' + (i + 1) + '</span><span class="mv-name">' + esc(m.name.toUpperCase()) + '</span><span class="mv-info">' + esc(m.type.slice(0, 4).toUpperCase()) + ' ' + esc(m.power) + '</span></div>';
      }).join('');
    }

    function renderTimer() {
      var txt = $('turn-text');
      var fill = $('timer-fill');
      if (!lastB || !lastB.p2Mon || showingResult) { txt.textContent = ''; fill.style.width = '0%'; return; }
      var started = lastB.turnStartedAt || serverNow();
      var left = Math.max(0, started + limits.move - serverNow());
      var secs = Math.ceil(left / 1000);
      var battleLeft = Math.max(0, (lastB.startedAt || serverNow()) + limits.battle - serverNow());
      var m = Math.floor(battleLeft / 60000);
      var s = Math.floor((battleLeft % 60000) / 1000);
      txt.textContent = '@' + lastB.turn + ' ' + secs + 's | ' + m + ':' + (s < 10 ? '0' : '') + s + ' left';
      fill.style.width = (left / limits.move * 100) + '%';
      fill.style.background = secs <= 8 ? '#ef4444' : '#3b82f6';
    }

    // ---------- main battle render ----------
    function battleKey(b) { return b.p1 + '|' + b.p2 + '|' + (b.createdAt || 0); }

    function renderBattle(b, isResult, res) {
      var key = battleKey(b);
      var isNew = !cur || cur.key !== key;
      var hasP2 = Boolean(b.p2Mon);
      var p1Hp = b.p1Mon.currentHp;
      var p2Hp = hasP2 ? b.p2Mon.currentHp : null;

      var hit = null;
      var missed = false;
      if (!isNew) {
        if (hasP2 && cur.p2Hp !== null && p2Hp < cur.p2Hp) hit = ['p1', 'p2'];
        else if (p1Hp < cur.p1Hp) hit = ['p2', 'p1'];
        else if (b.lastLog !== cur.log && String(b.lastLog).indexOf('missed') >= 0) missed = true;
      }

      // static info
      $('p1-name').textContent = (b.p1Mon.isShiny ? '✨' : '') + b.p1Mon.name;
      $('p1-user').textContent = '@' + b.p1;
      setBattleSprite($('p1-img'), b.p1Mon, true, 170);
      $('p2-hud').classList.toggle('hide', !hasP2);
      $('p2-spr').classList.toggle('hide', !hasP2);
      $('p2-platform').classList.toggle('hide', !hasP2);
      if (hasP2) {
        $('p2-name').textContent = (b.p2Mon.isShiny ? '✨' : '') + b.p2Mon.name;
        $('p2-user').textContent = '@' + b.p2;
        setBattleSprite($('p2-img'), b.p2Mon, false, 130);
      }

      // entrances
      if (isNew) {
        $('p1-fx').classList.remove('faint');
        $('p2-fx').classList.remove('faint');
        play($('p1-fx'), 'enter-left', 950);
        play($('p1-hud'), 'hud-in', 650);
        if (hasP2) { play($('p2-fx'), 'enter-right', 950); play($('p2-hud'), 'hud-in', 650); }
      } else if (hasP2 && !cur.hasP2) {
        play($('p2-fx'), 'enter-right', 950);
        play($('p2-hud'), 'hud-in', 650);
      }

      // attacks
      if (hit) attackAnim(hit[0], hit[1]);
      if (missed) {
        var attacker = (b.turn === b.p1) ? 'p2' : 'p1';
        play($(attacker + '-fx'), 'lunge-' + attacker, 650);
      }

      // health bars (delayed so they drop when the hit lands)
      var delay = hit ? 450 : 0;
      var instant = isNew;
      setTimeout(function () {
        setHp('p1', p1Hp, b.p1Mon.maxHp, instant);
        if (hasP2) setHp('p2', p2Hp, b.p2Mon.maxHp, instant);
        else { $('p2-hp-text').textContent = ''; }
      }, delay);

      // fainting
      if (isResult && res.reason === 'faint') {
        if (p1Hp <= 0) setTimeout(function () { $('p1-fx').classList.add('faint'); }, 1100);
        if (hasP2 && p2Hp <= 0) setTimeout(function () { $('p2-fx').classList.add('faint'); }, 1100);
      }

      // text, menu, banner
      typeText($('log-text'), isResult ? res.message : (b.lastLog || ''));
      renderMoves(b, isResult);
      var banner = $('banner');
      if (isResult) {
        banner.textContent = res.winner ? ('🏆 @' + res.winner + ' WINS!') : 'DRAW!';
        if (!banner.classList.contains('show')) setTimeout(function () { banner.classList.add('show'); }, 1200);
      } else {
        banner.classList.remove('show');
      }

      cur = { key: key, p1Hp: p1Hp, p2Hp: p2Hp, log: b.lastLog, hasP2: hasP2 };
      lastB = b;
      showingResult = isResult;
      renderTimer();
    }

    function renderSpawnTimer() {
      var txt = $('spawn-timer');
      var bar = $('spawn-bar');
      if (!lastSpawn) return;
      var expires = lastSpawn.expiresAt || (lastSpawn.spawnedAt + 60000);
      var total = Math.max(1, expires - lastSpawn.spawnedAt);
      var left = Math.max(0, expires - serverNow());
      var secs = Math.ceil(left / 1000);
      txt.textContent = secs > 0 ? ('ESCAPES IN ' + secs + 's') : 'IT FLED!';
      bar.style.width = (left / total * 100) + '%';
      bar.style.background = secs <= 10 ? '#ef4444' : (secs <= 20 ? '#eab308' : '#22c55e');
    }

    // ---------- polling ----------
    async function tick() {
      try {
        var res = await fetch('/battle-data');
        var data = await res.json();
        if (data.now) offset = data.now - Date.now();
        if (data.limits) limits = data.limits;

        var frame = $('gbc-frame');
        var card = $('spawn-card');

        var result = data.result;
        var resultFresh = result && (serverNow() - result.at) < 10000;

        if (data.active && data.battle) {
          card.style.display = 'none';
          frame.style.display = 'block';
          renderBattle(data.battle, false, null);
          return;
        }
        if (resultFresh) {
          card.style.display = 'none';
          frame.style.display = 'block';
          renderBattle(result, true, result);
          return;
        }

        frame.style.display = 'none';
        cur = null;
        lastB = null;
        showingResult = false;
        $('banner').classList.remove('show');

        var s = data.spawn;
        if (s && s.spawnedAt && serverNow() < (s.expiresAt || (s.spawnedAt + 60000))) {
          lastSpawn = s;
          card.style.display = 'block';
          var banner = $('spawn-banner');
          banner.textContent = s.isShiny ? '✨ RARE SHINY APPEARED! ✨' : 'WILD POKÉMON APPEARED!';
          banner.classList.toggle('shiny', Boolean(s.isShiny));
          setAnimatedSprite($('spawn-sprite'), s);
          $('spawn-name').textContent = (s.isShiny ? '✨' : '') + s.name;
          $('spawn-types').textContent = 'TYPE: ' + s.types.join(' / ').toUpperCase();
          renderSpawnTimer();
        } else {
          lastSpawn = null;
          card.style.display = 'none';
        }
      } catch (e) {}
    }
    setInterval(tick, 1000);
    setInterval(renderTimer, 250);
    setInterval(renderSpawnTimer, 250);
    tick();
  </script>
</body>
</html>
</html>`);
});

// Battle timer: enforces the move time limit and 5 min battle limit
let battleTickRunning = false;
setInterval(async () => {
  if (battleTickRunning) return;
  battleTickRunning = true;
  try {
    if (mongoose.connection.readyState !== 1) return;
    const db = await getDB();
    const messages = [];

    for (const key of Object.keys(db.activeBattles || {})) {
      const msg = applyBattleTimers(db, key, db.activeBattles[key]);
      if (msg) messages.push(msg);
    }

    // Announce when a wild Pokémon flees after the catch window ends
    const spawn = db.activeSpawn;
    if (spawn && !spawn.fledAnnounced && Date.now() > spawnExpiresAt(spawn)) {
      spawn.fledAnnounced = true;
      const expiredAgo = Date.now() - spawnExpiresAt(spawn);
      if (expiredAgo < 60000) { // skip stale spawns left over from before a restart
        const shinyTag = spawn.isShiny ? '✨SHINY ' : '';
        const catchers = spawn.caughtBy || [];
        messages.push(catchers.length > 0
          ? `💨 The wild ${shinyTag}${spawn.name} fled! Caught by: ${catchers.map(u => '@' + u).join(', ')}. Next spawn in ${SPAWN_INTERVAL_MINUTES} minutes!`
          : `💨 The wild ${shinyTag}${spawn.name} fled... nobody caught it! Next spawn in ${SPAWN_INTERVAL_MINUTES} minutes!`);
      } else {
        messages.push(null);
      }
    }

    if (messages.length > 0) {
      await saveDB(db);
      for (const msg of messages) if (msg) await sendKickChat(db, msg);
    }
  } catch (err) {
    console.error('❌ Battle timer error:', err.message);
  } finally {
    battleTickRunning = false;
  }
}, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Bot online on port ${PORT}!`));
