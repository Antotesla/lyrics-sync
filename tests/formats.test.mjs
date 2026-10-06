import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatShort, formatPrecise, parseTime, toTxt, toLrc, toSrt } from '../js/formats.js';

const lines = [{ start: 3.44, end: 6.5, text: 'Prima riga' }, { start: 63.0, end: 70, text: 'Seconda' }];

test('formatShort/formatPrecise/parseTime', () => {
  assert.equal(formatShort(3.44), '0:03');
  assert.equal(formatShort(6.74), '0:07');
  assert.equal(formatShort(63), '1:03');
  assert.equal(formatPrecise(63.46), '1:03.5');
  assert.equal(parseTime('1:03.4'), 63.4);
  assert.equal(parseTime('12,5'), 12.5);
  assert.equal(parseTime('abc'), null);
});

test('toTxt riproduce il formato "(m:ss) testo"', () => {
  assert.equal(toTxt(lines), '(0:03) Prima riga\n(1:03) Seconda\n');
});

test('toLrc', () => {
  assert.equal(toLrc(lines), '[00:03.44]Prima riga\n[01:03.00]Seconda\n');
});

test('toSrt non sovrappone i sottotitoli', () => {
  const srt = toSrt([{ start: 1, end: 5, text: 'a' }, { start: 4, end: 6, text: 'b' }]);
  assert.match(srt, /00:00:01,000 --> 00:00:04,000\na/);
});

test('toAss: una riga per verso, parole con \\kf e pausa iniziale con \\k', async () => {
  const { toAss } = await import('../js/formats.js');
  const ass = toAss([{
    start: 2, end: 3.2, text: 'Ciao mondo',
    words: [{ text: 'Ciao', start: 2, end: 2.5 }, { text: 'mondo', start: 2.7, end: 3.2 }],
  }]);
  const dlg = ass.split('\n').find((l) => l.startsWith('Dialogue:'));
  assert.equal(dlg, 'Dialogue: 0,0:00:01.40,0:00:05.20,Karaoke,,0,0,0,,{\\k60}{\\kf50}Ciao {\\k20}{\\kf50}mondo');
  assert.match(ass, /\[V4\+ Styles\]/);
});
