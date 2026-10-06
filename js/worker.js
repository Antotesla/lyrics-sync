// Web Worker: esegue Whisper nel browser con Transformers.js, così l'interfaccia resta reattiva.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
import { transcribeLongForm } from './longform.js?v=20261006n';

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
    const language = data.language || null;
    const words = await transcribeLongForm(
      data.audio,
      (slice) => asr(slice, { language, task: 'transcribe', return_timestamps: 'word' }),
      (position, duration) => self.postMessage({ type: 'progress', position, duration }),
    );
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
