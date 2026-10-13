// Development-only CORS proxy so the browser preview (`npm run web`) can reach Yahoo.  The phone app never uses it.
//   node scripts/dev-proxy.js        -> http://localhost:8787/q1/... = https://query1.finance.yahoo.com/...
const http = require('http');

const TARGETS = { q1: 'https://query1.finance.yahoo.com', q2: 'https://query2.finance.yahoo.com', fc: 'https://fc.yahoo.com' };
let cookie = '';   // Yahoo's session cookie, kept here because the browser will not send a cross-site one

http.createServer(async (req, res) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const [, key, ...rest] = req.url.split('/');
  const base = TARGETS[key];
  if (!base) { res.writeHead(404, cors); return res.end('unknown target'); }
  try {
    const r = await fetch(base + '/' + rest.join('/'), { headers: { 'User-Agent': 'Mozilla/5.0', ...(cookie ? { Cookie: cookie } : {}) }, redirect: 'manual' });
    const set = r.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const body = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { ...cors, 'Content-Type': r.headers.get('content-type') || 'application/json' });
    res.end(body);
  } catch (e) {
    res.writeHead(502, cors);
    res.end(String(e));
  }
}).listen(8787, () => console.log('dev proxy on http://localhost:8787'));
