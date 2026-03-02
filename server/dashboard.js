// LocalGo — Dashboard (served from local server)
// Data is fetched from the REST API at /api/links

const API = '';  // relative URLs — same origin as the server

const STALE_MS         = 90 * 24 * 60 * 60 * 1000; // 90 days
const EXPIRING_SOON_MS =  7 * 24 * 60 * 60 * 1000; // 7 days

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function api(method, path, body) {
  const opts = {
    method,
    headers: {
      'X-LocalGo-Token': window.GO_AUTH_TOKEN || '',
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  };
  const res = await fetch(API + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

const getLinks    = ()           => api('GET',    '/api/links');
const createLink  = (link)       => api('POST',   '/api/links', link);
const updateLink  = (id, link)   => api('PUT',    `/api/links/${id}`, link);
const deleteLink  = (id)         => api('DELETE', `/api/links/${id}`);
const healthCheck = (ids)        => api('POST',   '/api/health-check', ids ? { ids } : {});

// ─── AI Summary Peek (Gemini Nano Summarizer API) ────────────────────────────

const summaryCache = new Map();   // url → summary string | null

async function nanoSummarizerAvailable() {
  try {
    if (!window.ai?.summarizer) return false;
    const status = await window.ai.summarizer.availability();
    return status === 'readily' || status === 'after-download';
  } catch {
    return false;
  }
}

async function getSummary(url) {
  if (summaryCache.has(url)) return summaryCache.get(url);
  if (!(await nanoSummarizerAvailable())) { summaryCache.set(url, null); return null; }

  try {
    const data = await api('GET', `/api/fetch-preview?url=${encodeURIComponent(url)}`);
    if (!data?.text) { summaryCache.set(url, null); return null; }

    const summarizer = await window.ai.summarizer.create({ type: 'tl;dr', length: 'short' });
    const summary = await summarizer.summarize(data.text.slice(0, 2800));
    summarizer.destroy();
    summaryCache.set(url, summary || null);
    return summary || null;
  } catch {
    summaryCache.set(url, null);
    return null;
  }
}

// Single shared tooltip element, positioned via JS
let peekTooltip = null;
let peekTimer   = null;

function getTooltip() {
  if (!peekTooltip) {
    peekTooltip = document.createElement('div');
    peekTooltip.id = 'peek-tooltip';
    peekTooltip.style.cssText = [
      'position:fixed', 'z-index:9999', 'max-width:360px',
      'background:#1e293b', 'border:1px solid #334155',
      'color:#cbd5e1', 'font-size:0.75rem', 'line-height:1.5',
      'padding:10px 14px', 'border-radius:10px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.6)',
      'pointer-events:none', 'opacity:0', 'transition:opacity 0.15s',
      'white-space:pre-wrap', 'word-break:break-word'
    ].join(';');
    document.body.appendChild(peekTooltip);
  }
  return peekTooltip;
}

function showTooltip(text, anchorEl) {
  const tip = getTooltip();
  tip.textContent = text;
  const r = anchorEl.getBoundingClientRect();
  tip.style.left = Math.min(r.left, window.innerWidth - 380) + 'px';
  tip.style.top  = (r.bottom + 6) + 'px';
  tip.style.opacity = '1';
}

function hideTooltip() {
  if (peekTooltip) peekTooltip.style.opacity = '0';
}

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  links: [],
  filter: { tag: null, search: '', expired: false },
  selected: new Set()
};

// ─── Computed ────────────────────────────────────────────────────────────────

function getFiltered() {
  return state.links
    .filter(l => !state.filter.tag || l.tags.includes(state.filter.tag))
    .filter(l => {
      if (state.filter.expired) return l.expires_at && Date.now() > l.expires_at;
      return true;
    })
    .filter(l => {
      const q = state.filter.search.toLowerCase();
      if (!q) return true;
      return l.short_path.includes(q)
        || l.long_url.toLowerCase().includes(q)
        || l.tags.some(t => t.includes(q))
        || (l.aliases || []).some(a => a.includes(q));
    })
    .sort((a, b) => b.created_at - a.created_at);
}

function getAllTags() {
  const s = new Set();
  state.links.forEach(l => l.tags.forEach(t => s.add(t)));
  return [...s].sort();
}

// ─── Utilities ───────────────────────────────────────────────────────────────

function relativeTime(ts) {
  const d = Date.now() - ts;
  const m = Math.floor(d / 60000), h = Math.floor(d / 3600000), days = Math.floor(d / 86400000);
  if (m < 2)   return 'just now';
  if (m < 60)  return `${m}m ago`;
  if (h < 24)  return `${h}h ago`;
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseTags(str) {
  return str.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);
}

function parseAliases(str) {
  return str.split(',').map(a => a.trim().toLowerCase().replace(/^go\//i, '')).filter(Boolean);
}

function truncate(str, max = 48) {
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = '✓ ' + msg;
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), 2400);
}

function showError(msg) {
  const b = document.getElementById('error-banner');
  b.textContent = '⚠ ' + msg;
  b.classList.remove('hidden');
  setTimeout(() => b.classList.add('hidden'), 5000);
}

// Format a timestamp as a local date string for <input type="date">
function tsToDateInput(ts) {
  if (!ts) return '';
  return new Date(ts).toISOString().slice(0, 10);
}

// Convert a date input string to a timestamp (end of day, local time)
function dateInputToTs(str) {
  if (!str) return null;
  const d = new Date(str);
  if (isNaN(d)) return null;
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// ─── Row status helpers ───────────────────────────────────────────────────────

function isStale(link) {
  if (link.last_used) return Date.now() - link.last_used > STALE_MS;
  return Date.now() - link.created_at > STALE_MS;
}

function expiryStatus(link) {
  if (!link.expires_at) return null;
  const now = Date.now();
  if (now > link.expires_at) return 'expired';
  if (link.expires_at - now < EXPIRING_SOON_MS) return 'soon';
  return 'ok';
}

// Render {var} placeholders in a short_path with amber styling
function renderShortPath(short_path) {
  return esc(short_path).replace(/\{([^}]+)\}/g,
    (_, v) => `<span class="text-amber-500">{${esc(v)}}</span>`);
}

// ─── Render ──────────────────────────────────────────────────────────────────

function render() {
  renderSidebar();
  renderList();
  renderBulkBar();
}

function renderSidebar() {
  const sidebar = document.getElementById('tag-sidebar');
  const tags = getAllTags();
  const active = state.filter.tag;
  const expiredCount = state.links.filter(l => l.expires_at && Date.now() > l.expires_at).length;

  sidebar.innerHTML = [
    `<button class="tag-pill text-left ${!active && !state.filter.expired ? 'active' : ''}" data-tag="__all__">All links</button>`,
    expiredCount > 0
      ? `<button class="tag-pill text-left ${state.filter.expired ? 'active' : ''}" data-tag="__expired__">Expired <span class="ml-1 text-red-400">${expiredCount}</span></button>`
      : '',
    ...tags.map(t => `<button class="tag-pill text-left ${active === t ? 'active' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`)
  ].join('');

  sidebar.querySelectorAll('[data-tag]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tag === '__expired__') {
        state.filter.tag = null;
        state.filter.expired = true;
      } else {
        state.filter.expired = false;
        state.filter.tag = btn.dataset.tag === '__all__' ? null : btn.dataset.tag;
      }
      state.selected.clear();
      render();
    });
  });
}

function renderList() {
  const listEl   = document.getElementById('links-list');
  const emptyEl  = document.getElementById('empty-state');
  const noResEl  = document.getElementById('no-results');
  const countEl  = document.getElementById('link-count');
  const selectAll = document.getElementById('select-all');

  const filtered = getFiltered();

  countEl.textContent = `${filtered.length} / ${state.links.length} link${state.links.length !== 1 ? 's' : ''}`;

  if (state.links.length === 0) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    noResEl.classList.add('hidden');
    return;
  }
  emptyEl.classList.add('hidden');

  if (filtered.length === 0) {
    listEl.innerHTML = '';
    noResEl.classList.remove('hidden');
    return;
  }
  noResEl.classList.add('hidden');

  listEl.innerHTML = filtered.map(rowHTML).join('');

  // Select-all state
  const allSel = filtered.every(l => state.selected.has(l.id));
  selectAll.checked = allSel;
  selectAll.indeterminate = !allSel && filtered.some(l => state.selected.has(l.id));

  // Per-row events
  listEl.querySelectorAll('[data-id]').forEach(row => {
    const id = row.dataset.id;

    row.querySelector('.row-cb').addEventListener('change', e => {
      e.target.checked ? state.selected.add(id) : state.selected.delete(id);
      renderBulkBar();
      const f = getFiltered();
      selectAll.indeterminate = state.selected.size > 0 && state.selected.size < f.length;
      selectAll.checked = f.every(l => state.selected.has(l.id));
    });
    row.querySelector('.row-cb').checked = state.selected.has(id);

    row.querySelector('.copy-short')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText('go/' + row.dataset.path);
      showToast('Copied go/' + row.dataset.path);
    });

    row.querySelector('.copy-url')?.addEventListener('click', async () => {
      await navigator.clipboard.writeText(row.dataset.url);
      showToast('URL copied');
    });

    // Action menu
    const menuBtn = row.querySelector('.menu-btn');
    const menu = row.querySelector('.dropdown-menu');
    menuBtn.addEventListener('click', e => {
      e.stopPropagation();
      document.querySelectorAll('.dropdown-menu').forEach(m => { if (m !== menu) m.classList.add('hidden'); });
      menu.classList.toggle('hidden');
    });

    row.querySelector('.edit-btn').addEventListener('click', () => {
      menu.classList.add('hidden');
      startEdit(id);
    });
    row.querySelector('.delete-btn').addEventListener('click', () => {
      menu.classList.add('hidden');
      confirmDelete(id);
    });

    // Summary Peek — hover the URL anchor for 600ms to trigger AI summary
    const urlAnchor = row.querySelector('a[href]');
    if (urlAnchor) {
      urlAnchor.addEventListener('mouseenter', () => {
        clearTimeout(peekTimer);
        peekTimer = setTimeout(async () => {
          const summary = await getSummary(row.dataset.url);
          if (summary) showTooltip(summary, urlAnchor);
        }, 600);
      });
      urlAnchor.addEventListener('mouseleave', () => {
        clearTimeout(peekTimer);
        hideTooltip();
      });
    }
  });
}

function rowHTML(link) {
  const tags = link.tags.map(t =>
    `<span class="inline-block px-1.5 py-0.5 bg-gray-800 text-gray-500 rounded text-xs mono border border-gray-700/60">${esc(t)}</span>`
  ).join(' ');

  const aliases = (link.aliases || []).map(a =>
    `<span class="inline-block px-1.5 py-0.5 bg-gray-800/60 text-gray-600 rounded text-xs mono border border-gray-700/40 italic">=${esc(a)}</span>`
  ).join(' ');

  // Status badges
  const badges = [];
  if (link.dead === true) {
    badges.push(`<span class="badge bg-red-950 text-red-400 border border-red-800/60">dead</span>`);
  }
  const exp = expiryStatus(link);
  if (exp === 'expired') {
    badges.push(`<span class="badge bg-red-950 text-red-400 border border-red-800/60">expired</span>`);
  } else if (exp === 'soon') {
    const d = new Date(link.expires_at).toLocaleDateString();
    badges.push(`<span class="badge bg-amber-950 text-amber-400 border border-amber-800/60" title="Expires ${d}">expires soon</span>`);
  }
  if (isStale(link) && link.dead !== true) {
    badges.push(`<span class="badge bg-gray-800 text-gray-600 border border-gray-700/40">stale</span>`);
  }

  const lastUsedTitle = link.last_used
    ? `Last used ${new Date(link.last_used).toLocaleString()}`
    : 'Never used';

  return `
    <div class="link-row flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-gray-800/40 transition-colors group border border-transparent hover:border-gray-700/40"
         data-id="${esc(link.id)}" data-path="${esc(link.short_path)}" data-url="${esc(link.long_url)}">
      <input type="checkbox" class="row-cb flex-shrink-0" />
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="mono font-semibold text-sm">
            <span class="text-indigo-500">go/</span><span class="text-gray-100">${renderShortPath(link.short_path)}</span>
          </span>
          <button class="copy-short text-gray-700 hover:text-gray-400 transition-colors opacity-0 group-hover:opacity-100" title="Copy go/${esc(link.short_path)}">
            <svg class="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                    d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
            </svg>
          </button>
          ${badges.join('')}
        </div>
        <div class="flex items-center gap-1 mt-0.5 flex-wrap">${tags}${aliases ? ' ' + aliases : ''}</div>
      </div>
      <div class="flex items-center gap-1.5" style="width:320px">
        <a href="${esc(link.long_url)}" target="_blank"
           class="truncate-url text-gray-500 text-xs hover:text-indigo-400 transition-colors mono"
           title="${esc(link.long_url)}">${esc(truncate(link.long_url))}</a>
        <button class="copy-url text-gray-700 hover:text-gray-400 transition-colors opacity-0 group-hover:opacity-100 flex-shrink-0" title="Copy URL">
          <svg class="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                  d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"/>
          </svg>
        </button>
      </div>
      <span class="text-gray-600 text-xs w-20 text-right flex-shrink-0 tabular-nums">${link.hits} visit${link.hits !== 1 ? 's' : ''}</span>
      <span class="text-gray-700 text-xs w-28 text-right flex-shrink-0" title="${lastUsedTitle}">${relativeTime(link.created_at)}</span>
      <div class="relative w-8 flex-shrink-0">
        <button class="menu-btn row-actions text-gray-600 hover:text-gray-200 transition-colors p-1 rounded hover:bg-gray-700/60" title="Actions">
          <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 6a2 2 0 110-4 2 2 0 010 4zm0 8a2 2 0 110-4 2 2 0 010 4zm0 8a2 2 0 110-4 2 2 0 010 4z"/>
          </svg>
        </button>
        <div class="dropdown-menu hidden">
          <button class="edit-btn">✏️ Edit</button>
          <button class="delete-btn danger">🗑 Delete</button>
        </div>
      </div>
    </div>`;
}

function renderBulkBar() {
  const bar = document.getElementById('bulk-bar');
  const cnt = document.getElementById('bulk-count');
  document.getElementById('bulk-tag-count').textContent = state.selected.size;
  if (state.selected.size > 0) {
    cnt.textContent = `${state.selected.size} selected`;
    bar.classList.remove('hidden');
    bar.classList.add('flex');
  } else {
    bar.classList.add('hidden');
    bar.classList.remove('flex');
  }
}

// ─── Inline Edit ─────────────────────────────────────────────────────────────

function startEdit(id) {
  const link = state.links.find(l => l.id === id);
  if (!link) return;
  const row = document.querySelector(`[data-id="${CSS.escape(id)}"]`);
  if (!row) return;

  row.outerHTML = `
    <div class="flex flex-col gap-2 px-4 py-3 rounded-xl bg-gray-800/80 border border-indigo-500/60 fade-in" data-edit-id="${esc(id)}">
      <div class="flex items-center gap-2">
        <span class="mono text-indigo-500 text-sm flex-shrink-0">go/</span>
        <input class="ei-path bg-gray-700 rounded-lg px-2 py-1 text-white mono text-sm outline-none focus:ring-1 focus:ring-indigo-500 w-40"
               value="${esc(link.short_path)}" placeholder="keyword or keyword/{var}" />
        <span class="text-gray-600 text-sm flex-shrink-0">→</span>
        <input class="ei-url bg-gray-700 rounded-lg px-2 py-1 text-gray-200 text-sm outline-none focus:ring-1 focus:ring-indigo-500 flex-1 min-w-0"
               value="${esc(link.long_url)}" />
        <input class="ei-tags bg-gray-700 rounded-lg px-2 py-1 text-gray-400 mono text-sm outline-none focus:ring-1 focus:ring-indigo-500 w-28"
               placeholder="tags" value="${esc(link.tags.join(', '))}" />
        <button class="ei-save px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-500 transition-colors">Save</button>
        <button class="ei-cancel px-3 py-1.5 bg-gray-700 text-gray-200 rounded-lg text-xs hover:bg-gray-600 transition-colors">Cancel</button>
      </div>
      <div class="flex items-center gap-3 text-xs pl-12">
        <span class="text-gray-600 flex-shrink-0">aliases:</span>
        <input class="ei-aliases bg-gray-700 rounded-lg px-2 py-1 text-gray-400 mono text-xs outline-none focus:ring-1 focus:ring-indigo-500 w-48"
               placeholder="mail, inbox" value="${esc((link.aliases || []).join(', '))}" />
        <span class="text-gray-600 flex-shrink-0 ml-2">expires:</span>
        <input class="ei-expires bg-gray-700 rounded-lg px-2 py-1 text-gray-400 text-xs outline-none focus:ring-1 focus:ring-indigo-500"
               type="date" value="${esc(tsToDateInput(link.expires_at))}" />
        <button class="ei-clear-expires text-gray-600 hover:text-gray-400 text-xs transition-colors">clear</button>
      </div>
    </div>`;

  const editRow = document.querySelector(`[data-edit-id="${CSS.escape(id)}"]`);
  editRow.querySelector('.ei-path').focus();

  editRow.querySelector('.ei-clear-expires').addEventListener('click', () => {
    editRow.querySelector('.ei-expires').value = '';
  });

  editRow.querySelector('.ei-save').addEventListener('click', async () => {
    const newPath    = editRow.querySelector('.ei-path').value.trim().toLowerCase();
    const newUrl     = editRow.querySelector('.ei-url').value.trim();
    const newTags    = parseTags(editRow.querySelector('.ei-tags').value);
    const newAliases = parseAliases(editRow.querySelector('.ei-aliases').value);
    const newExpires = dateInputToTs(editRow.querySelector('.ei-expires').value);

    if (!newPath || !/^https?:\/\/.+/.test(newUrl)) {
      showError('Please fill in a valid keyword and URL (must start with http:// or https://).');
      return;
    }
    try {
      const updated = await updateLink(id, {
        short_path: newPath, long_url: newUrl, tags: newTags,
        aliases: newAliases, expires_at: newExpires
      });
      const idx = state.links.findIndex(l => l.id === id);
      if (idx !== -1) state.links[idx] = updated;
      render();
      showToast(`go/${newPath} updated`);
    } catch (e) {
      showError('Failed to update: ' + e.message);
    }
  });

  editRow.querySelector('.ei-cancel').addEventListener('click', () => render());
  editRow.querySelector('.ei-path').addEventListener('keydown', e => { if (e.key === 'Escape') render(); });
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

async function handleCreate(keywordEl, urlEl, tagsEl, aliasesEl, expiresEl) {
  const short_path = keywordEl.value.trim().toLowerCase();
  const long_url   = urlEl.value.trim();
  const tags       = parseTags(tagsEl.value);
  const aliases    = parseAliases(aliasesEl ? aliasesEl.value : '');
  const expires_at = dateInputToTs(expiresEl ? expiresEl.value : '');

  if (!short_path) { keywordEl.focus(); showError('Keyword is required.'); return; }
  if (!/^https?:\/\/.+/.test(long_url)) { urlEl.focus(); showError('Please enter a valid URL starting with http:// or https://'); return; }

  const existing = state.links.find(l => l.short_path === short_path);
  if (existing && !confirm(`go/${short_path} already exists. Overwrite?`)) return;

  try {
    const link = await createLink({ short_path, long_url, tags, aliases, expires_at });
    state.links = state.links.filter(l => l.short_path !== short_path);
    state.links.push(link);
    keywordEl.value = '';
    urlEl.value = '';
    tagsEl.value = '';
    if (aliasesEl) aliasesEl.value = '';
    if (expiresEl) expiresEl.value = '';
    keywordEl.focus();
    render();
    showToast(`go/${short_path} saved`);
  } catch (e) {
    showError('Failed to create: ' + e.message);
  }
}

async function confirmDelete(id) {
  const link = state.links.find(l => l.id === id);
  if (!link || !confirm(`Delete go/${link.short_path}?`)) return;
  try {
    await deleteLink(id);
    state.links = state.links.filter(l => l.id !== id);
    state.selected.delete(id);
    render();
    showToast(`go/${link.short_path} deleted`);
  } catch (e) {
    showError('Failed to delete: ' + e.message);
  }
}

async function bulkDelete() {
  if (!state.selected.size) return;
  if (!confirm(`Delete ${state.selected.size} link${state.selected.size !== 1 ? 's' : ''}?`)) return;
  try {
    await Promise.all([...state.selected].map(id => deleteLink(id)));
    state.links = state.links.filter(l => !state.selected.has(l.id));
    state.selected.clear();
    render();
    showToast('Links deleted');
  } catch (e) {
    showError('Failed to delete: ' + e.message);
  }
}

async function bulkAddTag(tag) {
  tag = tag.trim().toLowerCase();
  if (!tag) return;
  try {
    const updates = [...state.selected].map(id => {
      const link = state.links.find(l => l.id === id);
      if (!link) return null;
      const newTags = [...new Set([...link.tags, tag])];
      return updateLink(id, { tags: newTags }).then(updated => {
        const idx = state.links.findIndex(l => l.id === id);
        if (idx !== -1) state.links[idx] = updated;
      });
    }).filter(Boolean);
    await Promise.all(updates);
    render();
    showToast(`Tag "${tag}" added`);
  } catch (e) {
    showError('Failed to add tag: ' + e.message);
  }
}

// ─── Health Check ─────────────────────────────────────────────────────────────

async function runHealthCheck() {
  const btn = document.getElementById('health-check-btn');
  btn.textContent = '⬡ Checking…';
  btn.disabled = true;
  try {
    await healthCheck();
    state.links = await getLinks();
    render();
    const dead = state.links.filter(l => l.dead === true).length;
    showToast(dead > 0 ? `Health check done — ${dead} dead link${dead !== 1 ? 's' : ''}` : 'Health check done — all links OK');
  } catch (e) {
    showError('Health check failed: ' + e.message);
  } finally {
    btn.textContent = '⬡ Check all links';
    btn.disabled = false;
  }
}

// ─── Export / Import ─────────────────────────────────────────────────────────

function exportLinks() {
  const blob = new Blob([JSON.stringify(state.links, null, 2)], { type: 'application/json' });
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob), download: 'golinks.json'
  });
  a.click();
  URL.revokeObjectURL(a.href);
}

async function importLinks(file) {
  let imported;
  try { imported = JSON.parse(await file.text()); } catch { showError('Invalid JSON file.'); return; }
  if (!Array.isArray(imported)) { showError('Expected a JSON array.'); return; }

  const valid = imported
    .filter(l => l.short_path && l.long_url)
    .map(l => ({
      short_path: l.short_path.toLowerCase().trim(),
      long_url:   l.long_url.trim(),
      tags:       Array.isArray(l.tags) ? l.tags : [],
      aliases:    Array.isArray(l.aliases) ? l.aliases : [],
      expires_at: l.expires_at || null,
      created_at: l.created_at || Date.now(),
      hits:       l.hits || 0
    }));

  if (!valid.length) { showError('No valid links found in file.'); return; }

  try {
    const created = await Promise.all(valid.map(l => createLink(l)));
    state.links = await getLinks();
    render();
    showToast(`Imported ${created.length} link${created.length !== 1 ? 's' : ''}`);
  } catch (e) {
    showError('Import failed: ' + e.message);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Load links
  try {
    state.links = await getLinks();
  } catch {
    showError('Cannot connect to LocalGo server. Is it running? → node server/server.js');
  }
  render();

  // Handle not-found keyword — can arrive via injected window.GO_NOTFOUND (server)
  // or via ?notfound= query param (omnibox handler in background.js)
  const notfound = window.GO_NOTFOUND || new URLSearchParams(location.search).get('notfound');
  if (notfound) {
    const banner = document.getElementById('notfound-banner');
    document.getElementById('notfound-path').textContent = `go/${notfound}`;
    banner.classList.remove('hidden');
    document.getElementById('new-keyword').value = notfound;
    document.getElementById('new-url').focus();
    history.replaceState({}, '', '/');
  }

  // Handle expired keyword — arrives via injected window.GO_EXPIRED (server)
  if (window.GO_EXPIRED) {
    const banner = document.getElementById('expired-banner');
    document.getElementById('expired-path').textContent = `go/${window.GO_EXPIRED}`;
    banner.classList.remove('hidden');
    // Pre-fill keyword and scroll to the matching link
    const match = state.links.find(l => l.short_path === window.GO_EXPIRED);
    if (match) startEdit(match.id);
  }

  // Header create form
  const kw      = document.getElementById('new-keyword');
  const url     = document.getElementById('new-url');
  const tags    = document.getElementById('new-tags');
  const aliases = document.getElementById('new-aliases');
  const expires = document.getElementById('new-expires');
  document.getElementById('header-create-btn').addEventListener('click', () => handleCreate(kw, url, tags, aliases, expires));
  [kw, url, tags, aliases].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') handleCreate(kw, url, tags, aliases, expires); }));

  // Search
  let st;
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(st);
    st = setTimeout(() => { state.filter.search = e.target.value.toLowerCase(); render(); }, 150);
  });

  // Select-all
  document.getElementById('select-all').addEventListener('change', e => {
    getFiltered().forEach(l => e.target.checked ? state.selected.add(l.id) : state.selected.delete(l.id));
    render();
  });

  // Bulk actions
  document.getElementById('bulk-delete-btn').addEventListener('click', bulkDelete);
  document.getElementById('bulk-tag-btn').addEventListener('click', () => {
    document.getElementById('bulk-tag-modal').classList.remove('hidden');
    document.getElementById('bulk-tag-input').value = '';
    document.getElementById('bulk-tag-input').focus();
  });
  document.getElementById('bulk-tag-cancel').addEventListener('click', () =>
    document.getElementById('bulk-tag-modal').classList.add('hidden'));
  document.getElementById('bulk-tag-confirm').addEventListener('click', async () => {
    const tag = document.getElementById('bulk-tag-input').value;
    document.getElementById('bulk-tag-modal').classList.add('hidden');
    await bulkAddTag(tag);
  });
  document.getElementById('bulk-tag-input').addEventListener('keydown', e => {
    if (e.key === 'Enter')  document.getElementById('bulk-tag-confirm').click();
    if (e.key === 'Escape') document.getElementById('bulk-tag-cancel').click();
  });
  document.getElementById('bulk-tag-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });

  // Health check
  document.getElementById('health-check-btn').addEventListener('click', runHealthCheck);

  // Export / Import
  document.getElementById('export-btn').addEventListener('click', exportLinks);
  document.getElementById('import-file').addEventListener('change', e => {
    if (e.target.files[0]) importLinks(e.target.files[0]);
    e.target.value = '';
  });

  // Close dropdowns on outside click
  document.addEventListener('click', () =>
    document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden')));

  // Help / Documentation modal
  document.getElementById('help-btn').addEventListener('click', () => {
    document.getElementById('help-modal').classList.remove('hidden');
  });
  document.getElementById('help-close').addEventListener('click', () => {
    document.getElementById('help-modal').classList.add('hidden');
  });
  document.getElementById('help-modal').addEventListener('click', e => {
    if (e.target === e.currentTarget) e.currentTarget.classList.add('hidden');
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('help-modal').classList.contains('hidden'))
      document.getElementById('help-modal').classList.add('hidden');
  });
  document.querySelectorAll('.help-nav-link').forEach(a => {
    a.addEventListener('click', () => {
      const target  = document.getElementById(a.dataset.target);
      const content = document.getElementById('help-content');
      if (target && content) content.scrollTo({ top: target.offsetTop - 24, behavior: 'smooth' });
    });
  });
});
