import { Router } from "express";
import nacl from "tweetnacl";
import bs58 from "bs58";

export const verifyRouter = Router();

verifyRouter.post("/", (req, res) => {
  try {
    const { oraclePubkey, payloadB64, sigB64 } = req.body as {
      oraclePubkey: string;
      payloadB64: string;
      sigB64: string;
    };

    const pubkeyBytes = bs58.decode(String(oraclePubkey));
    const payloadBytes = Uint8Array.from(Buffer.from(String(payloadB64), "base64"));
    const sigBytes = Uint8Array.from(Buffer.from(String(sigB64), "base64"));

    const ok = nacl.sign.detached.verify(payloadBytes, sigBytes, pubkeyBytes);
    res.json({ ok });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? String(e) });
  }
});
