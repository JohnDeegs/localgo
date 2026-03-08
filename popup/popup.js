// LocalGo — Popup Script

const SERVER = 'https://localgo-production.up.railway.app';

// ─── DOM ─────────────────────────────────────────────────────────────────────

const keywordInput       = document.getElementById('keyword-input');
const urlInput           = document.getElementById('url-input');
const tagsInput          = document.getElementById('tags-input');
const createBtn          = document.getElementById('create-btn');
const conflictBanner     = document.getElementById('conflict-banner');
const conflictPathLabel  = document.getElementById('conflict-path-label');
const overwriteBtn       = document.getElementById('overwrite-btn');
const cancelOverwriteBtn = document.getElementById('cancel-overwrite-btn');
const openDashboardBtn   = document.getElementById('open-dashboard');
const toast              = document.getElementById('toast');
const serverWarning      = document.getElementById('server-warning');

const aiStrip         = document.getElementById('ai-strip');
const aiLoading       = document.getElementById('ai-loading');
const aiResult        = document.getElementById('ai-result');
const aiKeywordBtn    = document.getElementById('ai-keyword-btn');
const aiTagsContainer = document.getElementById('ai-tags-container');

let allLinks = [];
let conflictLink = null;
let debounceTimer = null;
let authToken = '';

// ─── Authenticated fetch helper ───────────────────────────────────────────────

function apiFetch(path, options = {}) {
  return fetch(`${SERVER}${path}`, {
    ...options,
    headers: {
      'X-LocalGo-Token': authToken,
      ...(options.headers || {})
    }
  });
}

// ─── Gemini Nano (Chrome built-in AI) ────────────────────────────────────────

async function nanoAvailable() {
  try {
    if (!window.ai?.languageModel) return false;
    const status = await window.ai.languageModel.availability();
    return status === 'readily' || status === 'after-download';
  } catch {
    return false;
  }
}

async function suggestFromPage(title, url, desc, h1) {
  const session = await window.ai.languageModel.create({
    systemPrompt: 'You are a URL classifier. Respond with valid JSON only, no markdown, no explanation.'
  });

  const context = [
    title && `Title: ${title}`,
    url   && `URL: ${url}`,
    desc  && `Description: ${desc.slice(0, 300)}`,
    h1    && `H1: ${h1.slice(0, 200)}`
  ].filter(Boolean).join('\n');

  const prompt = `${context}\n\nSuggest 3 short lowercase tags and a concise go-link keyword (lowercase, hyphens only, max 20 chars, no stop words).\nJSON: {"keyword":"...","tags":["...","...","..."]}`;

  const raw = await session.prompt(prompt);
  session.destroy();

  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  const parsed = JSON.parse(match[0]);
  if (!parsed.keyword || !Array.isArray(parsed.tags)) return null;
  return parsed;
}

async function runAISuggestions(tab) {
  if (!(await nanoAvailable())) return;
  if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  // Show loading state
  aiStrip.classList.remove('hidden');
  aiLoading.classList.remove('hidden');
  aiResult.classList.add('hidden');

  try {
    // Extract meta description and H1 from the page
    let desc = '', h1 = '';
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          desc: document.querySelector('meta[name="description"]')?.content || '',
          h1:   document.querySelector('h1')?.innerText?.slice(0, 200) || ''
        })
      });
      desc = result?.desc || '';
      h1   = result?.h1   || '';
    } catch {
      // scripting may fail on some pages — proceed with title/URL only
    }

    const suggestion = await suggestFromPage(tab.title || '', tab.url, desc, h1);
    if (!suggestion) { aiStrip.classList.add('hidden'); return; }

    // Show result
    aiLoading.classList.add('hidden');
    aiResult.classList.remove('hidden');

    aiKeywordBtn.textContent = suggestion.keyword;
    aiKeywordBtn.onclick = () => {
      keywordInput.value = suggestion.keyword;
      checkConflict();
    };

    aiTagsContainer.innerHTML = suggestion.tags.map(tag =>
      `<button class="ai-tag-chip bg-indigo-100 text-indigo-700 px-1.5 py-0.5 rounded hover:bg-indigo-200 transition-colors border border-indigo-300 font-mono">${tag}</button>`
    ).join('');

    aiTagsContainer.querySelectorAll('.ai-tag-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const existing = tagsInput.value.split(',').map(t => t.trim()).filter(Boolean);
        if (!existing.includes(chip.textContent)) {
          tagsInput.value = [...existing, chip.textContent].join(', ');
        }
        chip.classList.add('opacity-50');
        chip.disabled = true;
      });
    });
  } catch {
    aiStrip.classList.add('hidden');
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  // Fetch token from health endpoint (open, no auth needed)
  // Then fetch links using the token
  try {
    const health = await fetch(`${SERVER}/api/health`).then(r => r.json());
    authToken = health.token;
    // Cache token in extension storage for background.js omnibox use
    await chrome.storage.local.set({ goAuthToken: authToken });

    allLinks = await apiFetch('/api/links').then(r => r.json());
    serverWarning.classList.add('hidden');
    createBtn.disabled = false;
  } catch {
    serverWarning.classList.remove('hidden');
    createBtn.disabled = true;
    return;
  }

  // Pre-fill URL from current tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
    urlInput.value = tab.url;
    if (tab.title) {
      const slug = tab.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
      if (slug) keywordInput.placeholder = slug;
    }
  }

  keywordInput.focus();

  // Fire AI suggestions in background (non-blocking)
  if (tab) runAISuggestions(tab);
});

// ─── Conflict Detection ───────────────────────────────────────────────────────

keywordInput.addEventListener('input', () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(checkConflict, 250);
});

function checkConflict() {
  const path = keywordInput.value.trim().toLowerCase();
  if (!path) { hideConflict(); return; }

  const existing = allLinks.find(l => l.short_path === path);
  if (existing) {
    conflictLink = existing;
    conflictPathLabel.textContent = path;
    conflictBanner.classList.remove('hidden');
    createBtn.disabled = true;
  } else {
    conflictLink = null;
    hideConflict();
  }
}

function hideConflict() {
  conflictBanner.classList.add('hidden');
  createBtn.disabled = false;
  conflictLink = null;
}

// ─── Validation ───────────────────────────────────────────────────────────────

function validate() {
  const keyword = keywordInput.value.trim();
  const url     = urlInput.value.trim();

  if (!keyword) { shake(keywordInput); return false; }
  if (!/^https?:\/\/.+/.test(url)) { shake(urlInput); return false; }
  return true;
}

function shake(el) {
  el.classList.add('shake', 'border-red-400');
  el.addEventListener('animationend', () => el.classList.remove('shake', 'border-red-400'), { once: true });
}

// ─── Save ─────────────────────────────────────────────────────────────────────

async function save() {
  const short_path = keywordInput.value.trim().toLowerCase();
  const long_url   = urlInput.value.trim();
  const tags       = tagsInput.value.split(',').map(t => t.trim().toLowerCase()).filter(Boolean);

  try {
    await apiFetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ short_path, long_url, tags })
    });
    showToast();
    setTimeout(() => window.close(), 900);
  } catch {
    serverWarning.classList.remove('hidden');
  }
}

// ─── Events ───────────────────────────────────────────────────────────────────

createBtn.addEventListener('click', async () => {
  if (!validate()) return;
  await save();
});

overwriteBtn.addEventListener('click', async () => {
  if (!validate()) return;
  await save();
});

cancelOverwriteBtn.addEventListener('click', () => {
  keywordInput.value = '';
  hideConflict();
  keywordInput.focus();
});

openDashboardBtn.addEventListener('click', () => {
  chrome.tabs.create({ url: `${SERVER}/` });
});

keywordInput.addEventListener('keydown', e => { if (e.key === 'Enter' && !createBtn.disabled) createBtn.click(); });
urlInput.addEventListener('keydown',     e => { if (e.key === 'Enter' && !createBtn.disabled) createBtn.click(); });

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast() {
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 800);
}
