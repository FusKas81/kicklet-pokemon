import express from 'express';
import axios from 'axios';
import mongoose from 'mongoose';

const app = express();
app.use(express.json());

// Connect to MongoDB safely with clear error logging
if (!process.env.MONGO_URI) {
  console.error('❌ ERROR: MONGO_URI environment variable is missing in Render!');
} else {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('✅ Connected to MongoDB successfully!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err.message));
}

const StateSchema = new mongoose.Schema({
  _id: String,
  users: { type: Object, default: {} },
  activeSpawn: { type: Object, default: null },
  pendingTrades: { type: Object, default: {} },
  activeBattles: { type: Object, default: {} }
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
  await doc.save();
}

const POKEAPI = 'https://pokeapi.co/api/v2';
const MAX_POKEMON_ID = 1025;
const MAX_INVENTORY = 10;

function checkSecret(req, res, next) {
  if (process.env.BOT_SECRET && req.query.secret !== process.env.BOT_SECRET) {
    return res.status(401).send('Unauthorized');
  }
  next();
}

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

app.get('/ping', (req, res) => res.send('Bot is awake!'));

app.get('/spawn', checkSecret, async (req, res) => {
  try {
    const db = await getDB();
    const randomId = Math.floor(Math.random() * MAX_POKEMON_ID) + 1;
    const mon = await generatePokemon(randomId);
    db.activeSpawn = { ...mon, caughtBy: [] };
    await saveDB(db);

    const shinyTag = mon.isShiny ? '✨SHINY ' : '';
    res.send(`🌿 A wild ${shinyTag}${mon.name} (${mon.types.join('/').toUpperCase()}) appeared! Type !catch to throw a Pokéball!`);
  } catch (err) {
    console.error(err);
    res.send('⚠️ Spawn error - check Render logs.');
  }
});

app.get('/command', checkSecret, async (req, res) => {
  try {
    const db = await getDB();
    const user = (req.query.user || '').toLowerCase().replace('@', '');
    const cmd = (req.query.cmd || '').toLowerCase();
    const args = (req.query.args || '').trim().split(/\s+/).filter(Boolean);

    if (!user) return res.send('Missing user.');
    if (!db.users[user]) db.users[user] = { inventory: [], totalCaught: 0, pokedex: [] };
    if (db.users[user].totalCaught === undefined) db.users[user].totalCaught = db.users[user].inventory.length;
    if (!db.users[user].pokedex) db.users[user].pokedex = [...new Set(db.users[user].inventory.map(p => p.id))];

    if (cmd === 'catch') {
      const spawn = db.activeSpawn;
      if (!spawn) return res.send(`@${user} No wild Pokémon right now!`);
      if (spawn.caughtBy.includes(user)) return res.send(`@${user} You already caught this ${spawn.name}!`);
      if (db.users[user].inventory.length >= MAX_INVENTORY) return res.send(`@${user} Party full (10/10)! Use !release <1-10>.`);
      if (Math.random() > 0.65) return res.send(`@${user} The wild ${spawn.name} broke free!`);

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
      return res.send(reply);
    }

    if (cmd === 'party') {
      const inv = db.users[user].inventory;
      if (inv.length === 0) return res.send(`@${user} Your party is empty!`);
      const list = inv.map((p, i) => `[${i + 1}] ${p.isShiny ? '✨' : ''}${p.name}`).join(' | ');
      return res.send(`@${user}'s Party (${inv.length}/10): ${list}`);
    }

    if (cmd === 'info') {
      const slot = parseInt(args[0]) - 1;
      const mon = db.users[user].inventory[slot];
      if (!mon) return res.send(`@${user} Use !info <1-10>.`);
      const shinyTag = mon.isShiny ? '✨SHINY ' : '';
      const movesStr = mon.moves.map((m, i) => `${i + 1}:${m.name}(${m.type}/${m.power}pwr)`).join(', ');
      return res.send(`@${user} #${slot + 1} ${shinyTag}${mon.name} | HP:${mon.maxHp} | Moves: ${movesStr}`);
    }

    if (cmd === 'release') {
      const slot = parseInt(args[0]) - 1;
      const inv = db.users[user].inventory;
      if (!inv[slot]) return res.send(`@${user} Use !release <1-10>.`);
      const released = inv.splice(slot, 1)[0];
      await saveDB(db);
      return res.send(`@${user} Released ${released.name}.`);
    }

    if (cmd === 'pokedex') {
      const uniqueCount = db.users[user].pokedex.length;
      const totalCaught = db.users[user].totalCaught;
      const percent = ((uniqueCount / MAX_POKEMON_ID) * 100).toFixed(1);
      return res.send(`📖 @${user}'s Pokédex: ${uniqueCount}/${MAX_POKEMON_ID} unique species (${percent}%) | Total Caught: ${totalCaught}`);
    }

    if (cmd === 'leaderboard') {
      const rankings = Object.entries(db.users)
        .map(([name, data]) => ({ name, caught: data.totalCaught ?? data.inventory.length }))
        .filter(entry => entry.caught > 0)
        .sort((a, b) => b.caught - a.caught)
        .slice(0, 5);

      if (rankings.length === 0) return res.send('🏆 Nobody has caught any Pokémon yet! Be the first with !catch!');
      const board = rankings.map((entry, idx) => `#${idx + 1} @${entry.name} (${entry.caught})`).join(' | ');
      return res.send(`🏆 Top Pokémon Trainers: ${board}`);
    }

    if (cmd === 'trade') {
      const target = (args[0] || '').toLowerCase().replace('@', '');
      const slot = parseInt(args[1]) - 1;
      const mon = db.users[user].inventory[slot];
      if (!target || !db.users[target]) return res.send(`@${user} User not found.`);
      if (target === user) return res.send(`@${user} Can't trade with yourself!`);
      if (!mon) return res.send(`@${user} Usage: !trade @user <slot>`);

      db.pendingTrades[target] = { fromUser: user, offeredUid: mon.uid, offeredName: mon.name };
      await saveDB(db);
      return res.send(`🔄 @${user} wants to trade ${mon.isShiny ? '✨' : ''}${mon.name} to @${target}! Type !accept <yourSlot> to accept.`);
    }

    if (cmd === 'accept') {
      const trade = db.pendingTrades[user];
      if (!trade) return res.send(`@${user} No pending trades.`);
      const mySlot = parseInt(args[0]) - 1;
      const myInv = db.users[user].inventory;
      const senderInv = db.users[trade.fromUser].inventory;
      const myMon = myInv[mySlot];
      const senderIndex = senderInv.findIndex(p => p.uid === trade.offeredUid);

      if (!myMon || senderIndex === -1) {
        delete db.pendingTrades[user];
        await saveDB(db);
        return res.send(`@${user} Trade failed.`);
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
      return res.send(reply);
    }

    if (cmd === 'battle') {
      const opponent = (args[0] || '').toLowerCase().replace('@', '');
      const slot = parseInt(args[1]) - 1;
      const myMon = db.users[user].inventory[slot];
      if (!opponent || !db.users[opponent]) return res.send(`@${user} Opponent not found.`);
      if (!myMon) return res.send(`@${user} Usage: !battle @user <slot>`);

      const battleKey = [user, opponent].sort().join('_vs_');
      let battle = db.activeBattles[battleKey];

      if (!battle) {
        db.activeBattles[battleKey] = { p1: user, p2: opponent, p1Mon: { ...myMon, currentHp: myMon.maxHp }, p2Mon: null, turn: user };
        await saveDB(db);
        return res.send(`⚔️ @${user} challenged @${opponent} with ${myMon.name}! @${opponent}, type !battle @${user} <slot> to accept!`);
      } else if (battle.p2 === user && !battle.p2Mon) {
        battle.p2Mon = { ...myMon, currentHp: myMon.maxHp };
        await saveDB(db);
        return res.send(`🔥 Battle started! ${battle.p1Mon.name} vs ${battle.p2Mon.name}! @${battle.turn}, use !move <1-4>!`);
      }
      return res.send(`@${user} Battle already active! Use !move <1-4>.`);
    }

    if (cmd === 'move') {
      const moveIdx = parseInt(args[0]) - 1;
      const battleKey = Object.keys(db.activeBattles).find(k => k.includes(user));
      const battle = db.activeBattles[battleKey];
      if (!battle || !battle.p2Mon) return res.send(`@${user} Not in a battle.`);
      if (battle.turn !== user) return res.send(`@${user} Not your turn!`);

      const isP1 = battle.p1 === user;
      const attacker = isP1 ? battle.p1Mon : battle.p2Mon;
      const defender = isP1 ? battle.p2Mon : battle.p1Mon;
      const opponentUser = isP1 ? battle.p2 : battle.p1;
      const move = attacker.moves[moveIdx];
      if (!move) return res.send(`@${user} Pick move 1-4.`);

      if (Math.random() * 100 > move.accuracy) {
        battle.turn = opponentUser;
        await saveDB(db);
        return res.send(`💨 ${attacker.name} used ${move.name}, but missed! @${opponentUser}'s turn.`);
      }

      const stab = attacker.types.includes(move.type) ? 1.5 : 1.0;
      const effectiveness = getTypeEffectiveness(move.type, defender.types);
      const rawDamage = (((2 * 50 / 5 + 2) * move.power * (attacker.atk / defender.def)) / 50 + 2);
      const finalDamage = Math.max(1, Math.floor(rawDamage * stab * effectiveness * (0.85 + Math.random() * 0.15)));
      defender.currentHp = Math.max(0, defender.currentHp - finalDamage);

      let effText = effectiveness > 1 ? " Super effective!" : (effectiveness === 0 ? " No effect!" : (effectiveness < 1 ? " Not very effective..." : ""));

      if (defender.currentHp === 0) {
        delete db.activeBattles[battleKey];
        await saveDB(db);
        return res.send(`💥 ${attacker.name} used ${move.name} (-${finalDamage} HP)!${effText} ${defender.name} fainted! 🏆 @${user} wins!`);
      }

      battle.turn = opponentUser;
      await saveDB(db);
      return res.send(`⚔️ ${attacker.name} used ${move.name} (-${finalDamage} HP)!${effText} ${defender.name} (${defender.currentHp}/${defender.maxHp} HP). @${opponentUser}'s turn!`);
    }

    return res.send('Unknown command.');
  } catch (err) {
    console.error(err);
    return res.send('⚠️ PokéCenter hiccup, try again!');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Bot online on port ${PORT}!`));
