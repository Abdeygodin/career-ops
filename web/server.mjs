#!/usr/bin/env node
import express from 'express';
import { readFileSync, writeFileSync, appendFileSync, existsSync, copyFileSync, mkdirSync, unlinkSync, readdirSync, statSync } from 'fs';
import yaml from 'js-yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { chromium } from 'playwright';

try { const { config } = await import('dotenv'); config(); } catch {}

const require = createRequire(import.meta.url);
const multer  = require('multer');

import { parseTracker, enrichFromReports, normalizeStatus, STATUS_RU } from './lib/parse-tracker.mjs';
import { checkUrlLiveness } from '../liveness-browser.mjs';
import { parsePipeline } from './lib/parse-pipeline.mjs';
import { loadReportFull, mdToHtml, parseSummaryBlock } from './lib/parse-reports.mjs';
import { extractTextFromBuffer } from './lib/parse-cv.mjs';
import { loadLlmConfig, saveLlmConfig, chat, streamChat, testConnection, PROVIDER_MODELS, PROVIDER_LABELS } from './lib/llm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = join(__dirname, '..');
const PORT      = process.env.WEB_PORT || 3000;

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const CV_PATH       = join(ROOT, 'cv.md');
const CV_BACKUP     = join(ROOT, 'cv.backup.md');
const PORTALS_PATH  = join(ROOT, 'portals.yml');

// ── Helpers ───────────────────────────────────────────────────────

function loadAll() {
  const tracked  = parseTracker(ROOT);
  enrichFromReports(ROOT, tracked);

  const pending  = parsePipeline(ROOT)
    .filter(p => p.status === 'pending')
    // exclude URLs already in tracker
    .filter(p => !tracked.some(t => t.url && p.url && t.url === p.url));

  return [...tracked, ...pending];
}

function scoreColor(score) {
  if (!score) return 'muted';
  if (score >= 4.5) return 'green';
  if (score >= 4.0) return 'blue';
  if (score >= 3.5) return 'orange';
  return 'red';
}

function toDTO(v) {
  return {
    id:           v.id,
    source:       v.source,
    jobSource:    v.jobSource || (v.url?.includes('hh.ru') ? 'hh' : 'other'),
    number:       v.number,
    date:         v.date,
    company:      v.company,
    role:         v.role,
    score:        v.score,
    scoreRaw:     v.scoreRaw,
    scoreColor:   scoreColor(v.score),
    status:       v.status,
    statusRu:     STATUS_RU[v.status] || v.status,
    hasPDF:       v.hasPDF,
    reportPath:   v.reportPath,
    url:          v.url,
    notes:        v.notes,
    archetype:    v.archetype,
    legitimacy:   v.legitimacy,
  };
}

// ── GET /api/vacancies ─────────────────────────────────────────────
app.get('/api/vacancies', (req, res) => {
  let vacancies = loadAll().map(toDTO);

  const { q, status, source, score_min, score_max, remote } = req.query;

  if (q) {
    const lower = q.toLowerCase();
    vacancies = vacancies.filter(v =>
      v.company.toLowerCase().includes(lower) ||
      v.role.toLowerCase().includes(lower) ||
      (v.notes || '').toLowerCase().includes(lower) ||
      (v.archetype || '').toLowerCase().includes(lower)
    );
  }
  if (status && status !== 'all') {
    const statuses = status.split(',').map(s => s.trim());
    vacancies = vacancies.filter(v => statuses.includes(v.status));
  }
  if (source && source !== 'all') {
    const sources = source.split(',');
    vacancies = vacancies.filter(v => sources.includes(v.jobSource));
  }
  if (score_min) vacancies = vacancies.filter(v => v.score >= parseFloat(score_min));
  if (score_max) vacancies = vacancies.filter(v => v.score !== null && v.score <= parseFloat(score_max));

  // Sort: tracked first by number desc, then pending by date
  vacancies.sort((a, b) => {
    if (a.source === 'tracker' && b.source !== 'tracker') return -1;
    if (b.source === 'tracker' && a.source !== 'tracker') return 1;
    if (a.score && b.score) return b.score - a.score;
    return (b.number || 0) - (a.number || 0);
  });

  res.json(vacancies);
});

// ── Guess URL for tracker entry from pipeline/scan-history ────────
function guessVacancyUrl(company, role) {
  if (!company || company.toLowerCase() === 'unknown') return null;

  const norm = s => s.toLowerCase().replace(/[^a-zа-яё0-9\s]/gi, ' ').replace(/\s+/g, ' ').trim();
  const nc   = norm(company);

  const scoreMatch = (lineCompany, lineTitle) => {
    const nlc = norm(lineCompany);
    const nlt = norm(lineTitle || '');
    const nr  = norm(role || '');
    let score = 0;
    if (nlc === nc)                                score += 3;
    else if (nlc.includes(nc) || nc.includes(nlc)) score += 1;
    else                                            return 0;
    if (nr && (nlt.includes(nr.slice(0, 12)) || nr.includes(nlt.slice(0, 12)))) score += 2;
    return score;
  };

  let best = null, bestScore = 0;

  // 1. Search pipeline.md [x] entries (highest confidence — these were evaluated)
  const pipelinePath = join(ROOT, 'data', 'pipeline.md');
  if (existsSync(pipelinePath)) {
    for (const line of readFileSync(pipelinePath, 'utf-8').split('\n')) {
      const m = line.match(/^- \[x\] (https?:\/\/\S+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/);
      if (!m) continue;
      const s = scoreMatch(m[2], m[3]);
      if (s > bestScore) { bestScore = s; best = m[1]; }
    }
  }
  if (best) return best;

  // 2. Fallback: scan-history.tsv
  const histPath = join(ROOT, 'data', 'scan-history.tsv');
  if (existsSync(histPath)) {
    for (const line of readFileSync(histPath, 'utf-8').split('\n').slice(1)) {
      const cols = line.split('\t');
      if (cols.length < 5) continue;
      const [url, , , lineTitle, lineCompany] = cols;
      if (!url?.startsWith('http')) continue;
      const s = scoreMatch(lineCompany, lineTitle);
      if (s > bestScore) { bestScore = s; best = url; }
    }
  }

  return bestScore >= 1 ? best : null;
}

// ── GET /api/vacancies/:id ─────────────────────────────────────────
app.get('/api/vacancies/:id', (req, res) => {
  const all = loadAll();
  const v   = all.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'Not found' });

  const dto = toDTO(v);

  if (v.reportPath) {
    const raw = loadReportFull(ROOT, v.reportPath);
    if (raw) {
      dto.reportRaw  = raw;
      dto.reportHtml = mdToHtml(raw);
      dto.summary    = parseSummaryBlock(raw);
    }
  }

  // For old tracker entries without a stored URL, try to recover from pipeline/history
  if (!dto.url && dto.source === 'tracker') {
    const guessed = guessVacancyUrl(dto.company, dto.role);
    if (guessed) dto.url = guessed;
  }

  res.json(dto);
});

// ── GET /api/stats ────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const all = loadAll();
  const tracked = all.filter(v => v.source === 'tracker');
  const pending = all.filter(v => v.status === 'pending');

  const byStatus = {};
  for (const v of tracked) {
    byStatus[v.status] = (byStatus[v.status] || 0) + 1;
  }

  const scored  = tracked.filter(v => v.score);
  const avgScore = scored.length
    ? (scored.reduce((s, v) => s + v.score, 0) / scored.length).toFixed(2)
    : null;

  const highPriority = tracked.filter(v => v.score >= 4.0 &&
    ['evaluated', 'applied'].includes(v.status)).length;

  res.json({
    total:       all.length,
    pending:     pending.length,
    evaluated:   byStatus.evaluated || 0,
    applied:     byStatus.applied   || 0,
    interview:   byStatus.interview || 0,
    offer:       byStatus.offer     || 0,
    highPriority,
    avgScore,
    byStatus,
  });
});

// ── PATCH /api/vacancies/:id/status ───────────────────────────────
app.patch('/api/vacancies/:id/status', (req, res) => {
  const { status } = req.body;
  if (!status) return res.status(400).json({ error: 'status required' });

  const trackerPath = join(ROOT, 'data', 'applications.md');
  if (!existsSync(trackerPath)) return res.status(404).json({ error: 'tracker not found' });

  const all   = loadAll();
  const v     = all.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'vacancy not found' });
  if (v.source !== 'tracker') return res.status(400).json({ error: 'can only update tracked vacancies' });

  let content = readFileSync(trackerPath, 'utf-8');
  const lines = content.split('\n');
  let updated = false;

  for (let i = 0; i < lines.length; i++) {
    if (v.reportNumber && lines[i].includes(`[${v.reportNumber}]`)) {
      // Replace old status with new (column 5 in the pipe table)
      lines[i] = lines[i].replace(
        new RegExp(`(\\|[^|]+\\|[^|]+\\|[^|]+\\|[^|]+\\|)\\s*[^|]+\\s*(\\|)`),
        `$1 ${status} $2`
      );
      updated = true;
      break;
    }
  }

  if (!updated) return res.status(404).json({ error: 'row not found in tracker' });

  writeFileSync(trackerPath, lines.join('\n'), 'utf-8');
  res.json({ ok: true, status });
});

// ── DELETE /api/vacancies/:id ─────────────────────────────────────
// Fully removes a vacancy: pipeline.md line + tracker row + report file
app.delete('/api/vacancies/:id', (req, res) => {
  const all = loadAll();
  const v   = all.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'vacancy not found' });

  const removedFrom = [];

  // 1. Remove from pipeline.md (both pending and processed lines)
  const pipelinePath = join(ROOT, 'data', 'pipeline.md');
  if (existsSync(pipelinePath)) {
    const urlToMatch = v.url || v.localPath;
    if (urlToMatch) {
      const lines   = readFileSync(pipelinePath, 'utf-8').split('\n');
      const escaped = urlToMatch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const before  = lines.length;
      const updated = lines.filter(l => !new RegExp(`^- \\[[ x]\\] ${escaped}`).test(l));
      if (updated.length < before) {
        writeFileSync(pipelinePath, updated.join('\n'), 'utf-8');
        removedFrom.push('pipeline');
      }
    }
  }

  // 2. Remove from applications.md (tracker row)
  const trackerPath = join(ROOT, 'data', 'applications.md');
  if (v.source === 'tracker' && existsSync(trackerPath)) {
    const lines   = readFileSync(trackerPath, 'utf-8').split('\n');
    const before  = lines.length;
    const updated = lines.filter(l => {
      if (!l.trim().startsWith('|') || /^\|\s*#/.test(l) || /^\|[-\s|]+$/.test(l)) return true;
      if (v.reportNumber && l.includes(`[${v.reportNumber}]`)) return false;
      return true;
    });
    if (updated.length < before) {
      writeFileSync(trackerPath, updated.join('\n'), 'utf-8');
      removedFrom.push('tracker');
    }
  }

  // 3. Delete linked report file
  let reportDeleted = false;
  if (v.reportPath) {
    const rp = join(ROOT, v.reportPath);
    if (existsSync(rp)) {
      try { unlinkSync(rp); reportDeleted = true; removedFrom.push('report'); } catch {}
    }
  }

  res.json({ ok: true, removedFrom, reportDeleted });
});

// ── POST /api/scan ─────────────────────────────────────────────────
// Runs hh-scan.mjs, habr-scan.mjs, getmatch-scan.mjs sequentially, streams output via SSE
app.post('/api/scan', async (req, res) => {
  const {
    period = '1', pages = '2', habrPages = '2', getmatchPages = '2',
    dryRun = false, keywords, negative, area, schedule,
    sources = ['hh'],
  } = req.body;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => { if (!res.destroyed) res.write(`data: ${JSON.stringify({ text: data })}\n\n`); };

  const runScript = (scriptArgs) => new Promise(resolve => {
    const child = spawn('node', scriptArgs, { cwd: ROOT });
    child.stdout.on('data', d => send(d.toString()));
    child.stderr.on('data', d => send(d.toString()));
    child.on('close', resolve);
  });

  let lastCode = 0;

  if (sources.includes('hh')) {
    const args = ['hh-scan.mjs', '--period', String(period), '--pages', String(pages)];
    if (dryRun)   args.push('--dry-run');
    if (area)     args.push('--area', String(area));
    if (schedule) args.push('--schedule', String(schedule));
    if (Array.isArray(keywords) && keywords.length > 0) {
      args.push('--keywords', keywords.join('|'));
      args.push('--no-title-filter');
    }
    if (Array.isArray(negative) && negative.length > 0)
      args.push('--negative', negative.join('|'));
    lastCode = await runScript(args);
  }

  if (sources.includes('habr')) {
    send('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    const args = ['habr-scan.mjs', '--pages', String(habrPages)];
    if (dryRun) args.push('--dry-run');
    if (Array.isArray(keywords) && keywords.length > 0)
      args.push('--keywords', keywords.join('|'));
    if (Array.isArray(negative) && negative.length > 0)
      args.push('--negative', negative.join('|'));
    lastCode = await runScript(args);
  }

  if (sources.includes('getmatch')) {
    send('\n\n◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆◆\n');
    const args = ['getmatch-scan.mjs', '--pages', String(getmatchPages)];
    if (dryRun) args.push('--dry-run');
    if (Array.isArray(keywords) && keywords.length > 0)
      args.push('--keywords', keywords.join('|'));
    if (Array.isArray(negative) && negative.length > 0)
      args.push('--negative', negative.join('|'));
    lastCode = await runScript(args);
  }

  if (sources.includes('telegram')) {
    send('\n\n▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲▲\n');
    const args = ['telegram-scan.mjs'];
    if (dryRun) args.push('--dry-run');
    if (Array.isArray(keywords) && keywords.length > 0)
      args.push('--keywords', keywords.join('|'));
    if (Array.isArray(negative) && negative.length > 0)
      args.push('--negative', negative.join('|'));
    lastCode = await runScript(args);
  }

  res.write(`data: ${JSON.stringify({ done: true, code: lastCode })}\n\n`);
  res.end();
});

// ── POST /api/evaluate ─────────────────────────────────────────────
// Accepts { text, lang } — saves to temp file, runs ollama-eval.mjs, streams output
app.post('/api/evaluate', async (req, res) => {
  const { text, lang = 'ru', model, sourceUrl } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'text required' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const tmpPath = join(ROOT, 'jds', `_web-eval-${Date.now()}.txt`);
  try {
    mkdirSync(join(ROOT, 'jds'), { recursive: true });
    writeFileSync(tmpPath, text, 'utf-8');
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    return res.end();
  }

  const args = ['ollama-eval.mjs', '--file', tmpPath, '--lang', lang];
  if (model)     args.push('--model', model);
  if (sourceUrl) args.push('--url', sourceUrl);

  // Snapshot existing reports before evaluation so we can find the new one afterwards
  const reportsDir    = join(ROOT, 'reports');
  const reportsBefore = existsSync(reportsDir)
    ? new Set(readdirSync(reportsDir).filter(f => f.endsWith('.md')))
    : new Set();

  const child = spawn('node', args, { cwd: ROOT });
  const send  = (data) => res.write(`data: ${JSON.stringify({ text: data })}\n\n`);

  child.stdout.on('data', d => send(d.toString()));
  child.stderr.on('data', d => send(d.toString()));

  child.on('close', async (code) => {
    try { unlinkSync(tmpPath); } catch {}

    if (code === 0) {
      try {
        // Find the report created during this evaluation
        const newReport = existsSync(reportsDir)
          ? readdirSync(reportsDir)
              .filter(f => f.endsWith('.md') && !reportsBefore.has(f))
              .sort()
              .pop()           // highest number = latest
          : null;

        if (newReport) {
          const content = readFileSync(join(reportsDir, newReport), 'utf-8');

          // Parse header: supports both English ("# Evaluation:") and Russian ("# Оценка:")
          const titleM = content.match(/^# (?:Evaluation|Оценка):\s*(.+?)\s*[—–\-]\s*(.+)$/m);
          const scoreM = content.match(/\*\*(?:Score|Балл):\*\*\s*([\d.]+)\/5/);
          const dateM  = newReport.match(/(\d{4}-\d{2}-\d{2})\.md$/);

          const num     = newReport.slice(0, 3);
          const slug    = newReport.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '');
          const company = titleM?.[1]?.trim() || 'Unknown';
          const role    = titleM?.[2]?.trim() || 'Unknown';
          const score   = scoreM?.[1] || '?';
          const date    = dateM?.[1]  || new Date().toISOString().slice(0, 10);

          const tsvLine = `${num}\t${date}\t${company}\t${role}\tEvaluated\t${score}/5\t❌\t[${num}](reports/${newReport})\t`;
          const tsvDir  = join(ROOT, 'batch', 'tracker-additions');
          mkdirSync(tsvDir, { recursive: true });
          writeFileSync(join(tsvDir, `${num}-${slug}.tsv`), tsvLine + '\n', 'utf-8');
          send(`\n📋  TSV → batch/tracker-additions/${num}-${slug}.tsv\n`);

          if (existsSync(join(ROOT, 'merge-tracker.mjs'))) {
            await new Promise(resolve => {
              const merge = spawn('node', ['merge-tracker.mjs'], { cwd: ROOT });
              merge.stdout.on('data', d => send(d.toString()));
              merge.stderr.on('data', d => send(d.toString()));
              merge.on('close', resolve);
            });
            send('✅  Добавлено в трекер\n');

            // Mark pipeline entry as processed → prevents duplicate row in UI
            if (sourceUrl) {
              const pipelinePath = join(ROOT, 'data', 'pipeline.md');
              if (existsSync(pipelinePath)) {
                const pc  = readFileSync(pipelinePath, 'utf-8');
                const esc = sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const pu  = pc.replace(new RegExp(`^(- )\\[ \\] (${esc})`, 'm'), '$1[x] $2');
                if (pu !== pc) writeFileSync(pipelinePath, pu, 'utf-8');
              }
            }
          }
        } else {
          send('\n⚠️  Новый отчёт не найден — трекер не обновлён\n');
        }
      } catch (err) {
        send(`\n⚠️  Авто-трекинг: ${err.message}\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true, code })}\n\n`);
    res.end();
  });
});

// ── POST /api/evaluate-batch ─────────────────────────────────────
// Sequentially evaluates all pending hh.ru items. Streams SSE progress events.
app.post('/api/evaluate-batch', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => { if (!res.destroyed) res.write(`data: ${JSON.stringify(data)}\n\n`); };

  const items = parsePipeline(ROOT)
    .filter(p => p.status === 'pending')
    .filter(p => p.url?.includes('hh.ru'));

  if (items.length === 0) {
    send({ type: 'all-done', evaluated: 0, errors: 0 });
    return res.end();
  }

  send({ type: 'start', total: items.length });

  const reportsDir = join(ROOT, 'reports');
  let evaluated = 0, errors = 0;
  let browser;

  try {
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ locale: 'ru-RU' });

    for (let i = 0; i < items.length; i++) {
      if (res.destroyed) break;
      const item = items[i];
      send({ type: 'item-begin', index: i, total: items.length,
        company: item.company || 'Вакансия', role: item.role || '?', url: item.url });

      // Fetch JD via Playwright
      let text = '';
      try {
        send({ type: 'item-status', index: i, text: 'Загружаю страницу…' });
        const page = await ctx.newPage();
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        const get      = sel => page.$eval(sel, el => el.textContent.trim()).catch(() => '');
        const getInner = sel => page.$eval(sel, el => el.innerText.trim()).catch(() => '');
        const [title, company, salary, city, desc] = await Promise.all([
          get('[data-qa="vacancy-title"]'),
          get('[data-qa="vacancy-company-name"]'),
          get('[data-qa="vacancy-salary"]'),
          get('[data-qa="vacancy-view-location"]'),
          getInner('[data-qa="vacancy-description"]'),
        ]);
        await page.close();
        if (!title && !desc) {
          send({ type: 'item-error', index: i, error: 'Вакансия закрыта' });
          errors++; continue;
        }
        text = [title && `# ${title}`, company && `Компания: ${company}`,
          city && `Город: ${city}`, salary && `Зарплата: ${salary.replace(/\s+/g, ' ')}`,
          '', desc || ''].filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim();
      } catch (e) {
        send({ type: 'item-error', index: i, error: `Ошибка загрузки: ${e.message.slice(0, 80)}` });
        errors++; continue;
      }

      // Run ollama-eval.mjs
      const tmpPath = join(ROOT, 'jds', `_batch-${Date.now()}-${i}.txt`);
      mkdirSync(join(ROOT, 'jds'), { recursive: true });
      writeFileSync(tmpPath, text, 'utf-8');
      const reportsBefore = existsSync(reportsDir)
        ? new Set(readdirSync(reportsDir).filter(f => f.endsWith('.md'))) : new Set();

      send({ type: 'item-status', index: i, text: 'Оцениваю с ИИ…' });
      const args = ['ollama-eval.mjs', '--file', tmpPath, '--lang', 'ru', '--url', item.url];
      const evalCode = await new Promise(resolve => {
        const child = spawn('node', args, { cwd: ROOT });
        child.stdout.on('data', () => {});
        child.stderr.on('data', () => {});
        child.on('close', resolve);
      });
      try { unlinkSync(tmpPath); } catch {}

      if (evalCode === 0) {
        const newReport = existsSync(reportsDir)
          ? readdirSync(reportsDir).filter(f => f.endsWith('.md') && !reportsBefore.has(f)).sort().pop()
          : null;
        if (newReport) {
          const content = readFileSync(join(reportsDir, newReport), 'utf-8');
          const scoreM  = content.match(/\*\*(?:Score|Балл):\*\*\s*([\d.]+)\/5/);
          const titleM  = content.match(/^# (?:Evaluation|Оценка):\s*(.+?)\s*[—–\-]\s*(.+)$/m);
          const dateM   = newReport.match(/(\d{4}-\d{2}-\d{2})\.md$/);
          const num     = newReport.slice(0, 3);
          const slug    = newReport.replace(/^\d+-/, '').replace(/-\d{4}-\d{2}-\d{2}\.md$/, '');
          const company = titleM?.[1]?.trim() || 'Unknown';
          const role    = titleM?.[2]?.trim() || 'Unknown';
          const score   = scoreM?.[1] || '?';
          const date    = dateM?.[1] || new Date().toISOString().slice(0, 10);
          const tsvLine = `${num}\t${date}\t${company}\t${role}\tEvaluated\t${score}/5\t❌\t[${num}](reports/${newReport})\t`;
          const tsvDir  = join(ROOT, 'batch', 'tracker-additions');
          mkdirSync(tsvDir, { recursive: true });
          writeFileSync(join(tsvDir, `${num}-${slug}.tsv`), tsvLine + '\n', 'utf-8');
          if (existsSync(join(ROOT, 'merge-tracker.mjs'))) {
            await new Promise(r => { const m = spawn('node', ['merge-tracker.mjs'], { cwd: ROOT }); m.on('close', r); });
          }
          const pipelinePath = join(ROOT, 'data', 'pipeline.md');
          if (existsSync(pipelinePath) && item.url) {
            const pc  = readFileSync(pipelinePath, 'utf-8');
            const esc = item.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const pu  = pc.replace(new RegExp(`^(- )\\[ \\] (${esc})`, 'm'), '$1[x] $2');
            if (pu !== pc) writeFileSync(pipelinePath, pu, 'utf-8');
          }
          evaluated++;
          send({ type: 'item-done', index: i, score: parseFloat(score) || null, company, role });
        } else {
          send({ type: 'item-error', index: i, error: 'Отчёт не создан' });
          errors++;
        }
      } else {
        send({ type: 'item-error', index: i, error: `Ошибка оценки (код ${evalCode})` });
        errors++;
      }
    }
  } catch (e) {
    send({ type: 'error', message: e.message });
  } finally {
    await browser?.close().catch(() => {});
    if (!res.destroyed) { send({ type: 'all-done', evaluated, errors }); res.end(); }
  }
});

// ── POST /api/suggest-keywords ───────────────────────────────────
// Asks LLM to suggest hh.ru keywords and stop-words for a given role
app.post('/api/suggest-keywords', async (req, res) => {
  const { role } = req.body;
  if (!role?.trim()) return res.status(400).json({ error: 'role required' });

  const profilePath = join(ROOT, 'config', 'profile.yml');
  const profileText = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8').slice(0, 800) : '';

  const prompt = `/no_think
Ты помогаешь настроить поиск вакансий на hh.ru для российского рынка.

Должность: "${role.trim()}"
${profileText ? `\nПрофиль кандидата (для контекста):\n${profileText}` : ''}

Верни ТОЛЬКО валидный JSON (без markdown, без пояснений):
{
  "keywords": ["вариант1", "вариант2", ...],
  "stopwords": ["стоп1", "стоп2", ...]
}

Правила:
- keywords: 8-15 вариантов названия этой должности и смежных ролей для поиска на hh.ru (русские и английские варианты)
- stopwords: 8-15 слов в заголовках вакансий, которые явно НЕ подходят — джуниор-позиции, нерелевантные роли, нежелательные специализации
- Только короткие слова/фразы (1-3 слова), без объяснений
- Ориентируйся на российский рынок труда`;

  try {
    let raw = await chat([{ role: 'user', content: prompt }], { temperature: 0.3, maxTokens: 1024 });
    raw = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ error: 'Не удалось распарсить ответ модели', raw: raw.slice(0, 200) });
    const parsed = JSON.parse(jsonMatch[0]);
    res.json({
      keywords:  Array.isArray(parsed.keywords)  ? parsed.keywords.slice(0, 20)  : [],
      stopwords: Array.isArray(parsed.stopwords) ? parsed.stopwords.slice(0, 20) : [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/hh-areas ────────────────────────────────────────────
// Returns flat sorted list of hh.ru Russian regions/cities.
// Fetched from hh.ru public API, cached for 1 hour.
let _hhAreasCache = null;
let _hhAreasCacheAt = 0;
const HH_AREAS_TTL = 3_600_000;

app.get('/api/hh-areas', async (req, res) => {
  if (_hhAreasCache && Date.now() - _hhAreasCacheAt < HH_AREAS_TTL) {
    return res.json(_hhAreasCache);
  }
  try {
    const r = await fetch('https://api.hh.ru/areas/113', {
      headers: { 'User-Agent': 'career-ops/1.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`hh.ru areas HTTP ${r.status}`);
    const root = await r.json();
    // root.areas is directly the list of Russian regions (oblasts/krais/republics).
    // Children of each region are individual cities — too granular, we skip them.
    const flat = (root.areas || []).map(a => ({ id: a.id, name: a.name }));
    flat.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    _hhAreasCache = flat;
    _hhAreasCacheAt = Date.now();
    res.json(flat);
  } catch (e) {
    // Return static fallback so UI stays functional offline
    res.json([
      { id: '1',  name: 'Москва' },
      { id: '2',  name: 'Санкт-Петербург' },
      { id: '3',  name: 'Екатеринбург' },
      { id: '4',  name: 'Новосибирск' },
      { id: '88', name: 'Вся Россия' },
    ]);
  }
});

// ── GET /api/followups ───────────────────────────────────────────
// Runs followup-cadence.mjs and returns its JSON output.
// Cached for 60 s so rapid refreshes don't re-spawn.
let _followupsCache = null;
let _followupsCacheAt = 0;
const FOLLOWUPS_TTL = 60_000;

app.get('/api/followups', (req, res) => {
  const force = req.query.force === '1';
  if (!force && _followupsCache && Date.now() - _followupsCacheAt < FOLLOWUPS_TTL) {
    return res.json(_followupsCache);
  }
  let out = '';
  const child = spawn('node', ['followup-cadence.mjs'], { cwd: ROOT });
  child.stdout.on('data', d => { out += d; });
  child.on('close', () => {
    try {
      const parsed = JSON.parse(out);
      _followupsCache = parsed;
      _followupsCacheAt = Date.now();
      res.json(parsed);
    } catch {
      res.status(500).json({ error: 'followup-cadence parse error', raw: out.slice(0, 300) });
    }
  });
  child.on('error', e => res.status(500).json({ error: e.message }));
});

// ── GET /api/analytics ───────────────────────────────────────────
// Runs analyze-patterns.mjs and returns its JSON output. Cached 5 min.
let _analyticsCache = null;
let _analyticsCacheAt = 0;
const ANALYTICS_TTL = 5 * 60_000;

app.get('/api/analytics', (req, res) => {
  const force = req.query.force === '1';
  if (!force && _analyticsCache && Date.now() - _analyticsCacheAt < ANALYTICS_TTL) {
    return res.json(_analyticsCache);
  }
  let out = '';
  const child = spawn('node', ['analyze-patterns.mjs', '--min-threshold', '1'], { cwd: ROOT });
  child.stdout.on('data', d => { out += d; });
  child.on('close', () => {
    try {
      const parsed = JSON.parse(out);
      if (!parsed.error) {
        _analyticsCache = parsed;
        _analyticsCacheAt = Date.now();
      }
      res.json(parsed);
    } catch {
      res.status(500).json({ error: 'analyze-patterns parse error', raw: out.slice(0, 300) });
    }
  });
  child.on('error', e => res.status(500).json({ error: e.message }));
});

// ── GET /api/liveness?url=... ─────────────────────────────────────
// Checks if a job posting URL is still active. Cached 5 min per URL.
const _livenessCache = new Map();
const LIVENESS_TTL = 5 * 60_000;

app.get('/api/liveness', async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'url required' });

  const cached = _livenessCache.get(url);
  if (cached && Date.now() - cached.checkedAt < LIVENESS_TTL) {
    return res.json(cached);
  }

  let browser, page;
  try {
    browser = await chromium.launch({ headless: true });
    page    = await browser.newPage();
    const { result, reason } = await checkUrlLiveness(page, url);
    const data = { result, reason, checkedAt: Date.now() };
    _livenessCache.set(url, data);
    res.json(data);
  } catch (e) {
    res.json({ result: 'uncertain', reason: e.message });
  } finally {
    await page?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
});

// ── GET /api/search-config ────────────────────────────────────────
// Returns current keyword config from portals.yml
app.get('/api/search-config', (req, res) => {
  if (!existsSync(PORTALS_PATH)) {
    return res.json({ positive: [], negative: [], area: '1,2' });
  }
  try {
    const cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
    res.json({
      positive: cfg?.title_filter?.positive || [],
      negative: cfg?.title_filter?.negative || [],
      area:     process.env.HH_AREA || '1,2',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/search-config ────────────────────────────────────────
// Saves keyword config back to portals.yml
app.put('/api/search-config', (req, res) => {
  const { positive, negative } = req.body;
  if (!Array.isArray(positive)) return res.status(400).json({ error: 'positive must be array' });

  try {
    let cfg = {};
    if (existsSync(PORTALS_PATH)) {
      cfg = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {};
    }
    if (!cfg.title_filter) cfg.title_filter = {};
    cfg.title_filter.positive = positive;
    if (Array.isArray(negative)) cfg.title_filter.negative = negative;
    writeFileSync(PORTALS_PATH, yaml.dump(cfg, { lineWidth: 120, quotingType: '"' }), 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/telegram-channels ───────────────────────────────────────────
app.get('/api/telegram-channels', (req, res) => {
  try {
    const cfg      = existsSync(PORTALS_PATH) ? (yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {}) : {};
    const channels = cfg.telegram_channels?.channels || [];
    res.json({ channels });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/telegram-channels ───────────────────────────────────────────
// Body: { handle, notes? }
app.post('/api/telegram-channels', (req, res) => {
  const { handle, notes = '' } = req.body;
  if (!handle?.trim()) return res.status(400).json({ error: 'handle required' });
  const clean = handle.trim().replace(/^@/, '');
  if (!/^[\w.-]{3,64}$/.test(clean)) return res.status(400).json({ error: 'invalid handle' });

  try {
    let cfg = existsSync(PORTALS_PATH) ? (yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {}) : {};
    if (!cfg.telegram_channels) cfg.telegram_channels = { enabled: true, channels: [] };
    if (!Array.isArray(cfg.telegram_channels.channels)) cfg.telegram_channels.channels = [];

    if (cfg.telegram_channels.channels.some(c => c.handle === clean)) {
      return res.status(409).json({ error: 'Канал уже добавлен' });
    }
    cfg.telegram_channels.channels.push({ handle: clean, notes: notes.trim() });
    writeFileSync(PORTALS_PATH, yaml.dump(cfg, { lineWidth: 120, quotingType: '"' }), 'utf-8');
    res.json({ ok: true, handle: clean });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/telegram-channels/:handle ─────────────────────────────────
app.delete('/api/telegram-channels/:handle', (req, res) => {
  const handle = req.params.handle.replace(/^@/, '');
  try {
    let cfg = existsSync(PORTALS_PATH) ? (yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) || {}) : {};
    if (!Array.isArray(cfg.telegram_channels?.channels)) return res.json({ ok: true });
    const before = cfg.telegram_channels.channels.length;
    cfg.telegram_channels.channels = cfg.telegram_channels.channels.filter(c => c.handle !== handle);
    if (cfg.telegram_channels.channels.length === before)
      return res.status(404).json({ error: 'Канал не найден' });
    writeFileSync(PORTALS_PATH, yaml.dump(cfg, { lineWidth: 120, quotingType: '"' }), 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/llm-config ───────────────────────────────────────────
app.get('/api/llm-config', (req, res) => {
  const cfg = loadLlmConfig();
  // Mask API key in response (send back so the form can show it, but don't log it)
  res.json({ ...cfg, providerModels: PROVIDER_MODELS, providerLabels: PROVIDER_LABELS });
});

// ── PUT /api/llm-config ───────────────────────────────────────────
app.put('/api/llm-config', (req, res) => {
  const { provider, model, ollama_host, api_key, base_url } = req.body;
  const allowed = ['ollama', 'openai', 'anthropic', 'deepseek', 'openrouter', 'custom'];
  if (!allowed.includes(provider)) return res.status(400).json({ error: 'invalid provider' });
  try {
    saveLlmConfig({ provider, model: model || '', ollama_host: ollama_host || '', api_key: api_key || '', base_url: base_url || '' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/llm-config/test ─────────────────────────────────────
app.post('/api/llm-config/test', async (req, res) => {
  const { provider, model, ollama_host, api_key, base_url } = req.body;
  const cfg = { provider, model, ollama_host, api_key, base_url };
  const result = await testConnection(cfg);
  res.json(result);
});

// ── GET /api/llm-status ───────────────────────────────────────────
// Lightweight readiness check — no LLM tokens consumed.
app.get('/api/llm-status', async (req, res) => {
  const cfg = loadLlmConfig();

  if (cfg.provider === 'ollama') {
    const host = (cfg.ollama_host || 'http://localhost:11434').replace(/\/$/, '');
    try {
      const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
      if (r.ok) {
        const data = await r.json().catch(() => ({}));
        const count = data.models?.length || 0;
        return res.json({ ok: true, provider: 'ollama', model: cfg.model,
          message: `Ollama запущен, ${count} мод.` });
      }
      return res.json({ ok: false, provider: 'ollama', model: cfg.model,
        message: `Ollama вернул ${r.status}` });
    } catch {
      return res.json({ ok: false, provider: 'ollama', model: cfg.model,
        message: `Ollama недоступен (${host})` });
    }
  }

  if (!cfg.api_key) {
    return res.json({ ok: false, provider: cfg.provider, model: cfg.model,
      message: 'API ключ не указан' });
  }

  res.json({ ok: true, provider: cfg.provider, model: cfg.model, message: 'Настроен' });
});

// ── GET /api/pipeline ─────────────────────────────────────────────
app.get('/api/pipeline', (req, res) => {
  const items = parsePipeline(ROOT).filter(p => p.status === 'pending');
  res.json(items);
});

// ── POST /api/pipeline/add ────────────────────────────────────────
// Accepts { url } — fetches hh.ru metadata with Playwright, adds to pipeline
app.post('/api/pipeline/add', async (req, res) => {
  const { url } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'url required' });

  const cleanUrl = url.trim().replace(/\?.*$/, '');

  // Check for duplicates
  const all = loadAll();
  if (all.some(v => v.url === cleanUrl)) {
    return res.status(409).json({ error: 'Вакансия уже есть в трекере', url: cleanUrl });
  }
  const pipelinePath = join(ROOT, 'data', 'pipeline.md');
  if (existsSync(pipelinePath)) {
    const pc = readFileSync(pipelinePath, 'utf-8');
    if (pc.includes(cleanUrl)) {
      return res.status(409).json({ error: 'Вакансия уже в очереди', url: cleanUrl });
    }
  }

  let company = 'Unknown', title = 'Unknown';

  // Fetch hh.ru metadata with Playwright
  const hhMatch = cleanUrl.match(/hh\.ru\/vacancy\/(\d+)/);
  if (hhMatch) {
    let browser;
    try {
      browser = await chromium.launch({ headless: true });
      const ctx  = await browser.newContext({ locale: 'ru-RU' });
      const page = await ctx.newPage();
      await page.goto(`https://hh.ru/vacancy/${hhMatch[1]}`, {
        waitUntil: 'domcontentloaded', timeout: 20_000,
      });
      title   = await page.$eval('[data-qa="vacancy-title"]',        el => el.textContent.trim()).catch(() => 'Unknown');
      company = await page.$eval('[data-qa="vacancy-company-name"]', el => el.textContent.trim()).catch(() => 'Unknown');
    } catch { /* fallback: add without metadata */ }
    finally { if (browser) await browser.close(); }
  }

  // Append to pipeline.md
  mkdirSync(join(ROOT, 'data'), { recursive: true });
  if (!existsSync(pipelinePath)) {
    writeFileSync(pipelinePath, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');
  }
  let text  = readFileSync(pipelinePath, 'utf-8');
  const marker = '## Pendientes';
  const idx    = text.indexOf(marker);
  const block  = `\n- [ ] ${cleanUrl} | ${company} | ${title}\n`;
  if (idx === -1) {
    text += `\n${marker}${block}`;
  } else {
    const next = text.indexOf('\n## ', idx + marker.length);
    const at   = next === -1 ? text.length : next;
    text = text.slice(0, at) + block + text.slice(at);
  }
  writeFileSync(pipelinePath, text, 'utf-8');

  // Append to scan-history.tsv (dedup on next scan)
  const histPath = join(ROOT, 'data', 'scan-history.tsv');
  const date = new Date().toISOString().slice(0, 10);
  if (!existsSync(histPath)) {
    writeFileSync(histPath, 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n', 'utf-8');
  }
  appendFileSync(histPath, `${cleanUrl}\t${date}\tmanual\t${title}\t${company}\tadded\t\n`, 'utf-8');

  res.json({ ok: true, url: cleanUrl, company, title });
});

// ── GET /api/hh-vacancy/:id ───────────────────────────────────────
// Opens hh.ru/vacancy/:id with Playwright (no API key needed)
app.get('/api/hh-vacancy/:id', async (req, res) => {
  const id = req.params.id.replace(/\D/g, '');
  if (!id) return res.status(400).json({ error: 'invalid id' });

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const ctx  = await browser.newContext({ locale: 'ru-RU' });
    const page = await ctx.newPage();

    await page.goto(`https://hh.ru/vacancy/${id}`, {
      waitUntil: 'domcontentloaded',
      timeout:   20_000,
    });

    const get = (sel) => page.$eval(sel, el => el.textContent.trim()).catch(() => '');
    const getInner = (sel) => page.$eval(sel, el => el.innerText.trim()).catch(() => '');

    const [title, company, salary, city, desc] = await Promise.all([
      get('[data-qa="vacancy-title"]'),
      get('[data-qa="vacancy-company-name"]'),
      get('[data-qa="vacancy-salary"]'),
      get('[data-qa="vacancy-view-location"]'),
      getInner('[data-qa="vacancy-description"]'),
    ]);

    if (!title && !desc) {
      return res.status(404).json({ error: 'Вакансия не найдена или закрыта' });
    }

    const text = [
      title   && `# ${title}`,
      company && `Компания: ${company}`,
      city    && `Город: ${city}`,
      salary  && `Зарплата: ${salary.replace(/\s+/g, ' ')}`,
      '',
      desc || '(описание не найдено)',
    ].filter(Boolean).join('\n').replace(/\n{3,}/g, '\n\n').trim();

    res.json({ text, title, company });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    await browser?.close().catch(() => {});
  }
});

// ── GET /api/cvs ─────────────────────────────────────────────────
app.get('/api/cvs', (req, res) => {
  const files = readdirSync(ROOT)
    .filter(f => /^cv[\w-]*\.md$/i.test(f))
    .sort();
  res.json(files);
});

// ── DELETE /api/pipeline/pending ─────────────────────────────────
app.delete('/api/pipeline/pending', (req, res) => {
  const pipelinePath = join(ROOT, 'data', 'pipeline.md');
  if (!existsSync(pipelinePath)) return res.json({ ok: true, cleared: 0 });
  const lines = readFileSync(pipelinePath, 'utf-8').split('\n');
  let cleared = 0;
  const updated = lines.map(l => {
    if (/^- \[ \] /.test(l)) { cleared++; return l.replace('- [ ] ', '- [x] '); }
    return l;
  });
  writeFileSync(pipelinePath, updated.join('\n'), 'utf-8');
  res.json({ ok: true, cleared });
});

// ── POST /api/tracker/archive ─────────────────────────────────────
app.post('/api/tracker/archive', (req, res) => {
  const { statuses = ['evaluated'] } = req.body;
  const trackerPath = join(ROOT, 'data', 'applications.md');
  if (!existsSync(trackerPath)) return res.json({ ok: true, archived: 0 });
  const lines = readFileSync(trackerPath, 'utf-8').split('\n');
  let archived = 0;
  const updated = lines.map(raw => {
    if (!raw.trim().startsWith('|') || /^\|\s*#/.test(raw) || /^\|[-\s|]+$/.test(raw)) return raw;
    const cells = raw.split('|');
    // layout: '' | num | date | company | role | score | status(6) | pdf | report | notes | ''
    if (cells.length < 8) return raw;
    const cur = normalizeStatus(cells[6] || '');
    if (statuses.includes(cur)) { cells[6] = ' Discarded '; archived++; return cells.join('|'); }
    return raw;
  });
  writeFileSync(trackerPath, updated.join('\n'), 'utf-8');
  res.json({ ok: true, archived });
});

// ── DELETE /api/tracker/rows ─────────────────────────────────────
// Removes rows from applications.md matching given statuses
app.delete('/api/tracker/rows', (req, res) => {
  const { statuses = [] } = req.body;
  if (!statuses.length) return res.json({ ok: true, deleted: 0 });

  const trackerPath = join(ROOT, 'data', 'applications.md');
  if (!existsSync(trackerPath)) return res.json({ ok: true, deleted: 0 });

  const lines   = readFileSync(trackerPath, 'utf-8').split('\n');
  let   deleted = 0;
  const updated = lines.filter(raw => {
    if (!raw.trim().startsWith('|') || /^\|\s*#/.test(raw) || /^\|[-\s|]+$/.test(raw)) return true;
    const cells = raw.split('|');
    if (cells.length < 8) return true;
    const cur = normalizeStatus(cells[6] || '');
    if (statuses.includes(cur)) { deleted++; return false; }
    return true;
  });

  writeFileSync(trackerPath, updated.join('\n'), 'utf-8');
  res.json({ ok: true, deleted });
});

// ── DELETE /api/scan-history ─────────────────────────────────────
// Resets scan-history.tsv + pipeline.md (full dedup reset)
app.delete('/api/scan-history', (req, res) => {
  const histPath     = join(ROOT, 'data', 'scan-history.tsv');
  const pipelinePath = join(ROOT, 'data', 'pipeline.md');
  const header = 'url\tfirst_seen\tportal\ttitle\tcompany\tstatus\tlocation\n';

  let deleted = 0;
  if (existsSync(histPath)) {
    deleted = readFileSync(histPath, 'utf-8').split('\n').filter(l => l.trim() && !l.startsWith('url\t')).length;
  }
  writeFileSync(histPath, header, 'utf-8');

  // Also reset pipeline.md — pending entries there count as "seen" in dedup
  let pipelineReset = 0;
  if (existsSync(pipelinePath)) {
    const lines = readFileSync(pipelinePath, 'utf-8').split('\n');
    pipelineReset = lines.filter(l => /^- \[[ x]\]/.test(l)).length;
  }
  writeFileSync(pipelinePath, '# Pipeline\n\n## Pendientes\n\n## Procesadas\n', 'utf-8');

  res.json({ ok: true, deleted, pipelineReset });
});

// ── DELETE /api/reports ───────────────────────────────────────────
// Deletes report files; mode = 'all' | 'evaluated'
app.delete('/api/reports', (req, res) => {
  const { mode = 'evaluated' } = req.body;
  const reportsDir = join(ROOT, 'reports');
  if (!existsSync(reportsDir)) return res.json({ ok: true, deleted: 0 });

  const files = readdirSync(reportsDir).filter(f => /^\d{3}-/.test(f) && f.endsWith('.md'));

  let toDelete = files;
  if (mode === 'evaluated') {
    // Only delete reports whose tracker entry has status 'evaluated'
    const tracked = loadAll().filter(v => v.source === 'tracker' && v.status === 'evaluated');
    const evalPaths = new Set(tracked.map(v => v.reportPath?.split(/[/\\]/).pop()).filter(Boolean));
    toDelete = files.filter(f => evalPaths.has(f));
  }

  let deleted = 0;
  for (const f of toDelete) {
    try { unlinkSync(join(reportsDir, f)); deleted++; } catch {}
  }
  res.json({ ok: true, deleted });
});

// ── GET /api/export/csv ───────────────────────────────────────────
app.get('/api/export/csv', (req, res) => {
  let all = loadAll().map(toDTO);
  if (req.query.status && req.query.status !== 'all')
    all = all.filter(v => v.status === req.query.status);
  if (req.query.score_min)
    all = all.filter(v => v.score && v.score >= parseFloat(req.query.score_min));
  all.sort((a, b) => (b.score || 0) - (a.score || 0));

  const headers = ['#', 'Дата', 'Компания', 'Роль', 'Оценка', 'Статус', 'URL', 'Отчёт', 'Заметки'];
  const rows = all.map(v => [
    v.number || '', v.date || '', v.company || '', v.role || '',
    v.score != null ? v.score.toFixed(1) : '',
    v.status || '', v.url || '', v.reportPath || '',
    (v.notes || '').replace(/[\r\n]+/g, ' '),
  ].map(c => `"${String(c).replace(/"/g, '""')}"`).join(','));

  const csv = '﻿' + [headers.join(','), ...rows].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="vacancies-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(csv);
});

// ── GET /api/cv ───────────────────────────────────────────────────
app.get('/api/cv', (req, res) => {
  const file = req.query.file;
  let cvPath = CV_PATH;
  if (file) {
    if (!/^cv[\w-]*\.md$/i.test(file)) return res.status(400).json({ error: 'invalid filename' });
    cvPath = join(ROOT, file);
  }
  if (!existsSync(cvPath)) return res.json({ exists: false, content: '' });
  res.json({ exists: true, content: readFileSync(cvPath, 'utf-8'), filename: cvPath.split(/[/\\]/).pop() });
});

// ── PUT /api/cv ───────────────────────────────────────────────────
app.put('/api/cv', (req, res) => {
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' });
  if (existsSync(CV_PATH)) copyFileSync(CV_PATH, CV_BACKUP);
  writeFileSync(CV_PATH, content, 'utf-8');
  res.json({ ok: true });
});

// ── POST /api/cv/upload ───────────────────────────────────────────
app.post('/api/cv/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file required' });
  try {
    const { text, pages } = await extractTextFromBuffer(req.file.buffer, req.file.originalname);
    res.json({ text, pages, filename: req.file.originalname, size: req.file.size });
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

// ── POST /api/cv/optimize ─────────────────────────────────────────
// Body: { jdText, model?, cvFile? } — streams optimized CV tokens via SSE
app.post('/api/cv/optimize', async (req, res) => {
  const { jdText, model, cvFile } = req.body;
  if (!jdText?.trim()) return res.status(400).json({ error: 'jdText required' });
  let cvPath = CV_PATH;
  if (cvFile) {
    if (!/^cv[\w-]*\.md$/i.test(cvFile)) return res.status(400).json({ error: 'invalid cvFile' });
    cvPath = join(ROOT, cvFile);
  }
  if (!existsSync(cvPath)) return res.status(404).json({ error: `${cvFile || 'cv.md'} not found` });

  const cvContent = readFileSync(cvPath, 'utf-8');

  const prompt = `Ты эксперт по написанию резюме для российского рынка труда.
Перепиши резюме кандидата так, чтобы максимально подчеркнуть релевантный опыт для данной вакансии.

Правила:
- НЕ выдумывай навыки, опыт или достижения которых нет в оригинале
- Сохраняй все факты (даты, компании, должности, образование)
- МОЖНО переставлять пункты в списках — релевантные вперёд
- МОЖНО усилить раздел «О себе» / Summary под конкретную роль
- МОЖНО переупорядочить раздел навыков
- Сохрани ту же структуру markdown и разделы
- Выведи ТОЛЬКО markdown резюме, без объяснений и вводных фраз

ВАКАНСИЯ:
${jdText.trim()}

ТЕКУЩЕЕ РЕЗЮМЕ:
${cvContent}

ОПТИМИЗИРОВАННОЕ РЕЗЮМЕ:`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const result = await streamChat(
      [{ role: 'user', content: prompt }],
      { temperature: 0.3, maxTokens: 8192 },
      token => send({ token }),
    );
    send({ done: true, result });
  } catch (e) {
    send({ error: e.message });
  }
  res.end();
});

// ── GET /api/interview-prep/:id ───────────────────────────────────
app.get('/api/interview-prep/:id', (req, res) => {
  const all = loadAll().map(toDTO);
  const v   = all.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });

  const slug = s => (s || '').toLowerCase()
    .replace(/[^a-zа-яё0-9\s]/gi, ' ')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');

  const companySlug = slug(v.company);

  const prepDir = join(ROOT, 'interview-prep');
  let reportFile    = null;
  let reportContent = null;

  if (existsSync(prepDir)) {
    const files = readdirSync(prepDir)
      .filter(f => f.endsWith('.md') && f !== 'story-bank.md');

    const exact = `${companySlug}-${slug(v.role)}.md`;
    if (files.includes(exact)) {
      reportFile = exact;
    } else if (companySlug) {
      reportFile = files.find(f => f.startsWith(companySlug + '-'))
                || files.find(f => f.includes(companySlug))
                || null;
    }

    if (reportFile) {
      reportContent = readFileSync(join(prepDir, reportFile), 'utf-8');
    }
  }

  const sbPath    = join(ROOT, 'interview-prep', 'story-bank.md');
  const storyBank = existsSync(sbPath) ? readFileSync(sbPath, 'utf-8') : null;

  const url = v.url || guessVacancyUrl(v.company, v.role) || '';

  res.json({
    hasReport:   !!reportContent,
    reportFile,
    reportHtml:  reportContent ? mdToHtml(reportContent) : null,
    storyBankHtml: storyBank ? mdToHtml(storyBank) : null,
    company:     v.company,
    role:        v.role,
    url,
    claudeCmd:   `/career-ops interview-prep ${url || v.role || v.company}`,
  });
});

// ── POST /api/interview-prep/:id/generate ─────────────────────────
// Fetches JD, reads CV+profile+storybank, streams Qwen prep report, saves file
app.post('/api/interview-prep/:id/generate', async (req, res) => {
  const { model } = req.body;

  const all = loadAll().map(toDTO);
  const v   = all.find(x => x.id === req.params.id);
  if (!v) return res.status(404).json({ error: 'not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    // 1. Get JD text
    let jdText = '';
    const url = v.url || guessVacancyUrl(v.company, v.role) || '';

    const hhMatch = url.match(/hh\.ru\/vacancy\/(\d+)/);
    if (hhMatch) {
      send({ phase: 'Загружаю вакансию с hh.ru…' });
      let browser;
      try {
        browser = await chromium.launch({ headless: true });
        const ctx  = await browser.newContext({ locale: 'ru-RU' });
        const page = await ctx.newPage();
        await page.goto(`https://hh.ru/vacancy/${hhMatch[1]}`, {
          waitUntil: 'domcontentloaded', timeout: 20_000,
        });
        const title   = await page.$eval('[data-qa="vacancy-title"]',        el => el.textContent.trim()).catch(() => '');
        const company = await page.$eval('[data-qa="vacancy-company-name"]', el => el.textContent.trim()).catch(() => '');
        const salary  = await page.$eval('[data-qa="vacancy-salary"]',       el => el.textContent.replace(/\s+/g, ' ').trim()).catch(() => '');
        const desc    = await page.$eval('[data-qa="vacancy-description"]',  el => el.innerText.trim()).catch(() => '');
        jdText = [
          title   && `# ${title}`,
          company && `Компания: ${company}`,
          salary  && `Зарплата: ${salary}`,
          '',
          desc,
        ].filter(s => s !== undefined).join('\n').trim();
      } finally {
        await browser?.close().catch(() => {});
      }
    }

    // Fallback: use evaluation report as JD context
    if (!jdText && v.reportPath) {
      send({ phase: 'Использую отчёт об оценке как контекст…' });
      const raw = loadReportFull(ROOT, v.reportPath);
      if (raw) jdText = raw;
    }

    if (!jdText) {
      send({ error: 'Не удалось получить текст вакансии. Убедись, что URL сохранён или есть отчёт об оценке.' });
      return res.end();
    }

    // 2. Load CV
    send({ phase: 'Читаю резюме и профиль…' });
    const cvContent  = existsSync(CV_PATH) ? readFileSync(CV_PATH, 'utf-8') : '(резюме не найдено)';

    const profilePath = join(ROOT, 'config', 'profile.yml');
    const profileText = existsSync(profilePath) ? readFileSync(profilePath, 'utf-8') : '';

    const sbPath      = join(ROOT, 'interview-prep', 'story-bank.md');
    const storyBank   = existsSync(sbPath) ? readFileSync(sbPath, 'utf-8') : '';

    // 3. Build prompt
    const today = new Date().toISOString().slice(0, 10);
    const company   = v.company || 'Компания';
    const role      = v.role    || 'Роль';

    const slug = s => (s || '').toLowerCase()
      .replace(/[^a-zа-яё0-9\s]/gi, ' ')
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '');
    const prepFile = `${slug(company)}-${slug(role)}.md`;

    const prompt = `Ты эксперт по подготовке к техническим интервью для российского рынка труда.

ВАКАНСИЯ:
${jdText.slice(0, 6000)}

РЕЗЮМЕ КАНДИДАТА:
${cvContent.slice(0, 3000)}

${profileText ? `ПРОФИЛЬ КАНДИДАТА (YAML):\n${profileText.slice(0, 1500)}` : ''}

${storyBank ? `ИСТОРИИ КАНДИДАТА (STAR+R):\n${storyBank.slice(0, 2000)}` : ''}

ЗАДАЧА: Создай детальный план подготовки к интервью.

ОБЯЗАТЕЛЬНЫЕ ПРАВИЛА:
- НЕ приписывай вопросы реальным источникам (Glassdoor, Blind) — у тебя нет доступа к ним
- Помечай все вопросы как [inferred from JD]
- Используй ТОЛЬКО факты из резюме кандидата для формирования ответов — не выдумывай опыт
- Ответы на вопросы должны быть конкретными, с цифрами и примерами из резюме
- Пиши на русском языке

Выведи ТОЛЬКО markdown-отчёт в следующем формате (без вводных фраз):

# Interview Intel: ${company} — ${role}

**URL:** ${url || 'N/A'}
**Источник:** Локальный анализ (Qwen) — без данных Glassdoor/Blind
**Дата:** ${today}
**Аудитории:** recruiter-screen, hiring-manager, peer-tech

---

## Процесс найма

На основе описания роли предположи типичную структуру (этапы, фокус каждого). Используй формат:
- **Этапы:** …
- **Типичный процесс:** …
- **На что обратить внимание:** …

---

## Вероятные вопросы

### Аудитория: Рекрутерский экран

Для каждого вопроса:
**"[вопрос]"** [inferred from JD]
*Что проверяют:* …
*Рекомендуемый ответ (на основе резюме):* …

Обязательно покрой: «Расскажите о себе», «Почему эта компания?», зарплатные ожидания, локация/формат, таймлайн.

### Аудитория: Технический раунд

5-8 технических вопросов, напрямую из требований вакансии. Для каждого:
**"[вопрос]"** [inferred from JD]
*Почему спросят:* (какое требование из JD покрывает)
*Сильный ответ кандидата:* (конкретные технологии/примеры из резюме)

### Аудитория: Менеджерский раунд

3-5 поведенческих вопросов. Для каждого:
**"[вопрос]"** [inferred from JD]
*Что проверяют:* …
*Лучшая история из story bank или резюме:* …

---

## Маппинг историй

| # | Вопрос | Лучшая история | Подходит? |
|---|--------|----------------|-----------|
| 1 | … | … | strong/partial/gap |

Для каждого gap: "Нужна история о [теме]. Возможный материал: [из резюме]"

---

## Чеклист технической подготовки

Максимум 8 пунктов, только то что реально спросят:
- [ ] {тема} — почему: "{цитата или суть из JD}"

---

## Красные флаги

Требования из вакансии, слабо покрытые резюме. Для каждого:
- **[требование]**: как закрыть или честно признать на интервью

---

## Вопросы от кандидата

3-5 острых вопроса к работодателю (tied to конкретным аспектам роли/компании):
1. …`;

    // 4. Stream LLM
    send({ phase: 'Генерирую план подготовки к интервью…' });

    let result;
    try {
      result = await streamChat(
        [{ role: 'user', content: prompt }],
        { temperature: 0.4, maxTokens: 8192 },
        token => send({ token }),
      );
    } catch (streamErr) {
      send({ error: streamErr.message });
      return res.end();
    }

    // 5. Strip <think> blocks (Qwen3 reasoning)
    const clean = result.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // 6. Save to interview-prep/
    const prepDir  = join(ROOT, 'interview-prep');
    mkdirSync(prepDir, { recursive: true });
    writeFileSync(join(prepDir, prepFile), clean, 'utf-8');
    send({ done: true, result: clean, prepFile });

  } catch (e) {
    send({ error: e.message });
  }
  res.end();
});

// ── Start ─────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n🌐  career-ops web UI`);
  console.log(`    http://localhost:${PORT}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌  Порт ${PORT} уже занят.`);
    console.error(`    Завершите предыдущий процесс:`);
    console.error(`    Windows: netstat -ano | findstr :${PORT}  → taskkill /PID <pid> /F`);
    console.error(`    Или задай другой порт: WEB_PORT=3001 npm run web\n`);
  } else {
    console.error(`\n❌  Ошибка сервера: ${err.message}\n`);
  }
  process.exit(1);
});
