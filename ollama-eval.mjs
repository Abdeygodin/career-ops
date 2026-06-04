#!/usr/bin/env node
/**
 * ollama-eval.mjs — Local Ollama-powered Job Offer Evaluator for career-ops
 *
 * Zero-cloud alternative: runs against a local Ollama instance via the
 * OpenAI-compatible /v1/chat/completions endpoint. No API key required.
 *
 * Usage:
 *   node ollama-eval.mjs "Paste full JD text here"
 *   node ollama-eval.mjs --file ./jds/job.txt --lang ru
 *   node ollama-eval.mjs --model qwen3:14b --debug --file ./jds/job.txt
 *
 * Requires:
 *   Ollama running at OLLAMA_HOST (default: http://localhost:11434)
 *   Model pulled: ollama pull qwen3:14b
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// Bootstrap: load .env before anything else
// ---------------------------------------------------------------------------
try {
  const { config } = await import('dotenv');
  config();
} catch {
  // dotenv optional
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------
const ROOT = dirname(fileURLToPath(import.meta.url));

const PATHS = {
  shared:     join(ROOT, 'modes', '_shared.md'),
  sharedRu:   join(ROOT, 'modes', 'ru', '_shared.md'),
  oferta:     join(ROOT, 'modes', 'oferta.md'),
  ofertaRu:   join(ROOT, 'modes', 'ru', 'oferta.md'),
  cv:         join(ROOT, 'cv.md'),
  profile:    join(ROOT, 'modes', '_profile.md'),
  profileYml: join(ROOT, 'config', 'profile.yml'),
  reports:    join(ROOT, 'reports'),
  debugDir:   join(ROOT, 'data', 'ollama-debug'),
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║         career-ops — Ollama Evaluator (local, zero-cost)        ║
╚══════════════════════════════════════════════════════════════════╝

  Evaluate a job offer using a local Ollama model. No cloud, no cost.

  USAGE
    node ollama-eval.mjs "<JD text>"
    node ollama-eval.mjs --file ./jds/my-job.txt
    node ollama-eval.mjs --file ./jds/job.txt --lang ru
    node ollama-eval.mjs --model qwen3:14b --debug --file ./jds/job.txt

  OPTIONS
    --file <path>    Read JD from a file instead of inline text
    --model <name>   Ollama model (default: OLLAMA_MODEL env or qwen3:14b)
    --lang <ru|en>   Prompt language: ru = Russian modes, en = English (default: ru)
    --no-save        Do not save report to reports/ directory
    --debug          Log raw model response to data/ollama-debug/{timestamp}.txt
    --help           Show this help

  SETUP
    1. Install Ollama:  https://ollama.ai
    2. Pull model:      ollama pull qwen3:14b
    3. Start Ollama:    ollama serve
    4. Add to .env:     OLLAMA_MODEL=qwen3:14b
    5. Run:             node ollama-eval.mjs --file ./jds/job.txt

  EXAMPLES
    node ollama-eval.mjs "We are looking for a DevSecOps Engineer..."
    node ollama-eval.mjs --file ./jds/yandex-devsecops.txt --lang ru
    node ollama-eval.mjs --model mistral --no-save "JD text here"
`);
  process.exit(0);
}

// Parse flags
let jdText = '';
let jdUrl = '';
let modelName = process.env.OLLAMA_MODEL || 'qwen3:14b';
let saveReport = true;
let lang = process.env.DEFAULT_LANG || 'ru';
let debug = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file' && args[i + 1]) {
    const filePath = args[++i];
    if (!existsSync(filePath)) {
      console.error(`❌  File not found: ${filePath}`);
      process.exit(1);
    }
    jdText = readFileSync(filePath, 'utf-8').trim();
  } else if (args[i] === '--url' && args[i + 1]) {
    jdUrl = args[++i];
  } else if (args[i] === '--model' && args[i + 1]) {
    modelName = args[++i];
  } else if (args[i] === '--lang' && args[i + 1]) {
    lang = args[++i];
    if (!['ru', 'en'].includes(lang)) {
      console.error('❌  --lang must be "ru" or "en"');
      process.exit(1);
    }
  } else if (args[i] === '--no-save') {
    saveReport = false;
  } else if (args[i] === '--debug') {
    debug = true;
  } else if (!args[i].startsWith('--')) {
    jdText += (jdText ? '\n' : '') + args[i];
  }
}

if (!jdText) {
  console.error('❌  No Job Description provided. Run with --help for usage.');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const _rawHost   = process.env.OLLAMA_HOST || 'http://localhost:11434';
const OLLAMA_HOST = (_rawHost.startsWith('http://') || _rawHost.startsWith('https://'))
  ? _rawHost.replace(/\/$/, '')
  : `http://${_rawHost.replace(/\/$/, '')}`;
const TIMEOUT_MS  = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);
const CHAT_URL    = `${OLLAMA_HOST}/v1/chat/completions`;

// ---------------------------------------------------------------------------
// Ollama liveness check
// ---------------------------------------------------------------------------
async function checkOllamaLiveness() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.models || []).map(m => m.name);
    return { alive: true, models };
  } catch (err) {
    return { alive: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// File helper
// ---------------------------------------------------------------------------
function readFile(path, label) {
  if (!existsSync(path)) {
    console.warn(`⚠️   ${label} not found at: ${path}`);
    return `[${label} not found — skipping]`;
  }
  return readFileSync(path, 'utf-8').trim();
}

function nextReportNumber() {
  if (!existsSync(PATHS.reports)) return '001';
  const files = readdirSync(PATHS.reports)
    .filter(f => /^\d{3}-/.test(f))
    .map(f => parseInt(f.slice(0, 3)))
    .filter(n => !isNaN(n));
  if (files.length === 0) return '001';
  return String(Math.max(...files) + 1).padStart(3, '0');
}

// ---------------------------------------------------------------------------
// Block 7 — Anti-hallucination: strip Qwen3 reasoning + markdown fences
// ---------------------------------------------------------------------------
function stripModelArtifacts(text) {
  // Qwen3 thinking mode wraps reasoning in <think>...</think>
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Some models wrap the whole response in a markdown code fence
  text = text.replace(/^```(?:markdown|json|text)?\n([\s\S]*)\n```$/i, '$1').trim();
  return text;
}

// ---------------------------------------------------------------------------
// Block 7 — Anti-hallucination: validate ---SCORE_SUMMARY--- fields
// Returns array of warning strings (empty = valid).
// ---------------------------------------------------------------------------
function validateScoreSummary(company, role, score) {
  const warnings = [];

  const scoreNum = parseFloat(score);
  if (isNaN(scoreNum) || scoreNum < 0 || scoreNum > 5) {
    warnings.push(`SCORE "${score}" is not a valid 0.0–5.0 number`);
  }

  const unknownCompany = !company || company.toLowerCase() === 'unknown';
  const unknownRole    = !role    || role.toLowerCase()    === 'unknown';
  if (unknownCompany && unknownRole) {
    warnings.push('COMPANY and ROLE are both Unknown — could not parse job metadata. Check input JD.');
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Load context files (lang-aware: ru → modes/ru/, en → modes/)
// ---------------------------------------------------------------------------
console.log(`\n📂  Loading context files (lang: ${lang})...`);

const sharedContext  = lang === 'ru'
  ? readFile(PATHS.sharedRu, 'modes/ru/_shared.md')
  : readFile(PATHS.shared,   'modes/_shared.md');

const ofertaLogic    = lang === 'ru'
  ? readFile(PATHS.ofertaRu, 'modes/ru/oferta.md')
  : readFile(PATHS.oferta,   'modes/oferta.md');

const cvContent      = readFile(PATHS.cv,          'cv.md');
const profileYml     = readFile(PATHS.profileYml,  'config/profile.yml');
// _profile.md is optional (created during onboarding) — read silently
const profileContent = existsSync(PATHS.profile)
  ? readFileSync(PATHS.profile, 'utf-8').trim()
  : '';

// ---------------------------------------------------------------------------
// Build system prompt (same structure as gemini-eval.mjs)
// ---------------------------------------------------------------------------
const langNote = lang === 'ru'
  ? 'Respond in Russian unless the JD is in another language.'
  : 'Respond in English unless the JD is in another language.';

const systemPrompt = `You are career-ops, an AI-powered job search assistant.
You evaluate job offers against the user's CV using a structured A-G scoring system.

Your evaluation methodology is defined below. Follow it exactly.

═══════════════════════════════════════════════════════
SYSTEM CONTEXT (_shared.md)
═══════════════════════════════════════════════════════
${sharedContext}

═══════════════════════════════════════════════════════
EVALUATION MODE (oferta.md)
═══════════════════════════════════════════════════════
${ofertaLogic}

═══════════════════════════════════════════════════════
CANDIDATE RESUME (cv.md)
═══════════════════════════════════════════════════════
${cvContent}

═══════════════════════════════════════════════════════
CANDIDATE PROFILE & TARGETS (config/profile.yml)
═══════════════════════════════════════════════════════
${profileYml}

${profileContent ? `═══════════════════════════════════════════════════════
USER ARCHETYPES & NARRATIVE (_profile.md)
═══════════════════════════════════════════════════════
${profileContent}

` : ''}═══════════════════════════════════════════════════════
IMPORTANT OPERATING RULES FOR THIS SESSION
═══════════════════════════════════════════════════════
1. You do NOT have access to WebSearch, Playwright, or file writing tools.
   - For Block D (Comp research): provide salary estimates from your training data, clearly marked as estimates.
   - For Block G (Legitimacy): analyze the JD text only; skip URL/page freshness checks.
   - Post-evaluation file saving is handled by the script, not by you.
2. ${langNote}
3. At the very end, output a machine-readable summary block in this EXACT format (no extra text after it):

---SCORE_SUMMARY---
COMPANY: <company name or "Unknown">
ROLE: <role title>
SCORE: <global score as decimal, e.g. 3.8>
ARCHETYPE: <detected archetype>
LEGITIMACY: <High Confidence | Proceed with Caution | Suspicious>
---END_SUMMARY---
`;

// ---------------------------------------------------------------------------
// Ollama liveness check
// ---------------------------------------------------------------------------
console.log(`\n🔍  Checking Ollama at ${OLLAMA_HOST}...`);
const liveness = await checkOllamaLiveness();

if (!liveness.alive) {
  console.error(`
❌  Ollama is not running or unreachable at ${OLLAMA_HOST}

   Start Ollama:       ollama serve
   Pull the model:     ollama pull ${modelName}
   Override host:      set OLLAMA_HOST in .env

   Error: ${liveness.error}
`);
  process.exit(1);
}

// Exact match: strip :latest suffix from both sides before comparing
const norm = s => s.replace(/:latest$/, '');
const modelInstalled = liveness.models.some(m => norm(m) === norm(modelName));
if (!modelInstalled) {
  console.error(`
❌  Model "${modelName}" is not pulled in Ollama.

   Installed models: ${liveness.models.join(', ') || '(none)'}

   Pull it and retry:
     ollama pull ${modelName}

   Or use an already-installed model:
     node ollama-eval.mjs --model ${liveness.models[0] || 'qwen3:14b'} --file ...
`);
  process.exit(1);
}

const modelList = liveness.models.slice(0, 5).join(', ') + (liveness.models.length > 5 ? '...' : '');
console.log(`✅  Ollama running. Models: ${modelList}`);

// ---------------------------------------------------------------------------
// Call Ollama (OpenAI-compatible /v1/chat/completions)
// ---------------------------------------------------------------------------
const promptTokenEstimate = Math.round((systemPrompt.length + jdText.length) / 4);
console.log(`\n🤖  Calling Ollama (${modelName}, lang=${lang})`);
console.log(`    Prompt: ~${promptTokenEstimate} tokens | Timeout: ${TIMEOUT_MS / 1000}s | think: false\n`);

let evaluationText;
try {
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  // Live elapsed-time counter so the terminal doesn't look frozen
  const startTime = Date.now();
  const progressTimer = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r⏳  Generating... ${elapsed}s`);
  }, 1000);

  const response = await fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: controller.signal,
    body: JSON.stringify({
      model: modelName,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: `JOB DESCRIPTION TO EVALUATE:\n\n${jdText}` },
      ],
      temperature: 0.3,
      max_tokens: 8192,
      stream: false,
      think: false,          // disable Qwen3 CoT — prevents multi-minute thinking buffering
      options: {
        num_ctx: 8192,       // ensure full system prompt fits; override Modelfile default
      },
    }),
  });

  clearInterval(progressTimer);
  process.stdout.write(`\r\x1b[K✅  Generated in ${Math.round((Date.now() - startTime) / 1000)}s\n`);
  clearTimeout(abortTimer);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  evaluationText = data.choices?.[0]?.message?.content;
  if (!evaluationText) throw new Error('Model returned empty content');

} catch (err) {
  if (err.name === 'AbortError') {
    console.error(`❌  Request timed out after ${TIMEOUT_MS / 1000}s.`);
    console.error(`    If using qwen3, make sure think:false is accepted by your Ollama version (>=0.6).`);
    console.error(`    Otherwise increase OLLAMA_TIMEOUT_MS in .env or switch to a faster model.`);
  } else {
    console.error('❌  Ollama request failed:', err.message);
  }
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Post-process: strip Qwen3 artifacts (Block 7)
// ---------------------------------------------------------------------------
evaluationText = stripModelArtifacts(evaluationText);

// ---------------------------------------------------------------------------
// Debug logging (Block 7)
// ---------------------------------------------------------------------------
if (debug) {
  mkdirSync(PATHS.debugDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const debugPath = join(PATHS.debugDir, `${timestamp}.txt`);
  writeFileSync(debugPath, evaluationText, 'utf-8');
  console.log(`🐛  Raw response saved: data/ollama-debug/${timestamp}.txt`);
}

// ---------------------------------------------------------------------------
// Display evaluation
// ---------------------------------------------------------------------------
console.log('\n' + '═'.repeat(66));
console.log(`  CAREER-OPS EVALUATION — powered by Ollama (${modelName})`);
console.log('═'.repeat(66) + '\n');
console.log(evaluationText);

// ---------------------------------------------------------------------------
// Parse ---SCORE_SUMMARY---
// ---------------------------------------------------------------------------
const summaryMatch = evaluationText.match(
  /---SCORE_SUMMARY---\s*([\s\S]*?)---END_SUMMARY---/
);

let company    = 'unknown';
let role       = 'unknown';
let score      = '?';
let archetype  = 'unknown';
let legitimacy = 'unknown';

if (summaryMatch) {
  const block = summaryMatch[1];
  const extract = (key) => {
    for (const line of block.split('\n')) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith(`${key}:`)) return trimmed.slice(key.length + 1).trim();
    }
    return 'unknown';
  };
  company    = extract('COMPANY');
  role       = extract('ROLE');
  score      = extract('SCORE');
  archetype  = extract('ARCHETYPE');
  legitimacy = extract('LEGITIMACY');
} else {
  console.warn('\n⚠️   ---SCORE_SUMMARY--- block not found in response.');
  console.warn('    Run with --debug to inspect the raw model output.');
}

// ---------------------------------------------------------------------------
// Validate score summary (Block 7)
// ---------------------------------------------------------------------------
const validationWarnings = validateScoreSummary(company, role, score);
let scoreValid = validationWarnings.length === 0;

if (validationWarnings.length > 0) {
  console.warn('\n⚠️   Validation warnings:');
  for (const w of validationWarnings) console.warn(`    • ${w}`);

  if (validationWarnings.some(w => w.includes('COMPANY and ROLE'))) {
    console.error('\n❌  Cannot save report: job metadata unparseable. Check input JD and retry.');
    process.exit(1);
  }
  if (validationWarnings.some(w => w.includes('SCORE'))) {
    console.warn('    Report will NOT be saved to tracker due to invalid score.');
    scoreValid = false;
  }
}

// ---------------------------------------------------------------------------
// Save report
// ---------------------------------------------------------------------------
if (saveReport && scoreValid) {
  try {
    mkdirSync(PATHS.reports, { recursive: true });

    const num         = nextReportNumber();
    const today       = new Date().toISOString().split('T')[0];
    const companySlug = company.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const filename    = `${num}-${companySlug}-${today}.md`;
    const reportPath  = join(PATHS.reports, filename);

    const reportContent = `# Evaluation: ${company} — ${role}

**Date:** ${today}
**URL:** ${jdUrl}
**Archetype:** ${archetype}
**Score:** ${score}/5
**Legitimacy:** ${legitimacy}
**PDF:** pending
**Tool:** Ollama (${modelName}, lang=${lang})

---

${evaluationText.replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/, '').trim()}

${summaryMatch ? summaryMatch[0] : ''}
`;

    writeFileSync(reportPath, reportContent, 'utf-8');
    console.log(`\n✅  Report saved: reports/${filename}`);
    console.log(`\n📊  Tracker entry (copy to batch/tracker-additions/${num}-${companySlug}.tsv):`);
    console.log(`    ${num}\t${today}\t${company}\t${role}\tEvaluated\t${score}/5\t❌\t[${num}](reports/${filename})\t`);
  } catch (err) {
    console.warn(`⚠️   Could not save report: ${err.message}`);
  }
} else if (saveReport && !scoreValid) {
  console.warn('⚠️   Report not saved (invalid score). Fix the JD input or use --no-save to suppress this check.');
}

console.log('\n' + '─'.repeat(66));
console.log(`  Score: ${score}/5  |  Archetype: ${archetype}  |  Legitimacy: ${legitimacy}`);
console.log('─'.repeat(66) + '\n');
