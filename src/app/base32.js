const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export function encodeBase32(input) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : new Uint8Array(input || []);
  let buffer = 0;
  let bits = 0;
  let output = '';
  for (const byte of bytes) {
    buffer = (buffer * 256) + byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[Math.floor(buffer / (2 ** bits)) & 31];
      buffer %= 2 ** bits;
    }
  }
  if (bits > 0) output += ALPHABET[(buffer * (2 ** (5 - bits))) & 31];
  return output;
}

export function decodeBase32(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return new Uint8Array();
  if (!/^[a-z2-7]+$/.test(normalized)) throw new TypeError('Invalid Base32 value.');
  let buffer = 0;
  let bits = 0;
  const output = [];
  for (const character of normalized) {
    buffer = (buffer * 32) + ALPHABET.indexOf(character);
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      output.push(Math.floor(buffer / (2 ** bits)) & 255);
      buffer %= 2 ** bits;
    }
  }
  if (bits >= 5 || (bits > 0 && buffer % (2 ** bits) !== 0)) throw new TypeError('Invalid Base32 padding.');
  return Uint8Array.from(output);
}

