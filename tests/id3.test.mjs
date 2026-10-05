import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readId3Lyrics } from '../js/id3.js';

function id3WithUslt(text) {
  const body = Buffer.concat([Buffer.from([3]), Buffer.from('ita'), Buffer.from([0]), Buffer.from(text, 'utf8')]);
  const frame = Buffer.concat([Buffer.from('USLT'), u32(body.length), Buffer.from([0, 0]), body]);
  const ss = (n) => Buffer.from([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127]);
  return Buffer.concat([Buffer.from('ID3'), Buffer.from([3, 0, 0]), ss(frame.length), frame]);
}
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const ab = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);

test('legge il testo dal frame USLT', () => {
  assert.equal(readId3Lyrics(ab(id3WithUslt('[Verse]\nRiga uno\nRiga due'))), '[Verse]\nRiga uno\nRiga due');
});

test('restituisce null senza tag ID3', () => {
  assert.equal(readId3Lyrics(ab(Buffer.from('RIFF0000WAVE'))), null);
});
