import fs from "fs";
import nacl from "tweetnacl";
import bs58 from "bs58";

export type OracleSigner = {
  oraclePubkeyBase58: string;
  sign: (message: Uint8Array) => Uint8Array; // 64-byte signature
};

export function loadOracleSigner(keypairPath: string): OracleSigner {
  const raw = fs.readFileSync(keypairPath, "utf8");
  const secretKey = Uint8Array.from(JSON.parse(raw)); // Solana keypair JSON (64 bytes)

  if (secretKey.length !== 64) {
    throw new Error(`Oracle keypair must be 64 bytes, got ${secretKey.length}`);
  }

  const keypair = nacl.sign.keyPair.fromSecretKey(secretKey);
  const oraclePubkeyBase58 = bs58.encode(Buffer.from(keypair.publicKey));

  return {
    oraclePubkeyBase58,
    sign: (message: Uint8Array) => nacl.sign.detached(message, keypair.secretKey),
  };
}
