import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateDropRound,
  calculateSessionPoints,
  sessionMultiplier
} from '../src/domain/scoring.js';

const scoring = [
  { position: 3, points: 10 },
  { position: 1, points: 20 },
  { position: 2, points: 15 }
];

test('uses the configured P1 score as the multiplier base', () => {
  assert.equal(sessionMultiplier({ points_max: 40 }, scoring), 2);
});

test('scores every view from one session-points rule', () => {
  const points = calculateSessionPoints(
    { points_max: 40 },
    [
      { driver_id: 'a', position: 1, dnf: false },
      { driver_id: 'b', position: 2, dnf: false },
      { driver_id: 'c', position: 3, dnf: false }
    ],
    scoring
  );
  assert.deepEqual(points, { a: 40, b: 30, c: 20 });
});

test('gives a DNF the last classified finisher points', () => {
  const points = calculateSessionPoints(
    { points_max: 20 },
    [
      { driver_id: 'a', position: 1, dnf: false },
      { driver_id: 'b', position: 2, dnf: false },
      { driver_id: 'c', position: 3, dnf: true }
    ],
    scoring
  );
  assert.deepEqual(points, { a: 20, b: 15, c: 15 });
});

test('drops a missed round as zero and requires two completed rounds', () => {
  assert.deepEqual(
    calculateDropRound({ round1: 35 }, ['round1'], true),
    { droppedEventId: null, droppedPoints: 0 }
  );
  assert.deepEqual(
    calculateDropRound({ round1: 35, round3: 20 }, ['round1', 'round2', 'round3'], true),
    { droppedEventId: 'round2', droppedPoints: 0 }
  );
});
