// Real checksum algorithms. Used by codecs and verified in tests.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();

/** CRC-32 (IEEE 802.3), as used by the Ethernet FCS. */
export function crc32(b: Uint8Array, start = 0, end = b.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RFC 1071 Internet checksum over the given range, with optional pseudo-header prefix. */
export function inetChecksum(b: Uint8Array, start = 0, end = b.length, prefix?: Uint8Array): number {
  let sum = 0;
  if (prefix) { for (let i = 0; i + 1 < prefix.length; i += 2) sum += (prefix[i]! << 8) | prefix[i + 1]!; if (prefix.length & 1) sum += prefix[prefix.length - 1]! << 8; }
  let i = start;
  for (; i + 1 < end; i += 2) sum += (b[i]! << 8) | b[i + 1]!;
  if (i < end) sum += b[i]! << 8;
  while (sum >>> 16) sum = (sum & 0xffff) + (sum >>> 16);
  return (~sum) & 0xffff;
}

/** Pseudo-header for TCP/UDP checksums (RFC 768/793). */
export function pseudoHeader(srcIp: number, dstIp: number, proto: number, len: number): Uint8Array {
  const p = new Uint8Array(12);
  p[0] = srcIp >>> 24; p[1] = (srcIp >>> 16) & 255; p[2] = (srcIp >>> 8) & 255; p[3] = srcIp & 255;
  p[4] = dstIp >>> 24; p[5] = (dstIp >>> 16) & 255; p[6] = (dstIp >>> 8) & 255; p[7] = dstIp & 255;
  p[8] = 0; p[9] = proto & 255; p[10] = (len >>> 8) & 255; p[11] = len & 255;
  return p;
}
