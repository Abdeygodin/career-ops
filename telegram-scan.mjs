#!/usr/bin/env node
/**
 * telegram-scan.mjs — Scans public Telegram job channels via t.me/s/{handle}
 * No auth needed — works with public channels only.
 *
 * Usage:
 *   node telegram-scan.mjs [--dry-run] [--keywords "kw1|kw2"] [--negative "kw1|kw2"] [--debug]
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT          = __dirname;
const PORTALS_PATH  = join(ROOT, 'portals.yml');
const PIPELINE_PATH = join(ROOT, 'data', 'pipeline.md');
const HISTORY_PATH  = join(ROOT, 'data', 'scan-history.tsv');

// ── CLI args ──────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const DRY_RUN  = args.includes('--dry-run');
const DEBUG    = args.includes('--debug');

const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const cliPositive = getArg('--keywords')?.split('|').map(k => k.trim()).filter(Boolean) || [];
const cliNegative = getArg('--negative')?.split('|').map(k => k.trim()).filter(Boolean) || [];

// ── Config ────────────────────────────────────────────────────────────────
let portalsConfig = {};
if (existsSync(PORTALS_PATH)) {
  portalsConfig = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
}

const telegramCfg = portalsConfig.telegram_channels || {};
const channels    = (telegramCfg.channels || [])
  .filter(c => c?.handle)
  .map(c => c.handle.replace(/^@/, ''));

if (channels.length === 0) {
  console.log('⚠️  Нет Telegram-каналов в portals.yml');
  console.log('   Добавь каналы в секцию telegram_channels.channels или через веб-интерфейс.');
  process.exit(0);
}

const portalPositive = portalsConfig?.title_filter?.positive || [];
const portalNegative = portalsConfig?.title_filter?.negative || [];
const effectivePositive = [...new Set([...cliPositive, ...portalPositive])];
const effectiveNegative = [...new Set([...cliNegative, ...portalNegative])];

// ── Dedup from existing data ──────────────────────────────────────────────
const seenUrls = new Set();

if (existsSync(HISTORY_PATH)) {
  for (const line of readFileSync(HISTORY_PATH, 'utf-8').split('\n').slice(1)) {
    const url = line.split('\t')[0]?.trim();
    if (url?.startsWith('http')) seenUrls.add(url);
  }
}
if (existsSync(PIPELINE_PATH)) {
  for (const line of readFileSync(PIPELINE_PATH, 'utf-8').split('\n')) {
    const m = line.match(/^- \[[ x]\] (https?:\/\/\S+)/);
    if (m) seenUrls.add(m[1]);
  }
}

// ── Filters ───────────────────────────────────────────────────────────────
function passesFilter(title) {
  if (!title?.trim()) return false;
  const t = title.toLowerCase();
  if (effectivePositive.length > 0 && !effectivePositive.some(k => t.includes(k.toLowerCase()))) return false;
  if (effectiveNegative.some(k => t.includes(k.toLowerCase()))) return false;
  return true;
}

// ── Text extraction helpers ───────────────────────────────────────────────
function extractTitle(text) {
  if (!text) return '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  // Common job-post patterns in Russian Telegram channels
  for (const line of lines.slice(0, 8)) {
    for (const re of [
      /[Вв]акансия[:\s]+(.+)/,
      /[Дд]олжность[:\s]+(.+)/,
      /[Рр]оль[:\s]+(.+)/,
      /Position[:\s]+(.+)/i,
      /[💼🔥📌]\s*(.+)/,
    ]) {
      const m = line.match(re);
      if (m) return m[1].replace(/\*+/g, '').trim();
    }
  }

  // Fallback: first non-URL, non-emoji-only line that's a plausible job title
  for (const line of lines.slice(0, 5)) {
    const clean = line.replace(/^[^\w\dА-ЯЁа-яё]+/, '').trim();
    if (!clean.startsWith('http') && clean.length > 4 && clean.length < 120) return clean;
  }

  return lines[0] || '';
}

function extractCompany(text) {
  if (!text) return 'Telegram';
  const m = text.match(/(?:[Кк]омпания|Company|[Рр]аботодатель|🏢)[:\s]+([^\n\r]{2,60})/);
  return m ? m[1].replace(/\*+/g, '').trim() : 'Telegram';
}

// Job-board domains to prefer as canonical vacancy URL
const JOB_DOMAINS = [
  'hh.ru', 'headhunter.ru', 'career.habr.com', 'getmatch.ru',
  'superjob.ru', 'rabota.ru', 'linkedin.com/jobs',
  'tinkoff.ru', 'yandex.ru/jobs', 'sber.ru', 'ozon.ru',
];

function extractJobUrl(rawHtml, fallback) {
  if (!rawHtml) return fallback;
  // Playwright gives us innerText — links are lost; fall back to permalink
  // But if the post text has raw https:// links to job boards, grab the first
  const urls = rawHtml.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  for (const url of urls) {
    if (JOB_DOMAINS.some(d => url.includes(d))) return url.replace(/[.,;]+$/, '');
  }
  return fallback;
}

// ── Main ──────────────────────────────────────────────────────────────────
const today = new Date().toISOString().slice(0, 10);

console.log(`Telegram scan — ${today}`);
console.log(`Каналы (${channels.length}): ${channels.map(h => '@' + h).join(', ')}`);
if (effectivePositive.length > 0)
  console.log(`Фильтр: ${effectivePositive.slice(0, 6).join(', ')}${effectivePositive.length > 6 ? '…' : ''}`);
if (DRY_RUN) console.log('🔍 Пробный прогон — данные не сохраняются');
console.log();

let browser;
let totalNew = 0, totalFiltered = 0, totalDupes = 0;

try {
  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    locale: 'ru-RU',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });

  for (const handle of channels) {
    console.log(`📡 @${handle}…`);
    const page = await ctx.newPage();
    let posts  = [];

    const targetUrl = `https://t.me/s/${handle}`;
    try {
      await page.goto(targetUrl, { waitUntil: 'networkidle', timeout: 30_000 });

      // Detect redirect — if URL no longer contains /s/{handle}, channel has no web preview
      const finalUrl = page.url();
      if (!finalUrl.includes(`/s/${handle}`)) {
        console.log(`  ⚠️  Канал не поддерживает веб-превью (приватный или слишком маленький)`);
        console.log(`     Попробуй другой канал или убедись, что он публичный и крупный`);
        await page.close();
        continue;
      }

      posts = await page.evaluate(() =>
        [...document.querySelectorAll('.tgme_widget_message_wrap')].map(wrap => {
          const textEl   = wrap.querySelector('.tgme_widget_message_text');
          const dateLink = wrap.querySelector('.tgme_widget_message_date');
          // Grab anchor hrefs inside post body (job-board links)
          const bodyLinks = [...(wrap.querySelectorAll('.tgme_widget_message_text a') || [])]
            .map(a => a.href).filter(Boolean).join(' ');
          return {
            text:      (textEl?.innerText || '').trim(),
            bodyLinks,
            permalink: dateLink?.getAttribute('href') || '',
          };
        })
      );
    } catch (e) {
      console.log(`  ⚠️  Ошибка: ${e.message.slice(0, 80)}`);
      await page.close();
      continue;
    }
    await page.close();

    if (posts.length === 0) {
      console.log(`  ⚠️  Нет постов (канал пустой)`);
      continue;
    }

    if (DEBUG) console.log(`  Найдено постов: ${posts.length}`);

    let channelNew = 0, channelFiltered = 0, channelDupes = 0;

    for (const post of posts) {
      const combined = post.text + ' ' + post.bodyLinks;
      const title    = extractTitle(post.text);
      const company  = extractCompany(post.text);
      const jobUrl   = extractJobUrl(combined, post.permalink) || post.permalink;

      if (DEBUG) console.log(`  [post] title="${title.slice(0, 50)}" url=${jobUrl.slice(0, 60)}`);

      if (!passesFilter(title)) { channelFiltered++; continue; }
      if (!jobUrl) { channelFiltered++; continue; }
      if (seenUrls.has(jobUrl)) { channelDupes++; continue; }

      seenUrls.add(jobUrl);
      channelNew++;
      totalNew++;

      console.log(`  ✅ ${title.slice(0, 55)} — ${company}`);
      if (DEBUG) console.log(`     ${jobUrl}`);

      if (!DRY_RUN) {
        mkdirSync(join(ROOT, 'data'), { recursive: true });

        // pipeline.md
        if (!existsSync(PIPELINE_PATH))
          writeFileSync(PIPELINE_PATH, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');

        let pipeText   = readFileSync(PIPELINE_PATH, 'utf-8');
        const marker   = '## Pendientes';
        const markerIdx = pipeText.indexOf(marker);
        const block    = `\n- [ ] ${jobUrl} | ${company} | ${title}\n`;

        if (markerIdx === -1) {
          pipeText += `\n${marker}${block}`;
        } else {
          const next = pipeText.indexOf('\n## ', markerIdx + marker.length);
          const at   = next === -1 ? pipeText.length : next;
          pipeText   = pipeText.slice(0, at) + block + pipeText.slice(at);
        }
        writeFileSync(PIPELINE_PATH, pipeText, 'utf-8');

        // scan-history.tsv
        if (!existsSync(HISTORY_PATH))
          writeFileSync(HISTORY_PATH, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
        appendFileSync(HISTORY_PATH,
          `${jobUrl}\t${today}\ttelegram/@${handle}\t${title}\t${company}\tnew\t\n`, 'utf-8');
      }
    }

    totalFiltered += channelFiltered;
    totalDupes    += channelDupes;
    console.log(`  +${channelNew} новых | ${channelFiltered} не прошли фильтр | ${channelDupes} дублей`);
  }
} finally {
  await browser?.close().catch(() => {});
}

console.log();
if (totalNew > 0)
  console.log(`✅ Итого: +${totalNew} новых вакансий из Telegram`);
else
  console.log(`Новых вакансий из Telegram не найдено (${totalFiltered} отфильтровано, ${totalDupes} дублей)`);
if (DRY_RUN) console.log('(пробный прогон — данные не сохранены)');
