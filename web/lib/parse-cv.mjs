import { createRequire } from 'module';
const require = createRequire(import.meta.url);

export async function extractTextFromBuffer(buffer, filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();

  if (ext === 'pdf') {
    // pdf-parse v1: require via lib path to avoid test-file ENOENT on import
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const data = await pdfParse(buffer);
    return { text: cleanPdfText(data.text), pages: data.numpages };
  }

  if (ext === 'docx') {
    const mammoth = require('mammoth');
    const result = await mammoth.extractRawText({ buffer });
    return { text: result.value.trim(), pages: null };
  }

  // .txt / .md — plain text
  return { text: buffer.toString('utf-8').trim(), pages: null };
}

function cleanPdfText(raw) {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // collapse 3+ blank lines to 2
    .replace(/\n{3,}/g, '\n\n')
    // remove form-feed chars
    .replace(/\f/g, '\n\n')
    .trim();
}
