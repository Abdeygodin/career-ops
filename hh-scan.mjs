#!/usr/bin/env node
/**
 * hh-scan.mjs — hh.ru vacancy scanner via public RSS feed (no API key, no auth)
 *
 * Uses hh.ru/search/vacancy/rss — a public endpoint that requires no token,
 * no registered app, and no special User-Agent. Returns standard RSS/XML.
 *
 * Usage:
 *   node hh-scan.mjs
 *   node hh-scan.mjs --dry-run
 *   node hh-scan.mjs --area 1          override HH_AREA for this run
 *   node hh-scan.mjs --period 3        days to look back (default 1)
 *   node hh-scan.mjs --pages 3         RSS pages to fetch per area (default 2)
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

try {
  const { config } = await import('dotenv');
  config();
} catch { /* dotenv optional */ }

const ROOT = dirname(fileURLToPath(import.meta.url));

// ── Paths (same contract as scan.mjs) ────────────────────────────
const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
const PIPELINE_PATH     = join(ROOT, 'data', 'pipeline.md');
const APPLICATIONS_PATH = join(ROOT, 'data', 'applications.md');
const PORTALS_PATH      = join(ROOT, 'portals.yml');
const PROFILE_PATH      = join(ROOT, 'config', 'profile.yml');

const HH_RSS_BASE = 'https://hh.ru/search/vacancy/rss';
const AREA_ENV    = process.env.HH_AREA || '1,2';

// ── CLI ──────────────────────────────────────────────────────────
const cliArgs    = process.argv.slice(2);
const dryRun     = cliArgs.includes('--dry-run');
const areaArg    = cliArgs.indexOf('--area')     !== -1 ? cliArgs[cliArgs.indexOf('--area')     + 1] : null;
const periodArg  = cliArgs.indexOf('--period')   !== -1 ? cliArgs[cliArgs.indexOf('--period')   + 1] : '1';
const pagesArg   = cliArgs.indexOf('--pages')    !== -1 ? parseInt(cliArgs[cliArgs.indexOf('--pages')    + 1]) : 2;
const keywordsArg     = cliArgs.indexOf('--keywords')        !== -1 ? cliArgs[cliArgs.indexOf('--keywords')        + 1] : null;
const negativeArg     = cliArgs.indexOf('--negative')        !== -1 ? cliArgs[cliArgs.indexOf('--negative')        + 1] : null;
const scheduleArg     = cliArgs.indexOf('--schedule')        !== -1 ? cliArgs[cliArgs.indexOf('--schedule')        + 1] : null;
const noTitleFilter   = cliArgs.includes('--no-title-filter');

// ── RSS XML parser (no deps) ──────────────────────────────────────

function extractTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim() : null;
}

// hh.ru packs company/location/salary inside <description> CDATA as HTML paragraphs:
//   <p>Вакансия компании: NAME</p>
//   <p>Регион: CITY</p>
//   <p>Предполагаемый уровень месячного дохода: SALARY</p>
function extractFromDesc(descHtml, prefix) {
  const m = descHtml.match(new RegExp(`<p>${prefix}\\s*([^<]+)<\\/p>`, 'i'));
  return m ? m[1].trim() : '';
}

function parseRssItems(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const title = extractTag(block, 'title');
    const link  = extractTag(block, 'link')?.trim().replace(/\?.*$/, '');
    if (!title || !link || !link.startsWith('http')) continue;

    const desc     = extractTag(block, 'description') || '';
    const company  = extractFromDesc(desc, 'Вакансия компании:') || 'Unknown';
    const location = extractFromDesc(desc, 'Регион:');
    const salary   = extractFromDesc(desc, 'Предполагаемый уровень месячного дохода:');

    items.push({ title, url: link, company, location, salary });
  }
  return items;
}

// ── Title filter (mirrors scan.mjs logic) ────────────────────────
// Applied AFTER RSS fetch because hh.ru does full-text search —
// broad OR queries match job descriptions, not just titles.

function buildTitleFilter(portalsConfig, overridePositive, overrideNegative) {
  const tf       = portalsConfig?.title_filter || {};
  const positive = (overridePositive || tf.positive || []).map(k => k.toLowerCase());
  const negative = (overrideNegative || tf.negative || []).map(k => k.toLowerCase());
  return (title) => {
    const lower       = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Fetch one RSS page ────────────────────────────────────────────

async function fetchRssPage(searchText, area, page, period, schedule) {
  const params = new URLSearchParams({
    text:     searchText,
    area:     area,
    period:   period,
    per_page: '20',
    page:     String(page),
    order_by: 'publication_time',
  });
  if (schedule) params.set('schedule', schedule);

  const url = `${HH_RSS_BASE}?${params}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; career-ops/1.0)',
      'Accept':     'application/rss+xml, text/xml, */*',
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) throw new Error(`hh.ru RSS returned HTTP ${res.status} for area=${area}`);
  return res.text();
}

// ── Dedup helpers (identical to scan.mjs) ────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    for (const line of readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    for (const m of readFileSync(PIPELINE_PATH, 'utf-8').matchAll(/- \[[ x]\] (\S+)/g)) {
      seen.add(m[1]);
    }
  }
  if (existsSync(APPLICATIONS_PATH)) {
    for (const m of readFileSync(APPLICATIONS_PATH, 'utf-8').matchAll(/https?:\/\/[^\s|)]+/g)) {
      seen.add(m[0]);
    }
  }
  return seen;
}

function appendToPipeline(offers) {
  if (offers.length === 0) return;
  if (!existsSync(PIPELINE_PATH)) {
    writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }
  let text = readFileSync(PIPELINE_PATH, 'utf-8');
  const marker = '## Pendientes';
  const idx    = text.indexOf(marker);
  const block  = '\n' + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n';
  if (idx === -1) {
    text += `\n${marker}${block}`;
  } else {
    const nextSection = text.indexOf('\n## ', idx + marker.length);
    const insertAt = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }
  const lines = offers.map(o =>
    `${o.url}\t${date}\thh-rss\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Build search queries from portals.yml / profile.yml ──────────
// Returns an array of queries — each runs as a separate RSS request.
// hh.ru RSS caps at 20 items/page. One big OR query wastes all 80 slots
// on description matches; N focused queries get 80 relevant results each.

function buildSearchQueries(overrideKeywords) {
  let keywords = [];

  // CLI override takes highest priority (from web UI or direct invocation)
  if (overrideKeywords && overrideKeywords.length > 0) {
    keywords = overrideKeywords;
  } else if (existsSync(PORTALS_PATH)) {
    try {
      const portals = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
      keywords = portals?.title_filter?.positive || [];
    } catch { /* fall through */ }
  }

  if (keywords.length === 0 && existsSync(PROFILE_PATH)) {
    try {
      const profile = yaml.load(readFileSync(PROFILE_PATH, 'utf-8'));
      keywords = profile?.target_roles?.primary || [];
    } catch { /* fall through */ }
  }

  if (keywords.length === 0) {
    return ['DevSecOps', 'AppSec', '"Security Engineer"'];
  }

  // Wrap multi-word keywords in quotes so hh.ru matches the phrase, not individual words.
  // Single-word terms are sent as-is (hh.ru title-boosts exact matches).
  // Group pairs of short synonyms to halve the number of API calls.
  const quoted = keywords.map(k => k.includes(' ') ? `"${k}"` : k);

  // Pair adjacent keywords to stay under ~12 API calls total
  const queries = [];
  for (let i = 0; i < quoted.length; i += 2) {
    if (i + 1 < quoted.length) {
      queries.push(`${quoted[i]} OR ${quoted[i + 1]}`);
    } else {
      queries.push(quoted[i]);
    }
  }
  return queries;
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  mkdirSync(join(ROOT, 'data'), { recursive: true });

  const areas    = (areaArg || AREA_ENV).split(',').map(s => s.trim()).filter(Boolean);
  const cliKw    = keywordsArg ? keywordsArg.split('|').map(k => k.trim()).filter(Boolean) : null;
  const cliNeg   = negativeArg ? negativeArg.split('|').map(k => k.trim()).filter(Boolean) : null;
  const queries  = buildSearchQueries(cliKw);
  const date     = new Date().toISOString().slice(0, 10);

  console.log(`\nhh.ru scan (RSS) — ${date}`);
  console.log(`Areas: ${areas.join(', ')}  |  Period: ${periodArg}d  |  Pages/query: ${pagesArg}  |  Queries: ${queries.length}${scheduleArg ? `  |  Schedule: ${scheduleArg}` : ''}`);
  if (dryRun) console.log('(dry run — no files will be written)');
  console.log('');

  // Load title filter — CLI overrides take priority over portals.yml
  let portalsConfig = {};
  if (existsSync(PORTALS_PATH)) {
    try { portalsConfig = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {}; } catch {}
  }
  // When user provides explicit keywords (web UI), skip title filter — the RSS query is already specific.
  const titleFilter = noTitleFilter ? () => true : buildTitleFilter(portalsConfig, cliKw, cliNeg);

  const seenUrls  = loadSeenUrls();
  const newOffers = [];
  let totalFound    = 0;
  let totalFiltered = 0;
  let totalDupes    = 0;
  const errors    = [];

  for (const area of areas) {
    for (const query of queries) {
      process.stdout.write(`  ⟳  ${query.slice(0, 50)}${query.length > 50 ? '…' : ''}`);
      let queryFound = 0;

      for (let page = 0; page < pagesArg; page++) {
        let xml;
        try {
          xml = await fetchRssPage(query, area, page, periodArg, scheduleArg);
        } catch (err) {
          errors.push(`area=${area} query="${query}" page=${page}: ${err.message}`);
          break;
        }

        const items = parseRssItems(xml);
        totalFound  += items.length;
        queryFound  += items.length;
        if (items.length === 0) break;

        for (const item of items) {
          if (!titleFilter(item.title)) { totalFiltered++; continue; }
          if (seenUrls.has(item.url))   { totalDupes++;    continue; }
          seenUrls.add(item.url);
          newOffers.push(item);
        }

        if (page < pagesArg - 1) await new Promise(r => setTimeout(r, 600));
      }

      process.stdout.write(`\r  ✓  ${query.slice(0, 50)}${query.length > 50 ? '…' : ''} (${queryFound})\n`);
      // pause between queries to be polite
      await new Promise(r => setTimeout(r, 800));
    }
  }

  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  console.log(`${'━'.repeat(45)}`);
  console.log(`hh.ru RSS Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Total found:       ${totalFound}`);
  console.log(`Filtered by title: ${totalFiltered} removed`);
  console.log(`Duplicates:        ${totalDupes} skipped`);
  console.log(`New offers added:  ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e}`);
  }

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      const salary = o.salary && o.salary !== 'не указан' ? ` | ${o.salary}` : '';
      console.log(`  + ${o.company} | ${o.title}${o.location ? ' | ' + o.location : ''}${salary}`);
    }
    if (!dryRun) {
      console.log(`\nResults saved to data/pipeline.md and data/scan-history.tsv`);
    } else {
      console.log('\n(dry run — run without --dry-run to save)');
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
