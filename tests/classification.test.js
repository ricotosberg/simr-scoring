import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyDriverByEfficiency } from '../src/domain/classification.js';

test('keeps drivers provisional until five starts', () => {
  assert.equal(classifyDriverByEfficiency(99, 4), 'U');
  assert.equal(classifyDriverByEfficiency(99, 5), 'P');
});

test('uses the current SimR default efficiency bands', () => {
  assert.equal(classifyDriverByEfficiency(72, 10), 'P');
  assert.equal(classifyDriverByEfficiency(55, 10), 'G');
  assert.equal(classifyDriverByEfficiency(35, 10), 'S');
  assert.equal(classifyDriverByEfficiency(34.99, 10), 'B');
});

test('accepts season-configured thresholds', () => {
  const thresholds = { p: 80, g: 60, s: 40 };
  assert.equal(classifyDriverByEfficiency(75, 10, thresholds), 'G');
  assert.equal(classifyDriverByEfficiency(39, 10, thresholds), 'B');
});
