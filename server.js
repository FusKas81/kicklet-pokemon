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
const MAX_INVENTORY = 15;
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
const GEN1 = {"mons":{"63":{"n":"ABRA","t":["psychic"],"s":[25,20,15,90,105],"m":["TELEPORT"],"l":[],"e":[64]},"142":{"n":"AERODACTYL","t":["rock","flying"],"s":[80,105,65,130,60],"m":["WING_ATTACK","AGILITY"],"l":[[33,"SUPERSONIC"],[38,"BITE"],[45,"TAKE_DOWN"],[54,"HYPER_BEAM"]],"e":[]},"65":{"n":"ALAKAZAM","t":["psychic"],"s":[55,50,45,120,135],"m":["TELEPORT","CONFUSION","DISABLE"],"l":[[16,"CONFUSION"],[20,"DISABLE"],[27,"PSYBEAM"],[31,"RECOVER"],[38,"PSYCHIC_M"],[42,"REFLECT"]],"e":[]},"24":{"n":"ARBOK","t":["poison"],"s":[60,85,69,80,65],"m":["WRAP","LEER","POISON_STING"],"l":[[10,"POISON_STING"],[17,"BITE"],[27,"GLARE"],[36,"SCREECH"],[47,"ACID"]],"e":[]},"59":{"n":"ARCANINE","t":["fire"],"s":[90,110,80,95,80],"m":["ROAR","EMBER","LEER","TAKE_DOWN"],"l":[],"e":[]},"144":{"n":"ARTICUNO","t":["ice","flying"],"s":[90,85,100,85,125],"m":["PECK","ICE_BEAM"],"l":[[51,"BLIZZARD"],[55,"AGILITY"],[60,"MIST"]],"e":[]},"15":{"n":"BEEDRILL","t":["bug","poison"],"s":[65,80,40,75,45],"m":["FURY_ATTACK"],"l":[[12,"FURY_ATTACK"],[16,"FOCUS_ENERGY"],[20,"TWINEEDLE"],[25,"RAGE"],[30,"PIN_MISSILE"],[35,"AGILITY"]],"e":[]},"69":{"n":"BELLSPROUT","t":["grass","poison"],"s":[50,75,35,40,70],"m":["VINE_WHIP","GROWTH"],"l":[[13,"WRAP"],[15,"POISONPOWDER"],[18,"SLEEP_POWDER"],[21,"STUN_SPORE"],[26,"ACID"],[33,"RAZOR_LEAF"],[42,"SLAM"]],"e":[70]},"9":{"n":"BLASTOISE","t":["water"],"s":[79,83,100,78,85],"m":["TACKLE","TAIL_WHIP","BUBBLE","WATER_GUN"],"l":[[8,"BUBBLE"],[15,"WATER_GUN"],[24,"BITE"],[31,"WITHDRAW"],[42,"SKULL_BASH"],[52,"HYDRO_PUMP"]],"e":[]},"1":{"n":"BULBASAUR","t":["grass","poison"],"s":[45,49,49,45,65],"m":["TACKLE","GROWL"],"l":[[7,"LEECH_SEED"],[13,"VINE_WHIP"],[20,"POISONPOWDER"],[27,"RAZOR_LEAF"],[34,"GROWTH"],[41,"SLEEP_POWDER"],[48,"SOLARBEAM"]],"e":[2]},"12":{"n":"BUTTERFREE","t":["bug","flying"],"s":[60,45,50,70,80],"m":["CONFUSION"],"l":[[12,"CONFUSION"],[15,"POISONPOWDER"],[16,"STUN_SPORE"],[17,"SLEEP_POWDER"],[21,"SUPERSONIC"],[26,"WHIRLWIND"],[32,"PSYBEAM"]],"e":[]},"10":{"n":"CATERPIE","t":["bug"],"s":[45,30,35,45,20],"m":["TACKLE","STRING_SHOT"],"l":[],"e":[11]},"113":{"n":"CHANSEY","t":["normal"],"s":[250,5,5,50,105],"m":["POUND","DOUBLESLAP"],"l":[[24,"SING"],[30,"GROWL"],[38,"MINIMIZE"],[44,"DEFENSE_CURL"],[48,"LIGHT_SCREEN"],[54,"DOUBLE_EDGE"]],"e":[]},"6":{"n":"CHARIZARD","t":["fire","flying"],"s":[78,84,78,100,85],"m":["SCRATCH","GROWL","EMBER","LEER"],"l":[[9,"EMBER"],[15,"LEER"],[24,"RAGE"],[36,"SLASH"],[46,"FLAMETHROWER"],[55,"FIRE_SPIN"]],"e":[]},"4":{"n":"CHARMANDER","t":["fire"],"s":[39,52,43,65,50],"m":["SCRATCH","GROWL"],"l":[[9,"EMBER"],[15,"LEER"],[22,"RAGE"],[30,"SLASH"],[38,"FLAMETHROWER"],[46,"FIRE_SPIN"]],"e":[5]},"5":{"n":"CHARMELEON","t":["fire"],"s":[58,64,58,80,65],"m":["SCRATCH","GROWL","EMBER"],"l":[[9,"EMBER"],[15,"LEER"],[24,"RAGE"],[33,"SLASH"],[42,"FLAMETHROWER"],[56,"FIRE_SPIN"]],"e":[6]},"36":{"n":"CLEFABLE","t":["normal"],"s":[95,70,73,60,85],"m":["SING","DOUBLESLAP","MINIMIZE","METRONOME"],"l":[],"e":[]},"35":{"n":"CLEFAIRY","t":["normal"],"s":[70,45,48,35,60],"m":["POUND","GROWL"],"l":[[13,"SING"],[18,"DOUBLESLAP"],[24,"MINIMIZE"],[31,"METRONOME"],[39,"DEFENSE_CURL"],[48,"LIGHT_SCREEN"]],"e":[36]},"91":{"n":"CLOYSTER","t":["water","ice"],"s":[50,95,180,70,85],"m":["WITHDRAW","SUPERSONIC","CLAMP","AURORA_BEAM"],"l":[[50,"SPIKE_CANNON"]],"e":[]},"104":{"n":"CUBONE","t":["ground"],"s":[50,50,95,35,40],"m":["BONE_CLUB","GROWL"],"l":[[25,"LEER"],[31,"FOCUS_ENERGY"],[38,"THRASH"],[43,"BONEMERANG"],[46,"RAGE"]],"e":[105]},"87":{"n":"DEWGONG","t":["water","ice"],"s":[90,70,80,70,95],"m":["HEADBUTT","GROWL","AURORA_BEAM"],"l":[[30,"GROWL"],[35,"AURORA_BEAM"],[44,"REST"],[50,"TAKE_DOWN"],[56,"ICE_BEAM"]],"e":[]},"50":{"n":"DIGLETT","t":["ground"],"s":[10,55,25,95,45],"m":["SCRATCH"],"l":[[15,"GROWL"],[19,"DIG"],[24,"SAND_ATTACK"],[31,"SLASH"],[40,"EARTHQUAKE"]],"e":[51]},"132":{"n":"DITTO","t":["normal"],"s":[48,48,48,48,48],"m":["TRANSFORM"],"l":[],"e":[]},"85":{"n":"DODRIO","t":["normal","flying"],"s":[60,110,70,100,60],"m":["PECK","GROWL","FURY_ATTACK"],"l":[[20,"GROWL"],[24,"FURY_ATTACK"],[30,"DRILL_PECK"],[39,"RAGE"],[45,"TRI_ATTACK"],[51,"AGILITY"]],"e":[]},"84":{"n":"DODUO","t":["normal","flying"],"s":[35,85,45,75,35],"m":["PECK"],"l":[[20,"GROWL"],[24,"FURY_ATTACK"],[30,"DRILL_PECK"],[36,"RAGE"],[40,"TRI_ATTACK"],[44,"AGILITY"]],"e":[85]},"148":{"n":"DRAGONAIR","t":["dragon"],"s":[61,84,65,70,70],"m":["WRAP","LEER","THUNDER_WAVE"],"l":[[10,"THUNDER_WAVE"],[20,"AGILITY"],[35,"SLAM"],[45,"DRAGON_RAGE"],[55,"HYPER_BEAM"]],"e":[149]},"149":{"n":"DRAGONITE","t":["dragon","flying"],"s":[91,134,95,80,100],"m":["WRAP","LEER","THUNDER_WAVE","AGILITY"],"l":[[10,"THUNDER_WAVE"],[20,"AGILITY"],[35,"SLAM"],[45,"DRAGON_RAGE"],[60,"HYPER_BEAM"]],"e":[]},"147":{"n":"DRATINI","t":["dragon"],"s":[41,64,45,50,50],"m":["WRAP","LEER"],"l":[[10,"THUNDER_WAVE"],[20,"AGILITY"],[30,"SLAM"],[40,"DRAGON_RAGE"],[50,"HYPER_BEAM"]],"e":[148]},"96":{"n":"DROWZEE","t":["psychic"],"s":[60,48,45,42,90],"m":["POUND","HYPNOSIS"],"l":[[12,"DISABLE"],[17,"CONFUSION"],[24,"HEADBUTT"],[29,"POISON_GAS"],[32,"PSYCHIC_M"],[37,"MEDITATE"]],"e":[97]},"51":{"n":"DUGTRIO","t":["ground"],"s":[35,80,50,120,70],"m":["SCRATCH","GROWL","DIG"],"l":[[15,"GROWL"],[19,"DIG"],[24,"SAND_ATTACK"],[35,"SLASH"],[47,"EARTHQUAKE"]],"e":[]},"133":{"n":"EEVEE","t":["normal"],"s":[55,55,50,55,65],"m":["TACKLE","SAND_ATTACK"],"l":[[27,"QUICK_ATTACK"],[31,"TAIL_WHIP"],[37,"BITE"],[45,"TAKE_DOWN"]],"e":[136,135,134]},"23":{"n":"EKANS","t":["poison"],"s":[35,60,44,55,40],"m":["WRAP","LEER"],"l":[[10,"POISON_STING"],[17,"BITE"],[24,"GLARE"],[31,"SCREECH"],[38,"ACID"]],"e":[24]},"125":{"n":"ELECTABUZZ","t":["electric"],"s":[65,83,57,105,85],"m":["QUICK_ATTACK","LEER"],"l":[[34,"THUNDERSHOCK"],[37,"SCREECH"],[42,"THUNDERPUNCH"],[49,"LIGHT_SCREEN"],[54,"THUNDER"]],"e":[]},"101":{"n":"ELECTRODE","t":["electric"],"s":[60,50,70,140,80],"m":["TACKLE","SCREECH","SONICBOOM"],"l":[[17,"SONICBOOM"],[22,"SELFDESTRUCT"],[29,"LIGHT_SCREEN"],[40,"SWIFT"],[50,"EXPLOSION"]],"e":[]},"102":{"n":"EXEGGCUTE","t":["grass","psychic"],"s":[60,40,80,40,60],"m":["BARRAGE","HYPNOSIS"],"l":[[25,"REFLECT"],[28,"LEECH_SEED"],[32,"STUN_SPORE"],[37,"POISONPOWDER"],[42,"SOLARBEAM"],[48,"SLEEP_POWDER"]],"e":[103]},"103":{"n":"EXEGGUTOR","t":["grass","psychic"],"s":[95,95,85,55,125],"m":["BARRAGE","HYPNOSIS"],"l":[[28,"STOMP"]],"e":[]},"83":{"n":"FARFETCHD","t":["normal","flying"],"s":[52,65,55,60,58],"m":["PECK","SAND_ATTACK"],"l":[[7,"LEER"],[15,"FURY_ATTACK"],[23,"SWORDS_DANCE"],[31,"AGILITY"],[39,"SLASH"]],"e":[]},"22":{"n":"FEAROW","t":["normal","flying"],"s":[65,90,65,100,61],"m":["PECK","GROWL","LEER"],"l":[[9,"LEER"],[15,"FURY_ATTACK"],[25,"MIRROR_MOVE"],[34,"DRILL_PECK"],[43,"AGILITY"]],"e":[]},"136":{"n":"FLAREON","t":["fire"],"s":[65,130,60,65,110],"m":["TACKLE","SAND_ATTACK","QUICK_ATTACK","EMBER"],"l":[[27,"QUICK_ATTACK"],[31,"EMBER"],[37,"TAIL_WHIP"],[40,"BITE"],[42,"LEER"],[44,"FIRE_SPIN"],[48,"RAGE"],[54,"FLAMETHROWER"]],"e":[]},"92":{"n":"GASTLY","t":["ghost","poison"],"s":[30,35,30,80,100],"m":["LICK","CONFUSE_RAY","NIGHT_SHADE"],"l":[[27,"HYPNOSIS"],[35,"DREAM_EATER"]],"e":[93]},"94":{"n":"GENGAR","t":["ghost","poison"],"s":[60,65,60,110,130],"m":["LICK","CONFUSE_RAY","NIGHT_SHADE"],"l":[[29,"HYPNOSIS"],[38,"DREAM_EATER"]],"e":[]},"74":{"n":"GEODUDE","t":["rock","ground"],"s":[40,80,100,20,30],"m":["TACKLE"],"l":[[11,"DEFENSE_CURL"],[16,"ROCK_THROW"],[21,"SELFDESTRUCT"],[26,"HARDEN"],[31,"EARTHQUAKE"],[36,"EXPLOSION"]],"e":[75]},"44":{"n":"GLOOM","t":["grass","poison"],"s":[60,65,70,40,85],"m":["ABSORB","POISONPOWDER","STUN_SPORE"],"l":[[15,"POISONPOWDER"],[17,"STUN_SPORE"],[19,"SLEEP_POWDER"],[28,"ACID"],[38,"PETAL_DANCE"],[52,"SOLARBEAM"]],"e":[45]},"42":{"n":"GOLBAT","t":["poison","flying"],"s":[75,80,70,90,75],"m":["LEECH_LIFE","SCREECH","BITE"],"l":[[10,"SUPERSONIC"],[15,"BITE"],[21,"CONFUSE_RAY"],[32,"WING_ATTACK"],[43,"HAZE"]],"e":[]},"118":{"n":"GOLDEEN","t":["water"],"s":[45,67,60,63,50],"m":["PECK","TAIL_WHIP"],"l":[[19,"SUPERSONIC"],[24,"HORN_ATTACK"],[30,"FURY_ATTACK"],[37,"WATERFALL"],[45,"HORN_DRILL"],[54,"AGILITY"]],"e":[119]},"55":{"n":"GOLDUCK","t":["water"],"s":[80,82,78,85,80],"m":["SCRATCH","TAIL_WHIP","DISABLE"],"l":[[28,"TAIL_WHIP"],[31,"DISABLE"],[39,"CONFUSION"],[48,"FURY_SWIPES"],[59,"HYDRO_PUMP"]],"e":[]},"76":{"n":"GOLEM","t":["rock","ground"],"s":[80,110,130,45,55],"m":["TACKLE","DEFENSE_CURL"],"l":[[11,"DEFENSE_CURL"],[16,"ROCK_THROW"],[21,"SELFDESTRUCT"],[29,"HARDEN"],[36,"EARTHQUAKE"],[43,"EXPLOSION"]],"e":[]},"75":{"n":"GRAVELER","t":["rock","ground"],"s":[55,95,115,35,45],"m":["TACKLE","DEFENSE_CURL"],"l":[[11,"DEFENSE_CURL"],[16,"ROCK_THROW"],[21,"SELFDESTRUCT"],[29,"HARDEN"],[36,"EARTHQUAKE"],[43,"EXPLOSION"]],"e":[76]},"88":{"n":"GRIMER","t":["poison"],"s":[80,80,50,25,40],"m":["POUND","DISABLE"],"l":[[30,"POISON_GAS"],[33,"MINIMIZE"],[37,"SLUDGE"],[42,"HARDEN"],[48,"SCREECH"],[55,"ACID_ARMOR"]],"e":[89]},"58":{"n":"GROWLITHE","t":["fire"],"s":[55,70,45,60,50],"m":["BITE","ROAR"],"l":[[18,"EMBER"],[23,"LEER"],[30,"TAKE_DOWN"],[39,"AGILITY"],[50,"FLAMETHROWER"]],"e":[59]},"130":{"n":"GYARADOS","t":["water","flying"],"s":[95,125,79,81,100],"m":["BITE","DRAGON_RAGE","LEER","HYDRO_PUMP"],"l":[[20,"BITE"],[25,"DRAGON_RAGE"],[32,"LEER"],[41,"HYDRO_PUMP"],[52,"HYPER_BEAM"]],"e":[]},"93":{"n":"HAUNTER","t":["ghost","poison"],"s":[45,50,45,95,115],"m":["LICK","CONFUSE_RAY","NIGHT_SHADE"],"l":[[29,"HYPNOSIS"],[38,"DREAM_EATER"]],"e":[94]},"107":{"n":"HITMONCHAN","t":["fighting"],"s":[50,105,79,76,35],"m":["COMET_PUNCH","AGILITY"],"l":[[33,"FIRE_PUNCH"],[38,"ICE_PUNCH"],[43,"THUNDERPUNCH"],[48,"MEGA_PUNCH"],[53,"COUNTER"]],"e":[]},"106":{"n":"HITMONLEE","t":["fighting"],"s":[50,120,53,87,35],"m":["DOUBLE_KICK","MEDITATE"],"l":[[33,"ROLLING_KICK"],[38,"JUMP_KICK"],[43,"FOCUS_ENERGY"],[48,"HI_JUMP_KICK"],[53,"MEGA_KICK"]],"e":[]},"116":{"n":"HORSEA","t":["water"],"s":[30,40,70,60,70],"m":["BUBBLE"],"l":[[19,"SMOKESCREEN"],[24,"LEER"],[30,"WATER_GUN"],[37,"AGILITY"],[45,"HYDRO_PUMP"]],"e":[117]},"97":{"n":"HYPNO","t":["psychic"],"s":[85,73,70,67,115],"m":["POUND","HYPNOSIS","DISABLE","CONFUSION"],"l":[[12,"DISABLE"],[17,"CONFUSION"],[24,"HEADBUTT"],[33,"POISON_GAS"],[37,"PSYCHIC_M"],[43,"MEDITATE"]],"e":[]},"2":{"n":"IVYSAUR","t":["grass","poison"],"s":[60,62,63,60,80],"m":["TACKLE","GROWL","LEECH_SEED"],"l":[[7,"LEECH_SEED"],[13,"VINE_WHIP"],[22,"POISONPOWDER"],[30,"RAZOR_LEAF"],[38,"GROWTH"],[46,"SLEEP_POWDER"],[54,"SOLARBEAM"]],"e":[3]},"39":{"n":"JIGGLYPUFF","t":["normal"],"s":[115,45,20,20,25],"m":["SING"],"l":[[9,"POUND"],[14,"DISABLE"],[19,"DEFENSE_CURL"],[24,"DOUBLESLAP"],[29,"REST"],[34,"BODY_SLAM"],[39,"DOUBLE_EDGE"]],"e":[40]},"135":{"n":"JOLTEON","t":["electric"],"s":[65,65,60,130,110],"m":["TACKLE","SAND_ATTACK","QUICK_ATTACK","THUNDERSHOCK"],"l":[[27,"QUICK_ATTACK"],[31,"THUNDERSHOCK"],[37,"TAIL_WHIP"],[40,"THUNDER_WAVE"],[42,"DOUBLE_KICK"],[44,"AGILITY"],[48,"PIN_MISSILE"],[54,"THUNDER"]],"e":[]},"124":{"n":"JYNX","t":["ice","psychic"],"s":[65,50,35,95,95],"m":["POUND","LOVELY_KISS"],"l":[[18,"LICK"],[23,"DOUBLESLAP"],[31,"ICE_PUNCH"],[39,"BODY_SLAM"],[47,"THRASH"],[58,"BLIZZARD"]],"e":[]},"140":{"n":"KABUTO","t":["rock","water"],"s":[30,80,90,55,45],"m":["SCRATCH","HARDEN"],"l":[[34,"ABSORB"],[39,"SLASH"],[44,"LEER"],[49,"HYDRO_PUMP"]],"e":[141]},"141":{"n":"KABUTOPS","t":["rock","water"],"s":[60,115,105,80,70],"m":["SCRATCH","HARDEN","ABSORB"],"l":[[34,"ABSORB"],[39,"SLASH"],[46,"LEER"],[53,"HYDRO_PUMP"]],"e":[]},"64":{"n":"KADABRA","t":["psychic"],"s":[40,35,30,105,120],"m":["TELEPORT","CONFUSION","DISABLE"],"l":[[16,"CONFUSION"],[20,"DISABLE"],[27,"PSYBEAM"],[31,"RECOVER"],[38,"PSYCHIC_M"],[42,"REFLECT"]],"e":[65]},"14":{"n":"KAKUNA","t":["bug","poison"],"s":[45,25,50,35,25],"m":["HARDEN"],"l":[],"e":[15]},"115":{"n":"KANGASKHAN","t":["normal"],"s":[105,95,80,90,40],"m":["COMET_PUNCH","RAGE"],"l":[[26,"BITE"],[31,"TAIL_WHIP"],[36,"MEGA_PUNCH"],[41,"LEER"],[46,"DIZZY_PUNCH"]],"e":[]},"99":{"n":"KINGLER","t":["water"],"s":[55,130,115,75,50],"m":["BUBBLE","LEER","VICEGRIP"],"l":[[20,"VICEGRIP"],[25,"GUILLOTINE"],[34,"STOMP"],[42,"CRABHAMMER"],[49,"HARDEN"]],"e":[]},"109":{"n":"KOFFING","t":["poison"],"s":[40,65,95,35,60],"m":["TACKLE","SMOG"],"l":[[32,"SLUDGE"],[37,"SMOKESCREEN"],[40,"SELFDESTRUCT"],[45,"HAZE"],[48,"EXPLOSION"]],"e":[110]},"98":{"n":"KRABBY","t":["water"],"s":[30,105,90,50,25],"m":["BUBBLE","LEER"],"l":[[20,"VICEGRIP"],[25,"GUILLOTINE"],[30,"STOMP"],[35,"CRABHAMMER"],[40,"HARDEN"]],"e":[99]},"131":{"n":"LAPRAS","t":["water","ice"],"s":[130,85,80,60,95],"m":["WATER_GUN","GROWL"],"l":[[16,"SING"],[20,"MIST"],[25,"BODY_SLAM"],[31,"CONFUSE_RAY"],[38,"ICE_BEAM"],[46,"HYDRO_PUMP"]],"e":[]},"108":{"n":"LICKITUNG","t":["normal"],"s":[90,55,75,30,60],"m":["WRAP","SUPERSONIC"],"l":[[7,"STOMP"],[15,"DISABLE"],[23,"DEFENSE_CURL"],[31,"SLAM"],[39,"SCREECH"]],"e":[]},"68":{"n":"MACHAMP","t":["fighting"],"s":[90,130,80,55,65],"m":["KARATE_CHOP","LOW_KICK","LEER"],"l":[[20,"LOW_KICK"],[25,"LEER"],[36,"FOCUS_ENERGY"],[44,"SEISMIC_TOSS"],[52,"SUBMISSION"]],"e":[]},"67":{"n":"MACHOKE","t":["fighting"],"s":[80,100,70,45,50],"m":["KARATE_CHOP","LOW_KICK","LEER"],"l":[[20,"LOW_KICK"],[25,"LEER"],[36,"FOCUS_ENERGY"],[44,"SEISMIC_TOSS"],[52,"SUBMISSION"]],"e":[68]},"66":{"n":"MACHOP","t":["fighting"],"s":[70,80,50,35,35],"m":["KARATE_CHOP"],"l":[[20,"LOW_KICK"],[25,"LEER"],[32,"FOCUS_ENERGY"],[39,"SEISMIC_TOSS"],[46,"SUBMISSION"]],"e":[67]},"129":{"n":"MAGIKARP","t":["water"],"s":[20,10,55,80,20],"m":["SPLASH"],"l":[[15,"TACKLE"]],"e":[130]},"126":{"n":"MAGMAR","t":["fire"],"s":[65,95,57,93,85],"m":["EMBER"],"l":[[36,"LEER"],[39,"CONFUSE_RAY"],[43,"FIRE_PUNCH"],[48,"SMOKESCREEN"],[52,"SMOG"],[55,"FLAMETHROWER"]],"e":[]},"81":{"n":"MAGNEMITE","t":["electric"],"s":[25,35,70,45,95],"m":["TACKLE"],"l":[[21,"SONICBOOM"],[25,"THUNDERSHOCK"],[29,"SUPERSONIC"],[35,"THUNDER_WAVE"],[41,"SWIFT"],[47,"SCREECH"]],"e":[82]},"82":{"n":"MAGNETON","t":["electric"],"s":[50,60,95,70,120],"m":["TACKLE","SONICBOOM","THUNDERSHOCK"],"l":[[21,"SONICBOOM"],[25,"THUNDERSHOCK"],[29,"SUPERSONIC"],[38,"THUNDER_WAVE"],[46,"SWIFT"],[54,"SCREECH"]],"e":[]},"56":{"n":"MANKEY","t":["fighting"],"s":[40,80,35,70,35],"m":["SCRATCH","LEER"],"l":[[15,"KARATE_CHOP"],[21,"FURY_SWIPES"],[27,"FOCUS_ENERGY"],[33,"SEISMIC_TOSS"],[39,"THRASH"]],"e":[57]},"105":{"n":"MAROWAK","t":["ground"],"s":[60,80,110,45,50],"m":["BONE_CLUB","GROWL","LEER","FOCUS_ENERGY"],"l":[[25,"LEER"],[33,"FOCUS_ENERGY"],[41,"THRASH"],[48,"BONEMERANG"],[55,"RAGE"]],"e":[]},"52":{"n":"MEOWTH","t":["normal"],"s":[40,45,35,90,40],"m":["SCRATCH","GROWL"],"l":[[12,"BITE"],[17,"PAY_DAY"],[24,"SCREECH"],[33,"FURY_SWIPES"],[44,"SLASH"]],"e":[53]},"11":{"n":"METAPOD","t":["bug"],"s":[50,20,55,30,25],"m":["HARDEN"],"l":[],"e":[12]},"151":{"n":"MEW","t":["psychic"],"s":[100,100,100,100,100],"m":["POUND"],"l":[[10,"TRANSFORM"],[20,"MEGA_PUNCH"],[30,"METRONOME"],[40,"PSYCHIC_M"]],"e":[]},"150":{"n":"MEWTWO","t":["psychic"],"s":[106,110,90,130,154],"m":["CONFUSION","DISABLE","SWIFT","PSYCHIC_M"],"l":[[63,"BARRIER"],[66,"PSYCHIC_M"],[70,"RECOVER"],[75,"MIST"],[81,"AMNESIA"]],"e":[]},"146":{"n":"MOLTRES","t":["fire","flying"],"s":[90,100,90,90,125],"m":["PECK","FIRE_SPIN"],"l":[[51,"LEER"],[55,"AGILITY"],[60,"SKY_ATTACK"]],"e":[]},"122":{"n":"MR-MIME","t":["psychic"],"s":[40,45,65,90,100],"m":["CONFUSION","BARRIER"],"l":[[15,"CONFUSION"],[23,"LIGHT_SCREEN"],[31,"DOUBLESLAP"],[39,"MEDITATE"],[47,"SUBSTITUTE"]],"e":[]},"89":{"n":"MUK","t":["poison"],"s":[105,105,75,50,65],"m":["POUND","DISABLE","POISON_GAS"],"l":[[30,"POISON_GAS"],[33,"MINIMIZE"],[37,"SLUDGE"],[45,"HARDEN"],[53,"SCREECH"],[60,"ACID_ARMOR"]],"e":[]},"34":{"n":"NIDOKING","t":["poison","ground"],"s":[81,92,77,85,75],"m":["TACKLE","HORN_ATTACK","POISON_STING","THRASH"],"l":[[8,"HORN_ATTACK"],[14,"POISON_STING"],[23,"THRASH"]],"e":[]},"31":{"n":"NIDOQUEEN","t":["poison","ground"],"s":[90,82,87,76,75],"m":["TACKLE","SCRATCH","TAIL_WHIP","BODY_SLAM"],"l":[[8,"SCRATCH"],[14,"POISON_STING"],[23,"BODY_SLAM"]],"e":[]},"29":{"n":"NIDORAN-F","t":["poison"],"s":[55,47,52,41,40],"m":["GROWL","TACKLE"],"l":[[8,"SCRATCH"],[14,"POISON_STING"],[21,"TAIL_WHIP"],[29,"BITE"],[36,"FURY_SWIPES"],[43,"DOUBLE_KICK"]],"e":[30]},"32":{"n":"NIDORAN-M","t":["poison"],"s":[46,57,40,50,40],"m":["LEER","TACKLE"],"l":[[8,"HORN_ATTACK"],[14,"POISON_STING"],[21,"FOCUS_ENERGY"],[29,"FURY_ATTACK"],[36,"HORN_DRILL"],[43,"DOUBLE_KICK"]],"e":[33]},"30":{"n":"NIDORINA","t":["poison"],"s":[70,62,67,56,55],"m":["GROWL","TACKLE","SCRATCH"],"l":[[8,"SCRATCH"],[14,"POISON_STING"],[23,"TAIL_WHIP"],[32,"BITE"],[41,"FURY_SWIPES"],[50,"DOUBLE_KICK"]],"e":[31]},"33":{"n":"NIDORINO","t":["poison"],"s":[61,72,57,65,55],"m":["LEER","TACKLE","HORN_ATTACK"],"l":[[8,"HORN_ATTACK"],[14,"POISON_STING"],[23,"FOCUS_ENERGY"],[32,"FURY_ATTACK"],[41,"HORN_DRILL"],[50,"DOUBLE_KICK"]],"e":[34]},"38":{"n":"NINETALES","t":["fire"],"s":[73,76,75,100,100],"m":["EMBER","TAIL_WHIP","QUICK_ATTACK","ROAR"],"l":[],"e":[]},"43":{"n":"ODDISH","t":["grass","poison"],"s":[45,50,55,30,75],"m":["ABSORB"],"l":[[15,"POISONPOWDER"],[17,"STUN_SPORE"],[19,"SLEEP_POWDER"],[24,"ACID"],[33,"PETAL_DANCE"],[46,"SOLARBEAM"]],"e":[44]},"138":{"n":"OMANYTE","t":["rock","water"],"s":[35,40,100,35,90],"m":["WATER_GUN","WITHDRAW"],"l":[[34,"HORN_ATTACK"],[39,"LEER"],[46,"SPIKE_CANNON"],[53,"HYDRO_PUMP"]],"e":[139]},"139":{"n":"OMASTAR","t":["rock","water"],"s":[70,60,125,55,115],"m":["WATER_GUN","WITHDRAW","HORN_ATTACK"],"l":[[34,"HORN_ATTACK"],[39,"LEER"],[44,"SPIKE_CANNON"],[49,"HYDRO_PUMP"]],"e":[]},"95":{"n":"ONIX","t":["rock","ground"],"s":[35,45,160,70,30],"m":["TACKLE","SCREECH"],"l":[[15,"BIND"],[19,"ROCK_THROW"],[25,"RAGE"],[33,"SLAM"],[43,"HARDEN"]],"e":[]},"46":{"n":"PARAS","t":["bug","grass"],"s":[35,70,55,25,55],"m":["SCRATCH"],"l":[[13,"STUN_SPORE"],[20,"LEECH_LIFE"],[27,"SPORE"],[34,"SLASH"],[41,"GROWTH"]],"e":[47]},"47":{"n":"PARASECT","t":["bug","grass"],"s":[60,95,80,30,80],"m":["SCRATCH","STUN_SPORE","LEECH_LIFE"],"l":[[13,"STUN_SPORE"],[20,"LEECH_LIFE"],[30,"SPORE"],[39,"SLASH"],[48,"GROWTH"]],"e":[]},"53":{"n":"PERSIAN","t":["normal"],"s":[65,70,60,115,65],"m":["SCRATCH","GROWL","BITE","SCREECH"],"l":[[12,"BITE"],[17,"PAY_DAY"],[24,"SCREECH"],[37,"FURY_SWIPES"],[51,"SLASH"]],"e":[]},"18":{"n":"PIDGEOT","t":["normal","flying"],"s":[83,80,75,91,70],"m":["GUST","SAND_ATTACK","QUICK_ATTACK"],"l":[[5,"SAND_ATTACK"],[12,"QUICK_ATTACK"],[21,"WHIRLWIND"],[31,"WING_ATTACK"],[44,"AGILITY"],[54,"MIRROR_MOVE"]],"e":[]},"17":{"n":"PIDGEOTTO","t":["normal","flying"],"s":[63,60,55,71,50],"m":["GUST","SAND_ATTACK"],"l":[[5,"SAND_ATTACK"],[12,"QUICK_ATTACK"],[21,"WHIRLWIND"],[31,"WING_ATTACK"],[40,"AGILITY"],[49,"MIRROR_MOVE"]],"e":[18]},"16":{"n":"PIDGEY","t":["normal","flying"],"s":[40,45,40,56,35],"m":["GUST"],"l":[[5,"SAND_ATTACK"],[12,"QUICK_ATTACK"],[19,"WHIRLWIND"],[28,"WING_ATTACK"],[36,"AGILITY"],[44,"MIRROR_MOVE"]],"e":[17]},"25":{"n":"PIKACHU","t":["electric"],"s":[35,55,30,90,50],"m":["THUNDERSHOCK","GROWL"],"l":[[9,"THUNDER_WAVE"],[16,"QUICK_ATTACK"],[26,"SWIFT"],[33,"AGILITY"],[43,"THUNDER"]],"e":[26]},"127":{"n":"PINSIR","t":["bug"],"s":[65,125,100,85,55],"m":["VICEGRIP"],"l":[[25,"SEISMIC_TOSS"],[30,"GUILLOTINE"],[36,"FOCUS_ENERGY"],[43,"HARDEN"],[49,"SLASH"],[54,"SWORDS_DANCE"]],"e":[]},"60":{"n":"POLIWAG","t":["water"],"s":[40,50,40,90,40],"m":["BUBBLE"],"l":[[16,"HYPNOSIS"],[19,"WATER_GUN"],[25,"DOUBLESLAP"],[31,"BODY_SLAM"],[38,"AMNESIA"],[45,"HYDRO_PUMP"]],"e":[61]},"61":{"n":"POLIWHIRL","t":["water"],"s":[65,65,65,90,50],"m":["BUBBLE","HYPNOSIS","WATER_GUN"],"l":[[16,"HYPNOSIS"],[19,"WATER_GUN"],[26,"DOUBLESLAP"],[33,"BODY_SLAM"],[41,"AMNESIA"],[49,"HYDRO_PUMP"]],"e":[62]},"62":{"n":"POLIWRATH","t":["water","fighting"],"s":[90,85,95,70,70],"m":["HYPNOSIS","WATER_GUN","DOUBLESLAP","BODY_SLAM"],"l":[[16,"HYPNOSIS"],[19,"WATER_GUN"]],"e":[]},"77":{"n":"PONYTA","t":["fire"],"s":[50,85,55,90,65],"m":["EMBER"],"l":[[30,"TAIL_WHIP"],[32,"STOMP"],[35,"GROWL"],[39,"FIRE_SPIN"],[43,"TAKE_DOWN"],[48,"AGILITY"]],"e":[78]},"137":{"n":"PORYGON","t":["normal"],"s":[65,60,70,40,75],"m":["TACKLE","SHARPEN","CONVERSION"],"l":[[23,"PSYBEAM"],[28,"RECOVER"],[35,"AGILITY"],[42,"TRI_ATTACK"]],"e":[]},"57":{"n":"PRIMEAPE","t":["fighting"],"s":[65,105,60,95,60],"m":["SCRATCH","LEER","KARATE_CHOP","FURY_SWIPES"],"l":[[15,"KARATE_CHOP"],[21,"FURY_SWIPES"],[27,"FOCUS_ENERGY"],[37,"SEISMIC_TOSS"],[46,"THRASH"]],"e":[]},"54":{"n":"PSYDUCK","t":["water"],"s":[50,52,48,55,50],"m":["SCRATCH"],"l":[[28,"TAIL_WHIP"],[31,"DISABLE"],[36,"CONFUSION"],[43,"FURY_SWIPES"],[52,"HYDRO_PUMP"]],"e":[55]},"26":{"n":"RAICHU","t":["electric"],"s":[60,90,55,100,90],"m":["THUNDERSHOCK","GROWL","THUNDER_WAVE"],"l":[],"e":[]},"78":{"n":"RAPIDASH","t":["fire"],"s":[65,100,70,105,80],"m":["EMBER","TAIL_WHIP","STOMP","GROWL"],"l":[[30,"TAIL_WHIP"],[32,"STOMP"],[35,"GROWL"],[39,"FIRE_SPIN"],[47,"TAKE_DOWN"],[55,"AGILITY"]],"e":[]},"20":{"n":"RATICATE","t":["normal"],"s":[55,81,60,97,50],"m":["TACKLE","TAIL_WHIP","QUICK_ATTACK"],"l":[[7,"QUICK_ATTACK"],[14,"HYPER_FANG"],[27,"FOCUS_ENERGY"],[41,"SUPER_FANG"]],"e":[]},"19":{"n":"RATTATA","t":["normal"],"s":[30,56,35,72,25],"m":["TACKLE","TAIL_WHIP"],"l":[[7,"QUICK_ATTACK"],[14,"HYPER_FANG"],[23,"FOCUS_ENERGY"],[34,"SUPER_FANG"]],"e":[20]},"112":{"n":"RHYDON","t":["ground","rock"],"s":[105,130,120,40,45],"m":["HORN_ATTACK","STOMP","TAIL_WHIP","FURY_ATTACK"],"l":[[30,"STOMP"],[35,"TAIL_WHIP"],[40,"FURY_ATTACK"],[48,"HORN_DRILL"],[55,"LEER"],[64,"TAKE_DOWN"]],"e":[]},"111":{"n":"RHYHORN","t":["ground","rock"],"s":[80,85,95,25,30],"m":["HORN_ATTACK"],"l":[[30,"STOMP"],[35,"TAIL_WHIP"],[40,"FURY_ATTACK"],[45,"HORN_DRILL"],[50,"LEER"],[55,"TAKE_DOWN"]],"e":[112]},"27":{"n":"SANDSHREW","t":["ground"],"s":[50,75,85,40,30],"m":["SCRATCH"],"l":[[10,"SAND_ATTACK"],[17,"SLASH"],[24,"POISON_STING"],[31,"SWIFT"],[38,"FURY_SWIPES"]],"e":[28]},"28":{"n":"SANDSLASH","t":["ground"],"s":[75,100,110,65,55],"m":["SCRATCH","SAND_ATTACK"],"l":[[10,"SAND_ATTACK"],[17,"SLASH"],[27,"POISON_STING"],[36,"SWIFT"],[47,"FURY_SWIPES"]],"e":[]},"123":{"n":"SCYTHER","t":["bug","flying"],"s":[70,110,80,105,55],"m":["QUICK_ATTACK"],"l":[[17,"LEER"],[20,"FOCUS_ENERGY"],[24,"DOUBLE_TEAM"],[29,"SLASH"],[35,"SWORDS_DANCE"],[42,"AGILITY"]],"e":[]},"117":{"n":"SEADRA","t":["water"],"s":[55,65,95,85,95],"m":["BUBBLE","SMOKESCREEN"],"l":[[19,"SMOKESCREEN"],[24,"LEER"],[30,"WATER_GUN"],[41,"AGILITY"],[52,"HYDRO_PUMP"]],"e":[]},"119":{"n":"SEAKING","t":["water"],"s":[80,92,65,68,80],"m":["PECK","TAIL_WHIP","SUPERSONIC"],"l":[[19,"SUPERSONIC"],[24,"HORN_ATTACK"],[30,"FURY_ATTACK"],[39,"WATERFALL"],[48,"HORN_DRILL"],[54,"AGILITY"]],"e":[]},"86":{"n":"SEEL","t":["water"],"s":[65,45,55,45,70],"m":["HEADBUTT"],"l":[[30,"GROWL"],[35,"AURORA_BEAM"],[40,"REST"],[45,"TAKE_DOWN"],[50,"ICE_BEAM"]],"e":[87]},"90":{"n":"SHELLDER","t":["water"],"s":[30,65,100,40,45],"m":["TACKLE","WITHDRAW"],"l":[[18,"SUPERSONIC"],[23,"CLAMP"],[30,"AURORA_BEAM"],[39,"LEER"],[50,"ICE_BEAM"]],"e":[91]},"80":{"n":"SLOWBRO","t":["water","psychic"],"s":[95,75,110,30,80],"m":["CONFUSION","DISABLE","HEADBUTT"],"l":[[18,"DISABLE"],[22,"HEADBUTT"],[27,"GROWL"],[33,"WATER_GUN"],[37,"WITHDRAW"],[44,"AMNESIA"],[55,"PSYCHIC_M"]],"e":[]},"79":{"n":"SLOWPOKE","t":["water","psychic"],"s":[90,65,65,15,40],"m":["CONFUSION"],"l":[[18,"DISABLE"],[22,"HEADBUTT"],[27,"GROWL"],[33,"WATER_GUN"],[40,"AMNESIA"],[48,"PSYCHIC_M"]],"e":[80]},"143":{"n":"SNORLAX","t":["normal"],"s":[160,110,65,30,65],"m":["HEADBUTT","AMNESIA","REST"],"l":[[35,"BODY_SLAM"],[41,"HARDEN"],[48,"DOUBLE_EDGE"],[56,"HYPER_BEAM"]],"e":[]},"21":{"n":"SPEAROW","t":["normal","flying"],"s":[40,60,30,70,31],"m":["PECK","GROWL"],"l":[[9,"LEER"],[15,"FURY_ATTACK"],[22,"MIRROR_MOVE"],[29,"DRILL_PECK"],[36,"AGILITY"]],"e":[22]},"7":{"n":"SQUIRTLE","t":["water"],"s":[44,48,65,43,50],"m":["TACKLE","TAIL_WHIP"],"l":[[8,"BUBBLE"],[15,"WATER_GUN"],[22,"BITE"],[28,"WITHDRAW"],[35,"SKULL_BASH"],[42,"HYDRO_PUMP"]],"e":[8]},"121":{"n":"STARMIE","t":["water","psychic"],"s":[60,75,85,115,100],"m":["TACKLE","WATER_GUN","HARDEN"],"l":[],"e":[]},"120":{"n":"STARYU","t":["water"],"s":[30,45,55,85,70],"m":["TACKLE"],"l":[[17,"WATER_GUN"],[22,"HARDEN"],[27,"RECOVER"],[32,"SWIFT"],[37,"MINIMIZE"],[42,"LIGHT_SCREEN"],[47,"HYDRO_PUMP"]],"e":[121]},"114":{"n":"TANGELA","t":["grass"],"s":[65,55,115,60,100],"m":["CONSTRICT","BIND"],"l":[[29,"ABSORB"],[32,"POISONPOWDER"],[36,"STUN_SPORE"],[39,"SLEEP_POWDER"],[45,"SLAM"],[49,"GROWTH"]],"e":[]},"128":{"n":"TAUROS","t":["normal"],"s":[75,100,95,110,70],"m":["TACKLE"],"l":[[21,"STOMP"],[28,"TAIL_WHIP"],[35,"LEER"],[44,"RAGE"],[51,"TAKE_DOWN"]],"e":[]},"72":{"n":"TENTACOOL","t":["water","poison"],"s":[40,40,35,70,100],"m":["ACID"],"l":[[7,"SUPERSONIC"],[13,"WRAP"],[18,"POISON_STING"],[22,"WATER_GUN"],[27,"CONSTRICT"],[33,"BARRIER"],[40,"SCREECH"],[48,"HYDRO_PUMP"]],"e":[73]},"73":{"n":"TENTACRUEL","t":["water","poison"],"s":[80,70,65,100,120],"m":["ACID","SUPERSONIC","WRAP"],"l":[[7,"SUPERSONIC"],[13,"WRAP"],[18,"POISON_STING"],[22,"WATER_GUN"],[27,"CONSTRICT"],[35,"BARRIER"],[43,"SCREECH"],[50,"HYDRO_PUMP"]],"e":[]},"134":{"n":"VAPOREON","t":["water"],"s":[130,65,60,65,110],"m":["TACKLE","SAND_ATTACK","QUICK_ATTACK","WATER_GUN"],"l":[[27,"QUICK_ATTACK"],[31,"WATER_GUN"],[37,"TAIL_WHIP"],[40,"BITE"],[42,"ACID_ARMOR"],[44,"HAZE"],[48,"MIST"],[54,"HYDRO_PUMP"]],"e":[]},"49":{"n":"VENOMOTH","t":["bug","poison"],"s":[70,65,60,90,90],"m":["TACKLE","DISABLE","POISONPOWDER","LEECH_LIFE"],"l":[[24,"POISONPOWDER"],[27,"LEECH_LIFE"],[30,"STUN_SPORE"],[38,"PSYBEAM"],[43,"SLEEP_POWDER"],[50,"PSYCHIC_M"]],"e":[]},"48":{"n":"VENONAT","t":["bug","poison"],"s":[60,55,50,45,40],"m":["TACKLE","DISABLE"],"l":[[24,"POISONPOWDER"],[27,"LEECH_LIFE"],[30,"STUN_SPORE"],[35,"PSYBEAM"],[38,"SLEEP_POWDER"],[43,"PSYCHIC_M"]],"e":[49]},"3":{"n":"VENUSAUR","t":["grass","poison"],"s":[80,82,83,80,100],"m":["TACKLE","GROWL","LEECH_SEED","VINE_WHIP"],"l":[[7,"LEECH_SEED"],[13,"VINE_WHIP"],[22,"POISONPOWDER"],[30,"RAZOR_LEAF"],[43,"GROWTH"],[55,"SLEEP_POWDER"],[65,"SOLARBEAM"]],"e":[]},"71":{"n":"VICTREEBEL","t":["grass","poison"],"s":[80,105,65,70,100],"m":["SLEEP_POWDER","STUN_SPORE","ACID","RAZOR_LEAF"],"l":[[13,"WRAP"],[15,"POISONPOWDER"],[18,"SLEEP_POWDER"]],"e":[]},"45":{"n":"VILEPLUME","t":["grass","poison"],"s":[75,80,85,50,100],"m":["STUN_SPORE","SLEEP_POWDER","ACID","PETAL_DANCE"],"l":[[15,"POISONPOWDER"],[17,"STUN_SPORE"],[19,"SLEEP_POWDER"]],"e":[]},"100":{"n":"VOLTORB","t":["electric"],"s":[40,30,50,100,55],"m":["TACKLE","SCREECH"],"l":[[17,"SONICBOOM"],[22,"SELFDESTRUCT"],[29,"LIGHT_SCREEN"],[36,"SWIFT"],[43,"EXPLOSION"]],"e":[101]},"37":{"n":"VULPIX","t":["fire"],"s":[38,41,40,65,65],"m":["EMBER","TAIL_WHIP"],"l":[[16,"QUICK_ATTACK"],[21,"ROAR"],[28,"CONFUSE_RAY"],[35,"FLAMETHROWER"],[42,"FIRE_SPIN"]],"e":[38]},"8":{"n":"WARTORTLE","t":["water"],"s":[59,63,80,58,65],"m":["TACKLE","TAIL_WHIP","BUBBLE"],"l":[[8,"BUBBLE"],[15,"WATER_GUN"],[24,"BITE"],[31,"WITHDRAW"],[39,"SKULL_BASH"],[47,"HYDRO_PUMP"]],"e":[9]},"13":{"n":"WEEDLE","t":["bug","poison"],"s":[40,35,30,50,20],"m":["POISON_STING","STRING_SHOT"],"l":[],"e":[14]},"70":{"n":"WEEPINBELL","t":["grass","poison"],"s":[65,90,50,55,85],"m":["VINE_WHIP","GROWTH","WRAP"],"l":[[13,"WRAP"],[15,"POISONPOWDER"],[18,"SLEEP_POWDER"],[23,"STUN_SPORE"],[29,"ACID"],[38,"RAZOR_LEAF"],[49,"SLAM"]],"e":[71]},"110":{"n":"WEEZING","t":["poison"],"s":[65,90,120,60,85],"m":["TACKLE","SMOG","SLUDGE"],"l":[[32,"SLUDGE"],[39,"SMOKESCREEN"],[43,"SELFDESTRUCT"],[49,"HAZE"],[53,"EXPLOSION"]],"e":[]},"40":{"n":"WIGGLYTUFF","t":["normal"],"s":[140,70,45,45,50],"m":["SING","DISABLE","DEFENSE_CURL","DOUBLESLAP"],"l":[],"e":[]},"145":{"n":"ZAPDOS","t":["electric","flying"],"s":[90,90,85,100,125],"m":["THUNDERSHOCK","DRILL_PECK"],"l":[[51,"THUNDER"],[55,"AGILITY"],[60,"LIGHT_SCREEN"]],"e":[]},"41":{"n":"ZUBAT","t":["poison","flying"],"s":[40,45,35,55,40],"m":["LEECH_LIFE"],"l":[[10,"SUPERSONIC"],[15,"BITE"],[21,"CONFUSE_RAY"],[28,"WING_ATTACK"],[36,"HAZE"]],"e":[42]}},"moves":{"POUND":{"n":"POUND","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"normal","a":100,"pp":35},"KARATE_CHOP":{"n":"KARATE CHOP","e":"NO_ADDITIONAL_EFFECT","p":50,"t":"normal","a":100,"pp":25},"DOUBLESLAP":{"n":"DOUBLESLAP","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":15,"t":"normal","a":85,"pp":10},"COMET_PUNCH":{"n":"COMET PUNCH","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":18,"t":"normal","a":85,"pp":15},"MEGA_PUNCH":{"n":"MEGA PUNCH","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"normal","a":85,"pp":20},"PAY_DAY":{"n":"PAY DAY","e":"PAY_DAY_EFFECT","p":40,"t":"normal","a":100,"pp":20},"FIRE_PUNCH":{"n":"FIRE PUNCH","e":"BURN_SIDE_EFFECT1","p":75,"t":"fire","a":100,"pp":15},"ICE_PUNCH":{"n":"ICE PUNCH","e":"FREEZE_SIDE_EFFECT1","p":75,"t":"ice","a":100,"pp":15},"THUNDERPUNCH":{"n":"THUNDERPUNCH","e":"PARALYZE_SIDE_EFFECT1","p":75,"t":"electric","a":100,"pp":15},"SCRATCH":{"n":"SCRATCH","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"normal","a":100,"pp":35},"VICEGRIP":{"n":"VICEGRIP","e":"NO_ADDITIONAL_EFFECT","p":55,"t":"normal","a":100,"pp":30},"GUILLOTINE":{"n":"GUILLOTINE","e":"OHKO_EFFECT","p":1,"t":"normal","a":30,"pp":5},"RAZOR_WIND":{"n":"RAZOR WIND","e":"CHARGE_EFFECT","p":80,"t":"normal","a":75,"pp":10},"SWORDS_DANCE":{"n":"SWORDS DANCE","e":"ATTACK_UP2_EFFECT","p":0,"t":"normal","a":100,"pp":30},"CUT":{"n":"CUT","e":"NO_ADDITIONAL_EFFECT","p":50,"t":"normal","a":95,"pp":30},"GUST":{"n":"GUST","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"normal","a":100,"pp":35},"WING_ATTACK":{"n":"WING ATTACK","e":"NO_ADDITIONAL_EFFECT","p":35,"t":"flying","a":100,"pp":35},"WHIRLWIND":{"n":"WHIRLWIND","e":"SWITCH_AND_TELEPORT_EFFECT","p":0,"t":"normal","a":85,"pp":20},"FLY":{"n":"FLY","e":"FLY_EFFECT","p":70,"t":"flying","a":95,"pp":15},"BIND":{"n":"BIND","e":"TRAPPING_EFFECT","p":15,"t":"normal","a":75,"pp":20},"SLAM":{"n":"SLAM","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"normal","a":75,"pp":20},"VINE_WHIP":{"n":"VINE WHIP","e":"NO_ADDITIONAL_EFFECT","p":35,"t":"grass","a":100,"pp":10},"STOMP":{"n":"STOMP","e":"FLINCH_SIDE_EFFECT2","p":65,"t":"normal","a":100,"pp":20},"DOUBLE_KICK":{"n":"DOUBLE KICK","e":"ATTACK_TWICE_EFFECT","p":30,"t":"fighting","a":100,"pp":30},"MEGA_KICK":{"n":"MEGA KICK","e":"NO_ADDITIONAL_EFFECT","p":120,"t":"normal","a":75,"pp":5},"JUMP_KICK":{"n":"JUMP KICK","e":"JUMP_KICK_EFFECT","p":70,"t":"fighting","a":95,"pp":25},"ROLLING_KICK":{"n":"ROLLING KICK","e":"FLINCH_SIDE_EFFECT2","p":60,"t":"fighting","a":85,"pp":15},"SAND_ATTACK":{"n":"SAND-ATTACK","e":"ACCURACY_DOWN1_EFFECT","p":0,"t":"normal","a":100,"pp":15},"HEADBUTT":{"n":"HEADBUTT","e":"FLINCH_SIDE_EFFECT2","p":70,"t":"normal","a":100,"pp":15},"HORN_ATTACK":{"n":"HORN ATTACK","e":"NO_ADDITIONAL_EFFECT","p":65,"t":"normal","a":100,"pp":25},"FURY_ATTACK":{"n":"FURY ATTACK","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":15,"t":"normal","a":85,"pp":20},"HORN_DRILL":{"n":"HORN DRILL","e":"OHKO_EFFECT","p":1,"t":"normal","a":30,"pp":5},"TACKLE":{"n":"TACKLE","e":"NO_ADDITIONAL_EFFECT","p":35,"t":"normal","a":95,"pp":35},"BODY_SLAM":{"n":"BODY SLAM","e":"PARALYZE_SIDE_EFFECT2","p":85,"t":"normal","a":100,"pp":15},"WRAP":{"n":"WRAP","e":"TRAPPING_EFFECT","p":15,"t":"normal","a":85,"pp":20},"TAKE_DOWN":{"n":"TAKE DOWN","e":"RECOIL_EFFECT","p":90,"t":"normal","a":85,"pp":20},"THRASH":{"n":"THRASH","e":"THRASH_PETAL_DANCE_EFFECT","p":90,"t":"normal","a":100,"pp":20},"DOUBLE_EDGE":{"n":"DOUBLE-EDGE","e":"RECOIL_EFFECT","p":100,"t":"normal","a":100,"pp":15},"TAIL_WHIP":{"n":"TAIL WHIP","e":"DEFENSE_DOWN1_EFFECT","p":0,"t":"normal","a":100,"pp":30},"POISON_STING":{"n":"POISON STING","e":"POISON_SIDE_EFFECT1","p":15,"t":"poison","a":100,"pp":35},"TWINEEDLE":{"n":"TWINEEDLE","e":"TWINEEDLE_EFFECT","p":25,"t":"bug","a":100,"pp":20},"PIN_MISSILE":{"n":"PIN MISSILE","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":14,"t":"bug","a":85,"pp":20},"LEER":{"n":"LEER","e":"DEFENSE_DOWN1_EFFECT","p":0,"t":"normal","a":100,"pp":30},"BITE":{"n":"BITE","e":"FLINCH_SIDE_EFFECT1","p":60,"t":"normal","a":100,"pp":25},"GROWL":{"n":"GROWL","e":"ATTACK_DOWN1_EFFECT","p":0,"t":"normal","a":100,"pp":40},"ROAR":{"n":"ROAR","e":"SWITCH_AND_TELEPORT_EFFECT","p":0,"t":"normal","a":100,"pp":20},"SING":{"n":"SING","e":"SLEEP_EFFECT","p":0,"t":"normal","a":55,"pp":15},"SUPERSONIC":{"n":"SUPERSONIC","e":"CONFUSION_EFFECT","p":0,"t":"normal","a":55,"pp":20},"SONICBOOM":{"n":"SONICBOOM","e":"SPECIAL_DAMAGE_EFFECT","p":1,"t":"normal","a":90,"pp":20},"DISABLE":{"n":"DISABLE","e":"DISABLE_EFFECT","p":0,"t":"normal","a":55,"pp":20},"ACID":{"n":"ACID","e":"DEFENSE_DOWN_SIDE_EFFECT","p":40,"t":"poison","a":100,"pp":30},"EMBER":{"n":"EMBER","e":"BURN_SIDE_EFFECT1","p":40,"t":"fire","a":100,"pp":25},"FLAMETHROWER":{"n":"FLAMETHROWER","e":"BURN_SIDE_EFFECT1","p":95,"t":"fire","a":100,"pp":15},"MIST":{"n":"MIST","e":"MIST_EFFECT","p":0,"t":"ice","a":100,"pp":30},"WATER_GUN":{"n":"WATER GUN","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"water","a":100,"pp":25},"HYDRO_PUMP":{"n":"HYDRO PUMP","e":"NO_ADDITIONAL_EFFECT","p":120,"t":"water","a":80,"pp":5},"SURF":{"n":"SURF","e":"NO_ADDITIONAL_EFFECT","p":95,"t":"water","a":100,"pp":15},"ICE_BEAM":{"n":"ICE BEAM","e":"FREEZE_SIDE_EFFECT1","p":95,"t":"ice","a":100,"pp":10},"BLIZZARD":{"n":"BLIZZARD","e":"FREEZE_SIDE_EFFECT1","p":120,"t":"ice","a":90,"pp":5},"PSYBEAM":{"n":"PSYBEAM","e":"CONFUSION_SIDE_EFFECT","p":65,"t":"psychic","a":100,"pp":20},"BUBBLEBEAM":{"n":"BUBBLEBEAM","e":"SPEED_DOWN_SIDE_EFFECT","p":65,"t":"water","a":100,"pp":20},"AURORA_BEAM":{"n":"AURORA BEAM","e":"ATTACK_DOWN_SIDE_EFFECT","p":65,"t":"ice","a":100,"pp":20},"HYPER_BEAM":{"n":"HYPER BEAM","e":"HYPER_BEAM_EFFECT","p":150,"t":"normal","a":90,"pp":5},"PECK":{"n":"PECK","e":"NO_ADDITIONAL_EFFECT","p":35,"t":"flying","a":100,"pp":35},"DRILL_PECK":{"n":"DRILL PECK","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"flying","a":100,"pp":20},"SUBMISSION":{"n":"SUBMISSION","e":"RECOIL_EFFECT","p":80,"t":"fighting","a":80,"pp":25},"LOW_KICK":{"n":"LOW KICK","e":"FLINCH_SIDE_EFFECT2","p":50,"t":"fighting","a":90,"pp":20},"COUNTER":{"n":"COUNTER","e":"NO_ADDITIONAL_EFFECT","p":1,"t":"fighting","a":100,"pp":20},"SEISMIC_TOSS":{"n":"SEISMIC TOSS","e":"SPECIAL_DAMAGE_EFFECT","p":1,"t":"fighting","a":100,"pp":20},"STRENGTH":{"n":"STRENGTH","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"normal","a":100,"pp":15},"ABSORB":{"n":"ABSORB","e":"DRAIN_HP_EFFECT","p":20,"t":"grass","a":100,"pp":20},"MEGA_DRAIN":{"n":"MEGA DRAIN","e":"DRAIN_HP_EFFECT","p":40,"t":"grass","a":100,"pp":10},"LEECH_SEED":{"n":"LEECH SEED","e":"LEECH_SEED_EFFECT","p":0,"t":"grass","a":90,"pp":10},"GROWTH":{"n":"GROWTH","e":"SPECIAL_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":40},"RAZOR_LEAF":{"n":"RAZOR LEAF","e":"NO_ADDITIONAL_EFFECT","p":55,"t":"grass","a":95,"pp":25},"SOLARBEAM":{"n":"SOLARBEAM","e":"CHARGE_EFFECT","p":120,"t":"grass","a":100,"pp":10},"POISONPOWDER":{"n":"POISONPOWDER","e":"POISON_EFFECT","p":0,"t":"poison","a":75,"pp":35},"STUN_SPORE":{"n":"STUN SPORE","e":"PARALYZE_EFFECT","p":0,"t":"grass","a":75,"pp":30},"SLEEP_POWDER":{"n":"SLEEP POWDER","e":"SLEEP_EFFECT","p":0,"t":"grass","a":75,"pp":15},"PETAL_DANCE":{"n":"PETAL DANCE","e":"THRASH_PETAL_DANCE_EFFECT","p":70,"t":"grass","a":100,"pp":20},"STRING_SHOT":{"n":"STRING SHOT","e":"SPEED_DOWN1_EFFECT","p":0,"t":"bug","a":95,"pp":40},"DRAGON_RAGE":{"n":"DRAGON RAGE","e":"SPECIAL_DAMAGE_EFFECT","p":1,"t":"dragon","a":100,"pp":10},"FIRE_SPIN":{"n":"FIRE SPIN","e":"TRAPPING_EFFECT","p":15,"t":"fire","a":70,"pp":15},"THUNDERSHOCK":{"n":"THUNDERSHOCK","e":"PARALYZE_SIDE_EFFECT1","p":40,"t":"electric","a":100,"pp":30},"THUNDERBOLT":{"n":"THUNDERBOLT","e":"PARALYZE_SIDE_EFFECT1","p":95,"t":"electric","a":100,"pp":15},"THUNDER_WAVE":{"n":"THUNDER WAVE","e":"PARALYZE_EFFECT","p":0,"t":"electric","a":100,"pp":20},"THUNDER":{"n":"THUNDER","e":"PARALYZE_SIDE_EFFECT1","p":120,"t":"electric","a":70,"pp":10},"ROCK_THROW":{"n":"ROCK THROW","e":"NO_ADDITIONAL_EFFECT","p":50,"t":"rock","a":65,"pp":15},"EARTHQUAKE":{"n":"EARTHQUAKE","e":"NO_ADDITIONAL_EFFECT","p":100,"t":"ground","a":100,"pp":10},"FISSURE":{"n":"FISSURE","e":"OHKO_EFFECT","p":1,"t":"ground","a":30,"pp":5},"DIG":{"n":"DIG","e":"CHARGE_EFFECT","p":100,"t":"ground","a":100,"pp":10},"TOXIC":{"n":"TOXIC","e":"POISON_EFFECT","p":0,"t":"poison","a":85,"pp":10},"CONFUSION":{"n":"CONFUSION","e":"CONFUSION_SIDE_EFFECT","p":50,"t":"psychic","a":100,"pp":25},"PSYCHIC_M":{"n":"PSYCHIC","e":"SPECIAL_DOWN_SIDE_EFFECT","p":90,"t":"psychic","a":100,"pp":10},"HYPNOSIS":{"n":"HYPNOSIS","e":"SLEEP_EFFECT","p":0,"t":"psychic","a":60,"pp":20},"MEDITATE":{"n":"MEDITATE","e":"ATTACK_UP1_EFFECT","p":0,"t":"psychic","a":100,"pp":40},"AGILITY":{"n":"AGILITY","e":"SPEED_UP2_EFFECT","p":0,"t":"psychic","a":100,"pp":30},"QUICK_ATTACK":{"n":"QUICK ATTACK","e":"NO_ADDITIONAL_EFFECT","p":40,"t":"normal","a":100,"pp":30},"RAGE":{"n":"RAGE","e":"RAGE_EFFECT","p":20,"t":"normal","a":100,"pp":20},"TELEPORT":{"n":"TELEPORT","e":"SWITCH_AND_TELEPORT_EFFECT","p":0,"t":"psychic","a":100,"pp":20},"NIGHT_SHADE":{"n":"NIGHT SHADE","e":"SPECIAL_DAMAGE_EFFECT","p":0,"t":"ghost","a":100,"pp":15},"MIMIC":{"n":"MIMIC","e":"MIMIC_EFFECT","p":0,"t":"normal","a":100,"pp":10},"SCREECH":{"n":"SCREECH","e":"DEFENSE_DOWN2_EFFECT","p":0,"t":"normal","a":85,"pp":40},"DOUBLE_TEAM":{"n":"DOUBLE TEAM","e":"EVASION_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":15},"RECOVER":{"n":"RECOVER","e":"HEAL_EFFECT","p":0,"t":"normal","a":100,"pp":20},"HARDEN":{"n":"HARDEN","e":"DEFENSE_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":30},"MINIMIZE":{"n":"MINIMIZE","e":"EVASION_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":20},"SMOKESCREEN":{"n":"SMOKESCREEN","e":"ACCURACY_DOWN1_EFFECT","p":0,"t":"normal","a":100,"pp":20},"CONFUSE_RAY":{"n":"CONFUSE RAY","e":"CONFUSION_EFFECT","p":0,"t":"ghost","a":100,"pp":10},"WITHDRAW":{"n":"WITHDRAW","e":"DEFENSE_UP1_EFFECT","p":0,"t":"water","a":100,"pp":40},"DEFENSE_CURL":{"n":"DEFENSE CURL","e":"DEFENSE_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":40},"BARRIER":{"n":"BARRIER","e":"DEFENSE_UP2_EFFECT","p":0,"t":"psychic","a":100,"pp":30},"LIGHT_SCREEN":{"n":"LIGHT SCREEN","e":"LIGHT_SCREEN_EFFECT","p":0,"t":"psychic","a":100,"pp":30},"HAZE":{"n":"HAZE","e":"HAZE_EFFECT","p":0,"t":"ice","a":100,"pp":30},"REFLECT":{"n":"REFLECT","e":"REFLECT_EFFECT","p":0,"t":"psychic","a":100,"pp":20},"FOCUS_ENERGY":{"n":"FOCUS ENERGY","e":"FOCUS_ENERGY_EFFECT","p":0,"t":"normal","a":100,"pp":30},"BIDE":{"n":"BIDE","e":"BIDE_EFFECT","p":0,"t":"normal","a":100,"pp":10},"METRONOME":{"n":"METRONOME","e":"METRONOME_EFFECT","p":0,"t":"normal","a":100,"pp":10},"MIRROR_MOVE":{"n":"MIRROR MOVE","e":"MIRROR_MOVE_EFFECT","p":0,"t":"flying","a":100,"pp":20},"SELFDESTRUCT":{"n":"SELFDESTRUCT","e":"EXPLODE_EFFECT","p":130,"t":"normal","a":100,"pp":5},"EGG_BOMB":{"n":"EGG BOMB","e":"NO_ADDITIONAL_EFFECT","p":100,"t":"normal","a":75,"pp":10},"LICK":{"n":"LICK","e":"PARALYZE_SIDE_EFFECT2","p":20,"t":"ghost","a":100,"pp":30},"SMOG":{"n":"SMOG","e":"POISON_SIDE_EFFECT2","p":20,"t":"poison","a":70,"pp":20},"SLUDGE":{"n":"SLUDGE","e":"POISON_SIDE_EFFECT2","p":65,"t":"poison","a":100,"pp":20},"BONE_CLUB":{"n":"BONE CLUB","e":"FLINCH_SIDE_EFFECT1","p":65,"t":"ground","a":85,"pp":20},"FIRE_BLAST":{"n":"FIRE BLAST","e":"BURN_SIDE_EFFECT2","p":120,"t":"fire","a":85,"pp":5},"WATERFALL":{"n":"WATERFALL","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"water","a":100,"pp":15},"CLAMP":{"n":"CLAMP","e":"TRAPPING_EFFECT","p":35,"t":"water","a":75,"pp":10},"SWIFT":{"n":"SWIFT","e":"SWIFT_EFFECT","p":60,"t":"normal","a":100,"pp":20},"SKULL_BASH":{"n":"SKULL BASH","e":"CHARGE_EFFECT","p":100,"t":"normal","a":100,"pp":15},"SPIKE_CANNON":{"n":"SPIKE CANNON","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":20,"t":"normal","a":100,"pp":15},"CONSTRICT":{"n":"CONSTRICT","e":"SPEED_DOWN_SIDE_EFFECT","p":10,"t":"normal","a":100,"pp":35},"AMNESIA":{"n":"AMNESIA","e":"SPECIAL_UP2_EFFECT","p":0,"t":"psychic","a":100,"pp":20},"KINESIS":{"n":"KINESIS","e":"ACCURACY_DOWN1_EFFECT","p":0,"t":"psychic","a":80,"pp":15},"SOFTBOILED":{"n":"SOFTBOILED","e":"HEAL_EFFECT","p":0,"t":"normal","a":100,"pp":10},"HI_JUMP_KICK":{"n":"HI JUMP KICK","e":"JUMP_KICK_EFFECT","p":85,"t":"fighting","a":90,"pp":20},"GLARE":{"n":"GLARE","e":"PARALYZE_EFFECT","p":0,"t":"normal","a":75,"pp":30},"DREAM_EATER":{"n":"DREAM EATER","e":"DREAM_EATER_EFFECT","p":100,"t":"psychic","a":100,"pp":15},"POISON_GAS":{"n":"POISON GAS","e":"POISON_EFFECT","p":0,"t":"poison","a":55,"pp":40},"BARRAGE":{"n":"BARRAGE","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":15,"t":"normal","a":85,"pp":20},"LEECH_LIFE":{"n":"LEECH LIFE","e":"DRAIN_HP_EFFECT","p":20,"t":"bug","a":100,"pp":15},"LOVELY_KISS":{"n":"LOVELY KISS","e":"SLEEP_EFFECT","p":0,"t":"normal","a":75,"pp":10},"SKY_ATTACK":{"n":"SKY ATTACK","e":"CHARGE_EFFECT","p":140,"t":"flying","a":90,"pp":5},"TRANSFORM":{"n":"TRANSFORM","e":"TRANSFORM_EFFECT","p":0,"t":"normal","a":100,"pp":10},"BUBBLE":{"n":"BUBBLE","e":"SPEED_DOWN_SIDE_EFFECT","p":20,"t":"water","a":100,"pp":30},"DIZZY_PUNCH":{"n":"DIZZY PUNCH","e":"NO_ADDITIONAL_EFFECT","p":70,"t":"normal","a":100,"pp":10},"SPORE":{"n":"SPORE","e":"SLEEP_EFFECT","p":0,"t":"grass","a":100,"pp":15},"FLASH":{"n":"FLASH","e":"ACCURACY_DOWN1_EFFECT","p":0,"t":"normal","a":70,"pp":20},"PSYWAVE":{"n":"PSYWAVE","e":"SPECIAL_DAMAGE_EFFECT","p":1,"t":"psychic","a":80,"pp":15},"SPLASH":{"n":"SPLASH","e":"SPLASH_EFFECT","p":0,"t":"normal","a":100,"pp":40},"ACID_ARMOR":{"n":"ACID ARMOR","e":"DEFENSE_UP2_EFFECT","p":0,"t":"poison","a":100,"pp":40},"CRABHAMMER":{"n":"CRABHAMMER","e":"NO_ADDITIONAL_EFFECT","p":90,"t":"water","a":85,"pp":10},"EXPLOSION":{"n":"EXPLOSION","e":"EXPLODE_EFFECT","p":170,"t":"normal","a":100,"pp":5},"FURY_SWIPES":{"n":"FURY SWIPES","e":"TWO_TO_FIVE_ATTACKS_EFFECT","p":18,"t":"normal","a":80,"pp":15},"BONEMERANG":{"n":"BONEMERANG","e":"ATTACK_TWICE_EFFECT","p":50,"t":"ground","a":90,"pp":10},"REST":{"n":"REST","e":"HEAL_EFFECT","p":0,"t":"psychic","a":100,"pp":10},"ROCK_SLIDE":{"n":"ROCK SLIDE","e":"NO_ADDITIONAL_EFFECT","p":75,"t":"rock","a":90,"pp":10},"HYPER_FANG":{"n":"HYPER FANG","e":"FLINCH_SIDE_EFFECT1","p":80,"t":"normal","a":90,"pp":15},"SHARPEN":{"n":"SHARPEN","e":"ATTACK_UP1_EFFECT","p":0,"t":"normal","a":100,"pp":30},"CONVERSION":{"n":"CONVERSION","e":"CONVERSION_EFFECT","p":0,"t":"normal","a":100,"pp":30},"TRI_ATTACK":{"n":"TRI ATTACK","e":"NO_ADDITIONAL_EFFECT","p":80,"t":"normal","a":100,"pp":10},"SUPER_FANG":{"n":"SUPER FANG","e":"SUPER_FANG_EFFECT","p":1,"t":"normal","a":90,"pp":10},"SLASH":{"n":"SLASH","e":"NO_ADDITIONAL_EFFECT","p":70,"t":"normal","a":100,"pp":20},"SUBSTITUTE":{"n":"SUBSTITUTE","e":"SUBSTITUTE_EFFECT","p":0,"t":"normal","a":100,"pp":10},"STRUGGLE":{"n":"STRUGGLE","e":"RECOIL_EFFECT","p":50,"t":"normal","a":100,"pp":10}},"chart":[["water","fire",20],["fire","grass",20],["fire","ice",20],["grass","water",20],["electric","water",20],["water","rock",20],["ground","flying",0],["water","water",5],["fire","fire",5],["electric","electric",5],["ice","ice",5],["grass","grass",5],["psychic","psychic",5],["fire","water",5],["grass","fire",5],["water","grass",5],["electric","grass",5],["normal","rock",5],["normal","ghost",0],["ghost","ghost",20],["fire","bug",20],["fire","rock",5],["water","ground",20],["electric","ground",0],["electric","flying",20],["grass","ground",20],["grass","bug",5],["grass","poison",5],["grass","rock",20],["grass","flying",5],["ice","water",5],["ice","grass",20],["ice","ground",20],["ice","flying",20],["fighting","normal",20],["fighting","poison",5],["fighting","flying",5],["fighting","psychic",5],["fighting","bug",5],["fighting","rock",20],["fighting","ice",20],["fighting","ghost",0],["poison","grass",20],["poison","poison",5],["poison","ground",5],["poison","bug",20],["poison","rock",5],["poison","ghost",5],["ground","fire",20],["ground","electric",20],["ground","grass",5],["ground","bug",5],["ground","rock",20],["ground","poison",20],["flying","electric",5],["flying","fighting",20],["flying","bug",20],["flying","grass",20],["flying","rock",5],["psychic","fighting",20],["psychic","poison",20],["bug","fire",5],["bug","grass",20],["bug","fighting",5],["bug","flying",5],["bug","psychic",20],["bug","ghost",5],["bug","poison",20],["rock","fire",20],["rock","fighting",5],["rock","ground",5],["rock","flying",20],["rock","bug",20],["rock","ice",20],["ghost","normal",0],["ghost","psychic",0],["fire","dragon",5],["water","dragon",5],["electric","dragon",5],["grass","dragon",5],["ice","dragon",20],["dragon","dragon",20]]};

// ===================================================================
// GEN 1 (POKÉMON RED/BLUE) STATS + BATTLE ENGINE
// Game data (base stats, types, moves, learnsets, type chart) was
// extracted from the pret/pokered disassembly. Formulas follow the
// original game code (damage, crits, accuracy, status, stat stages).
// ===================================================================
const G1_LEVEL = 50; // every Pokémon in the bot is level 50
const G1_PHYSICAL = new Set(['normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost']);
const G1_RATIOS = [[25, 100], [28, 100], [33, 100], [40, 100], [50, 100], [66, 100], [1, 1], [15, 10], [2, 1], [25, 10], [3, 1], [35, 10], [4, 1]];
const G1_HIGH_CRIT = new Set(['KARATE_CHOP', 'RAZOR_LEAF', 'CRABHAMMER', 'SLASH']);
const G1_STAT_NAMES = { atk: 'ATTACK', def: 'DEFENSE', spd: 'SPEED', spc: 'SPECIAL', acc: 'ACCURACY', eva: 'EVASION' };
const G1_STAT_KEYS = { ATTACK: 'atk', DEFENSE: 'def', SPEED: 'spd', SPECIAL: 'spc', ACCURACY: 'acc', EVASION: 'eva' };
const G1_CHARGE_TEXT = {
  RAZOR_WIND: 'made a whirlwind!', SOLARBEAM: 'took in sunlight!', SKULL_BASH: 'lowered its head!',
  SKY_ATTACK: 'is glowing!', FLY: 'flew up high!', DIG: 'dug a hole!'
};
const G1_FIXED_DAMAGE = new Set(['SPECIAL_DAMAGE_EFFECT', 'SUPER_FANG_EFFECT', 'OHKO_EFFECT']);

const g1Rb = (rng) => Math.floor(rng() * 256); // BattleRandom: 0-255

// ---------- stats / creation ----------
function g1LearnMoves(species, level) {
  const known = species.m.slice();
  for (const [lv, mv] of species.l) {
    if (lv > level) break;
    if (known.includes(mv)) continue;
    if (known.length < 4) known.push(mv);
    else { known.shift(); known.push(mv); }
  }
  return known;
}

function g1MoveEntry(key) {
  const m = GEN1.moves[key];
  return { k: key, name: m.n, type: m.t, power: m.p, acc: m.a, pp: m.pp, maxPp: m.pp };
}

function g1CreateMon(dexId, isShiny = null, rng = Math.random, uid = null) {
  const sp = GEN1.mons[dexId];
  const dv = { atk: Math.floor(rng() * 16), def: Math.floor(rng() * 16), spd: Math.floor(rng() * 16), spc: Math.floor(rng() * 16) };
  dv.hp = ((dv.atk & 1) << 3) | ((dv.def & 1) << 2) | ((dv.spd & 1) << 1) | (dv.spc & 1);
  const L = G1_LEVEL;
  // Gen 1 stat formula with 0 stat experience
  const calc = (base, d, isHp) => {
    const core = Math.floor(((base + d) * 2) * L / 100);
    return isHp ? core + L + 10 : core + 5;
  };
  const stats = {
    hp: calc(sp.s[0], dv.hp, true), atk: calc(sp.s[1], dv.atk), def: calc(sp.s[2], dv.def),
    spd: calc(sp.s[3], dv.spd), spc: calc(sp.s[4], dv.spc)
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
    moves: g1LearnMoves(sp, L).map(g1MoveEntry),
    gen1: true
  };
}

// Old saved Pokémon (from before the Gen 1 update) are rebuilt with real Gen 1 stats, keeping species, shiny and uid.
function g1EnsureMon(mon) {
  if (mon && mon.gen1 === true && mon.stats && mon.moves && mon.moves[0] && mon.moves[0].k) return mon;
  return g1CreateMon(mon.id, Boolean(mon.isShiny), Math.random, mon.uid);
}

// ---------- battle mon ----------
function g1BattleMon(mon) {
  return {
    uid: mon.uid, id: mon.id, speciesId: mon.id, spriteId: mon.id, name: mon.name, isShiny: Boolean(mon.isShiny),
    types: mon.types.slice(), level: mon.level, stats: { ...mon.stats }, maxHp: mon.stats.hp, currentHp: mon.stats.hp,
    stages: { atk: 0, def: 0, spd: 0, spc: 0, acc: 0, eva: 0 },
    status: null, sleep: 0, badly: false, toxic: 0,
    conf: 0, flinch: false, recharge: false, seeded: false, mist: false, focus: false, reflect: false, lscreen: false,
    sub: 0, disabled: null, disabledTurns: 0, charging: null, invuln: false,
    trapping: false, trapLeft: 0, trapDmg: 0, trapKey: null, thrash: 0, thrashKey: null, rage: false, bide: null,
    lastMove: null, counterDmg: 0,
    moves: mon.moves.map((m) => ({ ...m, pp: m.maxPp }))
  };
}

function g1ModStat(m, s) {
  const [n, d] = G1_RATIOS[m.stages[s] + 6];
  return Math.max(1, Math.min(999, Math.floor(m.stats[s] * n / d)));
}
function g1Stat(m, s) {
  let v = g1ModStat(m, s);
  if (s === 'atk' && m.status === 'brn') v = Math.max(1, v >> 1);
  if (s === 'spd' && m.status === 'par') v = Math.max(1, v >> 2);
  return v;
}

// ---------- damage ----------
function g1RawDamage(level, power, atk, def) {
  let dmg = Math.floor(Math.floor(Math.floor((Math.floor(2 * level / 5) + 2) * power * atk) / Math.max(1, def)) / 50);
  return Math.min(997, dmg) + 2;
}

function g1Damage(A, D, mv, crit, explode) {
  const special = !G1_PHYSICAL.has(mv.t);
  let atk, def;
  if (crit) {
    atk = A.stats[special ? 'spc' : 'atk'];
    def = D.stats[special ? 'spc' : 'def'];
  } else {
    atk = g1Stat(A, special ? 'spc' : 'atk');
    def = g1Stat(D, special ? 'spc' : 'def');
    if (!special && D.reflect) def *= 2;
    if (special && D.lscreen) def *= 2;
  }
  if (atk > 255 || def > 255) { atk = Math.max(1, atk >> 2); def = Math.max(1, def >> 2); }
  if (explode) def = Math.max(1, def >> 1);
  let dmg = g1RawDamage(A.level * (crit ? 2 : 1), mv.p, atk, def);
  if (A.types.includes(mv.t)) dmg += dmg >> 1; // STAB
  let mult = 1;
  for (const [at, dt, r] of GEN1.chart) {
    if (at === mv.t && D.types.includes(dt)) { dmg = Math.floor(dmg * r / 10); mult *= r / 10; }
  }
  return { dmg, mult };
}

function g1CritThreshold(A, key) {
  const b0 = Math.floor(GEN1.mons[A.speciesId].s[3] / 2);
  let b = A.focus ? (b0 >> 1) : Math.min(255, b0 * 2); // Focus Energy bug: quarters the crit rate
  if (G1_HIGH_CRIT.has(key)) { b = Math.min(255, b * 2); b = Math.min(255, b * 2); } else { b = b >> 1; }
  return b;
}

function g1HitCheck(A, D, mv, rng) {
  let acc = Math.floor(mv.a * 255 / 100);
  let [n, d] = G1_RATIOS[A.stages.acc + 6];
  acc = Math.max(1, Math.floor(acc * n / d));
  [n, d] = G1_RATIOS[-D.stages.eva + 6];
  acc = Math.max(1, Math.floor(acc * n / d));
  acc = Math.min(255, acc);
  return g1Rb(rng) < acc; // even 100% moves miss 1/256 of the time (Gen 1 quirk)
}

// ---------- helpers ----------
function g1Hurt(ctx, A, D, dmg, mv) {
  if (D.sub > 0) {
    if (dmg >= D.sub) { D.sub = 0; ctx.say(`${D.name}'s SUBSTITUTE broke!`); }
    else { D.sub -= dmg; ctx.say('The SUBSTITUTE took the hit!'); }
    if (mv && (mv.t === 'normal' || mv.t === 'fighting')) D.counterDmg = dmg;
    return 0;
  }
  const dealt = Math.min(dmg, D.currentHp);
  D.currentHp -= dealt;
  if (mv && (mv.t === 'normal' || mv.t === 'fighting')) D.counterDmg = dmg;
  if (D.bide) D.bide.accum += dmg;
  if (D.rage && D.currentHp > 0 && mv && mv.p > 0 && D.stages.atk < 6) {
    D.stages.atk++;
    ctx.say(`${D.name}'s RAGE is building!`);
  }
  return dealt;
}

function g1ClearVolatile(A) {
  A.charging = null; A.invuln = false; A.trapping = false; A.trapLeft = 0; A.thrash = 0; A.bide = null;
}

function g1Heal(M, amt) { M.currentHp = Math.min(M.maxHp, M.currentHp + amt); }

function g1StatChange(ctx, M, stat, delta, byOther) {
  const s = M.stages[stat];
  if (delta > 0) {
    if (s >= 6) { ctx.say('Nothing happened!'); return false; }
    if (['atk', 'def', 'spd', 'spc'].includes(stat) && g1ModStat(M, stat) >= 999) { ctx.say('Nothing happened!'); return false; }
    M.stages[stat] = Math.min(6, s + delta);
    ctx.say(`${M.name}'s ${G1_STAT_NAMES[stat]} ${delta > 1 ? 'greatly ' : ''}rose!`);
    return true;
  }
  if (s <= -6) { if (!byOther.silent) ctx.say('Nothing happened!'); return false; }
  if (['atk', 'def', 'spd', 'spc'].includes(stat) && g1ModStat(M, stat) <= 1) { if (!byOther.silent) ctx.say('Nothing happened!'); return false; }
  M.stages[stat] = Math.max(-6, s + delta);
  ctx.say(`${M.name}'s ${G1_STAT_NAMES[stat]} ${delta < -1 ? 'greatly ' : ''}fell!`);
  return true;
}

function g1RollConfusion(rng) { return 2 + (g1Rb(rng) & 3); }
function g1RollMulti(rng) {
  let r = g1Rb(rng) & 3;
  if (r >= 2) r = g1Rb(rng) & 3;
  return r; // 0-3
}

// ---------- executing a move ----------
function g1Exec(ctx, A, D, key, o = {}) {
  const mv = GEN1.moves[key];
  const say = ctx.say;
  if (!o.noText) say(`${A.name} used ${mv.n}!`);
  if (!o.noPP) {
    const slot = A.moves.find((m) => m.k === key);
    if (slot && slot.pp > 0) slot.pp--;
  }
  if (!o.noRecord) A.lastMove = key;
  const e = mv.e;

  if (e === 'MIRROR_MOVE_EFFECT') {
    const c = D.lastMove;
    if (!c || c === 'MIRROR_MOVE') { say('But it failed!'); return; }
    return g1Exec(ctx, A, D, c, { noPP: true, noRecord: true });
  }
  if (e === 'METRONOME_EFFECT') {
    const pool = Object.keys(GEN1.moves).filter((k) => k !== 'METRONOME' && k !== 'STRUGGLE');
    const pick = pool[Math.floor(ctx.rng() * pool.length)];
    return g1Exec(ctx, A, D, pick, { noPP: true, noRecord: true });
  }

  // two-turn moves
  if (!o.charged && (e === 'CHARGE_EFFECT' || e === 'FLY_EFFECT')) {
    A.charging = key;
    if (key === 'FLY' || key === 'DIG') A.invuln = true;
    say(`${A.name} ${G1_CHARGE_TEXT[key] || 'is charging up!'}`);
    return;
  }

  if (G1_FIXED_DAMAGE.has(e) || mv.p > 0 || key === 'COUNTER') return g1Attack(ctx, A, D, key, mv, o);
  return g1StatusMove(ctx, A, D, key, mv);
}

function g1Attack(ctx, A, D, key, mv, o) {
  const say = ctx.say, rng = ctx.rng, e = mv.e;
  let dmg = 0, crit = false, mult = 1, missed = false, immune = false, ohko = false;

  if (!o.cont) {
    if (e === 'THRASH_PETAL_DANCE_EFFECT') { A.thrash = 2 + (g1Rb(rng) & 1); A.thrashKey = key; }
    if (e === 'TRAPPING_EFFECT') { A.trapping = true; A.trapKey = key; A.trapLeft = 1 + g1RollMulti(rng); }
    if (e === 'RAGE_EFFECT') A.rage = true;
  }

  if (e === 'SPECIAL_DAMAGE_EFFECT') {
    if (key === 'SONICBOOM') dmg = 20;
    else if (key === 'DRAGON_RAGE') dmg = 40;
    else if (key === 'PSYWAVE') { const cap = A.level + (A.level >> 1); do { dmg = g1Rb(rng); } while (dmg === 0 || dmg >= cap); }
    else dmg = A.level; // Seismic Toss, Night Shade
  } else if (e === 'SUPER_FANG_EFFECT') {
    dmg = Math.max(1, D.currentHp >> 1);
  } else if (e === 'OHKO_EFFECT') {
    if (g1Stat(A, 'spd') < g1Stat(D, 'spd')) missed = true; else { dmg = 65535; ohko = true; }
  } else if (key === 'COUNTER') {
    if (A.counterDmg > 0) dmg = A.counterDmg * 2; else missed = true;
  } else {
    crit = g1Rb(rng) < g1CritThreshold(A, key);
    const r = g1Damage(A, D, mv, crit, e === 'EXPLODE_EFFECT');
    dmg = r.dmg; mult = r.mult;
    if (dmg === 0) { missed = true; immune = true; }
    else if (dmg > 1) dmg = Math.floor(dmg * (217 + Math.floor(rng() * 39)) / 255);
  }

  // accuracy (Counter never misses once it has damage)
  if (!missed && key !== 'COUNTER') {
    if (e === 'DREAM_EATER_EFFECT' && D.status !== 'slp') missed = true;
    else if (e !== 'SWIFT_EFFECT') {
      if (D.invuln) missed = true;
      else if (!o.cont || e === 'THRASH_PETAL_DANCE_EFFECT') { if (!g1HitCheck(A, D, mv, rng)) missed = true; }
    }
  }

  if (missed) {
    if (immune) say(`It doesn't affect ${D.name}!`);
    else say(`${A.name}'s attack missed!`);
    if (e === 'TRAPPING_EFFECT') { A.trapping = false; A.trapLeft = 0; }
    if (e === 'JUMP_KICK_EFFECT') { A.currentHp = Math.max(0, A.currentHp - 1); say(`${A.name} kept going and crashed!`); }
    if (e === 'EXPLODE_EFFECT') { A.currentHp = 0; A.status = null; A.seeded = false; }
    return;
  }

  if (ohko) say('One-hit KO!');
  if (crit) say('A critical hit!');
  if (mult > 1) say("It's super effective!");
  else if (mult > 0 && mult < 1) say("It's not very effective...");

  const hits = e === 'TWO_TO_FIVE_ATTACKS_EFFECT' ? 2 + g1RollMulti(rng)
    : (e === 'ATTACK_TWICE_EFFECT' || e === 'TWINEEDLE_EFFECT') ? 2 : 1;
  let total = 0, n = 0;
  for (let i = 0; i < hits; i++) {
    const hadSub = D.sub > 0;
    total += g1Hurt(ctx, A, D, dmg, mv);
    n++;
    if (D.currentHp <= 0 || (hadSub && D.sub === 0)) break;
  }
  if (hits > 1) say(`Hit ${n} time${n > 1 ? 's' : ''}!`);
  say(`(-${total} HP) ${D.name} ${D.currentHp}/${D.maxHp}`);
  if (e === 'TRAPPING_EFFECT') A.trapDmg = dmg;

  if (e === 'DRAIN_HP_EFFECT' || e === 'DREAM_EATER_EFFECT') {
    g1Heal(A, Math.max(1, dmg >> 1));
    say(`Sucked health from ${D.name}!`);
  }
  if (e === 'RECOIL_EFFECT') {
    const rec = Math.max(1, key === 'STRUGGLE' ? dmg >> 1 : dmg >> 2);
    A.currentHp = Math.max(0, A.currentHp - rec);
    say(`${A.name} is hit with recoil! (-${rec})`);
  }
  if (e === 'EXPLODE_EFFECT') { A.currentHp = 0; A.status = null; A.seeded = false; }
  if (e === 'HYPER_BEAM_EFFECT' && D.currentHp > 0) A.recharge = true;
  if (e === 'PAY_DAY_EFFECT') say('Coins scattered everywhere!');

  if (D.currentHp <= 0) return;
  g1SideEffect(ctx, A, D, key, mv);
}

function g1SideEffect(ctx, A, D, key, mv) {
  const say = ctx.say, rng = ctx.rng, e = mv.e;
  if (D.sub > 0) return;
  const noStatus = () => D.status === null;
  if (e === 'POISON_SIDE_EFFECT1' || e === 'POISON_SIDE_EFFECT2' || e === 'TWINEEDLE_EFFECT') {
    if (!noStatus() || D.types.includes('poison')) return;
    if (g1Rb(rng) < (e === 'POISON_SIDE_EFFECT2' ? 103 : 52)) { D.status = 'psn'; say(`${D.name} was poisoned!`); }
  } else if (/^(BURN|FREEZE|PARALYZE)_SIDE_EFFECT[12]$/.test(e)) {
    if (!noStatus()) {
      if (D.status === 'frz' && mv.t === 'fire' && e.startsWith('BURN')) { D.status = null; say(`Fire defrosted ${D.name}!`); }
      return;
    }
    if (D.types.includes(mv.t)) return;
    if (g1Rb(rng) >= (e.endsWith('2') ? 77 : 26)) return;
    if (e.startsWith('BURN')) { D.status = 'brn'; say(`${D.name} was burned!`); }
    else if (e.startsWith('FREEZE')) { D.status = 'frz'; D.recharge = false; say(`${D.name} was frozen solid!`); }
    else { D.status = 'par'; say(`${D.name} is paralyzed! It may not attack!`); }
  } else if (e === 'FLINCH_SIDE_EFFECT1' || e === 'FLINCH_SIDE_EFFECT2') {
    if (g1Rb(rng) < (e === 'FLINCH_SIDE_EFFECT1' ? 26 : 77)) { D.flinch = true; D.recharge = false; }
  } else if (e === 'CONFUSION_SIDE_EFFECT') {
    if (g1Rb(rng) < 25 && D.conf === 0) { D.conf = g1RollConfusion(rng); say(`${D.name} became confused!`); }
  } else {
    const m = /^(ATTACK|DEFENSE|SPEED|SPECIAL)_DOWN_SIDE_EFFECT$/.exec(e);
    if (m && g1Rb(rng) < 85) g1StatChange(ctx, D, G1_STAT_KEYS[m[1]], -1, { silent: true });
  }
}

function g1StatusMove(ctx, A, D, key, mv) {
  const say = ctx.say, rng = ctx.rng, e = mv.e;
  const test = () => {
    if (D.invuln) return false;
    return g1HitCheck(A, D, mv, rng);
  };
  const fail = () => say('But it failed!');

  let m = /^(ATTACK|DEFENSE|SPEED|SPECIAL|ACCURACY|EVASION)_(UP|DOWN)([12])_EFFECT$/.exec(e);
  if (m) {
    const stat = G1_STAT_KEYS[m[1]], amt = Number(m[3]);
    if (m[2] === 'UP') { g1StatChange(ctx, A, stat, amt, {}); return; }
    if (D.sub > 0) { say(`${A.name}'s attack missed!`); return; }
    if (D.mist) { say(`${A.name}'s attack missed!`); return; }
    if (!test()) { say(`${A.name}'s attack missed!`); return; }
    g1StatChange(ctx, D, stat, -amt, {});
    return;
  }

  switch (e) {
    case 'SLEEP_EFFECT': {
      if (D.recharge) { D.recharge = false; }
      else if (D.status === 'slp') { say(`${D.name} is already asleep!`); return; }
      else if (D.status !== null) { say("It didn't affect " + D.name + '!'); return; }
      else if (!test()) { say(`${A.name}'s attack missed!`); return; }
      let n; do { n = g1Rb(rng) & 7; } while (n === 0);
      D.status = 'slp'; D.sleep = n;
      say(`${D.name} fell asleep!`);
      return;
    }
    case 'POISON_EFFECT': {
      if (D.sub > 0 || D.status !== null || D.types.includes('poison')) { say("It didn't affect " + D.name + '!'); return; }
      if (!test()) { say(`${A.name}'s attack missed!`); return; }
      D.status = 'psn';
      if (key === 'TOXIC') { D.badly = true; D.toxic = 0; say(`${D.name}'s badly poisoned!`); } else say(`${D.name} was poisoned!`);
      return;
    }
    case 'PARALYZE_EFFECT': {
      if (D.status !== null) { say("It didn't affect " + D.name + '!'); return; }
      if (mv.t === 'electric' && D.types.includes('ground')) { say(`It doesn't affect ${D.name}!`); return; }
      if (!test()) { say(`${A.name}'s attack missed!`); return; }
      D.status = 'par';
      say(`${D.name}'s paralyzed! It may not attack!`);
      return;
    }
    case 'CONFUSION_EFFECT': {
      if (D.sub > 0 || !test() || D.conf > 0) { fail(); return; }
      D.conf = g1RollConfusion(rng);
      say(`${D.name} became confused!`);
      return;
    }
    case 'HEAL_EFFECT': {
      if (A.currentHp >= A.maxHp) { fail(); return; }
      if (key === 'REST') {
        A.status = 'slp'; A.sleep = 2; A.badly = false;
        g1Heal(A, A.maxHp);
        say(`${A.name} started sleeping!`);
      } else {
        g1Heal(A, A.maxHp >> 1);
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
        M.stages = { atk: 0, def: 0, spd: 0, spc: 0, acc: 0, eva: 0 };
        M.conf = 0; M.disabled = null; M.disabledTurns = 0; M.mist = false; M.focus = false; M.seeded = false;
        M.badly = false; M.toxic = 0; M.reflect = false; M.lscreen = false;
      }
      if (D.status === 'frz' || D.status === 'slp') ctx.skip[ctx.sideOf(D)] = true;
      D.status = null;
      say('All status changes were eliminated!');
      return;
    }
    case 'CONVERSION_EFFECT': A.types = D.types.slice(); say(`Converted type to match ${D.name}'s!`); return;
    case 'TRANSFORM_EFFECT': {
      A.types = D.types.slice();
      A.stats = { hp: A.stats.hp, atk: D.stats.atk, def: D.stats.def, spd: D.stats.spd, spc: D.stats.spc };
      A.stages = { ...D.stages };
      A.moves = D.moves.map((x) => ({ ...x, pp: 5, maxPp: 5 }));
      A.speciesId = D.speciesId; A.spriteId = D.spriteId;
      say(`${A.name} transformed into ${D.name}!`);
      return;
    }
    case 'SUBSTITUTE_EFFECT': {
      if (A.sub > 0) { say(`${A.name} has a SUBSTITUTE!`); return; }
      const cost = A.maxHp >> 2;
      if (A.currentHp - cost < 0) { say('Too weak to make a SUBSTITUTE!'); return; }
      A.currentHp -= cost; A.sub = cost;
      say(`${A.name} made a SUBSTITUTE!`);
      return;
    }
    case 'LEECH_SEED_EFFECT': {
      if (!test() || D.types.includes('grass') || D.seeded) { say(`${D.name} evaded the attack!`); return; }
      D.seeded = true;
      say(`${D.name} was seeded!`);
      return;
    }
    case 'DISABLE_EFFECT': {
      if (D.disabled || !test()) { fail(); return; }
      const cands = D.moves.filter((x) => x.pp > 0);
      if (cands.length === 0) { fail(); return; }
      const pick = cands[Math.floor(rng() * cands.length)];
      D.disabled = pick.k; D.disabledTurns = 1 + (g1Rb(rng) & 7);
      say(`${D.name}'s ${pick.name} was disabled!`);
      return;
    }
    case 'MIMIC_EFFECT': {
      if (!test() || D.moves.length === 0) { fail(); return; }
      const pick = D.moves[Math.floor(rng() * D.moves.length)];
      const idx = A.moves.findIndex((x) => x.k === 'MIMIC');
      if (idx >= 0) A.moves[idx] = { ...g1MoveEntry(pick.k), pp: 5, maxPp: pick.maxPp };
      say(`${A.name} learned ${pick.name}!`);
      return;
    }
    case 'BIDE_EFFECT': A.bide = { turns: 2 + (g1Rb(rng) & 1), accum: 0 }; say(`${A.name} is storing energy!`); return;
    case 'SPLASH_EFFECT': say('No effect!'); return;
    case 'SWITCH_AND_TELEPORT_EFFECT': fail(); return;
    default: say('But nothing happened!');
  }
}

// ---------- one action (status gates + move) ----------
function g1Act(ctx, A, D, sel) {
  const say = ctx.say, rng = ctx.rng;
  if (A.currentHp <= 0 || D.currentHp <= 0 || !sel) return;

  if (A.status === 'slp') {
    A.lastMove = null; A.sleep--;
    if (A.sleep > 0) say(`${A.name} is fast asleep.`);
    else { A.status = null; say(`${A.name} woke up!`); }
    return;
  }
  if (A.status === 'frz') { A.lastMove = null; say(`${A.name} is frozen solid!`); return; }
  if (D.trapping) { say(`${A.name} can't move!`); return; }
  if (A.flinch) { A.flinch = false; say(`${A.name} flinched!`); return; }
  if (A.recharge) { A.recharge = false; say(`${A.name} must recharge!`); return; }
  if (A.disabledTurns > 0) {
    A.disabledTurns--;
    if (A.disabledTurns === 0) { A.disabled = null; say(`${A.name} is no longer disabled!`); }
  }
  if (A.conf > 0) {
    A.conf--;
    if (A.conf === 0) say(`${A.name} is no longer confused!`);
    else {
      say(`${A.name} is confused!`);
      if (g1Rb(rng) >= 128) {
        const dmg = g1RawDamage(A.level, 40, g1Stat(A, 'atk'), g1Stat(A, 'def'));
        A.currentHp = Math.max(0, A.currentHp - dmg);
        say(`It hurt itself in its confusion! (-${dmg})`);
        g1ClearVolatile(A);
        return;
      }
    }
  }
  if (A.disabled && sel.key === A.disabled) { say(`${A.name}'s move is disabled!`); return; }
  if (A.status === 'par' && g1Rb(rng) < 63) {
    say(`${A.name} is fully paralyzed!`);
    g1ClearVolatile(A);
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
    const dealt = g1Hurt(ctx, A, D, dmg, null);
    say(`(-${dealt} HP) ${D.name} ${D.currentHp}/${D.maxHp}`);
    return;
  }
  // Thrash / Petal Dance continues
  if (A.thrash > 0) {
    A.thrash--;
    say(`${A.name}'s thrashing about!`);
    if (A.thrash === 0) A.conf = g1RollConfusion(rng);
    return g1Exec(ctx, A, D, A.thrashKey, { noPP: true, noText: true, cont: true, noRecord: true });
  }
  // Wrap/Bind/Fire Spin/Clamp continues
  if (A.trapping) {
    say(`${A.name}'s attack continues!`);
    A.trapLeft--;
    const dealt = g1Hurt(ctx, A, D, A.trapDmg, null);
    say(`(-${dealt} HP) ${D.name} ${D.currentHp}/${D.maxHp}`);
    if (A.trapLeft <= 0) A.trapping = false;
    return;
  }
  if (A.rage) return g1Exec(ctx, A, D, 'RAGE', { cont: true });
  if (A.charging) {
    const k = A.charging;
    A.charging = null; A.invuln = false;
    return g1Exec(ctx, A, D, k, { charged: true });
  }
  return g1Exec(ctx, A, D, sel.key, {});
}

// ---------- end of action residual damage ----------
function g1Residual(ctx, A, D) {
  if (A.currentHp <= 0) return;
  const base = Math.max(1, A.maxHp >> 4);
  if (A.status === 'psn' || A.status === 'brn') {
    let dmg = base;
    if (A.badly && A.status === 'psn') { A.toxic++; dmg = base * A.toxic; }
    A.currentHp = Math.max(0, A.currentHp - dmg);
    ctx.say(`${A.name} is hurt by ${A.status === 'brn' ? 'its burn' : 'poison'}! (-${dmg})`);
  }
  if (A.currentHp > 0 && A.seeded) {
    const dmg = A.badly && A.toxic > 0 ? base * A.toxic : base;
    const dealt = Math.min(dmg, A.currentHp);
    A.currentHp -= dealt;
    if (D.currentHp > 0) g1Heal(D, dealt);
    ctx.say(`LEECH SEED saps ${A.name}! (-${dealt})`);
  }
}

// ---------- rounds ----------
function g1Needs(B, side) {
  const m = B[side + 'Mon'], o = B[(side === 'p1' ? 'p2' : 'p1') + 'Mon'];
  if (m.currentHp <= 0) return false;
  if (m.charging || m.thrash > 0 || m.trapping || m.bide || m.rage || m.recharge) return false;
  if (m.status === 'slp' || m.status === 'frz' || o.trapping) return false;
  return true;
}
function g1Usable(m) {
  return m.moves.map((mv, i) => ({ i, ok: mv.pp > 0 && mv.k !== m.disabled })).filter((x) => x.ok).map((x) => x.i);
}
function g1NeedsPick(B, side) {
  if (!g1Needs(B, side)) return false;
  return g1Usable(B[side + 'Mon']).length > 0; // none usable -> automatic Struggle
}

function g1StartRound(B) {
  B.round = (B.round || 0) + 1;
  B.picks = { p1: null, p2: null };
  B.pickState = { p1: g1NeedsPick(B, 'p1') ? 'wait' : 'auto', p2: g1NeedsPick(B, 'p2') ? 'wait' : 'auto' };
  B.p1Mon.flinch = false; B.p2Mon.flinch = false;
  B.p1Mon.counterDmg = 0; B.p2Mon.counterDmg = 0;
  B.roundStartedAt = Date.now();
}

function g1Ready(B) { return B.pickState.p1 !== 'wait' && B.pickState.p2 !== 'wait'; }

function g1Pick(B, side, idx) {
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

function g1Selection(B, side) {
  const m = B[side + 'Mon'];
  if (m.bide) return { key: 'BIDE', cont: true };
  if (m.thrash > 0) return { key: m.thrashKey, cont: true };
  if (m.trapping) return { key: m.trapKey, cont: true };
  if (m.rage) return { key: 'RAGE', cont: true };
  if (m.charging) return { key: m.charging, cont: true };
  const st = B.pickState[side];
  if (st === 'timeout') return null;
  if (st === 'done') return { key: m.moves[B.picks[side]].k };
  // 'auto': nothing to choose (asleep, recharging, trapped...) or no PP left -> Struggle
  const usable = g1Usable(m);
  if (usable.length === 0 && g1Needs(B, side)) return { key: 'STRUGGLE' };
  return { key: m.moves[0] ? m.moves[0].k : 'STRUGGLE', auto: true };
}

function g1Priority(sel) {
  if (!sel) return 0;
  if (sel.key === 'QUICK_ATTACK') return 1;
  if (sel.key === 'COUNTER') return -1;
  return 0;
}

// Resolves one full round. Returns the battle log text; sets B.ended when someone faints.
function g1ResolveRound(B, rng = Math.random) {
  const log = [];
  const ctx = {
    B, rng, log, skip: { p1: false, p2: false },
    say: (t) => log.push(t),
    sideOf: (M) => (M === B.p1Mon ? 'p1' : 'p2')
  };
  const sel = { p1: g1Selection(B, 'p1'), p2: g1Selection(B, 'p2') };
  for (const s of ['p1', 'p2']) {
    if (B.pickState[s] === 'timeout' && !(B[s + 'Mon'].charging || B[s + 'Mon'].thrash || B[s + 'Mon'].trapping || B[s + 'Mon'].bide || B[s + 'Mon'].rage)) {
      log.push(`⏰ @${B[s]}, time has passed! No move this round.`);
    }
  }

  // who goes first: priority, then speed, then coin flip
  let order = ['p1', 'p2'];
  const pr1 = g1Priority(sel.p1), pr2 = g1Priority(sel.p2);
  if (pr1 !== pr2) order = pr1 > pr2 ? ['p1', 'p2'] : ['p2', 'p1'];
  else {
    const s1 = g1Stat(B.p1Mon, 'spd'), s2 = g1Stat(B.p2Mon, 'spd');
    if (s1 !== s2) order = s1 > s2 ? ['p1', 'p2'] : ['p2', 'p1'];
    else if (rng() < 0.5) order = ['p2', 'p1'];
  }

  for (const side of order) {
    const A = B[side + 'Mon'], D = B[(side === 'p1' ? 'p2' : 'p1') + 'Mon'];
    if (A.currentHp <= 0 || D.currentHp <= 0) break;
    if (ctx.skip[side]) { ctx.skip[side] = false; continue; }
    g1Act(ctx, A, D, sel[side]);
    g1Residual(ctx, A, D);
    if (A.currentHp <= 0 || D.currentHp <= 0) break;
  }

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


// --- POKÉMON CREATION / EVOLUTION (Gen 1 data, no external API needed) ---
async function generatePokemon(idOrName, forceShiny = null) {
  return g1CreateMon(Number(idOrName), forceShiny);
}

// Pokémon saved before the Gen 1 update are rebuilt with real Gen 1 stats and moves (species, shiny status and uid are kept)
function upgradeUser(db, name) {
  const u = db.users[name];
  if (!u || !Array.isArray(u.inventory)) return false;
  let changed = false;
  u.inventory = u.inventory.map((p) => {
    const fixed = g1EnsureMon(p);
    if (fixed !== p) changed = true;
    return fixed;
  });
  return changed;
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
    const species = GEN1.mons[speciesId];
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

    const evolvedMon = g1CreateMon(nextId, isShinyGroup);
    db.users[user].inventory.push(evolvedMon);
    if (!db.users[user].pokedex.includes(evolvedMon.id)) db.users[user].pokedex.push(evolvedMon.id);
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
const BATTLE_RULES = `📜 Gen 1 rules: each round both trainers pick !move <1-4> within ${MOVE_LIMIT_SECS}s (no pick = no attack). Faster Pokémon moves first. Battle max 5 min.`;

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
  while (!battle.ended && g1Ready(battle) && guard++ < 25) {
    g1ResolveRound(battle);
    lines.push(...(battle.lastLines || []));
    battle.seq = (battle.seq || 0) + 1;
    if (!battle.ended) g1StartRound(battle);
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
    return `💥 ${trimChat(text, 330)} 🏆 @${winner} wins! 🎙️ ${pickLine(["And that's the match! What a finish!", `${loserMon.name} gave it everything, but it's over!`, 'Incredible battle, chat!'])}`;
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
  if (!battle.pickState) {
    delete db.activeBattles[key];
    return `⚠️ The battle between @${battle.p1} and @${battle.p2} was canceled because the bot was updated to Gen 1 rules. Start a new one with !battle!`;
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
    return `⏰ Time's up! The 5 minute limit is over (${p1Txt} vs ${p2Txt}). 🏆 @${winner} wins on remaining HP!`;
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

async function triggerSpawn(db) {
  const randomId = Math.floor(Math.random() * MAX_POKEMON_ID) + 1;
  const mon = await generatePokemon(randomId);
  const now = Date.now();
  db.activeSpawn = { ...mon, caughtBy: [], attempts: {}, spawnedAt: now, expiresAt: now + CATCH_WINDOW_MS };
  await saveDB(db);

  const shinyTag = mon.isShiny ? '✨SHINY ' : '';
  return `🌿 A wild ${shinyTag}${mon.name} (${mon.types.join('/').toUpperCase()}) appeared! Type !catch within ${CATCH_WINDOW_MS / 1000} seconds to throw a Pokéball! (${MAX_CATCH_TRIES} tries each)`;
}

// Time until the next spawn (spawns come from the cron job every SPAWN_INTERVAL_MINUTES)
function nextSpawnText(spawn) {
  const msLeft = spawn.spawnedAt + SPAWN_INTERVAL_MINUTES * 60 * 1000 - Date.now();
  if (msLeft <= 0) return 'a few seconds (any moment now)';
  if (msLeft >= 60000) return `${Math.floor(msLeft / 60000)}m ${Math.floor((msLeft % 60000) / 1000)}s`;
  return `${Math.ceil(msLeft / 1000)}s`;
}

async function processCommand(db, rawUser, rawCmd, rawArgs, isMod = false) {
  const user = (rawUser || '').toLowerCase().replace('@', '');
  const cmd = (rawCmd || '').toLowerCase();
  const args = (rawArgs || '').trim().split(/\s+/).filter(Boolean);

  if (!user) return null;
  if (!db.users[user]) db.users[user] = { inventory: [], totalCaught: 0, pokedex: [] };
  if (db.users[user].totalCaught === undefined) db.users[user].totalCaught = db.users[user].inventory.length;
  if (!db.users[user].pokedex) db.users[user].pokedex = [...new Set(db.users[user].inventory.map(p => p.id))];
  if (upgradeUser(db, user)) await saveDB(db); // old Pokémon get real Gen 1 stats and moves

  if (cmd === 'spawn') {
    if (!isMod) return `@${user} Only moderators can use !spawn.`;
    return await triggerSpawn(db);
  }

  if (cmd === 'catch') {
    const spawn = db.activeSpawn;
    if (!spawn) return `@${user} No wild Pokémon right now!`;
    if (Date.now() > spawnExpiresAt(spawn)) {
      return `@${user} Too late to catch the wild ${spawn.name}, it already fled! Next spawn in ${nextSpawnText(spawn)}!`;
    }
    if (spawn.caughtBy.includes(user)) return `@${user} You already caught this ${spawn.name}!`;
    if (db.users[user].inventory.length >= MAX_INVENTORY) return `@${user} Party full (${MAX_INVENTORY}/${MAX_INVENTORY})! Use !release <1-${MAX_INVENTORY}>.`;

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
    let reply = `🎉 @${user} caught ${shinyTag}${caughtMon.name} Lv${caughtMon.level} [${caughtMon.types.join('/')}]! (${db.users[user].inventory.length}/${MAX_INVENTORY})`;
    const evoMsg = await checkEvolution(db, user);
    if (evoMsg) reply += ` | ${evoMsg}`;
    return reply;
  }

  if (cmd === 'spawncheck' || cmd === 'wild') {
    const spawn = db.activeSpawn;
    if (!spawn) return `@${user} No wild Pokémon right now!`;
    if (Date.now() > spawnExpiresAt(spawn)) return `@${user} No wild Pokémon right now! Next spawn in ${nextSpawnText(spawn)}!`;
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
    const tip = '💡 Have 3 of the same Pokémon and they evolve (if they have an evolution)!';
    if (inv.length === 0) return `@${user} Your party is empty! Use !catch when a wild Pokémon appears. ${tip}`;
    const PER_PAGE = 15;
    const pages = Math.ceil(inv.length / PER_PAGE);
    let page = parseInt(args[0]) || 1;
    page = Math.max(1, Math.min(pages, page));
    const from = (page - 1) * PER_PAGE;
    const list = inv.slice(from, from + PER_PAGE).map((p, i) => `[${from + i + 1}] ${p.isShiny ? '✨' : ''}${p.name}`).join(' | ');
    const pageTxt = pages > 1 ? ` Page ${page}/${pages} (type !party ${page % pages + 1} for more)` : '';
    return `@${user}'s Party (${inv.length}/${MAX_INVENTORY})${pageTxt}: ${list} | ${tip}`;
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
    return `@${user} #${slot + 1} ${shinyTag}${mon.name} Lv${mon.level} [${mon.types.join('/')}] | HP:${st.hp} ATK:${st.atk} DEF:${st.def} SPD:${st.spd} SPC:${st.spc} | Moves: ${movesStr}`;
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
        existing.p2Mon = g1BattleMon(g1EnsureMon(myMon));
        existing.startedAt = now;
        existing.seq = 0;
        existing.roundLines = [];
        g1StartRound(existing);
        existing.lastLog = `Round 1: choose your moves!`;
        await saveDB(db);
        return `🔥 Battle started! ${existing.p1Mon.name} (@${existing.p1}) vs ${existing.p2Mon.name} (@${existing.p2}), both Lv${G1_LEVEL}! ${BATTLE_RULES} Round 1: both trainers use !move <1-4> now!`;
      }
      if (existing.p1 === user) return `@${user} You already challenged @${existing.p2}! Wait for them to accept, or use !forfeit to cancel your challenge.`;
      return `@${user} @${existing.p1} already challenged you! Accept with !battle @${existing.p1} <slot>.`;
    }
    if (findBattleKey(db, opponent)) return `@${user} @${opponent} is already busy with another battle or challenge. Try again later!`;

    const battleKey = [user, opponent].sort().join('_vs_');
    db.activeBattles[battleKey] = {
      p1: user,
      p2: opponent,
      p1Mon: g1BattleMon(g1EnsureMon(myMon)),
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
    if (!battle || !battle.p2Mon) return `@${user} Not in a battle.`;

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

    const picked = g1Pick(battle, side, moveIdx);
    if (!picked.ok) return `@${user} ${picked.msg}`;

    if (!g1Ready(battle)) {
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
    return wasAccepted ? `🏳️ @${user} forfeited! 🏆 @${opponent} wins!` : `🏳️ @${user} canceled the challenge.`;
  }

  if (cmd === 'help' || cmd === 'pokemon') {
    return `🎮 Commands: !catch (catch the wild Pokémon) | !spawncheck (see the current spawn) | !party [page] (your Pokémon) | !info <slot> (stats & moves) | !release <slot> | !pokedex | !leaderboard (top catchers & battle winners) | !trade @user <slot> | !accept <slot> | !battle @user <slot> (challenge) | !move <1-4> (battle) | !forfeit | !help`;
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
      var expires = lastSpawn.expiresAt || (lastSpawn.spawnedAt + 60000);
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
