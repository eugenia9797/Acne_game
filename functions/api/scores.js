// 擠痘木頭人 leaderboard API (Cloudflare Pages Function + D1, binding name "DB").
//   GET  /api/scores?player=<id>   → top 50 + total players + this player's rank
//   POST /api/scores               → {player, name, score, duration, lang}; keeps each player's best score
// Players are anonymous: a random id kept in their browser plus a nickname.
// To hide an entry, run in the D1 console:  UPDATE players SET hidden = 1 WHERE name = '...';

const TOP_N = 50;
const NAME_MAX = 10;
const MIN_GAP_MS = 4000;             // one submission per IP every few seconds
const ALLOWED = [/^https:\/\/esheen\.skin$/, /^https:\/\/([a-z0-9-]+\.)?acne-game\.pages\.dev$/];

const BAD_WORDS = [
  // 中文
  '幹', '靠北', '靠杯', '靠夭', '操你', '肏', '屌', '雞巴', '機掰', '機巴', '雞掰', '屄', '婊', '妓', '賤人', '賤貨',
  '他媽', '你媽', '媽的', '王八', '智障', '白痴', '白癡', '低能', '去死', '幹你娘', '淫', '色情', '做愛', '性交', '陰莖', '陰道', '強姦', '強暴',
  '共匪', '支那', '台巴子',
  // English
  'fuck', 'shit', 'bitch', 'cunt', 'dick', 'pussy', 'nigger', 'nigga', 'faggot', 'slut', 'whore', 'porn', 'rape', 'nazi', 'asshole', 'retard', 'penis', 'vagina',
  // 日本語
  'しね', '死ね', 'ちんこ', 'ちんぽ', 'まんこ', 'セックス', 'きちがい', 'キチガイ',
  // 한국어
  '씨발', '시발', '병신', '좆', '개새끼', '섹스', '니미',
];

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '';
  const allow = ALLOWED.some((re) => re.test(origin)) ? origin : 'https://esheen.skin';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}
function json(request, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...corsHeaders(request) },
  });
}

// control characters and invisible/zero-width characters
const INVISIBLE = new RegExp('[\\u0000-\\u001f\\u007f\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]', 'g');

function cleanName(raw) {
  if (typeof raw !== 'string') return { error: 'bad_name' };
  const name = raw.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  const len = Array.from(name).length;
  if (len < 1 || len > NAME_MAX) return { error: 'bad_name' };
  const lower = name.toLowerCase();
  if (/https?:|www\.|\.(com|net|org|tw|io|me|co|cc|xyz|app|shop)\b|line\.me|@|#/.test(lower)) return { error: 'bad_name' };
  if ((lower.match(/[0-9０-９]/g) || []).length >= 6) return { error: 'bad_name' };
  const squashed = lower.replace(/[\s._\-*~!$%^&()+=|\\/:;"'<>,?·・。，！？「」【】\[\]{}0-9]/g, '');
  const leet = squashed.replace(/[@4]/g, 'a').replace(/3/g, 'e').replace(/[1!]/g, 'i').replace(/0/g, 'o').replace(/5/g, 's');
  if (BAD_WORDS.some((w) => squashed.includes(w) || leet.includes(w))) return { error: 'bad_name' };
  return { name };
}

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) {
    schemaReady = db.batch([
      db.prepare(`CREATE TABLE IF NOT EXISTS players (
        player TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        best INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 0,
        achieved_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        games INTEGER NOT NULL DEFAULT 0,
        lang TEXT,
        hidden INTEGER NOT NULL DEFAULT 0
      )`),
      db.prepare('CREATE INDEX IF NOT EXISTS players_rank ON players (hidden, best DESC, achieved_at)'),
      db.prepare('CREATE TABLE IF NOT EXISTS rate (ip TEXT PRIMARY KEY, ts INTEGER NOT NULL)'),
    ]).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function rankOf(db, row) {
  if (!row || row.best <= 0 || row.hidden) return null;
  const r = await db
    .prepare('SELECT COUNT(*) AS c FROM players WHERE hidden = 0 AND (best > ?1 OR (best = ?1 AND achieved_at < ?2))')
    .bind(row.best, row.achieved_at).first();
  return (r ? r.c : 0) + 1;
}
async function totalPlayers(db) {
  const r = await db.prepare('SELECT COUNT(*) AS c FROM players WHERE hidden = 0 AND best > 0').first();
  return r ? r.c : 0;
}
async function ipKey(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'local';
  const data = new TextEncoder().encode(ip + '|' + (env.SALT || 'acne-game'));
  const hash = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(hash)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
}
const validPlayer = (p) => typeof p === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(p);

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json(request, { ok: false, error: 'no_db' }, 503);
  await ensureSchema(env.DB);
  const player = new URL(request.url).searchParams.get('player');
  const { results } = await env.DB
    .prepare('SELECT player, name, best, level FROM players WHERE hidden = 0 AND best > 0 ORDER BY best DESC, achieved_at ASC LIMIT ?1')
    .bind(TOP_N).all();
  let me = null;
  if (validPlayer(player)) {
    const row = await env.DB.prepare('SELECT name, best, level, achieved_at, hidden FROM players WHERE player = ?1').bind(player).first();
    if (row && !row.hidden && row.best > 0) me = { name: row.name, best: row.best, level: row.level, rank: await rankOf(env.DB, row) };
  }
  const top = results.map((r, i) => ({ rank: i + 1, name: r.name, best: r.best, level: r.level, me: validPlayer(player) && r.player === player }));
  return json(request, { ok: true, top, total: await totalPlayers(env.DB), me });
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json(request, { ok: false, error: 'no_db' }, 503);
  await ensureSchema(env.DB);
  let body;
  try { body = JSON.parse(await request.text()); } catch { return json(request, { ok: false, error: 'invalid' }, 400); }
  const { player, score: rawScore, duration: rawDuration, lang } = body || {};
  if (!validPlayer(player)) return json(request, { ok: false, error: 'invalid' }, 400);
  const checked = cleanName(body.name);
  if (checked.error) return json(request, { ok: false, error: 'bad_name' }, 400);
  const score = Math.floor(Number(rawScore) || 0);
  const duration = Math.floor(Number(rawDuration) || 0);
  // generous plausibility limits: a real game cannot earn points faster than this
  if (score < 0 || score > 200000 || duration < 0 || duration > 7200 || score > 120 + duration * 150) {
    return json(request, { ok: false, error: 'invalid' }, 400);
  }

  const now = Date.now();
  const ip = await ipKey(request, env);
  const last = await env.DB.prepare('SELECT ts FROM rate WHERE ip = ?1').bind(ip).first();
  if (last && now - last.ts < MIN_GAP_MS) return json(request, { ok: false, error: 'too_fast' }, 429);
  const writes = [env.DB.prepare('INSERT INTO rate (ip, ts) VALUES (?1, ?2) ON CONFLICT(ip) DO UPDATE SET ts = excluded.ts').bind(ip, now)];
  if (Math.random() < 0.02) writes.push(env.DB.prepare('DELETE FROM rate WHERE ts < ?1').bind(now - 86400000));

  const level = Math.min(29, Math.floor(score / 100));
  const shortLang = typeof lang === 'string' ? lang.slice(0, 5) : null;
  const existing = await env.DB.prepare('SELECT best, achieved_at, hidden FROM players WHERE player = ?1').bind(player).first();
  if (!existing) {
    if (score > 0) {
      writes.push(env.DB.prepare('INSERT INTO players (player, name, best, level, achieved_at, updated_at, games, lang) VALUES (?1, ?2, ?3, ?4, ?5, ?5, 1, ?6)')
        .bind(player, checked.name, score, level, now, shortLang));
    }
  } else if (score > existing.best) {
    writes.push(env.DB.prepare('UPDATE players SET name = ?2, best = ?3, level = ?4, achieved_at = ?5, updated_at = ?5, games = games + 1, lang = ?6 WHERE player = ?1')
      .bind(player, checked.name, score, level, now, shortLang));
  } else {
    writes.push(env.DB.prepare('UPDATE players SET name = ?2, updated_at = ?3, games = games + ?4, lang = ?5 WHERE player = ?1')
      .bind(player, checked.name, now, score > 0 ? 1 : 0, shortLang));
  }
  await env.DB.batch(writes);

  const row = await env.DB.prepare('SELECT name, best, level, achieved_at, hidden FROM players WHERE player = ?1').bind(player).first();
  return json(request, {
    ok: true,
    name: checked.name,
    best: row ? row.best : 0,
    rank: await rankOf(env.DB, row),
    total: await totalPlayers(env.DB),
    improved: !existing ? score > 0 : score > existing.best,
  });
}
