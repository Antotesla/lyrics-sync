import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineIndexAt, ballAt, LEAD } from '../js/karaoke.js';

const lines = [
  { start: 2, words: [{ text: 'uno', start: 2, end: 2.4 }] },
  { start: 5, words: [{ text: 'due', start: 5, end: 5.4 }] },
];

test('lineIndexAt: nessuna riga prima, poi la riga diventa corrente con LEAD di anticipo', () => {
  assert.equal(lineIndexAt(lines, 0), -1);
  assert.equal(lineIndexAt(lines, 2 - LEAD + 0.01), 0);
  assert.equal(lineIndexAt(lines, 4.9), 1);
});

test('ballAt: atterra sulle parole al loro inizio e salta a metà strada', () => {
  const anchors = [{ x: 100, y: 300, start: 1 }, { x: 300, y: 300, start: 2 }];
  assert.equal(ballAt(anchors, 0), null); // prima dell'entrata
  assert.deepEqual(ballAt(anchors, 1), { x: 100, y: 300 });
  const mid = ballAt(anchors, 1.5);
  assert.equal(mid.x, 200);
  assert.ok(mid.y < 300 - 20); // in aria
  assert.deepEqual(ballAt(anchors, 2), { x: 300, y: 300 });
  assert.deepEqual(ballAt(anchors, 9), { x: 300, y: 300 }); // resta sull'ultima parola
});
