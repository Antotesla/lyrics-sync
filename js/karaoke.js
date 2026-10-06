// Disegno del karaoke su canvas (stile video per bambini): riga corrente che si illumina
// parola per parola, righe successive che scorrono sotto, pallina che rimbalza sulle parole.
// Il disegno dipende solo dal tempo t: lo stesso codice serve all'anteprima e all'export video.

export const WIDTH = 1280;
export const HEIGHT = 720;
export const LEAD = 0.6; // anticipo con cui una riga diventa "corrente" (come nel file .ass)

const FONT_FAMILY = '"Baloo 2", "Arial Rounded MT Bold", "Trebuchet MS", system-ui, sans-serif';
const SIZE = 60; // dimensione del testo (px a 1280x720)
const ROW = SIZE * 1.18;
const LINE_GAP = SIZE * 0.55;
const MAX_TEXT_WIDTH = WIDTH * 0.86;
const CURRENT_TOP = HEIGHT * 0.3; // dove sta la riga corrente
const SCROLL_TIME = 0.4;
const SMALL = 0.82; // scala delle righe non correnti
const BALL_R = 13;
const BALL_HOP = 70; // altezza del salto

const COLORS = {
  skyTop: '#2f80ed', skyBottom: '#56ccf2',
  text: '#ffffff', sung: '#ffd23f', outline: 'rgba(16, 42, 84, 0.85)',
  ball: '#ff5a5f', ballShine: '#ffd1d2',
};

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ease = (x) => 1 - (1 - x) ** 3;

export const firstStart = (line) => line.words?.[0]?.start ?? line.start;

/** Indice della riga corrente al tempo t (-1 prima della prima riga). */
export function lineIndexAt(lines, t) {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) if (firstStart(lines[i]) - LEAD <= t) idx = i;
  return idx;
}

/**
 * Posizione della pallina: atterra su ogni parola all'inizio della parola e salta verso la successiva.
 * `anchors` = [{x, y, start}] (y = dove appoggia la pallina sopra la parola).
 */
export function ballAt(anchors, t) {
  if (!anchors.length) return null;
  const first = anchors[0];
  if (t < first.start - LEAD) return null;
  if (t < first.start) {
    // entrata da sinistra con un salto verso la prima parola
    const u = clamp01((t - (first.start - LEAD)) / LEAD);
    return { x: first.x - 140 * (1 - u), y: first.y - BALL_HOP * Math.sin(Math.PI * u) };
  }
  for (let k = 0; k < anchors.length - 1; k++) {
    const a = anchors[k], b = anchors[k + 1];
    if (t < b.start) {
      const u = clamp01((t - a.start) / Math.max(0.05, b.start - a.start));
      const hop = Math.min(BALL_HOP, 25 + Math.abs(b.x - a.x) * 0.35);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u - hop * Math.sin(Math.PI * u) };
    }
  }
  const last = anchors[anchors.length - 1];
  return { x: last.x, y: last.y };
}

/** Crea il renderer per un canvas 2D; `layout` viene ricalcolato quando cambia il testo. */
export function createKaraoke(ctx) {
  const cache = new WeakMap();
  const font = (px) => `700 ${px}px ${FONT_FAMILY}`;

  // Divide la riga in righe-video che stanno nella larghezza e misura ogni parola
  function layout(line) {
    const words = line.words?.length ? line.words : [{ text: line.text, start: line.start, end: line.end ?? line.start + 2 }];
    const key = words.map((w) => `${w.text}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join('|');
    const hit = cache.get(line);
    if (hit && hit.key === key) return hit;
    ctx.font = font(SIZE);
    const space = ctx.measureText(' ').width;
    const rows = [[]];
    let rowW = 0;
    for (const w of words) {
      const width = ctx.measureText(w.text).width;
      if (rows.at(-1).length && rowW + space + width > MAX_TEXT_WIDTH) { rows.push([]); rowW = 0; }
      rowW += (rows.at(-1).length ? space : 0) + width;
      rows.at(-1).push({ ...w, width });
    }
    const placed = [];
    rows.forEach((row, r) => {
      const total = row.reduce((s, w) => s + w.width, 0) + space * (row.length - 1);
      let x = (WIDTH - total) / 2;
      for (const w of row) { placed.push({ ...w, x, row: r }); x += w.width + space; }
    });
    const result = { key, words: placed, rows: rows.length, height: rows.length * ROW };
    cache.set(line, result);
    return result;
  }

  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, HEIGHT);
    g.addColorStop(0, COLORS.skyTop);
    g.addColorStop(1, COLORS.skyBottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
  }

  function drawLine(lay, top, { scale, alpha, t, active }) {
    ctx.save();
    ctx.globalAlpha = alpha;
    // scala attorno al centro orizzontale della riga
    ctx.translate(WIDTH / 2, top);
    ctx.scale(scale, scale);
    ctx.translate(-WIDTH / 2, 0);
    ctx.font = font(SIZE);
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    for (const w of lay.words) {
      const baseline = w.row * ROW + SIZE;
      ctx.lineWidth = 10;
      ctx.strokeStyle = COLORS.outline;
      ctx.strokeText(w.text, w.x, baseline);
      ctx.fillStyle = COLORS.text;
      ctx.fillText(w.text, w.x, baseline);
      if (active) {
        const p = t <= w.start ? 0 : t >= w.end ? 1 : (t - w.start) / Math.max(0.01, w.end - w.start);
        if (p > 0) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(w.x - 6, baseline - SIZE * 1.1, (w.width + 12) * p, SIZE * 1.5);
          ctx.clip();
          ctx.fillStyle = COLORS.sung;
          ctx.fillText(w.text, w.x, baseline);
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  function drawBall(lay, top, t, scale) {
    // stesse coordinate della riga disegnata (scalata attorno al centro orizzontale)
    const anchors = lay.words.map((w) => ({
      x: WIDTH / 2 + (w.x + w.width / 2 - WIDTH / 2) * scale,
      y: top + (w.row * ROW + SIZE * 0.24) * scale - BALL_R - 2, // appena sopra le lettere
      start: w.start,
    }));
    const b = ballAt(anchors, t);
    if (!b) return;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.18)';
    ctx.beginPath();
    ctx.ellipse(b.x, Math.min(...anchors.map((a) => a.y)) + BALL_R + 4, BALL_R * 0.9, 4, 0, 0, Math.PI * 2);
    ctx.fill();
    const g = ctx.createRadialGradient(b.x - 4, b.y - 4, 2, b.x, b.y, BALL_R);
    g.addColorStop(0, COLORS.ballShine);
    g.addColorStop(1, COLORS.ball);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** Disegna il frame al tempo t (secondi). */
  function draw(lines, t) {
    drawBackground();
    if (!lines.length) return;
    const idx = lineIndexAt(lines, t);
    const cur = Math.max(0, idx);
    // scorrimento: la colonna di righe si sposta in su quando cambia la riga corrente
    const s = idx < 0 ? 1 : ease(clamp01((t - (firstStart(lines[idx]) - LEAD)) / SCROLL_TIME));
    const lays = [];
    const tops = [];
    let y = 0;
    for (let i = Math.max(0, cur - 1); i < Math.min(lines.length, cur + 4); i++) {
      const lay = layout(lines[i]);
      lays[i] = lay;
      tops[i] = y;
      y += lay.height + LINE_GAP;
    }
    const target = (i) => CURRENT_TOP - (tops[i] ?? 0);
    const offset = idx > 0 && tops[idx - 1] != null ? target(idx - 1) + (target(idx) - target(idx - 1)) * s : target(cur);
    for (let i = Math.max(0, cur - 1); i < Math.min(lines.length, cur + 4); i++) {
      const top = offset + tops[i];
      const isCur = i === idx;
      const dist = i - cur;
      const scale = isCur ? SMALL + (1 - SMALL) * s : SMALL;
      const alpha = isCur ? 1 : dist < 0 ? 0.45 * (1 - s) : idx < 0 && i === 0 ? 0.85 : Math.max(0, 0.7 - 0.2 * (dist - 1));
      if (top > HEIGHT || top + lays[i].height < -ROW) continue;
      drawLine(lays[i], top, { scale, alpha, t, active: isCur });
    }
    const b = Math.max(0, idx); // prima della prima riga la pallina entra sulla riga 0
    drawBall(lays[b], offset + tops[b], t, idx >= 0 ? SMALL + (1 - SMALL) * s : SMALL);
  }

  return { draw };
}
