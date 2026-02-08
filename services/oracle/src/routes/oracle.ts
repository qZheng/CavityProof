import { Router } from "express";
import { buildPayloadBytes, SignInput } from "../core/payload";
import { validateSignInput } from "../core/validate";
import { OracleSigner } from "../core/signer";

export function makeOracleRouter(signer: OracleSigner) {
  const router = Router();

  router.post("/sign", (req, res) => {
    try {
      const body = req.body as Partial<SignInput>;

      const input: SignInput = {
        user: String(body.user || ""),
        day: Number(body.day),
        sessionHash: String((body as any).sessionHash || ""),
        nonce: String((body as any).nonce || ""),
        expiresAt: Number((body as any).expiresAt),
      };

      validateSignInput(input);

      const payloadBytes = buildPayloadBytes(input);
      const sigBytes = signer.sign(payloadBytes);

      res.json({
        oraclePubkey: signer.oraclePubkeyBase58,
        payloadB64: Buffer.from(payloadBytes).toString("base64"),
        sigB64: Buffer.from(sigBytes).toString("base64"),
      });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? String(e) });
    }
  });

  return router;
}
