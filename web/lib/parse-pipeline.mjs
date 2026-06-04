import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export function parsePipeline(root) {
  const path = join(root, 'data', 'pipeline.md');
  if (!existsSync(path)) return [];

  const entries = [];
  for (const raw of readFileSync(path, 'utf-8').split('\n')) {
    // Match both pending [ ] and processed [x] lines
    const m = raw.match(/^- \[([ x])\] (\S+)\s*\|\s*([^|]+?)\s*\|\s*(.+)$/);
    if (!m) continue;

    const [, checked, rawUrl, company, title] = m;
    const url = rawUrl.startsWith('local:') ? null : rawUrl;

    entries.push({
      id:        `p-${createHash('md5').update(rawUrl).digest('hex').slice(0, 10)}`,
      source:    'pipeline',
      jobSource: detectSource(rawUrl),
      url,
      localPath: rawUrl.startsWith('local:') ? rawUrl.slice(6) : null,
      date:      new Date().toISOString().split('T')[0],
      company:   company.trim(),
      role:      title.trim().replace(/\s*→.*$/, ''), // strip → annotation
      status:    checked === 'x' ? 'evaluated' : 'pending',
      score:     null,
      hasPDF:    false,
      notes:     '',
    });
  }
  return entries;
}

function detectSource(url) {
  if (url.includes('hh.ru'))       return 'hh';
  if (url.includes('habr'))        return 'habr';
  if (url.includes('getmatch'))    return 'getmatch';
  if (url.includes('superjob'))    return 'superjob';
  if (url.includes('t.me') || url.includes('telegram')) return 'telegram';
  if (url.startsWith('local:'))    return 'local';
  return 'other';
}
