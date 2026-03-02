#!/usr/bin/env node
// Convert a trot.to export to LocalGo's JSON import format.
//
// Usage:
//   node convert-trot.js export.csv          → writes golinks-import.json
//   node convert-trot.js export.json         → writes golinks-import.json
//   node convert-trot.js export.csv out.json → custom output filename
//
// Then import the result via the LocalGo dashboard → Import JSON button.

const fs   = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const inputFile  = process.argv[2];
const outputFile = process.argv[3] || 'golinks-import.json';

if (!inputFile) {
  console.error('Usage: node convert-trot.js <export.csv|export.json> [output.json]');
  process.exit(1);
}

const raw = fs.readFileSync(inputFile, 'utf8');
const ext = path.extname(inputFile).toLowerCase();

// ─── Parse ────────────────────────────────────────────────────────────────────

let rows = [];

if (ext === '.json') {
  // trot.to JSON export — try common shapes
  const data = JSON.parse(raw);
  const arr = Array.isArray(data) ? data : (data.links || data.golinks || data.data || []);
  rows = arr.map(r => ({
    short_path: r.name || r.shortlink || r.short_path || r.keyword || r.key || '',
    long_url:   r.url  || r.destination || r.long_url  || r.target  || r.dest || '',
    tags:       Array.isArray(r.tags) ? r.tags : (r.tags ? r.tags.split(',').map(t => t.trim()) : []),
    hits:       Number(r.hits || r.clicks || r.uses || 0),
    created_at: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
  }));

} else {
  // CSV — parse manually (handles quoted fields)
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim());

  // Map known trot.to column names to LocalGo fields
  const col = name => {
    const aliases = {
      short_path: ['name', 'shortlink', 'short_path', 'keyword', 'key', 'short', 'go_link', 'golink'],
      long_url:   ['url', 'destination', 'long_url', 'target', 'dest', 'link', 'redirect'],
      tags:       ['tags', 'tag', 'labels', 'categories'],
      hits:       ['hits', 'clicks', 'uses', 'count', 'views'],
      created_at: ['created_at', 'created', 'date', 'timestamp'],
    };
    for (const alias of (aliases[name] || [])) {
      const idx = headers.indexOf(alias);
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const idxPath = col('short_path');
  const idxUrl  = col('long_url');

  if (idxPath === -1 || idxUrl  === -1) {
    console.error('\nCould not find keyword/URL columns in CSV.');
    console.error('Headers found:', headers.join(', '));
    console.error('Expected columns like: name, url  or  shortlink, destination\n');
    process.exit(1);
  }

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const short_path = (cols[idxPath] || '').toLowerCase().trim();
    const long_url   = (cols[idxUrl]  || '').trim();
    if (!short_path || !long_url) continue;

    const tagsRaw = col('tags') !== -1 ? cols[col('tags')] || '' : '';
    const hitsRaw = col('hits') !== -1 ? cols[col('hits')] || '0' : '0';
    const dateRaw = col('created_at') !== -1 ? cols[col('created_at')] || '' : '';

    rows.push({
      short_path,
      long_url,
      tags: tagsRaw ? tagsRaw.split(/[,;]/).map(t => t.trim().toLowerCase()).filter(Boolean) : [],
      hits: parseInt(hitsRaw, 10) || 0,
      created_at: dateRaw ? new Date(dateRaw).getTime() || Date.now() : Date.now(),
    });
  }
}

// ─── Build LocalGo objects ────────────────────────────────────────────────────

const valid = rows.filter(r => r.short_path && /^https?:\/\/.+/.test(r.long_url));
const skipped = rows.length - valid.length;

const output = valid.map(r => ({
  id:         randomUUID(),
  short_path: r.short_path,
  long_url:   r.long_url,
  tags:       r.tags,
  aliases:    [],
  expires_at: null,
  created_at: isNaN(r.created_at) ? Date.now() : r.created_at,
  hits:       r.hits,
  last_used:  null,
  dead:       null,
}));

// ─── Write ────────────────────────────────────────────────────────────────────

fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

console.log(`\n  Converted ${output.length} link${output.length !== 1 ? 's' : ''}`);
if (skipped > 0) console.log(`  Skipped   ${skipped} (missing keyword or invalid URL)`);
console.log(`  Output  → ${outputFile}`);
console.log(`\n  Next: open http://localhost:2999 → sidebar → ↑ Import JSON → select ${outputFile}\n`);

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCsvLine(line) {
  const fields = [];
  let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields.map(f => f.trim().replace(/^"|"$/g, ''));
}
