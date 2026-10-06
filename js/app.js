import { decodeToMono16k } from './audio.js?v=20261006l';
import { readId3Lyrics } from './id3.js?v=20261006l';
import { normalizeWords, groupWords, parseLyrics, alignLyrics, distributeWords, shiftWords } from './lines.js?v=20261006l';
import { formatShort, formatPrecise, parseTime, toTxt, toLrc, toSrt, toAss } from './formats.js?v=20261006l';
import { createKaraoke, DEFAULT_OPTIONS } from './karaoke.js?v=20261006l';

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), dropTitle: $('drop-title'), model: $('model'), language: $('language'),
  lyrics: $('lyrics'), lyricsBox: $('lyrics-box'), lyricsBadge: $('lyrics-badge'),
  go: $('go'), status: $('status'), progress: $('progress'),
  result: $('result'), player: $('player'), lines: $('lines'), tpl: $('line-tpl'),
};

const state = { file: null, media: null, lines: [], baseName: 'testo' };
let worker = null;

// iPhone/iPad (anche iPad che si presenta come Mac): la trascrizione supera la memoria concessa a Safari
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
$('ios-warning').hidden = !isIOS;

// ---------- Scelta del file ----------

els.file.addEventListener('change', () => els.file.files[0] && selectFile(els.file.files[0]));
['dragenter', 'dragover'].forEach((ev) => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => els.drop.addEventListener(ev, (e) => { e.preventDefault(); els.drop.classList.remove('over'); }));
els.drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && selectFile(e.dataTransfer.files[0]));

async function selectFile(file) {
  state.file = file;
  // toglie anche estensioni doppie (es. "canzone.mp3.mpeg" → "canzone")
  state.baseName = file.name.replace(/(\.(mp3|mpeg|mpga|wav|m4a|aac|ogg|oga|flac|mp4|m4v|mov|webm|mkv|avi|3gp))+$/i, '') || 'testo';
  els.dropTitle.textContent = file.name;
  els.go.disabled = false;
  setStatus('');
  // Se il file ha il testo nei metadati (es. mp3 di Suno) lo proponiamo subito
  const lyrics = readId3Lyrics(await file.slice(0, 2 * 1024 * 1024).arrayBuffer());
  els.lyricsBadge.hidden = !lyrics;
  if (lyrics && !els.lyrics.value.trim()) {
    els.lyrics.value = lyrics;
    els.lyricsBox.open = true;
  }
}

// Testo preso da un altro file (es. l'mp3 di Suno) mentre si trascrive un video
$('lyrics-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const msg = $('lyrics-file-msg');
  const lyrics = readId3Lyrics(await f.slice(0, 2 * 1024 * 1024).arrayBuffer());
  if (lyrics) {
    els.lyrics.value = lyrics;
    msg.textContent = `Testo preso da "${f.name}" (${parseLyrics(lyrics).length} righe). Ora premi Trascrivi.`;
    msg.classList.remove('error');
  } else {
    msg.textContent = `"${f.name}" non contiene il testo nei metadati: incollalo a mano qui sotto.`;
    msg.classList.add('error');
  }
});

// ---------- Trascrizione ----------

els.go.addEventListener('click', transcribe);

const FALLBACK_MODEL = 'Xenova/whisper-base'; // incluso nel sito (models/)
const APP_VERSION = '20261006l';

async function transcribe() {
  if (!state.file) return;
  let fallbackNote = '';
  els.go.disabled = true;
  try {
    setStatus('Leggo il file…');
    showProgress(null);
    const { audio } = await decodeToMono16k(await state.file.arrayBuffer());
    const lyricLines = parseLyrics(els.lyrics.value);
    const model = pickModel();
    let chunks;
    try {
      chunks = await runWhisper(audio.slice(), model);
    } catch (err) {
      // In automatico, se Hugging Face blocca il modello preciso, si usa quello veloce incluso nel sito
      if (els.model.value !== 'auto' || model === FALLBACK_MODEL) throw err;
      fallbackNote = ' Il modello preciso non si è potuto usare: ho usato quello veloce.';
      chunks = await runWhisper(audio, FALLBACK_MODEL);
    }
    const words = normalizeWords(chunks);
    if (!words.length) throw new Error('Non ho riconosciuto parole cantate in questo file.');
    state.lines = lyricLines.length ? alignLyrics(lyricLines, words) : groupWords(words);
    // dati per l'assistenza: permettono di riprodurre esattamente l'allineamento fatto su questo PC
    state.debug = {
      app: 'lyrics-sync', version: APP_VERSION, createdAt: new Date().toISOString(),
      file: { name: state.file.name, type: state.file.type, size: state.file.size },
      model: fallbackNote ? FALLBACK_MODEL : model, language: els.language.value,
      userAgent: navigator.userAgent, lyrics: els.lyrics.value, chunks,
    };
    showResult();
    const unsure = state.lines.filter((l) => l.uncertain).length;
    setStatus(`Fatto: ${state.lines.length} righe` + (unsure ? `, ${unsure} da controllare.` : '.') + fallbackNote);
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    els.progress.hidden = true;
    els.go.disabled = false;
  }
}

// Automatico = small: anche con il testo noto dà tempi delle parole più affidabili del base
// (misurato: meno parole stimate, nessuna parola oltre la fine). Se non si carica, si ripiega sul base.
function pickModel() {
  return els.model.value === 'auto' ? 'Xenova/whisper-small' : els.model.value;
}

function runWhisper(audio, model) {
  worker ??= new Worker(new URL('./worker.js?v=20261006l', import.meta.url), { type: 'module' });
  const files = {};
  const started = performance.now();
  return new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'download') {
        files[data.file] = data;
        const loaded = Object.values(files).reduce((s, f) => s + (f.loaded || 0), 0);
        const total = Object.values(files).reduce((s, f) => s + (f.total || 0), 0);
        setStatus(`Scarico il modello (solo la prima volta): ${mb(loaded)} / ${mb(total)} MB`);
        showProgress(total ? loaded / total : null);
      } else if (data.type === 'progress') {
        const s = Math.round((performance.now() - started) / 1000);
        setStatus(`Ascolto la canzone: ${formatShort(data.position)} / ${formatShort(data.duration)} (${s} s trascorsi)`);
        showProgress(data.position / data.duration);
      } else if (data.type === 'result') {
        resolve(data.chunks);
      } else if (data.type === 'error') {
        reject(Object.assign(new Error('Errore durante la trascrizione: ' + data.message), { code: data.code }));
      }
    };
    worker.onerror = (e) => { reject(new Error(e.message || 'Errore nel worker')); };
    worker.postMessage({ type: 'transcribe', audio, model, language: els.language.value }, [audio.buffer]);
  });
}

const mb = (b) => (b / 1048576).toFixed(0);

function setStatus(msg, isError = false) {
  els.status.textContent = msg;
  els.status.classList.toggle('error', isError);
}
function showProgress(fraction) {
  els.progress.hidden = false;
  if (fraction == null) els.progress.removeAttribute('value');
  else els.progress.value = fraction;
}

// ---------- Risultato ed editor ----------

function showResult() {
  const url = URL.createObjectURL(state.file);
  els.player.innerHTML = '';
  setMedia(state.file.type.startsWith('video/') ? 'video' : 'audio', url);
  // Alcuni audio arrivano come "video/…" (es. file .mpeg): se non c'è immagine usiamo il player audio
  if (state.media.tagName === 'VIDEO') {
    state.media.addEventListener('loadedmetadata', () => {
      if (!state.media.videoWidth) setMedia('audio', url);
      sizeCanvas();
    }, { once: true });
  }
  sizeCanvas();
  els.result.hidden = false;
  renderLines();
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** Il karaoke ha lo stesso formato del video (lato lungo max 1920 px); per l'audio 1280x720. */
function sizeCanvas() {
  const canvas = $('k-canvas');
  const m = state.media;
  let w = 1280, h = 720;
  if (m?.tagName === 'VIDEO' && m.videoWidth) {
    const k = Math.min(1, 1920 / Math.max(m.videoWidth, m.videoHeight));
    w = Math.round((m.videoWidth * k) / 2) * 2;
    h = Math.round((m.videoHeight * k) / 2) * 2;
  }
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  drawKaraoke();
}

function setMedia(kind, url) {
  const media = document.createElement(kind);
  media.controls = true;
  media.playsInline = true;
  media.src = url;
  media.addEventListener('timeupdate', () => { highlightCurrent(); updateControls(); });
  media.addEventListener('play', () => { updateControls(); karaokeLoop(); });
  media.addEventListener('pause', updateControls);
  media.addEventListener('seeked', drawKaraoke);
  media.addEventListener('loadeddata', drawKaraoke);
  media.addEventListener('loadedmetadata', updateControls);
  els.player.replaceChildren(media);
  state.media = media;
}

function renderLines() {
  els.lines.innerHTML = '';
  state.lines.forEach((line, i) => {
    const li = els.tpl.content.firstElementChild.cloneNode(true);
    li.dataset.i = i;
    li.classList.toggle('uncertain', !!line.uncertain);
    li.querySelector('.time-edit').value = formatPrecise(line.start);
    li.querySelector('.text').value = line.text;
    els.lines.append(li);
  });
  highlightCurrent();
  drawKaraoke();
}

els.lines.addEventListener('click', (e) => {
  const li = e.target.closest('.line');
  if (!li) return;
  const i = Number(li.dataset.i);
  const line = state.lines[i];
  if (e.target.matches('.play')) {
    seek(line.start);
  } else if (e.target.matches('.stamp')) {
    shiftWords(line, state.media.currentTime);
    line.uncertain = false;
    resort();
  } else if (e.target.matches('.merge') && i > 0) {
    const prev = state.lines[i - 1];
    prev.text = `${prev.text} ${line.text}`.trim();
    prev.end = line.end;
    prev.words = [...(prev.words || []), ...(line.words || [])];
    state.lines.splice(i, 1);
    renderLines();
  } else if (e.target.matches('.del')) {
    state.lines.splice(i, 1);
    renderLines();
  }
});

els.lines.addEventListener('focusout', (e) => {
  const li = e.target.closest('.line');
  if (!li) return;
  const line = state.lines[li.dataset.i];
  if (e.target.matches('.time-edit')) {
    const t = parseTime(e.target.value);
    if (t == null) { e.target.value = formatPrecise(line.start); return; }
    if (Math.abs(t - line.start) < 0.05) return;
    shiftWords(line, t);
    line.uncertain = false;
    resort();
  } else if (e.target.matches('.text')) {
    if (e.target.value === line.text) return;
    const texts = e.target.value.split(/\s+/).filter(Boolean);
    line.text = e.target.value;
    if (line.words && texts.length === line.words.length) {
      texts.forEach((t, k) => { line.words[k].text = t; }); // stesse parole corrette: tempi invariati
    } else {
      line.words = distributeWords(line.text, line.start, line.end ?? line.start + 2);
    }
    drawKaraoke();
  }
});
els.lines.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input')) e.target.blur();
});

$('add-line').addEventListener('click', () => {
  const t = state.media ? state.media.currentTime : 0;
  state.lines.push({ start: t, end: t + 3, text: '', words: [], uncertain: false });
  resort();
  const idx = state.lines.findIndex((l) => l.start === t && l.text === '');
  els.lines.children[idx]?.querySelector('.text').focus();
});

function resort() {
  state.lines.sort((a, b) => a.start - b.start);
  renderLines();
}

function seek(t) {
  if (!state.media || recording) return;
  state.media.currentTime = Math.max(0, t - 0.2);
  state.media.play();
}

function highlightCurrent() {
  if (!state.media) return;
  const t = state.media.currentTime;
  let cur = -1;
  state.lines.forEach((l, i) => { if (l.start <= t) cur = i; });
  [...els.lines.children].forEach((li, i) => li.classList.toggle('active', i === cur));
}

// ---------- Anteprima karaoke ----------

const karaoke = createKaraoke($('k-canvas').getContext('2d'));

// Impostazioni dell'aspetto (ricordate dal browser)
const LOOK_KEY = 'lyrics-sync-look';
const lookFields = { bg: 'k-bg', position: 'k-pos', readability: 'k-read', bandOpacity: 'k-band', nextLines: 'k-next', textSize: 'k-size', sungColor: 'k-sung', ballColor: 'k-ball' };
try {
  const saved = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}');
  for (const [k, id] of Object.entries(lookFields)) if (saved[k] != null) $(id).value = String(saved[k]);
} catch { /* nessuna impostazione salvata */ }
for (const id of Object.values(lookFields)) {
  $(id).addEventListener('change', () => {
    try { localStorage.setItem(LOOK_KEY, JSON.stringify(lookValues())); } catch { /* storage non disponibile */ }
    drawKaraoke();
  });
}

function lookValues() {
  const v = {};
  for (const [k, id] of Object.entries(lookFields)) v[k] = $(id).value;
  return v;
}

/** Opzioni per il disegno: sul video caricato se c'è e se l'utente non ha scelto il cielo. */
function karaokeOptions() {
  const v = lookValues();
  const hasVideo = state.media?.tagName === 'VIDEO' && state.media.videoWidth > 0;
  return {
    ...DEFAULT_OPTIONS,
    background: v.bg === 'auto' && hasVideo ? 'video' : 'sky',
    video: hasVideo ? state.media : null,
    position: v.position,
    readability: v.readability,
    bandOpacity: Number(v.bandOpacity),
    nextLines: Number(v.nextLines),
    textSize: v.textSize,
    sungColor: v.sungColor,
    ballColor: v.ballColor,
  };
}

function karaokeLoop() {
  drawKaraoke();
  if (state.media && !state.media.paused) requestAnimationFrame(karaokeLoop);
}

function drawKaraoke() {
  if (recording) recording.noteDraw();
  karaoke.draw(state.lines.filter((l) => l.text.trim()), state.media ? state.media.currentTime : 0, karaokeOptions());
}

// Il font arrotondato arriva da Google Fonts: ridisegna quando è pronto (le misure delle parole cambiano)
document.fonts?.load('700 60px "Baloo 2"').then(() => state.lines.length && drawKaraoke(), () => {});

$('k-full').addEventListener('click', () => {
  const box = $('karaoke');
  if (document.fullscreenElement) document.exitFullscreen();
  else box.requestFullscreen?.().catch(() => {});
});

// Controlli di riproduzione (l'elemento audio/video vero è nascosto)
$('k-play').addEventListener('click', () => {
  if (!state.media) return;
  if (state.media.paused) state.media.play(); else state.media.pause();
});
$('k-seek').addEventListener('input', (e) => {
  if (!state.media) return;
  state.media.currentTime = Number(e.target.value);
  drawKaraoke();
});
$('k-canvas').addEventListener('click', () => $('k-play').click());

function updateControls() {
  const m = state.media;
  if (!m) return;
  const d = Number.isFinite(m.duration) ? m.duration : 0;
  $('k-play').textContent = m.paused ? '▶' : '❚❚';
  $('k-play').setAttribute('aria-label', m.paused ? 'Riproduci' : 'Pausa');
  $('k-seek').max = String(d || 1);
  if (document.activeElement !== $('k-seek')) $('k-seek').value = String(m.currentTime);
  $('k-time').textContent = `${formatShort(m.currentTime)} / ${formatShort(d)}`;
}

// ---------- Export video ----------

let audioGraph = null; // { ctx, source, media }: un elemento media può essere collegato una sola volta
let recording = null;

/** Formato di registrazione: quello del file caricato se possibile, altrimenti MP4, altrimenti WebM. */
function pickRecorderFormat() {
  const mp4 = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
  const webm = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  const ok = (list) => list.find((t) => window.MediaRecorder?.isTypeSupported?.(t));
  const wantsWebm = /webm/i.test(state.file?.type || '') || /\.webm$/i.test(state.file?.name || '');
  const h264 = ok(mp4.slice(0, 3)); // MP4 con H.264/AAC: si apre ovunque (WhatsApp, iPhone, Windows)
  const mime = (wantsWebm && ok(webm)) || h264 || ok(mp4) || ok(webm);
  if (!mime) return null;
  const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
  // MP4 senza H.264 esplicito: il browser potrebbe usare VP9/Opus, che alcuni lettori non aprono
  const warning = ext === 'mp4' && !h264 ? ' Attenzione: questo browser crea MP4 con codec poco diffusi, alcuni lettori potrebbero non aprirlo.' : '';
  return { mime, ext, warning };
}

function audioStreamOf(media) {
  if (!audioGraph || audioGraph.media !== media) {
    const ctx = audioGraph?.ctx || new (window.AudioContext || window.webkitAudioContext)();
    const source = ctx.createMediaElementSource(media);
    source.connect(ctx.destination); // continui a sentire la canzone
    audioGraph = { ctx, source, media };
  }
  const dest = audioGraph.ctx.createMediaStreamDestination();
  audioGraph.source.connect(dest);
  return { stream: dest.stream, disconnect: () => audioGraph.source.disconnect(dest) };
}

$('export').addEventListener('click', async () => {
  const m = state.media;
  if (!m || recording) return;
  const fmt = pickRecorderFormat();
  if (!fmt) { setExport('Questo browser non sa registrare video. Usa Chrome o Edge aggiornati.', true); return; }
  const canvas = $('k-canvas');
  await audioGraph?.ctx.resume?.();
  const audio = audioStreamOf(m);
  await audioGraph.ctx.resume();
  const stream = new MediaStream([...canvas.captureStream(30).getVideoTracks(), ...audio.stream.getAudioTracks()]);
  const rec = new MediaRecorder(stream, {
    mimeType: fmt.mime,
    // "leggera": file ~2,5 volte più piccolo (comodo da inviare), qualità ancora buona per testo e cartoni
    videoBitsPerSecond: Math.round(canvas.width * canvas.height * ($('export-quality').value === 'light' ? 1.4 : 3.5)),
    audioBitsPerSecond: 192000,
  });
  const parts = [];
  // Controllo della regolarità: se tra due disegni passa troppo tempo mentre si registra,
  // nel video ci sarebbe un'immagine ferma (succede se Chrome rallenta la pagina).
  const glitches = { count: 0, worst: 0 };
  let lastDraw = 0;
  recording = {
    rec,
    cancelled: false,
    noteDraw() {
      const now = performance.now();
      if (rec.state === 'recording' && lastDraw && now - lastDraw > 250) {
        glitches.count++;
        glitches.worst = Math.max(glitches.worst, now - lastDraw);
      }
      lastDraw = now;
    },
  };
  rec.ondataavailable = (e) => e.data.size && parts.push(e.data);
  const finished = new Promise((resolve) => { rec.onstop = resolve; });
  const onEnded = () => rec.state !== 'inactive' && rec.stop();
  // pausa durante l'export = pausa della registrazione (altrimenti nel video resta l'immagine ferma)
  const onPause = () => { if (rec.state === 'recording' && !m.ended) rec.pause(); };
  const onPlay = () => { lastDraw = 0; drawKaraoke(); if (rec.state === 'paused') rec.resume(); };
  // Scheda nascosta (o finestra coperta del tutto): Chrome smette di disegnare ma l'audio continuerebbe.
  // Meglio mettere in pausa e riprendere quando si torna.
  let pausedByHide = false;
  const onVisibility = () => {
    if (document.hidden && !m.paused) { pausedByHide = true; m.pause(); }
    else if (!document.hidden && pausedByHide) { pausedByHide = false; m.play().catch(() => {}); }
  };
  document.addEventListener('visibilitychange', onVisibility);
  // Il disegno durante l'export non dipende solo dall'aggiornamento dello schermo (requestAnimationFrame)
  const driver = setInterval(() => { if (!m.paused) drawKaraoke(); }, 1000 / 30);
  m.addEventListener('ended', onEnded);
  m.addEventListener('pause', onPause);
  m.addEventListener('play', onPlay);
  $('k-seek').disabled = true; // spostarsi avanti/indietro rovinerebbe il video registrato

  $('export').disabled = true;
  $('export-box').hidden = false;
  setExport(`Preparo la registrazione (${fmt.ext.toUpperCase()})…`);
  m.pause();
  m.currentTime = 0;
  await new Promise((r) => m.addEventListener('seeked', r, { once: true }));
  drawKaraoke();
  rec.start(1000);
  rec.pause(); // riparte con il play, così l'inizio del video coincide con l'inizio della canzone
  const tick = setInterval(() => {
    const d = m.duration || 1;
    const paused = m.paused && !m.ended
      ? (pausedByHide ? ' — in pausa perché la scheda è nascosta: riprende quando torni qui' : ' — in pausa: premi ▶ per continuare')
      : '';
    setExport(`Registrazione in corso: ${formatShort(m.currentTime)} / ${formatShort(d)} (${fmt.ext.toUpperCase()})${paused}`);
    $('export-progress').value = m.currentTime / d;
  }, 250);
  try { await m.play(); onPlay(); } catch { onEnded(); }
  await finished;
  clearInterval(tick);
  m.removeEventListener('ended', onEnded);
  m.removeEventListener('pause', onPause);
  m.removeEventListener('play', onPlay);
  document.removeEventListener('visibilitychange', onVisibility);
  clearInterval(driver);
  $('k-seek').disabled = false;
  audio.disconnect();
  stream.getTracks().forEach((t) => t.stop());
  $('export').disabled = false;
  const cancelled = recording.cancelled;
  recording = null;
  if (cancelled) { setExport('Esportazione annullata.'); return; }
  let blob = new Blob(parts, { type: fmt.mime.split(';')[0] });
  if (fmt.ext === 'webm' && window.ysFixWebmDuration) {
    // i WebM registrati dal browser non hanno la durata: senza, molti lettori non permettono di avanzare
    try { blob = await window.ysFixWebmDuration(blob, (m.duration || 0) * 1000, { logger: false }); } catch { /* resta senza durata */ }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.baseName}-karaoke.${fmt.ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  $('export-progress').value = 1;
  const glitchNote = glitches.count
    ? ` Attenzione: in ${glitches.count} punti il disegno si è fermato (fino a ${(glitches.worst / 1000).toFixed(1)} s), nel video ci possono essere scatti. Rifai l'export tenendo la finestra in primo piano e senza altre finestre davanti.`
    : '';
  setExport(`Fatto: ${a.download} (${(blob.size / 1048576).toFixed(1)} MB).${fmt.warning}${glitchNote}`, glitches.count > 0);
});

$('export-cancel').addEventListener('click', () => {
  if (!recording) { $('export-box').hidden = true; return; }
  recording.cancelled = true;
  state.media.pause();
  if (recording.rec.state !== 'inactive') recording.rec.stop();
});

function setExport(msg, isError = false) {
  $('export-box').hidden = false;
  $('export-status').textContent = msg;
  $('export-status').classList.toggle('error', isError);
}

// ---------- Export ----------

const cleanLines = () => state.lines.filter((l) => l.text.trim());

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(toTxt(cleanLines()));
    setStatus('Testo copiato negli appunti.');
  } catch {
    setStatus('Copia non riuscita: usa il pulsante TXT.', true);
  }
});
$('dl-txt').addEventListener('click', () => download(toTxt(cleanLines()), 'txt'));
$('dl-lrc').addEventListener('click', () => download(toLrc(cleanLines(), state.baseName), 'lrc'));
$('dl-srt').addEventListener('click', () => download(toSrt(cleanLines()), 'srt'));
$('dl-debug').addEventListener('click', () => {
  if (!state.debug) return;
  download(JSON.stringify(state.debug), 'dati-tecnici.json');
});
$('dl-ass').addEventListener('click', () => download(toAss(cleanLines(), state.baseName, karaokeOptions()), 'ass'));

function download(text, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `${state.baseName}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
