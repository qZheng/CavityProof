import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { healthRouter } from "./routes/health";
import { getConfig } from "./core/config";
import { loadOracleSigner } from "./core/signer";
import { makeOracleRouter } from "./routes/oracle";
import { verifyRouter } from "./routes/verify";

dotenv.config();

const cfg = getConfig();
const signer = loadOracleSigner(cfg.keypairPath);

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.use("/health", healthRouter);
app.use("/oracle", makeOracleRouter(signer));
app.use("/verify", verifyRouter);

app.listen(cfg.port, () => {
  console.log(`Oracle service listening on http://localhost:${cfg.port}`);
  console.log(`Oracle pubkey: ${signer.oraclePubkeyBase58}`);
});
