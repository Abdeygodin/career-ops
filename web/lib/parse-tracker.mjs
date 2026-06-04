import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const RE_SCORE    = /(\d+\.?\d*)\/5/;
const RE_REPORT   = /\[(\d+)\]\(([^)]+)\)/;
const RE_URL      = /\*\*URL:\*\*\s*(https?:\/\/\S+)/;
const RE_ARCH     = /\*\*Архетип:\*\*\s*(.+)|Archetype:\*\*\s*(.+)/i;
const RE_LEGIT    = /\*\*Legitimacy:\*\*\s*(.+)/i;
const RE_SUMMARY  = /---SCORE_SUMMARY---([\s\S]*?)---END_SUMMARY---/;

export function parseTracker(root) {
  const path = join(root, 'data', 'applications.md');
  if (!existsSync(path)) return [];

  const entries = [];
  for (const raw of readFileSync(path, 'utf-8').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('|') || /^\|\s*#/.test(line) || /^\|[-\s|]+$/.test(line)) continue;

    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (cells.length < 7) continue;

    const [numRaw, date, company, role, scoreRaw, status, pdfRaw, reportRaw, ...noteParts] = cells;
    const numMatch   = numRaw.match(/\d+/);
    const scoreMatch = scoreRaw.match(RE_SCORE);
    const repMatch   = reportRaw?.match(RE_REPORT);

    entries.push({
      id:           `t-${numRaw.replace(/\s/g, '')}`,
      source:       'tracker',
      number:       numMatch ? parseInt(numMatch[0]) : null,
      date:         date || '',
      company:      company || '',
      role:         role || '',
      score:        scoreMatch ? parseFloat(scoreMatch[1]) : null,
      scoreRaw:     scoreRaw || '',
      status:       normalizeStatus(status || ''),
      statusRaw:    status || '',
      hasPDF:       pdfRaw?.includes('✅') ?? false,
      reportPath:   repMatch?.[2] ?? null,
      reportNumber: repMatch?.[1] ?? null,
      notes:        noteParts.join(' | ').trim(),
      url:          null,
      archetype:    null,
      legitimacy:   null,
    });
  }
  return entries;
}

export function enrichFromReports(root, entries) {
  for (const e of entries) {
    if (!e.reportPath) continue;
    const fp = join(root, e.reportPath);
    if (!existsSync(fp)) continue;

    const text   = readFileSync(fp, 'utf-8');
    const header = text.slice(0, 1500);

    const urlM   = header.match(RE_URL);
    const archM  = header.match(RE_ARCH);
    const legitM = header.match(RE_LEGIT);

    if (urlM)   e.url       = urlM[1];
    if (archM)  e.archetype = (archM[1] || archM[2] || '').trim();
    if (legitM) e.legitimacy = legitM[1].trim();

    // Fallback: parse SCORE_SUMMARY
    if (!e.url) {
      const sumM = text.match(RE_SUMMARY);
      if (sumM) {
        for (const ln of sumM[1].split('\n')) {
          const [k, ...v] = ln.split(':');
          if (k?.trim() === 'ARCHETYPE' && !e.archetype) e.archetype = v.join(':').trim();
        }
      }
    }
  }
  return entries;
}

export function normalizeStatus(raw) {
  const s = raw.replace(/\*\*/g, '').toLowerCase().trim();
  if (/interview|собес/.test(s))               return 'interview';
  if (/offer|оффер/.test(s))                   return 'offer';
  if (/responded|ответ/.test(s))               return 'responded';
  if (/applied|откликнул|sent/.test(s))        return 'applied';
  if (/rejected|отказ|отклонён/.test(s))       return 'rejected';
  if (/discarded|архив|descartado/.test(s))    return 'discarded';
  if (/skip|пропуст|no_aplic/.test(s))         return 'skip';
  if (/evaluated|оценен|evalua/.test(s))       return 'evaluated';
  if (/pending|ожида/.test(s))                 return 'pending';
  return s || 'evaluated';
}

export const STATUS_RU = {
  pending:    'Не оценено',
  evaluated:  'Оценено',
  apply:      'Откликнуться',
  applied:    'Откликнулся',
  responded:  'Ответили',
  interview:  'Собеседование',
  offer:      'Оффер',
  rejected:   'Отказ',
  discarded:  'Архив',
  skip:       'Пропустить',
};
