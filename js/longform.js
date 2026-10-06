// Trascrizione di un brano lungo con Whisper, a finestre di 30 s che riprendono dall'ultima parola.
// Modulo puro (Whisper viene passato come funzione) così è testabile con `node --test`.

export const SAMPLE_RATE = 16000;
const WINDOW = 30; // secondi: la finestra nativa di Whisper
const SUB_WINDOW = 15; // finestre più corte per rileggere un tratto saltato
const EDGE = 1.0; // parole che finiscono a meno di 1 s dal bordo della finestra potrebbero essere tagliate
const MAX_SKIP = 6; // se una finestra riparte più di 6 s dopo l'inizio, il tratto saltato viene riletto
const RETRY_WINDOWS = [12, 20, 8]; // se una finestra "allucina", si rilegge con tagli diversi
const MAX_WORD = 3; // una parola di più di 3 s a metà finestra non è una parola vera

/**
 * @param {Float32Array} audio  mono 16 kHz
 * @param {(slice: Float32Array, startSec: number) => Promise<{chunks: Array}>} transcribe  una finestra di Whisper
 * @param {(position: number, duration: number) => void} [onProgress]
 * @returns {Promise<Array<{text: string, timestamp: [number, number]}>>} parole con tempi assoluti
 */
export async function transcribeLongForm(audio, transcribe, onProgress) {
  const duration = audio.length / SAMPLE_RATE;
  const words = await transcribeRange(audio, transcribe, 0, duration, WINDOW, true, onProgress);
  onProgress?.(duration, duration);
  return words;
}

/**
 * Legge [from, to). Con `fixSkips` i tratti che Whisper salta (riparte molto più avanti, oppure
 * non restituisce nulla) vengono riletti con finestre più corte, invece di essere persi:
 * con la musica Whisper a volte "salta" a una frase più avanti nella finestra.
 */
async function transcribeRange(audio, transcribe, from, to, windowSec, fixSkips, onProgress) {
  const words = [];
  let pos = from;
  let retry = 0; // tentativi con finestre diverse nello stesso punto
  while (pos < to - 0.5) {
    onProgress?.(pos, audio.length / SAMPLE_RATE);
    const end = Math.min(to, pos + (retry ? RETRY_WINDOWS[retry - 1] : windowSec));
    const isLast = end >= to;
    const got = await readWindow(audio, transcribe, pos, end, isLast);

    if (got.badAt != null) {
      // Whisper si è "incantato" (allucinazione): si tengono le parole prima del guasto
      // e si rilegge da lì con una finestra di lunghezza diversa
      words.push(...got.words);
      const resume = got.lastEnd != null && got.lastEnd > pos ? got.lastEnd : pos;
      if (retry < RETRY_WINDOWS.length) { pos = resume; retry++; continue; }
      // dopo vari tentativi si va oltre il punto difettoso (per una parola lunghissima, es. un assolo
      // strumentale, si salta alla sua fine: la parola vera, se c'è, sta lì)
      pos = Math.max(resume, got.skipTo, pos + 1);
      retry = 0;
      continue;
    }
    retry = 0;

    if (fixSkips && end - pos > SUB_WINDOW) {
      const firstStart = got.words.length ? got.words[0].timestamp[0] : end;
      if (firstStart - pos > MAX_SKIP) {
        // tratto saltato (o finestra vuota): rilettura a pezzi più corti
        const missed = await transcribeRange(audio, transcribe, pos, firstStart, SUB_WINDOW, false);
        words.push(...missed.filter((w) => w.timestamp[0] < firstStart - 0.05));
        if (!got.words.length) { pos = Math.max(end - EDGE * 2, pos + 1); continue; }
      }
    }

    words.push(...got.words);
    if (isLast) break;
    // Riparte dall'ultima parola; se non c'è nulla (es. intro strumentale) o il passo è troppo piccolo, avanza
    pos = got.lastEnd != null && got.lastEnd > pos + 2 ? got.lastEnd : Math.max(pos + 1, end - EDGE * 2);
  }
  return words;
}

async function readWindow(audio, transcribe, pos, end, isLast) {
  const slice = audio.subarray(Math.floor(pos * SAMPLE_RATE), Math.floor(end * SAMPLE_RATE));
  const out = await transcribe(slice, pos);
  const chunks = (out?.chunks || []).filter((c) => c.timestamp?.[0] != null);
  // la prima parola della canzone è spesso "allungata" sull'intro strumentale: è normale (poi viene corretta)
  const bad = firstHallucination(chunks, pos < 1);
  const words = [];
  let lastEnd = null;
  for (const [k, c] of chunks.entries()) {
    if (k === bad) {
      const [bs, be] = c.timestamp;
      const long = be != null && be - bs > MAX_WORD;
      return { words, lastEnd, badAt: pos + bs, skipTo: long ? pos + be - 1 : pos + bs + 1 };
    }
    const [s, e] = c.timestamp;
    const wEnd = e ?? s + 0.5;
    if (pos + s >= end - 0.05) break; // parola "inventata" oltre la fine del tratto
    if (!isLast && wEnd > end - pos - EDGE) break; // parola forse tagliata: la rilegge la finestra dopo
    words.push({ text: c.text, timestamp: [pos + s, Math.min(end, pos + wEnd)] });
    lastEnd = pos + wEnd;
  }
  return { words, lastEnd, badAt: null, skipTo: null };
}

const normWord = (t) => (t || '').toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Indice della prima parola "allucinata" in una finestra, o -1. Segnali:
 * - una parola di più di MAX_WORD secondi (tranne, se `allowLongFirst`, la prima: dopo un intro è spesso lunga);
 * - la stessa sequenza di 1-3 parole ripetuta 4 o più volte di fila;
 * - 3 o più parole di fila con durata (quasi) zero.
 */
export function firstHallucination(chunks, allowLongFirst = true) {
  const keys = chunks.map((c) => normWord(c.text));
  for (let k = 0; k < chunks.length; k++) {
    const [s, e] = chunks[k].timestamp;
    if ((k > 0 || !allowLongFirst) && e != null && e - s > MAX_WORD) return k;
    if (k + 2 < chunks.length && [k, k + 1, k + 2].every((j) => {
      const [a, b] = chunks[j].timestamp;
      return b != null && b - a < 0.02;
    })) return k;
    for (let n = 1; n <= 3; n++) {
      let reps = 1;
      while (k + (reps + 1) * n <= keys.length && keys.slice(k + reps * n, k + (reps + 1) * n).join(' ') === keys.slice(k, k + n).join(' ')) reps++;
      if (reps >= 4) return k;
    }
  }
  return -1;
}
