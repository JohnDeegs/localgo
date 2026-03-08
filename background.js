// LocalGo — Background Service Worker
// The declarativeNetRequest rule in rules.json handles the http://go/* → localhost:2999/* redirect.
// This file only handles the omnibox fallback (go[Tab]keyword in address bar).

const SERVER = 'https://localgo-production.up.railway.app';

// ─── Auth ──────────────────────────────────────────────────────────────────────

function getToken() {
  return new Promise(resolve => {
    chrome.storage.local.get('goAuthToken', r => resolve(r.goAuthToken || ''));
  });
}

async function fetchLinks() {
  const token = await getToken();
  const res = await fetch(`${SERVER}/api/links`, {
    headers: { 'X-LocalGo-Token': token }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ─── Template resolution ───────────────────────────────────────────────────────
// Mirrors the server-side matchTemplate logic for client-side omnibox resolution.

function resolveTemplate(link, keyword) {
  if (!link.short_path.includes('{')) return null;
  const varNames = [];
  const regexStr = link.short_path
    .replace(/\{([^}]+)\}/g, (_, name) => { varNames.push(name); return '([^/]+)'; })
    .replace(/[.+^$[\]\\()]/g, '\\$&')
    .replace(/\//g, '\\/');
  const m = keyword.match(new RegExp('^' + regexStr + '$', 'i'));
  if (!m) return null;
  let url = link.long_url;
  varNames.forEach((name, i) => {
    url = url.split(`{${name}}`).join(encodeURIComponent(m[i + 1]));
  });
  return url;
}

// ─── Omnibox ──────────────────────────────────────────────────────────────────

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  if (!text.trim()) return;
  try {
    const links = await fetchLinks();
    const q = text.toLowerCase().trim();

    const matches = links
      .filter(l => {
        const sp = l.short_path;
        // For template links, match against the base prefix (before first {)
        const base = sp.includes('{') ? sp.slice(0, sp.indexOf('{')) : sp;
        return (
          sp.includes(q) ||
          base.startsWith(q) ||
          l.long_url.toLowerCase().includes(q) ||
          l.tags.some(t => t.includes(q)) ||
          (l.aliases || []).some(a => a.includes(q))
        );
      })
      .slice(0, 6)
      .map(l => {
        const isTemplate = l.short_path.includes('{');
        const desc = isTemplate
          ? `go/${l.short_path} \u2192 ${l.long_url}`
          : `go/${l.short_path} \u2192 ${l.long_url}`;
        return { content: l.short_path, description: desc };
      });

    suggest(matches);
  } catch {
    suggest([{
      content: '__dashboard__',
      description: 'LocalGo server is not running \u2014 start it with: node server/server.js'
    }]);
  }
});

chrome.omnibox.onInputEntered.addListener(async (text) => {
  const keyword = text.trim().toLowerCase();

  if (!keyword || keyword === '__dashboard__') {
    chrome.tabs.update({ url: `${SERVER}/` });
    return;
  }

  try {
    const links = await fetchLinks();

    // 1. Exact match
    let link = links.find(l => l.short_path === keyword);
    if (link) { chrome.tabs.update({ url: link.long_url }); return; }

    // 2. Alias match
    link = links.find(l => (l.aliases || []).includes(keyword));
    if (link) { chrome.tabs.update({ url: link.long_url }); return; }

    // 3. Template match
    for (const l of links) {
      const resolved = resolveTemplate(l, keyword);
      if (resolved) { chrome.tabs.update({ url: resolved }); return; }
    }

    // Not found — open dashboard with prefilled keyword
    chrome.tabs.update({ url: `${SERVER}/?notfound=${encodeURIComponent(keyword)}` });
  } catch {
    chrome.tabs.update({ url: `${SERVER}/` });
  }
});

// ─── Initialization ───────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  // Nothing to initialize — data lives in the server's links.json
  console.log('LocalGo extension installed. Start the server: node server/server.js');
});
