import { randomBytes } from 'node:crypto';

/**
 * RFC 9562 UUIDv7: a 48-bit millisecond timestamp followed by random bits,
 * so ids sort roughly by creation time (better index locality than v4).
 * All ids are uuid v7 except items.item_id (§6).
 */
export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();

  // Division/modulo, not bitwise ops: `ms` exceeds the 32-bit range that JS's
  // bitwise operators silently wrap.
  bytes[0] = Math.floor(ms / 2 ** 40) % 256;
  bytes[1] = Math.floor(ms / 2 ** 32) % 256;
  bytes[2] = Math.floor(ms / 2 ** 24) % 256;
  bytes[3] = Math.floor(ms / 2 ** 16) % 256;
  bytes[4] = Math.floor(ms / 2 ** 8) % 256;
  bytes[5] = ms % 256;

  bytes[6] = 0x70 | (bytes[6]! & 0x0f); // version 7
  bytes[8] = 0x80 | (bytes[8]! & 0x3f); // variant 10

  const hex = bytes.toString('hex');
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-');
}
