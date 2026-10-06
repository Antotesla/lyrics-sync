// Formattazione dei tempi ed export (TXT, LRC, SRT).

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** 63.4 → "1:03" (arrotondato al secondo, come nelle trascrizioni a mano) */
export function formatShort(sec) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${pad(s % 60)}`;
}

/** 63.45 → "1:03.4" (precisione al decimo, per l'editor) */
export function formatPrecise(sec) {
  const d = Math.max(0, Math.round(sec * 10));
  return `${Math.floor(d / 600)}:${pad(Math.floor(d / 10) % 60)}.${d % 10}`;
}

/** Accetta "1:03", "1:03.4", "63", "63.4" → secondi; null se non valido. */
export function parseTime(str) {
  const m = String(str).trim().match(/^(?:(\d+):)?(\d+(?:[.,]\d+)?)$/);
  if (!m) return null;
  const sec = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2].replace(',', '.'));
  return Number.isFinite(sec) ? sec : null;
}

export function toTxt(lines) {
  return lines.map((l) => `(${formatShort(l.start)}) ${l.text}`).join('\n') + '\n';
}

export function toLrc(lines, title = '') {
  const head = title ? `[ti:${title}]\n` : '';
  return head + lines.map((l) => {
    const cs = Math.max(0, Math.round(l.start * 100));
    return `[${pad(Math.floor(cs / 6000))}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}]${l.text}`;
  }).join('\n') + '\n';
}

function srtTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

export function toSrt(lines) {
  return lines.map((l, i) => {
    const next = lines[i + 1];
    let end = l.end ?? l.start + 3;
    if (next && end > next.start) end = next.start;
    if (end <= l.start) end = l.start + 1;
    return `${i + 1}\n${srtTime(l.start)} --> ${srtTime(end)}\n${l.text}\n`;
  }).join('\n');
}

// ---------- Sottotitoli karaoke (ASS) ----------

function assTime(sec) {
  const cs = Math.max(0, Math.round(sec * 100));
  return `${Math.floor(cs / 360000)}:${pad(Math.floor(cs / 6000) % 60)}:${pad(Math.floor(cs / 100) % 60)}.${pad(cs % 100)}`;
}

const assEscape = (s) => s.replace(/[{}]/g, '').replace(/\\/g, '');

/**
 * File .ass con effetto karaoke: ogni parola si colora mentre viene cantata (\kf).
 * Ogni riga compare poco prima della prima parola e resta fino all'inizio della successiva.
 */
export function toAss(lines, title = '') {
  const LEAD = 0.6; // secondi di anticipo con cui compare la riga
  const head = `[Script Info]
Title: ${assEscape(title)}
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Karaoke,Arial,56,&H0000D7FF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,70,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
  const events = lines.map((l, i) => {
    const words = l.words?.length ? l.words : [{ text: l.text, start: l.start, end: l.end ?? l.start + 2 }];
    const prevEnd = i > 0 ? (lines[i - 1].words?.at(-1)?.end ?? lines[i - 1].start) : 0;
    const show = Math.max(prevEnd, words[0].start - LEAD, 0);
    const next = lines[i + 1];
    const lastEnd = words[words.length - 1].end;
    const hide = Math.max(lastEnd + 0.3, next ? Math.min(next.start, lastEnd + 2) : lastEnd + 2);
    let t = show;
    let text = '';
    for (const w of words) {
      const gap = Math.round((w.start - t) * 100);
      if (gap > 0) text += `{\\k${gap}}`;
      const dur = Math.max(1, Math.round((w.end - Math.max(w.start, t)) * 100));
      text += `{\\kf${dur}}${assEscape(w.text)} `;
      t = Math.max(w.start, t) + dur / 100;
    }
    return `Dialogue: 0,${assTime(show)},${assTime(hide)},Karaoke,,0,0,0,,${text.trim()}`;
  });
  return head + events.join('\n') + '\n';
}
