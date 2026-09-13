import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(projectRoot, 'src/app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');

test('every legacy inline handler can reach its application function', () => {
  const definedFunctions = new Set(
    [...appSource.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1])
  );
  const handlerSource = `${htmlSource}\n${appSource}`;
  const attributes = [...handlerSource.matchAll(/on(?:click|change|input|keydown|drop|dragover|dragleave)="([^"]+)"/g)]
    .map(match => match[1]);
  const calledNames = new Set(
    attributes.flatMap(attribute => [...attribute.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map(match => match[1]))
  );
  const exposedBlock = appSource.match(/const legacyUiActions = \{([\s\S]*?)\n\};/)?.[1] || '';

  const missing = [...calledNames]
    .filter(name => definedFunctions.has(name) && !new RegExp(`\\b${name}\\b`).test(exposedBlock));
  assert.deepEqual(missing, []);
});

test('legacy inline state variables are bridged explicitly', () => {
  assert.match(appSource, /Object\.defineProperties\(window/);
  assert.match(appSource, /_sequencerSlots:\s*\{/);
  assert.match(appSource, /scoringRows:\s*\{/);
});
