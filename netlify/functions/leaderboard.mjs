// netlify/functions/leaderboard.mjs
import { getStore } from '@netlify/blobs';

const KEY = 'board.v1';
const MAX_PLAYERS = 20000;
const TOP = 100;
const NAME_MIN = 2, NAME_MAX = 18;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{1,17}$/u;
const DIFFS = ['СТАЖЁР', 'МЕНЕДЖЕР', 'ТИМЛИД'];

const HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}
function fail(code, message, status = 400, extra) {
  return json(Object.assign({ ok: false, code, message }, extra || {}), status);
}

function cleanName(raw) {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}
function nameKey(name) {
  return name.toLowerCase().replace(/ё/g, 'е').replace(/[._'-]/g, ' ').replace(/\s+/g, ' ').trim();
}
function validName(name) {
  if (name.length < NAME_MIN || name.length > NAME_MAX) return false;
  if (!NAME_RE.test(name)) return false;
  if (!/[\p{L}\p{N}]{2}/u.test(name)) return false;
  return true;
}

function rid(n) {
  const a = 'abcdefghijkmnpqrstuvwxyz23456789';
  let s = '';
  const buf = crypto.getRandomValues(new Uint8Array(n));
  for (let i = 0; i < n; i++) s += a[buf[i] % a.length];
  return s;
}

function emptyBoard() { return { players: {}, names: {}, runs: 0, updated: Date.now() }; }

function sorted(board) {
  return Object.values(board.players).sort((a, b) =>
    (b.best - a.best) || (b.dist - a.dist) || (a.created - b.created));
}
function rankOf(board, id) {
  const list = sorted(board);
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return i + 1;
  return 0;
}
function publicPlayer(p) {
  return { n: p.name, s: p.best, d: p.dist, f: p.diff, r: p.runs, e: p.euros || 0, u: p.updated };
}
function suggestions(board, base) {
  const root = base.replace(/\s*\d+$/, '').slice(0, NAME_MAX - 4) || base.slice(0, 12);
  const pool = [root + ' 185', root + ' ' + (2 + Math.floor(Math.random() * 8)),
    root + ' ' + (10 + Math.floor(Math.random() * 89)), root + ' X', root + ' ' + rid(2).toUpperCase()];
  const out = [];
  for (const cand of pool) {
    const c = cleanName(cand);
    if (validName(c) && !board.names[nameKey(c)] && out.indexOf(c) < 0) out.push(c);
    if (out.length === 3) break;
  }
  return out;
}

async function read(store) {
  try {
    const res = await store.getWithMetadata(KEY, { type: 'json', consistency: 'strong' });
    if (!res || !res.data) return { board: emptyBoard(), etag: null };
    const b = res.data;
    if (!b.players) b.players = {};
    if (!b.names) b.names = {};
    if (typeof b.runs !== 'number') b.runs = 0;
    return { board: b, etag: res.etag || null };
  } catch (e) {
    return { board: emptyBoard(), etag: null };
  }
}

async function mutate(store, fn) {
  let lastErr = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const { board, etag } = await read(store);
    let result;
    try { result = fn(board); } catch (e) { return { error: e }; }
    if (result && result.error) return { error: result.error, board };
    board.updated = Date.now();
    try {
      if (etag && attempt < 4) await store.setJSON(KEY, board, { onlyIfMatch: etag });
      else await store.setJSON(KEY, board);
      return { board, result };
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 40 + attempt * 70));
    }
  }
  return { error: lastErr || new Error('write failed') };
}

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response('', { status: 204, headers: HEADERS });

  let store;
  try { store = getStore({ name: 'deskrun', consistency: 'strong' }); }
  catch (e) { return fail('storage', 'Хранилище недоступно', 503); }

  const url = new URL(req.url);
  let action = url.searchParams.get('action') || '';
  let body = {};
  if (req.method === 'POST') {
    try { body = await req.json(); } catch (e) { body = {}; }
    action = body.action || action;
  }
  const q = (k) => url.searchParams.get(k);

  try {
    /* ---------- проверка имени ---------- */
    if (action === 'check') {
      const name = cleanName(q('name') || body.name);
      if (!validName(name)) return json({ ok: true, valid: false, available: false });
      const { board } = await read(store);
      const taken = !!board.names[nameKey(name)];
      return json({
        ok: true, valid: true, available: !taken,
        suggestions: taken ? suggestions(board, name) : []
      });
    }

    /* ---------- регистрация ---------- */
    if (action === 'register') {
      const name = cleanName(body.name);
      if (!validName(name)) return fail('invalid', 'Имя: 2–18 символов, буквы и цифры');
      const key = nameKey(name);
      const out = await mutate(store, (board) => {
        if (board.names[key]) return { error: { code: 'taken', suggestions: suggestions(board, name) } };
        if (Object.keys(board.players).length >= MAX_PLAYERS) return { error: { code: 'full' } };
        const id = rid(12), token = rid(24), code = rid(6).toUpperCase();
        board.players[id] = {
          id, name, token, code, best: 0, dist: 0, diff: '—',
          runs: 0, euros: 0, f2: 0, near: 0, time: 0,
          created: Date.now(), updated: Date.now()
        };
        board.names[key] = id;
        return { id, token, code, name };
      });
      if (out.error && out.error.code === 'taken')
        return fail('taken', 'Имя уже занято', 409, { suggestions: out.error.suggestions });
      if (out.error && out.error.code === 'full')
        return fail('full', 'Рейтинг заполнен', 507);
      if (out.error) return fail('storage', 'Не удалось сохранить имя', 503);
      return json({ ok: true, player: out.result });
    }

    /* ---------- восстановление доступа ---------- */
    if (action === 'recover') {
      const name = cleanName(body.name);
      const code = String(body.code || '').trim().toUpperCase();
      const { board } = await read(store);
      const id = board.names[nameKey(name)];
      if (!id) return fail('unknown', 'Такого имени в рейтинге нет', 404);
      const p = board.players[id];
      if (!p || p.code !== code) return fail('badcode', 'Код не подходит', 403);
      return json({ ok: true, player: { id: p.id, name: p.name, token: p.token, code: p.code } });
    }

    /* ---------- отправка результата ---------- */
    if (action === 'submit') {
      const id = String(body.id || '');
      const token = String(body.token || '');
      const score = clampNum(body.score, 0, 2000000, 0);
      const dist = clampNum(body.dist, 0, 20000, 0);
      const euros = clampNum(body.euros, 0, 400, 0);
      const f2 = clampNum(body.f2, 0, 7200, 0);
      const near = clampNum(body.near, 0, 5000, 0);
      const time = clampNum(body.time, 0, 7200, 0);
      const diff = DIFFS.indexOf(String(body.diff)) >= 0 ? String(body.diff) : 'МЕНЕДЖЕР';
      const won = !!body.won;
      if (dist < 3 || time < 2) return fail('short', 'Забег слишком короткий', 422);
      if (score > dist * 90 + 60000) return fail('implausible', 'Результат не принят', 422);

      const out = await mutate(store, (board) => {
        const p = board.players[id];
        if (!p) return { error: { code: 'unknown' } };
        if (p.token !== token) return { error: { code: 'auth' } };
        p.runs += 1;
        board.runs += 1;
        const improved = score > p.best;
        if (improved) {
          p.best = score; p.dist = dist; p.diff = diff;
          p.euros = euros; p.f2 = f2; p.near = near; p.time = time; p.won = won;
        }
        p.updated = Date.now();
        return { improved, best: p.best, runs: p.runs };
      });
      if (out.error && out.error.code === 'unknown') return fail('unknown', 'Профиль не найден', 404);
      if (out.error && out.error.code === 'auth') return fail('auth', 'Нет доступа к профилю', 403);
      if (out.error) return fail('storage', 'Не удалось записать результат', 503);
      return json({
        ok: true, improved: out.result.improved, best: out.result.best,
        runs: out.result.runs, rank: rankOf(out.board, id),
        total: Object.keys(out.board.players).length
      });
    }

    /* ---------- таблица ---------- */
    if (action === 'top' || action === '' || !action) {
      const limit = clampNum(q('limit') || 60, 1, TOP, 60);
      const meId = q('id') || '';
      const { board } = await read(store);
      const list = sorted(board);
      const me = board.players[meId];
      return json({
        ok: true,
        total: list.length,
        runs: board.runs,
        updated: board.updated,
        players: list.slice(0, limit).map((p, i) => Object.assign({ rank: i + 1, me: p.id === meId }, publicPlayer(p))),
        you: me ? Object.assign({ rank: rankOf(board, meId) }, publicPlayer(me)) : null
      });
    }

    return fail('action', 'Неизвестное действие', 400);
  } catch (e) {
    return fail('server', 'Ошибка сервера', 500);
  }
};