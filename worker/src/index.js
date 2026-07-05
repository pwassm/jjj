/* SLAM API — Cloudflare Worker + D1.
 *
 * Auth model: passwordless magic links. Anyone may log in (the email
 * round-trip IS the verification); roles gate what a login can do:
 *   user   — may POST /messages (private notes / takedown reports to Phil)
 *   expert — additionally may POST /comments on ml.json rows
 *   admin  — additionally may use /admin/* (Phil)
 *
 * Endpoints (JSON in/out unless noted):
 *   POST /auth/request-link  {email, site?, turnstileToken?}
 *   GET  /auth/verify?token=…          → 302 to site/#session=<bearer token>
 *   GET  /auth/me                      → {email, name, role}
 *   POST /auth/profile       {name}
 *   POST /auth/logout
 *   GET  /comments?uid=…               → public; approved comments for a row
 *   POST /comments           {uid, body}            (expert/admin)
 *   POST /messages           {body, uid?, kind?}    (any logged-in user)
 *   GET  /admin/messages?status=…      POST /admin/message-status {id, status}
 *   GET  /admin/comments?uid=…         POST /admin/comment-status {id, status}
 *   POST /admin/set-role     {email, role}
 *
 * Auth header: Authorization: Bearer <session token from /auth/verify>.
 */

const ALLOWED_ORIGINS = [
  'https://sealifeandmore.com',
  'https://www.sealifeandmore.com',
  'http://localhost:8080',
  'http://127.0.0.1:8080',
];

const SESSION_MS = 30 * 24 * 3600 * 1000;   // session lifetime: 30 days
const LINK_MS = 15 * 60 * 1000;             // magic-link lifetime: 15 min
const MAX_BODY_LEN = 4000;
const RATE_LINKS_PER_EMAIL_HOUR = 5;
const RATE_LINKS_PER_IP_HOUR = 10;
const RATE_POSTS_PER_USER_HOUR = 20;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req.headers.get('Origin') || '');
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let res;
    try {
      res = await route(req, env, url);
    } catch (e) {
      res = json({ error: 'server error', detail: String(e && e.message || e) }, 500);
    }
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
};

async function route(req, env, url) {
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const m = req.method;

  if (p === '/' && m === 'GET') return json({ ok: true, service: 'sal-api' });

  if (p === '/auth/request-link' && m === 'POST') return authRequestLink(req, env, url);
  if (p === '/auth/verify' && m === 'GET') return authVerify(env, url);
  if (p === '/auth/me' && m === 'GET') return authMe(req, env);
  if (p === '/auth/profile' && m === 'POST') return authProfile(req, env);
  if (p === '/auth/logout' && m === 'POST') return authLogout(req, env);

  if (p === '/comments' && m === 'GET') return commentsGet(env, url);
  if (p === '/comments' && m === 'POST') return commentsPost(req, env);
  if (p === '/messages' && m === 'POST') return messagesPost(req, env);

  if (p.startsWith('/admin/')) return adminRoute(req, env, url, p, m);

  return json({ error: 'not found' }, 404);
}

/* ---------------- auth ---------------- */

async function authRequestLink(req, env, url) {
  const body = await readJson(req);
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json({ error: 'invalid email' }, 400);
  }
  const site = ALLOWED_ORIGINS.includes(body.site) ? body.site : env.SITE_ORIGIN;
  const ip = req.headers.get('CF-Connecting-IP') || '';
  const now = Date.now();

  // Turnstile bot-check, only when configured.
  if (env.TURNSTILE_SECRET) {
    const ok = await turnstileOk(env, body.turnstileToken, ip);
    if (!ok) return json({ error: 'bot check failed' }, 403);
  }

  // Housekeeping + rate limits (protects the email quota from abuse).
  await env.DB.prepare('DELETE FROM login_tokens WHERE created < ?').bind(now - 24 * 3600 * 1000).run();
  const perEmail = await countSince(env, 'login_tokens', 'email', email, now - 3600 * 1000);
  const perIp = ip ? await countSince(env, 'login_tokens', 'ip', ip, now - 3600 * 1000) : 0;
  if (perEmail >= RATE_LINKS_PER_EMAIL_HOUR || perIp >= RATE_LINKS_PER_IP_HOUR) {
    return json({ error: 'too many requests, try again later' }, 429);
  }

  const token = randToken();
  await env.DB.prepare('INSERT INTO login_tokens (token, email, site, ip, created) VALUES (?,?,?,?,?)')
    .bind(token, email, site, ip, now).run();
  const link = `${url.origin}/auth/verify?token=${token}`;

  if (env.RESEND_API_KEY) {
    await sendLoginEmail(env, email, link);
    return json({ ok: true, sent: true });
  }
  // No email provider wired yet: in dev, hand the link back for testing.
  if (env.ENVIRONMENT !== 'prod') return json({ ok: true, sent: false, devLink: link });
  return json({ error: 'email sending not configured' }, 503);
}

async function authVerify(env, url) {
  const token = url.searchParams.get('token') || '';
  const now = Date.now();
  const row = await env.DB.prepare('SELECT * FROM login_tokens WHERE token=?').bind(token).first();
  if (!row || row.used || row.created < now - LINK_MS) {
    return new Response('This sign-in link is invalid or has expired. Please request a new one.',
      { status: 400, headers: { 'Content-Type': 'text/plain' } });
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE login_tokens SET used=1 WHERE token=?').bind(token),
    env.DB.prepare(
      "INSERT INTO users (email, role, created, last_login) VALUES (?, 'user', ?, ?) " +
      'ON CONFLICT(email) DO UPDATE SET last_login=excluded.last_login'
    ).bind(row.email, now, now),
    env.DB.prepare('DELETE FROM sessions WHERE expires < ?').bind(now),
  ]);
  const session = randToken();
  await env.DB.prepare('INSERT INTO sessions (token, email, created, expires) VALUES (?,?,?,?)')
    .bind(session, row.email, now, now + SESSION_MS).run();
  const dest = `${row.site || env.SITE_ORIGIN}/#session=${session}`;
  return new Response(null, { status: 302, headers: { Location: dest } });
}

async function authMe(req, env) {
  const u = await sessionUser(req, env);
  if (!u) return json({ error: 'not logged in' }, 401);
  return json({ email: u.email, name: u.name, role: u.role });
}

async function authProfile(req, env) {
  const u = await sessionUser(req, env);
  if (!u) return json({ error: 'not logged in' }, 401);
  const body = await readJson(req);
  const name = String(body.name || '').trim().slice(0, 40);
  await env.DB.prepare('UPDATE users SET name=? WHERE email=?').bind(name || null, u.email).run();
  return json({ ok: true, name: name || null });
}

async function authLogout(req, env) {
  const t = bearerToken(req);
  if (t) await env.DB.prepare('DELETE FROM sessions WHERE token=?').bind(t).run();
  return json({ ok: true });
}

/* ---------------- comments (expert) ---------------- */

async function commentsGet(env, url) {
  const uid = String(url.searchParams.get('uid') || '').trim();
  if (!uid) return json({ error: 'uid required' }, 400);
  const rows = await env.DB.prepare(
    "SELECT c.id, c.body, c.created, u.name, c.email FROM comments c " +
    "LEFT JOIN users u ON u.email=c.email WHERE c.uid=? AND c.status='approved' ORDER BY c.created"
  ).bind(uid).all();
  const out = (rows.results || []).map(r => ({
    id: r.id, body: r.body, created: r.created,
    author: r.name || maskEmail(r.email),   // never expose full emails publicly
  }));
  return json({ uid, comments: out });
}

async function commentsPost(req, env) {
  const u = await sessionUser(req, env);
  if (!u) return json({ error: 'not logged in' }, 401);
  if (u.role !== 'expert' && u.role !== 'admin') {
    return json({ error: 'comments are invite-only; send a message if you would like to contribute' }, 403);
  }
  const body = await readJson(req);
  const uid = String(body.uid || '').trim();
  const text = String(body.body || '').trim();
  if (!uid || uid.length > 64) return json({ error: 'invalid uid' }, 400);
  if (!text || text.length > MAX_BODY_LEN) return json({ error: `body must be 1–${MAX_BODY_LEN} chars` }, 400);
  const now = Date.now();
  if (await countSince(env, 'comments', 'email', u.email, now - 3600 * 1000) >= RATE_POSTS_PER_USER_HOUR) {
    return json({ error: 'too many posts, try again later' }, 429);
  }
  const r = await env.DB.prepare(
    "INSERT INTO comments (uid, email, body, created, status) VALUES (?,?,?,?,'approved')"
  ).bind(uid, u.email, text, now).run();
  return json({ ok: true, id: r.meta.last_row_id, created: now });
}

/* ---------------- messages (any user) ---------------- */

async function messagesPost(req, env) {
  const u = await sessionUser(req, env);
  if (!u) return json({ error: 'not logged in' }, 401);
  const body = await readJson(req);
  const text = String(body.body || '').trim();
  const uid = String(body.uid || '').trim().slice(0, 64) || null;
  const kind = body.kind === 'report' ? 'report' : 'general';
  if (!text || text.length > MAX_BODY_LEN) return json({ error: `body must be 1–${MAX_BODY_LEN} chars` }, 400);
  const now = Date.now();
  if (await countSince(env, 'messages', 'email', u.email, now - 3600 * 1000) >= RATE_POSTS_PER_USER_HOUR) {
    return json({ error: 'too many posts, try again later' }, 429);
  }
  const r = await env.DB.prepare(
    'INSERT INTO messages (uid, email, kind, body, created) VALUES (?,?,?,?,?)'
  ).bind(uid, u.email, kind, text, now).run();
  return json({ ok: true, id: r.meta.last_row_id });
}

/* ---------------- admin (Phil) ---------------- */

async function adminRoute(req, env, url, p, m) {
  const u = await sessionUser(req, env);
  if (!u || u.role !== 'admin') return json({ error: 'admin only' }, 403);

  if (p === '/admin/messages' && m === 'GET') {
    const status = url.searchParams.get('status');
    const q = status
      ? env.DB.prepare('SELECT * FROM messages WHERE status=? ORDER BY created DESC').bind(status)
      : env.DB.prepare('SELECT * FROM messages ORDER BY created DESC');
    return json({ messages: (await q.all()).results || [] });
  }
  if (p === '/admin/comments' && m === 'GET') {
    const uid = url.searchParams.get('uid');
    const q = uid
      ? env.DB.prepare('SELECT * FROM comments WHERE uid=? ORDER BY created DESC').bind(uid)
      : env.DB.prepare('SELECT * FROM comments ORDER BY created DESC');
    return json({ comments: (await q.all()).results || [] });
  }
  if (p === '/admin/message-status' && m === 'POST') {
    const b = await readJson(req);
    if (!['new', 'read', 'done'].includes(b.status)) return json({ error: 'bad status' }, 400);
    await env.DB.prepare('UPDATE messages SET status=? WHERE id=?').bind(b.status, b.id | 0).run();
    return json({ ok: true });
  }
  if (p === '/admin/comment-status' && m === 'POST') {
    const b = await readJson(req);
    if (!['approved', 'hidden'].includes(b.status)) return json({ error: 'bad status' }, 400);
    await env.DB.prepare('UPDATE comments SET status=? WHERE id=?').bind(b.status, b.id | 0).run();
    return json({ ok: true });
  }
  if (p === '/admin/set-role' && m === 'POST') {
    const b = await readJson(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!['user', 'expert', 'admin'].includes(b.role)) return json({ error: 'bad role' }, 400);
    const r = await env.DB.prepare('UPDATE users SET role=? WHERE email=?').bind(b.role, email).run();
    if (!r.meta.changes) return json({ error: 'no such user (they must log in once first)' }, 404);
    return json({ ok: true });
  }
  return json({ error: 'not found' }, 404);
}

/* ---------------- helpers ---------------- */

function corsHeaders(origin) {
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };
  if (ALLOWED_ORIGINS.includes(origin)) h['Access-Control-Allow-Origin'] = origin;
  return h;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'Content-Type': 'application/json' },
  });
}

async function readJson(req) {
  try { return await req.json() || {}; } catch { return {}; }
}

function bearerToken(req) {
  const m = (req.headers.get('Authorization') || '').match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : null;
}

async function sessionUser(req, env) {
  const t = bearerToken(req);
  if (!t) return null;
  const row = await env.DB.prepare(
    'SELECT s.expires, u.email, u.name, u.role FROM sessions s JOIN users u ON u.email=s.email WHERE s.token=?'
  ).bind(t).first();
  if (!row || row.expires < Date.now()) return null;
  return row;
}

async function countSince(env, table, col, val, since) {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${col}=? AND created>?`
  ).bind(val, since).first();
  return r ? r.n : 0;
}

function randToken() {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  return `${(local || '').slice(0, 2)}…@${domain || ''}`;
}

async function turnstileOk(env, token, ip) {
  if (!token) return false;
  const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
  });
  const d = await r.json().catch(() => ({}));
  return !!d.success;
}

async function sendLoginEmail(env, email, link) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: env.EMAIL_FROM || 'SeaLifeAndMore <login@sealifeandmore.com>',
      to: [email],
      subject: 'Your SeaLifeAndMore sign-in link',
      text: `Click to sign in to SeaLifeAndMore:\n\n${link}\n\n` +
            'The link works once and expires in 15 minutes. ' +
            'If you did not request this, you can ignore this email.',
    }),
  });
  if (!r.ok) throw new Error(`email send failed: ${r.status} ${await r.text()}`);
}
