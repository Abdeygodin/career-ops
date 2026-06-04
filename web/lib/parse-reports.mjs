import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

const RE_SUMMARY = /---SCORE_SUMMARY---([\s\S]*?)---END_SUMMARY---/;

export function loadReportFull(root, reportPath) {
  const fp = join(root, reportPath);
  if (!existsSync(fp)) return null;
  return readFileSync(fp, 'utf-8');
}

export function parseSummaryBlock(text) {
  const m = text.match(RE_SUMMARY);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

// Simple markdown → safe HTML for report rendering
export function mdToHtml(md) {
  if (!md) return '';
  return md
    // strip SCORE_SUMMARY block
    .replace(/---SCORE_SUMMARY---[\s\S]*?---END_SUMMARY---/g, '')
    // h1-h4
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    // bold / italic
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // horizontal rule
    .replace(/^---$/gm, '<hr>')
    // table rows (very simple — wrap cells in <td>)
    .replace(/^\|(.+)\|$/gm, (_, row) => {
      if (/^[-\s|]+$/.test(row)) return '';        // separator row
      const cells = row.split('|').map(c =>
        `<td>${c.trim()}</td>`
      ).join('');
      return `<tr>${cells}</tr>`;
    })
    // wrap consecutive <tr> in <table>
    .replace(/((?:<tr>.*<\/tr>\n?)+)/g, '<table>$1</table>')
    // inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // links
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>')
    // paragraphs: double newline
    .replace(/\n\n+/g, '</p><p>')
    // single newlines to <br> inside paragraphs
    .replace(/([^>])\n([^<])/g, '$1<br>$2')
    .replace(/^(?!<[htpuolba])(.+)$/gm, '<p>$1</p>')
    // clean up empty p tags
    .replace(/<p>\s*<\/p>/g, '')
    // fix double-wrapped p inside tables
    .replace(/<td><p>(.*?)<\/p><\/td>/g, '<td>$1</td>');
}

export function listReports(root) {
  const dir = join(root, 'reports');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => /^\d{3}-/.test(f) && f.endsWith('.md'))
    .sort();
}
