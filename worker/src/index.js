const GAME_ORIGIN = 'https://ordekaamb.github.io';
const TOKEN_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const TIMER_REWARD = 5;
const TIMER_WAIT_MS = 5 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const LEADERBOARD_START = Date.parse('2026-11-07T00:00:00+03:00');
const CODE_REWARDS = Object.freeze({
  OYUNPIYASADA: 1000,
  BUGLARICINOZURDILERIM: 1000,
  EFSANEGUNCELLEME: 500,
});
const PLAYER_RATINGS = Object.freeze({ayaz:96,atlas:94,parhan:97,ozgur:69,alperen:68,eymenkl:60,kuzey:70,dorukhan:75,muhammed:69,vasim:64,cad:70,cihangir:78,emir:68,aliumut:79,radan:70,eymenst:75,tahir:50,sait:59,zeba:67});
const PLAYER_POSITIONS = Object.freeze({ayaz:'GF',atlas:'STP',parhan:'OOS',ozgur:'OOS',alperen:'STP',eymenkl:'KL',kuzey:'SLB',dorukhan:'ST',muhammed:'SLB',vasim:'STP',cad:'OS',cihangir:'KL',emir:'STP',aliumut:'ST',radan:'STP',eymenst:'ST',tahir:'KL',sait:'STP',zeba:'OS'});
const PLAYER_NATIONS = Object.freeze({ayaz:'TR',atlas:'TR',parhan:'IR',ozgur:'TR',alperen:'TR',eymenkl:'TR',kuzey:'TR',dorukhan:'TR',muhammed:'SY',vasim:'SY',cad:'SY',cihangir:'TR',emir:'TR',aliumut:'TR',radan:'IR',eymenst:'TR',tahir:'TR',sait:'TR',zeba:'RU'});
// Kondisyonlar sunucunun kayıtlı profilinde tutulur. Bu sürüm dağıtımı bir
// defaya mahsus uygulanır; istemci bu değerleri değiştiremez.
const CONDITION_PRESET_V6 = Object.freeze({aliumut:'B',kuzey:'A',cad:'B',ozgur:'A',muhammed:'B',zeba:'D',emir:'B',vasim:'B',sait:'C',tahir:'D',eymenkl:'B'});
const CONDITION_PRESET_V7 = Object.freeze({alperen:'B'});
const FORMATION_SLOTS = Object.freeze({'1-2-1':['KL','STP','OS','OS','ST'],'2-1-1':['KL','STP','SLB','OOS','ST'],'1-1-2':['KL','STP','OS','GF','ST'],'1-3':['KL','STP','ST','GF','ST'],'4-0-0':['KL','SLB','STP','STP','SGB']});
const PACK_POOL = Object.entries(PLAYER_RATINGS).map(([id,r])=>({id,r,w:['ayaz','atlas','parhan'].includes(id)?({ayaz:3,atlas:4,parhan:2}[id]):100*Math.exp(-.09*(r-50))}));
// Tekrar kart iadesi yarıya iner; küsurat oyuncu lehine en yakın tam sayıya yuvarlanır.
const duplicateRefund = rating => Math.round((rating>=80?60:rating>=70?50:rating>=60?25:10)*.5);
const STARTER_IDS = ['eymenkl','sait','zeba','muhammed','eymenst'];
const BENCH_IDS = ['tahir','vasim','ozgur'];
const SECURE_TASKS = Object.freeze({matches:{text:'20 kere maç yap',goal:20,reward:100},packs:{text:'10 kere paket aç',goal:10,reward:200},squad80:{text:'Kadronun gücü 80’i geçsin',goal:1,reward:100}});

let certificateCache = { expiresAt: 0, values: {} };
let serviceTokenCache = { expiresAt: 0, value: '' };

function cors(request) {
  const origin = request.headers.get('Origin');
  return {
    'Access-Control-Allow-Origin': origin === GAME_ORIGIN ? origin : GAME_ORIGIN,
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Vary': 'Origin',
  };
}

function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(request), 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = atob(padded);
  return Uint8Array.from(raw, char => char.charCodeAt(0));
}

function decodePart(value) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value)));
}

function pemToBytes(pem) {
  const body = pem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
  return base64UrlToBytes(body.replace(/\+/g, '-').replace(/\//g, '_'));
}

function derNode(bytes, start) {
  let length = bytes[start + 1];
  let cursor = start + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    length = 0;
    for (let i = 0; i < count; i += 1) length = (length << 8) | bytes[cursor + i];
    cursor += count;
  }
  return { tag: bytes[start], start, valueStart: cursor, end: cursor + length };
}

// Firebase anahtarları X.509 sertifikası olarak gelir. Web Crypto ise SPKI ister.
function certificateToSpki(pem) {
  const bytes = pemToBytes(pem);
  const certificate = derNode(bytes, 0);
  const tbs = derNode(bytes, certificate.valueStart);
  const fields = [];
  for (let cursor = tbs.valueStart; cursor < tbs.end;) {
    const field = derNode(bytes, cursor);
    fields.push(field);
    cursor = field.end;
  }
  const spki = fields[fields[0]?.tag === 0xa0 ? 6 : 5];
  if (!spki) throw new Error('Firebase sertifikası okunamadı.');
  return bytes.slice(spki.start, spki.end).buffer;
}

async function getCertificates() {
  if (certificateCache.expiresAt > Date.now()) return certificateCache.values;
  const response = await fetch(TOKEN_CERTS_URL);
  if (!response.ok) throw new Error('Firebase doğrulama sertifikaları alınamadı.');
  const cacheControl = response.headers.get('Cache-Control') || '';
  const maxAge = Number((cacheControl.match(/max-age=(\d+)/) || [])[1] || 3600);
  const values = await response.json();
  certificateCache = { values, expiresAt: Date.now() + maxAge * 1000 };
  return values;
}

async function requireFirebaseUser(request, env) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Google oturumu gerekli.');

  const header = decodePart(parts[0]);
  const claims = decodePart(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (header.alg !== 'RS256' || !header.kid || !claims.sub || claims.sub.length > 128
    || claims.aud !== env.FIREBASE_PROJECT_ID
    || claims.iss !== `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`
    || !Number.isFinite(claims.exp) || claims.exp <= now) {
    throw new Error('Google oturumu doğrulanamadı.');
  }

  const certificate = (await getCertificates())[header.kid];
  if (!certificate) throw new Error('Oturum anahtarı güncel değil. Tekrar giriş yap.');
  const key = await crypto.subtle.importKey(
    'spki', certificateToSpki(certificate), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'],
  );
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, base64UrlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw new Error('Google oturumu doğrulanamadı.');
  return { uid: claims.sub, email: String(claims.email || '').toLowerCase() };
}
function requireAdmin(user) {
  // Yönetici yetkisi yalnız imzalı Google kimliğindeki e-posta üzerinden verilir.
  if (user.email !== 'atlasd907@gmail.com') throw new Error('Yönetici yetkisi gerekli.');
}

function toBase64Url(bytes) { let s=''; for(const b of bytes)s+=String.fromCharCode(b); return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''); }
function privateKeyBytes(pem) { return base64UrlToBytes(pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g,'').replace(/\+/g,'-').replace(/\//g,'_')); }
async function serviceAccessToken(env) {
  if(serviceTokenCache.expiresAt>Date.now())return serviceTokenCache.value;
  if(!env.FIREBASE_SERVICE_ACCOUNT_JSON)throw new Error('Güvenli profil aktarımı henüz ayarlanmadı.');
  const sa=JSON.parse(env.FIREBASE_SERVICE_ACCOUNT_JSON),now=Math.floor(Date.now()/1000),header=toBase64Url(new TextEncoder().encode(JSON.stringify({alg:'RS256',typ:'JWT'}))),body=toBase64Url(new TextEncoder().encode(JSON.stringify({iss:sa.client_email,scope:'https://www.googleapis.com/auth/datastore',aud:'https://oauth2.googleapis.com/token',iat:now,exp:now+3600})));
  const key=await crypto.subtle.importKey('pkcs8',privateKeyBytes(sa.private_key),{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['sign']);
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(`${header}.${body}`));
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:`${header}.${body}.${toBase64Url(new Uint8Array(signature))}`})});
  if(!response.ok)throw new Error('Firebase servis hesabı doğrulanamadı.');const data=await response.json();serviceTokenCache={value:data.access_token,expiresAt:Date.now()+Math.max(60000,(data.expires_in-60)*1000)};return data.access_token;
}
function firestoreValue(v){if('stringValue'in v)return v.stringValue;if('integerValue'in v)return Number(v.integerValue);if('doubleValue'in v)return v.doubleValue;if('booleanValue'in v)return v.booleanValue;if('nullValue'in v)return null;if('mapValue'in v){const out={};for(const[k,x]of Object.entries(v.mapValue.fields||{}))out[k]=firestoreValue(x);return out}if('arrayValue'in v)return(v.arrayValue.values||[]).map(firestoreValue);return null}
async function importLegacyProfile(env,uid){const token=await serviceAccessToken(env),url=`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/afootball_profiles/${encodeURIComponent(uid)}`,response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});if(response.status===404)return null;if(!response.ok)throw new Error('Eski profil okunamadı.');const doc=await response.json(),state=doc.fields?.state?firestoreValue(doc.fields.state):firestoreValue({mapValue:{fields:doc.fields||{}}});return state&&typeof state==='object'?state:null;}
async function listLegacyProfiles(env){const token=await serviceAccessToken(env),url=`https://firestore.googleapis.com/v1/projects/${env.FIREBASE_PROJECT_ID}/databases/(default)/documents/afootball_profiles?pageSize=300`,response=await fetch(url,{headers:{Authorization:`Bearer ${token}`}});if(!response.ok)throw new Error('Eski profil listesi okunamadı.');const payload=await response.json();return{truncated:!!payload.nextPageToken,items:(payload.documents||[]).map(doc=>{const uid=String(doc.name||'').split('/').pop(),state=doc.fields?.state?firestoreValue(doc.fields.state):firestoreValue({mapValue:{fields:doc.fields||{}}});return{uid,teamName:String(state?.teamName||'İsimsiz takım').slice(0,15)}})}}

async function ensureTables(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS player_wallets (
      uid TEXT PRIMARY KEY,
      coins INTEGER NOT NULL DEFAULT 0 CHECK (coins >= 0),
      next_reward_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS used_codes (
      uid TEXT NOT NULL,
      code TEXT NOT NULL,
      used_at INTEGER NOT NULL,
      PRIMARY KEY (uid, code)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS secure_code_redemptions (
      uid TEXT NOT NULL,
      code TEXT NOT NULL,
      used_at INTEGER NOT NULL,
      PRIMARY KEY (uid, code)
    )`),
    // Oyun profili Firebase'de değil D1'de tutulur. Böylece doğrudan Firestore
    // yazımıyla kadro, süre ve takım gücü değiştirilemez.
    db.prepare(`CREATE TABLE IF NOT EXISTS player_profiles (
      uid TEXT PRIMARY KEY,
      team_name TEXT NOT NULL DEFAULT '',
      state_json TEXT NOT NULL,
      team_power INTEGER NOT NULL DEFAULT 0,
      migrated_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS player_presence (
      uid TEXT PRIMARY KEY,
      last_heartbeat_at INTEGER NOT NULL,
      play_seconds INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS weekly_playtime (
      week_start INTEGER NOT NULL,
      uid TEXT NOT NULL,
      play_seconds INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (week_start, uid)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS weekly_awards (
      week_start INTEGER NOT NULL,
      category TEXT NOT NULL,
      uid TEXT NOT NULL,
      amount INTEGER NOT NULL,
      awarded_at INTEGER NOT NULL,
      PRIMARY KEY (week_start, category)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pack_openings (
      id TEXT PRIMARY KEY,
      uid TEXT NOT NULL,
      count INTEGER NOT NULL,
      cost INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS match_sessions (
      id TEXT PRIMARY KEY, uid TEXT NOT NULL, score_a INTEGER NOT NULL, score_b INTEGER NOT NULL,
      reward INTEGER NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS daily_task_claims (
      uid TEXT NOT NULL, day_key TEXT NOT NULL, task_id TEXT NOT NULL, claimed_at INTEGER NOT NULL,
      PRIMARY KEY (uid, day_key, task_id)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS secure_auctions (
      id TEXT PRIMARY KEY, seller_uid TEXT NOT NULL, player_id TEXT NOT NULL, start_price INTEGER NOT NULL,
      buy_now INTEGER NOT NULL, high_bid INTEGER NOT NULL DEFAULT 0, high_bidder_uid TEXT,
      expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS duels (
      code TEXT PRIMARY KEY, host_uid TEXT NOT NULL, guest_uid TEXT, status TEXT NOT NULL,
      host_score INTEGER NOT NULL DEFAULT 0, guest_score INTEGER NOT NULL DEFAULT 0,
      attack TEXT NOT NULL DEFAULT 'host', minute INTEGER NOT NULL DEFAULT 1,
      host_pick TEXT, guest_pick TEXT, winner_uid TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS duel_rewards (
      code TEXT NOT NULL, uid TEXT NOT NULL, awarded_at INTEGER NOT NULL, PRIMARY KEY(code,uid)
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS secure_leagues (
      code TEXT PRIMARY KEY, owner_uid TEXT NOT NULL, status TEXT NOT NULL, members_json TEXT NOT NULL,
      results_json TEXT NOT NULL DEFAULT '[]', ends_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    )`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS auction_create_guard BEFORE INSERT ON secure_auctions BEGIN
      SELECT RAISE(ABORT,'Oyuncu envanterde yok') WHERE COALESCE(json_extract((SELECT state_json FROM player_profiles WHERE uid=NEW.seller_uid),'$.owned.'||NEW.player_id),0)<1;
      SELECT RAISE(ABORT,'Kadrodaki son kart satılamaz') WHERE COALESCE(json_extract((SELECT state_json FROM player_profiles WHERE uid=NEW.seller_uid),'$.owned.'||NEW.player_id),0)=1
        AND (EXISTS(SELECT 1 FROM json_each((SELECT state_json FROM player_profiles WHERE uid=NEW.seller_uid),'$.lineup') WHERE value=NEW.player_id)
        OR EXISTS(SELECT 1 FROM json_each((SELECT state_json FROM player_profiles WHERE uid=NEW.seller_uid),'$.bench') WHERE value=NEW.player_id));
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS auction_create_debit AFTER INSERT ON secure_auctions BEGIN
      UPDATE player_profiles SET state_json=json_set(state_json,'$.owned.'||NEW.player_id,COALESCE(json_extract(state_json,'$.owned.'||NEW.player_id),0)-1),updated_at=NEW.created_at WHERE uid=NEW.seller_uid;
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS auction_bid_guard BEFORE UPDATE OF high_bid ON secure_auctions WHEN NEW.high_bid>OLD.high_bid BEGIN
      SELECT RAISE(ABORT,'İhale sona erdi') WHERE OLD.status!='active' OR OLD.expires_at<=CAST(strftime('%s','now') AS INTEGER)*1000;
      SELECT RAISE(ABORT,'Teklif çok düşük') WHERE NEW.high_bid<MAX(OLD.start_price,OLD.high_bid+1) OR NEW.high_bid>OLD.buy_now;
      SELECT RAISE(ABORT,'Yetersiz coin') WHERE COALESCE((SELECT coins FROM player_wallets WHERE uid=NEW.high_bidder_uid),0)<NEW.high_bid-CASE WHEN NEW.high_bidder_uid=OLD.high_bidder_uid THEN OLD.high_bid ELSE 0 END;
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS auction_bid_money AFTER UPDATE OF high_bid ON secure_auctions WHEN NEW.high_bid>OLD.high_bid BEGIN
      UPDATE player_wallets SET coins=coins+OLD.high_bid WHERE uid=OLD.high_bidder_uid AND OLD.high_bidder_uid!=NEW.high_bidder_uid;
      UPDATE player_wallets SET coins=coins-(NEW.high_bid-CASE WHEN NEW.high_bidder_uid=OLD.high_bidder_uid THEN OLD.high_bid ELSE 0 END) WHERE uid=NEW.high_bidder_uid;
    END`),
    db.prepare(`CREATE TRIGGER IF NOT EXISTS auction_settle AFTER UPDATE OF status ON secure_auctions WHEN OLD.status='active' AND NEW.status IN ('sold','expired') BEGIN
      UPDATE player_wallets SET coins=coins+NEW.high_bid WHERE uid=NEW.seller_uid AND NEW.status='sold';
      UPDATE player_profiles SET state_json=json_set(state_json,'$.owned.'||NEW.player_id,COALESCE(json_extract(state_json,'$.owned.'||NEW.player_id),0)+1) WHERE uid=CASE WHEN NEW.status='sold' THEN NEW.high_bidder_uid ELSE NEW.seller_uid END;
    END`),
  ]);
  try { await db.prepare('ALTER TABLE duels ADD COLUMN league_code TEXT').run(); } catch (_) {}
}

function weekStart(now = Date.now()) {
  if (now < LEADERBOARD_START) return null;
  return LEADERBOARD_START + Math.floor((now - LEADERBOARD_START) / WEEK_MS) * WEEK_MS;
}

function cleanState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Geçersiz oyun kaydı.');
  // Coin yalnızca cüzdandan gelir; istemcinin gönderdiği coin ve yönetici bayrakları saklanmaz.
  const state = JSON.parse(JSON.stringify(value));
  delete state.coins; delete state.adminActive; delete state.lastSaved;
  const encoded = JSON.stringify(state);
  if (encoded.length > 110000) throw new Error('Oyun kaydı fazla büyük.');
  return { state, encoded };
}

function cryptoPick(pool) {
  const total = pool.reduce((sum, p) => sum + p.w, 0);
  const bytes = new Uint32Array(1); crypto.getRandomValues(bytes);
  let roll = bytes[0] / 0x100000000 * total;
  for (const p of pool) { roll -= p.w; if (roll <= 0) return p; }
  return pool[pool.length - 1];
}
function applyConditionPresetV6(state) {
  if (state.conditionPresetV6) return false;
  state.condition = { ...(state.condition && typeof state.condition === 'object' ? state.condition : {}), ...CONDITION_PRESET_V6 };
  state.conditionPresetV6 = true;
  return true;
}
function applyConditionPresetV7(state) {
  if (state.conditionPresetV7) return false;
  state.condition = { ...(state.condition && typeof state.condition === 'object' ? state.condition : {}), ...CONDITION_PRESET_V7 };
  state.conditionPresetV7 = true;
  return true;
}
function initialState() { return { owned:Object.fromEntries([...STARTER_IDS,...BENCH_IDS].map(id=>[id,1])), lineup:[...STARTER_IDS], bench:[...BENCH_IDS], formation:'1-2-1', condition:{...CONDITION_PRESET_V6,...CONDITION_PRESET_V7},conditionPresetV6:true,conditionPresetV7:true, teamName:'', w:0,l:0,taskStats:{matches:0,packs:0,reports:0,onlineWins:0,liveChampions:0},dailyTasks:null,injuries:{},redCards:{},subRule:'flex',captain:null,freeKickTaker:null,penaltyTaker:null }; }
function quickSellValue(id) { const r=PLAYER_RATINGS[id]||0; return Math.floor((r>=90?1000:r>=80?200:100)*.5); }
function canSecurelySell(state,id) {
  const owned=state.owned&&typeof state.owned==='object'?state.owned:{};
  if(Number(owned[id]||0)<1)return false;
  // Kadroda kullanılan son kopya satılamaz; 5 saha + 3 yedek güvenliği korunur.
  if(Number(owned[id])===1&&((state.lineup||[]).includes(id)||(state.bench||[]).includes(id)))return false;
  return Object.entries(owned).filter(([playerId,count])=>Number(count)>0&&(playerId!==id||Number(count)>1)).length>=8;
}
function canApplyServerAbsence(state, id) {
  const owned=state.owned&&typeof state.owned==='object'?state.owned:{};
  const injuries=state.injuries&&typeof state.injuries==='object'?state.injuries:{};
  const redCards=state.redCards&&typeof state.redCards==='object'?state.redCards:{};
  return Object.keys(PLAYER_RATINGS).filter(playerId=>playerId!==id&&Number(owned[playerId]||0)>0&&!injuries[playerId]&&!redCards[playerId]).length>=5;
}
function consumeServerAbsences(state) {
  for (const key of ['injuries','redCards']) {
    const map=state[key]&&typeof state[key]==='object'?state[key]:{};
    state[key]=map;
    for (const id of Object.keys(map)) { map[id]=Number(map[id]||0)-1; if(map[id]<=0) delete map[id]; }
  }
}
// Eski Firebase profilinden yalnızca kart sahipliği bir kez geri alınabilir.
// Eski istemci kayıtları güvenilir para kaynağı değildir; coin, görev, ceza ve
// duplicate adetleri bu yolla asla taşınmaz.
function recoverLegacyRoster(current, legacy) {
  const next = JSON.parse(JSON.stringify(current));
  next.owned = next.owned && typeof next.owned === 'object' ? next.owned : {};
  const oldOwned = legacy?.owned && typeof legacy.owned === 'object' ? legacy.owned : {};
  let restored = 0;
  for (const id of Object.keys(PLAYER_RATINGS)) {
    if (Number(oldOwned[id] || 0) > 0 && Number(next.owned[id] || 0) < 1) { next.owned[id] = 1; restored++; }
  }
  const valid = ids => Array.isArray(ids) ? ids.filter((id, i, all) => PLAYER_RATINGS[id] && next.owned[id] && all.indexOf(id) === i) : [];
  const oldLineup = valid(legacy?.lineup);
  if (oldLineup.length === 5) next.lineup = oldLineup;
  next.bench = valid(legacy?.bench).filter(id => !(next.lineup || []).includes(id)).slice(0, 3);
  if (!next.teamName && typeof legacy?.teamName === 'string') next.teamName = legacy.teamName.slice(0, 15);
  next.legacyRecoveryV1 = true;
  return { state: next, restored };
}
function safeClientSettings(existing, incoming) {
  const next = JSON.parse(JSON.stringify(existing));
  next.teamName = String(incoming.teamName || next.teamName || '').slice(0, 15);
  next.formation = ['1-2-1','2-1-1','1-1-2','1-3','4-0-0'].includes(incoming.formation) ? incoming.formation : next.formation;
  const own = next.owned && typeof next.owned === 'object' ? next.owned : {};
  const cleanIds = value => Array.isArray(value) ? value.filter((id,i,a)=>typeof id==='string'&&!!own[id]&&a.indexOf(id)===i).slice(0,5) : [];
  const lineup = cleanIds(incoming.lineup);
  if (lineup.length === 5) next.lineup = lineup;
  const bench = cleanIds(incoming.bench).filter(id=>!next.lineup.includes(id)).slice(0,3);
  next.bench = bench;
  next.captain = next.lineup.includes(incoming.captain) ? incoming.captain : (next.captain||null);
  next.freeKickTaker = next.lineup.includes(incoming.freeKickTaker) ? incoming.freeKickTaker : (next.freeKickTaker||null);
  next.penaltyTaker = next.lineup.includes(incoming.penaltyTaker) ? incoming.penaltyTaker : (next.penaltyTaker||null);
  next.subRule = ['early','flex','late'].includes(incoming.subRule) ? incoming.subRule : (next.subRule||'flex');
  // Cihaz tercihi yalnız görsel/performance ayarıdır; yine de profil ile birlikte
  // saklanır ki aynı Google hesabında her girişte doğru mod açılsın.
  next.graphicsMode = ['mobile','desktop'].includes(incoming.graphicsMode) ? incoming.graphicsMode : (next.graphicsMode||null);
  return next;
}
function serverPositionPenalty(playerPos,slotPos){if(playerPos===slotPos)return 0;if(playerPos==='KL'||slotPos==='KL')return 30;if((playerPos==='SLB'||playerPos==='SGB')&&slotPos==='STP')return 2;const groups={KL:'G',STP:'D',SLB:'D',SGB:'D',OS:'M',OOS:'M',GF:'A',ST:'A'},a=groups[playerPos],b=groups[slotPos];if(a===b)return 3;const order={D:0,M:1,A:2};return Math.abs(order[a]-order[b])===1?8:14}
function serverConditionBonus(state,id){return({A:3,B:2,C:-1,D:-3})[state.condition?.[id]||'A']}
function serverChemistryBonus(lineup,id){const nation=PLAYER_NATIONS[id];return nation?(lineup||[]).reduce((total,other)=>total+(other!==id&&PLAYER_NATIONS[other]===nation?1:0),0):0}
function serverPower(state) {
  const lineup=Array.isArray(state.lineup)?state.lineup:[],bench=Array.isArray(state.bench)?state.bench:[],slots=FORMATION_SLOTS[state.formation]||FORMATION_SLOTS['1-2-1'],values=[];
  lineup.forEach((id,index)=>{if(!Number.isFinite(PLAYER_RATINGS[id])||!slots[index])return;values.push(PLAYER_RATINGS[id]-serverPositionPenalty(PLAYER_POSITIONS[id],slots[index])+serverConditionBonus(state,id)+serverChemistryBonus(lineup,id))});
  bench.forEach(id=>{if(Number.isFinite(PLAYER_RATINGS[id]))values.push(PLAYER_RATINGS[id]+serverConditionBonus(state,id))});
  return values.length ? Math.round(values.reduce((a,b)=>a+b,0)/values.length) : 0;
}

function profilePower(state) {
  // Görsel güç değeri istemcinin eski profilinden taşınır; sonraki sürümde maç ve
  // paket işlemleri de Worker'da tamamlandığında bu değer yalnız sunucuda hesaplanır.
  return serverPower(state);
}

async function profileResponse(request, db, uid, extra = {}) {
  const profile = await db.prepare('SELECT state_json AS stateJson, team_name AS teamName, team_power AS teamPower, updated_at AS updatedAt FROM player_profiles WHERE uid = ?').bind(uid).first();
  if (!profile) return json(request, { ok: true, profile: null, ...extra });
  const state = JSON.parse(profile.stateJson);
  // İki tek-seferlik güncelleme de aynı yüklemede uygulanmalıdır; || kısa devre
  // yaptığı için sonuçları önce ayrı alıyoruz.
  const conditionV6Changed = applyConditionPresetV6(state);
  const conditionV7Changed = applyConditionPresetV7(state);
  if (conditionV6Changed || conditionV7Changed) {
    const now = Date.now();
    const teamPower = serverPower(state);
    await db.prepare('UPDATE player_profiles SET state_json=?, team_power=?, updated_at=? WHERE uid=?').bind(JSON.stringify(state), teamPower, now, uid).run();
    profile.stateJson = JSON.stringify(state); profile.teamPower = teamPower; profile.updatedAt = now;
  }
  return json(request, { ok: true, profile: { ...profile, state }, ...extra });
}

async function recordHeartbeat(db, uid, now = Date.now()) {
  const previous = await db.prepare('SELECT last_heartbeat_at AS lastSeen FROM player_presence WHERE uid = ?').bind(uid).first();
  const elapsed = previous ? Math.max(0, Math.min(70, Math.floor((now - previous.lastSeen) / 1000))) : 0;
  await db.prepare(`INSERT INTO player_presence (uid,last_heartbeat_at,play_seconds,updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET last_heartbeat_at=excluded.last_heartbeat_at, play_seconds=player_presence.play_seconds+excluded.play_seconds, updated_at=excluded.updated_at`)
    .bind(uid, now, elapsed, now).run();
  const currentWeek = weekStart(now);
  if (currentWeek !== null) await db.prepare(`INSERT INTO weekly_playtime (week_start,uid,play_seconds,updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(week_start,uid) DO UPDATE SET play_seconds=weekly_playtime.play_seconds+excluded.play_seconds, updated_at=excluded.updated_at`)
    .bind(currentWeek, uid, elapsed, now).run();
  // Liderlikteki güç, istemciden gelen sayı değil D1'deki doğrulanmış kadrodan
  // her nabızda yeniden hesaplanır. İstemci dakika başı nabız gönderir.
  const profile = await db.prepare('SELECT state_json AS stateJson FROM player_profiles WHERE uid=?').bind(uid).first();
  let power = 0;
  if (profile) {
    power = serverPower(JSON.parse(profile.stateJson));
    await db.prepare('UPDATE player_profiles SET team_power=?,updated_at=? WHERE uid=?').bind(power, now, uid).run();
  }
  return { elapsed, power };
}

async function settleWeek(db, week, now) {
  if (week === null || now < week + WEEK_MS) return;
  const power = await db.prepare('SELECT uid FROM player_profiles WHERE team_power > 0 ORDER BY team_power DESC, updated_at ASC LIMIT 1').first();
  const time = await db.prepare('SELECT uid FROM weekly_playtime WHERE week_start = ? AND play_seconds > 0 ORDER BY play_seconds DESC, updated_at ASC LIMIT 1').bind(week).first();
  for (const [category, winner] of [['power', power], ['playtime', time]]) {
    if (!winner?.uid) continue;
    const added = await db.prepare('INSERT OR IGNORE INTO weekly_awards (week_start,category,uid,amount,awarded_at) VALUES (?, ?, ?, 1000, ?)').bind(week, category, winner.uid, now).run();
    if ((added.meta.changes || 0) === 1) {
      await getWallet(db, winner.uid, now);
      await db.prepare('UPDATE player_wallets SET coins=coins+1000, updated_at=? WHERE uid=?').bind(now, winner.uid).run();
    }
  }
}

async function leaderboardResponse(request, db, uid) {
  const now = Date.now(), currentWeek = weekStart(now);
  if (currentWeek !== null) await settleWeek(db, currentWeek - WEEK_MS, now);
  const power = await db.prepare('SELECT team_name AS teamName, team_power AS value FROM player_profiles WHERE team_power > 0 ORDER BY team_power DESC, updated_at ASC LIMIT 10').all();
  const coins = await db.prepare(`SELECT p.team_name AS teamName, w.coins AS value FROM player_wallets w LEFT JOIN player_profiles p ON p.uid=w.uid ORDER BY w.coins DESC, w.updated_at ASC LIMIT 10`).all();
  const time = currentWeek === null ? { results: [] } : await db.prepare(`SELECT p.team_name AS teamName, t.play_seconds AS value FROM weekly_playtime t LEFT JOIN player_profiles p ON p.uid=t.uid WHERE t.week_start=? ORDER BY t.play_seconds DESC, t.updated_at ASC LIMIT 10`).bind(currentWeek).all();
  const awards = currentWeek === null ? { results: [] } : await db.prepare('SELECT category,uid,amount FROM weekly_awards WHERE week_start=?').bind(currentWeek - WEEK_MS).all();
  return json(request, { ok:true, currentWeek, nextAt: currentWeek === null ? LEADERBOARD_START : currentWeek + WEEK_MS, power: power.results, playtime: time.results, coins: coins.results, awards: awards.results, me: uid });
}

function taskDayKey(now=Date.now()){return new Date(now+3*3600000).toISOString().slice(0,10)}
async function taskPayload(db, uid, now=Date.now()){
  const profile=await db.prepare('SELECT state_json AS stateJson FROM player_profiles WHERE uid=?').bind(uid).first();
  if(!profile)throw new Error('Önce profil aktarımı gerekli.');
  const state=JSON.parse(profile.stateJson), day=taskDayKey(now), claimedRows=await db.prepare('SELECT task_id AS taskId FROM daily_task_claims WHERE uid=? AND day_key=?').bind(uid,day).all(),claimed=new Set(claimedRows.results.map(r=>r.taskId));
  return {day,items:Object.entries(SECURE_TASKS).map(([id,t])=>{const progress=id==='squad80'?serverPower(state):Number(state.taskStats?.[id]||0);return{id,...t,progress,claimed:claimed.has(id)}})};
}

async function getWallet(db, uid, now = Date.now()) {
  await db.prepare(
    'INSERT OR IGNORE INTO player_wallets (uid, coins, next_reward_at, created_at, updated_at) VALUES (?, 0, ?, ?, ?)',
  ).bind(uid, now + TIMER_WAIT_MS, now, now).run();
  return db.prepare('SELECT coins, next_reward_at AS nextRewardAt, updated_at AS walletUpdatedAt FROM player_wallets WHERE uid = ?').bind(uid).first();
}

async function walletResponse(request, db, uid, extra = {}) {
  const wallet = await getWallet(db, uid);
  return json(request, { ok: true, coins: wallet.coins, nextRewardAt: wallet.nextRewardAt, ...extra });
}

async function readBody(request) {
  const type = request.headers.get('Content-Type') || '';
  if (!type.includes('application/json')) return {};
  try { return await request.json(); } catch { throw new Error('Geçersiz istek.'); }
}

export default {
  async scheduled(controller, env, ctx) {
    // Her cuma 00:00 Türkiye saatinden sonra çalışan zamanlayıcı, önceki haftanın
    // güç ve oynama süresi ödüllerini tek seferlik D1 kaydıyla dağıtır.
    ctx.waitUntil((async () => {
      await ensureTables(env.AF_DB);
      const now = Date.now();
      const expired=await env.AF_DB.prepare("SELECT id FROM secure_auctions WHERE status='active' AND expires_at<=? LIMIT 100").bind(now).all();
      for(const row of expired.results)await env.AF_DB.prepare("UPDATE secure_auctions SET status=CASE WHEN high_bidder_uid IS NULL THEN 'expired' ELSE 'sold' END WHERE id=? AND status='active'").bind(row.id).run();
      const current = weekStart(now);
      if (current !== null) await settleWeek(env.AF_DB, current - WEEK_MS, now);
    })());
  },
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request) });
    const url = new URL(request.url);
    if (url.pathname === '/' || url.pathname === '/health') {
      return json(request, { ok: true, service: 'AFootball güvenli oyun servisi' });
    }
    if (!url.pathname.startsWith('/v1/')) return json(request, { ok: false, error: 'Bulunamadı.' }, 404);
    if (request.method !== 'POST') return json(request, { ok: false, error: 'Yalnız POST istekleri desteklenir.' }, 405);

    try {
      const user = await requireFirebaseUser(request, env);
      await ensureTables(env.AF_DB);

      if (url.pathname === '/v1/bootstrap') return walletResponse(request, env.AF_DB, user.uid);

      if (url.pathname === '/v1/profile/load') return profileResponse(request, env.AF_DB, user.uid);

      if (url.pathname === '/v1/profile/migrate') {
        await readBody(request); const now = Date.now();
        const existing = await env.AF_DB.prepare('SELECT uid FROM player_profiles WHERE uid=?').bind(user.uid).first();
        const legacy=existing?null:await importLegacyProfile(env,user.uid),state=legacy?.owned?cleanState(legacy).state:initialState(),encoded=JSON.stringify(state);
        if (!existing) await env.AF_DB.prepare('INSERT INTO player_profiles (uid,team_name,state_json,team_power,migrated_at,updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(user.uid, String(state.teamName || '').slice(0, 15), encoded, profilePower(state), now, now).run();
        return profileResponse(request, env.AF_DB, user.uid, { migrated: !existing });
      }

      if (url.pathname === '/v1/profile/recover-legacy') {
        await readBody(request); const now=Date.now();
        const profile=await env.AF_DB.prepare('SELECT state_json AS stateJson FROM player_profiles WHERE uid=?').bind(user.uid).first();
        if(!profile)return json(request,{ok:false,error:'Önce profil aktarımı gerekli.'},409);
        const current=JSON.parse(profile.stateJson);
        if(current.legacyRecoveryV1)return profileResponse(request,env.AF_DB,user.uid,{recovered:false,restored:0});
        const legacy=await importLegacyProfile(env,user.uid);
        if(!legacy?.owned){current.legacyRecoveryV1=true;await env.AF_DB.prepare('UPDATE player_profiles SET state_json=?,updated_at=? WHERE uid=?').bind(JSON.stringify(current),now,user.uid).run();return profileResponse(request,env.AF_DB,user.uid,{recovered:false,restored:0});}
        const merged=recoverLegacyRoster(current,legacy);
        await env.AF_DB.prepare('UPDATE player_profiles SET team_name=?,state_json=?,team_power=?,updated_at=? WHERE uid=?').bind(String(merged.state.teamName||'').slice(0,15),JSON.stringify(merged.state),serverPower(merged.state),now,user.uid).run();
        return profileResponse(request,env.AF_DB,user.uid,{recovered:merged.restored>0,restored:merged.restored});
      }

      if (url.pathname === '/v1/profile/save') {
        const body = await readBody(request), now = Date.now(), cleaned = cleanState(body.state);
        const existing = await env.AF_DB.prepare('SELECT state_json AS stateJson FROM player_profiles WHERE uid=?').bind(user.uid).first();
        if (!existing) return json(request, { ok:false, error:'Önce profil aktarımı gerekli.' }, 409);
        const state = safeClientSettings(JSON.parse(existing.stateJson), cleaned.state), encoded = JSON.stringify(state);
        await env.AF_DB.prepare('UPDATE player_profiles SET team_name=?, state_json=?, team_power=?, updated_at=? WHERE uid=?')
          .bind(String(state.teamName || '').slice(0, 15), encoded, profilePower(state), now, user.uid).run();
        return walletResponse(request, env.AF_DB, user.uid, { saved:true });
      }

      if (url.pathname === '/v1/player/quick-sell') {
        const body=await readBody(request),id=String(body.playerId||''),now=Date.now();
        if(!PLAYER_RATINGS[id])return json(request,{ok:false,error:'Geçersiz oyuncu.'},400);
        const profile=await env.AF_DB.prepare('SELECT state_json AS stateJson FROM player_profiles WHERE uid=?').bind(user.uid).first();
        if(!profile)return json(request,{ok:false,error:'Önce profil aktarımı gerekli.'},409);
        const state=JSON.parse(profile.stateJson);
        if(!canSecurelySell(state,id))return json(request,{ok:false,error:'Kadro güvenliği için bu oyuncu satılamaz.'},400);
        state.owned[id]=Number(state.owned[id])-1;if(!state.owned[id])delete state.owned[id];
        const value=quickSellValue(id);await getWallet(env.AF_DB,user.uid,now);
        await env.AF_DB.batch([
          env.AF_DB.prepare('UPDATE player_profiles SET state_json=?,team_power=?,updated_at=? WHERE uid=?').bind(JSON.stringify(state),serverPower(state),now,user.uid),
          env.AF_DB.prepare('UPDATE player_wallets SET coins=coins+?,updated_at=? WHERE uid=?').bind(value,now,user.uid),
        ]);
        return walletResponse(request,env.AF_DB,user.uid,{sold:true,playerId:id,value,state});
      }

      if (url.pathname === '/v1/heartbeat') {
        const heartbeat = await recordHeartbeat(env.AF_DB, user.uid);
        return walletResponse(request, env.AF_DB, user.uid, heartbeat);
      }

      if (url.pathname === '/v1/leaderboard') return leaderboardResponse(request, env.AF_DB, user.uid);

      if (url.pathname === '/v1/tasks') {
        const tasks=await taskPayload(env.AF_DB,user.uid);
        return walletResponse(request,env.AF_DB,user.uid,{tasks});
      }

      if (url.pathname === '/v1/tasks/claim') {
        const body=await readBody(request),id=String(body.taskId||''),task=SECURE_TASKS[id];
        if(!task)return json(request,{ok:false,error:'Geçersiz görev.'},400);
        const now=Date.now(),tasks=await taskPayload(env.AF_DB,user.uid,now),current=tasks.items.find(x=>x.id===id);
        if(!current||current.progress<task.goal)return json(request,{ok:false,error:'Görev henüz tamamlanmadı.'},400);
        const added=await env.AF_DB.prepare('INSERT OR IGNORE INTO daily_task_claims (uid,day_key,task_id,claimed_at) VALUES (?, ?, ?, ?)').bind(user.uid,tasks.day,id,now).run();
        if((added.meta.changes||0)!==1)return walletResponse(request,env.AF_DB,user.uid,{claimed:false,error:'Bu ödül zaten alındı.'});
        await env.AF_DB.prepare('UPDATE player_wallets SET coins=coins+?,updated_at=? WHERE uid=?').bind(task.reward,now,user.uid).run();
        return walletResponse(request,env.AF_DB,user.uid,{claimed:true,reward:task.reward,tasks:await taskPayload(env.AF_DB,user.uid,now)});
      }

      if (url.pathname === '/v1/auction/list') {
        const now=Date.now(),expired=await env.AF_DB.prepare("SELECT id FROM secure_auctions WHERE status='active' AND expires_at<=? LIMIT 50").bind(now).all();
        for(const row of expired.results)await env.AF_DB.prepare("UPDATE secure_auctions SET status=CASE WHEN high_bidder_uid IS NULL THEN 'expired' ELSE 'sold' END WHERE id=? AND status='active'").bind(row.id).run();
        const rows=await env.AF_DB.prepare("SELECT a.id,a.player_id AS playerId,a.seller_uid AS sellerId,p.team_name AS sellerName,a.start_price AS startPrice,a.buy_now AS buyNow,a.high_bid AS highBid,a.high_bidder_uid AS highBidder,a.expires_at AS expiresAt,a.status FROM secure_auctions a LEFT JOIN player_profiles p ON p.uid=a.seller_uid WHERE a.status='active' AND a.expires_at>? ORDER BY a.expires_at ASC LIMIT 100").bind(now).all();
        return json(request,{ok:true,auctions:rows.results});
      }

      if (url.pathname === '/v1/auction/create') {
        const body=await readBody(request),id=String(body.playerId||''),price=Math.floor(Number(body.price)),now=Date.now();
        if(!PLAYER_RATINGS[id]||!Number.isFinite(price)||price<10)return json(request,{ok:false,error:'Geçersiz satış bilgisi.'},400);
        const profile=await env.AF_DB.prepare('SELECT state_json AS stateJson FROM player_profiles WHERE uid=?').bind(user.uid).first();if(!profile)return json(request,{ok:false,error:'Profil bulunamadı.'},404);
        const state=JSON.parse(profile.stateJson),count=Number(state.owned?.[id]||0);if(count<1)return json(request,{ok:false,error:'Bu oyuncu sende yok.'},400);
        await env.AF_DB.prepare('INSERT INTO secure_auctions (id,seller_uid,player_id,start_price,buy_now,expires_at,created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(crypto.randomUUID(),user.uid,id,price,price*2,now+86400000,now).run();
        return walletResponse(request,env.AF_DB,user.uid,{created:true});
      }

      if(url.pathname==='/v1/auction/bid'||url.pathname==='/v1/auction/buy'){
        const body=await readBody(request),id=String(body.id||''),auction=await env.AF_DB.prepare('SELECT * FROM secure_auctions WHERE id=?').bind(id).first();
        if(!auction||auction.status!=='active'||auction.expires_at<=Date.now())return json(request,{ok:false,error:'İhale sona erdi.'},400);
        if(auction.seller_uid===user.uid)return json(request,{ok:false,error:'Kendi oyuncuna teklif veremezsin.'},400);
        const buy=url.pathname.endsWith('/buy'),amount=buy?auction.buy_now:Math.floor(Number(body.amount));
        if(!Number.isSafeInteger(amount)||amount<Math.max(auction.start_price,auction.high_bid+1)||amount>auction.buy_now)return json(request,{ok:false,error:'Geçersiz teklif.'},400);
        await getWallet(env.AF_DB,user.uid);
        const changed=await env.AF_DB.prepare("UPDATE secure_auctions SET high_bid=?,high_bidder_uid=?,status=CASE WHEN ? THEN 'sold' ELSE status END WHERE id=? AND status='active' AND high_bid=? AND expires_at>?").bind(amount,user.uid,buy?1:0,id,auction.high_bid,Date.now()).run();
        if(!changed.meta.changes)return json(request,{ok:false,error:'Bu ihaleye yeni teklif geldi. Yenile ve tekrar dene.'},409);
        return walletResponse(request,env.AF_DB,user.uid,{bid:true,bought:buy});
      }

      if(url.pathname==='/v1/duel/create'){
        const body=await readBody(request),now=Date.now(), code=crypto.randomUUID().replace(/-/g,'').slice(0,6).toUpperCase(),leagueCode=String(body.leagueCode||'').toUpperCase()||null;
        if(leagueCode){const l=await env.AF_DB.prepare("SELECT members_json AS members,status,ends_at AS endsAt FROM secure_leagues WHERE code=?").bind(leagueCode).first();if(!l||l.status!=='active'||l.endsAt<=now||!JSON.parse(l.members).some(m=>m.id===user.uid))return json(request,{ok:false,error:'Aktif canlı lig bulunamadı.'},400)}
        await env.AF_DB.prepare("INSERT INTO duels (code,host_uid,status,league_code,created_at,updated_at) VALUES (?,?,'waiting',?,?,?)").bind(code,user.uid,leagueCode,now,now).run();
        return json(request,{ok:true,code});
      }
      if(url.pathname==='/v1/duel/join'){
        const body=await readBody(request),code=String(body.code||'').toUpperCase();
        const changed=await env.AF_DB.prepare("UPDATE duels SET guest_uid=?,status='ready',updated_at=? WHERE code=? AND status='waiting' AND host_uid!=?").bind(user.uid,Date.now(),code,user.uid).run();
        if(!changed.meta.changes)return json(request,{ok:false,error:'Oda bulunamadı veya dolu.'},400);
        return json(request,{ok:true,code});
      }
      if(url.pathname==='/v1/duel/get'){
        const body=await readBody(request),row=await env.AF_DB.prepare('SELECT * FROM duels WHERE code=?').bind(String(body.code||'').toUpperCase()).first();
        if(!row||![row.host_uid,row.guest_uid].includes(user.uid))return json(request,{ok:false,error:'Oda bulunamadı.'},404);
        return json(request,{ok:true,duel:{code:row.code,status:row.status,host:row.host_uid===user.uid?'sen':'rakip',guest:row.guest_uid===user.uid?'sen':row.guest_uid?'rakip':null,hostScore:row.host_score,guestScore:row.guest_score,attack:row.attack,minute:row.minute,winner:row.winner_uid===user.uid?'sen':row.winner_uid?'rakip':null}});
      }
      if(url.pathname==='/v1/duel/start'){
        const body=await readBody(request),changed=await env.AF_DB.prepare("UPDATE duels SET status='match',updated_at=? WHERE code=? AND host_uid=? AND status='ready'").bind(Date.now(),String(body.code||'').toUpperCase(),user.uid).run();
        if(!changed.meta.changes)return json(request,{ok:false,error:'Maç başlatılamadı.'},400);return json(request,{ok:true});
      }
      if(url.pathname==='/v1/duel/pick'){
        const body=await readBody(request),code=String(body.code||'').toUpperCase(),side=['sol','orta','sağ'].includes(body.side)?body.side:null;if(!side)return json(request,{ok:false,error:'Geçersiz yön.'},400);
        const row=await env.AF_DB.prepare('SELECT * FROM duels WHERE code=?').bind(code).first();if(!row||row.status!=='match'||![row.host_uid,row.guest_uid].includes(user.uid))return json(request,{ok:false,error:'Maç uygun değil.'},400);
        const field=row.host_uid===user.uid?'host_pick':'guest_pick';if(row[field])return json(request,{ok:false,error:'Seçimini zaten yaptın.'},400);
        await env.AF_DB.prepare(`UPDATE duels SET ${field}=?,updated_at=? WHERE code=? AND ${field} IS NULL`).bind(side,Date.now(),code).run();
        const d=await env.AF_DB.prepare('SELECT * FROM duels WHERE code=?').bind(code).first();
        if(!d.host_pick||!d.guest_pick)return json(request,{ok:true,waiting:true});
        const goal=d.host_pick!==d.guest_pick,scoreField=d.attack==='host'?'host_score':'guest_score',minute=Math.min(90,d.minute+5),done=minute>=90,winner=done?(d.host_score+(d.attack==='host'&&goal?1:0)===d.guest_score+(d.attack==='guest'&&goal?1:0)?null:(d.host_score+(d.attack==='host'&&goal?1:0)>d.guest_score+(d.attack==='guest'&&goal?1:0)?d.host_uid:d.guest_uid)):null;
        await env.AF_DB.prepare(`UPDATE duels SET ${scoreField}=${scoreField}+?,attack=?,minute=?,host_pick=NULL,guest_pick=NULL,status=?,winner_uid=?,updated_at=? WHERE code=?`).bind(goal?1:0,d.attack==='host'?'guest':'host',minute,done?'finished':'match',winner,Date.now(),code).run();
        if(done&&winner){const award=await env.AF_DB.prepare('INSERT OR IGNORE INTO duel_rewards (code,uid,awarded_at) VALUES (?,?,?)').bind(code,winner,Date.now()).run();if(award.meta.changes){await getWallet(env.AF_DB,winner);await env.AF_DB.prepare('UPDATE player_wallets SET coins=coins+100,updated_at=? WHERE uid=?').bind(Date.now(),winner).run();}}
        if(done&&d.league_code){const league=await env.AF_DB.prepare('SELECT * FROM secure_leagues WHERE code=?').bind(d.league_code).first();if(league&&league.status==='active'){const members=JSON.parse(league.members_json),a=d.host_score+(d.attack==='host'&&goal?1:0),b=d.guest_score+(d.attack==='guest'&&goal?1:0),winnerId=a===b?null:a>b?d.host_uid:d.guest_uid,loserId=winnerId===d.host_uid?d.guest_uid:d.host_uid;for(const m of members){if(m.id!==d.host_uid&&m.id!==d.guest_uid)continue;m.p=(m.p||0)+1;if(!winnerId){m.d=(m.d||0)+1;m.pts=(m.pts||0)+1}else if(m.id===winnerId){m.w=(m.w||0)+1;m.gf=(m.gf||0)+1;m.pts=(m.pts||0)+3}else{m.l=(m.l||0)+1;m.ga=(m.ga||0)+1}}await env.AF_DB.prepare('UPDATE secure_leagues SET members_json=?,results_json=json_insert(results_json,\'$[#]\',json(?)) WHERE code=?').bind(JSON.stringify(members),JSON.stringify({id:code,winner:winnerId,at:Date.now()}),d.league_code).run()}}
        return json(request,{ok:true,resolved:true});
      }

      if(url.pathname==='/v1/league/create'){
        const now=Date.now(),code=crypto.randomUUID().replace(/-/g,'').slice(0,6).toUpperCase();
        const profile=await env.AF_DB.prepare('SELECT team_name AS teamName FROM player_profiles WHERE uid=?').bind(user.uid).first();
        const members=[{id:user.uid,name:profile?.teamName||'Takımım',p:0,w:0,d:0,l:0,gf:0,ga:0,pts:0}];
        await env.AF_DB.prepare("INSERT INTO secure_leagues (code,owner_uid,status,members_json,ends_at,created_at) VALUES (?,?,'waiting',?,?,?)").bind(code,user.uid,JSON.stringify(members),now+7*86400000,now).run();
        return json(request,{ok:true,code});
      }
      if(url.pathname==='/v1/league/get'||url.pathname==='/v1/league/join'||url.pathname==='/v1/league/start'){
        const body=await readBody(request),code=String(body.code||'').toUpperCase(),row=await env.AF_DB.prepare('SELECT * FROM secure_leagues WHERE code=?').bind(code).first();
        if(!row)return json(request,{ok:false,error:'Lig bulunamadı.'},404);
        let members=JSON.parse(row.members_json),status=row.status;
        if(url.pathname.endsWith('/join')){if(status!=='waiting'||row.ends_at<=Date.now())return json(request,{ok:false,error:'Bu lige katılamazsın.'},400);if(!members.some(m=>m.id===user.uid)){if(members.length>=8)return json(request,{ok:false,error:'Lig dolu.'},400);const p=await env.AF_DB.prepare('SELECT team_name AS teamName FROM player_profiles WHERE uid=?').bind(user.uid).first();members.push({id:user.uid,name:p?.teamName||'Takımım',p:0,w:0,d:0,l:0,gf:0,ga:0,pts:0});status=members.length>=2?'ready':'waiting';await env.AF_DB.prepare('UPDATE secure_leagues SET members_json=?,status=? WHERE code=?').bind(JSON.stringify(members),status,code).run()}}
        if(url.pathname.endsWith('/start')){if(row.owner_uid!==user.uid||members.length<2)return json(request,{ok:false,error:'Lig başlatılamadı.'},400);status='active';await env.AF_DB.prepare("UPDATE secure_leagues SET status='active' WHERE code=?").bind(code).run()}
        return json(request,{ok:true,league:{code,ownerId:row.owner_uid,status,members,endsAt:row.ends_at,results:JSON.parse(row.results_json)}});
      }

      if(url.pathname==='/v1/admin/dashboard'){
        requireAdmin(user);
        const now=Date.now();
        const [auctionRows,leagueRows,playerRows,legacyProfiles]=await Promise.all([
          env.AF_DB.prepare("SELECT a.id,a.player_id AS playerId,a.seller_uid AS sellerId,p.team_name AS sellerName,a.start_price AS startPrice,a.buy_now AS buyNow,a.high_bid AS highBid,a.expires_at AS expiresAt FROM secure_auctions a LEFT JOIN player_profiles p ON p.uid=a.seller_uid WHERE a.status='active' AND a.expires_at>? ORDER BY a.expires_at ASC LIMIT 100").bind(now).all(),
          env.AF_DB.prepare("SELECT code,owner_uid AS ownerId,status,members_json AS membersJson,ends_at AS endsAt FROM secure_leagues WHERE status!='deleted' ORDER BY created_at DESC LIMIT 100").all(),
          env.AF_DB.prepare('SELECT uid,team_name AS teamName,state_json AS stateJson FROM player_profiles ORDER BY updated_at DESC LIMIT 300').all(),
          listLegacyProfiles(env),
        ]);
        const players=playerRows.results.map(p=>({...p,recoveryChecked:!!JSON.parse(p.stateJson||'{}').legacyRecoveryV1}));
        const byUid=new Map(players.map(p=>[p.uid,p]));
        const pending=legacyProfiles.items.filter(p=>!byUid.get(p.uid)?.recoveryChecked).map(p=>({teamName:p.teamName}));
        return json(request,{ok:true,auctions:auctionRows.results,leagues:leagueRows.results.map(l=>({...l,members:JSON.parse(l.membersJson||'[]')})),players,migration:{legacyTotal:legacyProfiles.items.length,checked:legacyProfiles.items.length-pending.length,pending,pendingCount:pending.length,truncated:legacyProfiles.truncated}});
      }

      if(url.pathname==='/v1/admin/action'){
        requireAdmin(user);const body=await readBody(request),action=String(body.action||''),id=String(body.id||'');
        if(!id)return json(request,{ok:false,error:'İşlem hedefi eksik.'},400);
        if(action==='auction-delete'){const r=await env.AF_DB.prepare("UPDATE secure_auctions SET status='deleted' WHERE id=? AND status='active'").bind(id).run();if(!r.meta.changes)return json(request,{ok:false,error:'Açık artırma bulunamadı.'},404);return json(request,{ok:true});}
        if(action==='auction-return'){const r=await env.AF_DB.prepare("UPDATE secure_auctions SET status='expired' WHERE id=? AND status='active'").bind(id).run();if(!r.meta.changes)return json(request,{ok:false,error:'Açık artırma bulunamadı.'},404);return json(request,{ok:true});}
        if(action==='league-delete'){const r=await env.AF_DB.prepare("UPDATE secure_leagues SET status='deleted' WHERE code=? AND status!='deleted'").bind(id).run();if(!r.meta.changes)return json(request,{ok:false,error:'Lig bulunamadı.'},404);return json(request,{ok:true});}
        return json(request,{ok:false,error:'Geçersiz yönetici işlemi.'},400);
      }

      if(url.pathname==='/v1/admin/grant'){
        requireAdmin(user);
        const body=await readBody(request),amount=Math.floor(Number(body.amount)),target=String(body.uid||'');if(!target||!Number.isSafeInteger(amount)||amount<1||amount>1000000)return json(request,{ok:false,error:'Geçersiz coin işlemi.'},400);
        await getWallet(env.AF_DB,target);await env.AF_DB.prepare('UPDATE player_wallets SET coins=coins+?,updated_at=? WHERE uid=?').bind(amount,Date.now(),target).run();return json(request,{ok:true});
      }

      if(url.pathname==='/v1/admin/debit'){
        requireAdmin(user);
        const body=await readBody(request),amount=Math.floor(Number(body.amount)),target=String(body.uid||'');
        if(!target||!Number.isSafeInteger(amount)||amount<1||amount>1000000)return json(request,{ok:false,error:'Geçersiz coin işlemi.'},400);
        await getWallet(env.AF_DB,target);
        const changed=await env.AF_DB.prepare('UPDATE player_wallets SET coins=coins-?,updated_at=? WHERE uid=? AND coins>=?').bind(amount,Date.now(),target,amount).run();
        if(!changed.meta.changes)return json(request,{ok:false,error:'Bakiyede yeterli coin yok.'},400);
        return walletResponse(request,env.AF_DB,target,{debited:true,amount});
      }

      if (url.pathname === '/v1/claim-timer') {
        const now = Date.now();
        await getWallet(env.AF_DB, user.uid, now);
        const claim = await env.AF_DB.prepare(
          'UPDATE player_wallets SET coins = coins + ?, next_reward_at = ?, updated_at = ? WHERE uid = ? AND next_reward_at <= ?',
        ).bind(TIMER_REWARD, now + TIMER_WAIT_MS, now, user.uid, now).run();
        return walletResponse(request, env.AF_DB, user.uid, { claimed: (claim.meta.changes || 0) === 1, reward: TIMER_REWARD });
      }

      if (url.pathname === '/v1/redeem') {
        const body = await readBody(request);
        const code = String(body.code || '').trim().toLocaleUpperCase('tr-TR');
        const reward = CODE_REWARDS[code];
        if (!reward) return json(request, { ok: false, error: 'Geçersiz kod.' }, 400);
        const now = Date.now();
        await getWallet(env.AF_DB, user.uid, now);
        const legacy = await env.AF_DB.prepare('SELECT 1 FROM used_codes WHERE uid=? AND code=? LIMIT 1').bind(user.uid, code).first();
        if (legacy) return walletResponse(request, env.AF_DB, user.uid, { redeemed: false, error: 'Bu kod daha önce kullanıldı.' });
        const inserted = await env.AF_DB.prepare(
          'INSERT OR IGNORE INTO secure_code_redemptions (uid, code, used_at) VALUES (?, ?, ?)',
        ).bind(user.uid, code, now).run();
        if ((inserted.meta.changes || 0) !== 1) return walletResponse(request, env.AF_DB, user.uid, { redeemed: false, error: 'Bu kod daha önce kullanıldı.' });
        await env.AF_DB.prepare('INSERT OR IGNORE INTO used_codes (uid, code, used_at) VALUES (?, ?, ?)').bind(user.uid, code, now).run();
        await env.AF_DB.prepare('UPDATE player_wallets SET coins = coins + ?, updated_at = ? WHERE uid = ?')
          .bind(reward, now, user.uid).run();
        return walletResponse(request, env.AF_DB, user.uid, { redeemed: true, reward });
      }

      if (url.pathname === '/v1/pack/open') {
        const body = await readBody(request), count = Number(body.count) === 10 ? 10 : Number(body.count) === 1 ? 1 : 0;
        if (!count) return json(request, { ok:false, error:'Geçersiz paket isteği.' }, 400);
        const profile = await env.AF_DB.prepare('SELECT state_json AS stateJson FROM player_profiles WHERE uid=?').bind(user.uid).first();
        if (!profile) return json(request, { ok:false, error:'Önce profil aktarımı gerekli.' }, 409);
        const now=Date.now(), cost=count===10?900:100; await getWallet(env.AF_DB,user.uid,now);
        const wallet=await env.AF_DB.prepare('SELECT coins FROM player_wallets WHERE uid=?').bind(user.uid).first();
        if (!wallet || wallet.coins<cost) return json(request,{ok:false,error:'Yeterli coin yok.'},400);
        const state=JSON.parse(profile.stateJson), results=[]; state.owned=state.owned&&typeof state.owned==='object'?state.owned:{};
        let refund=0;
        for(let i=0;i<count;i++){const p=cryptoPick(PACK_POOL), had=Number(state.owned[p.id]||0), dup=had>0, add=dup?duplicateRefund(p.r):0;state.owned[p.id]=had+1;refund+=add;results.push({id:p.id,dup,refund:add});}
        state.taskStats=state.taskStats&&typeof state.taskStats==='object'?state.taskStats:{};state.taskStats.packs=Number(state.taskStats.packs||0)+count;
        await env.AF_DB.batch([
          env.AF_DB.prepare('UPDATE player_wallets SET coins=coins-?+?,updated_at=? WHERE uid=?').bind(cost,refund,now,user.uid),
          env.AF_DB.prepare('UPDATE player_profiles SET state_json=?,team_power=?,updated_at=? WHERE uid=?').bind(JSON.stringify(state),serverPower(state),now,user.uid),
          env.AF_DB.prepare('INSERT INTO pack_openings (id,uid,count,cost,created_at) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(),user.uid,count,cost,now),
        ]);
        return walletResponse(request,env.AF_DB,user.uid,{opened:true,results,refund,cost});
      }

      if (url.pathname === '/v1/match/start') {
        const profile=await env.AF_DB.prepare('SELECT state_json AS stateJson FROM player_profiles WHERE uid=?').bind(user.uid).first();
        if(!profile)return json(request,{ok:false,error:'Önce profil aktarımı gerekli.'},409);
        const recent=await env.AF_DB.prepare('SELECT started_at AS startedAt FROM match_sessions WHERE uid=? ORDER BY started_at DESC LIMIT 1').bind(user.uid).first();
        if(recent&&Date.now()-recent.startedAt<55000)return json(request,{ok:false,error:'Yeni maç için önce önceki maçın tamamlanmasını bekle.'},429);
        const state=JSON.parse(profile.stateJson);consumeServerAbsences(state);const power=serverPower(state), bytes=new Uint32Array(3);crypto.getRandomValues(bytes);
        const rival=58+(bytes[0]%30), edge=(power-rival)/18, scoreA=Math.max(0,Math.min(5,Math.floor(bytes[1]%3+(edge>0?1:0)))), scoreB=Math.max(0,Math.min(5,Math.floor(bytes[2]%3+(edge<0?1:0))));
        const win=scoreA>scoreB,reward=win?10+(bytes[0]%41):scoreA===scoreB?10:1+(bytes[0]%5),id=crypto.randomUUID(),now=Date.now();
        await env.AF_DB.batch([
          env.AF_DB.prepare('INSERT INTO match_sessions (id,uid,score_a,score_b,reward,started_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id,user.uid,scoreA,scoreB,reward,now),
          env.AF_DB.prepare('UPDATE player_profiles SET state_json=?,team_power=?,updated_at=? WHERE uid=?').bind(JSON.stringify(state),power,now,user.uid),
        ]);
        return json(request,{ok:true,sessionId:id,serverScore:{a:scoreA,b:scoreB},minimumFinishAt:now+20000});
      }

      if (url.pathname === '/v1/match/finish') {
        const body=await readBody(request),id=String(body.sessionId||''),now=Date.now(),match=await env.AF_DB.prepare('SELECT * FROM match_sessions WHERE id=? AND uid=?').bind(id,user.uid).first();
        if(!match)return json(request,{ok:false,error:'Geçersiz maç oturumu.'},400);
        if(match.finished_at)return walletResponse(request,env.AF_DB,user.uid,{finished:true,score:{a:match.score_a,b:match.score_b},reward:0,alreadyFinished:true});
        if(now-match.started_at<20000)return json(request,{ok:false,error:'Maç henüz bitmedi.'},400);
        const profile=await env.AF_DB.prepare('SELECT state_json AS stateJson FROM player_profiles WHERE uid=?').bind(user.uid).first(),state=JSON.parse(profile.stateJson);state.w=Number(state.w||0)+(match.score_a>match.score_b?1:0);state.l=Number(state.l||0)+(match.score_a<match.score_b?1:0);state.taskStats=state.taskStats||{};state.taskStats.matches=Number(state.taskStats.matches||0)+1;
        await env.AF_DB.batch([env.AF_DB.prepare('UPDATE match_sessions SET finished_at=? WHERE id=?').bind(now,id),env.AF_DB.prepare('UPDATE player_wallets SET coins=coins+?,updated_at=? WHERE uid=?').bind(match.reward,now,user.uid),env.AF_DB.prepare('UPDATE player_profiles SET state_json=?,team_power=?,updated_at=? WHERE uid=?').bind(JSON.stringify(state),serverPower(state),now,user.uid)]);
        return walletResponse(request,env.AF_DB,user.uid,{finished:true,score:{a:match.score_a,b:match.score_b},reward:match.reward});
      }

      if (url.pathname === '/v1/match/absence') {
        const body=await readBody(request),id=String(body.sessionId||''),playerId=String(body.playerId||''),type=String(body.type||''),now=Date.now();
        if(!PLAYER_RATINGS[playerId]||!['injury','red'].includes(type))return json(request,{ok:false,error:'Geçersiz maç olayı.'},400);
        const match=await env.AF_DB.prepare('SELECT finished_at AS finishedAt FROM match_sessions WHERE id=? AND uid=?').bind(id,user.uid).first();
        if(!match||match.finishedAt)return json(request,{ok:false,error:'Bu maç oturumu kapandı.'},400);
        const profile=await env.AF_DB.prepare('SELECT state_json AS stateJson FROM player_profiles WHERE uid=?').bind(user.uid).first();
        if(!profile)return json(request,{ok:false,error:'Önce profil aktarımı gerekli.'},409);
        const state=JSON.parse(profile.stateJson);state.injuries=state.injuries&&typeof state.injuries==='object'?state.injuries:{};state.redCards=state.redCards&&typeof state.redCards==='object'?state.redCards:{};
        if(!(state.lineup||[]).includes(playerId)||state.injuries[playerId]||state.redCards[playerId]||!canApplyServerAbsence(state,playerId))return json(request,{ok:false,error:'Kadro güvenliği nedeniyle bu olay uygulanamadı.'},400);
        let games=2;
        if(type==='injury'){
          if(Object.keys(state.injuries).length)return json(request,{ok:false,error:'Takımda zaten sakat oyuncu var.'},400);
          const bytes=new Uint32Array(1);crypto.getRandomValues(bytes);games=1+(bytes[0]%3);state.injuries[playerId]=games;
        }else state.redCards[playerId]=2;
        await env.AF_DB.prepare('UPDATE player_profiles SET state_json=?,team_power=?,updated_at=? WHERE uid=?').bind(JSON.stringify(state),serverPower(state),now,user.uid).run();
        return walletResponse(request,env.AF_DB,user.uid,{recorded:true,type,playerId,games});
      }

      return json(request, { ok: false, error: 'Bilinmeyen güvenli işlem.' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sunucu işlemi tamamlanamadı.';
      return json(request, { ok: false, error: message }, message.includes('oturumu') ? 401 : 400);
    }
  },
};
