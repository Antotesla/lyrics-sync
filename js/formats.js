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
