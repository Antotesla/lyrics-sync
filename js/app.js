import { decodeToMono16k } from './audio.js';
import { readId3Lyrics } from './id3.js';
import { normalizeWords, groupWords, parseLyrics, alignLyrics } from './lines.js';
import { formatShort, formatPrecise, parseTime, toTxt, toLrc, toSrt } from './formats.js';

const $ = (id) => document.getElementById(id);
const els = {
  drop: $('drop'), file: $('file'), dropTitle: $('drop-title'), model: $('model'), language: $('language'),
  lyrics: $('lyrics'), lyricsBox: $('lyrics-box'), lyricsBadge: $('lyrics-badge'),
  go: $('go'), status: $('status'), progress: $('progress'),
  result: $('result'), player: $('player'), lines: $('lines'), tpl: $('line-tpl'),
};

const state = { file: null, media: null, lines: [], baseName: 'testo' };
let worker = null;

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

async function transcribe() {
  if (!state.file) return;
  els.go.disabled = true;
  try {
    setStatus('Leggo il file…');
    showProgress(null);
    const { audio } = await decodeToMono16k(await state.file.arrayBuffer());
    const chunks = await runWhisper(audio);
    const words = normalizeWords(chunks);
    if (!words.length) throw new Error('Non ho riconosciuto parole cantate in questo file.');
    const lyricLines = parseLyrics(els.lyrics.value);
    state.lines = lyricLines.length ? alignLyrics(lyricLines, words) : groupWords(words);
    showResult();
    const unsure = state.lines.filter((l) => l.uncertain).length;
    setStatus(`Fatto: ${state.lines.length} righe` + (unsure ? `, ${unsure} da controllare.` : '.'));
  } catch (err) {
    setStatus(err.message || String(err), true);
  } finally {
    els.progress.hidden = true;
    els.go.disabled = false;
  }
}

function runWhisper(audio) {
  worker ??= new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
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
        reject(new Error('Errore durante la trascrizione: ' + data.message));
      }
    };
    worker.onerror = (e) => { reject(new Error(e.message || 'Errore nel worker')); };
    worker.postMessage({ type: 'transcribe', audio, model: els.model.value, language: els.language.value }, [audio.buffer]);
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
  const isVideo = state.file.type.startsWith('video/');
  els.player.innerHTML = '';
  state.media = document.createElement(isVideo ? 'video' : 'audio');
  state.media.controls = true;
  state.media.playsInline = true;
  state.media.src = url;
  state.media.addEventListener('timeupdate', highlightCurrent);
  els.player.append(state.media);
  els.result.hidden = false;
  renderLines();
  els.result.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
}

els.lines.addEventListener('click', (e) => {
  const li = e.target.closest('.line');
  if (!li) return;
  const i = Number(li.dataset.i);
  const line = state.lines[i];
  if (e.target.matches('.play')) {
    seek(line.start);
  } else if (e.target.matches('.stamp')) {
    line.start = state.media.currentTime;
    line.uncertain = false;
    resort();
  } else if (e.target.matches('.merge') && i > 0) {
    const prev = state.lines[i - 1];
    prev.text = `${prev.text} ${line.text}`.trim();
    prev.end = line.end;
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
    line.start = t;
    line.uncertain = false;
    resort();
  } else if (e.target.matches('.text')) {
    line.text = e.target.value;
  }
});
els.lines.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input')) e.target.blur();
});

$('add-line').addEventListener('click', () => {
  const t = state.media ? state.media.currentTime : 0;
  state.lines.push({ start: t, end: t + 3, text: '', uncertain: false });
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

function download(text, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = `${state.baseName}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
