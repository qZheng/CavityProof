import bs58 from "bs58";

export type SignInput = {
  user: string;        // base58 pubkey
  day: number;         // UTC day number
  sessionHash: string; // 32 bytes (hex or base64)
  nonce: string;       // 16 bytes (hex or base64)
  expiresAt: number;   // unix seconds
};

function parseHexOrBase64(s: string): Uint8Array {
  const t = s.trim();
  const hex = t.startsWith("0x") ? t.slice(2) : t;
  const isHex = /^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0;
  if (isHex) return Uint8Array.from(Buffer.from(hex, "hex"));
  return Uint8Array.from(Buffer.from(t, "base64"));
}

function writeI64LE(buf: Buffer, offset: number, value: number) {
  buf.writeBigInt64LE(BigInt(value), offset);
}

export function buildPayloadBytes(input: SignInput): Uint8Array {
  const magic = Buffer.from("CPv1", "utf8"); // 4 bytes

  const userPk = bs58.decode(input.user);
  if (userPk.length !== 32) throw new Error("user must decode to 32 bytes");

  const sessionHash = parseHexOrBase64(input.sessionHash);
  if (sessionHash.length !== 32) throw new Error("sessionHash must be 32 bytes");

  const nonce = parseHexOrBase64(input.nonce);
  if (nonce.length !== 16) throw new Error("nonce must be 16 bytes");

  const out = Buffer.alloc(4 + 32 + 8 + 32 + 16 + 8);
  let o = 0;

  magic.copy(out, o); o += 4;
  Buffer.from(userPk).copy(out, o); o += 32;

  writeI64LE(out, o, input.day); o += 8;

  Buffer.from(sessionHash).copy(out, o); o += 32;
  Buffer.from(nonce).copy(out, o); o += 16;

  writeI64LE(out, o, input.expiresAt); o += 8;

  return Uint8Array.from(out);
}
