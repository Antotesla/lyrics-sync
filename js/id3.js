// Legge il testo della canzone dal tag ID3 USLT di un mp3 (es. i file scaricati da Suno).

const syncsafe = (b, o) => (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
const uint32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function decode(bytes, enc) {
  const label = ['latin1', 'utf-16', 'utf-16be', 'utf-8'][enc] || 'utf-8';
  return new TextDecoder(label).decode(bytes).replace(/\0+$/, '');
}

/** Restituisce il testo (stringa) o null se il file non ha un tag USLT. */
export function readId3Lyrics(arrayBuffer) {
  const b = new Uint8Array(arrayBuffer);
  if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return null; // "ID3"
  const version = b[3];
  if (version < 3) return null;
  const end = Math.min(b.length, 10 + syncsafe(b, 6));
  let pos = 10;
  if (b[5] & 0x40) pos += version === 4 ? syncsafe(b, 10) : uint32(b, 10) + 4; // extended header
  while (pos + 10 <= end) {
    const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = version === 4 ? syncsafe(b, pos + 4) : uint32(b, pos + 4);
    const body = b.subarray(pos + 10, pos + 10 + size);
    pos += 10 + size;
    if (id !== 'USLT' || body.length < 5) continue;
    const enc = body[0];
    const wide = enc === 1 || enc === 2;
    let k = 4; // salta encoding + lingua (3 byte), poi il descrittore terminato da zero
    if (wide) { while (k + 1 < body.length && (body[k] || body[k + 1])) k += 2; k += 2; }
    else { while (k < body.length && body[k]) k++; k += 1; }
    const text = decode(body.subarray(k), enc).trim();
    if (text) return text;
  }
  return null;
}
