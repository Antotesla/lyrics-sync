import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWords, groupWords, parseLyrics, alignLyrics } from '../js/lines.js';

const w = (text, start, end) => ({ text, timestamp: [start, end] });

test('normalizeWords corregge la prima parola "allungata" dopo un intro', () => {
  const [first, second] = normalizeWords([w(' Ciao,', 0, 4.1), w(' mondo', 4.2, 4.6)]);
  assert.ok(first.start > 3 && first.start < 4.1);
  assert.equal(second.start, 4.2);
});

test('groupWords spezza su pause, punteggiatura e maiuscole', () => {
  const words = normalizeWords([
    w(' Il', 1, 1.2), w(' sole', 1.2, 1.6), w(' splende.', 1.6, 2.0),
    w(' La', 2.0, 2.2), w(' luna', 2.2, 2.6), w(' dorme', 2.6, 3.0),
    w(' piano', 4.0, 4.4), w(' piano', 4.4, 4.8),
  ]);
  const lines = groupWords(words);
  assert.deepEqual(lines.map((l) => l.text), ['Il sole splende.', 'La luna dorme', 'piano piano']);
  assert.deepEqual(lines.map((l) => l.start), [1, 2.0, 4.0]);
});

test('parseLyrics ignora tag e righe vuote', () => {
  assert.deepEqual(parseLyrics('[Verse]\nUno due\n\n[Chorus]\nTre quattro\n'), ['Uno due', 'Tre quattro']);
});

test('parseLyrics toglie i tempi già presenti e divide le righe con due tempi', () => {
  assert.deepEqual(parseLyrics('(0:03) Uno due\n(0:37) Tre, (0:40) quattro,\n'), ['Uno due', 'Tre,', 'quattro,']);
});

test('alignLyrics usa il testo fornito e i tempi del riconoscimento, anche con errori', () => {
  const words = normalizeWords([
    w(' Spasce', 3, 3.4), w(' sotto', 3.4, 3.8), w(' il', 3.8, 4.0), w(' ponte', 4.0, 4.5),
    w(' gatto', 6.0, 6.4), w(' nero', 6.4, 6.9),
  ]);
  const lines = alignLyrics(['Splash sotto il ponte!', 'Il gatto nero'], words);
  assert.equal(lines[0].text, 'Splash sotto il ponte!');
  assert.equal(lines[0].start, 3);
  assert.ok(Math.abs(lines[1].start - 5.7) < 1e-6); // "Il" non riconosciuto: 0.3 s prima di "gatto"
  assert.equal(lines[0].uncertain, false);
});

test('alignLyrics interpola le righe non sentite e le segnala', () => {
  const words = normalizeWords([w(' alfa', 1, 1.5), w(' gamma', 9, 9.5)]);
  const lines = alignLyrics(['alfa', 'zzz yyy', 'gamma'], words);
  assert.equal(lines[1].uncertain, true);
  assert.ok(lines[1].start > 1 && lines[1].start < 9);
});
