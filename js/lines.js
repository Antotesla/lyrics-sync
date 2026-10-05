// Trasforma le parole con timestamp prodotte da Whisper in righe con tempo di inizio.
// Modulo puro (nessuna dipendenza dal DOM) così è testabile con `node --test`.

const MAX_WORD_DURATION = 1.0; // oltre questa durata l'inizio della parola è quasi sempre gonfiato
const WORD_FALLBACK_DURATION = 0.8;

/** Converte i chunk di transformers.js ({text, timestamp:[s,e]}) in parole pulite. */
export function normalizeWords(chunks) {
  const words = [];
  for (const c of chunks || []) {
    const text = (c.text || '').trim();
    if (!text) continue;
    let [start, end] = c.timestamp || [];
    if (start == null) continue;
    if (end == null || end < start) end = start + WORD_FALLBACK_DURATION;
    // Whisper tende ad "agganciare" la prima parola dopo un intro strumentale
    // all'inizio della finestra (es. 0.0 → 4.1 s). Teniamo la fine, che è affidabile.
    if (end - start > MAX_WORD_DURATION) start = end - WORD_FALLBACK_DURATION;
    words.push({ text, start, end });
  }
  return words;
}

const isCapitalized = (w) => /^[\p{Lu}]/u.test(w);

/**
 * Raggruppa le parole in righe usando pause, punteggiatura e maiuscole
 * (Whisper mette la maiuscola a inizio verso).
 */
export function groupWords(words, opts = {}) {
  const { pause = 0.6, maxWords = 10, maxDuration = 6 } = opts;
  const lines = [];
  let cur = null;
  for (const w of words) {
    if (cur) {
      const prev = cur.words[cur.words.length - 1];
      const gap = w.start - prev.end;
      const breakHere =
        gap >= pause ||
        /[.!?;:]["»”)]?$/.test(prev.text) ||
        (isCapitalized(w.text) && cur.words.length >= 2) ||
        cur.words.length >= maxWords ||
        w.end - cur.start > maxDuration;
      if (breakHere) { lines.push(finish(cur)); cur = null; }
    }
    if (!cur) cur = { start: w.start, words: [] };
    cur.words.push(w);
  }
  if (cur) lines.push(finish(cur));
  return mergeFragments(lines, pause);
}

/** Una parola isolata (es. "Splash,") viene unita alla riga successiva se segue subito. */
function mergeFragments(lines, pause) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const next = lines[i + 1];
    if (next && !/\s/.test(l.text) && next.start - l.end < pause * 2) {
      next.text = `${l.text} ${next.text}`;
      next.start = l.start;
      continue;
    }
    out.push(l);
  }
  return out;
}

function finish(line) {
  const text = line.words.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1');
  return { start: line.start, end: line.words[line.words.length - 1].end, text, uncertain: false };
}

/**
 * Estrae le righe cantate da un testo: toglie tag tipo [Chorus] e righe vuote.
 * Accetta anche testi già con i tempi "(0:37) …": i tempi vengono tolti e
 * una riga con più tempi viene divisa in più righe.
 */
export function parseLyrics(raw) {
  return (raw || '')
    .split(/\r?\n|\s*\(\d+:\d{2}(?:\.\d+)?\)\s*/)
    .map((l) => l.trim())
    .filter((l) => l && !/^\[.*\]$/.test(l));
}

const norm = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}']/gu, '');

function similarity(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/**
 * Allinea un testo noto (righe) alle parole riconosciute da Whisper:
 * il testo resta quello fornito, i tempi arrivano dal riconoscimento.
 * Usa un allineamento Needleman-Wunsch a livello di parola.
 */
export function alignLyrics(lyricLines, words) {
  const ref = [];
  lyricLines.forEach((line, li) => {
    for (const t of line.split(/\s+/)) {
      const n = norm(t);
      if (n) ref.push({ n, li });
    }
  });
  const hyp = words.map((w) => norm(w.text));
  const R = ref.length, H = hyp.length;
  const GAP = -0.6;
  const W = H + 1;
  const score = new Float32Array((R + 1) * W);
  const move = new Uint8Array((R + 1) * W); // 1 = diagonale, 2 = salta ref, 3 = salta hyp
  for (let i = 1; i <= R; i++) { score[i * W] = i * GAP; move[i * W] = 2; }
  for (let j = 1; j <= H; j++) { score[j] = j * GAP; move[j] = 3; }
  const sims = new Float32Array((R + 1) * W);
  for (let i = 1; i <= R; i++) {
    for (let j = 1; j <= H; j++) {
      const s = similarity(ref[i - 1].n, hyp[j - 1]);
      sims[i * W + j] = s;
      const diag = score[(i - 1) * W + j - 1] + (s >= 0.5 ? 2 * s : -1);
      const up = score[(i - 1) * W + j] + GAP;
      const left = score[i * W + j - 1] + GAP;
      if (diag >= up && diag >= left) { score[i * W + j] = diag; move[i * W + j] = 1; }
      else if (up >= left) { score[i * W + j] = up; move[i * W + j] = 2; }
      else { score[i * W + j] = left; move[i * W + j] = 3; }
    }
  }
  // Ricostruisce l'abbinamento parola-del-testo → parola-riconosciuta
  const pairOf = new Array(R).fill(-1);
  const strong = new Array(R).fill(false);
  let i = R, j = H;
  while (i > 0 || j > 0) {
    const m = move[i * W + j];
    if (m === 1) { pairOf[i - 1] = j - 1; strong[i - 1] = sims[i * W + j] >= 0.5; i--; j--; }
    else if (m === 2) i--;
    else j--;
  }

  const lines = lyricLines.map((text) => ({ start: null, end: null, text, uncertain: true }));
  ref.forEach((r, k) => {
    const line = lines[r.li];
    if (pairOf[k] < 0) return;
    const w = words[pairOf[k]];
    if (line.start == null) {
      // parole del verso non abbinate prima di questa: ~0.3 s ciascuna
      const before = ref.slice(0, k).filter((x) => x.li === r.li).length;
      line.start = Math.max(0, w.start - before * 0.3);
    }
    line.end = w.end;
    if (strong[k]) line.uncertain = false;
  });
  fillGaps(lines);
  return lines;
}

/** Interpola i tempi mancanti e garantisce che siano crescenti. */
function fillGaps(lines) {
  const n = lines.length;
  for (let k = 0; k < n; k++) {
    if (lines[k].start != null) continue;
    let a = k - 1; while (a >= 0 && lines[a].start == null) a--;
    let b = k + 1; while (b < n && lines[b].start == null) b++;
    const t0 = a >= 0 ? lines[a].start : 0;
    const t1 = b < n ? lines[b].start : t0 + (b - a) * 3;
    for (let m = a + 1; m < b; m++) {
      lines[m].start = t0 + ((t1 - t0) * (m - a)) / (b - a);
      lines[m].uncertain = true;
    }
    k = b - 1;
  }
  for (let k = 1; k < n; k++) {
    if (lines[k].start < lines[k - 1].start) { lines[k].start = lines[k - 1].start; lines[k].uncertain = true; }
  }
  for (let k = 0; k < n; k++) {
    const next = k + 1 < n ? lines[k + 1].start : null;
    if (lines[k].end == null || lines[k].end <= lines[k].start) lines[k].end = next ?? lines[k].start + 3;
  }
}
