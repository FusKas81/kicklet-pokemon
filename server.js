const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI || '';
const SECRET_KEY = process.env.SECRET_KEY || 'mysecret99';
const KICK_CLIENT_ID = process.env.KICK_CLIENT_ID || '';
const KICK_CLIENT_SECRET = process.env.KICK_CLIENT_SECRET || '';
const KICK_REDIRECT_URI = process.env.KICK_REDIRECT_URI || 'https://kicklet-pokemon.onrender.com/auth/kick/callback';

// --- MONGODB CONNECTION & PERSISTENCE ---
let dbClient = null;
let stateCol = null;

const defaultState = {
  _id: 'bot_state',
  users: {},
  pokedex: {},
  currentSpawn: null,
  lastCaught: null,
  lastEvolution: null,
  activeBattle: null,
  kickAuth: null,
  oauthPkce: {}
};

let memoryState = JSON.parse(JSON.stringify(defaultState));

async function initDB() {
  if (!MONGO_URI) {
    console.log('Warning: MONGO_URI not set. Running in volatile memory mode.');
    return;
  }
  try {
    dbClient = new MongoClient(MONGO_URI);
    await dbClient.connect();
    const db = dbClient.db('kicklet_pokemon');
    stateCol = db.collection('state');
    const existing = await stateCol.findOne({ _id: 'bot_state' });
    if (!existing) {
      await stateCol.insertOne(memoryState);
    }
    console.log('Connected to MongoDB Atlas successfully.');
  } catch (err) {
    console.error('MongoDB connection error:', err.message);
  }
}

async function getDB() {
  if (!stateCol) return memoryState;
  let doc = await stateCol.findOne({ _id: 'bot_state' });
  if (!doc) {
    doc = JSON.parse(JSON.stringify(defaultState));
    await stateCol.insertOne(doc);
  }
  return doc;
}

async function saveDB(doc) {
  if (!stateCol) {
    memoryState = doc;
    return;
  }
  await stateCol.replaceOne({ _id: 'bot_state' }, doc, { upsert: true });
}

function getUser(db, username) {
  const key = username.toLowerCase();
  if (!db.users[key]) {
    db.users[key] = { username, party: [], catches: 0, wins: 0 };
  }
  return db.users[key];
}

// --- POKÉAPI HELPERS & TYPE EFFECTIVENESS ---
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

function getEffectiveness(moveType, defTypes) {
  let mult = 1;
  const chart = TYPE_CHART[moveType] || {};
  for (const t of defTypes) {
    if (chart[t] !== undefined) mult *= chart[t];
  }
  return mult;
}

function formatName(str) {
  return str
    .split('-')
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

async function fetchPokemonData(idOrName, forceShiny = null) {
  const res = await fetch(`https://pokeapi.co/api/v2/pokemon/${idOrName}`);
  if (!res.ok) throw new Error('Pokémon not found');
  const data = await res.json();

  const isShiny = forceShiny !== null ? forceShiny : Math.floor(Math.random() * 50) === 0;
  const types = data.types.map(t => t.type.name);

  const statsMap = {};
  for (const s of data.stats) {
    statsMap[s.stat.name] = s.base_stat;
  }
  const level = 50;
  const maxHp = Math.floor(((2 * (statsMap.hp || 60)) * level) / 100) + level + 10;
  const atk = Math.floor(((2 * (statsMap.attack || 60)) * level) / 100) + 5;
  const def = Math.floor(((2 * (statsMap.defense || 60)) * level) / 100) + 5;
  const spAtk = Math.floor(((2 * (statsMap['special-attack'] || 60)) * level) / 100) + 5;
  const spDef = Math.floor(((2 * (statsMap['special-defense'] || 60)) * level) / 100) + 5;
  const spd = Math.floor(((2 * (statsMap.speed || 60)) * level) / 100) + 5;

  // Pick up to 4 real damaging moves with official power & accuracy
  const candidateMoves = data.moves
    .map(m => m.move)
    .sort(() => 0.5 - Math.random())
    .slice(0, 14);

  const selectedMoves = [];
  for (const cm of candidateMoves) {
    if (selectedMoves.length >= 4) break;
    try {
      const mRes = await fetch(cm.url);
      if (!mRes.ok) continue;
      const mData = await mRes.json();
      if (mData.power && mData.power > 0) {
        selectedMoves.push({
          name: formatName(mData.name),
          type: mData.type.name,
          power: mData.power,
          accuracy: mData.accuracy || 100,
          damageClass: mData.damage_class ? mData.damage_class.name : 'physical'
        });
      }
    } catch (_) {}
  }

  if (selectedMoves.length === 0) {
    selectedMoves.push({
      name: 'Tackle',
      type: 'normal',
      power: 40,
      accuracy: 100,
      damageClass: 'physical'
    });
  }

  return {
    id: data.id,
    name: formatName(data.name),
    rawName: data.name,
    isShiny,
    types,
    maxHp,
    currentHp: maxHp,
    atk,
    def,
    spAtk,
    spDef,
    spd,
    moves: selectedMoves
  };
}

async function getNextEvolutionName(speciesUrl, currentRawName) {
  try {
    const sRes = await fetch(speciesUrl);
    if (!sRes.ok) return null;
    const sData = await sRes.json();
    if (!sData.evolution_chain || !sData.evolution_chain.url) return null;

    const cRes = await fetch(sData.evolution_chain.url);
    if (!cRes.ok) return null;
    const cData = await cRes.json();

    function findNext(node) {
      if (!node) return null;
      if (node.species && node.species.name === currentRawName) {
        if (node.evolves_to && node.evolves_to.length > 0) {
          const pick = node.evolves_to[Math.floor(Math.random() * node.evolves_to.length)];
          return pick.species.name;
        }
        return null;
      }
      for (const child of node.evolves_to || []) {
        const found = findNext(child);
        if (found) return found;
      }
      return null;
    }

    return findNext(cData.chain);
  } catch (_) {
    return null;
  }
}

// --- KICK OAUTH & CHAT API INTEGRATION ---
function base64UrlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function refreshKickTokenIfNeeded(db) {
  if (!db.kickAuth || !db.kickAuth.refresh_token) return db.kickAuth ? db.kickAuth.access_token : null;
  if (db.kickAuth.expires_at && Date.now() < db.kickAuth.expires_at - 60000) {
    return db.kickAuth.access_token;
  }
  try {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET,
      refresh_token: db.kickAuth.refresh_token
    });
    const res = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await res.json();
    if (data.access_token) {
      db.kickAuth = {
        ...db.kickAuth,
        access_token: data.access_token,
        refresh_token: data.refresh_token || db.kickAuth.refresh_token,
        expires_at: Date.now() + (data.expires_in || 3600) * 1000
      };
      await saveDB(db);
      return db.kickAuth.access_token;
    }
  } catch (err) {
    console.error('Token refresh failed:', err.message);
  }
  return db.kickAuth.access_token;
}

async function sendKickChat(db, content) {
  const token = await getKickAccessToken(db);
  if (!token) throw new Error('No Kick access token found.');

  // Automatically fetch your exact User ID from Kick
  if (!db.kickAuth.user_id) {
    const userRes = await axios.get('https://api.kick.com/public/v1/users', {
      headers: { Authorization: `Bearer ${token}` }
    });
    const userData = userRes.data?.data?.[0] || userRes.data;
    if (userData?.user_id) {
      db.kickAuth.user_id = Number(userData.user_id);
      await saveDB(db);
    }
  }

  const broadcasterId = Number(db.kickAuth.user_id || process.env.KICK_BROADCASTER_ID);

  // Send as 'bot' (posts using your Kick Developer App's bot identity)
  const response = await axios.post(
    'https://api.kick.com/public/v1/chat',
    {
      broadcaster_user_id: broadcasterId,
      content: content.slice(0, 500),
      type: 'bot'
    },
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  return response.data;
}

  try {
    const res = await fetch('https://api.kick.com/public/v1/chat', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    const text = await res.text();
    if (!res.ok) {
      console.error('Kick Chat API error:', res.status, text);
      return { ok: false, status: res.status, body: text };
    }
    return { ok: true, body: text };
  } catch (err) {
    console.error('Kick Chat send exception:', err.message);
    return { ok: false, error: err.message };
  }
}

app.get('/auth/kick', async (req, res) => {
  if (!KICK_CLIENT_ID) return res.status(400).send('Missing KICK_CLIENT_ID env var.');
  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
  const codeChallenge = base64UrlEncode(crypto.createHash('sha256').update(codeVerifier).digest());

  const db = await getDB();
  db.oauthPkce = { state, codeVerifier, createdAt: Date.now() };
  await saveDB(db);

  const authUrl = new URL('https://id.kick.com/oauth/authorize');
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', KICK_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', KICK_REDIRECT_URI);
  authUrl.searchParams.set('scope', 'user:read channel:read chat:write events:subscribe');
  authUrl.searchParams.set('code_challenge', codeChallenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');
  authUrl.searchParams.set('state', state);

  res.redirect(authUrl.toString());
});

app.get('/auth/kick/callback', async (req, res) => {
  const { code, state } = req.query;
  const db = await getDB();
  if (!code || !db.oauthPkce || db.oauthPkce.state !== state) {
    return res.status(400).send('Invalid OAuth state or missing code.');
  }

  try {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: KICK_CLIENT_ID,
      client_secret: KICK_CLIENT_SECRET,
      redirect_uri: KICK_REDIRECT_URI,
      code_verifier: db.oauthPkce.codeVerifier,
      code: String(code)
    });

    const tokenRes = await fetch('https://id.kick.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(400).json({ error: 'Failed to exchange token', details: tokenData });
    }

    let broadcasterUserId = null;
    try {
      const userRes = await fetch('https://api.kick.com/public/v1/users', {
        headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
      });
      const userJson = await userRes.json();
      if (userJson.data && userJson.data[0]) {
        broadcasterUserId = userJson.data[0].user_id;
      }
    } catch (_) {}

    db.kickAuth = {
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: Date.now() + (tokenData.expires_in || 3600) * 1000,
      broadcaster_user_id: broadcasterUserId
    };
    db.oauthPkce = {};
    await saveDB(db);

    res.send('Kick OAuth connected successfully! You can close this tab and test commands in chat.');
  } catch (err) {
    res.status(500).send('OAuth callback error: ' + err.message);
  }
});

app.get('/debug-kick', async (req, res) => {
  const db = await getDB();
  const result = await sendKickChatMessage('PokéBot online! Type !pokehelp to view commands.');
  res.json({
    hasAuth: Boolean(db.kickAuth && db.kickAuth.access_token),
    broadcaster_user_id: db.kickAuth ? db.kickAuth.broadcaster_user_id : null,
    sendResult: result
  });
});

// --- CORE GAME & COMMAND ENGINE ---
async function triggerWildSpawn(db) {
  const randomId = Math.floor(Math.random() * 1025) + 1;
  const mon = await fetchPokemonData(randomId);
  db.currentSpawn = {
    ...mon,
    spawnedAt: Date.now()
  };
  await saveDB(db);

  const prefix = mon.isShiny ? '✨ RARE SHINY' : '🌿 A wild';
  const typeText = mon.types.map(t => t.toUpperCase()).join('/');
  return `${prefix} ${mon.name} [${typeText}] appeared! Type !catch to capture it!`;
}

async function processCommand(sender, rawText) {
  const text = (rawText || '').trim();
  if (!text.startsWith('!')) return null;

  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const arg1 = parts[1] ? parts[1].toLowerCase() : '';
  const arg2 = parts[2] ? parts[2].toLowerCase() : '';

  const db = await getDB();
  const user = getUser(db, sender);

  if (cmd === '!pokehelp') {
    return `@${sender} Commands: !catch | !party | !release <1-10> | !pokedex | !battle @user <slot> | !accept <slot> | !move <1-4> | !forfeit`;
  }

  if (cmd === '!spawn') {
    return await triggerWildSpawn(db);
  }

  if (cmd === '!catch') {
    if (!db.currentSpawn || (Date.now() - db.currentSpawn.spawnedAt) > 120000) {
      return `@${sender} There is no wild Pokémon around right now!`;
    }
    if (user.party.length >= 10) {
      return `@${sender} Your 10-slot party is full! Use !release <1-10> first to make room.`;
    }

    const mon = { ...db.currentSpawn };
    delete mon.spawnedAt;
    mon.currentHp = mon.maxHp;

    user.party.push(mon);
    user.catches = (user.catches || 0) + 1;

    db.pokedex[mon.id] = {
      id: mon.id,
      name: mon.name,
      firstCaughtBy: db.pokedex[mon.id] ? db.pokedex[mon.id].firstCaughtBy : sender,
      shinyFound: Boolean((db.pokedex[mon.id] && db.pokedex[mon.id].shinyFound) || mon.isShiny)
    };

    db.lastCaught = {
      name: mon.name,
      id: mon.id,
      isShiny: mon.isShiny,
      types: mon.types,
      caughtBy: sender,
      caughtAt: Date.now()
    };
    db.currentSpawn = null;

    let reply = `🎉 @${sender} caught ${mon.isShiny ? '✨ SHINY ' : ''}${mon.name}! (${user.party.length}/10 slots)`;

    // Check 3-of-a-kind automatic evolution
    const sameIndices = [];
    user.party.forEach((p, idx) => {
      if (p.id === mon.id) sameIndices.push(idx);
    });

    if (sameIndices.length >= 3) {
      const nextEvoName = await getNextEvolutionName(`https://pokeapi.co/api/v2/pokemon-species/${mon.id}/`, mon.rawName);
      if (nextEvoName) {
        const anyShiny = sameIndices.slice(0, 3).some(idx => user.party[idx].isShiny);
        const evolvedMon = await fetchPokemonData(nextEvoName, anyShiny);

        // Remove the 3 base copies (highest index first) and add evolved Pokémon
        const toRemove = sameIndices.slice(0, 3).sort((a, b) => b - a);
        for (const idx of toRemove) {
          user.party.splice(idx, 1);
        }
        user.party.push(evolvedMon);

        db.pokedex[evolvedMon.id] = {
          id: evolvedMon.id,
          name: evolvedMon.name,
          firstCaughtBy: db.pokedex[evolvedMon.id] ? db.pokedex[evolvedMon.id].firstCaughtBy : sender,
          shinyFound: Boolean((db.pokedex[evolvedMon.id] && db.pokedex[evolvedMon.id].shinyFound) || evolvedMon.isShiny)
        };

        db.lastEvolution = {
          fromName: mon.name,
          fromId: mon.id,
          toName: evolvedMon.name,
          toId: evolvedMon.id,
          isShiny: evolvedMon.isShiny,
          types: evolvedMon.types,
          trainer: sender,
          evolvedAt: Date.now()
        };

        reply += ` ✨ WHAT?! Three ${mon.name} combined and evolved into ${evolvedMon.isShiny ? '✨ SHINY ' : ''}${evolvedMon.name}!`;
      }
    }

    await saveDB(db);
    return reply;
  }

  if (cmd === '!party') {
    if (user.party.length === 0) {
      return `@${sender} Your party is empty! Catch wild Pokémon with !catch.`;
    }
    const list = user.party
      .map((p, i) => `#${i + 1} ${p.isShiny ? '✨' : ''}${p.name}`)
      .join(' | ');
    return `@${sender}'s Party (${user.party.length}/10): ${list}`;
  }

  if (cmd === '!release') {
    const slot = parseInt(arg1, 10);
    if (!slot || slot < 1 || slot > user.party.length) {
      return `@${sender} Usage: !release <1-${Math.max(1, user.party.length)}>`;
    }
    const removed = user.party.splice(slot - 1, 1)[0];
    await saveDB(db);
    return `@${sender} released ${removed.isShiny ? '✨' : ''}${removed.name} back into the wild.`;
  }

  if (cmd === '!pokedex') {
    const caughtCount = Object.keys(db.pokedex).length;
    const shinyCount = Object.values(db.pokedex).filter(p => p.shinyFound).length;
    return `📖 Global Stream Pokédex: ${caughtCount}/1025 species discovered (${shinyCount} ✨ Shinies found)!`;
  }

  if (cmd === '!battle') {
    if (db.activeBattle) {
      return `@${sender} A battle is already active between @${db.activeBattle.p1} and @${db.activeBattle.p2}!`;
    }
    const opponent = arg1.replace(/^@/, '');
    const slot = parseInt(arg2, 10) || 1;
    if (!opponent || opponent.toLowerCase() === sender.toLowerCase()) {
      return `@${sender} Usage: !battle @username <slot 1-10>`;
    }
    if (!user.party[slot - 1]) {
      return `@${sender} You don't have a Pokémon in slot #${slot}! Check !party.`;
    }

    const p1Mon = JSON.parse(JSON.stringify(user.party[slot - 1]));
    p1Mon.currentHp = p1Mon.maxHp;

    db.activeBattle = {
      p1: sender,
      p2: opponent,
      p1Mon,
      p2Mon: null,
      turn: opponent,
      lastLog: `@${sender} challenged @${opponent} with ${p1Mon.name}!`,
      startedAt: Date.now()
    };
    await saveDB(db);
    return `⚔️ @${sender} (${p1Mon.isShiny ? '✨' : ''}${p1Mon.name}) challenged @${opponent} to a battle! Type !accept <slot 1-10> to join!`;
  }

  if (cmd === '!accept') {
    const b = db.activeBattle;
    if (!b || b.p2Mon) {
      return `@${sender} There is no pending battle challenge to accept.`;
    }
    if (b.p2.toLowerCase() !== sender.toLowerCase()) {
      return `@${sender} This challenge is for @${b.p2}!`;
    }
    const slot = parseInt(arg1, 10) || 1;
    if (!user.party[slot - 1]) {
      return `@${sender} You don't have a Pokémon in slot #${slot}! Check !party.`;
    }

    const p2Mon = JSON.parse(JSON.stringify(user.party[slot - 1]));
    p2Mon.currentHp = p2Mon.maxHp;
    b.p2 = sender;
    b.p2Mon = p2Mon;
    b.turn = b.p1Mon.spd >= p2Mon.spd ? b.p1 : b.p2;
    b.lastLog = `${b.p1Mon.name} vs ${p2Mon.name}!`;
    await saveDB(db);

    const activeMon = b.turn === b.p1 ? b.p1Mon : b.p2Mon;
    const movesStr = activeMon.moves.map((m, i) => `!${i + 1} ${m.name}`).join(' | ');
    return `🔥 Battle started! ${b.p1Mon.name} vs ${p2Mon.name}! @${b.turn} goes first: ${movesStr}`;
  }

  if (cmd === '!move') {
    const b = db.activeBattle;
    if (!b || !b.p2Mon) {
      return `@${sender} No active battle in progress.`;
    }
    if (b.turn.toLowerCase() !== sender.toLowerCase()) {
      return `@${sender} It's @${b.turn}'s turn!`;
    }

    const moveIdx = (parseInt(arg1, 10) || 1) - 1;
    const isP1 = b.turn.toLowerCase() === b.p1.toLowerCase();
    const attacker = isP1 ? b.p1Mon : b.p2Mon;
    const defender = isP1 ? b.p2Mon : b.p1Mon;
    const defenderUser = isP1 ? b.p2 : b.p1;
    const move = attacker.moves[moveIdx] || attacker.moves[0];

    // Accuracy roll
    if (Math.random() * 100 > move.accuracy) {
      b.turn = defenderUser;
      b.lastLog = `${attacker.name} used ${move.name}, but it missed!`;
      await saveDB(db);
      return `💨 ${attacker.name} used ${move.name}, but it missed! @${b.turn}'s turn (!move 1-4).`;
    }

    const eff = getEffectiveness(move.type, defender.types);
    if (eff === 0) {
      b.turn = defenderUser;
      b.lastLog = `${attacker.name} used ${move.name} — No effect!`;
      await saveDB(db);
      return `🚫 ${attacker.name} used ${move.name}, but it had no effect on ${defender.name}! @${b.turn}'s turn (!move 1-4).`;
    }

    const atkStat = move.damageClass === 'special' ? attacker.spAtk : attacker.atk;
    const defStat = move.damageClass === 'special' ? defender.spDef : defender.def;
    const stab = attacker.types.includes(move.type) ? 1.5 : 1.0;
    const rand = 0.85 + Math.random() * 0.15;
    const rawDmg = (((2 * 50) / 5 + 2) * move.power * (atkStat / defStat)) / 50 + 2;
    const damage = Math.max(1, Math.floor(rawDmg * stab * eff * rand));

    defender.currentHp = Math.max(0, defender.currentHp - damage);

    let effTag = '';
    if (eff > 1) effTag = ' Super effective!';
    else if (eff < 1) effTag = ' Not very effective...';

    if (defender.currentHp <= 0) {
      const winnerObj = getUser(db, sender);
      winnerObj.wins = (winnerObj.wins || 0) + 1;
      db.activeBattle = null;
      await saveDB(db);
      return `💥 ${attacker.name} used ${move.name} for ${damage} dmg!${effTag} ${defender.name} fainted! 🏆 @${sender} wins the battle!`;
    }

    b.turn = defenderUser;
    b.lastLog = `${attacker.name} used ${move.name} (-${damage} HP).${effTag}`;
    await saveDB(db);

    const nextMoves = defender.moves.map((m, i) => `!${i + 1} ${m.name}`).join(' | ');
    return `💥 ${attacker.name} used ${move.name} (-${damage} HP)!${effTag} (${defender.name}: ${defender.currentHp}/${defender.maxHp} HP) — @${b.turn}'s turn: ${nextMoves}`;
  }

  if (cmd === '!forfeit') {
    const b = db.activeBattle;
    if (!b) return `@${sender} No active battle to forfeit.`;
    if (b.p1.toLowerCase() !== sender.toLowerCase() && b.p2.toLowerCase() !== sender.toLowerCase()) {
      return `@${sender} You are not in the active battle.`;
    }
    const winner = b.p1.toLowerCase() === sender.toLowerCase() ? b.p2 : b.p1;
    db.activeBattle = null;
    await saveDB(db);
    return `🏳️ @${sender} forfeited the battle! 🏆 @${winner} wins!`;
  }

  return null;
}

// --- ROUTES ---
app.get('/', (req, res) => {
  res.send('Kicklet Pokémon Bot is running! Overlay available at /overlay');
});

app.get('/spawn', async (req, res) => {
  if (req.query.secret !== SECRET_KEY) {
    return res.status(403).json({ error: 'Invalid secret' });
  }
  try {
    const db = await getDB();
    const announcement = await triggerWildSpawn(db);
    await sendKickChatMessage(announcement);
    res.json({ ok: true, announcement, spawn: db.currentSpawn });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/kick-webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const payload = req.body || {};
    const content = payload.content || (payload.message && payload.message.content) || '';
    const senderObj = payload.sender || (payload.message && payload.message.sender) || {};
    const sender = senderObj.username || senderObj.slug || 'Trainer';
    const broadcasterId = (payload.broadcaster && payload.broadcaster.user_id) || null;

    // Ignore bot's own announcements to prevent loops
    if (!content || !content.startsWith('!')) return;

    const reply = await processCommand(sender, content);
    if (reply) {
      await sendKickChatMessage(reply, broadcasterId);
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

app.get('/battle-data', async (req, res) => {
  const db = await getDB();
  res.json({
    active: Boolean(db.activeBattle),
    battle: db.activeBattle || null,
    spawn: db.currentSpawn || null,
    lastCaught: db.lastCaught || null,
    lastEvolution: db.lastEvolution || null
  });
});

// --- RETRO GAME BOY COLOR OBS OVERLAY (/overlay) ---
app.get('/overlay', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Kicklet Pokémon GBC Overlay</title>
  <link href="https://fonts.googleapis.com/css2?family=Press+Start+2P&display=swap" rel="stylesheet">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Press Start 2P', monospace; }
    body { background: transparent; overflow: hidden; width: 720px; height: 560px; display: flex; justify-content: center; align-items: center; }

    #gbc-frame {
      display: none;
      position: relative;
      width: 680px;
      height: 520px;
      background: #f8fafc;
      border: 6px solid #181818;
      border-radius: 12px;
      box-shadow: 0 10px 0 #181818;
      padding: 16px;
      color: #181818;
    }

    .arena-top, .arena-bottom {
      display: flex;
      justify-content: space-between;
      align-items: center;
      height: 155px;
      padding: 0 12px;
    }

    .hud-box {
      background: #f1f5f9;
      border: 4px solid #181818;
      border-radius: 6px;
      padding: 10px 12px;
      width: 310px;
      box-shadow: 4px 4px 0 #181818;
    }

    .hud-header { display: flex; justify-content: space-between; font-size: 11px; margin-bottom: 6px; }
    .hud-user { font-size: 9px; color: #475569; margin-bottom: 8px; }
    .hp-bar-bg { width: 100%; height: 12px; background: #cbd5e1; border: 3px solid #181818; border-radius: 4px; overflow: hidden; }
    .hp-bar-fill { height: 100%; background: #22c55e; transition: width 0.4s ease; }

    @keyframes low-hp-pulse {
      0%, 100% { background-color: #ef4444; box-shadow: 0 0 6px rgba(239, 68, 68, 0.9); }
      50% { background-color: #fca5a5; box-shadow: none; }
    }
    .hp-bar-fill.low-hp {
      animation: low-hp-pulse 0.7s steps(2, end) infinite;
    }

    .hp-text { font-size: 9px; text-align: right; margin-top: 5px; }

    .sprite-wrap {
      position: relative;
      width: 136px;
      height: 136px;
      display: flex;
      justify-content: center;
      align-items: center;
      overflow: hidden;
    }
    .sprite { width: 136px; height: 136px; image-rendering: pixelated; object-fit: contain; }

    @keyframes hit-shake {
      0%, 100% { transform: translateX(0); filter: brightness(1); }
      20% { transform: translateX(-10px); filter: brightness(2.5) sepia(1) hue-rotate(-50deg) saturate(4); }
      40% { transform: translateX(10px); filter: brightness(0.4); }
      60% { transform: translateX(-8px); filter: brightness(2.2); }
      80% { transform: translateX(8px); filter: brightness(1); }
    }
    .hit-anim { animation: hit-shake 0.36s steps(2, end); }

    @keyframes dmg-float {
      0% { opacity: 1; transform: translate(-50%, 0) scale(0.8); }
      20% { opacity: 1; transform: translate(-50%, -12px) scale(1.1); }
      80% { opacity: 1; transform: translate(-50%, -32px) scale(1); }
      100% { opacity: 0; transform: translate(-50%, -44px) scale(0.95); }
    }
    .dmg-popup {
      position: absolute;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      background: #ef4444;
      color: #fff;
      border: 3px solid #181818;
      border-radius: 4px;
      padding: 4px 7px;
      font-size: 11px;
      white-space: nowrap;
      pointer-events: none;
      z-index: 10;
      text-shadow: 1px 1px 0 #181818;
      animation: dmg-float 1.1s steps(8, end) forwards;
    }
    .dmg-popup.super {
      background: #facc15;
      color: #181818;
      text-shadow: none;
      font-size: 10px;
    }
    .dmg-popup.resist {
      background: #64748b;
      color: #f8fafc;
      font-size: 9px;
    }
    .dmg-popup.immune {
      background: #181818;
      color: #a1a1aa;
      border-color: #52525b;
      font-size: 9px;
    }
    .dmg-popup.miss {
      background: #ffffff;
      color: #181818;
      border-color: #181818;
      text-shadow: none;
      font-size: 10px;
    }

    @keyframes faint-drop {
      0% { transform: translateY(0); opacity: 1; }
      100% { transform: translateY(110px); opacity: 0; }
    }
    .faint-anim { animation: faint-drop 0.65s steps(6, end) forwards; }

    @keyframes banner-pop {
      0% { transform: translate(-50%, -50%) scale(0.6); opacity: 0; }
      60% { transform: translate(-50%, -50%) scale(1.06); opacity: 1; }
      100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    }
    #winner-banner {
      display: none;
      position: absolute;
      top: 42%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #facc15;
      color: #181818;
      border: 4px solid #181818;
      box-shadow: 0 6px 0 #181818;
      border-radius: 6px;
      padding: 12px 18px;
      font-size: 14px;
      white-space: nowrap;
      z-index: 20;
      text-align: center;
      animation: banner-pop 0.35s steps(5, end) forwards;
    }

    @keyframes sparkle-burst {
      0% { transform: translate(0, 0) scale(0.4); opacity: 1; }
      50% { opacity: 1; }
      100% { transform: translate(var(--tx), var(--ty)) scale(1.2); opacity: 0; }
    }
    .shiny-star {
      position: absolute;
      top: 50%;
      left: 50%;
      color: #facc15;
      font-size: 16px;
      line-height: 1;
      pointer-events: none;
      z-index: 15;
      text-shadow: 2px 2px 0 #181818, -1px -1px 0 #fef08a;
      animation: sparkle-burst 0.85s steps(6, end) forwards;
    }
    .shiny-glow {
      filter: drop-shadow(0 0 6px rgba(250, 204, 21, 0.85));
    }

    @keyframes pokeball-wobble {
      0%, 100% { transform: translate(-50%, -50%) rotate(0deg); }
      20% { transform: translate(-56%, -50%) rotate(-18deg); }
      40% { transform: translate(-44%, -50%) rotate(18deg); }
      60% { transform: translate(-54%, -50%) rotate(-12deg); }
      80% { transform: translate(-46%, -50%) rotate(12deg); }
    }
    @keyframes sprite-absorb {
      0% { transform: scale(1); filter: brightness(1); opacity: 1; }
      50% { transform: scale(0.4); filter: brightness(3); opacity: 0.9; }
      100% { transform: scale(0); filter: brightness(4); opacity: 0; }
    }
    .sprite-caught { animation: sprite-absorb 0.35s steps(4, end) forwards; }
    .pokeball-catch {
      position: absolute;
      top: 52%;
      left: 50%;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      border: 4px solid #181818;
      background: linear-gradient(to bottom, #ef4444 0%, #ef4444 46%, #181818 46%, #181818 54%, #ffffff 54%, #ffffff 100%);
      box-shadow: 0 4px 0 #181818;
      z-index: 16;
      animation: pokeball-wobble 0.95s steps(4, end) 2;
    }
    .pokeball-catch::after {
      content: '';
      position: absolute;
      top: 50%;
      left: 50%;
      width: 12px;
      height: 12px;
      transform: translate(-50%, -50%);
      background: #ffffff;
      border: 3px solid #181818;
      border-radius: 50%;
    }

    @keyframes evo-flash {
      0% { filter: brightness(1); transform: scale(1); }
      25% { filter: brightness(6) contrast(0); transform: scale(1.15); }
      50% { filter: brightness(1); transform: scale(0.95); }
      75% { filter: brightness(6) contrast(0); transform: scale(1.2); }
      100% { filter: brightness(1); transform: scale(1); }
    }
    .evo-anim { animation: evo-flash 1.1s steps(4, end); }
    .evo-banner {
      background: #38bdf8 !important;
      color: #181818 !important;
      text-shadow: none !important;
    }

    .dialog-box {
      margin-top: 10px;
      background: #ffffff;
      border: 4px solid #181818;
      border-radius: 8px;
      padding: 12px;
      height: 162px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
    }
    #log-text { font-size: 10px; line-height: 1.5; color: #181818; }
    #moves-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .move-item { background: #e2e8f0; border: 2px solid #181818; padding: 6px 8px; font-size: 9px; border-radius: 4px; }

    #spawn-card {
      display: none;
      width: 440px;
      background: #f8fafc;
      border: 6px solid #181818;
      border-radius: 12px;
      box-shadow: 0 10px 0 #181818;
      padding: 16px;
      text-align: center;
      color: #181818;
    }
    #spawn-banner {
      background: #ef4444;
      color: #ffffff;
      border: 3px solid #181818;
      border-radius: 6px;
      padding: 8px;
      font-size: 11px;
      margin-bottom: 10px;
      text-shadow: 1px 1px 0 #181818;
    }
    #spawn-banner.shiny {
      background: #facc15;
      color: #181818;
      text-shadow: none;
    }
    #spawn-name { font-size: 15px; margin: 8px 0; }
    #spawn-types { font-size: 10px; color: #475569; margin-bottom: 10px; }
    #spawn-hint { background: #181818; color: #facc15; padding: 8px; border-radius: 6px; font-size: 10px; }
  </style>
</head>
<body>
  <div id="gbc-frame">
    <div id="winner-banner"></div>
    <div class="arena-top">
      <div class="hud-box">
        <div class="hud-header"><span id="p2-name">OPPONENT</span><span>Lv50</span></div>
        <div class="hud-user" id="p2-user">@player2</div>
        <div class="hp-bar-bg"><div class="hp-bar-fill" id="p2-hp-bar"></div></div>
        <div class="hp-text" id="p2-hp-text">--/--</div>
      </div>
      <div class="sprite-wrap" id="p2-wrap"><img id="p2-sprite" class="sprite" src=""></div>
    </div>

    <div class="arena-bottom">
      <div class="sprite-wrap" id="p1-wrap"><img id="p1-sprite" class="sprite" src=""></div>
      <div class="hud-box">
        <div class="hud-header"><span id="p1-name">CHALLENGER</span><span>Lv50</span></div>
        <div class="hud-user" id="p1-user">@player1</div>
        <div class="hp-bar-bg"><div class="hp-bar-fill" id="p1-hp-bar"></div></div>
        <div class="hp-text" id="p1-hp-text">--/--</div>
      </div>
    </div>

    <div class="dialog-box">
      <div id="log-text">Waiting for battle...</div>
      <div id="moves-grid"></div>
    </div>
  </div>

  <div id="spawn-card">
    <div id="spawn-banner">WILD POKÉMON APPEARED!</div>
    <div class="sprite-wrap" id="spawn-wrap" style="margin: 0 auto;"><img id="spawn-sprite" class="sprite" src=""></div>
    <div id="spawn-name">PIKACHU</div>
    <div id="spawn-types">TYPE: ELECTRIC</div>
    <div id="spawn-hint">TYPE !catch IN CHAT!</div>
  </div>

  <script>
    // Adjust overall 8-bit volume here (0.03 = quiet, 0.08 = medium, 0.18 = loud)
    const MASTER_VOLUME = 0.08;

    let audioCtx = null;
    function getAudioCtx() {
      if (!audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (AudioContext) audioCtx = new AudioContext();
      }
      if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
      return audioCtx;
    }

    function playTone(freq, duration, type = 'square', delay = 0, volScale = 1.0) {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const startTime = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, startTime);
      gain.gain.setValueAtTime(MASTER_VOLUME * volScale, startTime);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    }

    function playSpawnSound(isShiny) {
      playTone(523.25, 0.10, 'square', 0.00); // C5
      playTone(659.25, 0.10, 'square', 0.10); // E5
      playTone(783.99, 0.22, 'square', 0.20); // G5
      if (isShiny) {
        playTone(1046.50, 0.10, 'triangle', 0.36, 1.2); // C6
        playTone(1318.51, 0.28, 'triangle', 0.46, 1.2); // E6
      }
    }

    function playHitSound(effType = 'normal') {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      if (effType === 'resist') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(180, now);
        osc.frequency.exponentialRampToValueAtTime(45, now + 0.15);
        gain.gain.setValueAtTime(MASTER_VOLUME * 0.9, now);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now);
        osc.stop(now + 0.15);
        return;
      }

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(320, now);
      osc.frequency.exponentialRampToValueAtTime(65, now + 0.18);
      gain.gain.setValueAtTime(MASTER_VOLUME * 1.2, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.18);

      if (effType === 'super') {
        playTone(880.00, 0.08, 'square', 0.02, 1.15); // A5
        playTone(1318.51, 0.18, 'square', 0.09, 1.25); // E6
      }
    }

    function playMissSound() {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(380, now);
      osc.frequency.exponentialRampToValueAtTime(620, now + 0.06);
      osc.frequency.exponentialRampToValueAtTime(190, now + 0.18);
      gain.gain.setValueAtTime(MASTER_VOLUME * 1.1, now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now);
      osc.stop(now + 0.18);
    }

    function playImmuneSound() {
      playTone(110.0, 0.09, 'sawtooth', 0.00, 1.0); // A2
      playTone(82.41, 0.16, 'sawtooth', 0.10, 1.0); // E2
    }

    function playLowHpChime() {
      playTone(783.99, 0.09, 'square', 0.22, 0.65); // G5
      playTone(523.25, 0.12, 'square', 0.34, 0.65); // C5
    }

    function playFaintSound() {
      const ctx = getAudioCtx();
      if (!ctx) return;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(260, now + 0.12);
      osc.frequency.exponentialRampToValueAtTime(55, now + 0.65);
      gain.gain.setValueAtTime(MASTER_VOLUME * 1.1, now + 0.12);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + 0.12);
      osc.stop(now + 0.65);
    }

    function playVictoryFanfare() {
      playTone(783.99, 0.11, 'square', 0.00, 1.1); // G5
      playTone(783.99, 0.11, 'square', 0.13, 1.1); // G5
      playTone(783.99, 0.11, 'square', 0.26, 1.1); // G5
      playTone(1046.50, 0.45, 'square', 0.39, 1.2); // C6
    }

    function playCatchFanfare() {
      playTone(587.33, 0.10, 'square', 0.15, 1.05); // D5
      playTone(739.99, 0.10, 'square', 0.27, 1.05); // F#5
      playTone(880.00, 0.10, 'square', 0.39, 1.05); // A5
      playTone(1174.66, 0.42, 'square', 0.51, 1.2); // D6
    }

    function playEvolutionChime() {
      playTone(523.25, 0.10, 'square', 0.00, 1.05); // C5
      playTone(659.25, 0.10, 'square', 0.12, 1.05); // E5
      playTone(783.99, 0.10, 'square', 0.24, 1.05); // G5
      playTone(1046.50, 0.14, 'square', 0.36, 1.15); // C6
      playTone(783.99, 0.10, 'square', 0.52, 1.05); // G5
      playTone(1046.50, 0.45, 'square', 0.64, 1.25); // C6
    }

    function triggerHitEffect(imgEl, wrapEl, dmgAmount, effType = 'normal') {
      const noDamage = effType === 'immune' || effType === 'miss';
      if (imgEl && !noDamage) {
        imgEl.classList.remove('hit-anim');
        void imgEl.offsetWidth;
        imgEl.classList.add('hit-anim');
      }
      if (wrapEl && (dmgAmount > 0 || noDamage)) {
        const badge = document.createElement('div');
        badge.className = 'dmg-popup' + (effType !== 'normal' ? ' ' + effType : '');
        if (effType === 'immune') {
          badge.textContent = 'NO EFFECT! 0 HP';
        } else if (effType === 'miss') {
          badge.textContent = 'MISSED!';
        } else {
          const prefix = effType === 'super'
            ? 'SUPER EFFECTIVE! -'
            : (effType === 'resist' ? 'NOT VERY EFFECTIVE... -' : '-');
          badge.textContent = prefix + dmgAmount + ' HP';
        }
        wrapEl.appendChild(badge);
        setTimeout(() => badge.remove(), 1150);
      }
    }

    function triggerShinySparkle(wrapEl) {
      if (!wrapEl) return;
      const offsets = [
        { tx: '-48px', ty: '-44px', delay: '0s' },
        { tx: '46px',  ty: '-40px', delay: '0.1s' },
        { tx: '-44px', ty: '36px',  delay: '0.18s' },
        { tx: '48px',  ty: '38px',  delay: '0.25s' },
        { tx: '0px',   ty: '-54px', delay: '0.12s' }
      ];
      offsets.forEach(o => {
        const star = document.createElement('div');
        star.className = 'shiny-star';
        star.textContent = '✦';
        star.style.setProperty('--tx', o.tx);
        star.style.setProperty('--ty', o.ty);
        star.style.animationDelay = o.delay;
        wrapEl.appendChild(star);
        setTimeout(() => star.remove(), 1150);
      });
    }

    let lastSpawnTimestamp = null;
    let lastBattleStateKey = null;
    let battleWasStarted = false;
    let lastP1Hp = null;
    let lastP2Hp = null;
    let p1LowHpWarned = false;
    let p2LowHpWarned = false;
    let lastBattleSnapshot = null;
    let faintHoldUntil = 0;
    let p1ShinySparkled = false;
    let p2ShinySparkled = false;
    let lastCaughtTimestamp = null;
    let catchHoldUntil = 0;
    let lastEvolutionTimestamp = null;
    let evoHoldUntil = 0;

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
      el.classList.toggle('low-hp', pct > 0 && pct <= 20);
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
          lastBattleSnapshot = b;

          const winBanner = document.getElementById('winner-banner');
          if (winBanner) winBanner.style.display = 'none';

          if (b.p2Mon) battleWasStarted = true;

          const p1Sprite = document.getElementById('p1-sprite');
          const p2Sprite = document.getElementById('p2-sprite');
          const p1Wrap = document.getElementById('p1-wrap');
          const p2Wrap = document.getElementById('p2-wrap');

          p1Sprite.classList.remove('faint-anim');
          p2Sprite.classList.remove('faint-anim');

          p1Sprite.classList.toggle('shiny-glow', Boolean(b.p1Mon.isShiny));
          if (b.p1Mon.isShiny && !p1ShinySparkled) {
            p1ShinySparkled = true;
            triggerShinySparkle(p1Wrap);
          }

          if (b.p2Mon) {
            p2Sprite.classList.toggle('shiny-glow', Boolean(b.p2Mon.isShiny));
            if (b.p2Mon.isShiny && !p2ShinySparkled) {
              p2ShinySparkled = true;
              triggerShinySparkle(p2Wrap);
            }
          }

          const logLower = (b.lastLog || '').toLowerCase();
          const effType = logLower.includes('super effective')
            ? 'super'
            : (logLower.includes('not very effective')
              ? 'resist'
              : (logLower.includes('no effect')
                ? 'immune'
                : (logLower.includes('missed') ? 'miss' : 'normal')));

          const stateKey = b.p1 + '_' + b.p2 + '_' + b.p1Mon.currentHp + '_' + (b.p2Mon ? b.p2Mon.currentHp : 'wait') + '_' + b.turn;
          const turnChanged = Boolean(lastBattleStateKey && lastBattleStateKey !== stateKey && b.p2Mon);

          if (lastP1Hp !== null && b.p1Mon.currentHp < lastP1Hp) {
            triggerHitEffect(p1Sprite, p1Wrap, lastP1Hp - b.p1Mon.currentHp, effType);
          } else if (b.p2Mon && lastP2Hp !== null && b.p2Mon.currentHp < lastP2Hp) {
            triggerHitEffect(p2Sprite, p2Wrap, lastP2Hp - b.p2Mon.currentHp, effType);
          } else if (turnChanged && (effType === 'immune' || effType === 'miss')) {
            const targetWrap = b.turn === b.p1 ? p1Wrap : p2Wrap;
            triggerHitEffect(null, targetWrap, 0, effType);
          }

          lastP1Hp = b.p1Mon.currentHp;
          lastP2Hp = b.p2Mon ? b.p2Mon.currentHp : null;

          if (turnChanged) {
            if (effType === 'miss') {
              playMissSound();
            } else if (effType === 'immune') {
              playImmuneSound();
            } else {
              playHitSound(effType);
            }
          }

          const p1Pct = (b.p1Mon.currentHp / b.p1Mon.maxHp) * 100;
          if (p1Pct > 0 && p1Pct <= 20 && !p1LowHpWarned) {
            p1LowHpWarned = true;
            playLowHpChime();
          }

          if (b.p2Mon) {
            const p2Pct = (b.p2Mon.currentHp / b.p2Mon.maxHp) * 100;
            if (p2Pct > 0 && p2Pct <= 20 && !p2LowHpWarned) {
              p2LowHpWarned = true;
              playLowHpChime();
            }
          }

          lastBattleStateKey = stateKey;

          document.getElementById('p1-name').textContent = (b.p1Mon.isShiny ? '✨' : '') + b.p1Mon.name;
          document.getElementById('p1-user').textContent = '@' + b.p1;
          document.getElementById('p1-hp-text').textContent = b.p1Mon.currentHp + '/' + b.p1Mon.maxHp;
          setSprite(p1Sprite, b.p1Mon, true);
          setHp(document.getElementById('p1-hp-bar'), b.p1Mon.currentHp, b.p1Mon.maxHp);

          if (b.p2Mon) {
            document.getElementById('p2-name').textContent = (b.p2Mon.isShiny ? '✨' : '') + b.p2Mon.name;
            document.getElementById('p2-user').textContent = '@' + b.p2;
            document.getElementById('p2-hp-text').textContent = b.p2Mon.currentHp + '/' + b.p2Mon.maxHp;
            setSprite(p2Sprite, b.p2Mon, false);
            p2Sprite.style.visibility = 'visible';
            setHp(document.getElementById('p2-hp-bar'), b.p2Mon.currentHp, b.p2Mon.maxHp);
          } else {
            document.getElementById('p2-name').textContent = 'WAITING...';
            document.getElementById('p2-user').textContent = '@' + b.p2;
            document.getElementById('p2-hp-text').textContent = '--/--';
            p2Sprite.style.visibility = 'hidden';
          }

          const activeMon = (b.turn === b.p2 && b.p2Mon) ? b.p2Mon : b.p1Mon;
          document.getElementById('log-text').textContent = (b.lastLog || '') + ' (@' + b.turn + '\\'s turn: !move 1-4)';
          document.getElementById('moves-grid').innerHTML = activeMon.moves.map((m, i) => '<div class="move-item">!' + (i + 1) + ' ' + m.name.toUpperCase() + '</div>').join('');
          return;
        }

        // Battle end faint drop + 2.5s victory hold
        if (lastBattleStateKey && battleWasStarted && lastBattleSnapshot) {
          faintHoldUntil = Date.now() + 2500;
          const b = lastBattleSnapshot;
          const p1Sprite = document.getElementById('p1-sprite');
          const p2Sprite = document.getElementById('p2-sprite');
          const p1Lost = b.turn === b.p1;
          const winnerName = p1Lost ? b.p2 : b.p1;
          const winBanner = document.getElementById('winner-banner');

          if (p1Lost) {
            document.getElementById('p1-hp-text').textContent = '0/' + b.p1Mon.maxHp;
            setHp(document.getElementById('p1-hp-bar'), 0, b.p1Mon.maxHp);
            p1Sprite.classList.add('faint-anim');
          } else if (b.p2Mon) {
            document.getElementById('p2-hp-text').textContent = '0/' + b.p2Mon.maxHp;
            setHp(document.getElementById('p2-hp-bar'), 0, b.p2Mon.maxHp);
            p2Sprite.classList.add('faint-anim');
          }

          if (winBanner) {
            winBanner.textContent = '🏆 WINNER: @' + winnerName.toUpperCase() + '!';
            winBanner.style.display = 'block';
          }
          document.getElementById('log-text').textContent = '@' + winnerName + ' won the battle!';

          playFaintSound();
          setTimeout(() => playVictoryFanfare(), 700);
          lastBattleStateKey = null;
          battleWasStarted = false;
          return;
        }

        if (Date.now() < faintHoldUntil) {
          return;
        }

        lastBattleStateKey = null;
        battleWasStarted = false;
        lastBattleSnapshot = null;
        lastP1Hp = null;
        lastP2Hp = null;
        p1LowHpWarned = false;
        p2LowHpWarned = false;
        p1ShinySparkled = false;
        p2ShinySparkled = false;
        frame.style.display = 'none';

        const s = data.spawn;
        const c = data.lastCaught;
        const ev = data.lastEvolution;
        const banner = document.getElementById('spawn-banner');
        const spawnSprite = document.getElementById('spawn-sprite');
        const spawnWrap = document.getElementById('spawn-wrap');

        // Poké Ball catch animation
        if (c && c.caughtAt && (Date.now() - c.caughtAt) < 4500 && lastCaughtTimestamp !== c.caughtAt) {
          lastCaughtTimestamp = c.caughtAt;
          catchHoldUntil = Date.now() + 3200;
          card.style.display = 'block';

          banner.classList.remove('evo-banner');
          banner.classList.add('shiny');
          banner.textContent = 'GOTCHA! @' + c.caughtBy.toUpperCase() + '!';
          setSprite(spawnSprite, c, false);
          spawnSprite.classList.remove('sprite-caught', 'evo-anim');
          void spawnSprite.offsetWidth;
          spawnSprite.classList.add('sprite-caught');

          const oldBall = spawnWrap.querySelector('.pokeball-catch');
          if (oldBall) oldBall.remove();
          const ball = document.createElement('div');
          ball.className = 'pokeball-catch';
          spawnWrap.appendChild(ball);

          document.getElementById('spawn-name').textContent = (c.isShiny ? '✨' : '') + c.name + ' CAUGHT!';
          document.getElementById('spawn-types').textContent = 'ADDED TO @' + c.caughtBy.toUpperCase() + '\\'S PARTY';

          playCatchFanfare();
          setTimeout(() => triggerShinySparkle(spawnWrap), 1850);
          setTimeout(() => { if (ball.parentNode) ball.remove(); }, 3200);
          return;
        }

        if (Date.now() < catchHoldUntil) {
          return;
        }

        // 3-of-a-kind Evolution alert card
        if (ev && ev.evolvedAt && (Date.now() - ev.evolvedAt) < 9000 && lastEvolutionTimestamp !== ev.evolvedAt) {
          lastEvolutionTimestamp = ev.evolvedAt;
          evoHoldUntil = Date.now() + 3800;
          card.style.display = 'block';

          banner.textContent = '✨ WHAT? IT EVOLVED! ✨';
          banner.classList.remove('shiny');
          banner.classList.add('evo-banner');

          setSprite(spawnSprite, { id: ev.fromId, isShiny: ev.isShiny }, false);
          spawnSprite.classList.remove('sprite-caught', 'evo-anim');
          void spawnSprite.offsetWidth;
          spawnSprite.classList.add('evo-anim');

          document.getElementById('spawn-name').textContent = ev.fromName + ' ➔ ' + (ev.isShiny ? '✨' : '') + ev.toName + '!';
          document.getElementById('spawn-types').textContent = '@' + ev.trainer.toUpperCase() + ' EVOLVED 3-OF-A-KIND!';

          playEvolutionChime();
          setTimeout(() => {
            setSprite(spawnSprite, { id: ev.toId, isShiny: ev.isShiny }, false);
            spawnSprite.classList.toggle('shiny-glow', Boolean(ev.isShiny));
            triggerShinySparkle(spawnWrap);
          }, 550);
          return;
        }

        if (Date.now() < evoHoldUntil) {
          return;
        }
        banner.classList.remove('evo-banner');

        // Wild Pokémon spawn card
        if (s && s.spawnedAt && (Date.now() - s.spawnedAt) < 20000) {
          card.style.display = 'block';
          spawnSprite.classList.remove('sprite-caught', 'evo-anim');
          const oldBall = spawnWrap.querySelector('.pokeball-catch');
          if (oldBall) oldBall.remove();

          spawnSprite.classList.toggle('shiny-glow', Boolean(s.isShiny));
          if (lastSpawnTimestamp !== s.spawnedAt) {
            lastSpawnTimestamp = s.spawnedAt;
            playSpawnSound(Boolean(s.isShiny));
            if (s.isShiny) triggerShinySparkle(spawnWrap);
          }

          banner.textContent = s.isShiny ? '✨ RARE SHINY APPEARED! ✨' : 'WILD POKÉMON APPEARED!';
          banner.classList.toggle('shiny', Boolean(s.isShiny));
          setSprite(spawnSprite, s, false);
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

initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`Kicklet Pokémon server listening on port ${PORT}`);
  });
});
