#!/usr/bin/env node
/**
 * getmatch-scan.mjs — getmatch.ru vacancy scanner via Playwright
 *
 * Strategy:
 *   1. Intercept JSON API responses (non-blocking, response listener only)
 *   2. Extract __NEXT_DATA__ embedded in page HTML
 *   3. Fall back to DOM scraping of <a> links
 *
 * Usage:
 *   node getmatch-scan.mjs
 *   node getmatch-scan.mjs --dry-run
 *   node getmatch-scan.mjs --pages 3
 *   node getmatch-scan.mjs --keywords "DevSecOps|AppSec" --negative "junior|intern"
 *   node getmatch-scan.mjs --debug          # print DOM diagnostics
 *
 * Requires: npx playwright install chromium
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';

try { const { config } = await import('dotenv'); config(); } catch {}

const ROOT = dirname(fileURLToPath(import.meta.url));

const SCAN_HISTORY_PATH = join(ROOT, 'data', 'scan-history.tsv');
const PIPELINE_PATH     = join(ROOT, 'data', 'pipeline.md');
const APPLICATIONS_PATH = join(ROOT, 'data', 'applications.md');
const PORTALS_PATH      = join(ROOT, 'portals.yml');

const GETMATCH_BASE = 'https://getmatch.ru/vacancies';

// ── CLI ──────────────────────────────────────────────────────────
const cliArgs     = process.argv.slice(2);
const dryRun      = cliArgs.includes('--dry-run');
const debugMode   = cliArgs.includes('--debug');
const pagesArg    = cliArgs.indexOf('--pages')    !== -1 ? parseInt(cliArgs[cliArgs.indexOf('--pages')    + 1]) : 2;
const keywordsArg = cliArgs.indexOf('--keywords') !== -1 ? cliArgs[cliArgs.indexOf('--keywords') + 1] : null;
const negativeArg = cliArgs.indexOf('--negative') !== -1 ? cliArgs[cliArgs.indexOf('--negative') + 1] : null;

// ── Dedup helpers ────────────────────────────────────────────────

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
    const afterMarker = idx + marker.length;
    const nextSection = text.indexOf('\n## ', afterMarker);
    const insertAt    = nextSection === -1 ? text.length : nextSection;
    text = text.slice(0, insertAt) + block + text.slice(insertAt);
  }
  writeFileSync(PIPELINE_PATH, text, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(SCAN_HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }
  const lines = offers.map(o =>
    `${o.url}\t${date}\tgetmatch\t${o.title}\t${o.company}\tadded\t${o.location || ''}`
  ).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Keywords / title filter ──────────────────────────────────────

// ── Keyword → getmatch category mapping ─────────────────────────
// getmatch category pages: /vacancies/{specialty}/remote
// These are the ONLY confirmed working category URL format.
// Invalid specialties redirect to a generic remote listing page.
const VALID_CATEGORIES = new Set([
  'dev_ops', 'python', 'java', 'golang', 'ruby', 'php',
  'backend', 'js_frontend', 'react', 'vue', 'angular',
  'ios', 'android', 'mobile', 'data_science', 'data_engineer',
  'fullstack', 'qa', 'qa_auto', 'product', 'analytics',
]);

const KEYWORD_CATEGORIES = [
  [/(devsecops|devops|dev.ops|sre|безопасност|appsec|infosec|информационн)/i, 'dev_ops'],
  [/python/i,                  'python'],
  [/\bjava\b/i,                'java'],
  [/(golang|go.lang|\bgo\b)/i, 'golang'],
  [/ruby/i,                    'ruby'],
  [/\bphp\b/i,                 'php'],
  [/(backend|бэкенд)/i,        'backend'],
  [/(frontend|фронтенд)/i,     'js_frontend'],
  [/react/i,                   'react'],
  [/vue/i,                     'vue'],
  [/angular/i,                 'angular'],
  [/\bios\b/i,                 'ios'],
  [/android/i,                 'android'],
  [/(mobile|мобильн)/i,        'mobile'],
  [/(data.science|machine.learn|ml.engin)/i, 'data_science'],
  [/(data.engineer|etl|spark|kafka)/i,       'data_engineer'],
  [/(fullstack|full.stack)/i,  'fullstack'],
  [/\bqa\b.*auto|автотест/i,   'qa_auto'],
  [/\bqa\b/i,                  'qa'],
  [/(product.owner|product.manage|продукт.менедж)/i, 'product'],
  [/(analyst|аналитик)/i,      'analytics'],
];

function resolveCategories(keywords) {
  const cats = new Set();
  for (const kw of keywords) {
    for (const [regex, slug] of KEYWORD_CATEGORIES) {
      if (regex.test(kw) && VALID_CATEGORIES.has(slug)) { cats.add(slug); break; }
    }
  }
  return Array.from(cats);
}

function getKeywords() {
  if (existsSync(PORTALS_PATH)) {
    try {
      const p = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'));
      return p?.title_filter?.positive || [];
    } catch {}
  }
  return [];
}

function buildTitleFilter(cliPositive, cliNegative) {
  let positive = cliPositive;
  let negative = cliNegative;
  if (!positive || !negative) {
    let tf = {};
    if (existsSync(PORTALS_PATH)) {
      try { tf = yaml.load(readFileSync(PORTALS_PATH, 'utf-8'))?.title_filter || {}; } catch {}
    }
    positive = positive || tf.positive || [];
    negative = negative || tf.negative || [];
  }
  const pos = positive.map(k => k.toLowerCase());
  const neg = negative.map(k => k.toLowerCase());
  return (title) => {
    const lower = title.toLowerCase();
    const hasPos = pos.length === 0 || pos.some(k => lower.includes(k));
    const hasNeg = neg.some(k => lower.includes(k));
    return hasPos && !hasNeg;
  };
}

// ── __NEXT_DATA__ extractor ──────────────────────────────────────

function tryNextData(json) {
  // Try common paths where getmatch might embed vacancy lists
  const tryPaths = [
    json?.props?.pageProps?.vacancies,
    json?.props?.pageProps?.items,
    json?.props?.pageProps?.jobs,
    json?.props?.pageProps?.data?.vacancies,
    json?.props?.pageProps?.data?.items,
    json?.props?.pageProps?.initialState?.vacancies,
  ];
  for (const list of tryPaths) {
    if (Array.isArray(list) && list.length > 0) return list;
  }
  return null;
}

function parseNextDataItem(v) {
  const id = v.id || v.slug || v.uuid;
  const url = v.url || (id ? `https://getmatch.ru/vacancies/${id}` : null);
  return {
    url:      url,
    title:    v.title || v.name || v.position || v.jobTitle || '',
    company:  v.company?.name || v.companyName || v.employer?.name || v.organizationName || '',
    location: v.location || v.city || v.address || '',
  };
}

// ── JSON API response capture (non-blocking listener) ────────────

function attachApiListener(page, captured) {
  page.on('response', async (response) => {
    const url = response.url();
    const ct  = response.headers()['content-type'] || '';
    if (!ct.includes('application/json')) return;
    // Only look at calls that look like vacancy search/list API
    if (!/vacanc|job|search|offer/i.test(url)) return;
    try {
      const json = await response.json().catch(() => null);
      if (!json) return;
      const list = json?.vacancies || json?.data?.vacancies ||
                   json?.items     || json?.data?.items     ||
                   json?.jobs      || json?.data?.jobs      ||
                   json?.results   || json?.data?.results;
      if (!Array.isArray(list) || list.length === 0) return;
      const parsed = list.map(parseNextDataItem).filter(i => i.url && i.title);
      if (parsed.length > 0) {
        if (debugMode) console.log(`  → API captured: ${url} (${parsed.length} items)`);
        captured.push(...parsed);
      }
    } catch {}
  });
}

// ── DOM scraper ──────────────────────────────────────────────────

async function scrapeDOM(page) {
  // Wait up to 10s for ANY vacancy-like link to appear
  try {
    await page.waitForSelector(
      'a[href*="/vacancies/"]:not([href="/vacancies"]):not([href="/vacancies/"])',
      { timeout: 10000 }
    );
  } catch {
    // no links appeared — will return empty
  }

  return page.evaluate((debug) => {
    const title   = document.title;
    const allHrefs = Array.from(document.querySelectorAll('a[href]'))
      .map(a => a.getAttribute('href'))
      .filter(Boolean);

    if (debug) {
      console.log('[getmatch-debug] title:', title);
      console.log('[getmatch-debug] total <a> tags:', allHrefs.length);
      const sample = allHrefs.filter(h => h.includes('/vacanc')).slice(0, 20);
      console.log('[getmatch-debug] vacancy hrefs sample:', sample);
    }

    // Collect all links pointing to individual vacancies.
    // Individual vacancy URLs: /vacancies/{id}-{slug}  (id is numeric, not a known category)
    // Category/breadcrumb URLs: /vacancies/{specialty}/{format}[/{level}] or /vacancies/{specialty}/__seo
    const CATEGORY_SLUGS = new Set([
      'dev_ops','devops','qa','qa_auto','js_frontend','react','angular','vue',
      'python','java','golang','ruby','php','ios','android','data_science','ml',
      'data_engineer','fullstack','backend','frontend','security','mobile','design',
      'product','management','analytics','devrel','support','sales','marketing',
      'finance','legal','hr','remote','office','hybrid','relocate','fulltime','parttime',
      'junior','middle','senior','lead','cto','head','__seo',
    ]);

    const vacancyLinks = new Map(); // href → anchor element

    for (const a of document.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (!href) continue;

      // Must contain /vacancies/ but not be just the listing root
      if (!href.includes('/vacancies/') || href === '/vacancies' || href === '/vacancies/') continue;

      // Strip query string for category classification only; keep for the actual URL
      const hrefPath  = href.split('?')[0];
      const fullUrl   = (href.startsWith('http') ? href : `https://getmatch.ru${href}`).split('?')[0];

      // Skip category/breadcrumb URLs — known slugs only
      const afterVac = hrefPath.replace(/^.*\/vacancies\//, '');
      const parts    = afterVac.split('/').filter(Boolean);
      if (parts.length > 0 && parts.length <= 4 && parts.every(p => CATEGORY_SLUGS.has(p))) continue;

      vacancyLinks.set(fullUrl, a);
    }

    if (debug) {
      console.log('[getmatch-debug] candidate vacancy links:', vacancyLinks.size);
      for (const [url] of Array.from(vacancyLinks).slice(0, 10)) {
        console.log('  ', url);
      }
    }

    // Debug: show extracted titles + company for first 15 items
    if (debug) {
      let i = 0;
      for (const [fullUrl, a] of vacancyLinks) {
        if (i++ >= 15) break;
        let card = a.closest('li, article, [class*="card"], [class*="vacancy"], [class*="job"], [class*="offer"]');
        if (!card) card = a.parentElement;
        const hEl = card?.querySelector('h1,h2,h3,h4,h5');
        const title = (hEl?.textContent?.trim() || a.textContent?.trim() || '').slice(0, 80);
        const cEl = card?.querySelector('[class*="company"],[class*="employer"],[class*="org"]');
        const company = (cEl?.textContent?.trim() || '').slice(0, 40);
        console.log(`[getmatch-debug] item: title="${title}" company="${company}"`);
        console.log(`[getmatch-debug]       url=${fullUrl}`);
      }
    }

    const results = [];
    for (const [fullUrl, a] of vacancyLinks) {
      // Walk up the DOM to find the card container
      let card = a.closest('li, article, [class*="card"], [class*="vacancy"], [class*="job"], [class*="offer"]');
      if (!card) card = a.parentElement;

      // Try to find title: use the link text, or a heading inside the card
      let titleText = '';
      const headingEl = card?.querySelector('h1, h2, h3, h4, h5');
      if (headingEl && headingEl.textContent.trim()) {
        titleText = headingEl.textContent.trim();
      } else {
        titleText = a.textContent.trim();
      }

      // Company: look for org/company element near the card
      let companyText = '';
      if (card) {
        const compEl = card.querySelector('[class*="company"], [class*="employer"], [class*="org"]') ||
                       card.querySelector('a[href*="/companies/"], a[href*="/company/"], a[href*="/employer/"]');
        companyText = compEl?.textContent.trim() || '';
      }

      if (titleText) {
        results.push({ url: fullUrl, title: titleText, company: companyText, location: '' });
      }
    }
    return results;
  }, debugMode);
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

  if (!existsSync(chromium.executablePath())) {
    console.error('❌  Playwright Chromium not installed. Run: npx playwright install chromium');
    process.exit(1);
  }

  const cliPositive = keywordsArg ? keywordsArg.split('|').map(s => s.trim()).filter(Boolean) : null;
  const cliNegative = negativeArg ? negativeArg.split('|').map(s => s.trim()).filter(Boolean) : null;

  // getmatch.ru ignores ?q= — we use category pages when possible, else general listing.
  // Title filter is ALWAYS applied from portals.yml (primary) + cliPositive (additional).
  const portalPositive = getKeywords();
  // Merge: use portals.yml keywords + CLI keywords for filtering
  const mergedPositive = cliPositive
    ? [...new Set([...cliPositive, ...portalPositive])]
    : (portalPositive.length > 0 ? portalPositive : null);

  // Auto-expand synonyms for getmatch title filter.
  // Rules: expand ONLY within the same security domain — never broaden to unrelated DevOps roles.
  // DevSecOps → also match security-specific titles, but NOT pure "DevOps Engineer" / "MLOps" / "SRE"
  const SYNONYM_GROUPS = [
    {
      // DevSecOps / AppSec / InfoSec cluster
      trigger: /(devsecops|appsec|application.security|infosec)/i,
      synonyms: [
        'devsecops', 'appsec', 'application security', 'безопасность разработки',
        'security engineer', 'инженер безопасности', 'инженер по безопасности',
        'кибербезопасност', 'информационная безопасность', 'ИБ', 'infosec',
        'pentest', 'penetration', 'ssdlc', 'sast', 'dast', 'soc analyst',
        'zokii', 'зокии', 'vulnerability', 'уязвимост',
      ],
    },
    {
      // Pure "безопасность" cluster (IB/cybersecurity roles)
      trigger: /безопасност|кибербезопасност|информационная безопасность/i,
      synonyms: [
        'безопасност', 'кибербезопасност', 'информационная безопасность',
        'security engineer', 'devsecops', 'appsec', 'pentest', 'siem', 'soc',
        'ИБ', 'инженер по безопасности',
      ],
    },
  ];

  let effectivePositive = mergedPositive;
  if (mergedPositive) {
    for (const group of SYNONYM_GROUPS) {
      if (mergedPositive.some(k => group.trigger.test(k))) {
        effectivePositive = [...new Set([...mergedPositive, ...group.synonyms])];
        break;
      }
    }
  }

  const titleFilter  = buildTitleFilter(effectivePositive, cliNegative);
  const filterDesc   = effectivePositive ? effectivePositive.slice(0, 6).join(', ') + (effectivePositive.length > 6 ? '…' : '') : 'none (all IT jobs pass)';

  // Derive getmatch category slugs from keywords
  const keywordsForCategories = mergedPositive || [];
  const categories = resolveCategories(keywordsForCategories);

  // Build page URLs using /vacancies/{specialty}/remote format (confirmed working).
  // If no category matched, fall back to general listing /vacancies?page=N.
  const urlBases = categories.length > 0
    ? categories.map(c => `${GETMATCH_BASE}/${c}/remote`)
    : [GETMATCH_BASE];

  const date     = new Date().toISOString().slice(0, 10);
  const seenUrls = loadSeenUrls();
  const newOffers = [];
  let totalFound    = 0;
  let totalDupes    = 0;
  let totalFiltered = 0;

  console.log(`\nGetMatch scan — ${date}`);
  console.log(`Categories: ${categories.length > 0 ? categories.join(', ') : 'general listing'}  |  Pages: ${pagesArg}`);
  console.log(`Title filter: ${filterDesc}`);
  if (dryRun)    console.log('(dry run — no files will be written)');
  if (debugMode) console.log('(debug mode — extra diagnostics enabled)\n');

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport:  { width: 1280, height: 900 },
    });
    const page = await context.newPage();

    // Capture console logs from the page (for --debug mode)
    if (debugMode) {
      page.on('console', msg => {
        const text = msg.text();
        if (text.startsWith('[getmatch-debug]')) console.log(text);
      });
    }

    for (const baseUrl of urlBases) {
      const isCategory = baseUrl !== GETMATCH_BASE;
      const catLabel   = baseUrl.replace(GETMATCH_BASE + '/', '').replace('/remote', '');
      console.log(`\n▶ ${isCategory ? 'Category: ' + catLabel : 'General listing'}`);

    for (let p = 1; p <= pagesArg; p++) {
      const url = `${baseUrl}?page=${p}`;
      console.log(`  Fetching page ${p}: ${url}`);

      const capturedApiOffers = [];
      attachApiListener(page, capturedApiOffers);

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Give React/Next.js time to hydrate and render the vacancy list
        await page.waitForTimeout(3000);
      } catch (err) {
        console.warn(`  ⚠️  Page ${p} failed: ${err.message}`);
        break;
      }

      // Strategy 1: JSON API responses captured by listener
      let items = capturedApiOffers;

      // Strategy 2: __NEXT_DATA__ embedded in page HTML
      if (items.length === 0) {
        try {
          const nextDataJson = await page.evaluate(() => {
            const el = document.querySelector('#__NEXT_DATA__');
            return el ? JSON.parse(el.textContent) : null;
          });
          if (nextDataJson) {
            if (debugMode) console.log('  → Found __NEXT_DATA__, checking for vacancy list…');
            const list = tryNextData(nextDataJson);
            if (list) {
              items = list.map(parseNextDataItem).filter(i => i.url && i.title);
              if (debugMode) console.log(`  → __NEXT_DATA__ vacancies: ${items.length}`);
            }
          }
        } catch {}
      }

      // Strategy 3: DOM scraping
      if (items.length === 0) {
        if (debugMode) console.log('  → Falling back to DOM scraping…');
        items = await scrapeDOM(page);
      }

      totalFound += items.length;
      if (items.length === 0) {
        console.log(`  No vacancies found on page ${p}, stopping.`);
        break;
      }
      console.log(`  Found ${items.length} items on page ${p}`);

      for (const item of items) {
        if (seenUrls.has(item.url)) { totalDupes++; continue; }
        if (!titleFilter(item.title)) { totalFiltered++; continue; }
        seenUrls.add(item.url);
        newOffers.push(item);
      }
    } // end pages loop
    } // end urlBases loop
  } finally {
    await browser.close();
  }

  if (!dryRun && newOffers.length > 0) {
    appendToPipeline(newOffers);
    appendToScanHistory(newOffers, date);
  }

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`GetMatch Scan — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Total found:       ${totalFound}`);
  console.log(`Filtered by title: ${totalFiltered} removed`);
  console.log(`Duplicates:        ${totalDupes} skipped`);
  console.log(`New offers added:  ${newOffers.length}`);

  if (newOffers.length > 0) {
    console.log('\nNew offers:');
    for (const o of newOffers) {
      console.log(`  + ${o.company || '?'} | ${o.title}`);
    }
    if (!dryRun) console.log(`\nResults saved to ${PIPELINE_PATH} and ${SCAN_HISTORY_PATH}`);
  } else if (totalFound > 0 && totalFiltered === totalFound) {
    console.log(`\n⚠️  All ${totalFound} items were filtered by title keywords.`);
    console.log(`   Title filter used: ${filterDesc}`);
    if (mergedPositive && mergedPositive.length <= 2) {
      console.log(`   💡 Tip: Expand title_filter.positive in portals.yml with broader terms`);
      console.log(`      e.g. for security roles add: "Security Engineer", "ИБ", "кибербезопасность"`);
    }
  }

  console.log(`\n→ Run /career-ops pipeline to evaluate new offers.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
