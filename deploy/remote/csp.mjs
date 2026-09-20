import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

/** @param {string} html */
export function productionCsp(html) {
  const hashes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)]
    .filter(match => !/\bsrc\s*=/.test(match[0].split('>')[0]))
    .map(match => `'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
  if (!hashes.length && !/<script\b[^>]*\bsrc\s*=/i.test(html)) throw new Error('missing production entry scripts');
  const scriptSrc = hashes.length ? `'self' ${hashes.join(' ')}` : "'self'";
  return `default-src 'none'; script-src ${scriptSrc}; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' wss: https:; worker-src 'self' blob:; frame-src blob:; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; manifest-src 'self'`;
}

if (process.argv[1]?.endsWith('/csp.mjs') || process.argv[1] === 'deploy/remote/csp.mjs') {
  const [, , input, output] = process.argv;
  if (!input || !output) throw new Error('input and output required');
  writeFileSync(output, `header Content-Security-Policy "${productionCsp(readFileSync(input, 'utf8'))}"\n`);
}
