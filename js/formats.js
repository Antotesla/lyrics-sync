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
/** "#rrggbb" + opacità (0..1) → colore ASS "&HAABBGGRR" (in ASS 00 = opaco). */
function assColor(hex, opacity = 1) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) || [null, 'ff', 'ff', 'ff'];
  const a = Math.round((1 - opacity) * 255).toString(16).padStart(2, '0');
  return `&H${a}${m[3]}${m[2]}${m[1]}`.toUpperCase();
}

const ASS_SIZES = { small: 46, medium: 58, large: 70 };

export function toAss(lines, title = '', opts = {}) {
  const LEAD = 0.6; // secondi di anticipo con cui compare la riga
  const align = opts.position === 'top' ? 8 : opts.position === 'center' ? 5 : 2;
  const band = (opts.readability ?? 'band') === 'band';
  const boxColor = assColor('#000000', band ? Number(opts.bandOpacity ?? 0.55) : 0.95);
  const size = ASS_SIZES[opts.textSize] ?? 56;
  const MARGIN_V = 50;
  const style = [
    'Karaoke', 'Arial', size,
    assColor(opts.sungColor || '#ffd23f'), // colore delle parole già cantate
    '&H00FFFFFF', // colore prima di essere cantate
    '&H00000000', // contorno nero
    '&H80000000', // ombra
    -1, 0, 0, 0, 100, 100, 0, 0,
    1, band ? 2.5 : 3, band ? 0 : 2,
    align, 60, 60, MARGIN_V, 1,
  ].join(',');
  // La fascia è un rettangolo disegnato a parte (layer 0): con BorderStyle 3 libass farebbe
  // un riquadro per ogni parola, con blocchi irregolari.
  const boxStyle = ['Box', 'Arial', 20, boxColor, boxColor, boxColor, boxColor, 0, 0, 0, 0, 100, 100, 0, 0, 1, 0, 0, 7, 0, 0, 0, 1].join(',');
  const charsPerRow = Math.floor((1280 - 120) / (size * 0.55));
  const boxFor = (text) => {
    const rows = Math.min(3, Math.max(1, Math.ceil(text.length / charsPerRow)));
    const h = Math.round(rows * size * 1.2 + 28);
    const y = align === 2 ? 720 - MARGIN_V + 14 - h : align === 8 ? MARGIN_V - 14 : Math.round(360 - h / 2);
    return `{\\pos(48,${y})\\p1}m 0 0 l ${1280 - 96} 0 ${1280 - 96} ${h} 0 ${h}{\\p0}`;
  };
  const head = `[Script Info]
Title: ${assEscape(title)}
ScriptType: v4.00+
PlayResX: 1280
PlayResY: 720
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: ${style}
Style: ${boxStyle}

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
    const karaokeEvent = `Dialogue: 1,${assTime(show)},${assTime(hide)},Karaoke,,0,0,0,,${text.trim()}`;
    return band ? `Dialogue: 0,${assTime(show)},${assTime(hide)},Box,,0,0,0,,${boxFor(l.text)}\n${karaokeEvent}` : karaokeEvent;
  });
  return head + events.join('\n') + '\n';
}
