// Disegno del karaoke su canvas (stile video per bambini): riga corrente che si illumina
// parola per parola, righe successive che scorrono sotto, pallina che rimbalza sulle parole.
// Il disegno dipende solo dal tempo t (e dalle opzioni): lo stesso codice serve all'anteprima
// e all'export video. Può disegnare su uno sfondo proprio o sopra un video esistente.

// Dimensioni dell'area di disegno: seguono il canvas (quindi il formato del video, anche verticale).
// K = fattore di scala rispetto al riferimento 1280x720.
let W = 1280;
let H = 720;
let K = 1;
export const LEAD = 0.6; // anticipo con cui una riga diventa "corrente" (come nel file .ass)

const FONT_FAMILY = '"Baloo 2", "Arial Rounded MT Bold", "Trebuchet MS", system-ui, sans-serif';
const SCROLL_TIME = 0.4;
const SMALL = 0.82; // scala delle righe non correnti
const BALL_R = 13;
const BALL_HOP = 70; // altezza massima del salto
const MARGIN = 24; // distanza della fascia dal bordo del video

export const TEXT_SIZES = { small: 46, medium: 58, large: 70 };

export const DEFAULT_OPTIONS = {
  background: 'sky', // 'sky' | 'video'
  position: 'bottom', // solo su video: 'bottom' | 'top' | 'center'
  readability: 'band', // solo su video: 'band' (fascia scura) | 'outline' (solo contorno)
  bandOpacity: 0.55,
  nextLines: 1, // righe successive visibili sul video (sullo sfondo proprio sono 3)
  textSize: 'medium',
  sungColor: '#ffd23f',
  ballColor: '#ff5a5f',
};

const SKY = { top: '#2f80ed', bottom: '#56ccf2', outline: 'rgba(16, 42, 84, 0.85)' };

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
export function ballAt(anchors, t, from = null, hopMax = BALL_HOP) {
  if (!anchors.length) return null;
  const first = anchors[0];
  if (t < first.start) {
    // Salto verso la prima parola: parte dall'ultima parola della riga precedente (se c'è),
    // altrimenti entra da sinistra. Prima del salto resta ferma sulla parola precedente.
    const start = from ? Math.max(from.start, first.start - LEAD * 1.5) : first.start - LEAD;
    if (t < start) return from ? { x: from.x, y: from.y } : null;
    const x0 = from ? from.x : first.x - 140;
    const y0 = from ? from.y : first.y;
    const u = clamp01((t - start) / Math.max(0.05, first.start - start));
    return { x: x0 + (first.x - x0) * u, y: y0 + (first.y - y0) * u - hopMax * Math.sin(Math.PI * u) };
  }
  for (let k = 0; k < anchors.length - 1; k++) {
    const a = anchors[k], b = anchors[k + 1];
    if (t < b.start) {
      const u = clamp01((t - a.start) / Math.max(0.05, b.start - a.start));
      const hop = Math.min(hopMax, (hopMax / BALL_HOP) * 25 + Math.abs(b.x - a.x) * 0.35);
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u - hop * Math.sin(Math.PI * u) };
    }
  }
  const last = anchors[anchors.length - 1];
  return { x: last.x, y: last.y };
}

/**
 * Rettangolo della fascia del testo quando si scrive sopra un video.
 * Altezza fissa per tutta la canzone (niente "salti"): spazio per la pallina,
 * la riga corrente (fino a `curRows` righe-video) e le righe successive.
 */
export function bandRect(o, size, curRows) {
  const row = size * 1.18;
  const gap = size * 0.3;
  const ballRoom = size * 0.95;
  const pad = size * 0.3;
  const height = ballRoom + curRows * row + o.nextLines * (row * SMALL + gap) + pad;
  const m = MARGIN * K;
  const top = o.position === 'top' ? m : o.position === 'center' ? (H - height) / 2 : H - m - height;
  return { x: m * 2, y: top, width: W - m * 4, height, currentTop: top + ballRoom };
}

/** Crea il renderer per un canvas 2D. */
export function createKaraoke(ctx) {
  const cache = new WeakMap();
  const font = (px) => `700 ${px}px ${FONT_FAMILY}`;

  // Divide la riga in righe-video che stanno nella larghezza e misura ogni parola
  function layout(line, size, maxWidth) {
    const words = line.words?.length ? line.words : [{ text: line.text, start: line.start, end: line.end ?? line.start + 2 }];
    const key = `${W}/${size}/${maxWidth}/` + words.map((w) => `${w.text}@${w.start.toFixed(2)}-${w.end.toFixed(2)}`).join('|');
    const hit = cache.get(line);
    if (hit && hit.key === key) return hit;
    ctx.font = font(size);
    const space = ctx.measureText(' ').width;
    const rows = [[]];
    let rowW = 0;
    for (const w of words) {
      const width = ctx.measureText(w.text).width;
      if (rows.at(-1).length && rowW + space + width > maxWidth) { rows.push([]); rowW = 0; }
      rowW += (rows.at(-1).length ? space : 0) + width;
      rows.at(-1).push({ ...w, width });
    }
    const placed = [];
    rows.forEach((row, r) => {
      const total = row.reduce((s, w) => s + w.width, 0) + space * (row.length - 1);
      let x = (W - total) / 2;
      for (const w of row) { placed.push({ ...w, x, row: r }); x += w.width + space; }
    });
    const result = { key, words: placed, rows: rows.length, height: rows.length * size * 1.18 };
    cache.set(line, result);
    return result;
  }

  function drawSky() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, SKY.top);
    g.addColorStop(1, SKY.bottom);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // Video intero senza tagli (bande nere se il formato non è 16:9)
  function drawVideo(video) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);
    const vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return;
    const k = Math.min(W / vw, H / vh);
    const w = vw * k, h = vh * k;
    ctx.drawImage(video, (W - w) / 2, (H - h) / 2, w, h);
  }

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawLine(lay, top, { scale, alpha, t, active, size, style }) {
    const row = size * 1.18;
    ctx.save();
    ctx.globalAlpha = alpha;
    // scala attorno al centro orizzontale della riga
    ctx.translate(W / 2, top);
    ctx.scale(scale, scale);
    ctx.translate(-W / 2, 0);
    ctx.font = font(size);
    ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round';
    if (style.shadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.75)';
      ctx.shadowBlur = size * 0.25;
    }
    for (const w of lay.words) {
      const baseline = w.row * row + size;
      ctx.lineWidth = style.outlineWidth;
      ctx.strokeStyle = style.outline;
      ctx.strokeText(w.text, w.x, baseline);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(w.text, w.x, baseline);
      if (active) {
        const p = t <= w.start ? 0 : t >= w.end ? 1 : (t - w.start) / Math.max(0.01, w.end - w.start);
        if (p > 0) {
          ctx.save();
          ctx.shadowColor = 'transparent';
          ctx.beginPath();
          ctx.rect(w.x - 6, baseline - size * 1.1, (w.width + 12) * p, size * 1.5);
          ctx.clip();
          ctx.fillStyle = style.sung;
          ctx.fillText(w.text, w.x, baseline);
          ctx.restore();
        }
      }
    }
    ctx.restore();
  }

  // punti di appoggio della pallina sopra le parole (stesse coordinate della riga disegnata)
  function anchorsOf(lay, top, scale, size) {
    const row = size * 1.18;
    const r = BALL_R * (size / 60);
    return lay.words.map((w) => ({
      x: W / 2 + (w.x + w.width / 2 - W / 2) * scale,
      y: top + (w.row * row + size * 0.24) * scale - r - 2, // appena sopra le lettere
      start: w.start,
    }));
  }

  function drawBall(anchors, from, t, size, color) {
    const r = BALL_R * (size / 60);
    const b = ballAt(anchors, t, from, BALL_HOP * K);
    if (!b) return;
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
    ctx.shadowBlur = 6;
    const g = ctx.createRadialGradient(b.x - r * 0.3, b.y - r * 0.3, 1, b.x, b.y, r);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.25, color);
    g.addColorStop(1, color);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(b.x, b.y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.stroke();
    ctx.restore();
  }

  /** Disegna il frame al tempo t (secondi). `opts`: vedi DEFAULT_OPTIONS, più `video`. */
  function draw(lines, t, opts = {}) {
    const o = { ...DEFAULT_OPTIONS, ...opts };
    W = ctx.canvas.width;
    H = ctx.canvas.height;
    // orizzontale: scala rispetto a 1280x720; verticale: rispetto alla larghezza (testo un po' più piccolo)
    K = W >= H ? Math.min(W / 1280, H / 720) : (W / 720) * 0.75;
    const onVideo = o.background === 'video' && o.video;
    const size = (onVideo ? TEXT_SIZES[o.textSize] ?? TEXT_SIZES.medium : 60) * K;
    const row = size * 1.18;
    const maxWidth = W * (W < H ? 0.88 : onVideo ? 0.8 : 0.86);
    if (onVideo) drawVideo(o.video);
    else drawSky();
    if (!lines.length) return;

    const shownNext = onVideo ? o.nextLines : 3;
    const gap = onVideo ? size * 0.3 : size * 0.55;
    let band = null;
    if (onVideo) {
      const curRows = Math.min(2, Math.max(1, ...lines.map((l) => layout(l, size, maxWidth).rows)));
      band = bandRect(o, size, curRows);
    }
    const currentTop = band ? band.currentTop : H * 0.3;
    const style = onVideo && o.readability === 'outline'
      ? { outline: 'rgba(0, 0, 0, 0.95)', outlineWidth: size * 0.22, shadow: true, sung: o.sungColor }
      : { outline: onVideo ? 'rgba(0, 0, 0, 0.8)' : SKY.outline, outlineWidth: size * 0.17, shadow: false, sung: onVideo ? o.sungColor : '#ffd23f' };

    if (band && o.readability === 'band') {
      ctx.save();
      ctx.fillStyle = `rgba(0, 0, 0, ${o.bandOpacity})`;
      roundRect(band.x, band.y, band.width, band.height, 18);
      ctx.fill();
      ctx.restore();
    }

    const idx = lineIndexAt(lines, t);
    const cur = Math.max(0, idx);
    // scorrimento: la colonna di righe si sposta in su quando cambia la riga corrente
    const s = idx < 0 ? 1 : ease(clamp01((t - (firstStart(lines[idx]) - LEAD)) / SCROLL_TIME));
    const from = Math.max(0, cur - 1);
    const to = Math.min(lines.length, cur + shownNext + 2);
    const lays = [];
    const tops = [];
    let y = 0;
    for (let i = from; i < to; i++) {
      lays[i] = layout(lines[i], size, maxWidth);
      tops[i] = y;
      y += lays[i].height + gap;
    }
    const target = (i) => currentTop - (tops[i] ?? 0);
    const offset = idx > 0 && tops[idx - 1] != null ? target(idx - 1) + (target(idx) - target(idx - 1)) * s : target(cur);

    ctx.save();
    if (band) {
      // sul video le righe restano dentro la fascia anche mentre scorrono
      ctx.beginPath();
      ctx.rect(0, band.y, W, band.height);
      ctx.clip();
    }
    for (let i = from; i < to; i++) {
      const top = offset + tops[i];
      const isCur = i === idx;
      const dist = i - cur;
      const scale = isCur ? SMALL + (1 - SMALL) * s : SMALL;
      let alpha;
      if (isCur) alpha = 1;
      else if (dist < 0) alpha = 0.45 * (1 - s);
      else if (idx < 0 && i === 0) alpha = 0.85;
      else if (dist > shownNext) alpha = 0.6 * s; // la riga che entra dal basso
      else alpha = Math.max(0, (onVideo ? 0.8 : 0.7) - 0.2 * (dist - 1));
      if (top > H || top + lays[i].height < -row) continue;
      drawLine(lays[i], top, { scale, alpha, t, active: isCur, size, style });
    }
    ctx.restore();

    const b = Math.max(0, idx); // prima della prima riga la pallina entra sulla riga 0
    const anchors = anchorsOf(lays[b], offset + tops[b], idx >= 0 ? SMALL + (1 - SMALL) * s : SMALL, size);
    // la pallina parte dall'ultima parola della riga precedente (che intanto scorre in su)
    const prev = idx > 0 && lays[idx - 1] ? anchorsOf(lays[idx - 1], offset + tops[idx - 1], SMALL, size).at(-1) : null;
    drawBall(anchors, prev, t, size, onVideo ? o.ballColor : '#ff5a5f');
  }

  return { draw };
}
