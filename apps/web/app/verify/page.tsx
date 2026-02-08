"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";

const PROGRAM_ID = new PublicKey("BtJDtqG3Zy25gZC43H7q1TXTqjoeSh4JBHVYiWzwd2cb");
const CLUSTER = "devnet";

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function explorerTx(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
}

type VerifyResult = {
  valid: boolean;
  txSig: string;
  sessionHashHex?: string;
  user?: string;
  day?: number;
  nonceHex?: string;
  error?: string;
};

export default function VerifyPage() {
  const { connection } = useConnection();
  const [signature, setSignature] = useState("");
  const [sessionHashToCheck, setSessionHashToCheck] = useState("");
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function verifyFromBlockchain() {
    setResult(null);
    const sig = signature.trim();
    if (!sig) {
      setResult({ valid: false, txSig: "", error: "Enter a transaction signature." });
      return;
    }

    setLoading(true);
    try {
      const rawTx = await connection.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
      });
      if (!rawTx?.transaction) {
        setResult({
          valid: false,
          txSig: sig,
          error: "Could not load transaction. Check the signature and that you're on devnet.",
        });
        return;
      }

      const versionedTx = rawTx.transaction;
      const message = versionedTx.message;
      const keysResult = message.getAccountKeys({ addressLookupTableAccounts: [] });
      const accountKeys = "staticAccountKeys" in keysResult && Array.isArray(keysResult.staticAccountKeys)
        ? keysResult.staticAccountKeys
        : (keysResult as unknown as PublicKey[]);
      const instructions = message.compiledInstructions;

      let sessionHashBytes: Uint8Array | null = null;
      let user: string | null = null;
      let day: number | undefined;
      let nonceBytes: Uint8Array | null = null;

      for (const cix of instructions) {
        const programKey = accountKeys[cix.programIdIndex];
        if (!programKey) continue;
        const pk = programKey instanceof PublicKey ? programKey : new PublicKey(programKey);
        if (!pk.equals(PROGRAM_ID)) continue;

        const data = cix.data;
        if (data.length < 8 + 8 + 32 + 16 + 8) continue;

        const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
        day = Number(view.getBigInt64(8, true));
        sessionHashBytes = new Uint8Array(data.slice(16, 48));
        nonceBytes = new Uint8Array(data.slice(48, 64));
        const userKeyIndex = cix.accountKeyIndexes[0];
        if (userKeyIndex !== undefined && accountKeys[userKeyIndex]) {
          const k = accountKeys[userKeyIndex];
          user = (k instanceof PublicKey ? k : new PublicKey(k)).toBase58();
        }
        break;
      }

      if (!sessionHashBytes || sessionHashBytes.length !== 32) {
        setResult({
          valid: false,
          txSig: sig,
          error: "Could not parse claim instruction data from this transaction.",
        });
        return;
      }

      const sessionHashHex = bytesToHex(sessionHashBytes);
      const hashMatches =
        !sessionHashToCheck.trim() ||
        sessionHashToCheck.trim().toLowerCase().replace(/^0x/, "") === sessionHashHex.toLowerCase();

      setResult({
        valid: true,
        txSig: sig,
        sessionHashHex,
        user: user ?? undefined,
        day,
        nonceHex: nonceBytes ? bytesToHex(nonceBytes) : undefined,
        error: sessionHashToCheck.trim() && !hashMatches
          ? `Session hash does not match. Expected from tx: ${sessionHashHex}`
          : undefined,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setResult({
        valid: false,
        txSig: sig,
        error: `Failed to verify: ${msg}`,
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <main
      style={{
        padding: 24,
        fontFamily: "ui-sans-serif, system-ui",
        color: "#0a0a0a",
        maxWidth: 720,
        margin: "0 auto",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <Link
          href="/"
          style={{ color: "#666", textDecoration: "none", fontSize: 14 }}
        >
          ← Back to BrushBuddy
        </Link>
      </div>

      <h1 style={{ fontSize: 24, fontWeight: 700, marginBottom: 8 }}>
        Hash authentication (blockchain)
      </h1>
      <p style={{ color: "#555", marginBottom: 24, lineHeight: 1.5 }}>
        Verify a CavityProof claim by transaction signature. The session hash is stored on-chain and can be used to prove a brush session was attested.
      </p>

      <div
        style={{
          border: "1px solid #333",
          borderRadius: 14,
          padding: 20,
          background: "#fafafa",
        }}
      >
        <label style={{ display: "block", fontWeight: 600, marginBottom: 8 }}>
          Transaction signature
        </label>
        <input
          type="text"
          placeholder="e.g. 5VERv8M... (from Solana Explorer)"
          value={signature}
          onChange={(e) => setSignature(e.target.value)}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #ccc",
            fontFamily: "monospace",
            fontSize: 14,
            boxSizing: "border-box",
          }}
        />

        <label style={{ display: "block", fontWeight: 600, marginTop: 16, marginBottom: 8 }}>
          Optional: session hash to compare
        </label>
        <input
          type="text"
          placeholder="Paste session hash (hex) to verify it matches this tx"
          value={sessionHashToCheck}
          onChange={(e) => setSessionHashToCheck(e.target.value)}
          style={{
            width: "100%",
            padding: "10px 12px",
            borderRadius: 10,
            border: "1px solid #ccc",
            fontFamily: "monospace",
            fontSize: 14,
            boxSizing: "border-box",
          }}
        />

        <button
          onClick={verifyFromBlockchain}
          disabled={loading}
          style={{
            marginTop: 16,
            padding: "10px 20px",
            borderRadius: 10,
            border: "1px solid #333",
            background: "#0a0a0a",
            color: "#fff",
            cursor: loading ? "not-allowed" : "pointer",
            fontWeight: 600,
          }}
        >
          {loading ? "Verifying…" : "Verify from blockchain"}
        </button>
      </div>

      {result && (
        <div
          style={{
            marginTop: 24,
            border: `1px solid ${result.valid ? "#22c55e" : "#e11"}`,
            borderRadius: 14,
            padding: 20,
            background: result.valid ? "#f0fdf4" : "#fef2f2",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 12, color: result.valid ? "#166534" : "#b91c1c" }}>
            {result.valid ? "✓ Authenticated" : "✗ Verification failed"}
          </div>
          {result.error && (
            <p style={{ color: "#b91c1c", marginBottom: 12 }}>{result.error}</p>
          )}
          <div style={{ fontFamily: "monospace", fontSize: 13, lineHeight: 1.8 }}>
            {result.txSig && (
              <div>
                <span style={{ color: "#666" }}>Transaction: </span>
                <a
                  href={explorerTx(result.txSig)}
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: "#2563eb", wordBreak: "break-all" }}
                >
                  {result.txSig.slice(0, 8)}…{result.txSig.slice(-8)}
                </a>
              </div>
            )}
            {result.sessionHashHex && (
              <div style={{ marginTop: 8 }}>
                <span style={{ color: "#666" }}>Session hash (on-chain): </span>
                <span style={{ wordBreak: "break-all", color: "#0a0a0a" }}>
                  {result.sessionHashHex}
                </span>
              </div>
            )}
            {result.user && (
              <div style={{ marginTop: 8 }}>
                <span style={{ color: "#666" }}>User: </span>
                <span style={{ wordBreak: "break-all" }}>{result.user}</span>
              </div>
            )}
            {result.day != null && (
              <div style={{ marginTop: 8 }}>
                <span style={{ color: "#666" }}>Day: </span>
                {result.day}
              </div>
            )}
            {result.nonceHex && (
              <div style={{ marginTop: 8 }}>
                <span style={{ color: "#666" }}>Nonce: </span>
                <span style={{ wordBreak: "break-all" }}>{result.nonceHex}</span>
              </div>
            )}
          </div>
        </div>
      )}

      <p style={{ marginTop: 32, fontSize: 13, color: "#666", lineHeight: 1.6 }}>
        Use a claim transaction signature from Solana Explorer (devnet). The page fetches the transaction and extracts the session hash and claim details stored on-chain.
      </p>
    </main>
  );
}
