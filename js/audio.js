// Decodifica qualsiasi file audio/video supportato dal browser in PCM mono a 16 kHz (formato richiesto da Whisper).

export const SAMPLE_RATE = 16000;

export async function decodeToMono16k(arrayBuffer) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
  } catch {
    throw new Error('Formato non supportato dal browser. Prova con mp3, wav, m4a o mp4.');
  } finally {
    ctx.close?.();
  }
  const length = Math.ceil(decoded.duration * SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, length, SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded; // il downmix a mono avviene automaticamente (1 canale in uscita)
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return { audio: rendered.getChannelData(0), duration: decoded.duration };
}
