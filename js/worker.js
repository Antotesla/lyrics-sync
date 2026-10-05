// Web Worker: esegue Whisper nel browser con Transformers.js, così l'interfaccia resta reattiva.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

env.allowLocalModels = false;

const SAMPLE_RATE = 16000;
const WINDOW = 30; // secondi: la finestra nativa di Whisper
const EDGE = 1.0; // parole che finiscono a meno di 1 s dal bordo della finestra potrebbero essere tagliate

let asr = null;
let loadedModel = null;

self.onmessage = async ({ data }) => {
  if (data.type !== 'transcribe') return;
  try {
    if (!asr || loadedModel !== data.model) {
      asr = await pipeline('automatic-speech-recognition', data.model, {
        dtype: 'q8',
        device: 'wasm',
        progress_callback: (p) => {
          if (p.status === 'progress') {
            self.postMessage({ type: 'download', file: p.file, loaded: p.loaded, total: p.total });
          }
        },
      });
      loadedModel = data.model;
    }
    const words = await transcribeLongForm(data.audio, data.language || null);
    self.postMessage({ type: 'result', chunks: words });
  } catch (err) {
    self.postMessage({ type: 'error', message: String(err?.message || err) });
  }
};

/**
 * Trascrizione "a scorrimento" come nell'implementazione originale di Whisper:
 * ogni finestra di 30 s riparte dalla fine dell'ultima parola sicura.
 * Con la musica Whisper spesso si ferma prima della fine della finestra;
 * a finestre fisse il resto andrebbe perso, così invece viene riletto.
 */
async function transcribeLongForm(audio, language) {
  const duration = audio.length / SAMPLE_RATE;
  const words = [];
  let pos = 0;
  while (pos < duration - 0.5) {
    self.postMessage({ type: 'progress', position: pos, duration });
    const end = Math.min(duration, pos + WINDOW);
    const slice = audio.subarray(Math.floor(pos * SAMPLE_RATE), Math.floor(end * SAMPLE_RATE));
    const out = await asr(slice, { language, task: 'transcribe', return_timestamps: 'word' });
    const isLast = end >= duration;
    let lastEnd = null;
    for (const c of out.chunks || []) {
      const [s, e] = c.timestamp || [];
      if (s == null) continue;
      const wEnd = e ?? s + 0.5;
      if (!isLast && wEnd > end - pos - EDGE) break; // parola forse tagliata: la rilegge la finestra dopo
      words.push({ text: c.text, timestamp: [pos + s, pos + wEnd] });
      lastEnd = pos + wEnd;
    }
    if (isLast) break;
    // Riparte dall'ultima parola; se non c'è nulla (es. intro strumentale) o il passo è troppo piccolo, avanza
    pos = lastEnd != null && lastEnd > pos + 2 ? lastEnd : pos + WINDOW - EDGE * 2;
  }
  self.postMessage({ type: 'progress', position: duration, duration });
  return words;
}
