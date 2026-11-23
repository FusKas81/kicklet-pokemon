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
  lastBattleResult: { type: Object, default: null },
  lastAutoSpawnAt: { type: Number, default: 0 },
  autoSpawnBlockedUntil: { type: Number, default: 0 },
  webSessions: { type: Object, default: {} }
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
  doc.markModified('webSessions');
  await doc.save();
}

// All load -> change -> save cycles on the game state run one at a time. Without this, two commands
// arriving together (e.g. two !catch) both load the same state and the last save erases the other's changes.
let dbChain = Promise.resolve();
function lockDB() {
  let release;
  const prev = dbChain;
  dbChain = new Promise((r) => { release = r; });
  return prev.then(() => release);
}

const POKEAPI = 'https://pokeapi.co/api/v2';
const MAX_POKEMON_ID = 251; // Generations 1 + 2 (Bulbasaur #1 - Celebi #251)
const MAX_INVENTORY = 50;
const MAX_CATCH_TRIES = 3; // !catch attempts per trainer for each spawn
const SPAWN_INTERVAL_MINUTES = 5;  // keep in sync with the cron-job.org schedule (only used in chat messages)
const SPAWN_CMD_COOLDOWN_MS = 10 * 60 * 1000; // !spawn cooldown (per user)
const CATCH_WINDOW_MS = 90 * 1000; // how long a spawned Pokémon can be caught (and stays on the overlay)

function spawnExpiresAt(spawn) {
  return spawn.expiresAt || (spawn.spawnedAt + CATCH_WINDOW_MS);
}
const REDIRECT_URI = 'https://kicklet-pokemon.onrender.com/kick-callback';
const POKEDEX_SITE = 'https://kicklet-pokemon.onrender.com/pokedex';
const SITE_NOTE = `🌐 Manage your Pokemon Party here ➡️ ${POKEDEX_SITE}`;

// Store temporary PKCE verifier in memory during login
let tempPkceVerifier = null;

// Website logins waiting for the trainer to type !verify <code> in chat (code -> { user, secretHash, expires, verified })
const webLogins = new Map();

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

    const unlockAuth = await lockDB();
    let db;
    try { db = await getDB();
    db.kickAuth = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000
    };
    await saveDB(db);
    } finally { unlockAuth(); }
    await subscribeKickChatWebhook(data.access_token);

    res.send('✅ Kick connected! Your Pokémon bot is now listening to chat and posting directly.');
  } catch (err) {
    console.error('❌ OAuth Callback Error:', err.response?.data || err.message);
    res.send('❌ Kick login failed: ' + JSON.stringify(err.response?.data || err.message));
  }
});

// --- POKÉMON GAME LOGIC ---
const GEN2 = {"mons":{"1":{"n":"BULBASAUR","t":["grass","poison"],"s":[45,49,49,45,65,65],"m":["TACKLE","GROWL"],"l":[[7,"LEECH_SEED"],[13,"VINE_WHIP"],[20,"POISONPOWDER"],[27,"RAZOR_LEAF"],[34,"GROWTH"],[41,"SLEEP_POWDER"],[48,"SOLARBEAM"]],"e":[2]},"2":{"n":"IVYSAUR","t":["grass","poison"],"s":[60,62,63,60,80,80],"m":["TACKLE","GROWL","LEECH_SEED"],"l":[[7,"LEECH_SEED"],[13,"VINE_WHIP"],[22,"POISONPOWDER"],[30,"RAZOR_LEAF"],[38,"GROWTH"],[46,"SLEEP_POWDER"],[54,"SOLARBEAM"]],"e":[3]},"3":{"n":"VENUSAUR","t":["grass","poison"],"s":[80,82,83,80,100,100],"m":["TACKLE","GROWL","LEECH_SEED","VINE_WHIP"],"l":[[7,"LEECH_SEED"],[13,"VINE_WHIP"],[22,"POISONPOWDER"],[30,"RAZOR_LEAF"],[43,"GROWTH"],[55,"SLEEP_POWDER"],[65,"SOLARBEAM"]],"e":[]},"4":{"n":"CHARMANDER","t":["fire"],"s":[39,52,43,65,60,50],"m":["SCRATCH","GROWL"],"l":[[9,"EMBER"],[15,"LEER"],[22,"RAGE"],[30,"SLASH"],[38,"FLAMETHROWER"],[46,"FIRE_SPIN"]],"e":[5]},"5":{"n":"CHARMELEON","t":["fire"],"s":[58,64,58,80,80,65],"m":["SCRATCH","GROWL","EMBER"],"l":[[9,"EMBER"],[15,"LEER"],[24,"RAGE"],[33,"SLASH"],[42,"FLAMETHROWER"],[56,"FIRE_SPIN"]],"e":[6]},"6":{"n":"CHARIZARD","t":["fire","flying"],"s":[78,84,78,100,109,85],"m":["SCRATCH","GROWL","EMBER","LEER"],"l":[[9,"EMBER"],[15,"LEER"],[24,"RAGE"],[36,"SLASH"],[46,"FLAMETHROWER"],[55,"FIRE_SPIN"]],"e":[]},"7":{"n":"SQUIRTLE","t":["water"],"s":[44,48,65,43,50,64],"m":["TACKLE","TAIL_WHIP"],"l":[[8,"BUBBLE"],[15,"WATER_GUN"],[22,"BITE"],[28,"WITHDRAW"],[35,"SKULL_BASH"],[42,"HYDRO_PUMP"]],"e":[8]},"8":{"n":"WARTORTLE","t":["water"],"s":[59,63,80,58,65,80],"m":["TACKLE","TAIL_WHIP","BUBBLE"],"l":[[8,"BUBBLE"],[15,"WATER_GUN"],[24,"BITE"],[31,"WITHDRAW"],[39,"SKULL_BASH"],[47,"HYDRO_PUMP"]],"e":[9]},"9":{"n":"BLASTOISE","t":["water"],"s":[79,83,100,78,85,105],"m":["TACKLE","TAIL_WHIP","BUBBLE","WATER_GUN"],"l":[[8,"BUBBLE"],[15,"WATER_GUN"],[24,"BITE"],[31,"WITHDRAW"],[42,"SKULL_BASH"],[52,"HYDRO_PUMP"]],"e":[]},"10":{"n":"CATERPIE","t":["bug"],"s":[45,30,35,45,20,20],"m":["TACKLE","STRING_SHOT"],"l":[],"e":[11]},"11":{"n":"METAPOD","t":["bug"],"s":[50,20,55,30,25,25],"m":["HARDEN"],"l":[],"e":[12]},"12":{"n":"BUTTERFREE","t":["bug","flying"],"s":[60,45,50,70,80,80],"m":["CONFUSION"],"l":[[12,"CONFUSION"],[15,"POISONPOWDER"],[16,"STUN_SPORE"],[17,"SLEEP_POWDER"],[21,"SUPERSONIC"],[26,"WHIRLWIND"],[32,"PSYBEAM"]],"e":[]},"13":{"n":"WEEDLE","t":["bug","poison"],"s":[40,35,30,50,20,20],"m":["POISON_STING","STRING_SHOT"],"l":[],"e":[14]},"14":{"n":"KAKUNA","t":["bug","poison"],"s":[45,25,50,35,25,25],"m":["HARDEN"],"l":[],"e":[15]},"15":{"n":"BEEDRILL","t":["bug","poison"],"s":[65,80,40,75,45,80],"m":["FURY_ATTACK"],"l":[[12,"FURY_ATTACK"],[16,"FOCUS_ENERGY"],[20,"TWINEEDLE"],[25,"RAGE"],[30,"PIN_MISSILE"],[35,"AGILITY"]],"e":[]},"16":{"n":"PIDGEY","t":["normal","flying"],"s":[40,45,40,56,35,35],"m":["GUST"],"l":[[5,"SAND_ATTACK"],[12,"QUICK_ATTACK"],[19,"WHIRLWIND"],[28,"WING_ATTACK"],[36,"AGILITY"],[44,"MIRROR_MOVE"]],"e":[17]},"17":{"n":"PIDGEOTTO","t":["normal","flying"],"s":[63,60,55,71,50,50],"m":["GUST","SAND_ATTACK"],"l":[[5,"SAND_ATTACK"],[12,"QUICK_ATTACK"],[21,"WHIRLWIND"],[31,"WING_ATTACK"],[40,"AGILITY"],[49,"MIRROR_MOVE"]],"e":[18]},"18":{"n":"PIDGEOT","t":["normal","flying"],"s":[83,80,75,91,70,70],"m":["GUST","SAND_ATTACK","QUICK_ATTACK"],"l":[[5,"SAND_ATTACK"],[12,"QUICK_ATTACK"],[21,"WHIRLWIND"],[31,"WING_ATTACK"],[44,"AGILITY"],[54,"MIRROR_MOVE"]],"e":[]},"19":{"n":"RATTATA","t":["normal"],"s":[30,56,35,72,25,35],"m":["TACKLE","TAIL_WHIP"],"l":[[7,"QUICK_ATTACK"],[14,"HYPER_FANG"],[23,"FOCUS_ENERGY"],[34,"SUPER_FANG"]],"e":[20]},"20":{"n":"RATICATE","t":["normal"],"s":[55,81,60,97,50,70],"m":["TACKLE","TAIL_WHIP","QUICK_ATTACK"],"l":[[7,"QUICK_ATTACK"],[14,"HYPER_FANG"],[27,"FOCUS_ENERGY"],[41,"SUPER_FANG"]],"e":[]},"21":{"n":"SPEAROW","t":["normal","flying"],"s":[40,60,30,70,31,31],"m":["PECK","GROWL"],"l":[[9,"LEER"],[15,"FURY_ATTACK"],[22,"MIRROR_MOVE"],[29,"DRILL_PECK"],[36,"AGILITY"]],"e":[22]},"22":{"n":"FEAROW","t":["normal","flying"],"s":[65,90,65,100,61,61],"m":["PECK","GROWL","LEER"],"l":[[9,"LEER"],[15,"FURY_ATTACK"],[25,"MIRROR_MOVE"],[34,"DRILL_PECK"],[43,"AGILITY"]],"e":[]},"23":{"n":"EKANS","t":["poison"],"s":[35,60,44,55,40,54],"m":["WRAP","LEER"],"l":[[10,"POISON_STING"],[17,"BITE"],[24,"GLARE"],[31,"SCREECH"],[38,"ACID"]],"e":[24]},"24":{"n":"ARBOK","t":["poison"],"s":[60,85,69,80,65,79],"m":["WRAP","LEER","POISON_STING"],"l":[[10,"POISON_STING"],[17,"BITE"],[27,"GLARE"],[36,"SCREECH"],[47,"ACID"]],"e":[]},"25":{"n":"PIKACHU","t":["electric"],"s":[35,55,30,90,50,40],"m":["THUNDERSHOCK","GROWL"],"l":[[9,"THUNDER_WAVE"],[16,"QUICK_ATTACK"],[26,"SWIFT"],[33,"AGILITY"],[43,"THUNDER"]],"e":[26]},"26":{"n":"RAICHU","t":["electric"],"s":[60,90,55,100,90,80],"m":["THUNDERSHOCK","GROWL","THUNDER_WAVE"],"l":[],"e":[]},"27":{"n":"SANDSHREW","t":["ground"],"s":[50,75,85,40,20,30],"m":["SCRATCH"],"l":[[10,"SAND_ATTACK"],[17,"SLASH"],[24,"POISON_STING"],[31,"SWIFT"],[38,"FURY_SWIPES"]],"e":[28]},"28":{"n":"SANDSLASH","t":["ground"],"s":[75,100,110,65,45,55],"m":["SCRATCH","SAND_ATTACK"],"l":[[10,"SAND_ATTACK"],[17,"SLASH"],[27,"POISON_STING"],[36,"SWIFT"],[47,"FURY_SWIPES"]],"e":[]},"29":{"n":"NIDORAN-F","t":["poison"],"s":[55,47,52,41,40,40],"m":["GROWL","TACKLE"],"l":[[8,"SCRATCH"],[14,"POISON_STING"],[21,"TAIL_WHIP"],[29,"BITE"],[36,"FURY_SWIPES"],[43,"DOUBLE_KICK"]],"e":[30]},"30":{"n":"NIDORINA","t":["poison"],"s":[70,62,67,56,55,55],"m":["GROWL","TACKLE","SCRATCH"],"l":[[8,"SCRATCH"],[14,"POISON_STING"],[23,"TAIL_WHIP"],[32,"BITE"],[41,"FURY_SWIPES"],[50,"DOUBLE_KICK"]],"e":[31]},"31":{"n":"NIDOQUEEN","t":["poison","ground"],"s":[90,82,87,76,75,85],"m":["TACKLE","SCRATCH","TAIL_WHIP","BODY_SLAM"],"l":[[8,"SCRATCH"],[14,"POISON_STING"],[23,"BODY_SLAM"]],"e":[]},"32":{"n":"NIDORAN-M","t":["poison"],"s":[46,57,40,50,40,40],"m":["LEER","TACKLE"],"l":[[8,"HORN_ATTACK"],[14,"POISON_STING"],[21,"FOCUS_ENERGY"],[29,"FURY_ATTACK"],[36,"HORN_DRILL"],[43,"DOUBLE_KICK"]],"e":[33]},"33":{"n":"NIDORINO","t":["poison"],"s":[61,72,57,65,55,55],"m":["LEER","TACKLE","HORN_ATTACK"],"l":[[8,"HORN_ATTACK"],[14,"POISON_STING"],[23,"FOCUS_ENERGY"],[32,"FURY_ATTACK"],[41,"HORN_DRILL"],[50,"DOUBLE_KICK"]],"e":[34]},"34":{"n":"NIDOKING","t":["poison","ground"],"s":[81,92,77,85,85,75],"m":["TACKLE","HORN_ATTACK","POISON_STING","THRASH"],"l":[[8,"HORN_ATTACK"],[14,"POISON_STING"],[23,"THRASH"]],"e":[]},"35":{"n":"CLEFAIRY","t":["normal"],"s":[70,45,48,35,60,65],"m":["POUND","GROWL"],"l":[[13,"SING"],[18,"DOUBLESLAP"],[24,"MINIMIZE"],[31,"METRONOME"],[39,"DEFENSE_CURL"],[48,"LIGHT_SCREEN"]],"e":[36]},"36":{"n":"CLEFABLE","t":["normal"],"s":[95,70,73,60,85,90],"m":["SING","DOUBLESLAP","MINIMIZE","METRONOME"],"l":[],"e":[]},"37":{"n":"VULPIX","t":["fire"],"s":[38,41,40,65,50,65],"m":["EMBER","TAIL_WHIP"],"l":[[16,"QUICK_ATTACK"],[21,"ROAR"],[28,"CONFUSE_RAY"],[35,"FLAMETHROWER"],[42,"FIRE_SPIN"]],"e":[38]},"38":{"n":"NINETALES","t":["fire"],"s":[73,76,75,100,81,100],"m":["EMBER","TAIL_WHIP","QUICK_ATTACK","ROAR"],"l":[],"e":[]},"39":{"n":"JIGGLYPUFF","t":["normal"],"s":[115,45,20,20,45,25],"m":["SING"],"l":[[9,"POUND"],[14,"DISABLE"],[19,"DEFENSE_CURL"],[24,"DOUBLESLAP"],[29,"REST"],[34,"BODY_SLAM"],[39,"DOUBLE_EDGE"]],"e":[40]},"40":{"n":"WIGGLYTUFF","t":["normal"],"s":[140,70,45,45,75,50],"m":["SING","DISABLE","DEFENSE_CURL","DOUBLESLAP"],"l":[],"e":[]},"41":{"n":"ZUBAT","t":["poison","flying"],"s":[40,45,35,55,30,40],"m":["LEECH_LIFE"],"l":[[10,"SUPERSONIC"],[15,"BITE"],[21,"CONFUSE_RAY"],[28,"WING_ATTACK"],[36,"HAZE"]],"e":[42]},"42":{"n":"GOLBAT","t":["poison","flying"],"s":[75,80,70,90,65,75],"m":["LEECH_LIFE","SCREECH","BITE"],"l":[[10,"SUPERSONIC"],[15,"BITE"],[21,"CONFUSE_RAY"],[32,"WING_ATTACK"],[43,"HAZE"]],"e":[169]},"43":{"n":"ODDISH","t":["grass","poison"],"s":[45,50,55,30,75,65],"m":["ABSORB"],"l":[[15,"POISONPOWDER"],[17,"STUN_SPORE"],[19,"SLEEP_POWDER"],[24,"ACID"],[33,"PETAL_DANCE"],[46,"SOLARBEAM"]],"e":[44]},"44":{"n":"GLOOM","t":["grass","poison"],"s":[60,65,70,40,85,75],"m":["ABSORB","POISONPOWDER","STUN_SPORE"],"l":[[15,"POISONPOWDER"],[17,"STUN_SPORE"],[19,"SLEEP_POWDER"],[28,"ACID"],[38,"PETAL_DANCE"],[52,"SOLARBEAM"]],"e":[45,182]},"45":{"n":"VILEPLUME","t":["grass","poison"],"s":[75,80,85,50,110,90],"m":["STUN_SPORE","SLEEP_POWDER","ACID","PETAL_DANCE"],"l":[[15,"POISONPOWDER"],[17,"STUN_SPORE"],[19,"SLEEP_POWDER"]],"e":[]},"46":{"n":"PARAS","t":["bug","grass"],"s":[35,70,55,25,40,55],"m":["SCRATCH"],"l":[[13,"STUN_SPORE"],[20,"LEECH_LIFE"],[27,"SPORE"],[34,"SLASH"],[41,"GROWTH"]],"e":[47]},"47":{"n":"PARASECT","t":["bug","grass"],"s":[60,95,80,30,60,80],"m":["SCRATCH","STUN_SPORE","LEECH_LIFE"],"l":[[13,"STUN_SPORE"],[20,"LEECH_LIFE"],[30,"SPORE"],[39,"SLASH"],[48,"GROWTH"]],"e":[]},"48":{"n":"VENONAT","t":["bug","poison"],"s":[60,55,50,45,40,55],"m":["TACKLE","DISABLE"],"l":[[24,"POISONPOWDER"],[27,"LEECH_LIFE"],[30,"STUN_SPORE"],[35,"PSYBEAM"],[38,"SLEEP_POWDER"],[43,"PSYCHIC_M"]],"e":[49]},"49":{"n":"VENOMOTH","t":["bug","poison"],"s":[70,65,60,90,90,75],"m":["TACKLE","DISABLE","POISONPOWDER","LEECH_LIFE"],"l":[[24,"POISONPOWDER"],[27,"LEECH_LIFE"],[30,"STUN_SPORE"],[38,"PSYBEAM"],[43,"SLEEP_POWDER"],[50,"PSYCHIC_M"]],"e":[]},"50":{"n":"DIGLETT","t":["ground"],"s":[10,55,25,95,35,45],"m":["SCRATCH"],"l":[[15,"GROWL"],[19,"DIG"],[24,"SAND_ATTACK"],[31,"SLASH"],[40,"EARTHQUAKE"]],"e":[51]},"51":{"n":"DUGTRIO","t":["ground"],"s":[35,80,50,120,50,70],"m":["SCRATCH","GROWL","DIG"],"l":[[15,"GROWL"],[19,"DIG"],[24,"SAND_ATTACK"],[35,"SLASH"],[47,"EARTHQUAKE"]],"e":[]},"52":{"n":"MEOWTH","t":["normal"],"s":[40,45,35,90,40,40],"m":["SCRATCH","GROWL"],"l":[[12,"BITE"],[17,"PAY_DAY"],[24,"SCREECH"],[33,"FURY_SWIPES"],[44,"SLASH"]],"e":[53]},"53":{"n":"PERSIAN","t":["normal"],"s":[65,70,60,115,65,65],"m":["SCRATCH","GROWL","BITE","SCREECH"],"l":[[12,"BITE"],[17,"PAY_DAY"],[24,"SCREECH"],[37,"FURY_SWIPES"],[51,"SLASH"]],"e":[]},"54":{"n":"PSYDUCK","t":["water"],"s":[50,52,48,55,65,50],"m":["SCRATCH"],"l":[[28,"TAIL_WHIP"],[31,"DISABLE"],[36,"CONFUSION"],[43,"FURY_SWIPES"],[52,"HYDRO_PUMP"]],"e":[55]},"55":{"n":"GOLDUCK","t":["water"],"s":[80,82,78,85,95,80],"m":["SCRATCH","TAIL_WHIP","DISABLE"],"l":[[28,"TAIL_WHIP"],[31,"DISABLE"],[39,"CONFUSION"],[48,"FURY_SWIPES"],[59,"HYDRO_PUMP"]],"e":[]},"56":{"n":"MANKEY","t":["fighting"],"s":[40,80,35,70,35,45],"m":["SCRATCH","LEER"],"l":[[15,"KARATE_CHOP"],[21,"FURY_SWIPES"],[27,"FOCUS_ENERGY"],[33,"SEISMIC_TOSS"],[39,"THRASH"]],"e":[57]},"57":{"n":"PRIMEAPE","t":["fighting"],"s":[65,105,60,95,60,70],"m":["SCRATCH","LEER","KARATE_CHOP","FURY_SWIPES"],"l":[[15,"KARATE_CHOP"],[21,"FURY_SWIPES"],[27,"FOCUS_ENERGY"],[37,"SEISMIC_TOSS"],[46,"THRASH"]],"e":[]},"58":{"n":"GROWLITHE","t":["fire"],"s":[55,70,45,60,70,50],"m":["BITE","ROAR"],"l":[[18,"EMBER"],[23,"LEER"],[30,"TAKE_DOWN"],[39,"AGILITY"],[50,"FLAMETHROWER"]],"e":[59]},"59":{"n":"ARCANINE","t":["fire"],"s":[90,110,80,95,100,80],"m":["ROAR","EMBER","LEER","TAKE_DOWN"],"l":[],"e":[]},"60":{"n":"POLIWAG","t":["water"],"s":[40,50,40,90,40,40],"m":["BUBBLE"],"l":[[16,"HYPNOSIS"],[19,"WATER_GUN"],[25,"DOUBLESLAP"],[31,"BODY_SLAM"],[38,"AMNESIA"],[45,"HYDRO_PUMP"]],"e":[61]},"61":{"n":"POLIWHIRL","t":["water"],"s":[65,65,65,90,50,50],"m":["BUBBLE","HYPNOSIS","WATER_GUN"],"l":[[16,"HYPNOSIS"],[19,"WATER_GUN"],[26,"DOUBLESLAP"],[33,"BODY_SLAM"],[41,"AMNESIA"],[49,"HYDRO_PUMP"]],"e":[62,186]},"62":{"n":"POLIWRATH","t":["water","fighting"],"s":[90,85,95,70,70,90],"m":["HYPNOSIS","WATER_GUN","DOUBLESLAP","BODY_SLAM"],"l":[[16,"HYPNOSIS"],[19,"WATER_GUN"]],"e":[]},"63":{"n":"ABRA","t":["psychic"],"s":[25,20,15,90,105,55],"m":["TELEPORT"],"l":[],"e":[64]},"64":{"n":"KADABRA","t":["psychic"],"s":[40,35,30,105,120,70],"m":["TELEPORT","CONFUSION","DISABLE"],"l":[[16,"CONFUSION"],[20,"DISABLE"],[27,"PSYBEAM"],[31,"RECOVER"],[38,"PSYCHIC_M"],[42,"REFLECT"]],"e":[65]},"65":{"n":"ALAKAZAM","t":["psychic"],"s":[55,50,45,120,135,85],"m":["TELEPORT","CONFUSION","DISABLE"],"l":[[16,"CONFUSION"],[20,"DISABLE"],[27,"PSYBEAM"],[31,"RECOVER"],[38,"PSYCHIC_M"],[42,"REFLECT"]],"e":[]},"66":{"n":"MACHOP","t":["fighting"],"s":[70,80,50,35,35,35],"m":["KARATE_CHOP"],"l":[[20,"LOW_KICK"],[25,"LEER"],[32,"FOCUS_ENERGY"],[39,"SEISMIC_TOSS"],[46,"SUBMISSION"]],"e":[67]},"67":{"n":"MACHOKE","t":["fighting"],"s":[80,100,70,45,50,60],"m":["KARATE_CHOP","LOW_KICK","LEER"],"l":[[20,"LOW_KICK"],[25,"LEER"],[36,"FOCUS_ENERGY"],[44,"SEISMIC_TOSS"],[52,"SUBMISSION"]],"e":[68]},"68":{"n":"MACHAMP","t":["fighting"],"s":[90,130,80,55,65,85],"m":["KARATE_CHOP","LOW_KICK","LEER"],"l":[[20,"LOW_KICK"],[25,"LEER"],[36,"FOCUS_ENERGY"],[44,"SEISMIC_TOSS"],[52,"SUBMISSION"]],"e":[]},"69":{"n":"BELLSPROUT","t":["grass","poison"],"s":[50,75,35,40,70,30],"m":["VINE_WHIP","GROWTH"],"l":[[13,"WRAP"],[15,"POISONPOWDER"],[18,"SLEEP_POWDER"],[21,"STUN_SPORE"],[26,"ACID"],[33,"RAZOR_LEAF"],[42,"SLAM"]],"e":[70]},"70":{"n":"WEEPINBELL","t":["grass","poison"],"s":[65,90,50,55,85,45],"m":["VINE_WHIP","GROWTH","WRAP"],"l":[[13,"WRAP"],[15,"POISONPOWDER"],[18,"SLEEP_POWDER"],[23,"STUN_SPORE"],[29,"ACID"],[38,"RAZOR_LEAF"],[49,"SLAM"]],"e":[71]},"71":{"n":"VICTREEBEL","t":["grass","poison"],"s":[80,105,65,70,100,60],"m":["SLEEP_POWDER","STUN_SPORE","ACID","RAZOR_LEAF"],"l":[[13,"WRAP"],[15,"POISONPOWDER"],[18,"SLEEP_POWDER"]],"e":[]},"72":{"n":"TENTACOOL","t":["water","poison"],"s":[40,40,35,70,50,100],"m":["ACID"],"l":[[7,"SUPERSONIC"],[13,"WRAP"],[18,"POISON_STING"],[22,"WATER_GUN"],[27,"CONSTRICT"],[33,"BARRIER"],[40,"SCREECH"],[48,"HYDRO_PUMP"]],"e":[73]},"73":{"n":"TENTACRUEL","t":["water","poison"],"s":[80,70,65,100,80,120],"m":["ACID","SUPERSONIC","WRAP"],"l":[[7,"SUPERSONIC"],[13,"WRAP"],[18,"POISON_STING"],[22,"WATER_GUN"],[27,"CONSTRICT"],[35,"BARRIER"],[43,"SCREECH"],[50,"HYDRO_PUMP"]],"e":[]},"74":{"n":"GEODUDE","t":["rock","ground"],"s":[40,80,100,20,30,30],"m":["TACKLE"],"l":[[11,"DEFENSE_CURL"],[16,"ROCK_THROW"],[21,"SELFDESTRUCT"],[26,"HARDEN"],[31,"EARTHQUAKE"],[36,"EXPLOSION"]],"e":[75]},"75":{"n":"GRAVELER","t":["rock","ground"],"s":[55,95,115,35,45,45],"m":["TACKLE","DEFENSE_CURL"],"l":[[11,"DEFENSE_CURL"],[16,"ROCK_THROW"],[21,"SELFDESTRUCT"],[29,"HARDEN"],[36,"EARTHQUAKE"],[43,"EXPLOSION"]],"e":[76]},"76":{"n":"GOLEM","t":["rock","ground"],"s":[80,110,130,45,55,65],"m":["TACKLE","DEFENSE_CURL"],"l":[[11,"DEFENSE_CURL"],[16,"ROCK_THROW"],[21,"SELFDESTRUCT"],[29,"HARDEN"],[36,"EARTHQUAKE"],[43,"EXPLOSION"]],"e":[]},"77":{"n":"PONYTA","t":["fire"],"s":[50,85,55,90,65,65],"m":["EMBER"],"l":[[30,"TAIL_WHIP"],[32,"STOMP"],[35,"GROWL"],[39,"FIRE_SPIN"],[43,"TAKE_DOWN"],[48,"AGILITY"]],"e":[78]},"78":{"n":"RAPIDASH","t":["fire"],"s":[65,100,70,105,80,80],"m":["EMBER","TAIL_WHIP","STOMP","GROWL"],"l":[[30,"TAIL_WHIP"],[32,"STOMP"],[35,"GROWL"],[39,"FIRE_SPIN"],[47,"TAKE_DOWN"],[55,"AGILITY"]],"e":[]},"79":{"n":"SLOWPOKE","t":["water","psychic"],"s":[90,65,65,15,40,40],"m":["CONFUSION"],"l":[[18,"DISABLE"],[22,"HEADBUTT"],[27,"GROWL"],[33,"WATER_GUN"],[40,"AMNESIA"],[48,"PSYCHIC_M"]],"e":[80,199]},"80":{"n":"SLOWBRO","t":["water","psychic"],"s":[95,75,110,30,100,80],"m":["CONFUSION","DISABLE","HEADBUTT"],"l":[[18,"DISABLE"],[22,"HEADBUTT"],[27,"GROWL"],[33,"WATER_GUN"],[37,"WITHDRAW"],[44,"AMNESIA"],[55,"PSYCHIC_M"]],"e":[]},"81":{"n":"MAGNEMITE","t":["electric","steel"],"s":[25,35,70,45,95,55],"m":["TACKLE"],"l":[[21,"SONICBOOM"],[25,"THUNDERSHOCK"],[29,"SUPERSONIC"],[35,"THUNDER_WAVE"],[41,"SWIFT"],[47,"SCREECH"]],"e":[82]},"82":{"n":"MAGNETON","t":["electric","steel"],"s":[50,60,95,70,120,70],"m":["TACKLE","SONICBOOM","THUNDERSHOCK"],"l":[[21,"SONICBOOM"],[25,"THUNDERSHOCK"],[29,"SUPERSONIC"],[38,"THUNDER_WAVE"],[46,"SWIFT"],[54,"SCREECH"]],"e":[]},"83":{"n":"FARFETCHD","t":["normal","flying"],"s":[52,65,55,60,58,62],"m":["PECK","SAND_ATTACK"],"l":[[7,"LEER"],[15,"FURY_ATTACK"],[23,"SWORDS_DANCE"],[31,"AGILITY"],[39,"SLASH"]],"e":[]},"84":{"n":"DODUO","t":["normal","flying"],"s":[35,85,45,75,35,35],"m":["PECK"],"l":[[20,"GROWL"],[24,"FURY_ATTACK"],[30,"DRILL_PECK"],[36,"RAGE"],[40,"TRI_ATTACK"],[44,"AGILITY"]],"e":[85]},"85":{"n":"DODRIO","t":["normal","flying"],"s":[60,110,70,100,60,60],"m":["PECK","GROWL","FURY_ATTACK"],"l":[[20,"GROWL"],[24,"FURY_ATTACK"],[30,"DRILL_PECK"],[39,"RAGE"],[45,"TRI_ATTACK"],[51,"AGILITY"]],"e":[]},"86":{"n":"SEEL","t":["water"],"s":[65,45,55,45,45,70],"m":["HEADBUTT"],"l":[[30,"GROWL"],[35,"AURORA_BEAM"],[40,"REST"],[45,"TAKE_DOWN"],[50,"ICE_BEAM"]],"e":[87]},"87":{"n":"DEWGONG","t":["water","ice"],"s":[90,70,80,70,70,95],"m":["HEADBUTT","GROWL","AURORA_BEAM"],"l":[[30,"GROWL"],[35,"AURORA_BEAM"],[44,"REST"],[50,"TAKE_DOWN"],[56,"ICE_BEAM"]],"e":[]},"88":{"n":"GRIMER","t":["poison"],"s":[80,80,50,25,40,50],"m":["POUND","DISABLE"],"l":[[30,"POISON_GAS"],[33,"MINIMIZE"],[37,"SLUDGE"],[42,"HARDEN"],[48,"SCREECH"],[55,"ACID_ARMOR"]],"e":[89]},"89":{"n":"MUK","t":["poison"],"s":[105,105,75,50,65,100],"m":["POUND","DISABLE","POISON_GAS"],"l":[[30,"POISON_GAS"],[33,"MINIMIZE"],[37,"SLUDGE"],[45,"HARDEN"],[53,"SCREECH"],[60,"ACID_ARMOR"]],"e":[]},"90":{"n":"SHELLDER","t":["water"],"s":[30,65,100,40,45,25],"m":["TACKLE","WITHDRAW"],"l":[[18,"SUPERSONIC"],[23,"CLAMP"],[30,"AURORA_BEAM"],[39,"LEER"],[50,"ICE_BEAM"]],"e":[91]},"91":{"n":"CLOYSTER","t":["water","ice"],"s":[50,95,180,70,85,45],"m":["WITHDRAW","SUPERSONIC","CLAMP","AURORA_BEAM"],"l":[[50,"SPIKE_CANNON"]],"e":[]},"92":{"n":"GASTLY","t":["ghost","poison"],"s":[30,35,30,80,100,35],"m":["LICK","CONFUSE_RAY","NIGHT_SHADE"],"l":[[27,"HYPNOSIS"],[35,"DREAM_EATER"]],"e":[93]},"93":{"n":"HAUNTER","t":["ghost","poison"],"s":[45,50,45,95,115,55],"m":["LICK","CONFUSE_RAY","NIGHT_SHADE"],"l":[[29,"HYPNOSIS"],[38,"DREAM_EATER"]],"e":[94]},"94":{"n":"GENGAR","t":["ghost","poison"],"s":[60,65,60,110,130,75],"m":["LICK","CONFUSE_RAY","NIGHT_SHADE"],"l":[[29,"HYPNOSIS"],[38,"DREAM_EATER"]],"e":[]},"95":{"n":"ONIX","t":["rock","ground"],"s":[35,45,160,70,30,45],"m":["TACKLE","SCREECH"],"l":[[15,"BIND"],[19,"ROCK_THROW"],[25,"RAGE"],[33,"SLAM"],[43,"HARDEN"]],"e":[208]},"96":{"n":"DROWZEE","t":["psychic"],"s":[60,48,45,42,43,90],"m":["POUND","HYPNOSIS"],"l":[[12,"DISABLE"],[17,"CONFUSION"],[24,"HEADBUTT"],[29,"POISON_GAS"],[32,"PSYCHIC_M"],[37,"MEDITATE"]],"e":[97]},"97":{"n":"HYPNO","t":["psychic"],"s":[85,73,70,67,73,115],"m":["POUND","HYPNOSIS","DISABLE","CONFUSION"],"l":[[12,"DISABLE"],[17,"CONFUSION"],[24,"HEADBUTT"],[33,"POISON_GAS"],[37,"PSYCHIC_M"],[43,"MEDITATE"]],"e":[]},"98":{"n":"KRABBY","t":["water"],"s":[30,105,90,50,25,25],"m":["BUBBLE","LEER"],"l":[[20,"VICEGRIP"],[25,"GUILLOTINE"],[30,"STOMP"],[35,"CRABHAMMER"],[40,"HARDEN"]],"e":[99]},"99":{"n":"KINGLER","t":["water"],"s":[55,130,115,75,50,50],"m":["BUBBLE","LEER","VICEGRIP"],"l":[[20,"VICEGRIP"],[25,"GUILLOTINE"],[34,"STOMP"],[42,"CRABHAMMER"],[49,"HARDEN"]],"e":[]},"100":{"n":"VOLTORB","t":["electric"],"s":[40,30,50,100,55,55],"m":["TACKLE","SCREECH"],"l":[[17,"SONICBOOM"],[22,"SELFDESTRUCT"],[29,"LIGHT_SCREEN"],[36,"SWIFT"],[43,"EXPLOSION"]],"e":[101]},"101":{"n":"ELECTRODE","t":["electric"],"s":[60,50,70,140,80,80],"m":["TACKLE","SCREECH","SONICBOOM"],"l":[[17,"SONICBOOM"],[22,"SELFDESTRUCT"],[29,"LIGHT_SCREEN"],[40,"SWIFT"],[50,"EXPLOSION"]],"e":[]},"102":{"n":"EXEGGCUTE","t":["grass","psychic"],"s":[60,40,80,40,60,45],"m":["BARRAGE","HYPNOSIS"],"l":[[25,"REFLECT"],[28,"LEECH_SEED"],[32,"STUN_SPORE"],[37,"POISONPOWDER"],[42,"SOLARBEAM"],[48,"SLEEP_POWDER"]],"e":[103]},"103":{"n":"EXEGGUTOR","t":["grass","psychic"],"s":[95,95,85,55,125,65],"m":["BARRAGE","HYPNOSIS"],"l":[[28,"STOMP"]],"e":[]},"104":{"n":"CUBONE","t":["ground"],"s":[50,50,95,35,40,50],"m":["BONE_CLUB","GROWL"],"l":[[25,"LEER"],[31,"FOCUS_ENERGY"],[38,"THRASH"],[43,"BONEMERANG"],[46,"RAGE"]],"e":[105]},"105":{"n":"MAROWAK","t":["ground"],"s":[60,80,110,45,50,80],"m":["BONE_CLUB","GROWL","LEER","FOCUS_ENERGY"],"l":[[25,"LEER"],[33,"FOCUS_ENERGY"],[41,"THRASH"],[48,"BONEMERANG"],[55,"RAGE"]],"e":[]},"106":{"n":"HITMONLEE","t":["fighting"],"s":[50,120,53,87,35,110],"m":["DOUBLE_KICK","MEDITATE"],"l":[[33,"ROLLING_KICK"],[38,"JUMP_KICK"],[43,"FOCUS_ENERGY"],[48,"HI_JUMP_KICK"],[53,"MEGA_KICK"]],"e":[]},"107":{"n":"HITMONCHAN","t":["fighting"],"s":[50,105,79,76,35,110],"m":["COMET_PUNCH","AGILITY"],"l":[[33,"FIRE_PUNCH"],[38,"ICE_PUNCH"],[43,"THUNDERPUNCH"],[48,"MEGA_PUNCH"],[53,"COUNTER"]],"e":[]},"108":{"n":"LICKITUNG","t":["normal"],"s":[90,55,75,30,60,75],"m":["WRAP","SUPERSONIC"],"l":[[7,"STOMP"],[15,"DISABLE"],[23,"DEFENSE_CURL"],[31,"SLAM"],[39,"SCREECH"]],"e":[]},"109":{"n":"KOFFING","t":["poison"],"s":[40,65,95,35,60,45],"m":["TACKLE","SMOG"],"l":[[32,"SLUDGE"],[37,"SMOKESCREEN"],[40,"SELFDESTRUCT"],[45,"HAZE"],[48,"EXPLOSION"]],"e":[110]},"110":{"n":"WEEZING","t":["poison"],"s":[65,90,120,60,85,70],"m":["TACKLE","SMOG","SLUDGE"],"l":[[32,"SLUDGE"],[39,"SMOKESCREEN"],[43,"SELFDESTRUCT"],[49,"HAZE"],[53,"EXPLOSION"]],"e":[]},"111":{"n":"RHYHORN","t":["ground","rock"],"s":[80,85,95,25,30,30],"m":["HORN_ATTACK"],"l":[[30,"STOMP"],[35,"TAIL_WHIP"],[40,"FURY_ATTACK"],[45,"HORN_DRILL"],[50,"LEER"],[55,"TAKE_DOWN"]],"e":[112]},"112":{"n":"RHYDON","t":["ground","rock"],"s":[105,130,120,40,45,45],"m":["HORN_ATTACK","STOMP","TAIL_WHIP","FURY_ATTACK"],"l":[[30,"STOMP"],[35,"TAIL_WHIP"],[40,"FURY_ATTACK"],[48,"HORN_DRILL"],[55,"LEER"],[64,"TAKE_DOWN"]],"e":[]},"113":{"n":"CHANSEY","t":["normal"],"s":[250,5,5,50,35,105],"m":["POUND","DOUBLESLAP"],"l":[[24,"SING"],[30,"GROWL"],[38,"MINIMIZE"],[44,"DEFENSE_CURL"],[48,"LIGHT_SCREEN"],[54,"DOUBLE_EDGE"]],"e":[242]},"114":{"n":"TANGELA","t":["grass"],"s":[65,55,115,60,100,40],"m":["CONSTRICT","BIND"],"l":[[29,"ABSORB"],[32,"POISONPOWDER"],[36,"STUN_SPORE"],[39,"SLEEP_POWDER"],[45,"SLAM"],[49,"GROWTH"]],"e":[]},"115":{"n":"KANGASKHAN","t":["normal"],"s":[105,95,80,90,40,80],"m":["COMET_PUNCH","RAGE"],"l":[[26,"BITE"],[31,"TAIL_WHIP"],[36,"MEGA_PUNCH"],[41,"LEER"],[46,"DIZZY_PUNCH"]],"e":[]},"116":{"n":"HORSEA","t":["water"],"s":[30,40,70,60,70,25],"m":["BUBBLE"],"l":[[19,"SMOKESCREEN"],[24,"LEER"],[30,"WATER_GUN"],[37,"AGILITY"],[45,"HYDRO_PUMP"]],"e":[117]},"117":{"n":"SEADRA","t":["water"],"s":[55,65,95,85,95,45],"m":["BUBBLE","SMOKESCREEN"],"l":[[19,"SMOKESCREEN"],[24,"LEER"],[30,"WATER_GUN"],[41,"AGILITY"],[52,"HYDRO_PUMP"]],"e":[230]},"118":{"n":"GOLDEEN","t":["water"],"s":[45,67,60,63,35,50],"m":["PECK","TAIL_WHIP"],"l":[[19,"SUPERSONIC"],[24,"HORN_ATTACK"],[30,"FURY_ATTACK"],[37,"WATERFALL"],[45,"HORN_DRILL"],[54,"AGILITY"]],"e":[119]},"119":{"n":"SEAKING","t":["water"],"s":[80,92,65,68,65,80],"m":["PECK","TAIL_WHIP","SUPERSONIC"],"l":[[19,"SUPERSONIC"],[24,"HORN_ATTACK"],[30,"FURY_ATTACK"],[39,"WATERFALL"],[48,"HORN_DRILL"],[54,"AGILITY"]],"e":[]},"120":{"n":"STARYU","t":["water"],"s":[30,45,55,85,70,55],"m":["TACKLE"],"l":[[17,"WATER_GUN"],[22,"HARDEN"],[27,"RECOVER"],[32,"SWIFT"],[37,"MINIMIZE"],[42,"LIGHT_SCREEN"],[47,"HYDRO_PUMP"]],"e":[121]},"121":{"n":"STARMIE","t":["water","psychic"],"s":[60,75,85,115,100,85],"m":["TACKLE","WATER_GUN","HARDEN"],"l":[],"e":[]},"122":{"n":"MR-MIME","t":["psychic"],"s":[40,45,65,90,100,120],"m":["CONFUSION","BARRIER"],"l":[[15,"CONFUSION"],[23,"LIGHT_SCREEN"],[31,"DOUBLESLAP"],[39,"MEDITATE"],[47,"SUBSTITUTE"]],"e":[]},"123":{"n":"SCYTHER","t":["bug","flying"],"s":[70,110,80,105,55,80],"m":["QUICK_ATTACK"],"l":[[17,"LEER"],[20,"FOCUS_ENERGY"],[24,"DOUBLE_TEAM"],[29,"SLASH"],[35,"SWORDS_DANCE"],[42,"AGILITY"]],"e":[212]},"124":{"n":"JYNX","t":["ice","psychic"],"s":[65,50,35,95,115,95],"m":["POUND","LOVELY_KISS"],"l":[[18,"LICK"],[23,"DOUBLESLAP"],[31,"ICE_PUNCH"],[39,"BODY_SLAM"],[47,"THRASH"],[58,"BLIZZARD"]],"e":[]},"125":{"n":"ELECTABUZZ","t":["electric"],"s":[65,83,57,105,95,85],"m":["QUICK_ATTACK","LEER"],"l":[[34,"THUNDERSHOCK"],[37,"SCREECH"],[42,"THUNDERPUNCH"],[49,"LIGHT_SCREEN"],[54,"THUNDER"]],"e":[]},"126":{"n":"MAGMAR","t":["fire"],"s":[65,95,57,93,100,85],"m":["EMBER"],"l":[[36,"LEER"],[39,"CONFUSE_RAY"],[43,"FIRE_PUNCH"],[48,"SMOKESCREEN"],[52,"SMOG"],[55,"FLAMETHROWER"]],"e":[]},"127":{"n":"PINSIR","t":["bug"],"s":[65,125,100,85,55,70],"m":["VICEGRIP"],"l":[[25,"SEISMIC_TOSS"],[30,"GUILLOTINE"],[36,"FOCUS_ENERGY"],[43,"HARDEN"],[49,"SLASH"],[54,"SWORDS_DANCE"]],"e":[]},"128":{"n":"TAUROS","t":["normal"],"s":[75,100,95,110,40,70],"m":["TACKLE"],"l":[[21,"STOMP"],[28,"TAIL_WHIP"],[35,"LEER"],[44,"RAGE"],[51,"TAKE_DOWN"]],"e":[]},"129":{"n":"MAGIKARP","t":["water"],"s":[20,10,55,80,15,20],"m":["SPLASH"],"l":[[15,"TACKLE"]],"e":[130]},"130":{"n":"GYARADOS","t":["water","flying"],"s":[95,125,79,81,60,100],"m":["BITE","DRAGON_RAGE","LEER","HYDRO_PUMP"],"l":[[20,"BITE"],[25,"DRAGON_RAGE"],[32,"LEER"],[41,"HYDRO_PUMP"],[52,"HYPER_BEAM"]],"e":[]},"131":{"n":"LAPRAS","t":["water","ice"],"s":[130,85,80,60,85,95],"m":["WATER_GUN","GROWL"],"l":[[16,"SING"],[20,"MIST"],[25,"BODY_SLAM"],[31,"CONFUSE_RAY"],[38,"ICE_BEAM"],[46,"HYDRO_PUMP"]],"e":[]},"132":{"n":"DITTO","t":["normal"],"s":[48,48,48,48,48,48],"m":["TRANSFORM"],"l":[],"e":[]},"133":{"n":"EEVEE","t":["normal"],"s":[55,55,50,55,45,65],"m":["TACKLE","SAND_ATTACK"],"l":[[27,"QUICK_ATTACK"],[31,"TAIL_WHIP"],[37,"BITE"],[45,"TAKE_DOWN"]],"e":[134,135,136,196,197]},"134":{"n":"VAPOREON","t":["water"],"s":[130,65,60,65,110,95],"m":["TACKLE","SAND_ATTACK","QUICK_ATTACK","WATER_GUN"],"l":[[27,"QUICK_ATTACK"],[31,"WATER_GUN"],[37,"TAIL_WHIP"],[40,"BITE"],[42,"ACID_ARMOR"],[44,"HAZE"],[48,"MIST"],[54,"HYDRO_PUMP"]],"e":[]},"135":{"n":"JOLTEON","t":["electric"],"s":[65,65,60,130,110,95],"m":["TACKLE","SAND_ATTACK","QUICK_ATTACK","THUNDERSHOCK"],"l":[[27,"QUICK_ATTACK"],[31,"THUNDERSHOCK"],[37,"TAIL_WHIP"],[40,"THUNDER_WAVE"],[42,"DOUBLE_KICK"],[44,"AGILITY"],[48,"PIN_MISSILE"],[54,"THUNDER"]],"e":[]},"136":{"n":"FLAREON","t":["fire"],"s":[65,130,60,65,95,110],"m":["TACKLE","SAND_ATTACK","QUICK_ATTACK","EMBER"],"l":[[27,"QUICK_ATTACK"],[31,"EMBER"],[37,"TAIL_WHIP"],[40,"BITE"],[42,"LEER"],[44,"FIRE_SPIN"],[48,"RAGE"],[54,"FLAMETHROWER"]],"e":[]},"137":{"n":"PORYGON","t":["normal"],"s":[65,60,70,40,85,75],"m":["TACKLE","SHARPEN","CONVERSION"],"l":[[23,"PSYBEAM"],[28,"RECOVER"],[35,"AGILITY"],[42,"TRI_ATTACK"]],"e":[233]},"138":{"n":"OMANYTE","t":["rock","water"],"s":[35,40,100,35,90,55],"m":["WATER_GUN","WITHDRAW"],"l":[[34,"HORN_ATTACK"],[39,"LEER"],[46,"SPIKE_CANNON"],[53,"HYDRO_PUMP"]],"e":[139]},"139":{"n":"OMASTAR","t":["rock","water"],"s":[70,60,125,55,115,70],"m":["WATER_GUN","WITHDRAW","HORN_ATTACK"],"l":[[34,"HORN_ATTACK"],[39,"LEER"],[44,"SPIKE_CANNON"],[49,"HYDRO_PUMP"]],"e":[]},"140":{"n":"KABUTO","t":["rock","water"],"s":[30,80,90,55,35,45],"m":["SCRATCH","HARDEN"],"l":[[34,"ABSORB"],[39,"SLASH"],[44,"LEER"],[49,"HYDRO_PUMP"]],"e":[141]},"141":{"n":"KABUTOPS","t":["rock","water"],"s":[60,115,105,80,65,70],"m":["SCRATCH","HARDEN","ABSORB"],"l":[[34,"ABSORB"],[39,"SLASH"],[46,"LEER"],[53,"HYDRO_PUMP"]],"e":[]},"142":{"n":"AERODACTYL","t":["rock","flying"],"s":[80,105,65,130,60,75],"m":["WING_ATTACK","AGILITY"],"l":[[33,"SUPERSONIC"],[38,"BITE"],[45,"TAKE_DOWN"],[54,"HYPER_BEAM"]],"e":[]},"143":{"n":"SNORLAX","t":["normal"],"s":[160,110,65,30,65,110],"m":["HEADBUTT","AMNESIA","REST"],"l":[[35,"BODY_SLAM"],[41,"HARDEN"],[48,"DOUBLE_EDGE"],[56,"HYPER_BEAM"]],"e":[]},"144":{"n":"ARTICUNO","t":["ice","flying"],"s":[90,85,100,85,95,125],"m":["PECK","ICE_BEAM"],"l":[[51,"BLIZZARD"],[55,"AGILITY"],[60,"MIST"]],"e":[]},"145":{"n":"ZAPDOS","t":["electric","flying"],"s":[90,90,85,100,125,90],"m":["THUNDERSHOCK","DRILL_PECK"],"l":[[51,"THUNDER"],[55,"AGILITY"],[60,"LIGHT_SCREEN"]],"e":[]},"146":{"n":"MOLTRES","t":["fire","flying"],"s":[90,100,90,90,125,85],"m":["PECK","FIRE_SPIN"],"l":[[51,"LEER"],[55,"AGILITY"],[60,"SKY_ATTACK"]],"e":[]},"147":{"n":"DRATINI","t":["dragon"],"s":[41,64,45,50,50,50],"m":["WRAP","LEER"],"l":[[10,"THUNDER_WAVE"],[20,"AGILITY"],[30,"SLAM"],[40,"DRAGON_RAGE"],[50,"HYPER_BEAM"]],"e":[148]},"148":{"n":"DRAGONAIR","t":["dragon"],"s":[61,84,65,70,70,70],"m":["WRAP","LEER","THUNDER_WAVE"],"l":[[10,"THUNDER_WAVE"],[20,"AGILITY"],[35,"SLAM"],[45,"DRAGON_RAGE"],[55,"HYPER_BEAM"]],"e":[149]},"149":{"n":"DRAGONITE","t":["dragon","flying"],"s":[91,134,95,80,100,100],"m":["WRAP","LEER","THUNDER_WAVE","AGILITY"],"l":[[10,"THUNDER_WAVE"],[20,"AGILITY"],[35,"SLAM"],[45,"DRAGON_RAGE"],[60,"HYPER_BEAM"]],"e":[]},"150":{"n":"MEWTWO","t":["psychic"],"s":[106,110,90,130,154,90],"m":["CONFUSION","DISABLE","SWIFT","PSYCHIC_M"],"l":[[63,"BARRIER"],[66,"PSYCHIC_M"],[70,"RECOVER"],[75,"MIST"],[81,"AMNESIA"]],"e":[]},"151":{"n":"MEW","t":["psychic"],"s":[100,100,100,100,100,100],"m":["POUND"],"l":[[10,"TRANSFORM"],[20,"MEGA_PUNCH"],[30,"METRONOME"],[40,"PSYCHIC_M"]],"e":[]},"152":{"n":"CHIKORITA","t":["grass"],"s":[45,49,65,45,49,65],"e":[153],"m":["TACKLE","GROWL"],"l":[[8,"RAZOR_LEAF"],[12,"REFLECT"],[15,"POISONPOWDER"],[22,"SYNTHESIS"],[29,"BODY_SLAM"],[36,"LIGHT_SCREEN"],[43,"SAFEGUARD"],[50,"SOLARBEAM"]]},"153":{"n":"BAYLEEF","t":["grass"],"s":[60,62,80,60,63,80],"e":[154],"m":["TACKLE","GROWL","RAZOR_LEAF","REFLECT"],"l":[[15,"POISONPOWDER"],[22,"SYNTHESIS"],[31,"BODY_SLAM"],[40,"LIGHT_SCREEN"],[51,"SAFEGUARD"],[60,"SOLARBEAM"]]},"154":{"n":"MEGANIUM","t":["grass"],"s":[80,82,100,80,83,100],"e":[],"m":["TACKLE","GROWL","RAZOR_LEAF","REFLECT"],"l":[[15,"POISONPOWDER"],[22,"SYNTHESIS"],[31,"BODY_SLAM"],[41,"LIGHT_SCREEN"],[54,"SAFEGUARD"],[65,"SOLARBEAM"]]},"155":{"n":"CYNDAQUIL","t":["fire"],"s":[39,52,43,65,60,50],"e":[156],"m":["TACKLE","LEER"],"l":[[6,"SMOKESCREEN"],[12,"EMBER"],[19,"QUICK_ATTACK"],[27,"FLAME_WHEEL"],[36,"SWIFT"],[46,"FLAMETHROWER"]]},"156":{"n":"QUILAVA","t":["fire"],"s":[58,64,58,80,80,65],"e":[157],"m":["TACKLE","LEER","SMOKESCREEN","EMBER"],"l":[[24,"QUICK_ATTACK"],[31,"FLAME_WHEEL"],[40,"SWIFT"],[48,"FLAMETHROWER"]]},"157":{"n":"TYPHLOSION","t":["fire"],"s":[78,84,78,100,109,85],"e":[],"m":["TACKLE","LEER","SMOKESCREEN","EMBER"],"l":[[24,"QUICK_ATTACK"],[31,"FLAME_WHEEL"],[43,"SWIFT"],[53,"FLAMETHROWER"]]},"158":{"n":"TOTODILE","t":["water"],"s":[50,65,64,43,44,48],"e":[159],"m":["SCRATCH","LEER"],"l":[[7,"RAGE"],[13,"WATER_GUN"],[20,"BITE"],[27,"SCARY_FACE"],[35,"SLASH"],[43,"SCREECH"],[52,"HYDRO_PUMP"]]},"159":{"n":"CROCONAW","t":["water"],"s":[65,80,80,58,59,63],"e":[160],"m":["SCRATCH","LEER","RAGE","WATER_GUN"],"l":[[21,"BITE"],[28,"SCARY_FACE"],[37,"SLASH"],[45,"SCREECH"],[55,"HYDRO_PUMP"]]},"160":{"n":"FERALIGATR","t":["water"],"s":[85,105,100,78,79,83],"e":[],"m":["SCRATCH","LEER","RAGE","WATER_GUN"],"l":[[21,"BITE"],[28,"SCARY_FACE"],[38,"SLASH"],[47,"SCREECH"],[58,"HYDRO_PUMP"]]},"161":{"n":"SENTRET","t":["normal"],"s":[35,46,34,20,35,45],"e":[162],"m":["SCRATCH"],"l":[[4,"DEFENSE_CURL"],[7,"QUICK_ATTACK"],[12,"FURY_SWIPES"],[17,"SLAM"],[24,"FLAIL"],[31,"REST"],[40,"AMNESIA"]]},"162":{"n":"FURRET","t":["normal"],"s":[85,76,64,90,45,55],"e":[],"m":["SCRATCH","DEFENSE_CURL","QUICK_ATTACK","FURY_SWIPES"],"l":[[19,"SLAM"],[28,"FLAIL"],[37,"REST"],[48,"AMNESIA"]]},"163":{"n":"HOOTHOOT","t":["normal","flying"],"s":[60,30,30,50,36,56],"e":[164],"m":["TACKLE","GROWL"],"l":[[6,"FORESIGHT"],[11,"PECK"],[16,"HYPNOSIS"],[22,"REFLECT"],[28,"TAKE_DOWN"],[34,"CONFUSION"],[48,"DREAM_EATER"]]},"164":{"n":"NOCTOWL","t":["normal","flying"],"s":[100,50,50,70,76,96],"e":[],"m":["TACKLE","GROWL","FORESIGHT","PECK"],"l":[[25,"HYPNOSIS"],[33,"REFLECT"],[41,"TAKE_DOWN"],[49,"CONFUSION"],[57,"DREAM_EATER"]]},"165":{"n":"LEDYBA","t":["bug","flying"],"s":[40,20,30,55,40,80],"e":[166],"m":["TACKLE"],"l":[[8,"SUPERSONIC"],[15,"COMET_PUNCH"],[22,"LIGHT_SCREEN"],[24,"REFLECT"],[26,"SAFEGUARD"],[29,"BATON_PASS"],[36,"SWIFT"],[43,"AGILITY"],[50,"DOUBLE_EDGE"]]},"166":{"n":"LEDIAN","t":["bug","flying"],"s":[55,35,50,85,55,110],"e":[],"m":["TACKLE","SUPERSONIC","COMET_PUNCH"],"l":[[24,"LIGHT_SCREEN"],[26,"REFLECT"],[28,"SAFEGUARD"],[34,"BATON_PASS"],[41,"SWIFT"],[48,"AGILITY"],[55,"DOUBLE_EDGE"]]},"167":{"n":"SPINARAK","t":["bug","poison"],"s":[40,60,40,30,40,40],"e":[168],"m":["POISON_STING","STRING_SHOT"],"l":[[6,"SCARY_FACE"],[11,"CONSTRICT"],[17,"NIGHT_SHADE"],[25,"LEECH_LIFE"],[33,"SPIDER_WEB"],[41,"AGILITY"],[49,"PSYCHIC_M"]]},"168":{"n":"ARIADOS","t":["bug","poison"],"s":[70,90,70,40,60,60],"e":[],"m":["POISON_STING","STRING_SHOT","SCARY_FACE","CONSTRICT"],"l":[[17,"NIGHT_SHADE"],[25,"LEECH_LIFE"],[34,"SPIDER_WEB"],[43,"AGILITY"],[52,"PSYCHIC_M"]]},"169":{"n":"CROBAT","t":["poison","flying"],"s":[85,90,80,130,70,80],"e":[],"m":["LEECH_LIFE","SCREECH","SUPERSONIC","BITE"],"l":[[21,"CONFUSE_RAY"],[28,"WING_ATTACK"],[36,"MEAN_LOOK"],[42,"HAZE"],[48,"DOUBLE_EDGE"]]},"170":{"n":"CHINCHOU","t":["water","electric"],"s":[75,38,38,67,56,56],"e":[171],"m":["BUBBLE","SUPERSONIC"],"l":[[13,"THUNDER_WAVE"],[17,"FLAIL"],[25,"WATER_GUN"],[29,"SPARK"],[37,"CONFUSE_RAY"],[41,"TAKE_DOWN"],[49,"HYDRO_PUMP"]]},"171":{"n":"LANTURN","t":["water","electric"],"s":[125,58,58,67,76,76],"e":[],"m":["BUBBLE","SUPERSONIC","THUNDER_WAVE","FLAIL"],"l":[[27,"WATER_GUN"],[33,"SPARK"],[43,"CONFUSE_RAY"],[49,"TAKE_DOWN"],[57,"HYDRO_PUMP"]]},"172":{"n":"PICHU","t":["electric"],"s":[20,40,15,60,35,35],"e":[25],"m":["THUNDERSHOCK","CHARM"],"l":[[6,"TAIL_WHIP"],[8,"THUNDER_WAVE"],[11,"SWEET_KISS"]]},"173":{"n":"CLEFFA","t":["normal"],"s":[50,25,28,15,45,55],"e":[35],"m":["POUND","CHARM"],"l":[[4,"ENCORE"],[8,"SING"],[13,"SWEET_KISS"],[17,"DEFENSE_CURL"],[20,"PRESENT"],[25,"METRONOME"],[29,"SAFEGUARD"]]},"174":{"n":"IGGLYBUFF","t":["normal"],"s":[90,30,15,15,40,20],"e":[39],"m":["SING","CHARM"],"l":[[4,"DEFENSE_CURL"],[9,"POUND"],[14,"SWEET_KISS"]]},"175":{"n":"TOGEPI","t":["normal"],"s":[35,20,65,20,40,65],"e":[176],"m":["GROWL","CHARM"],"l":[[6,"METRONOME"],[11,"SWEET_KISS"],[16,"ENCORE"],[21,"SAFEGUARD"],[26,"DOUBLE_EDGE"]]},"176":{"n":"TOGETIC","t":["normal","flying"],"s":[55,40,85,40,80,105],"e":[],"m":["GROWL","CHARM","METRONOME","SWEET_KISS"],"l":[[21,"ENCORE"],[26,"SAFEGUARD"],[31,"DOUBLE_EDGE"]]},"177":{"n":"NATU","t":["psychic","flying"],"s":[40,50,45,70,70,45],"e":[178],"m":["PECK","LEER"],"l":[[10,"NIGHT_SHADE"],[20,"TELEPORT"],[30,"FUTURE_SIGHT"],[40,"CONFUSE_RAY"],[50,"PSYCHIC_M"]]},"178":{"n":"XATU","t":["psychic","flying"],"s":[65,75,70,95,95,70],"e":[],"m":["PECK","LEER","NIGHT_SHADE","TELEPORT"],"l":[[30,"FUTURE_SIGHT"],[40,"CONFUSE_RAY"],[50,"PSYCHIC_M"]]},"179":{"n":"MAREEP","t":["electric"],"s":[55,40,40,35,65,45],"e":[180],"m":["TACKLE","GROWL"],"l":[[9,"THUNDERSHOCK"],[16,"THUNDER_WAVE"],[23,"COTTON_SPORE"],[30,"LIGHT_SCREEN"],[37,"THUNDER"]]},"180":{"n":"FLAAFFY","t":["electric"],"s":[70,55,55,45,80,60],"e":[181],"m":["TACKLE","GROWL","THUNDERSHOCK","THUNDER_WAVE"],"l":[[18,"COTTON_SPORE"],[27,"LIGHT_SCREEN"],[36,"THUNDER"]]},"181":{"n":"AMPHAROS","t":["electric"],"s":[90,75,75,55,115,90],"e":[],"m":["TACKLE","GROWL","THUNDERSHOCK","THUNDER_WAVE"],"l":[[18,"COTTON_SPORE"],[30,"LIGHT_SCREEN"],[36,"THUNDERPUNCH"],[42,"THUNDER"]]},"182":{"n":"BELLOSSOM","t":["grass"],"s":[75,80,85,50,90,100],"e":[],"m":["ABSORB","SWEET_SCENT","STUN_SPORE","SLEEP_POWDER"],"l":[[36,"ACID"],[44,"PETAL_DANCE"]]},"183":{"n":"MARILL","t":["water"],"s":[70,20,50,40,20,50],"e":[184],"m":["TACKLE","TAIL_WHIP"],"l":[[3,"DEFENSE_CURL"],[6,"WATER_GUN"],[10,"ROLLOUT"],[15,"BUBBLEBEAM"],[21,"DOUBLE_EDGE"],[28,"RAIN_DANCE"],[36,"HYDRO_PUMP"]]},"184":{"n":"AZUMARILL","t":["water"],"s":[100,50,80,50,60,80],"e":[],"m":["TACKLE","TAIL_WHIP","DEFENSE_CURL","WATER_GUN"],"l":[[10,"ROLLOUT"],[15,"BUBBLEBEAM"],[24,"DOUBLE_EDGE"],[34,"RAIN_DANCE"],[45,"HYDRO_PUMP"]]},"185":{"n":"SUDOWOODO","t":["rock"],"s":[70,100,115,30,30,65],"e":[],"m":["ROCK_THROW","MIMIC"],"l":[[9,"FLAIL"],[17,"LOW_KICK"],[25,"ROCK_SLIDE"],[33,"FAINT_ATTACK"],[41,"SLAM"],[49,"DOUBLE_EDGE"]]},"186":{"n":"POLITOED","t":["water"],"s":[90,75,75,70,90,100],"e":[],"m":["WATER_GUN","HYPNOSIS","DOUBLESLAP","PERISH_SONG"],"l":[[35,"SWAGGER"],[43,"BUBBLEBEAM"],[51,"HYDRO_PUMP"]]},"187":{"n":"HOPPIP","t":["grass","flying"],"s":[35,35,40,50,35,55],"e":[188],"m":["SPLASH"],"l":[[5,"SYNTHESIS"],[10,"TAIL_WHIP"],[13,"TACKLE"],[15,"POISONPOWDER"],[20,"STUN_SPORE"],[25,"SLEEP_POWDER"],[30,"LEECH_SEED"],[35,"COTTON_SPORE"]]},"188":{"n":"SKIPLOOM","t":["grass","flying"],"s":[55,45,50,80,45,65],"e":[189],"m":["SPLASH","SYNTHESIS","TAIL_WHIP","TACKLE"],"l":[[15,"POISONPOWDER"],[20,"STUN_SPORE"],[25,"SLEEP_POWDER"],[33,"LEECH_SEED"],[43,"COTTON_SPORE"]]},"189":{"n":"JUMPLUFF","t":["grass","flying"],"s":[75,55,70,110,55,85],"e":[],"m":["SYNTHESIS","TAIL_WHIP","TACKLE","POISONPOWDER"],"l":[[20,"STUN_SPORE"],[25,"SLEEP_POWDER"],[33,"LEECH_SEED"],[45,"COTTON_SPORE"]]},"190":{"n":"AIPOM","t":["normal"],"s":[55,70,55,85,40,55],"e":[],"m":["SCRATCH","TAIL_WHIP"],"l":[[6,"SAND_ATTACK"],[13,"BATON_PASS"],[18,"FURY_SWIPES"],[26,"SWIFT"],[33,"SCREECH"],[43,"AGILITY"]]},"191":{"n":"SUNKERN","t":["grass"],"s":[30,30,30,30,30,30],"e":[192],"m":["ABSORB"],"l":[[6,"GROWTH"],[13,"MEGA_DRAIN"],[18,"SUNNY_DAY"],[25,"SYNTHESIS"],[30,"GIGA_DRAIN"]]},"192":{"n":"SUNFLORA","t":["grass"],"s":[75,75,55,30,105,85],"e":[],"m":["ABSORB","GROWTH","RAZOR_LEAF","SUNNY_DAY"],"l":[[25,"SYNTHESIS"],[30,"GIGA_DRAIN"],[42,"SOLARBEAM"]]},"193":{"n":"YANMA","t":["bug","flying"],"s":[65,65,45,95,75,45],"e":[],"m":["TACKLE","FORESIGHT"],"l":[[7,"QUICK_ATTACK"],[13,"DOUBLE_TEAM"],[19,"SONICBOOM"],[25,"DETECT"],[31,"SUPERSONIC"],[49,"SCREECH"]]},"194":{"n":"WOOPER","t":["water","ground"],"s":[55,45,45,15,25,25],"e":[195],"m":["WATER_GUN","TAIL_WHIP"],"l":[[11,"SLAM"],[16,"MUD_SLAP"],[21,"AMNESIA"],[31,"EARTHQUAKE"],[36,"RAIN_DANCE"],[41,"MIST"],[51,"HAZE"]]},"195":{"n":"QUAGSIRE","t":["water","ground"],"s":[95,85,85,35,65,65],"e":[],"m":["WATER_GUN","TAIL_WHIP","SLAM","MUD_SLAP"],"l":[[23,"AMNESIA"],[35,"EARTHQUAKE"],[42,"RAIN_DANCE"],[49,"MIST"],[57,"HAZE"]]},"196":{"n":"ESPEON","t":["psychic"],"s":[65,65,60,110,130,95],"e":[],"m":["TACKLE","TAIL_WHIP"],"l":[[8,"SAND_ATTACK"],[16,"QUICK_ATTACK"],[23,"SWIFT"],[30,"PSYBEAM"],[36,"PSYCH_UP"],[42,"PSYCHIC_M"],[47,"MORNING_SUN"]]},"197":{"n":"UMBREON","t":["dark"],"s":[95,65,110,65,60,130],"e":[],"m":["TACKLE","TAIL_WHIP"],"l":[[8,"SAND_ATTACK"],[16,"QUICK_ATTACK"],[23,"PURSUIT"],[30,"FAINT_ATTACK"],[36,"SCREECH"],[42,"MEAN_LOOK"],[47,"MOONLIGHT"]]},"198":{"n":"MURKROW","t":["dark","flying"],"s":[60,85,42,91,85,42],"e":[],"m":["PECK","PURSUIT"],"l":[[16,"HAZE"],[21,"NIGHT_SHADE"],[26,"FAINT_ATTACK"],[31,"WHIRLWIND"],[36,"MEAN_LOOK"],[41,"DRILL_PECK"]]},"199":{"n":"SLOWKING","t":["water","psychic"],"s":[95,75,80,30,100,110],"e":[],"m":["CURSE","TACKLE","GROWL","WATER_GUN"],"l":[[18,"CONFUSION"],[22,"DISABLE"],[27,"HEADBUTT"],[33,"SWAGGER"],[40,"PSYCHIC_M"],[48,"PSYCH_UP"]]},"200":{"n":"MISDREAVUS","t":["ghost"],"s":[60,60,60,85,85,85],"e":[],"m":["GROWL","PSYWAVE"],"l":[[6,"SPITE"],[11,"MEAN_LOOK"],[17,"PSYBEAM"],[23,"PAIN_SPLIT"],[30,"SHADOW_BALL"],[37,"PERISH_SONG"],[45,"DESTINY_BOND"]]},"201":{"n":"UNOWN","t":["psychic"],"s":[48,72,48,48,72,48],"e":[],"m":["HIDDEN_POWER"],"l":[]},"202":{"n":"WOBBUFFET","t":["psychic"],"s":[190,33,58,33,33,58],"e":[],"m":["COUNTER","MIRROR_COAT","SAFEGUARD","DESTINY_BOND"],"l":[]},"203":{"n":"GIRAFARIG","t":["normal","psychic"],"s":[70,80,65,85,90,65],"e":[],"m":["TACKLE","GROWL"],"l":[[7,"CONFUSION"],[13,"STOMP"],[19,"PSYBEAM"],[25,"AGILITY"],[31,"BATON_PASS"],[37,"TAKE_DOWN"],[43,"PSYCHIC_M"]]},"204":{"n":"PINECO","t":["bug"],"s":[50,65,90,15,35,35],"e":[205],"m":["TACKLE","PROTECT"],"l":[[8,"SELFDESTRUCT"],[15,"TAKE_DOWN"],[22,"RAPID_SPIN"],[29,"BIDE"],[36,"EXPLOSION"],[43,"SPIKES"],[50,"DOUBLE_EDGE"]]},"205":{"n":"FORRETRESS","t":["bug","steel"],"s":[75,90,140,40,60,60],"e":[],"m":["TACKLE","PROTECT","SELFDESTRUCT","TAKE_DOWN"],"l":[[23,"RAPID_SPIN"],[31,"BIDE"],[39,"EXPLOSION"],[47,"SPIKES"],[55,"DOUBLE_EDGE"]]},"206":{"n":"DUNSPARCE","t":["normal"],"s":[100,70,70,45,65,65],"e":[],"m":["RAGE"],"l":[[4,"DEFENSE_CURL"],[10,"GLARE"],[19,"ROLLOUT"],[25,"SPITE"],[31,"SCREECH"],[37,"TAKE_DOWN"],[43,"ENDURE"],[49,"DOUBLE_EDGE"]]},"207":{"n":"GLIGAR","t":["ground","flying"],"s":[65,75,105,85,35,65],"e":[],"m":["POISON_STING"],"l":[[6,"SAND_ATTACK"],[13,"HARDEN"],[20,"QUICK_ATTACK"],[28,"FAINT_ATTACK"],[36,"SLASH"],[44,"SCREECH"],[52,"GUILLOTINE"]]},"208":{"n":"STEELIX","t":["steel","ground"],"s":[75,85,200,30,55,65],"e":[],"m":["TACKLE","SCREECH","BIND","ROCK_THROW"],"l":[[19,"HARDEN"],[25,"RAGE"],[31,"SANDSTORM"],[37,"SLAM"],[43,"IRON_TAIL"],[49,"SCREECH"],[55,"DOUBLE_EDGE"]]},"209":{"n":"SNUBBULL","t":["normal"],"s":[60,80,50,30,40,40],"e":[210],"m":["TACKLE","SCARY_FACE"],"l":[[8,"TAIL_WHIP"],[13,"CHARM"],[19,"BITE"],[26,"LICK"],[34,"ROAR"],[43,"RAGE"],[53,"CRUNCH"]]},"210":{"n":"GRANBULL","t":["normal"],"s":[90,120,75,45,60,60],"e":[],"m":["TACKLE","SCARY_FACE","TAIL_WHIP","CHARM"],"l":[[19,"BITE"],[28,"LICK"],[38,"ROAR"],[49,"RAGE"],[61,"TAKE_DOWN"]]},"211":{"n":"QWILFISH","t":["water","poison"],"s":[65,95,75,85,55,55],"e":[],"m":["TACKLE","POISON_STING"],"l":[[9,"HARDEN"],[13,"MINIMIZE"],[20,"WATER_GUN"],[28,"PIN_MISSILE"],[36,"TAKE_DOWN"],[44,"HYDRO_PUMP"]]},"212":{"n":"SCIZOR","t":["bug","steel"],"s":[70,130,100,65,55,80],"e":[],"m":["QUICK_ATTACK","LEER","FOCUS_ENERGY","PURSUIT"],"l":[[21,"FALSE_SWIPE"],[26,"AGILITY"],[31,"METAL_CLAW"],[36,"SLASH"],[41,"SWORDS_DANCE"],[46,"DOUBLE_TEAM"]]},"213":{"n":"SHUCKLE","t":["bug","rock"],"s":[20,10,230,5,10,230],"e":[],"m":["CONSTRICT","WITHDRAW"],"l":[[9,"WRAP"],[14,"ENCORE"],[23,"SAFEGUARD"],[28,"BIDE"],[37,"REST"]]},"214":{"n":"HERACROSS","t":["bug","fighting"],"s":[80,125,75,85,40,95],"e":[],"m":["TACKLE","LEER"],"l":[[6,"HORN_ATTACK"],[11,"ENDURE"],[17,"FURY_ATTACK"],[23,"COUNTER"],[30,"TAKE_DOWN"],[37,"REVERSAL"],[45,"MEGAHORN"]]},"215":{"n":"SNEASEL","t":["dark","ice"],"s":[55,95,55,115,35,75],"e":[],"m":["SCRATCH","LEER"],"l":[[8,"QUICK_ATTACK"],[15,"SCREECH"],[22,"FAINT_ATTACK"],[29,"FURY_SWIPES"],[36,"AGILITY"],[43,"ICY_WIND"],[50,"SLASH"]]},"216":{"n":"TEDDIURSA","t":["normal"],"s":[60,80,50,40,50,50],"e":[217],"m":["SCRATCH","LEER"],"l":[[8,"LICK"],[15,"FURY_SWIPES"],[22,"FAINT_ATTACK"],[29,"REST"],[36,"SLASH"],[43,"SNORE"],[50,"THRASH"]]},"217":{"n":"URSARING","t":["normal"],"s":[90,130,75,55,75,75],"e":[],"m":["SCRATCH","LEER","LICK","FURY_SWIPES"],"l":[[25,"FAINT_ATTACK"],[32,"REST"],[41,"SLASH"],[50,"SNORE"],[59,"THRASH"]]},"218":{"n":"SLUGMA","t":["fire"],"s":[40,40,40,20,70,40],"e":[219],"m":["SMOG"],"l":[[8,"EMBER"],[15,"ROCK_THROW"],[22,"HARDEN"],[29,"AMNESIA"],[36,"FLAMETHROWER"],[43,"ROCK_SLIDE"],[50,"BODY_SLAM"]]},"219":{"n":"MAGCARGO","t":["fire","rock"],"s":[50,50,120,30,80,80],"e":[],"m":["SMOG","EMBER","ROCK_THROW","HARDEN"],"l":[[29,"AMNESIA"],[36,"FLAMETHROWER"],[48,"ROCK_SLIDE"],[60,"BODY_SLAM"]]},"220":{"n":"SWINUB","t":["ice","ground"],"s":[50,50,40,50,30,30],"e":[221],"m":["TACKLE"],"l":[[10,"POWDER_SNOW"],[16,"ENDURE"],[19,"TAKE_DOWN"],[28,"MIST"],[37,"BLIZZARD"],[46,"AMNESIA"]]},"221":{"n":"PILOSWINE","t":["ice","ground"],"s":[100,100,80,50,60,60],"e":[],"m":["TACKLE","POWDER_SNOW","ENDURE","TAKE_DOWN"],"l":[[28,"FURY_ATTACK"],[33,"MIST"],[42,"BLIZZARD"],[56,"AMNESIA"]]},"222":{"n":"CORSOLA","t":["water","rock"],"s":[55,55,85,35,65,85],"e":[],"m":["TACKLE"],"l":[[6,"HARDEN"],[12,"BUBBLE"],[17,"RECOVER"],[23,"BUBBLEBEAM"],[28,"SPIKE_CANNON"],[34,"ROCK_SLIDE"],[39,"MIRROR_COAT"],[45,"ANCIENTPOWER"]]},"223":{"n":"REMORAID","t":["water"],"s":[35,65,35,65,65,35],"e":[224],"m":["WATER_GUN"],"l":[[11,"LOCK_ON"],[22,"PSYBEAM"],[27,"AURORA_BEAM"],[33,"BUBBLEBEAM"],[38,"FOCUS_ENERGY"],[44,"HYPER_BEAM"]]},"224":{"n":"OCTILLERY","t":["water"],"s":[75,105,75,45,105,75],"e":[],"m":["WATER_GUN","CONSTRICT","PSYBEAM","AURORA_BEAM"],"l":[[25,"OCTAZOOKA"],[33,"BUBBLEBEAM"],[41,"FOCUS_ENERGY"],[50,"HYPER_BEAM"]]},"225":{"n":"DELIBIRD","t":["ice","flying"],"s":[45,55,45,75,65,45],"e":[],"m":["PRESENT"],"l":[]},"226":{"n":"MANTINE","t":["water","flying"],"s":[65,40,70,70,80,140],"e":[],"m":["TACKLE","BUBBLE"],"l":[[8,"SUPERSONIC"],[15,"BUBBLEBEAM"],[22,"TAKE_DOWN"],[29,"AGILITY"],[36,"WING_ATTACK"],[43,"WATER_GUN"],[50,"HYDRO_PUMP"]]},"227":{"n":"SKARMORY","t":["steel","flying"],"s":[65,80,140,70,40,70],"e":[],"m":["LEER","PECK"],"l":[[13,"SAND_ATTACK"],[19,"SWIFT"],[25,"AGILITY"],[37,"FURY_ATTACK"],[49,"STEEL_WING"]]},"228":{"n":"HOUNDOUR","t":["dark","fire"],"s":[45,60,30,65,80,50],"e":[229],"m":["LEER","EMBER"],"l":[[7,"ROAR"],[13,"SMOG"],[19,"BITE"],[25,"FAINT_ATTACK"],[31,"FLAMETHROWER"],[37,"CRUNCH"]]},"229":{"n":"HOUNDOOM","t":["dark","fire"],"s":[75,90,50,95,110,80],"e":[],"m":["LEER","EMBER","ROAR","SMOG"],"l":[[19,"BITE"],[35,"FAINT_ATTACK"],[43,"FLAMETHROWER"],[51,"CRUNCH"]]},"230":{"n":"KINGDRA","t":["water","dragon"],"s":[75,95,95,85,95,95],"e":[],"m":["BUBBLE","SMOKESCREEN","LEER","WATER_GUN"],"l":[[35,"DRAGONBREATH"],[40,"AGILITY"],[48,"HYDRO_PUMP"]]},"231":{"n":"PHANPY","t":["ground"],"s":[90,60,60,40,40,40],"e":[232],"m":["TACKLE","GROWL"],"l":[[9,"DEFENSE_CURL"],[17,"FLAIL"],[25,"ROLLOUT"],[33,"ENDURE"],[41,"TAKE_DOWN"],[49,"DOUBLE_EDGE"]]},"232":{"n":"DONPHAN","t":["ground"],"s":[90,120,120,50,60,60],"e":[],"m":["HORN_ATTACK","GROWL","DEFENSE_CURL","FLAIL"],"l":[[25,"ROLLOUT"],[33,"FURY_ATTACK"],[41,"TAKE_DOWN"],[49,"EARTHQUAKE"]]},"233":{"n":"PORYGON2","t":["normal"],"s":[85,80,90,60,105,95],"e":[],"m":["CONVERSION2","TACKLE","CONVERSION","SHARPEN"],"l":[[23,"PSYBEAM"],[28,"RECOVER"],[35,"AGILITY"],[42,"TRI_ATTACK"]]},"234":{"n":"STANTLER","t":["normal"],"s":[73,95,62,85,85,65],"e":[],"m":["TACKLE","LEER"],"l":[[7,"HYPNOSIS"],[13,"STOMP"],[19,"SAND_ATTACK"],[25,"TAKE_DOWN"],[31,"CONFUSE_RAY"],[37,"PSYCH_UP"],[43,"DOUBLE_EDGE"]]},"235":{"n":"SMEARGLE","t":["normal"],"s":[55,20,35,75,20,45],"e":[],"m":["TACKLE","SPLASH","MIMIC","METRONOME"],"l":[]},"236":{"n":"TYROGUE","t":["fighting"],"s":[35,35,35,35,35,35],"e":[106,107,237],"m":["TACKLE"],"l":[]},"237":{"n":"HITMONTOP","t":["fighting"],"s":[50,95,95,70,35,110],"e":[],"m":["ROLLING_KICK","FOCUS_ENERGY","PURSUIT","QUICK_ATTACK"],"l":[[20,"RAPID_SPIN"],[25,"COUNTER"],[32,"AGILITY"],[40,"TRIPLE_KICK"],[48,"DETECT"]]},"238":{"n":"SMOOCHUM","t":["ice","psychic"],"s":[45,30,15,65,85,65],"e":[124],"m":["POUND","LICK"],"l":[[9,"SWEET_KISS"],[13,"POWDER_SNOW"],[21,"CONFUSION"],[25,"SING"],[33,"MEAN_LOOK"],[37,"FAINT_ATTACK"],[45,"PSYCHIC_M"],[49,"PERISH_SONG"]]},"239":{"n":"ELEKID","t":["electric"],"s":[45,63,37,95,65,55],"e":[125],"m":["QUICK_ATTACK","LEER"],"l":[[9,"THUNDERPUNCH"],[17,"LIGHT_SCREEN"],[25,"SWIFT"],[33,"SCREECH"],[41,"THUNDERBOLT"],[49,"THUNDER"]]},"240":{"n":"MAGBY","t":["fire"],"s":[45,75,37,83,70,55],"e":[126],"m":["EMBER"],"l":[[7,"LEER"],[13,"SMOG"],[19,"FIRE_PUNCH"],[25,"SMOKESCREEN"],[31,"SUNNY_DAY"],[37,"FLAMETHROWER"],[43,"CONFUSE_RAY"],[49,"FIRE_BLAST"]]},"241":{"n":"MILTANK","t":["normal"],"s":[95,80,105,100,40,70],"e":[],"m":["TACKLE","GROWL"],"l":[[8,"STOMP"],[13,"MILK_DRINK"],[19,"BIDE"],[26,"ROLLOUT"],[34,"BODY_SLAM"],[43,"HEAL_BELL"]]},"242":{"n":"BLISSEY","t":["normal"],"s":[255,10,10,55,75,135],"e":[],"m":["POUND","GROWL","TAIL_WHIP","SOFTBOILED"],"l":[[13,"DOUBLESLAP"],[23,"MINIMIZE"],[33,"SING"],[44,"EGG_BOMB"]]},"243":{"n":"RAIKOU","t":["electric"],"s":[90,85,75,115,115,100],"e":[],"m":["THUNDERSHOCK","ROAR","LEER","QUICK_ATTACK"],"l":[[21,"SPARK"],[31,"REFLECT"],[41,"CRUNCH"],[51,"THUNDER"]]},"244":{"n":"ENTEI","t":["fire"],"s":[115,115,85,100,90,75],"e":[],"m":["EMBER","ROAR","LEER","STOMP"],"l":[[21,"FIRE_SPIN"],[31,"SWAGGER"],[41,"FLAMETHROWER"],[51,"CRUNCH"]]},"245":{"n":"SUICUNE","t":["water"],"s":[100,75,115,85,90,115],"e":[],"m":["BUBBLEBEAM","RAIN_DANCE","GUST","AURORA_BEAM"],"l":[[21,"MIST"],[31,"MIRROR_COAT"],[41,"HYDRO_PUMP"]]},"246":{"n":"LARVITAR","t":["rock","ground"],"s":[50,64,50,41,45,50],"e":[247],"m":["BITE","LEER"],"l":[[8,"SANDSTORM"],[15,"SCREECH"],[22,"ROCK_SLIDE"],[29,"THRASH"],[36,"SCARY_FACE"],[43,"CRUNCH"],[50,"EARTHQUAKE"]]},"247":{"n":"PUPITAR","t":["rock","ground"],"s":[70,84,70,51,65,70],"e":[248],"m":["BITE","LEER","SANDSTORM","SCREECH"],"l":[[22,"ROCK_SLIDE"],[30,"THRASH"],[38,"SCARY_FACE"],[46,"CRUNCH"],[54,"EARTHQUAKE"]]},"248":{"n":"TYRANITAR","t":["rock","dark"],"s":[100,134,110,61,95,100],"e":[],"m":["BITE","LEER","SANDSTORM","SCREECH"],"l":[[22,"ROCK_SLIDE"],[30,"THRASH"],[38,"SCARY_FACE"],[46,"CRUNCH"],[54,"EARTHQUAKE"],[61,"HYPER_BEAM"]]},"249":{"n":"LUGIA","t":["psychic","flying"],"s":[106,90,130,110,90,154],"e":[],"m":["AEROBLAST","SAFEGUARD","GUST","RECOVER"],"l":[[20,"RAIN_DANCE"],[30,"HYDRO_PUMP"],[40,"ANCIENTPOWER"],[50,"FUTURE_SIGHT"]]},"250":{"n":"HO-OH","t":["fire","flying"],"s":[106,130,90,90,110,154],"e":[],"m":["SACRED_FIRE","SAFEGUARD","GUST","RECOVER"],"l":[[20,"SUNNY_DAY"],[30,"FIRE_BLAST"],[40,"ANCIENTPOWER"],[50,"FUTURE_SIGHT"]]},"251":{"n":"CELEBI","t":["psychic","grass"],"s":[100,100,100,100,100,100],"e":[],"m":["LEECH_SEED","CONFUSION","RECOVER","HEAL_BELL"],"l":[[20,"SAFEGUARD"],[30,"ANCIENTPOWER"],[40,"FUTURE_SIGHT"],[50,"BATON_PASS"]]}},"moves":{"POUND":{"n":"POUND","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"normal","a":100,"pp":35},"KARATE_CHOP":{"n":"KARATE CHOP","e":"NO_ADDITIONAL_EFFECT","p":50,"t":"fighting","a":100,"pp":25,"hc":1},"DOUBLESLAP":{"n":"DOUBLESLAP","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":15,"t":"normal","a":85,"pp":10},"COMET_PUNCH":{"n":"COMET PUNCH","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":18,"t":"normal","a":85,"pp":15},"MEGA_PUNCH":{"n":"MEGA PUNCH","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"normal","a":85,"pp":20},"PAY_DAY":{"n":"PAY DAY","e":"PAY_DAY_EFFECT","p":40,"t":"normal","a":100,"pp":20},"FIRE_PUNCH":{"n":"FIRE PUNCH","e":"NO_ADDITIONAL_EFFECT","p":75,"t":"fire","a":100,"pp":15,"sec":[{"k":"brn","c":10}]},"ICE_PUNCH":{"n":"ICE PUNCH","e":"NO_ADDITIONAL_EFFECT","p":75,"t":"ice","a":100,"pp":15,"sec":[{"k":"frz","c":10}]},"THUNDERPUNCH":{"n":"THUNDERPUNCH","e":"NO_ADDITIONAL_EFFECT","p":75,"t":"electric","a":100,"pp":15,"sec":[{"k":"par","c":10}]},"SCRATCH":{"n":"SCRATCH","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"normal","a":100,"pp":35},"VICEGRIP":{"n":"VICEGRIP","e":"NO_ADDITIONAL_EFFECT","p":55,"t":"normal","a":100,"pp":30},"GUILLOTINE":{"n":"GUILLOTINE","e":"OHKO_EFFECT","p":1,"t":"normal","a":30,"pp":5},"RAZOR_WIND":{"n":"RAZOR WIND","e":"CHARGE_EFFECT","p":80,"t":"normal","a":75,"pp":10},"SWORDS_DANCE":{"n":"SWORDS DANCE","e":"ATTACK_UP2_EFFECT","p":0,"t":"normal","a":100,"pp":30,"self":1},"CUT":{"n":"CUT","e":"NO_ADDITIONAL_EFFECT","p":50,"t":"normal","a":95,"pp":30},"GUST":{"n":"GUST","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"flying","a":100,"pp":35},"WING_ATTACK":{"n":"WING ATTACK","e":"NO_ADDITIONAL_EFFECT","p":35,"t":"flying","a":100,"pp":35},"WHIRLWIND":{"n":"WHIRLWIND","e":"SWITCH_AND_TELEPORT_EFFECT","p":0,"t":"normal","a":85,"pp":20,"self":1},"FLY":{"n":"FLY","e":"FLY_EFFECT","p":70,"t":"flying","a":95,"pp":15},"BIND":{"n":"BIND","e":"TRAPPING_EFFECT","p":15,"t":"normal","a":75,"pp":20},"SLAM":{"n":"SLAM","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"normal","a":75,"pp":20},"VINE_WHIP":{"n":"VINE WHIP","e":"NO_ADDITIONAL_EFFECT","p":35,"t":"grass","a":100,"pp":10},"STOMP":{"n":"STOMP","e":"NO_ADDITIONAL_EFFECT","p":65,"t":"normal","a":100,"pp":20,"sec":[{"k":"flinch","c":30}]},"DOUBLE_KICK":{"n":"DOUBLE KICK","e":"ATTACK_TWICE_EFFECT","p":30,"t":"fighting","a":100,"pp":30},"MEGA_KICK":{"n":"MEGA KICK","e":"NO_ADDITIONAL_EFFECT","p":120,"t":"normal","a":75,"pp":5},"JUMP_KICK":{"n":"JUMP KICK","e":"JUMP_KICK_EFFECT","p":70,"t":"fighting","a":95,"pp":25},"ROLLING_KICK":{"n":"ROLLING KICK","e":"NO_ADDITIONAL_EFFECT","p":60,"t":"fighting","a":85,"pp":15,"sec":[{"k":"flinch","c":30}]},"SAND_ATTACK":{"n":"SAND-ATTACK","e":"ACCURACY_DOWN1_EFFECT","p":0,"t":"ground","a":100,"pp":15},"HEADBUTT":{"n":"HEADBUTT","e":"NO_ADDITIONAL_EFFECT","p":70,"t":"normal","a":100,"pp":15,"sec":[{"k":"flinch","c":30}]},"HORN_ATTACK":{"n":"HORN ATTACK","e":"NO_ADDITIONAL_EFFECT","p":65,"t":"normal","a":100,"pp":25},"FURY_ATTACK":{"n":"FURY ATTACK","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":15,"t":"normal","a":85,"pp":20},"HORN_DRILL":{"n":"HORN DRILL","e":"OHKO_EFFECT","p":1,"t":"normal","a":30,"pp":5},"TACKLE":{"n":"TACKLE","e":"NO_ADDITIONAL_EFFECT","p":35,"t":"normal","a":95,"pp":35},"BODY_SLAM":{"n":"BODY SLAM","e":"NO_ADDITIONAL_EFFECT","p":85,"t":"normal","a":100,"pp":15,"sec":[{"k":"par","c":30}]},"WRAP":{"n":"WRAP","e":"TRAPPING_EFFECT","p":15,"t":"normal","a":85,"pp":20},"TAKE_DOWN":{"n":"TAKE DOWN","e":"RECOIL_EFFECT","p":90,"t":"normal","a":85,"pp":20},"THRASH":{"n":"THRASH","e":"THRASH_PETAL_DANCE_EFFECT","p":90,"t":"normal","a":100,"pp":20},"DOUBLE_EDGE":{"n":"DOUBLE-EDGE","e":"RECOIL_EFFECT","p":100,"t":"normal","a":100,"pp":15},"TAIL_WHIP":{"n":"TAIL WHIP","e":"DEFENSE_DOWN1_EFFECT","p":0,"t":"normal","a":100,"pp":30},"POISON_STING":{"n":"POISON STING","e":"NO_ADDITIONAL_EFFECT","p":15,"t":"poison","a":100,"pp":35,"sec":[{"k":"psn","c":30}]},"TWINEEDLE":{"n":"TWINEEDLE","e":"ATTACK_TWICE_EFFECT","p":25,"t":"bug","a":100,"pp":20,"sec":[{"k":"psn","c":20}]},"PIN_MISSILE":{"n":"PIN MISSILE","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":14,"t":"bug","a":85,"pp":20},"LEER":{"n":"LEER","e":"DEFENSE_DOWN1_EFFECT","p":0,"t":"normal","a":100,"pp":30},"BITE":{"n":"BITE","e":"NO_ADDITIONAL_EFFECT","p":60,"t":"dark","a":100,"pp":25,"sec":[{"k":"flinch","c":30}]},"GROWL":{"n":"GROWL","e":"ATTACK_DOWN1_EFFECT","p":0,"t":"normal","a":100,"pp":40},"ROAR":{"n":"ROAR","e":"SWITCH_AND_TELEPORT_EFFECT","p":0,"t":"normal","a":100,"pp":20,"self":1},"SING":{"n":"SING","e":"SLEEP_EFFECT","p":0,"t":"normal","a":55,"pp":15},"SUPERSONIC":{"n":"SUPERSONIC","e":"CONFUSION_EFFECT","p":0,"t":"normal","a":55,"pp":20},"SONICBOOM":{"n":"SONICBOOM","e":"SPECIAL_DAMAGE_EFFECT","p":1,"t":"normal","a":90,"pp":20},"DISABLE":{"n":"DISABLE","e":"DISABLE_EFFECT","p":0,"t":"normal","a":55,"pp":20},"ACID":{"n":"ACID","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"poison","a":100,"pp":30,"sec":[{"k":"stat","st":"def","d":-1,"c":10}]},"EMBER":{"n":"EMBER","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"fire","a":100,"pp":25,"sec":[{"k":"brn","c":10}]},"FLAMETHROWER":{"n":"FLAMETHROWER","e":"NO_ADDITIONAL_EFFECT","p":95,"t":"fire","a":100,"pp":15,"sec":[{"k":"brn","c":10}]},"MIST":{"n":"MIST","e":"MIST_EFFECT","p":0,"t":"ice","a":100,"pp":30,"self":1},"WATER_GUN":{"n":"WATER GUN","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"water","a":100,"pp":25},"HYDRO_PUMP":{"n":"HYDRO PUMP","e":"NO_ADDITIONAL_EFFECT","p":120,"t":"water","a":80,"pp":5},"SURF":{"n":"SURF","e":"NO_ADDITIONAL_EFFECT","p":95,"t":"water","a":100,"pp":15},"ICE_BEAM":{"n":"ICE BEAM","e":"NO_ADDITIONAL_EFFECT","p":95,"t":"ice","a":100,"pp":10,"sec":[{"k":"frz","c":10}]},"BLIZZARD":{"n":"BLIZZARD","e":"NO_ADDITIONAL_EFFECT","p":120,"t":"ice","a":90,"pp":5,"sec":[{"k":"frz","c":10}]},"PSYBEAM":{"n":"PSYBEAM","e":"NO_ADDITIONAL_EFFECT","p":65,"t":"psychic","a":100,"pp":20,"sec":[{"k":"cnf","c":10}]},"BUBBLEBEAM":{"n":"BUBBLEBEAM","e":"NO_ADDITIONAL_EFFECT","p":65,"t":"water","a":100,"pp":20,"sec":[{"k":"stat","st":"spd","d":-1,"c":10}]},"AURORA_BEAM":{"n":"AURORA BEAM","e":"NO_ADDITIONAL_EFFECT","p":65,"t":"ice","a":100,"pp":20,"sec":[{"k":"stat","st":"atk","d":-1,"c":10}]},"HYPER_BEAM":{"n":"HYPER BEAM","e":"HYPER_BEAM_EFFECT","p":150,"t":"normal","a":90,"pp":5},"PECK":{"n":"PECK","e":"NO_ADDITIONAL_EFFECT","p":35,"t":"flying","a":100,"pp":35},"DRILL_PECK":{"n":"DRILL PECK","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"flying","a":100,"pp":20},"SUBMISSION":{"n":"SUBMISSION","e":"RECOIL_EFFECT","p":80,"t":"fighting","a":80,"pp":25},"LOW_KICK":{"n":"LOW KICK","e":"NO_ADDITIONAL_EFFECT","p":50,"t":"fighting","a":90,"pp":20,"sec":[{"k":"flinch","c":30}]},"COUNTER":{"n":"COUNTER","e":"NO_ADDITIONAL_EFFECT","p":1,"t":"fighting","a":100,"pp":20,"pri":-1,"x":"counter"},"SEISMIC_TOSS":{"n":"SEISMIC TOSS","e":"SPECIAL_DAMAGE_EFFECT","p":1,"t":"fighting","a":100,"pp":20},"STRENGTH":{"n":"STRENGTH","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"normal","a":100,"pp":15},"ABSORB":{"n":"ABSORB","e":"DRAIN_HP_EFFECT","p":20,"t":"grass","a":100,"pp":20},"MEGA_DRAIN":{"n":"MEGA DRAIN","e":"DRAIN_HP_EFFECT","p":40,"t":"grass","a":100,"pp":10},"LEECH_SEED":{"n":"LEECH SEED","e":"LEECH_SEED_EFFECT","p":0,"t":"grass","a":90,"pp":10},"GROWTH":{"n":"GROWTH","e":"SPA_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":40,"self":1},"RAZOR_LEAF":{"n":"RAZOR LEAF","e":"NO_ADDITIONAL_EFFECT","p":55,"t":"grass","a":95,"pp":25,"hc":1},"SOLARBEAM":{"n":"SOLARBEAM","e":"CHARGE_EFFECT","p":120,"t":"grass","a":100,"pp":10},"POISONPOWDER":{"n":"POISONPOWDER","e":"POISON_EFFECT","p":0,"t":"poison","a":75,"pp":35},"STUN_SPORE":{"n":"STUN SPORE","e":"PARALYZE_EFFECT","p":0,"t":"grass","a":75,"pp":30},"SLEEP_POWDER":{"n":"SLEEP POWDER","e":"SLEEP_EFFECT","p":0,"t":"grass","a":75,"pp":15},"PETAL_DANCE":{"n":"PETAL DANCE","e":"THRASH_PETAL_DANCE_EFFECT","p":70,"t":"grass","a":100,"pp":20},"STRING_SHOT":{"n":"STRING SHOT","e":"SPEED_DOWN1_EFFECT","p":0,"t":"bug","a":95,"pp":40},"DRAGON_RAGE":{"n":"DRAGON RAGE","e":"SPECIAL_DAMAGE_EFFECT","p":1,"t":"dragon","a":100,"pp":10},"FIRE_SPIN":{"n":"FIRE SPIN","e":"TRAPPING_EFFECT","p":15,"t":"fire","a":70,"pp":15},"THUNDERSHOCK":{"n":"THUNDERSHOCK","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"electric","a":100,"pp":30,"sec":[{"k":"par","c":10}]},"THUNDERBOLT":{"n":"THUNDERBOLT","e":"NO_ADDITIONAL_EFFECT","p":95,"t":"electric","a":100,"pp":15,"sec":[{"k":"par","c":10}]},"THUNDER_WAVE":{"n":"THUNDER WAVE","e":"PARALYZE_EFFECT","p":0,"t":"electric","a":100,"pp":20},"THUNDER":{"n":"THUNDER","e":"NO_ADDITIONAL_EFFECT","p":120,"t":"electric","a":70,"pp":10,"sec":[{"k":"par","c":10}]},"ROCK_THROW":{"n":"ROCK THROW","e":"NO_ADDITIONAL_EFFECT","p":50,"t":"rock","a":65,"pp":15},"EARTHQUAKE":{"n":"EARTHQUAKE","e":"NO_ADDITIONAL_EFFECT","p":100,"t":"ground","a":100,"pp":10},"FISSURE":{"n":"FISSURE","e":"OHKO_EFFECT","p":1,"t":"ground","a":30,"pp":5},"DIG":{"n":"DIG","e":"CHARGE_EFFECT","p":100,"t":"ground","a":100,"pp":10},"TOXIC":{"n":"TOXIC","e":"POISON_EFFECT","p":0,"t":"poison","a":85,"pp":10},"CONFUSION":{"n":"CONFUSION","e":"NO_ADDITIONAL_EFFECT","p":50,"t":"psychic","a":100,"pp":25,"sec":[{"k":"cnf","c":10}]},"PSYCHIC_M":{"n":"PSYCHIC","e":"NO_ADDITIONAL_EFFECT","p":90,"t":"psychic","a":100,"pp":10,"sec":[{"k":"stat","st":"sdf","d":-1,"c":10}]},"HYPNOSIS":{"n":"HYPNOSIS","e":"SLEEP_EFFECT","p":0,"t":"psychic","a":60,"pp":20},"MEDITATE":{"n":"MEDITATE","e":"ATTACK_UP1_EFFECT","p":0,"t":"psychic","a":100,"pp":40,"self":1},"AGILITY":{"n":"AGILITY","e":"SPEED_UP2_EFFECT","p":0,"t":"psychic","a":100,"pp":30,"self":1},"QUICK_ATTACK":{"n":"QUICK ATTACK","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"normal","a":100,"pp":30,"pri":1},"RAGE":{"n":"RAGE","e":"RAGE_EFFECT","p":20,"t":"normal","a":100,"pp":20},"TELEPORT":{"n":"TELEPORT","e":"SWITCH_AND_TELEPORT_EFFECT","p":0,"t":"psychic","a":100,"pp":20,"self":1},"NIGHT_SHADE":{"n":"NIGHT SHADE","e":"SPECIAL_DAMAGE_EFFECT","p":0,"t":"ghost","a":100,"pp":15},"MIMIC":{"n":"MIMIC","e":"MIMIC_EFFECT","p":0,"t":"normal","a":100,"pp":10},"SCREECH":{"n":"SCREECH","e":"DEFENSE_DOWN2_EFFECT","p":0,"t":"normal","a":85,"pp":40},"DOUBLE_TEAM":{"n":"DOUBLE TEAM","e":"EVASION_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":15,"self":1},"RECOVER":{"n":"RECOVER","e":"HEAL_EFFECT","p":0,"t":"normal","a":100,"pp":20,"self":1},"HARDEN":{"n":"HARDEN","e":"DEFENSE_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":30,"self":1},"MINIMIZE":{"n":"MINIMIZE","e":"EVASION_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":20,"self":1},"SMOKESCREEN":{"n":"SMOKESCREEN","e":"ACCURACY_DOWN1_EFFECT","p":0,"t":"normal","a":100,"pp":20},"CONFUSE_RAY":{"n":"CONFUSE RAY","e":"CONFUSION_EFFECT","p":0,"t":"ghost","a":100,"pp":10},"WITHDRAW":{"n":"WITHDRAW","e":"DEFENSE_UP1_EFFECT","p":0,"t":"water","a":100,"pp":40,"self":1},"DEFENSE_CURL":{"n":"DEFENSE CURL","e":"DEFENSE_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":40,"self":1},"BARRIER":{"n":"BARRIER","e":"DEFENSE_UP2_EFFECT","p":0,"t":"psychic","a":100,"pp":30,"self":1},"LIGHT_SCREEN":{"n":"LIGHT SCREEN","e":"LIGHT_SCREEN_EFFECT","p":0,"t":"psychic","a":100,"pp":30,"self":1},"HAZE":{"n":"HAZE","e":"HAZE_EFFECT","p":0,"t":"ice","a":100,"pp":30,"self":1},"REFLECT":{"n":"REFLECT","e":"REFLECT_EFFECT","p":0,"t":"psychic","a":100,"pp":20,"self":1},"FOCUS_ENERGY":{"n":"FOCUS ENERGY","e":"FOCUS_ENERGY_EFFECT","p":0,"t":"normal","a":100,"pp":30,"self":1},"BIDE":{"n":"BIDE","e":"BIDE_EFFECT","p":0,"t":"normal","a":100,"pp":10,"self":1},"METRONOME":{"n":"METRONOME","e":"METRONOME_EFFECT","p":0,"t":"normal","a":100,"pp":10,"self":1},"MIRROR_MOVE":{"n":"MIRROR MOVE","e":"MIRROR_MOVE_EFFECT","p":0,"t":"flying","a":100,"pp":20,"self":1},"SELFDESTRUCT":{"n":"SELFDESTRUCT","e":"EXPLODE_EFFECT","p":200,"t":"normal","a":100,"pp":5},"EGG_BOMB":{"n":"EGG BOMB","e":"NO_ADDITIONAL_EFFECT","p":100,"t":"normal","a":75,"pp":10},"LICK":{"n":"LICK","e":"NO_ADDITIONAL_EFFECT","p":20,"t":"ghost","a":100,"pp":30,"sec":[{"k":"par","c":30}]},"SMOG":{"n":"SMOG","e":"NO_ADDITIONAL_EFFECT","p":20,"t":"poison","a":70,"pp":20,"sec":[{"k":"psn","c":40}]},"SLUDGE":{"n":"SLUDGE","e":"NO_ADDITIONAL_EFFECT","p":65,"t":"poison","a":100,"pp":20,"sec":[{"k":"psn","c":30}]},"BONE_CLUB":{"n":"BONE CLUB","e":"NO_ADDITIONAL_EFFECT","p":65,"t":"ground","a":85,"pp":20,"sec":[{"k":"flinch","c":10}]},"FIRE_BLAST":{"n":"FIRE BLAST","e":"NO_ADDITIONAL_EFFECT","p":120,"t":"fire","a":85,"pp":5,"sec":[{"k":"brn","c":10}]},"WATERFALL":{"n":"WATERFALL","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"water","a":100,"pp":15,"sec":[{"k":"flinch","c":20}]},"CLAMP":{"n":"CLAMP","e":"TRAPPING_EFFECT","p":35,"t":"water","a":75,"pp":10},"SWIFT":{"n":"SWIFT","e":"SWIFT_EFFECT","p":60,"t":"normal","a":100,"pp":20,"nm":1},"SKULL_BASH":{"n":"SKULL BASH","e":"CHARGE_EFFECT","p":100,"t":"normal","a":100,"pp":15},"SPIKE_CANNON":{"n":"SPIKE CANNON","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":20,"t":"normal","a":100,"pp":15},"CONSTRICT":{"n":"CONSTRICT","e":"NO_ADDITIONAL_EFFECT","p":10,"t":"normal","a":100,"pp":35,"sec":[{"k":"stat","st":"spd","d":-1,"c":10}]},"AMNESIA":{"n":"AMNESIA","e":"SDF_UP2_EFFECT","p":0,"t":"psychic","a":100,"pp":20,"self":1},"KINESIS":{"n":"KINESIS","e":"ACCURACY_DOWN1_EFFECT","p":0,"t":"psychic","a":80,"pp":15},"SOFTBOILED":{"n":"SOFTBOILED","e":"HEAL_EFFECT","p":0,"t":"normal","a":100,"pp":10,"self":1},"HI_JUMP_KICK":{"n":"HI JUMP KICK","e":"JUMP_KICK_EFFECT","p":85,"t":"fighting","a":90,"pp":20},"GLARE":{"n":"GLARE","e":"PARALYZE_EFFECT","p":0,"t":"normal","a":75,"pp":30},"DREAM_EATER":{"n":"DREAM EATER","e":"DREAM_EATER_EFFECT","p":100,"t":"psychic","a":100,"pp":15},"POISON_GAS":{"n":"POISON GAS","e":"POISON_EFFECT","p":0,"t":"poison","a":55,"pp":40},"BARRAGE":{"n":"BARRAGE","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":15,"t":"normal","a":85,"pp":20},"LEECH_LIFE":{"n":"LEECH LIFE","e":"DRAIN_HP_EFFECT","p":20,"t":"bug","a":100,"pp":15},"LOVELY_KISS":{"n":"LOVELY KISS","e":"SLEEP_EFFECT","p":0,"t":"normal","a":75,"pp":10},"SKY_ATTACK":{"n":"SKY ATTACK","e":"CHARGE_EFFECT","p":140,"t":"flying","a":90,"pp":5,"sec":[{"k":"flinch","c":30}]},"TRANSFORM":{"n":"TRANSFORM","e":"TRANSFORM_EFFECT","p":0,"t":"normal","a":100,"pp":10,"self":0},"BUBBLE":{"n":"BUBBLE","e":"NO_ADDITIONAL_EFFECT","p":20,"t":"water","a":100,"pp":30,"sec":[{"k":"stat","st":"spd","d":-1,"c":10}]},"DIZZY_PUNCH":{"n":"DIZZY PUNCH","e":"NO_ADDITIONAL_EFFECT","p":70,"t":"normal","a":100,"pp":10},"SPORE":{"n":"SPORE","e":"SLEEP_EFFECT","p":0,"t":"grass","a":100,"pp":15},"FLASH":{"n":"FLASH","e":"ACCURACY_DOWN1_EFFECT","p":0,"t":"normal","a":70,"pp":20},"PSYWAVE":{"n":"PSYWAVE","e":"SPECIAL_DAMAGE_EFFECT","p":1,"t":"psychic","a":80,"pp":15},"SPLASH":{"n":"SPLASH","e":"SPLASH_EFFECT","p":0,"t":"normal","a":100,"pp":40,"self":1},"ACID_ARMOR":{"n":"ACID ARMOR","e":"DEFENSE_UP2_EFFECT","p":0,"t":"poison","a":100,"pp":40,"self":1},"CRABHAMMER":{"n":"CRABHAMMER","e":"NO_ADDITIONAL_EFFECT","p":90,"t":"water","a":85,"pp":10,"hc":1},"EXPLOSION":{"n":"EXPLOSION","e":"EXPLODE_EFFECT","p":250,"t":"normal","a":100,"pp":5},"FURY_SWIPES":{"n":"FURY SWIPES","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":18,"t":"normal","a":80,"pp":15},"BONEMERANG":{"n":"BONEMERANG","e":"ATTACK_TWICE_EFFECT","p":50,"t":"ground","a":90,"pp":10},"REST":{"n":"REST","e":"HEAL_EFFECT","p":0,"t":"psychic","a":100,"pp":10,"self":1},"ROCK_SLIDE":{"n":"ROCK SLIDE","e":"NO_ADDITIONAL_EFFECT","p":75,"t":"rock","a":90,"pp":10,"sec":[{"k":"flinch","c":30}]},"HYPER_FANG":{"n":"HYPER FANG","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"normal","a":90,"pp":15,"sec":[{"k":"flinch","c":10}]},"SHARPEN":{"n":"SHARPEN","e":"ATTACK_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":30,"self":1},"CONVERSION":{"n":"CONVERSION","e":"CONVERSION_EFFECT","p":0,"t":"normal","a":100,"pp":30,"self":1},"TRI_ATTACK":{"n":"TRI ATTACK","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"normal","a":100,"pp":10},"SUPER_FANG":{"n":"SUPER FANG","e":"SUPER_FANG_EFFECT","p":1,"t":"normal","a":90,"pp":10},"SLASH":{"n":"SLASH","e":"NO_ADDITIONAL_EFFECT","p":70,"t":"normal","a":100,"pp":20,"hc":1},"SUBSTITUTE":{"n":"SUBSTITUTE","e":"SUBSTITUTE_EFFECT","p":0,"t":"normal","a":100,"pp":10,"self":1},"STRUGGLE":{"n":"STRUGGLE","e":"RECOIL_EFFECT","p":50,"t":"normal","a":100,"pp":10},"TRIPLE_KICK":{"n":"TRIPLE KICK","e":"NO_ADDITIONAL_EFFECT","p":10,"t":"fighting","a":90,"pp":10,"x":"triple_kick"},"THIEF":{"n":"THIEF","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"dark","a":100,"pp":10},"SPIDER_WEB":{"n":"SPIDER WEB","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"bug","a":100,"pp":10,"x":"mean_look"},"MIND_READER":{"n":"MIND READER","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":5,"x":"lock_on"},"NIGHTMARE":{"n":"NIGHTMARE","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"ghost","a":100,"pp":15,"x":"nightmare"},"FLAME_WHEEL":{"n":"FLAME WHEEL","e":"NO_ADDITIONAL_EFFECT","p":60,"t":"fire","a":100,"pp":25,"sec":[{"k":"brn","c":10}],"thaw":1},"SNORE":{"n":"SNORE","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"normal","a":100,"pp":15,"x":"snore","sec":[{"k":"flinch","c":30}]},"CURSE":{"n":"CURSE","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":10,"x":"curse","self":1},"FLAIL":{"n":"FLAIL","e":"NO_ADDITIONAL_EFFECT","p":1,"t":"normal","a":100,"pp":15,"x":"flail"},"CONVERSION2":{"n":"CONVERSION2","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":30,"x":"conversion2","self":1},"AEROBLAST":{"n":"AEROBLAST","e":"NO_ADDITIONAL_EFFECT","p":100,"t":"flying","a":95,"pp":5,"hc":1},"COTTON_SPORE":{"n":"COTTON SPORE","e":"SPEED_DOWN2_EFFECT","p":0,"t":"grass","a":85,"pp":40},"REVERSAL":{"n":"REVERSAL","e":"NO_ADDITIONAL_EFFECT","p":1,"t":"fighting","a":100,"pp":15,"x":"flail"},"SPITE":{"n":"SPITE","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"ghost","a":100,"pp":10,"x":"spite"},"POWDER_SNOW":{"n":"POWDER SNOW","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"ice","a":100,"pp":25,"sec":[{"k":"frz","c":10}]},"PROTECT":{"n":"PROTECT","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":10,"x":"protect","pri":3,"self":1},"MACH_PUNCH":{"n":"MACH PUNCH","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"fighting","a":100,"pp":30,"pri":1},"SCARY_FACE":{"n":"SCARY FACE","e":"SPEED_DOWN2_EFFECT","p":0,"t":"normal","a":90,"pp":10},"FAINT_ATTACK":{"n":"FAINT ATTACK","e":"NO_ADDITIONAL_EFFECT","p":60,"t":"dark","a":100,"pp":20,"nm":1},"SWEET_KISS":{"n":"SWEET KISS","e":"CONFUSION_EFFECT","p":0,"t":"normal","a":75,"pp":10},"BELLY_DRUM":{"n":"BELLY DRUM","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":10,"x":"belly_drum","self":1},"SLUDGE_BOMB":{"n":"SLUDGE BOMB","e":"NO_ADDITIONAL_EFFECT","p":90,"t":"poison","a":100,"pp":10,"sec":[{"k":"psn","c":30}]},"MUD_SLAP":{"n":"MUD-SLAP","e":"NO_ADDITIONAL_EFFECT","p":20,"t":"ground","a":100,"pp":10,"sec":[{"k":"stat","st":"acc","d":-1,"c":100}]},"OCTAZOOKA":{"n":"OCTAZOOKA","e":"NO_ADDITIONAL_EFFECT","p":65,"t":"water","a":85,"pp":10,"sec":[{"k":"stat","st":"acc","d":-1,"c":50}]},"SPIKES":{"n":"SPIKES","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"ground","a":100,"pp":20,"x":"fail","self":1},"ZAP_CANNON":{"n":"ZAP CANNON","e":"NO_ADDITIONAL_EFFECT","p":100,"t":"electric","a":50,"pp":5,"sec":[{"k":"par","c":100}]},"FORESIGHT":{"n":"FORESIGHT","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":40,"x":"foresight"},"DESTINY_BOND":{"n":"DESTINY BOND","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"ghost","a":100,"pp":5,"x":"destiny","self":1},"PERISH_SONG":{"n":"PERISH SONG","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":5,"x":"perish","self":1},"ICY_WIND":{"n":"ICY WIND","e":"NO_ADDITIONAL_EFFECT","p":55,"t":"ice","a":95,"pp":15,"sec":[{"k":"stat","st":"spd","d":-1,"c":100}]},"DETECT":{"n":"DETECT","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"fighting","a":100,"pp":5,"x":"protect","pri":3,"self":1},"BONE_RUSH":{"n":"BONE RUSH","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":25,"t":"ground","a":80,"pp":10},"LOCK_ON":{"n":"LOCK-ON","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":5,"x":"lock_on"},"OUTRAGE":{"n":"OUTRAGE","e":"THRASH_PETAL_DANCE_EFFECT","p":90,"t":"dragon","a":100,"pp":15},"SANDSTORM":{"n":"SANDSTORM","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"rock","a":100,"pp":10,"x":"sandstorm","self":1},"GIGA_DRAIN":{"n":"GIGA DRAIN","e":"DRAIN_HP_EFFECT","p":60,"t":"grass","a":100,"pp":5},"ENDURE":{"n":"ENDURE","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":10,"x":"endure","pri":3,"self":1},"CHARM":{"n":"CHARM","e":"ATTACK_DOWN2_EFFECT","p":0,"t":"normal","a":100,"pp":20},"ROLLOUT":{"n":"ROLLOUT","e":"NO_ADDITIONAL_EFFECT","p":30,"t":"rock","a":90,"pp":20,"x":"rollout"},"FALSE_SWIPE":{"n":"FALSE SWIPE","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"normal","a":100,"pp":40,"x":"false_swipe"},"SWAGGER":{"n":"SWAGGER","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":90,"pp":15,"x":"swagger"},"MILK_DRINK":{"n":"MILK DRINK","e":"HEAL_EFFECT","p":0,"t":"normal","a":100,"pp":10,"self":1},"SPARK":{"n":"SPARK","e":"NO_ADDITIONAL_EFFECT","p":65,"t":"electric","a":100,"pp":20,"sec":[{"k":"par","c":30}]},"FURY_CUTTER":{"n":"FURY CUTTER","e":"NO_ADDITIONAL_EFFECT","p":10,"t":"bug","a":95,"pp":20,"x":"fury_cutter"},"STEEL_WING":{"n":"STEEL WING","e":"NO_ADDITIONAL_EFFECT","p":70,"t":"steel","a":90,"pp":25,"sec":[{"k":"stat","st":"def","d":1,"c":10,"self":1}]},"MEAN_LOOK":{"n":"MEAN LOOK","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":5,"x":"mean_look"},"ATTRACT":{"n":"ATTRACT","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":15,"x":"fail","self":1},"SLEEP_TALK":{"n":"SLEEP TALK","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":10,"x":"sleep_talk","self":1},"HEAL_BELL":{"n":"HEAL BELL","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":5,"x":"heal_bell","self":1},"RETURN":{"n":"RETURN","e":"NO_ADDITIONAL_EFFECT","p":102,"t":"normal","a":100,"pp":20},"PRESENT":{"n":"PRESENT","e":"NO_ADDITIONAL_EFFECT","p":1,"t":"normal","a":90,"pp":15,"x":"present"},"FRUSTRATION":{"n":"FRUSTRATION","e":"NO_ADDITIONAL_EFFECT","p":1,"t":"normal","a":100,"pp":20},"SAFEGUARD":{"n":"SAFEGUARD","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":25,"x":"safeguard","self":1},"PAIN_SPLIT":{"n":"PAIN SPLIT","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":20,"x":"pain_split"},"SACRED_FIRE":{"n":"SACRED FIRE","e":"NO_ADDITIONAL_EFFECT","p":100,"t":"fire","a":95,"pp":5,"sec":[{"k":"brn","c":50}],"thaw":1},"MAGNITUDE":{"n":"MAGNITUDE","e":"NO_ADDITIONAL_EFFECT","p":1,"t":"ground","a":100,"pp":30,"x":"magnitude"},"DYNAMICPUNCH":{"n":"DYNAMICPUNCH","e":"NO_ADDITIONAL_EFFECT","p":100,"t":"fighting","a":50,"pp":5,"sec":[{"k":"cnf","c":100}]},"MEGAHORN":{"n":"MEGAHORN","e":"NO_ADDITIONAL_EFFECT","p":120,"t":"bug","a":85,"pp":10},"DRAGONBREATH":{"n":"DRAGONBREATH","e":"NO_ADDITIONAL_EFFECT","p":60,"t":"dragon","a":100,"pp":20,"sec":[{"k":"par","c":30}]},"BATON_PASS":{"n":"BATON PASS","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":40,"x":"fail","self":1},"ENCORE":{"n":"ENCORE","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":5,"x":"encore"},"PURSUIT":{"n":"PURSUIT","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"dark","a":100,"pp":20},"RAPID_SPIN":{"n":"RAPID SPIN","e":"NO_ADDITIONAL_EFFECT","p":20,"t":"normal","a":100,"pp":40,"x":"rapid_spin"},"SWEET_SCENT":{"n":"SWEET SCENT","e":"EVASION_DOWN1_EFFECT","p":0,"t":"normal","a":100,"pp":20},"IRON_TAIL":{"n":"IRON TAIL","e":"NO_ADDITIONAL_EFFECT","p":100,"t":"steel","a":75,"pp":15,"sec":[{"k":"stat","st":"def","d":-1,"c":30}]},"METAL_CLAW":{"n":"METAL CLAW","e":"NO_ADDITIONAL_EFFECT","p":50,"t":"steel","a":95,"pp":35,"sec":[{"k":"stat","st":"atk","d":1,"c":10,"self":1}]},"VITAL_THROW":{"n":"VITAL THROW","e":"NO_ADDITIONAL_EFFECT","p":70,"t":"fighting","a":100,"pp":10,"pri":-1,"nm":1},"MORNING_SUN":{"n":"MORNING SUN","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":5,"x":"heal_weather","self":1},"SYNTHESIS":{"n":"SYNTHESIS","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"grass","a":100,"pp":5,"x":"heal_weather","self":1},"MOONLIGHT":{"n":"MOONLIGHT","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":5,"x":"heal_weather","self":1},"HIDDEN_POWER":{"n":"HIDDEN POWER","e":"NO_ADDITIONAL_EFFECT","p":1,"t":"normal","a":100,"pp":15,"x":"hidden_power"},"CROSS_CHOP":{"n":"CROSS CHOP","e":"NO_ADDITIONAL_EFFECT","p":100,"t":"fighting","a":80,"pp":5,"hc":1},"TWISTER":{"n":"TWISTER","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"dragon","a":100,"pp":20,"sec":[{"k":"flinch","c":20}]},"RAIN_DANCE":{"n":"RAIN DANCE","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"water","a":90,"pp":5,"x":"rain","self":1},"SUNNY_DAY":{"n":"SUNNY DAY","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"fire","a":90,"pp":5,"x":"sun","self":1},"CRUNCH":{"n":"CRUNCH","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"dark","a":100,"pp":15,"sec":[{"k":"stat","st":"sdf","d":-1,"c":20}]},"MIRROR_COAT":{"n":"MIRROR COAT","e":"NO_ADDITIONAL_EFFECT","p":1,"t":"psychic","a":100,"pp":20,"x":"mirror_coat","pri":-1},"PSYCH_UP":{"n":"PSYCH UP","e":"NO_ADDITIONAL_EFFECT","p":0,"t":"normal","a":100,"pp":10,"x":"psych_up","self":1},"EXTREMESPEED":{"n":"EXTREMESPEED","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"normal","a":100,"pp":5,"pri":2},"ANCIENTPOWER":{"n":"ANCIENTPOWER","e":"NO_ADDITIONAL_EFFECT","p":60,"t":"rock","a":100,"pp":5,"sec":[{"k":"allstats","c":10,"self":1}]},"SHADOW_BALL":{"n":"SHADOW BALL","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"ghost","a":100,"pp":15,"sec":[{"k":"stat","st":"sdf","d":-1,"c":20}]},"FUTURE_SIGHT":{"n":"FUTURE SIGHT","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"psychic","a":90,"pp":15,"x":"future_sight"},"ROCK_SMASH":{"n":"ROCK SMASH","e":"NO_ADDITIONAL_EFFECT","p":20,"t":"fighting","a":100,"pp":15,"sec":[{"k":"stat","st":"def","d":-1,"c":50}]},"WHIRLPOOL":{"n":"WHIRLPOOL","e":"TRAPPING_EFFECT","p":15,"t":"water","a":70,"pp":15},"BEAT_UP":{"n":"BEAT UP","e":"NO_ADDITIONAL_EFFECT","p":10,"t":"dark","a":100,"pp":10}},"chart":[["normal","rock",5],["normal","steel",5],["normal","ghost",0],["fire","fire",5],["fire","water",5],["fire","grass",20],["fire","ice",20],["fire","bug",20],["fire","rock",5],["fire","dragon",5],["fire","steel",20],["water","fire",20],["water","water",5],["water","grass",5],["water","ground",20],["water","rock",20],["water","dragon",5],["electric","water",20],["electric","electric",5],["electric","grass",5],["electric","ground",0],["electric","flying",20],["electric","dragon",5],["grass","fire",5],["grass","water",20],["grass","grass",5],["grass","poison",5],["grass","ground",20],["grass","flying",5],["grass","bug",5],["grass","rock",20],["grass","dragon",5],["grass","steel",5],["ice","water",5],["ice","grass",20],["ice","ice",5],["ice","ground",20],["ice","flying",20],["ice","dragon",20],["ice","fire",5],["ice","steel",5],["fighting","normal",20],["fighting","ice",20],["fighting","poison",5],["fighting","flying",5],["fighting","psychic",5],["fighting","bug",5],["fighting","rock",20],["fighting","ghost",0],["fighting","dark",20],["fighting","steel",20],["poison","grass",20],["poison","poison",5],["poison","ground",5],["poison","rock",5],["poison","ghost",5],["poison","steel",0],["ground","fire",20],["ground","electric",20],["ground","grass",5],["ground","poison",20],["ground","flying",0],["ground","bug",5],["ground","rock",20],["ground","steel",20],["flying","electric",5],["flying","grass",20],["flying","fighting",20],["flying","bug",20],["flying","rock",5],["flying","steel",5],["psychic","fighting",20],["psychic","poison",20],["psychic","psychic",5],["psychic","dark",0],["psychic","steel",5],["bug","fire",5],["bug","grass",20],["bug","fighting",5],["bug","poison",5],["bug","flying",5],["bug","psychic",20],["bug","ghost",5],["bug","dark",20],["bug","steel",5],["rock","fire",20],["rock","ice",20],["rock","fighting",5],["rock","ground",5],["rock","flying",20],["rock","bug",20],["rock","steel",5],["ghost","normal",0],["ghost","psychic",20],["ghost","ghost",20],["ghost","dark",5],["ghost","steel",5],["dragon","dragon",20],["dragon","steel",5],["dark","fighting",5],["dark","psychic",20],["dark","ghost",20],["dark","dark",5],["dark","steel",5],["steel","fire",5],["steel","water",5],["steel","electric",5],["steel","ice",20],["steel","rock",20],["steel","steel",5]]};

// ===================================================================
// GEN 2 (POKÉMON GOLD/SILVER/CRYSTAL) DATA + BATTLE ENGINE
// 251 Pokémon, Gen 2 type chart (Dark + Steel), Special Attack / Special Defense split,
// Gen 2 damage formula, critical hits, status, weather, Protect/Endure/Encore/Perish Song...
// ===================================================================
const G2_LEVEL = 50; // every Pokémon in the bot is level 50
const G2_SPECIAL_TYPES = new Set(['fire', 'water', 'grass', 'electric', 'ice', 'psychic', 'dragon', 'dark']);
const G2_RATIOS = [[25, 100], [28, 100], [33, 100], [40, 100], [50, 100], [66, 100], [1, 1], [15, 10], [2, 1], [25, 10], [3, 1], [35, 10], [4, 1]];
const G2_ACC_RATIOS = [[33, 100], [36, 100], [43, 100], [50, 100], [60, 100], [75, 100], [1, 1], [133, 100], [166, 100], [2, 1], [233, 100], [266, 100], [3, 1]];
const G2_CRIT_RATES = [17, 32, 64, 85, 128]; // out of 256, by crit stage
const G2_STAT_NAMES = { atk: 'ATTACK', def: 'DEFENSE', spd: 'SPEED', spa: 'SP. ATK', sdf: 'SP. DEF', acc: 'ACCURACY', eva: 'EVASION' };
const G2_STAT_KEYS = { ATTACK: 'atk', DEFENSE: 'def', SPEED: 'spd', SPA: 'spa', SDF: 'sdf', ACCURACY: 'acc', EVASION: 'eva' };
const G2_CHARGE_TEXT = {
  RAZOR_WIND: 'made a whirlwind!', SOLARBEAM: 'took in sunlight!', SKULL_BASH: 'lowered its head!',
  SKY_ATTACK: 'is glowing!', FLY: 'flew up high!', DIG: 'dug a hole!'
};
const G2_HP_TYPES = ['fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel', 'fire', 'water', 'grass', 'electric', 'psychic', 'ice', 'dragon', 'dark'];
const G2_FRESH_STAGES = () => ({ atk: 0, def: 0, spd: 0, spa: 0, sdf: 0, acc: 0, eva: 0 });

const G2_CHART = {};
for (const [a, d, r] of GEN2.chart) { (G2_CHART[a] = G2_CHART[a] || {})[d] = r; }
function g2TypeMult(atkType, defType) { return (G2_CHART[atkType] && G2_CHART[atkType][defType] !== undefined) ? G2_CHART[atkType][defType] : 10; }

const g2Rb = (rng) => Math.floor(rng() * 256); // BattleRandom: 0-255

// ---------- stats / creation ----------
function g2LearnMoves(species, level) {
  const known = species.m.slice();
  for (const [lv, mv] of species.l) {
    if (lv > level) break;
    if (known.includes(mv)) continue;
    if (known.length < 4) known.push(mv);
    else { known.shift(); known.push(mv); }
  }
  return known;
}

function g2MoveEntry(key, dvs) {
  const m = GEN2.moves[key];
  const e = { k: key, name: m.n, type: m.t, power: m.p, acc: m.a, pp: m.pp, maxPp: m.pp };
  if (key === 'HIDDEN_POWER' && dvs) { const hp = g2HiddenPower(dvs); e.type = hp.type; e.power = hp.power; }
  return e;
}

// Hidden Power (Gen 2): type and power come from the Pokémon's DVs
function g2HiddenPower(dv) {
  const type = G2_HP_TYPES[((dv.atk & 3) << 2) | (dv.def & 3)];
  const top = (v) => (v >= 8 ? 1 : 0);
  const power = Math.floor((5 * (top(dv.atk) + 2 * top(dv.def) + 4 * top(dv.spd) + 8 * top(dv.spc)) + (dv.spc & 3)) / 2) + 31;
  return { type, power };
}

function g2CreateMon(dexId, isShiny = null, rng = Math.random, uid = null) {
  const sp = GEN2.mons[dexId];
  const dv = { atk: Math.floor(rng() * 16), def: Math.floor(rng() * 16), spd: Math.floor(rng() * 16), spc: Math.floor(rng() * 16) };
  dv.hp = ((dv.atk & 1) << 3) | ((dv.def & 1) << 2) | ((dv.spd & 1) << 1) | (dv.spc & 1);
  const L = G2_LEVEL;
  // Gen 2 stat formula with 0 stat experience (Special DV is shared by Sp. Atk and Sp. Def)
  const calc = (base, d, isHp) => {
    const core = Math.floor(((base + d) * 2) * L / 100);
    return isHp ? core + L + 10 : core + 5;
  };
  const stats = {
    hp: calc(sp.s[0], dv.hp, true), atk: calc(sp.s[1], dv.atk), def: calc(sp.s[2], dv.def),
    spd: calc(sp.s[3], dv.spd), spa: calc(sp.s[4], dv.spc), sdf: calc(sp.s[5], dv.spc)
  };
  return {
    uid: uid || Math.random().toString(36).substring(2, 8).toUpperCase(),
    id: dexId,
    name: sp.n,
    isShiny: isShiny !== null ? isShiny : Math.random() < (1 / 50),
    types: sp.t.slice(),
    level: L,
    dvs: dv,
    stats,
    hp: stats.hp,
    maxHp: stats.hp,
    moves: g2LearnMoves(sp, L).map((k) => g2MoveEntry(k, dv)),
    gen2: true
  };
}

// Pokémon saved before the Gen 2 update are rebuilt with real Gen 2 stats and moves, keeping species, shiny and uid.
function g2EnsureMon(mon) {
  if (mon && mon.gen2 === true && mon.stats && mon.moves && mon.moves[0] && mon.moves[0].k && GEN2.mons[mon.id]) return mon;
  return g2CreateMon(mon.id, Boolean(mon.isShiny), Math.random, mon.uid);
}

// ---------- battle mon ----------
function g2BattleMon(mon) {
  return {
    v2: true,
    uid: mon.uid, id: mon.id, speciesId: mon.id, spriteId: mon.id, name: mon.name, isShiny: Boolean(mon.isShiny),
    types: mon.types.slice(), level: mon.level, stats: { ...mon.stats }, maxHp: mon.stats.hp, currentHp: mon.stats.hp,
    dvs: mon.dvs || null,
    stages: G2_FRESH_STAGES(),
    status: null, sleep: 0, badly: false, toxic: 0,
    conf: 0, flinch: false, recharge: false, seeded: false, mist: false, focus: false, reflect: false, lscreen: false,
    sub: 0, disabled: null, disabledTurns: 0, charging: null, invuln: false,
    trapping: false, trapLeft: 0, trapDmg: 0, trapKey: null, thrash: 0, thrashKey: null, rage: false, bide: null,
    lastMove: null, hitTaken: null,
    protect: false, protectN: 0, endure: false, destiny: false, lockOn: false, foresight: false, nightmare: false, cursed: false,
    perish: 0, encore: null, safeguard: 0, rollN: 0, furyN: 0, future: null, noEscape: false,
    moves: mon.moves.map((m) => ({ ...m, pp: m.maxPp }))
  };
}

function g2ModStat(m, s) {
  const [n, d] = G2_RATIOS[m.stages[s] + 6];
  return Math.max(1, Math.min(999, Math.floor(m.stats[s] * n / d)));
}
function g2Stat(m, s) {
  let v = g2ModStat(m, s);
  if (s === 'atk' && m.status === 'brn') v = Math.max(1, v >> 1);
  if (s === 'spd' && m.status === 'par') v = Math.max(1, v >> 2);
  return v;
}

// ---------- damage ----------
function g2RawDamage(level, power, atk, def) {
  const base = Math.floor(Math.floor(Math.floor(2 * level / 5 + 2) * power * atk / Math.max(1, def)) / 50);
  return Math.min(997, base);
}

// Gen 2 damage: base -> critical x2 -> +2 -> weather -> STAB -> type effectiveness (applied by the caller's random roll)
function g2Damage(ctx, A, D, mv, crit, o = {}) {
  const special = G2_SPECIAL_TYPES.has(mv.t);
  const oKey = special ? 'spa' : 'atk', dKey = special ? 'sdf' : 'def';
  const power = o.power !== undefined ? o.power : mv.p;
  let atk, def, screens = true;
  if (crit && A.stages[oKey] <= D.stages[dKey]) {
    // a critical hit ignores stat changes (and screens) when they would not help the attacker
    atk = A.stats[oKey]; def = D.stats[dKey]; screens = false;
    if (oKey === 'atk' && A.status === 'brn') atk = Math.max(1, atk >> 1);
  } else {
    atk = g2Stat(A, oKey); def = g2Stat(D, dKey);
  }
  if (screens && !special && D.reflect) def *= 2;
  if (screens && special && D.lscreen) def *= 2;
  if (atk > 255 || def > 255) { atk = Math.max(1, atk >> 2); def = Math.max(1, def >> 2); }
  if (o.explode) def = Math.max(1, def >> 1);
  let dmg = g2RawDamage(A.level, power, atk, def);
  if (crit) dmg *= 2;
  dmg += 2;
  const w = ctx.B.weather;
  if (w && w.turns > 0) {
    if (w.k === 'rain') { if (mv.t === 'water') dmg += dmg >> 1; else if (mv.t === 'fire') dmg >>= 1; }
    if (w.k === 'sun') { if (mv.t === 'fire') dmg += dmg >> 1; else if (mv.t === 'water') dmg >>= 1; }
  }
  if (A.types.includes(mv.t)) dmg += dmg >> 1; // STAB
  let mult = 1;
  for (const dt of D.types) {
    let r = g2TypeMult(mv.t, dt);
    if (r === 0 && D.foresight && dt === 'ghost' && (mv.t === 'normal' || mv.t === 'fighting')) r = 10;
    dmg = Math.floor(dmg * r / 10); mult *= r / 10;
  }
  return { dmg, mult, special };
}

function g2CritStage(A, mv) {
  let st = 0;
  if (A.focus) st += 1;
  if (mv.hc) st += 1;
  return Math.min(4, st);
}

function g2HitCheck(ctx, A, D, mv) {
  if (A.lockOn) { A.lockOn = false; return true; }
  if (mv.nm) return true;
  let acc = Math.floor(mv.a * 255 / 100);
  let [n, d] = G2_ACC_RATIOS[A.stages.acc + 6];
  acc = Math.max(1, Math.floor(acc * n / d));
  const eva = D.foresight ? Math.min(0, D.stages.eva) : D.stages.eva;
  [n, d] = G2_ACC_RATIOS[-eva + 6];
  acc = Math.max(1, Math.floor(acc * n / d));
  acc = Math.min(255, acc);
  return g2Rb(ctx.rng) < acc; // even 100% moves miss 1/256 of the time (Gen 2 keeps this quirk)
}

// ---------- helpers ----------
function g2Hurt(ctx, A, D, dmg, mv, special) {
  if (D.sub > 0) {
    if (dmg >= D.sub) { D.sub = 0; ctx.say(`${D.name}'s SUBSTITUTE broke!`); }
    else { D.sub -= dmg; ctx.say('The SUBSTITUTE took the hit!'); }
    D.hitTaken = { dmg, special: Boolean(special) };
    return 0;
  }
  let dealt = Math.min(dmg, D.currentHp);
  if (D.endure && dealt >= D.currentHp && D.currentHp > 1) { dealt = D.currentHp - 1; ctx.say(`${D.name} endured the hit!`); }
  D.currentHp -= dealt;
  D.hitTaken = { dmg, special: Boolean(special) };
  if (D.bide) D.bide.accum += dmg;
  if (D.rage && D.currentHp > 0 && mv && mv.p > 0 && D.stages.atk < 6) {
    D.stages.atk++;
    ctx.say(`${D.name}'s RAGE is building!`);
  }
  if (D.currentHp <= 0 && D.destiny) { A.currentHp = 0; ctx.say(`${D.name} took ${A.name} down with it!`); }
  return dealt;
}

function g2ClearVolatile(A) {
  A.charging = null; A.invuln = false; A.trapping = false; A.trapLeft = 0; A.thrash = 0; A.bide = null; A.rollN = 0;
}

function g2Heal(M, amt) { M.currentHp = Math.min(M.maxHp, M.currentHp + amt); }

function g2StatChange(ctx, M, stat, delta, byOther) {
  const s = M.stages[stat];
  const real = ['atk', 'def', 'spd', 'spa', 'sdf'].includes(stat);
  if (delta > 0) {
    if (s >= 6) { ctx.say('Nothing happened!'); return false; }
    if (real && g2ModStat(M, stat) >= 999) { ctx.say('Nothing happened!'); return false; }
    M.stages[stat] = Math.min(6, s + delta);
    ctx.say(`${M.name}'s ${G2_STAT_NAMES[stat]} ${delta > 1 ? 'sharply ' : ''}rose!`);
    return true;
  }
  if (s <= -6) { if (!byOther.silent) ctx.say('Nothing happened!'); return false; }
  if (real && g2ModStat(M, stat) <= 1) { if (!byOther.silent) ctx.say('Nothing happened!'); return false; }
  M.stages[stat] = Math.max(-6, s + delta);
  ctx.say(`${M.name}'s ${G2_STAT_NAMES[stat]} ${delta < -1 ? 'sharply ' : ''}fell!`);
  return true;
}

function g2RollConfusion(rng) { return 2 + (g2Rb(rng) & 3); }
function g2RollMulti(rng) { // 2-5 hits: 3/8, 3/8, 1/8, 1/8
  const r = g2Rb(rng) & 7;
  return r < 3 ? 0 : r < 6 ? 1 : r < 7 ? 2 : 3;
}

// can this Pokémon get a major status right now?
function g2CanStatus(D) { return D.status === null && !(D.safeguard > 0) && !(D.sub > 0); }

function g2SetStatus(ctx, D, kind, from) {
  if (kind === 'psn') { if (D.types.includes('poison') || D.types.includes('steel')) return false; D.status = 'psn'; ctx.say(`${D.name} was poisoned!`); }
  else if (kind === 'brn') { if (D.types.includes('fire')) return false; D.status = 'brn'; ctx.say(`${D.name} was burned!`); }
  else if (kind === 'frz') { if (D.types.includes('ice')) return false; D.status = 'frz'; D.recharge = false; ctx.say(`${D.name} was frozen solid!`); }
  else if (kind === 'par') { D.status = 'par'; ctx.say(`${D.name} is paralyzed! It may not attack!`); }
  else return false;
  return true;
}

// ---------- executing a move ----------
function g2Exec(ctx, A, D, key, o = {}) {
  const mv = GEN2.moves[key];
  const say = ctx.say;
  if (!o.noText) say(`${A.name} used ${mv.n}!`);
  if (!o.noPP) {
    const slot = A.moves.find((m) => m.k === key);
    if (slot && slot.pp > 0) slot.pp--;
  }
  if (!o.noRecord) A.lastMove = key;
  if (key !== 'FURY_CUTTER') A.furyN = 0;
  if (key !== 'ROLLOUT') A.rollN = 0;
  if (key !== 'PROTECT' && key !== 'DETECT' && key !== 'ENDURE') A.protectN = 0;
  const e = mv.e;

  if (e === 'MIRROR_MOVE_EFFECT') {
    const c = D.lastMove;
    if (!c || c === 'MIRROR_MOVE') { say('But it failed!'); return; }
    return g2Exec(ctx, A, D, c, { noPP: true, noRecord: true });
  }
  if (e === 'METRONOME_EFFECT') {
    const bad = new Set(['METRONOME', 'STRUGGLE', 'SLEEP_TALK', 'MIRROR_MOVE', 'COUNTER', 'MIRROR_COAT', 'PROTECT', 'DETECT', 'ENDURE', 'DESTINY_BOND', 'ENCORE', 'MIMIC']);
    const pool = Object.keys(GEN2.moves).filter((k) => !bad.has(k));
    const pick = pool[Math.floor(ctx.rng() * pool.length)];
    return g2Exec(ctx, A, D, pick, { noPP: true, noRecord: true });
  }

  // two-turn moves (Solarbeam skips the charge turn in sunlight)
  if (!o.charged && (e === 'CHARGE_EFFECT' || e === 'FLY_EFFECT')) {
    const sun = ctx.B.weather && ctx.B.weather.k === 'sun' && ctx.B.weather.turns > 0;
    if (!(key === 'SOLARBEAM' && sun)) {
      A.charging = key;
      if (key === 'FLY' || key === 'DIG') A.invuln = true;
      say(`${A.name} ${G2_CHARGE_TEXT[key] || 'is charging up!'}`);
      return;
    }
  }

  // Protect / Detect stop moves aimed at the Pokémon
  if (D.protect && !mv.self && key !== 'STRUGGLE') {
    say(`${D.name} protected itself!`);
    if (e === 'TRAPPING_EFFECT') { A.trapping = false; A.trapLeft = 0; }
    g2ClearVolatile(A);
    return;
  }

  if (mv.p > 0 || e === 'SPECIAL_DAMAGE_EFFECT' || e === 'SUPER_FANG_EFFECT' || e === 'OHKO_EFFECT' || mv.x === 'counter' || mv.x === 'mirror_coat') return g2Attack(ctx, A, D, key, mv, o);
  return g2StatusMove(ctx, A, D, key, mv);
}

function g2Attack(ctx, A, D, key, mv, o) {
  const say = ctx.say, rng = ctx.rng, e = mv.e, x = mv.x;
  let dmg = 0, crit = false, mult = 1, missed = false, immune = false, ohko = false, special = G2_SPECIAL_TYPES.has(mv.t);
  let power = mv.p;

  if (x === 'snore' && A.status !== 'slp') { say('But it failed!'); return; }
  if (!o.cont) {
    if (e === 'THRASH_PETAL_DANCE_EFFECT') { A.thrash = 2 + (g2Rb(rng) & 1); A.thrashKey = key; }
    if (e === 'TRAPPING_EFFECT') { A.trapping = true; A.trapKey = key; A.trapLeft = 1 + g2RollMulti(rng); }
    if (e === 'RAGE_EFFECT') A.rage = true;
  }

  // power overrides
  if (x === 'rollout') { A.rollN = (A.rollN || 0) + 1; power = 30 * Math.pow(2, A.rollN - 1); }
  else if (x === 'fury_cutter') { power = Math.min(160, 10 * Math.pow(2, A.furyN)); }
  else if (x === 'magnitude') {
    const r = rng() * 100;
    const t = r < 5 ? [10, 4] : r < 15 ? [30, 5] : r < 35 ? [50, 6] : r < 65 ? [70, 7] : r < 85 ? [90, 8] : r < 95 ? [110, 9] : [150, 10];
    power = t[0]; say(`Magnitude ${t[1]}!`);
  } else if (x === 'flail') {
    const f = Math.floor(A.currentHp * 48 / A.maxHp);
    power = f >= 33 ? 20 : f >= 17 ? 40 : f >= 10 ? 80 : f >= 5 ? 100 : f >= 2 ? 150 : 200;
  } else if (x === 'present') {
    const r = rng() * 100;
    if (r >= 80) {
      if (D.currentHp >= D.maxHp) say('But it failed!'); else { g2Heal(D, Math.max(1, D.maxHp >> 2)); say(`${D.name} regained health!`); }
      return;
    }
    power = r < 40 ? 40 : r < 70 ? 80 : 120;
  } else if (x === 'hidden_power') {
    const slot = A.moves.find((m) => m.k === key);
    if (slot) { power = slot.power; mv = { ...mv, t: slot.type }; special = G2_SPECIAL_TYPES.has(mv.t); }
  }
  if (key === 'SOLARBEAM' && ctx.B.weather && ctx.B.weather.k === 'rain' && ctx.B.weather.turns > 0) power = power >> 1;
  if (x === 'future_sight') {
    if (D.future) { say('But it failed!'); return; }
    if (!g2HitCheck(ctx, A, D, mv)) { say(`${A.name}'s attack missed!`); return; }
    const r = g2Damage(ctx, A, D, { ...mv, t: 'normal' }, false, { power });
    D.future = { turns: 3, dmg: Math.max(1, Math.floor(r.dmg * (217 + Math.floor(rng() * 39)) / 255)), by: A.name };
    say(`${A.name} foresaw an attack!`);
    return;
  }

  if (e === 'SPECIAL_DAMAGE_EFFECT') {
    if (key === 'SONICBOOM') dmg = 20;
    else if (key === 'DRAGON_RAGE') dmg = 40;
    else if (key === 'PSYWAVE') { const cap = A.level + (A.level >> 1); do { dmg = g2Rb(rng); } while (dmg === 0 || dmg >= cap); }
    else dmg = A.level; // Seismic Toss, Night Shade
    if (g2TypeMult(mv.t, D.types[0]) === 0 || (D.types[1] && g2TypeMult(mv.t, D.types[1]) === 0)) { missed = true; immune = true; }
  } else if (e === 'SUPER_FANG_EFFECT') {
    dmg = Math.max(1, D.currentHp >> 1);
  } else if (e === 'OHKO_EFFECT') {
    if (A.level < D.level) missed = true;
    else if (rng() * 100 >= 30 + A.level - D.level) missed = true;
    else {
      let m2 = 1; for (const dt of D.types) m2 *= g2TypeMult(mv.t, dt) / 10;
      if (m2 === 0) { missed = true; immune = true; } else { dmg = 65535; ohko = true; }
    }
  } else if (x === 'counter' || x === 'mirror_coat') {
    const want = x === 'mirror_coat';
    if (A.hitTaken && A.hitTaken.special === want && A.hitTaken.dmg > 0) {
      dmg = A.hitTaken.dmg * 2;
      let m2 = 1; for (const dt of D.types) m2 *= g2TypeMult(mv.t, dt) / 10;
      if (m2 === 0) { missed = true; immune = true; }
    } else missed = true;
  } else {
    const stage = g2CritStage(A, mv);
    crit = g2Rb(rng) < G2_CRIT_RATES[stage];
    if (mv.p === 1 && !x && key !== 'STRUGGLE') crit = false;
    const r = g2Damage(ctx, A, D, mv, crit, { power, explode: e === 'EXPLODE_EFFECT' });
    dmg = r.dmg; mult = r.mult;
    if (D.invuln) {
      if (D.charging === 'DIG' && (key === 'EARTHQUAKE' || key === 'MAGNITUDE')) dmg *= 2;
      if (D.charging === 'FLY' && (key === 'GUST' || key === 'TWISTER')) dmg *= 2;
    }
    if (mult === 0) { missed = true; immune = true; dmg = 0; }
    else {
      if (dmg < 1) dmg = 1;
      dmg = Math.max(1, Math.floor(dmg * (217 + Math.floor(rng() * 39)) / 255));
    }
  }

  // accuracy (Counter / Mirror Coat never miss once they have damage to return)
  if (!missed && x !== 'counter' && x !== 'mirror_coat') {
    if (e === 'DREAM_EATER_EFFECT' && D.status !== 'slp') missed = true;
    else if (e !== 'SWIFT_EFFECT' && e !== 'OHKO_EFFECT') {
      const hitsInvuln = D.invuln && ((D.charging === 'DIG' && (key === 'EARTHQUAKE' || key === 'MAGNITUDE')) || (D.charging === 'FLY' && (key === 'GUST' || key === 'TWISTER')));
      if (D.invuln && !hitsInvuln) missed = true;
      else if (!o.cont || e === 'THRASH_PETAL_DANCE_EFFECT') { if (!g2HitCheck(ctx, A, D, mv)) missed = true; }
    } else if (D.invuln && e !== 'OHKO_EFFECT') missed = true;
    if (e === 'OHKO_EFFECT' && D.invuln) missed = true;
  }

  if (missed) {
    if (immune) say(`It doesn't affect ${D.name}!`);
    else say(`${A.name}'s attack missed!`);
    if (e === 'TRAPPING_EFFECT') { A.trapping = false; A.trapLeft = 0; }
    if (e === 'JUMP_KICK_EFFECT') { A.currentHp = Math.max(0, A.currentHp - 1); say(`${A.name} kept going and crashed!`); }
    if (e === 'EXPLODE_EFFECT') { A.currentHp = 0; A.status = null; A.seeded = false; }
    A.rollN = 0; A.furyN = 0;
    return;
  }

  if (ohko) say('One-hit KO!');
  if (crit) say('A critical hit!');
  if (mult > 1) say("It's super effective!");
  else if (mult > 0 && mult < 1) say("It's not very effective...");

  if (x === 'false_swipe') dmg = Math.min(dmg, Math.max(0, D.currentHp - 1));
  if (D.status === 'frz' && mv.t === 'fire') { D.status = null; say(`Fire defrosted ${D.name}!`); }

  let hits = e === 'TWO_TO_FIVE_ATTACKS_EFFECT' ? 2 + g2RollMulti(rng)
    : (e === 'ATTACK_TWICE_EFFECT') ? 2 : x === 'triple_kick' ? 3 : 1;
  let total = 0, n = 0;
  for (let i = 0; i < hits; i++) {
    let d1 = dmg;
    if (x === 'triple_kick') {
      if (i > 0 && !g2HitCheck(ctx, A, D, mv)) break;
      const r2 = g2Damage(ctx, A, D, mv, false, { power: 10 * (i + 1) });
      d1 = Math.max(1, Math.floor(r2.dmg * (217 + Math.floor(rng() * 39)) / 255));
    }
    const hadSub = D.sub > 0;
    total += g2Hurt(ctx, A, D, d1, mv, special);
    n++;
    if (D.currentHp <= 0 || A.currentHp <= 0 || (hadSub && D.sub === 0)) break;
  }
  if (hits > 1) say(`Hit ${n} time${n > 1 ? 's' : ''}!`);
  say(`(-${total} HP) ${D.name} ${D.currentHp}/${D.maxHp}`);
  if (e === 'TRAPPING_EFFECT') A.trapDmg = Math.max(1, D.maxHp >> 4);

  if (x === 'fury_cutter') A.furyN = Math.min(4, A.furyN + 1);
  if (x === 'rollout' && A.rollN >= 5) A.rollN = 0;

  if (e === 'DRAIN_HP_EFFECT' || e === 'DREAM_EATER_EFFECT') {
    g2Heal(A, Math.max(1, total >> 1));
    say(`Sucked health from ${D.name}!`);
  }
  if (e === 'RECOIL_EFFECT') {
    const rec = Math.max(1, total >> 2);
    A.currentHp = Math.max(0, A.currentHp - rec);
    say(`${A.name} is hit with recoil! (-${rec})`);
  }
  if (e === 'EXPLODE_EFFECT') { A.currentHp = 0; A.status = null; A.seeded = false; }
  if (e === 'HYPER_BEAM_EFFECT' && D.currentHp > 0) A.recharge = true;
  if (e === 'PAY_DAY_EFFECT') say('Coins scattered everywhere!');
  if (x === 'rapid_spin') { A.seeded = false; D.trapping = false; D.trapLeft = 0; }

  if (D.currentHp <= 0) return;
  g2SideEffect(ctx, A, D, key, mv);
}

function g2SideEffect(ctx, A, D, key, mv) {
  const say = ctx.say, rng = ctx.rng;
  if (!mv.sec) return;
  for (const s of mv.sec) {
    if (s.k === 'allstats') {
      if (A.currentHp > 0 && g2Rb(rng) < Math.floor(s.c * 256 / 100)) {
        for (const st of ['atk', 'def', 'spd', 'spa', 'sdf']) if (A.stages[st] < 6) A.stages[st]++;
        say(`${A.name}'s stats rose!`);
      }
      continue;
    }
    if (s.self) {
      if (A.currentHp <= 0 || g2Rb(rng) >= Math.floor(s.c * 256 / 100)) continue;
      g2StatChange(ctx, A, s.st, s.d, {});
      continue;
    }
    if (D.sub > 0 || D.currentHp <= 0) return;
    if (g2Rb(rng) >= Math.floor(s.c * 256 / 100)) continue;
    if (s.k === 'flinch') { D.flinch = true; D.recharge = false; }
    else if (s.k === 'cnf') { if (D.conf === 0 && !(D.safeguard > 0)) { D.conf = g2RollConfusion(rng); say(`${D.name} became confused!`); } }
    else if (s.k === 'stat') { if (!D.mist) g2StatChange(ctx, D, s.st, s.d, { silent: true }); }
    else if (s.k === 'psn' || s.k === 'brn' || s.k === 'frz' || s.k === 'par') {
      if (!g2CanStatus(D)) continue;
      g2SetStatus(ctx, D, s.k);
    }
  }
}

function g2StatusMove(ctx, A, D, key, mv) {
  const say = ctx.say, rng = ctx.rng, e = mv.e, x = mv.x;
  const test = () => {
    if (D.invuln) return false;
    return g2HitCheck(ctx, A, D, mv);
  };
  const fail = () => say('But it failed!');

  let m = /^(ATTACK|DEFENSE|SPEED|SPA|SDF|ACCURACY|EVASION)_(UP|DOWN)([12])_EFFECT$/.exec(e);
  if (m) {
    const stat = G2_STAT_KEYS[m[1]], amt = Number(m[3]);
    if (m[2] === 'UP') { g2StatChange(ctx, A, stat, amt, {}); return; }
    if (D.sub > 0 || D.mist) { say(`${A.name}'s attack missed!`); return; }
    if (!test()) { say(`${A.name}'s attack missed!`); return; }
    g2StatChange(ctx, D, stat, -amt, {});
    return;
  }

  // ---------- Gen 2 special status moves ----------
  switch (x) {
    case 'fail': fail(); return;
    case 'protect': {
      const chance = A.protectN === 0 ? 255 : Math.floor(255 / Math.pow(2, A.protectN));
      if (g2Rb(rng) < chance) { A.protect = true; A.protectN++; say(`${A.name} protected itself!`); } else { A.protectN = 0; fail(); }
      return;
    }
    case 'endure': {
      const chance = A.protectN === 0 ? 255 : Math.floor(255 / Math.pow(2, A.protectN));
      if (g2Rb(rng) < chance) { A.endure = true; A.protectN++; say(`${A.name} braced itself!`); } else { A.protectN = 0; fail(); }
      return;
    }
    case 'destiny': A.destiny = true; say(`${A.name} is trying to take its foe down with it!`); return;
    case 'lock_on': A.lockOn = true; say(`${A.name} took aim at ${D.name}!`); return;
    case 'foresight': D.foresight = true; say(`${A.name} identified ${D.name}!`); return;
    case 'mean_look': if (!test()) { say(`${A.name}'s attack missed!`); return; } D.noEscape = true; say(`${D.name} can no longer escape!`); return;
    case 'perish': {
      if (A.perish > 0 && D.perish > 0) { fail(); return; }
      if (A.perish === 0) A.perish = 4;
      if (D.perish === 0) D.perish = 4;
      say('All Pokémon that heard the song will faint in 3 turns!');
      return;
    }
    case 'sandstorm': if (ctx.B.weather && ctx.B.weather.k === 'sand' && ctx.B.weather.turns > 0) { fail(); return; } ctx.B.weather = { k: 'sand', turns: 5 }; say('A sandstorm brewed!'); return;
    case 'rain': if (ctx.B.weather && ctx.B.weather.k === 'rain' && ctx.B.weather.turns > 0) { fail(); return; } ctx.B.weather = { k: 'rain', turns: 5 }; say('It started to rain!'); return;
    case 'sun': if (ctx.B.weather && ctx.B.weather.k === 'sun' && ctx.B.weather.turns > 0) { fail(); return; } ctx.B.weather = { k: 'sun', turns: 5 }; say('The sunlight turned harsh!'); return;
    case 'heal_weather': {
      if (A.currentHp >= A.maxHp) { fail(); return; }
      const w = ctx.B.weather && ctx.B.weather.turns > 0 ? ctx.B.weather.k : null;
      const amt = w === 'sun' ? A.maxHp : w ? A.maxHp >> 2 : A.maxHp >> 1;
      g2Heal(A, Math.max(1, amt)); say(`${A.name} regained health!`);
      return;
    }
    case 'safeguard': if (A.safeguard > 0) { fail(); return; } A.safeguard = 5; say(`${A.name}'s party is protected by SAFEGUARD!`); return;
    case 'heal_bell': A.status = null; A.badly = false; A.toxic = 0; say('A bell chimed! Status problems were cured!'); return;
    case 'sleep_talk': {
      if (A.status !== 'slp') { fail(); return; }
      const pool = A.moves.filter((s) => s.k !== 'SLEEP_TALK' && GEN2.moves[s.k] && s.pp > 0);
      if (!pool.length) { fail(); return; }
      const pick = pool[Math.floor(rng() * pool.length)];
      return g2Exec(ctx, A, D, pick.k, { noPP: true, noRecord: true });
    }
    case 'belly_drum': {
      if (A.currentHp <= (A.maxHp >> 1) || A.stages.atk >= 6) { fail(); return; }
      A.currentHp -= A.maxHp >> 1; A.stages.atk = 6;
      say(`${A.name} cut its own HP and maximized its ATTACK!`);
      return;
    }
    case 'swagger': {
      if (D.sub > 0 || !test()) { say(`${A.name}'s attack missed!`); return; }
      g2StatChange(ctx, D, 'atk', 2, {});
      if (D.conf === 0 && !(D.safeguard > 0)) { D.conf = g2RollConfusion(rng); say(`${D.name} became confused!`); }
      return;
    }
    case 'curse': {
      if (A.types.includes('ghost')) {
        if (D.cursed || D.sub > 0) { fail(); return; }
        A.currentHp = Math.max(1, A.currentHp - (A.maxHp >> 1));
        D.cursed = true; say(`${A.name} cut its own HP and laid a curse on ${D.name}!`);
      } else {
        g2StatChange(ctx, A, 'spd', -1, {}); g2StatChange(ctx, A, 'atk', 1, {}); g2StatChange(ctx, A, 'def', 1, {});
      }
      return;
    }
    case 'nightmare': {
      if (D.status !== 'slp' || D.nightmare || D.sub > 0 || !test()) { fail(); return; }
      D.nightmare = true; say(`${D.name} began having a nightmare!`);
      return;
    }
    case 'spite': {
      const last = D.lastMove && D.moves.find((s) => s.k === D.lastMove);
      if (!last || last.pp <= 0 || !test()) { fail(); return; }
      const cut = Math.min(last.pp, 2 + (g2Rb(rng) % 4));
      last.pp -= cut; say(`${D.name}'s ${last.name} lost ${cut} PP!`);
      return;
    }
    case 'encore': {
      const last = D.lastMove && D.moves.find((s) => s.k === D.lastMove);
      if (D.encore || !last || last.pp <= 0 || !test()) { fail(); return; }
      D.encore = { key: D.lastMove, turns: 2 + (g2Rb(rng) % 5) };
      say(`${D.name} got an ENCORE!`);
      return;
    }
    case 'psych_up': A.stages = { ...D.stages }; say(`${A.name} copied ${D.name}'s stat changes!`); return;
    case 'pain_split': {
      if (D.sub > 0) { fail(); return; }
      const avg = Math.floor((A.currentHp + D.currentHp) / 2);
      A.currentHp = Math.min(A.maxHp, avg); D.currentHp = Math.min(D.maxHp, avg);
      say('The battlers shared their pain!');
      return;
    }
    case 'conversion2': {
      const last = D.lastMove && GEN2.moves[D.lastMove];
      if (!last) { fail(); return; }
      const cands = Object.keys(G2_CHART).concat(['normal']).filter((t, i, arr) => arr.indexOf(t) === i && g2TypeMult(last.t, t) < 10);
      if (!cands.length) { fail(); return; }
      A.types = [cands[Math.floor(rng() * cands.length)]];
      say(`${A.name} became a ${A.types[0].toUpperCase()} type!`);
      return;
    }
  }

  switch (e) {
    case 'SLEEP_EFFECT': {
      if (D.recharge) { D.recharge = false; }
      else if (D.status === 'slp') { say(`${D.name} is already asleep!`); return; }
      else if (D.status !== null || D.safeguard > 0 || D.sub > 0) { say("It didn't affect " + D.name + '!'); return; }
      else if (!test()) { say(`${A.name}'s attack missed!`); return; }
      D.status = 'slp'; D.sleep = 1 + Math.floor(rng() * 7);
      say(`${D.name} fell asleep!`);
      return;
    }
    case 'POISON_EFFECT': {
      if (!g2CanStatus(D) || D.types.includes('poison') || D.types.includes('steel')) { say("It didn't affect " + D.name + '!'); return; }
      if (!test()) { say(`${A.name}'s attack missed!`); return; }
      D.status = 'psn';
      if (key === 'TOXIC') { D.badly = true; D.toxic = 0; say(`${D.name}'s badly poisoned!`); } else say(`${D.name} was poisoned!`);
      return;
    }
    case 'PARALYZE_EFFECT': {
      if (!g2CanStatus(D)) { say("It didn't affect " + D.name + '!'); return; }
      if (mv.t === 'electric' && D.types.includes('ground')) { say(`It doesn't affect ${D.name}!`); return; }
      if (!test()) { say(`${A.name}'s attack missed!`); return; }
      D.status = 'par';
      say(`${D.name}'s paralyzed! It may not attack!`);
      return;
    }
    case 'CONFUSION_EFFECT': {
      if (D.sub > 0 || D.safeguard > 0 || !test() || D.conf > 0) { fail(); return; }
      D.conf = g2RollConfusion(rng);
      say(`${D.name} became confused!`);
      return;
    }
    case 'HEAL_EFFECT': {
      if (A.currentHp >= A.maxHp) { fail(); return; }
      if (key === 'REST') {
        A.status = 'slp'; A.sleep = 2; A.badly = false;
        g2Heal(A, A.maxHp);
        say(`${A.name} started sleeping!`);
      } else {
        g2Heal(A, A.maxHp >> 1);
        say(`${A.name} regained health!`);
      }
      return;
    }
    case 'LIGHT_SCREEN_EFFECT': if (A.lscreen) fail(); else { A.lscreen = true; say(`${A.name}'s protected against special attacks!`); } return;
    case 'REFLECT_EFFECT': if (A.reflect) fail(); else { A.reflect = true; say(`${A.name} gained armor!`); } return;
    case 'MIST_EFFECT': if (A.mist) fail(); else { A.mist = true; say(`${A.name}'s shrouded in mist!`); } return;
    case 'FOCUS_ENERGY_EFFECT': if (A.focus) fail(); else { A.focus = true; say(`${A.name}'s getting pumped!`); } return;
    case 'HAZE_EFFECT': {
      for (const M of [A, D]) {
        M.stages = G2_FRESH_STAGES();
        M.conf = 0; M.disabled = null; M.disabledTurns = 0; M.mist = false; M.focus = false; M.seeded = false;
      }
      say('All stat changes were eliminated!');
      return;
    }
    case 'CONVERSION_EFFECT': A.types = D.types.slice(); say(`Converted type to match ${D.name}'s!`); return;
    case 'TRANSFORM_EFFECT': {
      A.types = D.types.slice();
      A.stats = { hp: A.stats.hp, atk: D.stats.atk, def: D.stats.def, spd: D.stats.spd, spa: D.stats.spa, sdf: D.stats.sdf };
      A.stages = { ...D.stages };
      A.moves = D.moves.map((s) => ({ ...s, pp: 5, maxPp: 5 }));
      A.speciesId = D.speciesId; A.spriteId = D.spriteId;
      say(`${A.name} transformed into ${D.name}!`);
      return;
    }
    case 'SUBSTITUTE_EFFECT': {
      if (A.sub > 0) { say(`${A.name} has a SUBSTITUTE!`); return; }
      const cost = A.maxHp >> 2;
      if (A.currentHp - cost <= 0) { say('Too weak to make a SUBSTITUTE!'); return; }
      A.currentHp -= cost; A.sub = cost;
      say(`${A.name} made a SUBSTITUTE!`);
      return;
    }
    case 'LEECH_SEED_EFFECT': {
      if (!test() || D.types.includes('grass') || D.seeded || D.sub > 0) { say(`${D.name} evaded the attack!`); return; }
      D.seeded = true;
      say(`${D.name} was seeded!`);
      return;
    }
    case 'DISABLE_EFFECT': {
      if (D.disabled || !test()) { fail(); return; }
      const cands = D.moves.filter((s) => s.pp > 0);
      if (cands.length === 0) { fail(); return; }
      const pick = cands[Math.floor(rng() * cands.length)];
      D.disabled = pick.k; D.disabledTurns = 2 + (g2Rb(rng) & 7);
      say(`${D.name}'s ${pick.name} was disabled!`);
      return;
    }
    case 'MIMIC_EFFECT': {
      if (!test() || !D.lastMove || !GEN2.moves[D.lastMove]) { fail(); return; }
      const idx = A.moves.findIndex((s) => s.k === 'MIMIC');
      if (idx >= 0) A.moves[idx] = { ...g2MoveEntry(D.lastMove, A.dvs), pp: 5, maxPp: GEN2.moves[D.lastMove].pp };
      say(`${A.name} learned ${GEN2.moves[D.lastMove].n}!`);
      return;
    }
    case 'BIDE_EFFECT': A.bide = { turns: 2 + (g2Rb(rng) & 1), accum: 0 }; say(`${A.name} is storing energy!`); return;
    case 'SPLASH_EFFECT': say('No effect!'); return;
    case 'SWITCH_AND_TELEPORT_EFFECT': fail(); return;
    default: say('But nothing happened!');
  }
}

// ---------- one action (status gates + move) ----------
function g2Act(ctx, A, D, sel) {
  const say = ctx.say, rng = ctx.rng;
  if (A.currentHp <= 0 || D.currentHp <= 0 || !sel) return;
  A.destiny = false; // Destiny Bond only lasts until the user moves again
  const mvKey = sel.key;

  if (A.status === 'slp') {
    A.lastMove = null; A.sleep--;
    if (A.sleep > 0) {
      say(`${A.name} is fast asleep.`);
      if (mvKey !== 'SLEEP_TALK' && mvKey !== 'SNORE') return;
    } else { A.status = null; A.nightmare = false; say(`${A.name} woke up!`); }
  }
  if (A.status === 'frz') {
    const mvd = GEN2.moves[mvKey];
    if (mvd && mvd.thaw) { A.status = null; say(`${A.name} thawed out!`); }
    else if (g2Rb(rng) < 25) { A.status = null; say(`${A.name} thawed out!`); }
    else { A.lastMove = null; say(`${A.name} is frozen solid!`); return; }
  }
  if (A.flinch) { A.flinch = false; say(`${A.name} flinched!`); g2ClearVolatile(A); return; }
  if (A.recharge) { A.recharge = false; say(`${A.name} must recharge!`); return; }
  if (A.disabledTurns > 0) {
    A.disabledTurns--;
    if (A.disabledTurns === 0) { A.disabled = null; say(`${A.name} is no longer disabled!`); }
  }
  if (A.encore) {
    A.encore.turns--;
    if (A.encore.turns <= 0) { A.encore = null; say(`${A.name}'s encore ended!`); }
  }
  if (A.conf > 0) {
    A.conf--;
    if (A.conf === 0) say(`${A.name} is no longer confused!`);
    else {
      say(`${A.name} is confused!`);
      if (g2Rb(rng) >= 128) {
        const dmg = Math.max(1, Math.floor(Math.floor(Math.floor(2 * A.level / 5 + 2) * 40 * g2Stat(A, 'atk') / Math.max(1, g2Stat(A, 'def'))) / 50) + 2);
        A.currentHp = Math.max(0, A.currentHp - dmg);
        say(`It hurt itself in its confusion! (-${dmg})`);
        g2ClearVolatile(A);
        return;
      }
    }
  }
  if (A.disabled && mvKey === A.disabled) { say(`${A.name}'s move is disabled!`); return; }
  if (A.status === 'par' && g2Rb(rng) < 63) {
    say(`${A.name} is fully paralyzed!`);
    g2ClearVolatile(A);
    return;
  }

  // Bide
  if (A.bide) {
    A.bide.turns--;
    if (A.bide.turns > 0) { say(`${A.name} is storing energy!`); return; }
    const dmg = A.bide.accum * 2;
    A.bide = null;
    say(`${A.name} unleashed energy!`);
    if (dmg === 0) { say(`${A.name}'s attack missed!`); return; }
    const dealt = g2Hurt(ctx, A, D, dmg, null, false);
    say(`(-${dealt} HP) ${D.name} ${D.currentHp}/${D.maxHp}`);
    return;
  }
  // Thrash / Outrage / Petal Dance continues
  if (A.thrash > 0) {
    A.thrash--;
    say(`${A.name}'s thrashing about!`);
    if (A.thrash === 0) A.conf = g2RollConfusion(rng);
    return g2Exec(ctx, A, D, A.thrashKey, { noPP: true, noText: true, cont: true, noRecord: true });
  }
  // Wrap/Bind/Fire Spin/Clamp/Whirlpool continues
  if (A.trapping) {
    say(`${A.name}'s attack continues!`);
    A.trapLeft--;
    const dealt = g2Hurt(ctx, A, D, A.trapDmg, null, false);
    say(`(-${dealt} HP) ${D.name} ${D.currentHp}/${D.maxHp}`);
    if (A.trapLeft <= 0) A.trapping = false;
    return;
  }
  if (A.rage) return g2Exec(ctx, A, D, 'RAGE', { cont: true });
  if (A.charging) {
    const k = A.charging;
    A.charging = null; A.invuln = false;
    return g2Exec(ctx, A, D, k, { charged: true });
  }
  // Rollout keeps going until it misses or hits 5 times
  if (A.rollN > 0 && A.rollN < 5 && mvKey === 'ROLLOUT') return g2Exec(ctx, A, D, 'ROLLOUT', {});
  return g2Exec(ctx, A, D, mvKey, {});
}

// ---------- end of round: status damage, weather, Perish Song, Future Sight ----------
function g2EndOfRound(ctx, order) {
  const B = ctx.B;
  for (const side of order) {
    const A = B[side + 'Mon'], D = B[(side === 'p1' ? 'p2' : 'p1') + 'Mon'];
    if (A.currentHp <= 0) continue;
    const base = Math.max(1, A.maxHp >> 3);
    if (A.status === 'psn' || A.status === 'brn') {
      let dmg = base;
      if (A.badly && A.status === 'psn') { A.toxic++; dmg = Math.max(1, (A.maxHp >> 4) * A.toxic); }
      A.currentHp = Math.max(0, A.currentHp - dmg);
      ctx.say(`${A.name} is hurt by ${A.status === 'brn' ? 'its burn' : 'poison'}! (-${dmg})`);
    }
    if (A.currentHp > 0 && A.seeded) {
      const dealt = Math.min(base, A.currentHp);
      A.currentHp -= dealt;
      if (D.currentHp > 0) g2Heal(D, dealt);
      ctx.say(`LEECH SEED saps ${A.name}! (-${dealt})`);
    }
    if (A.currentHp > 0 && A.nightmare && A.status === 'slp') {
      const dmg = Math.max(1, A.maxHp >> 2); A.currentHp = Math.max(0, A.currentHp - dmg);
      ctx.say(`${A.name} is locked in a nightmare! (-${dmg})`);
    }
    if (A.currentHp > 0 && A.cursed) {
      const dmg = Math.max(1, A.maxHp >> 2); A.currentHp = Math.max(0, A.currentHp - dmg);
      ctx.say(`${A.name} is afflicted by the curse! (-${dmg})`);
    }
  }
  // weather
  if (B.weather && B.weather.turns > 0) {
    if (B.weather.k === 'sand') {
      ctx.say('The sandstorm rages.');
      for (const side of order) {
        const A = B[side + 'Mon'];
        if (A.currentHp > 0 && !A.invuln && !A.types.some((t) => t === 'rock' || t === 'ground' || t === 'steel')) {
          const dmg = Math.max(1, A.maxHp >> 3); A.currentHp = Math.max(0, A.currentHp - dmg);
          ctx.say(`${A.name} is buffeted by the sandstorm! (-${dmg})`);
        }
      }
    }
    B.weather.turns--;
    if (B.weather.turns <= 0) {
      ctx.say(B.weather.k === 'rain' ? 'The rain stopped.' : B.weather.k === 'sun' ? 'The sunlight faded.' : 'The sandstorm subsided.');
      B.weather = null;
    }
  }
  for (const side of order) {
    const A = B[side + 'Mon'];
    if (A.currentHp <= 0) continue;
    if (A.future) {
      A.future.turns--;
      if (A.future.turns <= 0) {
        const dmg = Math.min(A.future.dmg, A.currentHp);
        A.currentHp -= dmg; ctx.say(`${A.name} took the FUTURE SIGHT attack! (-${dmg})`);
        A.future = null;
      }
    }
    if (A.currentHp > 0 && A.perish > 0) {
      A.perish--;
      ctx.say(`${A.name}'s perish count fell to ${A.perish}!`);
      if (A.perish === 0) A.currentHp = 0;
    }
    if (A.safeguard > 0) { A.safeguard--; if (A.safeguard === 0) ctx.say(`${A.name}'s SAFEGUARD wore off!`); }
  }
}

// ---------- rounds ----------
const G2_SLEEP_MOVES = new Set(['SLEEP_TALK', 'SNORE']);
function g2Needs(B, side) {
  const m = B[side + 'Mon'];
  if (m.currentHp <= 0) return false;
  if (m.charging || m.thrash > 0 || m.trapping || m.bide || m.rage || m.recharge) return false;
  if (m.encore || (m.rollN > 0 && m.rollN < 5)) return false;
  if (m.status === 'slp' && !m.moves.some((s) => G2_SLEEP_MOVES.has(s.k) && s.pp > 0)) return false;
  if (m.status === 'frz' && !m.moves.some((s) => GEN2.moves[s.k] && GEN2.moves[s.k].thaw && s.pp > 0)) return false;
  return true;
}
function g2Usable(m) {
  return m.moves.map((mv, i) => ({ i, ok: mv.pp > 0 && mv.k !== m.disabled })).filter((x) => x.ok).map((x) => x.i);
}
function g2NeedsPick(B, side) {
  if (!g2Needs(B, side)) return false;
  return g2Usable(B[side + 'Mon']).length > 0; // none usable -> automatic Struggle
}

function g2StartRound(B) {
  B.round = (B.round || 0) + 1;
  B.picks = { p1: null, p2: null };
  B.pickState = { p1: g2NeedsPick(B, 'p1') ? 'wait' : 'auto', p2: g2NeedsPick(B, 'p2') ? 'wait' : 'auto' };
  for (const M of [B.p1Mon, B.p2Mon]) {
    M.flinch = false; M.hitTaken = null; M.protect = false; M.endure = false;
  }
  B.roundStartedAt = Date.now();
}

function g2Ready(B) { return B.pickState.p1 !== 'wait' && B.pickState.p2 !== 'wait'; }

function g2Pick(B, side, idx) {
  const m = B[side + 'Mon'];
  if (B.pickState[side] === 'auto') return { ok: false, msg: `${m.name} can't choose a move this turn, it acts on its own.` };
  if (B.pickState[side] === 'done') return { ok: false, msg: 'You already chose your move this round. Wait for the other trainer!' };
  const mv = m.moves[idx];
  if (!mv) return { ok: false, msg: `Pick a move from 1-${m.moves.length}.` };
  if (mv.pp <= 0) return { ok: false, msg: `${mv.name.toUpperCase()} has no PP left! Pick another move.` };
  if (m.disabled === mv.k) return { ok: false, msg: `${mv.name.toUpperCase()} is disabled! Pick another move.` };
  B.picks[side] = idx;
  B.pickState[side] = 'done';
  return { ok: true, move: mv };
}

function g2Selection(B, side) {
  const m = B[side + 'Mon'];
  if (m.bide) return { key: 'BIDE', cont: true };
  if (m.thrash > 0) return { key: m.thrashKey, cont: true };
  if (m.trapping) return { key: m.trapKey, cont: true };
  if (m.rage) return { key: 'RAGE', cont: true };
  if (m.charging) return { key: m.charging, cont: true };
  if (m.encore) return { key: m.encore.key, cont: true };
  if (m.rollN > 0 && m.rollN < 5) return { key: 'ROLLOUT', cont: true };
  const st = B.pickState[side];
  if (st === 'timeout') return null;
  if (st === 'done') return { key: m.moves[B.picks[side]].k };
  // 'auto': nothing to choose (asleep, recharging...) or no PP left -> Struggle
  const usable = g2Usable(m);
  if (usable.length === 0 && g2Needs(B, side)) return { key: 'STRUGGLE' };
  return { key: m.moves[0] ? m.moves[0].k : 'STRUGGLE', auto: true };
}

function g2Priority(sel) {
  if (!sel) return 0;
  const mv = GEN2.moves[sel.key];
  return mv && mv.pri ? mv.pri : 0;
}

function g2ResolveRound(B, rng = Math.random) {
  const log = [];
  const ctx = {
    B, rng, log, skip: { p1: false, p2: false },
    say: (t) => log.push(t),
    sideOf: (M) => (M === B.p1Mon ? 'p1' : 'p2')
  };
  const sel = { p1: g2Selection(B, 'p1'), p2: g2Selection(B, 'p2') };
  for (const s of ['p1', 'p2']) {
    const M = B[s + 'Mon'];
    if (B.pickState[s] === 'timeout' && !(M.charging || M.thrash || M.trapping || M.bide || M.rage || M.encore || M.rollN)) {
      log.push(`⏰ @${B[s]}, time has passed! No move this round.`);
    }
  }

  // who goes first: priority, then speed, then coin flip
  let order = ['p1', 'p2'];
  const pr1 = g2Priority(sel.p1), pr2 = g2Priority(sel.p2);
  if (pr1 !== pr2) order = pr1 > pr2 ? ['p1', 'p2'] : ['p2', 'p1'];
  else {
    const s1 = g2Stat(B.p1Mon, 'spd'), s2 = g2Stat(B.p2Mon, 'spd');
    if (s1 !== s2) order = s1 > s2 ? ['p1', 'p2'] : ['p2', 'p1'];
    else if (rng() < 0.5) order = ['p2', 'p1'];
  }

  for (const side of order) {
    const A = B[side + 'Mon'], D = B[(side === 'p1' ? 'p2' : 'p1') + 'Mon'];
    if (A.currentHp <= 0 || D.currentHp <= 0) break;
    if (ctx.skip[side]) { ctx.skip[side] = false; continue; }
    g2Act(ctx, A, D, sel[side]);
    if (A.currentHp <= 0 || D.currentHp <= 0) break;
  }
  if (B.p1Mon.currentHp > 0 && B.p2Mon.currentHp > 0) g2EndOfRound(ctx, order);

  const f1 = B.p1Mon.currentHp <= 0, f2 = B.p2Mon.currentHp <= 0;
  if (f1 || f2) {
    let winner;
    if (f1 && f2) winner = order[0] === 'p1' ? 'p2' : 'p1'; // both fainted: the one who moved first (attacker) loses
    else winner = f1 ? 'p2' : 'p1';
    const loserMon = winner === 'p1' ? B.p2Mon : B.p1Mon;
    log.push(`${loserMon.name} fainted!`);
    B.ended = { winner, reason: 'faint' };
  }
  B.lastLines = log.slice();
  return log.join(' ');
}


// --- POKÉMON CREATION / EVOLUTION (Gen 1 + 2 data, no external API needed) ---
async function generatePokemon(idOrName, forceShiny = null) {
  return g2CreateMon(Number(idOrName), forceShiny);
}

// Pokémon saved before the Gen 2 update are rebuilt with real Gen 2 stats and moves (species, shiny status and uid are kept)
function upgradeUser(db, name) {
  const u = db.users[name];
  if (!u || !Array.isArray(u.inventory)) return false;
  let changed = false;
  u.inventory = u.inventory.map((p) => {
    const fixed = g2EnsureMon(p);
    if (fixed !== p) changed = true;
    return fixed;
  });
  return changed;
}

// Remember every species a trainer ever caught as shiny (shown on the Pokédex website)
function markShiny(db, user, mon) {
  if (!mon || !mon.isShiny || !db.users[user]) return;
  if (!Array.isArray(db.users[user].shinies)) db.users[user].shinies = [];
  if (!db.users[user].shinies.includes(mon.id)) db.users[user].shinies.push(mon.id);
}

// Remember the FIRST time a trainer got each species (and each shiny species). Later catches never change it.
function recordFirstCatch(db, user, mon) {
  const u = db.users[user];
  if (!mon || !u) return;
  if (!u.dexDates || typeof u.dexDates !== 'object') u.dexDates = {};
  if (!u.dexDates[mon.id]) u.dexDates[mon.id] = Date.now();
  if (mon.isShiny) {
    if (!u.shinyDates || typeof u.shinyDates !== 'object') u.shinyDates = {};
    if (!u.shinyDates[mon.id]) u.shinyDates[mon.id] = Date.now();
  }
}

async function checkEvolution(db, user) {
  const inv = db.users[user].inventory;
  const counts = {};
  inv.forEach(p => {
    const key = `${p.id}|${p.isShiny ? '1' : '0'}`;
    counts[key] = (counts[key] || 0) + 1;
  });

  for (const [key, count] of Object.entries(counts)) {
    if (count < 3) continue;
    const [idStr, shinyFlag] = key.split('|');
    const speciesId = Number(idStr);
    const isShinyGroup = shinyFlag === '1';
    const species = GEN2.mons[speciesId];
    if (!species || !species.e || species.e.length === 0) continue;

    const nextId = species.e[Math.floor(Math.random() * species.e.length)];
    let removed = 0;
    db.users[user].inventory = inv.filter(p => {
      if (p.id === speciesId && Boolean(p.isShiny) === isShinyGroup && removed < 3) {
        removed++;
        return false;
      }
      return true;
    });

    const evolvedMon = g2CreateMon(nextId, isShinyGroup);
    db.users[user].inventory.push(evolvedMon);
    if (!db.users[user].pokedex.includes(evolvedMon.id)) db.users[user].pokedex.push(evolvedMon.id);
    markShiny(db, user, evolvedMon);
    recordFirstCatch(db, user, evolvedMon);
    await saveDB(db);

    const shinyTag = isShinyGroup ? '✨SHINY ' : '';
    return `🌟 EVOLUTION! @${user}'s three ${shinyTag}${species.n} merged into ${shinyTag}${evolvedMon.name}!`;
  }
  return null;
}

// Remember how the last battle ended so the OBS overlay can play the ending animation
function recordBattleEnd(db, battle, winner, reason, message) {
  if (winner && db.users[winner]) db.users[winner].battleWins = (db.users[winner].battleWins || 0) + 1;
  db.lastBattleResult = {
    at: Date.now(),
    p1: battle.p1,
    p2: battle.p2,
    createdAt: battle.createdAt || 0,
    startedAt: battle.startedAt || 0,
    round: battle.round || 0,
    seq: battle.seq || 0,
    roundLines: battle.roundLines || [],
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
const ACCEPT_WARN_MS = 60 * 1000;      // second warning when this much time is left to accept a challenge
const MOVE_LIMIT_MS = 30 * 1000;       // time each player has to use !move
const MOVE_LIMIT_SECS = MOVE_LIMIT_MS / 1000;
const BATTLE_RULES = `📜 Gen 2 rules: each round both trainers pick !move <1-4> within ${MOVE_LIMIT_SECS}s (no pick = no attack). Faster Pokémon moves first. Battle max 5 min.`;

function pickLine(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function trimChat(s, max) {
  s = String(s);
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const i = cut.lastIndexOf(' ');
  return (i > max * 0.6 ? cut.slice(0, i) : cut) + '…';
}

function findBattleKey(db, user) {
  return Object.keys(db.activeBattles || {}).find(k => {
    const b = db.activeBattles[k];
    return b && (b.p1 === user || b.p2 === user);
  });
}

// --- BATTLE COMMENTATOR ---
function roundCommentary(B, text) {
  const low = [B.p1Mon, B.p2Mon].find(m => m.currentHp > 0 && m.currentHp / m.maxHp <= 0.2);
  if (low) return pickLine([`${low.name} is hanging by a thread!`, `Danger zone! ${low.name} is barely standing!`]);
  if (/critical/.test(text)) return pickLine(['A critical hit! What a moment!', 'Right on the weak spot, that one hurt!']);
  if (/super effective/.test(text)) return pickLine(['Super effective, smart pick!', 'Found the weakness!']);
  if (/missed|doesn't affect/.test(text)) return pickLine(['What a whiff!', 'So close, yet so far!']);
  if (/asleep|paralyzed|frozen|confused|flinched|poisoned|burned/.test(text)) return pickLine(['Status effects are turning the tide!', 'Luck is not on their side this round!']);
  return pickLine(['The battle is heating up!', 'Neither side is backing down!', 'Solid exchange!']);
}

// Resolves every round that is ready (both trainers picked, or nobody has to pick) and returns the chat message.
function concludeRounds(db, key, battle) {
  const lines = [];
  let guard = 0;
  while (!battle.ended && g2Ready(battle) && guard++ < 25) {
    g2ResolveRound(battle);
    lines.push(...(battle.lastLines || []));
    battle.seq = (battle.seq || 0) + 1;
    if (!battle.ended) g2StartRound(battle);
  }
  battle.roundLines = lines.slice(-14);
  const text = lines.join(' ');

  if (battle.ended) {
    const winner = battle[battle.ended.winner];
    const loserMon = battle.ended.winner === 'p1' ? battle.p2Mon : battle.p1Mon;
    const finalMsg = `${loserMon.name} fainted! @${winner} wins!`;
    battle.lastLog = finalMsg;
    recordBattleEnd(db, battle, winner, 'faint', finalMsg);
    delete db.activeBattles[key];
    return `💥 ${trimChat(text, 330)} 🏆 @${winner} [emote:5756671:GIGACHAD] wins! @${battle[battle.ended.winner === 'p1' ? 'p2' : 'p1']} [emote:1730802:emojiOuch] 🎙️ ${pickLine(["And that's the match! What a finish!", `${loserMon.name} gave it everything, but it's over!`, 'Incredible battle, chat!'])}`;
  }

  const waiting = ['p1', 'p2'].filter(s => battle.pickState[s] === 'wait').map(s => '@' + battle[s]);
  battle.lastLog = `Round ${battle.round}: choose your moves!`;
  const hp = `[${battle.p1Mon.name} ${battle.p1Mon.currentHp}/${battle.p1Mon.maxHp} | ${battle.p2Mon.name} ${battle.p2Mon.currentHp}/${battle.p2Mon.maxHp}]`;
  return `⚔️ ${trimChat(text, 290)} ${hp} 🎙️ ${roundCommentary(battle, text)} Round ${battle.round}: ${waiting.join(' & ')} use !move <1-4> (${MOVE_LIMIT_SECS}s)!`;
}

// Applies time limits to one battle. Mutates db and returns a chat message, or null if nothing happened.
function applyBattleTimers(db, key, battle) {
  const now = Date.now();

  // Challenge that nobody accepted yet: warn the challenged trainer at 60s left, cancel after 5 minutes
  if (!battle.p2Mon) {
    if (!battle.createdAt) battle.createdAt = now;
    const left = BATTLE_LIMIT_MS - (now - battle.createdAt);
    if (left <= 0) {
      delete db.activeBattles[key];
      return `⏰ @${battle.p2} didn't accept in time, so @${battle.p1}'s battle challenge has been canceled.`;
    }
    if (left <= ACCEPT_WARN_MS && !battle.warned60) {
      battle.warned60 = true;
      return `⏳ @${battle.p2}, only ${Math.ceil(left / 1000)} seconds left to accept @${battle.p1}'s battle! Type !battle @${battle.p1} <slot> now or the challenge will be canceled.`;
    }
    return null;
  }

  // Battles saved by the old engine can't continue
  if (!battle.pickState || (battle.p1Mon && !battle.p1Mon.v2)) {
    delete db.activeBattles[key];
    return `⚠️ The battle between @${battle.p1} and @${battle.p2} was canceled because the bot was updated to Gen 2 rules. Start a new one with !battle!`;
  }

  if (!battle.startedAt) battle.startedAt = now;

  // 5 minute battle limit: higher remaining HP% wins
  if (now - battle.startedAt > BATTLE_LIMIT_MS) {
    delete db.activeBattles[key];
    const p1Pct = battle.p1Mon.currentHp / battle.p1Mon.maxHp;
    const p2Pct = battle.p2Mon.currentHp / battle.p2Mon.maxHp;
    const p1Txt = `${battle.p1Mon.name} ${Math.round(p1Pct * 100)}%`;
    const p2Txt = `${battle.p2Mon.name} ${Math.round(p2Pct * 100)}%`;
    if (p1Pct === p2Pct) {
      recordBattleEnd(db, battle, null, 'time', 'Time is up! It is a draw!');
      return `⏰ Time's up! The 5 minute limit is over (${p1Txt} vs ${p2Txt}). It's a draw between @${battle.p1} and @${battle.p2}!`;
    }
    const winner = p1Pct > p2Pct ? battle.p1 : battle.p2;
    recordBattleEnd(db, battle, winner, 'time', `Time is up! @${winner} wins on remaining HP!`);
    return `⏰ Time's up! The 5 minute limit is over (${p1Txt} vs ${p2Txt}). 🏆 @${winner} [emote:5756671:GIGACHAD] wins on remaining HP! @${winner === battle.p1 ? battle.p2 : battle.p1} [emote:1730802:emojiOuch]`;
  }

  // Move limit: whoever didn't pick loses their action this round, the other trainer's Pokémon still attacks
  if (battle.roundStartedAt && now - battle.roundStartedAt > MOVE_LIMIT_MS) {
    let late = 0;
    for (const s of ['p1', 'p2']) {
      if (battle.pickState[s] === 'wait') { battle.pickState[s] = 'timeout'; late++; }
    }
    if (late > 0) return concludeRounds(db, key, battle);
  }

  return null;
}

async function triggerSpawn(db, forceShiny = null) {
  const randomId = Math.floor(Math.random() * MAX_POKEMON_ID) + 1;
  const mon = await generatePokemon(randomId, forceShiny);
  const now = Date.now();
  db.activeSpawn = { ...mon, caughtBy: [], attempts: {}, spawnedAt: now, expiresAt: now + CATCH_WINDOW_MS };
  await saveDB(db);

  const shinyTag = mon.isShiny ? '✨SHINY ' : '';
  return `🌿 A wild ${shinyTag}${mon.name} (${mon.types.join('/').toUpperCase()}) appeared! Type !catch within ${CATCH_WINDOW_MS / 1000} seconds to throw a Pokéball! (${MAX_CATCH_TRIES} tries each) [emote:5756381:modCheck]`;
}

// Time until the next spawn (spawns come from the cron job every SPAWN_INTERVAL_MINUTES)
function nextSpawnText(db, spawn) {
  const interval = SPAWN_INTERVAL_MINUTES * 60 * 1000;
  const base = db.lastAutoSpawnAt || spawn.spawnedAt;
  let next = base + interval;
  while (next < (db.autoSpawnBlockedUntil || 0)) next += interval; // a manual !spawn pushes the automatic spawn back
  const msLeft = next - Date.now();
  if (msLeft <= 0) return 'a few seconds (any moment now)';
  if (msLeft >= 60000) return `${Math.floor(msLeft / 60000)}m ${Math.floor((msLeft % 60000) / 1000)}s`;
  return `${Math.ceil(msLeft / 1000)}s`;
}

async function processCommand(db, rawUser, rawCmd, rawArgs, isMod = false, isSub = false) {
  const user = (rawUser || '').toLowerCase().replace('@', '');
  const cmd = (rawCmd || '').toLowerCase();
  const args = (rawArgs || '').trim().split(/\s+/).filter(Boolean);

  if (!user) return null;
  if (!db.users[user]) db.users[user] = { inventory: [], totalCaught: 0, pokedex: [] };
  if (db.users[user].totalCaught === undefined) db.users[user].totalCaught = db.users[user].inventory.length;
  if (!db.users[user].pokedex) db.users[user].pokedex = [...new Set(db.users[user].inventory.map(p => p.id))];
  if (upgradeUser(db, user)) await saveDB(db); // old Pokémon get real Gen 2 stats and moves

  if (cmd === 'verify') {
    const code = (args[0] || '').toUpperCase();
    if (!code) return `@${user} To log in on the website, open https://kicklet-pokemon.onrender.com/pokedex, press LOGIN, then type the code it shows here, e.g. !verify AB12CD`;
    const entry = webLogins.get(code);
    if (!entry || entry.expires < Date.now() || entry.user !== user) return `@${user} That code is invalid or expired. Press LOGIN on the website to get a new one.`;
    entry.verified = true;
    return `✅ @${user} verified! Go back to the website to finish logging in.`;
  }

  if (cmd === 'shinyspawn') {
    if (!isMod) return null; // silently ignore everyone except the owner and moderators
    const live = db.activeSpawn;
    if (live && Date.now() < spawnExpiresAt(live)) {
      const secsLeft = Math.ceil((spawnExpiresAt(live) - Date.now()) / 1000);
      return `@${user} A wild ${live.name} can still be caught (${secsLeft}s left)! Wait until it flees to use !shinyspawn.`;
    }
    return await triggerSpawn(db, true);
  }

  if (cmd === 'spawn') {
    if (!isMod && !isSub) return `@${user} !spawn is only available to the channel owner, moderators and subscribers.`;
    const live = db.activeSpawn;
    if (live && Date.now() < spawnExpiresAt(live)) {
      const secsLeft = Math.ceil((spawnExpiresAt(live) - Date.now()) / 1000);
      return `@${user} A wild ${live.name} can still be caught (${secsLeft}s left)! Wait until it flees to use !spawn.`;
    }
    const cdLeft = (db.users[user].lastSpawnCmdAt || 0) + SPAWN_CMD_COOLDOWN_MS - Date.now();
    if (cdLeft > 0) {
      const totalSecs = Math.ceil(cdLeft / 1000), m = Math.floor(totalSecs / 60), sec = totalSecs % 60;
      return `@${user} !spawn is on cooldown! You can use it again in ${m > 0 ? m + 'm ' : ''}${sec}s.`;
    }
    const spawnMsg = await triggerSpawn(db);
    db.users[user].lastSpawnCmdAt = Date.now();
    await saveDB(db);
    return `🎲 @${user} spawned a random Pokémon! ⏳ !spawn now has a ${SPAWN_CMD_COOLDOWN_MS / 60000} minute cooldown. ${spawnMsg}`;
  }

  if (cmd === 'catch') {
    const spawn = db.activeSpawn;
    if (!spawn) return `@${user} No wild Pokémon right now!`;
    if (Date.now() > spawnExpiresAt(spawn)) {
      return `@${user} Too late to catch the wild ${spawn.name}, it already fled! Next spawn in ${nextSpawnText(db, spawn)}! [emote:5339426:kickDrops]`;
    }
    if (spawn.caughtBy.includes(user)) return `@${user} You already caught this ${spawn.name}! [emote:5756614:CaptFail]`;
    if (db.users[user].inventory.length >= MAX_INVENTORY) return `@${user} Party full (${MAX_INVENTORY}/${MAX_INVENTORY})! Use !release <1-${MAX_INVENTORY}>.`;

    // Each trainer gets MAX_CATCH_TRIES attempts per spawn
    if (!spawn.attempts) spawn.attempts = {};
    const used = spawn.attempts[user] || 0;
    if (used >= MAX_CATCH_TRIES) return `@${user} You're out of tries for this ${spawn.name}! Wait for the next spawn. [emote:4148128:mericCat]`;

    spawn.attempts[user] = used + 1;
    if (Math.random() > 0.65) {
      await saveDB(db);
      const left = MAX_CATCH_TRIES - spawn.attempts[user];
      return left > 0
        ? `@${user} The wild ${spawn.name} broke free! You have ${left} ${left === 1 ? 'try' : 'tries'} left (${spawn.attempts[user]}/${MAX_CATCH_TRIES} used).${left === 1 ? ' [emote:5273247:highCortisol]' : ''}`
        : `@${user} The wild ${spawn.name} broke free and you're out of tries (${MAX_CATCH_TRIES}/${MAX_CATCH_TRIES} used)! Better luck on the next spawn. [emote:4148128:mericCat]`;
    }

    const caughtMon = await generatePokemon(spawn.id, spawn.isShiny);
    db.users[user].inventory.push(caughtMon);
    db.users[user].totalCaught += 1;
    if (!db.users[user].pokedex.includes(caughtMon.id)) db.users[user].pokedex.push(caughtMon.id);
    markShiny(db, user, caughtMon);
    recordFirstCatch(db, user, caughtMon);
    spawn.caughtBy.push(user);
    await saveDB(db);

    const shinyTag = caughtMon.isShiny ? '✨SHINY ' : '';
    let reply = `🎉 @${user} caught ${shinyTag}${caughtMon.name} Lv${caughtMon.level} [${caughtMon.types.join('/')}]! (${db.users[user].inventory.length}/${MAX_INVENTORY}) [emote:37232:PeepoClap]`;
    const evoMsg = await checkEvolution(db, user);
    if (evoMsg) reply += ` | ${evoMsg}`;
    reply += ` | ${SITE_NOTE}`;
    return reply;
  }

  if (cmd === 'spawncheck' || cmd === 'wild') {
    const spawn = db.activeSpawn;
    if (!spawn) return `@${user} No wild Pokémon right now! [emote:5756621:kkHuh]`;
    if (Date.now() > spawnExpiresAt(spawn)) return `@${user} No wild Pokémon right now! Next spawn in ${nextSpawnText(db, spawn)}! [emote:5756621:kkHuh]`;
    const secsLeft = Math.max(1, Math.ceil((spawnExpiresAt(spawn) - Date.now()) / 1000));
    const shinyTag = spawn.isShiny ? '✨SHINY ' : '';
    const triesLeft = MAX_CATCH_TRIES - ((spawn.attempts && spawn.attempts[user]) || 0);
    const status = spawn.caughtBy.includes(user)
      ? 'Already caught!'
      : (triesLeft <= 0 ? 'No tries left!' : `Type !catch to throw a Pokéball! (${triesLeft} ${triesLeft === 1 ? 'try' : 'tries'} left, ${secsLeft}s remaining)`);
    return `🌿 Active Spawn: ${shinyTag}${spawn.name} (${spawn.types.join('/').toUpperCase()}) — ${status} [emote:5756621:kkHuh]`;
  }

  if (cmd === 'party') {
    const inv = db.users[user].inventory;
    const tip = '💡 Have 3 of the same Pokémon and they evolve (if they have an evolution)!';
    const siteNote = args.length === 0 ? ` | ${SITE_NOTE}` : '';
    if (inv.length === 0) return `@${user} Your party is empty! Use !catch when a wild Pokémon appears. ${tip}${siteNote}`;
    const PER_PAGE = 15;
    const pages = Math.ceil(inv.length / PER_PAGE);
    let page = parseInt(args[0]) || 1;
    page = Math.max(1, Math.min(pages, page));
    const from = (page - 1) * PER_PAGE;
    const list = inv.slice(from, from + PER_PAGE).map((p, i) => `[${from + i + 1}] ${p.isShiny ? '✨' : ''}${p.name}`).join(' | ');
    const pageTxt = pages > 1 ? ` Page ${page}/${pages} (type !party ${page % pages + 1} for more)` : '';
    return `@${user}'s Party (${inv.length}/${MAX_INVENTORY})${pageTxt}: ${list} | ${tip}${siteNote}`;
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
    const movesStr = mon.moves.map((m, i) => `${i + 1}:${m.name}(${m.type}/${m.power || '-'}pwr/${m.maxPp}PP)`).join(', ');
    const st = mon.stats;
    return `@${user} #${slot + 1} ${shinyTag}${mon.name} Lv${mon.level} [${mon.types.join('/')}] | HP:${st.hp} ATK:${st.atk} DEF:${st.def} SPD:${st.spd} SPA:${st.spa} SPDEF:${st.sdf} | Moves: ${movesStr}`;
  }

  if (cmd === 'release') {
    const inv = db.users[user].inventory;
    const siteNote = args.length === 0 ? ` | ${SITE_NOTE}` : '';
    if (inv.length === 0) return `@${user} Your party is empty, nothing to release!${siteNote}`;
    const slot = parseInt(args[0]) - 1;
    if (args.length === 0 || Number.isNaN(slot)) {
      return `@${user} To release a Pokémon, type !release <slot number>, e.g. !release 3 releases the Pokémon in slot 3. Type !party to see your slots (1-${inv.length}).${siteNote}`;
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
    return `📖 @${user}'s Pokédex: ${uniqueCount}/${MAX_POKEMON_ID} unique species (${percent}%) | Total Caught: ${totalCaught} | 🌐 See all your captured Pokemon and manage your Pokemon here ➡️ ${POKEDEX_SITE}`;
  }

  if (cmd === 'leaderboard') {
    const medals = ['🥇', '🥈', '🥉'];
    const top3 = (valueOf) => Object.entries(db.users)
      .map(([name, data]) => ({ name, n: valueOf(data) }))
      .filter(e => e.n > 0)
      .sort((x, y) => y.n - x.n)
      .slice(0, 3)
      .map((e, i) => `${medals[i]} @${e.name} (${e.n})`)
      .join(' | ');
    const catches = top3(d => d.totalCaught ?? d.inventory.length);
    const wins = top3(d => d.battleWins || 0);
    const mode = (args[0] || '').toLowerCase();
    const catchLine = `🏆 Most catches: ${catches || 'nobody yet, be the first with !catch!'}`;
    const winLine = `⚔️ Most battle wins: ${wins || 'nobody yet, challenge someone with !battle!'}`;
    if (mode.startsWith('catch')) return catchLine;
    if (mode.startsWith('battle') || mode.startsWith('win')) return winLine;
    return `${catchLine} || ${winLine}`;
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
    if (upgradeUser(db, trade.fromUser)) await saveDB(db);
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
    markShiny(db, user, senderMon);
    markShiny(db, trade.fromUser, myMon);
    recordFirstCatch(db, user, senderMon);
    recordFirstCatch(db, trade.fromUser, myMon);

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
      return `@${user} To battle another trainer, type !battle @username <slot>, e.g. !battle @ash 1 challenges @ash with the Pokémon in your slot 1. They have 5 minutes to accept with !battle @${user} <slot>. Each round both pick !move <1-4>. Use !forfeit to quit.`;
    }
    if (!opponent || !db.users[opponent]) return `@${user} Opponent not found. Use !battle @username <slot>, e.g. !battle @ash 1.`;
    if (opponent === user) return `@${user} You can't battle yourself!`;
    if (Number.isNaN(slot) || !myMon) return `@${user} Pick one of your Pokémon: !battle @${opponent} <slot>, e.g. !battle @${opponent} 1. Type !party to see your slots.`;

    const existingKey = findBattleKey(db, user);
    const existing = existingKey ? db.activeBattles[existingKey] : null;

    if (existing) {
      if (existing.p2Mon) return `@${user} You're already in a battle! Use !move <1-4>.`;
      if (existing.p2 === user && existing.p1 === opponent) {
        // Accepting a challenge
        const now = Date.now();
        existing.p2Mon = g2BattleMon(g2EnsureMon(myMon));
        existing.startedAt = now;
        existing.seq = 0;
        existing.roundLines = [];
        g2StartRound(existing);
        existing.lastLog = `Round 1: choose your moves!`;
        await saveDB(db);
        return `🔥 Battle started! ${existing.p1Mon.name} (@${existing.p1}) vs ${existing.p2Mon.name} (@${existing.p2}), both Lv${G2_LEVEL}! ${BATTLE_RULES} Round 1: both trainers use !move <1-4> now!`;
      }
      if (existing.p1 === user) return `@${user} You already challenged @${existing.p2}! Wait for them to accept, or use !forfeit to cancel your challenge.`;
      return `@${user} @${existing.p1} already challenged you! Accept with !battle @${existing.p1} <slot>.`;
    }
    // Only one battle at a time for the whole channel: a new challenge is allowed only after the current battle is over
    const runningKey = Object.keys(db.activeBattles || {}).find(k => db.activeBattles[k]);
    if (runningKey) {
      const rb = db.activeBattles[runningKey];
      return rb.p2Mon
        ? `@${user} Only one battle can happen at a time! @${rb.p1} vs @${rb.p2} is going on right now. You can challenge someone when it finishes. [emote:4148081:Sadge]`
        : `@${user} Only one battle can happen at a time! @${rb.p1} already challenged @${rb.p2}. You can challenge someone once that battle is over or the challenge is canceled. [emote:4148081:Sadge]`;
    }
    if (findBattleKey(db, opponent)) return `@${user} @${opponent} is already busy with another battle or challenge. Try again later!`;

    const battleKey = [user, opponent].sort().join('_vs_');
    db.activeBattles[battleKey] = {
      p1: user,
      p2: opponent,
      p1Mon: g2BattleMon(g2EnsureMon(myMon)),
      p2Mon: null,
      lastLog: `@${user} challenged @${opponent}!`,
      createdAt: Date.now(),
      startedAt: null,
      warned60: false
    };
    await saveDB(db);
    return `⚔️ @${user} challenged @${opponent} with ${myMon.name}! @${opponent}, you have 5 minutes to accept with !battle @${user} <slot> or the challenge will be canceled. ${BATTLE_RULES}`;
  }

  if (cmd === 'move') {
    const battleKey = findBattleKey(db, user);
    const battle = battleKey ? db.activeBattles[battleKey] : null;
    if (!battle || !battle.p2Mon) {
      const pending = battle && !battle.p2Mon
        ? (battle.p1 === user ? ` Your challenge to @${battle.p2} hasn't been accepted yet.` : ` @${battle.p1} challenged you, accept with !battle @${battle.p1} <slot>.`)
        : '';
      return `@${user} !move only works during a battle.${pending} To battle: type !battle @username <slot> to challenge a trainer with the Pokémon in that slot (see !party). They accept with !battle @${user} <slot>, then both of you pick !move <1-4> each round.`;
    }

    // Enforce time limits even if the background check hasn't caught up yet
    const timerMsg = applyBattleTimers(db, battleKey, battle);
    if (timerMsg) {
      await saveDB(db);
      return timerMsg;
    }

    const side = battle.p1 === user ? 'p1' : 'p2';
    const opponentUser = side === 'p1' ? battle.p2 : battle.p1;
    const mon = battle[side + 'Mon'];
    const moveIdx = parseInt(args[0]) - 1;
    if (args.length === 0 || Number.isNaN(moveIdx) || !mon.moves[moveIdx]) {
      const movesList = mon.moves.map((m, i) => `${i + 1}:${m.name}(${m.pp}/${m.maxPp}PP)`).join(', ');
      const prefix = args.length === 0
        ? `To attack, type !move <number>, e.g. !move 1 uses move 1.`
        : `"${args[0]}" isn't a valid move. Type !move <number>, e.g. !move 1.`;
      return `@${user} ${prefix} Your ${mon.name}'s moves: ${movesList}. Both trainers pick each round, you have ${MOVE_LIMIT_SECS}s!`;
    }

    const picked = g2Pick(battle, side, moveIdx);
    if (!picked.ok) return `@${user} ${picked.msg}`;

    if (!g2Ready(battle)) {
      await saveDB(db);
      const secsLeft = Math.max(1, Math.ceil((battle.roundStartedAt + MOVE_LIMIT_MS - Date.now()) / 1000));
      return `✅ @${user} locked in a move! Waiting for @${opponentUser} (${secsLeft}s left)...`;
    }

    const msg = concludeRounds(db, battleKey, battle);
    await saveDB(db);
    return msg;
  }

  if (cmd === 'forfeit') {
    const battleKey = findBattleKey(db, user);
    if (!battleKey) return `@${user} Not in a battle.`;
    const battle = db.activeBattles[battleKey];
    const opponent = battle.p1 === user ? battle.p2 : battle.p1;
    const wasAccepted = Boolean(battle.p2Mon);
    if (wasAccepted) recordBattleEnd(db, battle, opponent, 'forfeit', `@${user} forfeited! @${opponent} wins!`);
    delete db.activeBattles[battleKey];
    await saveDB(db);
    return wasAccepted ? `🏳️ @${user} [emote:1730802:emojiOuch] forfeited! 🏆 @${opponent} [emote:5756671:GIGACHAD] wins!` : `🏳️ @${user} canceled the challenge.`;
  }

  if (cmd === 'help' || cmd === 'pokemon') {
    return `🎮 Commands: !catch (catch the wild Pokémon) | !spawncheck (see the current spawn) | !party (your Pokémon) | !info <slot> (stats & moves) | !release <slot> | !pokedex | !leaderboard (top catchers & battle winners) | !trade @user <slot> | !accept <slot> | !battle @user <slot> (challenge) | !move <1-4> (battle) | !forfeit | !help | ${SITE_NOTE}`;
  }

  return null;
}

// --- ROUTES ---
app.get('/ping', (req, res) => res.send('Bot is awake!'));

// Triggered every 5 mins by cron-job.org (posts directly to Kick chat + OBS)
app.get('/spawn', checkSecret, async (req, res) => {
  let unlock;
  try {
    unlock = await lockDB();
    const db = await getDB();
    if (Date.now() < (db.autoSpawnBlockedUntil || 0)) {
      return res.send('Skipped: a !spawn was used recently, the automatic spawn is delayed.');
    }
    if (db.activeSpawn && Date.now() < spawnExpiresAt(db.activeSpawn)) {
      return res.send('Skipped: a Pokémon can still be caught, so the automatic spawn waits for the next cycle.');
    }
    db.lastAutoSpawnAt = Date.now();
    const msg = await triggerSpawn(db);
    await sendKickChat(db, msg);
    res.send(msg);
  } catch (err) {
    console.error(err);
    res.send('⚠️ Spawn error.');
  } finally {
    if (unlock) unlock();
  }
});

// Direct Kick Webhook Receiver (Listens to Kick chat messages)
app.post('/kick-webhook', async (req, res) => {
  res.sendStatus(200); // Acknowledge Kick immediately
  let unlock;
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

    const validCmds = ['spawn', 'shinyspawn', 'catch', 'spawncheck', 'wild', 'party', 'info', 'release', 'pokedex', 'leaderboard', 'trade', 'accept', 'battle', 'move', 'forfeit', 'help', 'pokemon', 'verify'];
    if (!validCmds.includes(cmd.toLowerCase())) return;

    unlock = await lockDB();
    const db = await getDB();
    const isSub = badges.some(b => ['subscriber', 'founder'].includes(b.type));
    const reply = await processCommand(db, sender, cmd, args, isMod, isSub);
    if (reply) await sendKickChat(db, reply);
  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
  } finally {
    if (unlock) unlock();
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
    body { background: transparent; font-family: 'Press Start 2P', monospace; overflow: hidden; position: relative; width: 100vw; height: 100vh; }
    #spawn-card, #gbc-frame { position: absolute; left: 50%; transform: translateX(-50%); display: none; background: #2b2d42; border: 6px solid #1a1b26; border-radius: 16px 16px 40px 16px; padding: 18px 22px 24px; box-shadow: 0 12px 30px rgba(0,0,0,0.8); }
    #spawn-card { width: 440px; }
    #gbc-frame { width: 840px; }
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
    #moves-box { width: 470px; border: 4px solid #181818; border-radius: 6px; padding: 8px 10px; background: #fff; }
    #moves-list { display: flex; gap: 10px; }
    .mv-col { flex: 1; min-width: 0; }
    .mv-head { font-size: 8px; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .mv-head.done { color: #16a34a; }
    .mv.off { opacity: 0.4; }
    .stt { display: inline-block; background: #7c3aed; color: #fff; font-size: 7px; padding: 2px 3px; border-radius: 3px; margin-left: 4px; }
    #moves-title { font-size: 8px; color: #555; margin-bottom: 8px; min-height: 10px; }
    .mv { display: flex; align-items: center; gap: 5px; height: 25px; font-size: 8px; }
    .mv-num { min-width: 18px; text-align: center; background: #181818; color: #fff; border-radius: 3px; padding: 4px 4px; font-size: 9px; }
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
        anim: BASE + '/versions/generation-v/black-white/animated/' + (back ? 'back/' : '') + (shiny ? 'shiny/' : '') + (mon.spriteId || mon.id) + '.gif',
        still: BASE + (back ? '/back' : '') + (shiny ? '/shiny' : '') + '/' + (mon.spriteId || mon.id) + '.png'
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
    function statusTag(m) {
      var map = { par: 'PAR', psn: 'PSN', brn: 'BRN', slp: 'SLP', frz: 'FRZ' };
      var t = m.status ? (m.badly && m.status === 'psn' ? 'TOX' : map[m.status]) : '';
      if (m.conf > 0) t = t ? t + '/CNF' : 'CNF';
      return t ? '<span class="stt">' + t + '</span>' : '';
    }
    function movesCol(user, mon, st) {
      var head = '@' + esc(user) + (st === 'done' ? ' - READY' : (st === 'wait' ? ' - choosing...' : ''));
      var rows = mon.moves.map(function (m, i) {
        var off = m.pp <= 0 || mon.disabled === m.k;
        return '<div class="mv' + (off ? ' off' : '') + '"><span class="mv-num">' + (i + 1) + '</span><span class="mv-name">' + esc(m.name.toUpperCase()) + '</span><span class="mv-info">' + esc(m.type.slice(0, 3).toUpperCase()) + ' ' + m.pp + '/' + m.maxPp + '</span></div>';
      }).join('');
      return '<div class="mv-col"><div class="mv-head' + (st === 'done' ? ' done' : '') + '">' + head + '</div>' + rows + '</div>';
    }
    function renderMoves(b, isResult) {
      var title = $('moves-title');
      var list = $('moves-list');
      if (isResult) { title.textContent = 'BATTLE OVER'; list.innerHTML = ''; return; }
      if (!b.p2Mon) {
        title.textContent = 'WAITING...';
        list.innerHTML = '<div class="mv-hint">@' + esc(b.p2) + ' type<br>!battle @' + esc(b.p1) + ' &lt;slot&gt;<br>to accept!</div>';
        return;
      }
      var ps = b.pickState || {};
      title.textContent = 'ROUND ' + (b.round || 1) + ' - type !move <number>';
      list.innerHTML = movesCol(b.p1, b.p1Mon, ps.p1) + movesCol(b.p2, b.p2Mon, ps.p2);
    }

    function clock(ms) {
      var m = Math.floor(ms / 60000);
      var s = Math.floor((ms % 60000) / 1000);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }
    function renderTimer() {
      var txt = $('turn-text');
      var fill = $('timer-fill');
      if (!lastB || showingResult) { txt.textContent = ''; fill.style.width = '0%'; return; }
      if (!lastB.p2Mon) {
        var wait = Math.max(0, (lastB.createdAt || serverNow()) + limits.battle - serverNow());
        txt.textContent = '@' + lastB.p2 + ' ACCEPT WITHIN ' + clock(wait);
        fill.style.width = (wait / limits.battle * 100) + '%';
        fill.style.background = wait <= 60000 ? '#ef4444' : '#3b82f6';
        return;
      }
      var started = lastB.roundStartedAt || serverNow();
      var left = Math.max(0, started + limits.move - serverNow());
      var secs = Math.ceil(left / 1000);
      var battleLeft = Math.max(0, (lastB.startedAt || serverNow()) + limits.battle - serverNow());
      var ps = lastB.pickState || {};
      var who = [];
      if (ps.p1 === 'wait') who.push('@' + lastB.p1);
      if (ps.p2 === 'wait') who.push('@' + lastB.p2);
      txt.textContent = (who.length ? who.join(' & ') + ' ' + secs + 's' : 'FIGHT!') + ' | ' + clock(battleLeft) + ' left';
      fill.style.width = (who.length ? left / limits.move * 100 : 0) + '%';
      fill.style.background = secs <= 8 ? '#ef4444' : '#3b82f6';
    }

    // ---------- round text (plays line by line) ----------
    var ls = { key: '', seq: 0, playing: false, timer: null };
    function playLines(b, isResult, res, key) {
      var seq = b.seq || 0;
      var base = isResult ? res.message : (b.lastLog || '');
      var total = 0;
      if (ls.key !== key) {
        ls.key = key; ls.seq = seq; ls.playing = false;
        if (ls.timer) clearTimeout(ls.timer);
      }
      if (seq > ls.seq) {
        ls.seq = seq;
        if (ls.timer) clearTimeout(ls.timer);
        var lines = (b.roundLines || []).slice(-8);
        ls.playing = lines.length > 0;
        var step = function () {
          if (!lines.length) { ls.playing = false; typeText($('log-text'), base); return; }
          var line = String(lines.shift());
          typeText($('log-text'), line);
          ls.timer = setTimeout(step, Math.max(900, line.length * 28 + 450));
        };
        lines.forEach(function (l) { total += Math.max(900, String(l).length * 28 + 450); });
        step();
        return Math.min(total, 8000);
      }
      if (!ls.playing) typeText($('log-text'), base);
      return 0;
    }

    // ---------- main battle render ----------
    function battleKey(b) { return b.p1 + '|' + b.p2 + '|' + (b.createdAt || 0); }

    function renderBattle(b, isResult, res) {
      var key = battleKey(b);
      var isNew = !cur || cur.key !== key;
      var hasP2 = Boolean(b.p2Mon);
      var p1Hp = b.p1Mon.currentHp;
      var p2Hp = hasP2 ? b.p2Mon.currentHp : null;

      var hitP2 = false;
      var hitP1 = false;
      if (!isNew) {
        if (hasP2 && cur.p2Hp !== null && p2Hp < cur.p2Hp) hitP2 = true;
        if (p1Hp < cur.p1Hp) hitP1 = true;
      }
      var hit = hitP1 || hitP2;

      // static info
      $('p1-name').textContent = (b.p1Mon.isShiny ? '✨' : '') + b.p1Mon.name + ' L' + (b.p1Mon.level || 50);
      $('p1-user').innerHTML = '@' + esc(b.p1) + statusTag(b.p1Mon);
      setBattleSprite($('p1-img'), b.p1Mon, true, 150);
      $('p2-hud').classList.toggle('hide', !hasP2);
      $('p2-spr').classList.toggle('hide', !hasP2);
      $('p2-platform').classList.toggle('hide', !hasP2);
      if (hasP2) {
        $('p2-name').textContent = (b.p2Mon.isShiny ? '✨' : '') + b.p2Mon.name + ' L' + (b.p2Mon.level || 50);
        $('p2-user').innerHTML = '@' + esc(b.p2) + statusTag(b.p2Mon);
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
      if (hitP2) attackAnim('p1', 'p2');
      if (hitP1) setTimeout(function () { attackAnim('p2', 'p1'); }, hitP2 ? 1000 : 0);

      // health bars (delayed so they drop when the hit lands)
      var delay = hit ? (hitP1 && hitP2 ? 1450 : 450) : 0;
      var instant = isNew;
      setTimeout(function () {
        setHp('p1', p1Hp, b.p1Mon.maxHp, instant);
        if (hasP2) setHp('p2', p2Hp, b.p2Mon.maxHp, instant);
        else { $('p2-hp-text').textContent = ''; }
      }, delay);

      // fainting
      if (isResult && res.reason === 'faint') {
        if (p1Hp <= 0) setTimeout(function () { $('p1-fx').classList.add('faint'); }, 1100 + lead);
        if (hasP2 && p2Hp <= 0) setTimeout(function () { $('p2-fx').classList.add('faint'); }, 1100 + lead);
      }

      // text, menu, banner
      var lead = playLines(b, isResult, res, key);
      renderMoves(b, isResult);
      var banner = $('banner');
      if (isResult) {
        banner.textContent = res.winner ? ('🏆 @' + res.winner + ' WINS!') : 'DRAW!';
        if (!banner.classList.contains('show')) setTimeout(function () { banner.classList.add('show'); }, 1200 + lead);
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
      var expires = lastSpawn.expiresAt || (lastSpawn.spawnedAt + 90000);
      var total = Math.max(1, expires - lastSpawn.spawnedAt);
      var left = Math.max(0, expires - serverNow());
      var secs = Math.ceil(left / 1000);
      txt.textContent = secs > 0 ? ('ESCAPES IN ' + secs + 's') : 'IT FLED!';
      bar.style.width = (left / total * 100) + '%';
      bar.style.background = secs <= 10 ? '#ef4444' : (secs <= 20 ? '#eab308' : '#22c55e');
    }

    // ---------- polling ----------
    // Spawn card: centred on screen. Battle: bottom centre.
    // If both are visible, the spawn card moves to the top and both shrink (same scale) so they never overlap.
    function layout() {
      var card = $('spawn-card');
      var frame = $('gbc-frame');
      var cardOn = card.style.display === 'block';
      var frameOn = frame.style.display === 'block';
      if (!cardOn && !frameOn) return;
      var vw = window.innerWidth;
      var vh = window.innerHeight;
      var pad = 16;
      var ch = cardOn ? card.offsetHeight : 0;
      var fh = frameOn ? frame.offsetHeight : 0;
      var widest = Math.max(cardOn ? card.offsetWidth : 0, frameOn ? frame.offsetWidth : 0, 1);

      var s = 1;
      if (cardOn && frameOn) s = (vh - pad * 3) / (ch + fh);
      else s = (vh - pad * 2) / Math.max(ch, fh, 1);
      s = Math.max(0.2, Math.min(1, s, (vw - pad * 2) / widest));

      if (cardOn) {
        card.style.transformOrigin = 'top center';
        card.style.transform = 'translateX(-50%) scale(' + s + ')';
        card.style.top = (frameOn ? pad : Math.max(pad, (vh - ch * s) / 2)) + 'px';
      }
      if (frameOn) {
        frame.style.transformOrigin = 'bottom center';
        frame.style.transform = 'translateX(-50%) scale(' + s + ')';
        frame.style.bottom = pad + 'px';
      }
    }
    window.addEventListener('resize', layout);

    async function tick() {
      try {
        var res = await fetch('/battle-data');
        var data = await res.json();
        if (data.now) offset = data.now - Date.now();
        if (data.limits) limits = data.limits;

        var frame = $('gbc-frame');
        var card = $('spawn-card');

        var result = data.result;
        var resultFresh = result && (serverNow() - result.at) < 20000;

        // battle (bottom centre)
        if (data.active && data.battle) {
          frame.style.display = 'block';
          renderBattle(data.battle, false, null);
        } else if (resultFresh) {
          frame.style.display = 'block';
          renderBattle(result, true, result);
        } else {
          frame.style.display = 'none';
          cur = null;
          lastB = null;
          showingResult = false;
          $('banner').classList.remove('show');
        }

        // spawned Pokémon (centre of the screen)
        var s = data.spawn;
        if (s && s.spawnedAt && serverNow() < (s.expiresAt || (s.spawnedAt + 90000))) {
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

        layout();
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
  let unlock;
  try {
    if (mongoose.connection.readyState !== 1) return;
    unlock = await lockDB();
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
          ? `💨 The wild ${shinyTag}${spawn.name} fled! Caught by: ${catchers.map(u => '@' + u).join(', ')} [emote:37232:PeepoClap]. Next spawn in ${nextSpawnText(db, spawn)}! [emote:5339426:kickDrops]`
          : `💨 The wild ${shinyTag}${spawn.name} fled... nobody caught it! [emote:5756621:kkHuh] Next spawn in ${nextSpawnText(db, spawn)}! [emote:5339426:kickDrops]`);
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
    if (unlock) unlock();
    battleTickRunning = false;
  }
}, 3000);

// pokedex-site.js
// Public website for the Pokémon bot: animated top-10 catch leaderboard, every trainer's Pokédex,
// a shinies column, and a chat-verified login so trainers can release Pokémon from their party.
//
// Pages:   /pokedex            -> the website
// API:     /api/pokedex        -> public JSON (no secrets, no internal uids)
//          /api/login/start, /api/login/status, /api/me, /api/logout, /api/release

function registerPokedexSite(app, { getDB, saveDB, lockDB, runCommand, MOVE_LIMIT_MS, GEN2, MAX_POKEMON_ID, webLogins, crypto }) {
  const species = Object.entries(GEN2.mons)
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
              dexDates: (u.dexDates && typeof u.dexDates === 'object') ? u.dexDates : {},
              shinyDates: (u.shinyDates && typeof u.shinyDates === 'object') ? u.shinyDates : {},
              shinies: [...shinySet].sort((a, b) => a - b),
              party: inv.map((p, i) => ({ slot: i, id: p.id, name: p.name, shiny: Boolean(p.isShiny), level: p.level || 50, moves: (Array.isArray(p.moves) ? p.moves : []).map((m) => ({ n: m.name, t: m.type, p: m.power, pp: m.maxPp })) }))
            };
          })
          .filter((u) => u.totalCaught > 0 || u.pokedex.length > 0 || u.party.length > 0)
          .sort((a, b) => b.totalCaught - a.totalCaught || b.pokedex.length - a.pokedex.length);
        cache = { at: Date.now(), data: { max: MAX_POKEMON_ID, maxParty: MAX_INVENTORY, species, users, now: Date.now() } };
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
    let unlock;
    try {
      const body = req.body || {};
      const code = String(body.code || '').toUpperCase();
      const entry = webLogins.get(code);
      if (!entry || entry.secretHash !== sha(body.secret || '')) return res.json({ status: 'expired' });
      const now = Date.now();
      if (entry.expires < now) { webLogins.delete(code); return res.json({ status: 'expired' }); }
      if (!entry.verified) return res.json({ status: 'pending' });

      webLogins.delete(code);
      unlock = await lockDB();
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
    } finally {
      if (unlock) unlock();
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
    let unlock;
    try {
      unlock = await lockDB();
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
    } finally {
      if (unlock) unlock();
    }
  });

  app.post('/api/logout', async (req, res) => {
    let unlock;
    try {
      unlock = await lockDB();
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
    } finally {
      if (unlock) unlock();
    }
  });

  // ---------- release a Pokémon from your own party ----------
  app.post('/api/release', async (req, res) => {
    let unlock;
    try {
      unlock = await lockDB();
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
    } finally {
      if (unlock) unlock();
    }
  });

  // ---------- battle & trade from the website (logged-in trainers only) ----------
  const playHits = new Map(); // user -> last action time (rate limit)
  const cleanMsg = (m) => String(m || '').replace(/\[emote:[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();

  function battleKeyOf(db, user) {
    return Object.keys(db.activeBattles || {}).find((k) => { const b = db.activeBattles[k]; return b && (b.p1 === user || b.p2 === user); });
  }

  app.get('/api/play/state', async (req, res) => {
    try {
      const db = await getDB();
      const user = sessionUser(db, req);
      if (!user) return res.status(401).json({ error: 'not logged in' });
      const inv = (db.users[user] && Array.isArray(db.users[user].inventory)) ? db.users[user].inventory : [];
      const party = inv.map((p, i) => ({ slot: i + 1, name: p.name, shiny: Boolean(p.isShiny), level: p.level || 50 }));
      const trainers = Object.keys(db.users || {})
        .filter((n) => n !== user && Array.isArray(db.users[n].inventory) && db.users[n].inventory.length > 0)
        .sort();

      const pt = db.pendingTrades || {};
      let tradeIn = null, tradeOut = null;
      if (pt[user]) tradeIn = { from: pt[user].fromUser, name: pt[user].offeredName };
      for (const to of Object.keys(pt)) {
        if (pt[to] && pt[to].fromUser === user) { tradeOut = { to, name: pt[to].offeredName }; break; }
      }

      let battle = null;
      const key = battleKeyOf(db, user);
      if (key) {
        const b = db.activeBattles[key];
        const opp = b.p1 === user ? b.p2 : b.p1;
        if (!b.p2Mon) {
          battle = { state: b.p1 === user ? 'challenging' : 'challenged', opponent: opp, theirMon: b.p1Mon ? b.p1Mon.name : '' };
        } else {
          const side = b.p1 === user ? 'p1' : 'p2';
          const mine = b[side + 'Mon'];
          const theirs = b[side === 'p1' ? 'p2Mon' : 'p1Mon'];
          battle = {
            state: 'active', opponent: opp, round: b.round || 1,
            pick: b.pickState ? b.pickState[side] : 'wait',
            secsLeft: Math.max(0, Math.ceil(((b.roundStartedAt || Date.now()) + MOVE_LIMIT_MS - Date.now()) / 1000)),
            mine: { name: mine.name, hp: Math.max(0, mine.currentHp), maxHp: mine.maxHp,
                    moves: (mine.moves || []).map((m) => ({ name: m.name, pp: m.pp, maxPp: m.maxPp, off: m.pp <= 0 || mine.disabled === m.k })) },
            theirs: { name: theirs.name, hp: Math.max(0, theirs.currentHp), maxHp: theirs.maxHp },
            log: b.lastLog || ''
          };
        }
      }
      res.json({ me: user, party, trainers, tradeIn, tradeOut, battle });
    } catch (e) {
      console.error('❌ /api/play/state error:', e.message);
      res.status(500).json({ error: 'failed' });
    }
  });

  app.post('/api/play/action', async (req, res) => {
    try {
      const db0 = await getDB();
      const user = sessionUser(db0, req);
      if (!user) return res.status(401).json({ error: 'Please log in again.' });
      const now = Date.now();
      if (now - (playHits.get(user) || 0) < 1200) return res.status(429).json({ error: 'Slow down a little.' });
      playHits.set(user, now);

      const body = req.body || {};
      const action = String(body.action || '');
      const num = (v, max) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= max ? n : null; };
      const nameOf = (v) => String(v || '').toLowerCase().replace('@', '').trim();
      let reply = null;

      if (action === 'battle' || action === 'trade') {
        const who = nameOf(action === 'battle' ? body.opponent : body.target);
        const slot = num(body.slot, 500);
        if (!who || who.length > 40 || /\s/.test(who) || !slot) return res.status(400).json({ error: 'Pick a trainer and one of your Pokémon.' });
        reply = await runCommand(user, action, who + ' ' + slot);
      } else if (action === 'accept') {
        const slot = num(body.slot, 500);
        if (!slot) return res.status(400).json({ error: 'Pick one of your Pokémon.' });
        reply = await runCommand(user, 'accept', String(slot));
      } else if (action === 'move') {
        const mv = num(body.slot, 4);
        if (!mv) return res.status(400).json({ error: 'Pick a move.' });
        reply = await runCommand(user, 'move', String(mv));
      } else if (action === 'forfeit') {
        reply = await runCommand(user, 'forfeit', '');
      } else if (action === 'declineTrade' || action === 'cancelTrade') {
        const unlock = await lockDB();
        try {
          const db = await getDB();
          const pt = db.pendingTrades || {};
          if (action === 'declineTrade') delete pt[user];
          else for (const to of Object.keys(pt)) if (pt[to] && pt[to].fromUser === user) delete pt[to];
          db.pendingTrades = pt;
          await saveDB(db);
        } finally { unlock(); }
        reply = action === 'declineTrade' ? 'Trade declined.' : 'Trade offer canceled.';
      } else {
        return res.status(400).json({ error: 'Unknown action.' });
      }
      cache = { at: 0, data: null };
      res.json({ ok: true, message: cleanMsg(reply) });
    } catch (e) {
      console.error('❌ /api/play/action error:', e.message);
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
  .pm { position:relative; width:46px; height:46px; background:var(--panel2); border-radius:8px; display:flex; align-items:center; justify-content:center; cursor:pointer; transition:transform .12s, box-shadow .12s; }
  .pm img { width:100%; height:100%; image-rendering:pixelated; object-fit:contain; pointer-events:none; }
  .pm .sn { position:absolute; left:2px; bottom:1px; font-size:7px; line-height:1; color:var(--ink); background:rgba(11,12,18,.75); padding:2px 3px; border-radius:3px; pointer-events:none; }
  .pm.sh { outline:2px solid var(--gold); background:#2a220a; }
  .pm:hover { transform:translateY(-4px) scale(1.12); box-shadow:0 6px 14px rgba(0,0,0,.6); }
  .pm.mine { outline:2px dashed #fca5a5; }

  /* tooltip, modal, toast */
  #tip { position:fixed; z-index:99999; display:none; max-width:260px; background:#000; border:3px solid var(--gold); border-radius:8px; padding:8px 10px; font-size:8px; line-height:1.8; pointer-events:none; }
  #tip b { color:var(--gold); }
  #play .pl-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:14px; margin-bottom:14px; }
  #play .pl-box { background:var(--panel); border:4px solid var(--line); border-radius:10px; padding:14px; font-size:9px; line-height:1.8; }
  #play .sw { position:relative; }
  #play .sug { display:none; position:absolute; left:0; right:0; top:100%; margin-top:2px; z-index:50; background:#0f101a; border:3px solid var(--gold); border-radius:6px; max-height:190px; overflow-y:auto; }
  #play .si { padding:9px; cursor:pointer; font-size:9px; }
  #play .si:hover, #play .si.on { background:var(--panel2); color:var(--gold); }
  #play .si.none { color:var(--mute); cursor:default; }
  #play .pl-t { color:var(--gold); font-size:11px; margin-bottom:8px; }
  #play label { display:block; color:var(--mute); font-size:8px; margin:8px 0 4px; }
  #play select, #play input { width:100%; background:#0f101a; border:3px solid var(--line); color:var(--ink); font-family:inherit; font-size:9px; padding:9px; border-radius:6px; outline:none; }
  #play .pl-box .btn { margin-top:10px; width:100%; }
  #play .pl-note { background:var(--panel2); border:3px solid var(--gold); border-radius:10px; padding:12px 14px; font-size:9px; line-height:1.9; margin-bottom:10px; }
  #play .pl-note b { color:var(--gold); }
  #play .pl-row { display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; }
  #play .pl-row .btn { flex:1; min-width:120px; }
  #play .btn.yes { background:#16a34a; }
  #play .btn.no { background:#b91c1c; }
  #play .btn:disabled { opacity:.5; cursor:not-allowed; }
  #play .hpbar { height:12px; background:#0f101a; border:2px solid var(--line); border-radius:6px; overflow:hidden; margin:3px 0 8px; }
  #play .hpbar i { display:block; height:100%; background:#22c55e; transition:width .4s; }
  #play .mvs { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px; }
  #play .mvs .btn { margin:0; width:auto; font-size:8px; }
  #play .pl-log { color:var(--mute); font-size:8px; margin-top:10px; }
  #tip .big { display:block; margin:4px auto 6px; width:96px; height:96px; object-fit:contain; image-rendering:pixelated; }
  #tip .date { color:var(--mute); }
  .cell:not(.no), .scell { cursor:help; }
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

<section id="play" style="display:none">
  <h2><span>⚔️ BATTLE &amp; TRADE</span></h2>
  <div id="play-forms"></div>
  <div id="play-status"></div>
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
      startPlay();
    } else {
      stopPlay();
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
    var slotNo = Number(el.getAttribute('data-slot'));
    var p = partyOf(owner, slotNo);
    if (!isNaN(slotNo)) head += '<br>Slot ' + (slotNo + 1);
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

  function dexTipHtml(el) {
    var id = Number(el.getAttribute('data-dex'));
    var shiny = el.getAttribute('data-kind') === 'shiny';
    var owner = el.getAttribute('data-user');
    var u = null;
    for (var i = 0; i < data.users.length; i++) if (data.users[i].name === owner) u = data.users[i];
    var nm = byId[id] ? pretty(byId[id].name) : '#' + id;
    var ts = u ? (shiny ? (u.shinyDates || {})[id] : (u.dexDates || {})[id]) : null;
    var when = ts ? new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'not recorded (caught before dates were tracked)';
    var gif = BASE + '/versions/generation-v/black-white/animated/' + (shiny ? 'shiny/' : '') + id + '.gif';
    return '<img class="big" src="' + gif + '" alt="" data-fb="' + png(id, shiny) + '" onerror="this.onerror=null;this.src=this.dataset.fb">' +
      '<b>' + (shiny ? '✨ ' : '') + esc(nm) + '</b> #' + id +
      '<br><span class="date">First caught: ' + esc(when) + '</span>';
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
      what: 'Tries to catch the wild Pokémon that is on screen right now. You have 90 seconds after it appears. Each trainer gets 3 tries per spawn and every try has a 65% chance to work. You cannot catch if your party is full (50). Catching 3 of the same species merges them into its evolution.',
      use: '!catch', ex: '!catch' },
    { n: '!spawncheck / !wild', s: 'See the wild Pokémon right now',
      what: 'Shows the Pokémon that is currently available, its type, how many catch tries you have left and how many seconds remain. If nothing is there it tells you when the next one appears.',
      use: '!spawncheck  (or !wild)', ex: '!wild' },
    { n: '!spawn', s: 'Summon a wild Pokémon (owner, mods, subs)',
      what: 'Spawns a random Pokémon right away. Only the channel owner, moderators and subscribers can use it, only when no Pokémon is catchable, and each user has a 10 minute cooldown.',
      use: '!spawn', ex: '!spawn' },
    { n: '!party', s: 'List your Pokémon and slot numbers',
      what: 'Shows every Pokémon you own with its slot number (max 50). The slot numbers are used by !info, !release, !trade and !battle. Shiny Pokémon have a star. You can also manage your party on this website.',
      use: '!party  (or !party <page> if you have more than 15 Pokémon, 15 are shown per page)', ex: '!party' },
    { n: '!info', s: 'Stats and moves of one Pokémon',
      what: 'Shows the level, type, stats (HP, ATK, DEF, SPD, SP. ATK, SP. DEF) and the 4 moves of the Pokémon in a slot, including move type, power and PP.',
      use: '!info <slot number>', ex: '!info 1' },
    { n: '!release', s: 'Release a Pokémon from your party',
      what: 'Permanently removes the Pokémon in that slot from your party to free space. It cannot be undone, but the species stays in your Pokédex. You can also release Pokémon on this website by pressing them.',
      use: '!release <slot number>', ex: '!release 3' },
    { n: '!pokedex', s: 'Your Pokédex progress',
      what: 'Shows how many different species you have found out of 251 (Gen 1 and Gen 2), the percentage, and your total number of catches.',
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
      what: 'Challenges another trainer with the Pokémon in your slot, or accepts a challenge you received. The other trainer has 5 minutes to accept. Battles use Gen 2 (Gold, Silver and Crystal) rules at level 50 and last 5 minutes at most. When time runs out the Pokémon with more HP left wins.',
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
    var lastHtml = null;
    function hide() { tip.style.display = 'none'; lastHtml = null; }
    function show(e, html, wide) {
      tip.style.maxWidth = wide ? '360px' : '280px';
      if (html !== lastHtml) { tip.innerHTML = html; lastHtml = html; } // keep the animation running while the mouse moves
      tip.style.display = 'block';
      var x = Math.min(e.clientX + 16, window.innerWidth - tip.offsetWidth - 8);
      var y = e.clientY + 20;
      if (y + tip.offsetHeight > window.innerHeight - 8) y = e.clientY - tip.offsetHeight - 12;
      tip.style.left = Math.max(4, x) + 'px';
      tip.style.top = Math.max(4, y) + 'px';
    }
    var box = $('trainers'), cmds = $('cmds');
    box.addEventListener('mousemove', function (e) {
      var dx = e.target.closest ? e.target.closest('[data-dex]') : null;
      if (dx) { show(e, dexTipHtml(dx), false); return; }
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
        var attrs = has ? ' data-dex="' + sp.id + '" data-kind="dex" data-user="' + esc(u.name) + '"' : ' title="???"';
        return '<div class="' + cls + '"' + attrs + '><span class="n">' + sp.id + '</span><img loading="lazy" src="' + png(sp.id, false) + '" alt=""></div>';
      }).join('');
      var shinyHtml = u.shinies.length
        ? u.shinies.map(function (id) {
            var nm = byId[id] ? pretty(byId[id].name) : '#' + id;
            return '<div class="scell" data-dex="' + id + '" data-kind="shiny" data-user="' + esc(u.name) + '"><img loading="lazy" src="' + png(id, true) + '" alt=""><span>' + esc(nm) + '</span></div>';
          }).join('')
        : '<div class="sempty">NO SHINIES YET</div>';
      var partyHtml = u.party.length
        ? u.party.map(function (p) {
            return '<div class="pm' + (p.shiny ? ' sh' : '') + (me && me === u.name ? ' mine' : '') + '"' +
              ' data-user="' + esc(u.name) + '" data-slot="' + p.slot + '" data-id="' + p.id + '" data-shiny="' + (p.shiny ? 1 : 0) + '"' +
              ' data-name="' + esc(p.name) + '" data-level="' + p.level + '"><img loading="lazy" src="' + png(p.id, p.shiny) + '" alt=""><span class="sn">' + (p.slot + 1) + '</span></div>';
          }).join('')
        : '<div class="sempty" style="padding:8px">PARTY IS EMPTY</div>';
      return '<div class="card" data-card="' + esc(u.name) + '">' +
        '<div class="tname"><span class="rank">#' + rank + '</span> @' + esc(u.name) + '</div>' +
        '<div class="meta">CAUGHT ' + u.totalCaught + ' &middot; POKÉDEX ' + u.pokedex.length + '/' + data.max + ' &middot; PARTY ' + u.party.length + '/' + data.maxParty + ' &middot; SHINIES ' + u.shinies.length + ' &middot; WINS ' + u.battleWins + '</div>' +
        '<div class="bar"><i style="width:' + pct.toFixed(1) + '%"></i></div>' +
        '<div class="col-title">PARTY (' + u.party.length + '/' + data.maxParty + ')</div><div class="party">' + partyHtml + '</div>' +
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

  // ---------- battle & trade panel (logged-in trainers only) ----------
  var playTimer = null, playState = null, playFormSig = '', playStatusSig = '';

  function stopPlay() {
    if (playTimer) { clearInterval(playTimer); playTimer = null; }
    playState = null; playFormSig = ''; playStatusSig = '';
    $('play').style.display = 'none';
  }
  function startPlay() {
    $('play').style.display = 'block';
    if (!playTimer) playTimer = setInterval(pollPlay, 3000);
    pollPlay();
  }
  function partyOptions(party) {
    return party.map(function (p) {
      return '<option value="' + p.slot + '">' + p.slot + '. ' + (p.shiny ? '✨ ' : '') + esc(pretty(p.name)) + ' Lv' + p.level + '</option>';
    }).join('');
  }
  async function pollPlay() {
    if (!me || !token || document.hidden) return;
    try {
      var r = await fetch('/api/play/state', { headers: { Authorization: 'Bearer ' + token } });
      if (r.status === 401) { me = null; token = null; store('ph_token', null); renderAuth(); return; }
      if (!r.ok) return;
      playState = await r.json();
      renderPlay();
    } catch (e) {}
  }
  function renderPlay() {
    var s = playState;
    if (!s) return;
    var formSig = JSON.stringify([s.party, s.trainers]);
    if (formSig !== playFormSig) {
      playFormSig = formSig;
      if (!s.party.length) {
        $('play-forms').innerHTML = '<div class="pl-note">Catch a Pokémon in chat first, then you can battle and trade here.</div>';
      } else {
        var mons = partyOptions(s.party);
        $('play-forms').innerHTML = '<div class="pl-grid">' +
          '<div class="pl-box"><div class="pl-t">⚔️ CHALLENGE TO A BATTLE</div>' +
            '<label>1. WHO DO YOU WANT TO FIGHT? (TYPE TO SEARCH)</label><div class="sw"><input id="pb-who" data-sug="1" placeholder="search trainer..." autocomplete="off"><div class="sug"></div></div>' +
            '<label>2. WHICH POKÉMON FIGHTS FOR YOU?</label><select id="pb-mon">' + mons + '</select>' +
            '<button class="btn yes" data-act="battle-go">CHALLENGE</button></div>' +
          '<div class="pl-box"><div class="pl-t">🔄 OFFER A TRADE</div>' +
            '<label>1. WHO DO YOU WANT TO TRADE WITH? (TYPE TO SEARCH)</label><div class="sw"><input id="pt-who" data-sug="1" placeholder="search trainer..." autocomplete="off"><div class="sug"></div></div>' +
            '<label>2. WHICH POKÉMON DO YOU GIVE?</label><select id="pt-mon">' + mons + '</select>' +
            '<button class="btn yes" data-act="trade-go">OFFER TRADE</button></div>' +
          '</div>';
      }
    }

    // status: things waiting for you (selects are only rebuilt when something changes, so your choice is not lost)
    var b = s.battle;
    var stSig = JSON.stringify([s.tradeIn, s.tradeOut, b && b.state !== 'active' ? b : (b ? 'active' : null), s.party.length]);
    var h = '';
    if (b && b.state === 'active') {
      var mine = b.mine, th = b.theirs;
      var pct = function (x) { return x.maxHp ? Math.max(0, Math.min(100, x.hp / x.maxHp * 100)) : 0; };
      var msg = b.pick === 'wait' ? 'Your turn! Choose a move (' + b.secsLeft + 's left).' : (b.pick === 'done' ? 'Move chosen. Waiting for @' + esc(b.opponent) + '...' : 'Your Pokémon acts on its own this round.');
      h += '<div class="pl-note"><b>⚔️ BATTLE vs @' + esc(b.opponent) + ' - ROUND ' + b.round + '</b>' +
        '<div>YOU: ' + esc(pretty(mine.name)) + ' (' + mine.hp + '/' + mine.maxHp + ' HP)</div><div class="hpbar"><i style="width:' + pct(mine).toFixed(0) + '%"></i></div>' +
        '<div>@' + esc(b.opponent) + ': ' + esc(pretty(th.name)) + ' (' + th.hp + '/' + th.maxHp + ' HP)</div><div class="hpbar"><i style="width:' + pct(th).toFixed(0) + '%"></i></div>' +
        '<div>' + msg + '</div><div class="mvs">' +
        mine.moves.map(function (m, i) {
          return '<button class="btn" data-act="move" data-mv="' + (i + 1) + '"' + (b.pick !== 'wait' || m.off ? ' disabled' : '') + '>' + esc(pretty(m.name)) + '<br>' + m.pp + '/' + m.maxPp + ' PP</button>';
        }).join('') + '</div>' +
        '<div class="pl-row"><button class="btn no" data-act="forfeit-active">FORFEIT</button></div>' +
        (b.log ? '<div class="pl-log">' + esc(b.log) + '</div>' : '') + '</div>';
      $('play-status').innerHTML = h;
      playStatusSig = 'active';
      return;
    }
    if (stSig === playStatusSig) return;
    playStatusSig = stSig;
    if (b && b.state === 'challenged') {
      h += '<div class="pl-note"><b>⚔️ @' + esc(b.opponent) + ' CHALLENGED YOU</b> with ' + esc(pretty(b.theirMon)) + '.' +
        '<label>PICK YOUR POKÉMON TO FIGHT WITH</label><select id="pa-mon">' + partyOptions(s.party) + '</select>' +
        '<div class="pl-row"><button class="btn yes" data-act="accept-battle">ACCEPT BATTLE</button><button class="btn no" data-act="forfeit">DECLINE</button></div></div>';
    } else if (b && b.state === 'challenging') {
      h += '<div class="pl-note"><b>⚔️ WAITING FOR @' + esc(b.opponent) + '</b> to accept your challenge (5 minutes).' +
        '<div class="pl-row"><button class="btn no" data-act="forfeit">CANCEL CHALLENGE</button></div></div>';
    }
    if (s.tradeIn) {
      h += '<div class="pl-note"><b>🔄 @' + esc(s.tradeIn.from) + ' OFFERS YOU ' + esc(pretty(s.tradeIn.name)) + '</b>' +
        '<label>PICK THE POKÉMON YOU GIVE IN RETURN</label><select id="pi-mon">' + partyOptions(s.party) + '</select>' +
        '<div class="pl-row"><button class="btn yes" data-act="accept-trade">ACCEPT TRADE</button><button class="btn no" data-act="decline-trade">DECLINE</button></div></div>';
    }
    if (s.tradeOut) {
      h += '<div class="pl-note"><b>🔄 YOU OFFERED ' + esc(pretty(s.tradeOut.name)) + ' TO @' + esc(s.tradeOut.to) + '</b>. Waiting for them to accept.' +
        '<div class="pl-row"><button class="btn no" data-act="cancel-trade">CANCEL OFFER</button></div></div>';
    }
    $('play-status').innerHTML = h;
  }

  async function playAct(body, btn) {
    if (btn) btn.disabled = true;
    try {
      var r = await fetch('/api/play/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify(body)
      });
      var j = await r.json();
      if (r.status === 401) { me = null; token = null; store('ph_token', null); renderAuth(); openLogin('Your login expired. Please log in again.'); return; }
      toast(j.message || j.error || (r.ok ? 'Done.' : 'Something went wrong.'));
    } catch (e) {
      toast('Could not reach the server.');
    }
    if (btn) btn.disabled = false;
    playStatusSig = '';
    lastJson = '';
    pollPlay();
    load();
  }

  // live trainer suggestions while typing
  function showSug(inp) {
    var box = inp.parentNode.querySelector('.sug');
    if (!box || !playState) return;
    var q = inp.value.trim().toLowerCase().split('@').join('');
    var all = playState.trainers;
    var list = all.filter(function (n) { return n.indexOf(q) === 0; })
      .concat(all.filter(function (n) { return n.indexOf(q) > 0; })).slice(0, 8);
    box.innerHTML = list.length
      ? list.map(function (n, i) { return '<div class="si' + (i === 0 ? ' on' : '') + '" data-name="' + esc(n) + '">@' + esc(n) + '</div>'; }).join('')
      : '<div class="si none">no trainer found</div>';
    box.style.display = 'block';
  }
  function hideSug() {
    var boxes = document.querySelectorAll('#play .sug');
    for (var i = 0; i < boxes.length; i++) boxes[i].style.display = 'none';
  }
  $('play').addEventListener('input', function (e) { if (e.target && e.target.getAttribute && e.target.getAttribute('data-sug')) showSug(e.target); });
  $('play').addEventListener('focusin', function (e) { if (e.target && e.target.getAttribute && e.target.getAttribute('data-sug')) showSug(e.target); });
  $('play').addEventListener('keydown', function (e) {
    var t = e.target;
    if (!t || !t.getAttribute || !t.getAttribute('data-sug')) return;
    if (e.key === 'Escape') { hideSug(); return; }
    if (e.key === 'Enter') {
      var first = t.parentNode.querySelector('.si[data-name]');
      if (first) { t.value = first.getAttribute('data-name'); hideSug(); }
      e.preventDefault();
    }
  });
  $('play').addEventListener('mousedown', function (e) {
    var it = e.target.closest ? e.target.closest('.si[data-name]') : null;
    if (!it) return;
    e.preventDefault();
    var inp = it.parentNode.parentNode.querySelector('input');
    inp.value = it.getAttribute('data-name');
    hideSug();
  });
  document.addEventListener('mousedown', function (e) {
    if (!(e.target.closest && e.target.closest('#play .sw'))) hideSug();
  });

  $('play').addEventListener('click', function (e) {
    var el = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!el || el.disabled) return;
    var act = el.getAttribute('data-act');
    var val = function (id) { var x = $(id); return x ? x.value : ''; };
    var trainer = function (id) {
      var v = val(id).trim().toLowerCase().split('@').join('');
      return playState && playState.trainers.indexOf(v) !== -1 ? v : '';
    };
    if (act === 'battle-go') {
      var o = trainer('pb-who');
      if (!o) { toast('Type a trainer name and pick it from the list.'); return; }
      playAct({ action: 'battle', opponent: o, slot: val('pb-mon') }, el);
    } else if (act === 'trade-go') {
      var t = trainer('pt-who');
      if (!t) { toast('Type a trainer name and pick it from the list.'); return; }
      playAct({ action: 'trade', target: t, slot: val('pt-mon') }, el);
    } else if (act === 'accept-battle') {
      playAct({ action: 'battle', opponent: playState.battle.opponent, slot: val('pa-mon') }, el);
    } else if (act === 'accept-trade') {
      playAct({ action: 'accept', slot: val('pi-mon') }, el);
    } else if (act === 'decline-trade') {
      playAct({ action: 'declineTrade' }, el);
    } else if (act === 'cancel-trade') {
      playAct({ action: 'cancelTrade' }, el);
    } else if (act === 'move') {
      playAct({ action: 'move', slot: el.getAttribute('data-mv') }, el);
    } else if (act === 'forfeit') {
      playAct({ action: 'forfeit' }, el);
    } else if (act === 'forfeit-active') {
      if (window.confirm('Forfeit this battle? Your opponent wins.')) playAct({ action: 'forfeit' }, el);
    }
  });

  $('search').oninput = function () { if (data) renderTrainers(); };
  renderAuth();
  renderCommands();
  load().then(restoreLogin);
  setInterval(load, 30000);
</script>
</body>
</html>`;

// Runs a bot command on behalf of a website-logged-in trainer (same rules as typing it in chat) and posts the result to the stream chat.
async function runCommand(user, cmd, args) {
  const unlock = await lockDB();
  try {
    const db = await getDB();
    const reply = await processCommand(db, user, cmd, args, false, false);
    if (reply) {
      try { await sendKickChat(db, reply); } catch (e) { console.error('❌ Could not post website command to chat:', e.message); }
    }
    return reply;
  } finally {
    unlock();
  }
}

registerPokedexSite(app, { getDB, saveDB, lockDB, runCommand, MOVE_LIMIT_MS, GEN2, MAX_POKEMON_ID, webLogins, crypto });

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Bot online on port ${PORT}!`));
