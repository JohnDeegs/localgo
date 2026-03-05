// LocalGo — Local Server
// Run with: node server/server.js
// Dashboard: http://localhost:2999  (or http://go/ if hosts file is configured)

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');
const { randomUUID } = require('crypto');

const PORT      = Number(process.env.PORT) || 2999;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'links.json');

const TOKEN_FILE     = path.join(__dirname, 'auth-token.txt');
const DASHBOARD_HTML = path.join(__dirname, 'dashboard.html');
const DASHBOARD_JS   = path.join(__dirname, 'dashboard.js');
const LOGIN_HTML     = path.join(__dirname, 'login.html');
const FAVICON_SVG    = path.join(__dirname, 'favicon.svg');

// ─── Auth Token ───────────────────────────────────────────────────────────────
// Generated once on first run and persisted to auth-token.txt.
// Never commit this file — add it to .gitignore.

function loadToken() {
  if (process.env.AUTH_TOKEN) return process.env.AUTH_TOKEN;
  if (!fs.existsSync(TOKEN_FILE)) {
    const token = randomUUID();
    fs.writeFileSync(TOKEN_FILE, token, 'utf8');
    console.log(`  Auth token created → ${TOKEN_FILE}`);
    return token;
  }
  return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
}

const AUTH_TOKEN = loadToken();

// ─── Data Helpers ─────────────────────────────────────────────────────────────

function loadLinks() {
  if (!fs.existsSync(DATA_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveLinks(links) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(links, null, 2));
}

// ─── Request Helpers ──────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/x-www-form-urlencoded')) {
        resolve(Object.fromEntries(new URLSearchParams(body)));
        return;
      }
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

// Allowed CORS origins: the dashboard itself and the Chrome extension
function setCors(res, reqOrigin) {
  const allowed = [
    'http://localhost:2999',
    'http://127.0.0.1:2999',
    process.env.PUBLIC_URL,
  ].filter(Boolean);
  const origin = (allowed.includes(reqOrigin) || /^chrome-extension:\/\//.test(reqOrigin))
    ? reqOrigin
    : allowed[0];
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-LocalGo-Token');
  res.setHeader('Vary', 'Origin');
}

function sendJson(res, data, status = 200, reqOrigin = '') {
  setCors(res, reqOrigin);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Serve an HTML file, optionally injecting a <script> block before </head>
function serveHtml(res, filePath, inject = '') {
  try {
    let html = fs.readFileSync(filePath, 'utf8');
    if (inject) html = html.replace('</head>', inject + '\n</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ─── Security Guards ──────────────────────────────────────────────────────────

// Cookie helpers — used for dashboard session auth
function parseCookies(req) {
  return Object.fromEntries(
    (req.headers.cookie || '').split(';')
      .map(c => c.trim().split('='))
      .filter(p => p.length >= 2)
      .map(([k, ...v]) => [k.trim(), decodeURIComponent(v.join('=').trim())])
  );
}
function isAuthenticated(req) {
  return parseCookies(req).session === AUTH_TOKEN;
}

// Layer 1 — Host header validation (blocks DNS rebinding)
// In cloud mode (AUTH_TOKEN env var set), token auth alone is sufficient.
// Locally, validate that the Host header is localhost to block DNS rebinding.
function isValidHost(req) {
  if (process.env.AUTH_TOKEN) return true;
  const host = req.headers['host'] || '';
  return host === `localhost:${PORT}` || host === `127.0.0.1:${PORT}`;
}

// Layer 2 — Token check
function isValidToken(req) {
  return req.headers['x-localgo-token'] === AUTH_TOKEN;
}

// Combined guard for all API routes (except /api/health)
function guardApi(req, res) {
  const origin = req.headers['origin'] || '';
  if (!isValidHost(req)) {
    sendJson(res, { error: 'Forbidden: invalid host' }, 403, origin);
    return false;
  }
  if (!isValidToken(req)) {
    sendJson(res, { error: 'Unauthorized: missing or invalid token' }, 401, origin);
    return false;
  }
  return true;
}

// ─── Template Matching ────────────────────────────────────────────────────────
// Matches dynamic links like "jira/{id}" or "gh/{org}/{repo}" against a keyword.
// Returns { link, resolvedUrl } or null.

function matchTemplate(links, keyword) {
  for (const link of links) {
    if (!link.short_path.includes('{')) continue;
    const varNames = [];
    // Each {varname} segment matches one path component (no slashes)
    const regexStr = link.short_path
      .replace(/\{([^}]+)\}/g, (_, name) => { varNames.push(name); return '([^/]+)'; })
      .replace(/[.+^$[\]\\()]/g, '\\$&')  // escape regex special chars (except / and *)
      .replace(/\//g, '\\/');
    const m = keyword.match(new RegExp('^' + regexStr + '$', 'i'));
    if (m) {
      let url = link.long_url;
      varNames.forEach((name, i) => {
        url = url.split(`{${name}}`).join(encodeURIComponent(m[i + 1]));
      });
      return { link, resolvedUrl: url };
    }
  }
  return null;
}

// ─── Page Text Fetcher (for AI Summary Peek) ──────────────────────────────────

function fetchPageText(url) {
  return new Promise((resolve, reject) => {
    try {
      const mod = url.startsWith('https') ? https : http;
      let body = '';
      const req = mod.get(url, { headers: { 'User-Agent': 'LocalGo/1.0' }, timeout: 5000 }, r => {
        r.setEncoding('utf8');
        r.on('data', d => { body += d; if (body.length > 60000) req.destroy(); });
        r.on('end', () => {
          const text = body
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ').trim().slice(0, 3000);
          resolve(text);
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    } catch (e) {
      reject(e);
    }
  });
}

// ─── Dead Link Checker ────────────────────────────────────────────────────────

function checkUrl(url) {
  return new Promise(resolve => {
    try {
      const mod = url.startsWith('https') ? https : http;
      const req = mod.request(url, { method: 'HEAD', timeout: 5000 }, r => {
        resolve(r.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    } catch {
      resolve(false);
    }
  });
}

// ─── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const method = req.method;
  const urlPath = req.url.split('?')[0];
  const origin  = req.headers['origin'] || '';

  // CORS preflight
  if (method === 'OPTIONS') {
    setCors(res, origin);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── Login / Logout (password-protected dashboard) ─────────────────────────

  if (urlPath === '/login') {
    if (method === 'GET') {
      serveHtml(res, LOGIN_HTML);
      return;
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD || '';
      if (DASHBOARD_PASSWORD && body.password === DASHBOARD_PASSWORD) {
        const isCloud = !!process.env.AUTH_TOKEN;
        res.writeHead(302, {
          'Set-Cookie': `session=${AUTH_TOKEN}; HttpOnly; Path=/; SameSite=Strict;${isCloud ? ' Secure;' : ''} Max-Age=2592000`,
          'Location': '/'
        });
      } else {
        res.writeHead(302, { 'Location': '/login?error=1' });
      }
      res.end();
      return;
    }
  }

  if (urlPath === '/logout' && method === 'POST') {
    res.writeHead(302, {
      'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0',
      'Location': '/login'
    });
    res.end();
    return;
  }

  // ── Static files (no auth — these are just HTML/JS assets) ──

  if (urlPath === '/' || urlPath === '/index.html') {
    // If password protection is enabled, require a valid session cookie
    if (process.env.DASHBOARD_PASSWORD && !isAuthenticated(req)) {
      res.writeHead(302, { 'Location': '/login' });
      res.end();
      return;
    }
    // Inject token so dashboard JS can authenticate API calls
    serveHtml(res, DASHBOARD_HTML,
      `<script>window.GO_AUTH_TOKEN=${JSON.stringify(AUTH_TOKEN)};</script>`);
    return;
  }

  if (urlPath === '/dashboard.js') {
    if (process.env.DASHBOARD_PASSWORD && !isAuthenticated(req)) {
      res.writeHead(403); res.end('Forbidden');
      return;
    }
    try {
      res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8' });
      res.end(fs.readFileSync(DASHBOARD_JS));
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  if (urlPath === '/favicon.svg') {
    try {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(fs.readFileSync(FAVICON_SVG));
    } catch {
      res.writeHead(404); res.end('Not found');
    }
    return;
  }

  // ── Health check (open — no token required, safe since bound to 127.0.0.1) ──
  // Returns the token so the extension popup can bootstrap itself.

  if (urlPath === '/api/health' && method === 'GET') {
    sendJson(res, { ok: true, port: PORT, token: AUTH_TOKEN }, 200, origin);
    return;
  }

  // ── Guarded API routes ────────────────────────────────────────────────────
  // All routes below require a valid Host header AND auth token.

  if (urlPath === '/api/links' && method === 'GET') {
    if (!guardApi(req, res)) return;
    sendJson(res, loadLinks(), 200, origin);
    return;
  }

  if (urlPath === '/api/links' && method === 'POST') {
    if (!guardApi(req, res)) return;
    const body = await readBody(req);
    if (!body.short_path || !body.long_url) {
      sendJson(res, { error: 'short_path and long_url are required' }, 400, origin);
      return;
    }

    const links = loadLinks();
    const short_path = body.short_path.toLowerCase().trim();
    const existingIdx = links.findIndex(l => l.short_path === short_path);
    const linkObj = {
      id:         existingIdx !== -1 ? links[existingIdx].id : randomUUID(),
      short_path,
      long_url:   body.long_url.trim(),
      tags:       Array.isArray(body.tags) ? body.tags : [],
      aliases:    Array.isArray(body.aliases) ? body.aliases.map(a => a.toLowerCase().trim()).filter(Boolean) : [],
      expires_at: body.expires_at || null,
      created_at: existingIdx !== -1 ? links[existingIdx].created_at : (body.created_at || Date.now()),
      hits:       body.hits !== undefined ? Number(body.hits) : (existingIdx !== -1 ? links[existingIdx].hits : 0),
      last_used:  existingIdx !== -1 ? links[existingIdx].last_used : null,
      dead:       existingIdx !== -1 ? links[existingIdx].dead : null,
    };

    if (existingIdx !== -1) links[existingIdx] = linkObj;
    else links.push(linkObj);

    saveLinks(links);
    sendJson(res, linkObj, 201, origin);
    return;
  }

  // PUT /api/links/:id
  const putMatch = urlPath.match(/^\/api\/links\/([^/]+)$/);
  if (putMatch && method === 'PUT') {
    if (!guardApi(req, res)) return;
    const id = putMatch[1];
    const body = await readBody(req);
    const links = loadLinks();
    const idx = links.findIndex(l => l.id === id);
    if (idx === -1) { sendJson(res, { error: 'Not found' }, 404, origin); return; }

    const newPath = body.short_path ? body.short_path.toLowerCase().trim() : links[idx].short_path;
    const newAliases = Array.isArray(body.aliases)
      ? body.aliases.map(a => a.toLowerCase().trim()).filter(Boolean)
      : links[idx].aliases || [];

    // If short_path changed, remove any other link with that path
    if (body.short_path && newPath !== links[idx].short_path) {
      const conflict = links.findIndex(l => l.short_path === newPath && l.id !== id);
      if (conflict !== -1) links.splice(conflict, 1);
    }

    const finalIdx = links.findIndex(l => l.id === id);
    links[finalIdx] = {
      ...links[finalIdx],
      ...body,
      id,
      short_path: newPath,
      aliases: newAliases,
      expires_at: 'expires_at' in body ? (body.expires_at || null) : links[finalIdx].expires_at,
    };

    saveLinks(links);
    sendJson(res, links.find(l => l.id === id), 200, origin);
    return;
  }

  // DELETE /api/links/:id
  const deleteMatch = urlPath.match(/^\/api\/links\/([^/]+)$/);
  if (deleteMatch && method === 'DELETE') {
    if (!guardApi(req, res)) return;
    const id = deleteMatch[1];
    const links = loadLinks();
    const filtered = links.filter(l => l.id !== id);
    if (filtered.length === links.length) { sendJson(res, { error: 'Not found' }, 404, origin); return; }
    saveLinks(filtered);
    sendJson(res, { ok: true }, 200, origin);
    return;
  }

  // GET /api/fetch-preview?url=... — fetches page text for AI Summary Peek (guarded)
  if (urlPath === '/api/fetch-preview' && method === 'GET') {
    if (!guardApi(req, res)) return;
    const targetUrl = new URL(req.url, `http://localhost:${PORT}`).searchParams.get('url');
    if (!targetUrl) { sendJson(res, { error: 'url param required' }, 400, origin); return; }
    fetchPageText(targetUrl)
      .then(text => sendJson(res, { text }, 200, origin))
      .catch(() => sendJson(res, { text: '' }, 200, origin));
    return;
  }

  // POST /api/health-check — checks dead/alive status of links via HEAD request
  if (urlPath === '/api/health-check' && method === 'POST') {
    if (!guardApi(req, res)) return;
    const body = await readBody(req);
    const links = loadLinks();
    const targets = Array.isArray(body.ids)
      ? links.filter(l => body.ids.includes(l.id))
      : links;

    const results = await Promise.all(targets.map(async link => {
      // Skip template links (URL has unresolved {vars})
      if (link.long_url.includes('{')) return { id: link.id, dead: null, skipped: true };
      const alive = await checkUrl(link.long_url);
      link.dead = !alive;
      return { id: link.id, dead: !alive };
    }));

    saveLinks(links);
    sendJson(res, results, 200, origin);
    return;
  }

  // ── Go link redirect (unauthenticated — only exposes a 302, no data) ──

  if (method === 'GET' && !urlPath.startsWith('/api/')) {
    const keyword = urlPath.replace(/^\//, '').toLowerCase().trim();

    if (!keyword) {
      if (process.env.DASHBOARD_PASSWORD && !isAuthenticated(req)) {
        res.writeHead(302, { 'Location': '/login' });
        res.end();
        return;
      }
      serveHtml(res, DASHBOARD_HTML,
        `<script>window.GO_AUTH_TOKEN=${JSON.stringify(AUTH_TOKEN)};</script>`);
      return;
    }

    const links = loadLinks();

    // 1. Exact match on short_path
    let link = links.find(l => l.short_path === keyword);
    let resolvedUrl = link ? link.long_url : null;

    // 2. Alias match
    if (!link) {
      link = links.find(l => (l.aliases || []).includes(keyword));
      if (link) resolvedUrl = link.long_url;
    }

    // 3. Template match
    let templateMatch = null;
    if (!link) {
      templateMatch = matchTemplate(links, keyword);
      if (templateMatch) {
        link = templateMatch.link;
        resolvedUrl = templateMatch.resolvedUrl;
      }
    }

    if (link) {
      // Expiry check
      if (link.expires_at && Date.now() > link.expires_at) {
        serveHtml(res, DASHBOARD_HTML,
          `<script>window.GO_AUTH_TOKEN=${JSON.stringify(AUTH_TOKEN)};window.GO_EXPIRED=${JSON.stringify(keyword)};</script>`);
        return;
      }

      link.hits = (link.hits || 0) + 1;
      link.last_used = Date.now();
      saveLinks(links);
      res.writeHead(302, { 'Location': resolvedUrl });
      res.end();
    } else {
      serveHtml(res, DASHBOARD_HTML,
        `<script>window.GO_AUTH_TOKEN=${JSON.stringify(AUTH_TOKEN)};window.GO_NOTFOUND=${JSON.stringify(keyword)};</script>`);
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  LocalGo server running\n`);
  console.log(`  Dashboard → http://localhost:${PORT}`);
  console.log(`  go/ links → http://localhost:${PORT}/<keyword>\n`);
  console.log(`  To use go/keyword in the address bar:`);
  console.log(`    1. Add to hosts file: 127.0.0.1    go`);
  console.log(`    2. Reload the LocalGo Chrome extension`);
  console.log(`\n  Press Ctrl+C to stop\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Error: Port ${PORT} is already in use.`);
    console.error(`  Another instance may already be running.\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
