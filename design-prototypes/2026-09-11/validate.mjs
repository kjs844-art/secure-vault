import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const names = ['index.html','initial-comparison.html','01-monolith.html','02-quiet-vault.html','03-atlas-network.html','mobile-app.html'];
const results = [];
const failures = [];
for (const name of names) {
  const text = fs.readFileSync(path.join(root, name), 'utf8');
  const scripts = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  const externalScripts = [...text.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].map(match => match[1]);
  for (const source of externalScripts) {
    try { new vm.Script(fs.readFileSync(path.join(root, source), 'utf8'), { filename: source }); }
    catch (error) { failures.push(`${name}: external script ${source}: ${error.message}`); }
  }
  for (const [index, script] of scripts.entries()) {
    try { new vm.Script(script[1], { filename: `${name}:inline-${index}` }); }
    catch (error) { failures.push(`${name}: ${error.message}`); }
  }
  const ids = [...text.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  if (new Set(ids).size !== ids.length) failures.push(`${name}: duplicate IDs`);
  if (!/lang="ko"/.test(text) || !/name="viewport"/.test(text)) failures.push(`${name}: language/viewport missing`);
  if (!text.includes("connect-src 'none'")) failures.push(`${name}: explicit network block missing`);
  const resources = [...text.matchAll(/\b(?:src|href)=["']([^"']+)["']/gi)].map(m => m[1]);
  const localLinks = resources.filter(url => !/^(?:https?:|data:|#)/i.test(url));
  for (const link of localLinks) if (!fs.existsSync(path.join(root, link))) failures.push(`${name}: missing link ${link}`);
  if (/<(?:script|img|iframe)\b[^>]*\bsrc=["']https?:/i.test(text) || /@import\s|url\(\s*["']?https?:/i.test(text)) failures.push(`${name}: external automatic resource`);
  if (/\b(?:fetch|XMLHttpRequest|localStorage|sessionStorage|indexedDB|serviceWorker)\b/.test(scripts.map(s=>s[1]).join('\n'))) failures.push(`${name}: network/storage API present`);
  results.push({ file:name, inlineScriptsParsed:scripts.length, localLinksChecked:localLinks.length, ids:ids.length });
}
console.log(JSON.stringify({ scope:'Static syntax, local resources, no automatic external assets, no network/storage APIs; not a browser/security audit', results, failures }, null, 2));
process.exitCode = failures.length ? 1 : 0;
