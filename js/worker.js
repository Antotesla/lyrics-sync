// Web Worker: esegue Whisper nel browser con Transformers.js, così l'interfaccia resta reattiva.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

// I modelli sono ospitati insieme all'app (models/): così funziona anche se Hugging Face
// rifiuta il download (403). Hugging Face resta come riserva.
env.allowLocalModels = true;
env.localModelPath = new URL('../models/', import.meta.url).href;

// File del modello più grandi del limite di GitHub (100 MB): nel sito sono divisi in parti
// (nome.part1, nome.part2, …) e qui vengono riuniti in streaming, come se fossero un file unico.
const SPLIT_FILES = { 'Xenova/whisper-small/onnx/decoder_model_merged_quantized.onnx': 2 };
const originalFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const name = Object.keys(SPLIT_FILES).find((k) => url === env.localModelPath + k);
  if (!name) return originalFetch(input, init);
  const parts = await Promise.all(
    Array.from({ length: SPLIT_FILES[name] }, (_, i) => originalFetch(`${url}.part${i + 1}`)),
  );
  const bad = parts.find((r) => !r.ok);
  if (bad) return new Response(null, { status: bad.status, statusText: bad.statusText });
  const total = parts.reduce((sum, r) => sum + Number(r.headers.get('content-length') || 0), 0);
  const body = new ReadableStream({
    async start(controller) {
      for (const r of parts) {
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
        }
      }
      controller.close();
    },
  });
  const headers = { 'content-type': 'application/octet-stream' };
  if (total) headers['content-length'] = String(total);
  return new Response(body, { status: 200, headers });
};

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
    let message = String(err?.message || err);
    const blocked = /Forbidden access|403/.test(message);
    if (blocked) {
      message = 'Hugging Face ha rifiutato il download del modello (403). Scegli il modello "Veloce", che è incluso nell\'app.';
      asr = null; // il prossimo tentativo (anche con un altro modello) riparte da zero
      loadedModel = null;
    }
    self.postMessage({ type: 'error', message, code: blocked ? 'blocked' : undefined });
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
      if (pos + s >= duration - 0.05) break; // parola "inventata" oltre la fine dell'audio
      if (!isLast && wEnd > end - pos - EDGE) break; // parola forse tagliata: la rilegge la finestra dopo
      words.push({ text: c.text, timestamp: [pos + s, Math.min(duration, pos + wEnd)] });
      lastEnd = pos + wEnd;
    }
    if (isLast) break;
    // Riparte dall'ultima parola; se non c'è nulla (es. intro strumentale) o il passo è troppo piccolo, avanza
    pos = lastEnd != null && lastEnd > pos + 2 ? lastEnd : pos + WINDOW - EDGE * 2;
  }
  self.postMessage({ type: 'progress', position: duration, duration });
  return words;
}
