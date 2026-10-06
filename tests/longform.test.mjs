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

test('firstHallucination riconosce parole lunghissime, frasi in loop e parole a durata zero', async () => {
  const { firstHallucination } = await import('../js/longform.js');
  const c = (text, a, b) => ({ text, timestamp: [a, b] });
  assert.equal(firstHallucination([c('uno', 0, 4.1), c('due', 4.2, 4.6)]), -1); // la prima parola lunga è normale
  assert.equal(firstHallucination([c('uno', 0, 0.5), c('c', 1, 11.8), c('due', 12, 12.5)]), 1);
  const loop = [c('ciao', 0, 0.5)];
  for (let i = 0; i < 6; i++) loop.push(c(' la', 1 + i * 0.1, 1.05 + i * 0.1), c(' città,', 1.05 + i * 0.1, 1.1 + i * 0.1));
  assert.equal(firstHallucination(loop), 1);
  assert.equal(firstHallucination([c('a', 0, 0.5), c('b', 1, 1), c('c', 1, 1), c('d', 1, 1)]), 1);
  // ripetizioni normali delle canzoni non sono allucinazioni
  assert.equal(firstHallucination([c('piove,', 0, 0.5), c('piove,', 0.6, 1), c('splash,', 1.2, 1.6), c('splash', 1.7, 2)]), -1);
});

test('se una rilettura "allucina" (parola di 10 s, poi frase in loop), il tratto viene riletto con altre finestre', async () => {
  // come nei dati reali: nel tratto 88-102 s le finestre da 30 e 15 s producono una parola lunghissima e un loop
  const fn = async (slice, startSec) => {
    const len = slice.length / SAMPLE_RATE;
    const real = TRUTH.filter((w) => w.start >= startSec && w.end <= startSec + len);
    const hitsBadZone = startSec < 100 && startSec + len > 90;
    if (hitsBadZone && len >= 15) {
      const before = real.filter((w) => w.start < 88);
      const garbage = [{ text: ' c', start: 88, end: 98.7 }];
      for (let i = 0; i < 30; i++) garbage.push({ text: ' la', start: 101.5, end: 101.5 }, { text: ' città,', start: 101.5, end: 101.5 });
      const after = real.filter((w) => w.start >= 102.5);
      return { chunks: [...before, ...garbage, ...after].filter((w) => w.start < startSec + len).map((w) => ({ text: w.text, timestamp: [w.start - startSec, w.end - startSec] })) };
    }
    return { chunks: real.map((w) => ({ text: w.text, timestamp: [w.start - startSec, w.end - startSec] })) };
  };
  const words = await transcribeLongForm(audio, fn);
  assert.equal(words.filter((w) => /città|^ c$/.test(w.text)).length, 0, 'niente parole allucinate');
  assert.ok(covered(words, 88, 102) >= 13, `parole vere tra 88 e 102 s: ${covered(words, 88, 102)}`);
  for (let k = 1; k < words.length; k++) assert.ok(words[k].timestamp[0] > words[k - 1].timestamp[0], 'ordine');
});

test('assolo strumentale a metà canzone: nessuna parola persa e nessuna lettura secondo per secondo', async () => {
  // niente voce tra 50 e 60 s; Whisper "allunga" la prima parola dopo l'assolo su tutta la pausa
  const truth = TRUTH.filter((w) => w.start < 50 || w.start >= 60);
  let calls = 0;
  const fn = async (slice, startSec) => {
    calls++;
    const len = slice.length / SAMPLE_RATE;
    const ws = truth.filter((w) => w.start >= startSec - 0.01 && w.end <= startSec + len)
      .map((w) => ({ ...w, start: w.start === 60 && startSec > 49 ? startSec : w.start }));
    return { chunks: ws.map((w) => ({ text: w.text, timestamp: [w.start - startSec, w.end - startSec] })) };
  };
  const words = await transcribeLongForm(audio, fn);
  assert.equal(words.length, truth.length);
  assert.ok(calls < 40, `chiamate a Whisper: ${calls}`);
});
