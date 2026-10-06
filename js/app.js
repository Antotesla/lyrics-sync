import { decodeToMono16k } from './audio.js?v=20261006e';
import { readId3Lyrics } from './id3.js?v=20261006e';
import { normalizeWords, groupWords, parseLyrics, alignLyrics, distributeWords, shiftWords } from './lines.js?v=20261006e';
import { formatShort, formatPrecise, parseTime, toTxt, toLrc, toSrt, toAss } from './formats.js?v=20261006e';
import { createKaraoke, DEFAULT_OPTIONS } from './karaoke.js?v=20261006e';

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
  state.baseName = file.name.replace(/\.[^.]+$/, '') || 'testo';
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

// ---------- Trascrizione ----------

els.go.addEventListener('click', transcribe);

const FALLBACK_MODEL = 'Xenova/whisper-base'; // incluso nel sito (models/)

async function transcribe() {
  if (!state.file) return;
  let fallbackNote = '';
  els.go.disabled = true;
  try {
    setStatus('Leggo il file…');
    showProgress(null);
    const { audio } = await decodeToMono16k(await state.file.arrayBuffer());
    const lyricLines = parseLyrics(els.lyrics.value);
    const model = pickModel(lyricLines.length > 0);
    let chunks;
    try {
      chunks = await runWhisper(audio.slice(), model);
    } catch (err) {
      // In automatico, se Hugging Face blocca il modello preciso, si usa quello veloce incluso nel sito
      if (err.code !== 'blocked' || els.model.value !== 'auto' || model === FALLBACK_MODEL) throw err;
      fallbackNote = ' Il modello preciso non si è potuto scaricare (Hugging Face lo blocca): ho usato quello veloce.';
      chunks = await runWhisper(audio, FALLBACK_MODEL);
    }
    const words = normalizeWords(chunks);
    if (!words.length) throw new Error('Non ho riconosciuto parole cantate in questo file.');
    state.lines = lyricLines.length ? alignLyrics(lyricLines, words) : groupWords(words);
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

// Con il testo noto servono solo i tempi: il modello base è preciso quanto small e ~3 volte più veloce
function pickModel(hasLyrics) {
  if (els.model.value !== 'auto') return els.model.value;
  return hasLyrics ? FALLBACK_MODEL : 'Xenova/whisper-small';
}

function runWhisper(audio, model) {
  worker ??= new Worker(new URL('./worker.js?v=20261006e', import.meta.url), { type: 'module' });
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
    }, { once: true });
  }
  els.result.hidden = false;
  renderLines();
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  if (!state.media) return;
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
$('dl-ass').addEventListener('click', () => download(toAss(cleanLines(), state.baseName, karaokeOptions()), 'ass'));

function download(text, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `${state.baseName}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
