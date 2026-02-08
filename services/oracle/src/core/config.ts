import path from "path";

export function getConfig() {
  const port = Number(process.env.PORT || 8787);
  const keypairPath = process.env.ORACLE_KEYPAIR_PATH;
  if (!keypairPath) throw new Error("Missing ORACLE_KEYPAIR_PATH in .env");

  return {
    port,
    keypairPath: path.resolve(process.cwd(), keypairPath),
  };
}
