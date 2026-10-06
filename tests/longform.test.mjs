import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeLongForm, SAMPLE_RATE } from '../js/longform.js';

// Brano finto di 120 s con una parola ogni secondo (da 2 s a 118 s)
const TRUTH = Array.from({ length: 117 }, (_, i) => ({ text: ` w${i + 2}`, start: i + 2, end: i + 2.5 }));
const audio = new Float32Array(120 * SAMPLE_RATE);

/** Whisper finto: restituisce le parole vere che cadono nel tratto, con tempi relativi. */
function fakeWhisper({ skipFrom = null, skipTo = null } = {}) {
  const calls = [];
  const fn = async (slice, startSec) => {
    const len = slice.length / SAMPLE_RATE;
    calls.push([startSec, len]);
    let ws = TRUTH.filter((w) => w.start >= startSec && w.end <= startSec + len);
    // il difetto visto nei dati reali: nella finestra lunga che parte nel tratto, Whisper salta avanti
    if (skipFrom != null && len > 20 && startSec >= skipFrom - 1 && startSec < skipTo) ws = ws.filter((w) => w.start >= skipTo);
    return { chunks: ws.map((w) => ({ text: w.text, timestamp: [w.start - startSec, w.end - startSec] })) };
  };
  return { fn, calls };
}

const covered = (words, a, b) => words.filter((w) => w.timestamp[0] >= a && w.timestamp[0] < b).length;

test('senza difetti: tutte le parole, in ordine, senza doppioni', async () => {
  const { fn } = fakeWhisper();
  const words = await transcribeLongForm(audio, fn);
  assert.equal(words.length, TRUTH.length);
  for (let k = 1; k < words.length; k++) assert.ok(words[k].timestamp[0] > words[k - 1].timestamp[0]);
});

test('se Whisper salta 28 s in una finestra, il tratto viene riletto e non va perso', async () => {
  // come nei dati reali: ultima parola a ~74,5 s, poi la finestra riparte da 102,5 s
  const { fn, calls } = fakeWhisper({ skipFrom: 74, skipTo: 102 });
  const words = await transcribeLongForm(audio, fn);
  assert.equal(covered(words, 75, 102), 27, 'parole tra 75 e 102 s');
  assert.equal(words.length, TRUTH.length);
  assert.ok(calls.some(([, len]) => len <= 15), 'ha usato finestre corte per rileggere');
  for (let k = 1; k < words.length; k++) assert.ok(words[k].timestamp[0] > words[k - 1].timestamp[0], 'ordine');
});

test('una finestra che non restituisce nulla viene riletta invece di saltare 28 s', async () => {
  const fn = async (slice, startSec) => {
    const len = slice.length / SAMPLE_RATE;
    if (len > 20 && startSec >= 40 && startSec < 45) return { chunks: [] }; // finestra "muta"
    const ws = TRUTH.filter((w) => w.start >= startSec && w.end <= startSec + len);
    return { chunks: ws.map((w) => ({ text: w.text, timestamp: [w.start - startSec, w.end - startSec] })) };
  };
  const words = await transcribeLongForm(audio, fn);
  assert.ok(covered(words, 45, 68) >= 20, `parole tra 45 e 68 s: ${covered(words, 45, 68)}`);
});
