const GAME_ORIGIN = 'https://ordekaamb.github.io';
const TOKEN_CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const TIMER_REWARD = 5;
const TIMER_WAIT_MS = 5 * 60 * 1000;
const CODE_REWARDS = Object.freeze({
  OYUNPIYASADA: 1000,
  BUGLARICINOZURDILERIM: 1000,
  EFSANEGUNCELLEME: 500,
});

let certificateCache = { expiresAt: 0, values: {} };

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
  return { uid: claims.sub };
}

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
  ]);
}

async function getWallet(db, uid, now = Date.now()) {
  await db.prepare(
    'INSERT OR IGNORE INTO player_wallets (uid, coins, next_reward_at, created_at, updated_at) VALUES (?, 0, ?, ?, ?)',
  ).bind(uid, now + TIMER_WAIT_MS, now, now).run();
  return db.prepare('SELECT coins, next_reward_at AS nextRewardAt FROM player_wallets WHERE uid = ?').bind(uid).first();
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
        const inserted = await env.AF_DB.prepare(
          'INSERT OR IGNORE INTO used_codes (uid, code, used_at) VALUES (?, ?, ?)',
        ).bind(user.uid, code, now).run();
        if ((inserted.meta.changes || 0) !== 1) return walletResponse(request, env.AF_DB, user.uid, { redeemed: false, error: 'Bu kod daha önce kullanıldı.' });
        await env.AF_DB.prepare('UPDATE player_wallets SET coins = coins + ?, updated_at = ? WHERE uid = ?')
          .bind(reward, now, user.uid).run();
        return walletResponse(request, env.AF_DB, user.uid, { redeemed: true, reward });
      }

      return json(request, { ok: false, error: 'Bilinmeyen güvenli işlem.' }, 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Sunucu işlemi tamamlanamadı.';
      return json(request, { ok: false, error: message }, message.includes('oturumu') ? 401 : 400);
    }
  },
};
