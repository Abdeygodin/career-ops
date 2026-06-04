#!/usr/bin/env node
/**
 * habr-scan.mjs — career.habr.com vacancy scanner via Playwright
 *
 * Хабр Карьера не предоставляет публичный API, поэтому используем Playwright
 * для загрузки страницы вакансий и извлечения списка.
 *
 * Usage:
 *   node habr-scan.mjs
 *   node habr-scan.mjs --dry-run
 *   node habr-scan.mjs --pages 2
 *
 * Requires Playwright chromium: npx playwright install chromium
 *
 * Dedup and pipeline format identical to scan.mjs and hh-scan.mjs.
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

// ── Paths (same as scan.mjs / hh-scan.mjs) ──────────────────────
const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
const PIPELINE_PATH     = join(ROOT, 'data', 'pipeline.md');
const APPLICATIONS_PATH = join(ROOT, 'data', 'applications.md');
const PORTALS_PATH      = join(ROOT, 'portals.yml');

// ── Config ───────────────────────────────────────────────────────
const HABR_BASE = 'https://career.habr.com/vacancies';

// ── CLI ──────────────────────────────────────────────────────────
const cliArgs    = process.argv.slice(2);
const dryRun     = cliArgs.includes('--dry-run');
const pagesArg   = cliArgs.indexOf('--pages')    !== -1 ? parseInt(cliArgs[cliArgs.indexOf('--pages')    + 1]) : 2;
const keywordsArg = cliArgs.indexOf('--keywords') !== -1 ? cliArgs[cliArgs.indexOf('--keywords') + 1] : null;
const negativeArg = cliArgs.indexOf('--negative') !== -1 ? cliArgs[cliArgs.indexOf('--negative') + 1] : null;

// ── Dedup helpers (identical to hh-scan.mjs) ────────────────────

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
  const idx = text.indexOf(marker);
  const block = '\n' + offers.map(o => `- [ ] ${o.url} | ${o.company} | ${o.title}`).join('\n') + '\n';
  if (idx === -1) {
    text += `\n${marker}${block}`;
  } else {
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
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
    `${o.url}\t${date}\thabr-career\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Build search query from CLI args or portals.yml ─────────────

function buildSearchQuery(overridePositive) {
  if (overridePositive && overridePositive.length > 0) {
    // Habr q= takes a plain query — use first term; multiple terms run as separate passes
    return overridePositive[0];
  }
  if (existsSync(PORTALS_PATH)) {
    try {
      const portals = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
      const positive = portals?.title_filter?.positive || [];
      if (positive.length > 0) return positive[0];
    } catch { /* fall through */ }
  }
  return 'DevSecOps';
}

// ── Title filter (mirrors hh-scan.mjs / scan.mjs logic) ─────────

function buildTitleFilter(overridePositive, overrideNegative) {
  let tfPositive = overridePositive;
  let tfNegative = overrideNegative;

  if (!tfPositive || !tfNegative) {
    let tf = {};
    if (existsSync(PORTALS_PATH)) {
      try { tf = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'))?.title_filter || {}; } catch {}
    }
    tfPositive = tfPositive || tf.positive || [];
    tfNegative = tfNegative || tf.negative || [];
  }

  const positive = tfPositive.map(k => k.toLowerCase());
  const negative = tfNegative.map(k => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const hasPositive = positive.length === 0 || positive.some(k => lower.includes(k));
    const hasNegative = negative.some(k => lower.includes(k));
    return hasPositive && !hasNegative;
  };
}

// ── Main ─────────────────────────────────────────────────────────

async function main() {
  mkdirSync(join(ROOT, 'data'), { recursive: true });

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.error('❌  Playwright not installed. Run: npx playwright install chromium');
    process.exit(1);
  }

  const execPath = chromium.executablePath();
  if (!existsSync(execPath)) {
    console.error('❌  Playwright Chromium not installed. Run: npx playwright install chromium');
    process.exit(1);
  }

  // Parse CLI keyword overrides (pipe-separated, same format as hh-scan)
  const cliPositive = keywordsArg ? keywordsArg.split('|').map(s => s.trim()).filter(Boolean) : null;
  const cliNegative = negativeArg ? negativeArg.split('|').map(s => s.trim()).filter(Boolean) : null;

  // Each positive keyword becomes a separate search query (same strategy as hh-scan)
  const queries = cliPositive && cliPositive.length > 0
    ? cliPositive
    : [buildSearchQuery(null)];

  const titleFilter = buildTitleFilter(cliPositive, cliNegative);
  const date        = new Date().toISOString().slice(0, 10);
  const seenUrls    = loadSeenUrls();
  const newOffers   = [];
  let totalFound    = 0;
  let totalDupes    = 0;
  let totalFiltered = 0;

  console.log(`\nХабр Карьера scan — ${date}`);
  console.log(`Queries: ${queries.join(', ')}  |  Pages per query: ${pagesArg}`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();

    for (const searchQuery of queries) {
      console.log(`\n▶ Query: "${searchQuery}"`);

      for (let p = 1; p <= pagesArg; p++) {
        const url = `${HABR_BASE}?q=${encodeURIComponent(searchQuery)}&type=all&sort=date&page=${p}`;
        console.log(`  Fetching page ${p}: ${url}`);

        try {
          await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
        } catch (err) {
          console.warn(`  ⚠️  Page ${p} failed to load: ${err.message}`);
          break;
        }

        const items = await page.evaluate(() => {
          const cards = document.querySelectorAll('.vacancy-card');
          return Array.from(cards).map(card => {
            const titleEl   = card.querySelector('.vacancy-card__title a') ||
                              card.querySelector('a[href*="/vacancies/"]');
            const companyEl = card.querySelector('.vacancy-card__company-title') ||
                              card.querySelector('.company-name') ||
                              card.querySelector('[class*="company"]') ||
                              card.querySelector('a[href*="/companies/"]') ||
                              card.querySelector('a[href*="/company/"]');
            const locationEl = card.querySelector('.vacancy-card__meta') ||
                               card.querySelector('[class*="location"]') ||
                               card.querySelector('.location');

            const href = titleEl?.getAttribute('href') || '';
            const fullUrl = href.startsWith('http') ? href : `https://career.habr.com${href}`;
            return {
              url:      fullUrl,
              title:    titleEl?.textContent?.trim() || '',
              company:  companyEl?.textContent?.trim() || '',
              location: locationEl?.textContent?.trim() || '',
            };
          }).filter(i => i.url && i.title);
        });

        totalFound += items.length;
        if (items.length === 0) {
          console.log(`  No vacancies found on page ${p}, stopping.`);
          break;
        }

        for (const item of items) {
          if (seenUrls.has(item.url)) { totalDupes++; continue; }
          if (!titleFilter(item.title)) { totalFiltered++; continue; }
          seenUrls.add(item.url);
          newOffers.push(item);
        }
      }
    }
  } finally {
    await browser.close();
  }

  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`Хабр Карьера Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Total found:       ${totalFound}`);
  console.log(`Filtered by title: ${totalFiltered} removed`);
  console.log(`Duplicates:        ${totalDupes} skipped`);
  console.log(`New offers added:  ${newOffers.length}`);

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company} | ${o.title}`);
    }
    if (!dryRun) {
      console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
