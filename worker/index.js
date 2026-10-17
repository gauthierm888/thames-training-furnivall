// Cloudflare Worker (Workers + static assets): serves the game files from ../site, adds security headers, and provides the shared-scores API.
// Scores are kept in a Cloudflare D1 database bound to this Worker as "DB" (see ../wrangler.jsonc, ../README.md and ../database/schema.sql).
// Without the binding the API answers 503 and the game keeps its boards in the player's own browser.

const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "connect-src 'self' https://environment.data.gov.uk; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const BOATS = ['1x', '2x', '4x', '8+'];
const MAX_BODY = 2000;
const MAX_SPEED = 9.5; // m/s: faster than any boat in the game can go (8+ at 40 spm with a 1.3 m/s stream)

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
const int = (v, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : null);

// Checks a submitted result and rebuilds the score on the server, so the score cannot be typed in directly.
// (The counts themselves still come from the player's browser: this stops sloppy tampering, not a determined cheat.)
function validateScore(b) {
  if (!b || typeof b !== 'object') return { error: 'bad body' };
  const name = String(b.name ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 20) || 'Rower';
  const time = typeof b.time_s === 'number' && Number.isFinite(b.time_s) ? Math.round(b.time_s * 10) / 10 : null;
  const v = {
    dist: int(b.dist_m, 0, 100000), pen: int(b.pen, 0, 500), hits: int(b.hits, 0, 200), aground: int(b.aground, 0, 200),
    clean: int(b.clean, 0, 100), bad: int(b.bad, 0, 100),
  };
  if (time === null || time < 0 || time > 36000 || Object.values(v).some((x) => x === null)) return { error: 'out of range' };
  if (typeof b.ul !== 'boolean' || !BOATS.includes(b.boat)) return { error: 'bad fields' };
  const penaltyTime = 5 * v.pen + 5 * v.bad + 15 * (v.hits + v.aground); // time the game adds for penalties
  if (time + 0.5 < penaltyTime) return { error: 'implausible' };
  if (v.dist > (time - penaltyTime) * MAX_SPEED + 200) return { error: 'implausible' };
  const score = Math.max(0, Math.round(v.dist / 2) + (b.ul ? 1000 : 0) + 100 * v.clean - 100 * v.bad - 50 * v.pen - 150 * (v.hits + v.aground) - Math.round(time / 10));
  const chaos = 10 * v.hits + 8 * v.aground + 6 * v.bad + 3 * v.pen;
  return { row: { name, score, time_s: time, dist_m: v.dist, ul: b.ul ? 1 : 0, pen: v.pen, hits: v.hits, aground: v.aground, clean: v.clean, bad: v.bad, boat: b.boat, chaos } };
}

const COLS = 'id, name, score, time_s, dist_m, ul, pen, hits, aground, clean, bad, boat, chaos';

async function handleScores(request, env, url) {
  if (!env.DB) return json({ error: 'database not connected' }, 503);
  if (request.method === 'GET') {
    const [best, worst] = await env.DB.batch([
      env.DB.prepare(`SELECT ${COLS} FROM scores ORDER BY score DESC, id ASC LIMIT 10`),
      env.DB.prepare(`SELECT ${COLS} FROM scores WHERE chaos > 0 ORDER BY chaos DESC, score ASC, id ASC LIMIT 10`),
    ]);
    return json({ best: best.results, worst: worst.results });
  }
  if (request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'forbidden' }, 403); // only this site may post scores
    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'too large' }, 413);
    let body;
    try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400); }
    const { row, error } = validateScore(body);
    if (error) return json({ error }, 422);
    const r = await env.DB.prepare(
      'INSERT INTO scores (name, score, time_s, dist_m, ul, pen, hits, aground, clean, bad, boat, chaos) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).bind(row.name, row.score, row.time_s, row.dist_m, row.ul, row.pen, row.hits, row.aground, row.clean, row.bad, row.boat, row.chaos).run();
    return json({ id: r.meta.last_row_id, score: row.score }, 201);
  }
  return json({ error: 'method not allowed' }, 405);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    let res;
    if (url.pathname === '/api/scores') {
      try { res = await handleScores(request, env, url); } catch (e) { res = json({ error: 'server error' }, 500); }
      res.headers.set('Cache-Control', 'no-store');
    } else {
      res = await env.ASSETS.fetch(request);
    }
    const out = new Response(res.body, res);
    out.headers.set('Content-Security-Policy', CSP);
    out.headers.set('X-Content-Type-Options', 'nosniff');
    out.headers.set('Referrer-Policy', 'no-referrer');
    out.headers.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
    return out;
  },
};
