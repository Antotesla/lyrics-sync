// Trascrizione di un brano lungo con Whisper, a finestre di 30 s che riprendono dall'ultima parola.
// Modulo puro (Whisper viene passato come funzione) così è testabile con `node --test`.

export const SAMPLE_RATE = 16000;
const WINDOW = 30; // secondi: la finestra nativa di Whisper
const SUB_WINDOW = 15; // finestre più corte per rileggere un tratto saltato
const EDGE = 1.0; // parole che finiscono a meno di 1 s dal bordo della finestra potrebbero essere tagliate
const MAX_SKIP = 6; // se una finestra riparte più di 6 s dopo l'inizio, il tratto saltato viene riletto

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
  while (pos < to - 0.5) {
    onProgress?.(pos, audio.length / SAMPLE_RATE);
    const end = Math.min(to, pos + windowSec);
    const isLast = end >= to;
    const got = await readWindow(audio, transcribe, pos, end, isLast);

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
    pos = got.lastEnd != null && got.lastEnd > pos + 2 ? got.lastEnd : pos + windowSec - EDGE * 2;
  }
  return words;
}

async function readWindow(audio, transcribe, pos, end, isLast) {
  const slice = audio.subarray(Math.floor(pos * SAMPLE_RATE), Math.floor(end * SAMPLE_RATE));
  const out = await transcribe(slice, pos);
  const words = [];
  let lastEnd = null;
  for (const c of out?.chunks || []) {
    const [s, e] = c.timestamp || [];
    if (s == null) continue;
    const wEnd = e ?? s + 0.5;
    if (pos + s >= end - 0.05) break; // parola "inventata" oltre la fine del tratto
    if (!isLast && wEnd > end - pos - EDGE) break; // parola forse tagliata: la rilegge la finestra dopo
    words.push({ text: c.text, timestamp: [pos + s, Math.min(end, pos + wEnd)] });
    lastEnd = pos + wEnd;
  }
  return { words, lastEnd };
}
