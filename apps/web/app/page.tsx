"use client";

import React, { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Transaction,
  TransactionInstruction,
  Ed25519Program,
  SystemProgram,
} from "@solana/web3.js";

import UserDashboard from "../components/UserDashboard";
import logo from "./image.png";

const WalletButton = dynamic(() => import("../components/WalletButton"), { ssr: false });

// ✅ IMPORTANT: update to your latest deployed program id
const PROGRAM_ID = new PublicKey("BtJDtqG3Zy25gZC43H7q1TXTqjoeSh4JBHVYiWzwd2cb");
const IX_SYSVAR = new PublicKey("Sysvar1nstructions1111111111111111111111111");
const CLUSTER = "devnet";

// ---------- byte helpers (browser-safe, no Buffer) ----------
function randBytes(n: number) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function writeI64LE(view: DataView, offset: number, value: bigint) {
  view.setBigInt64(offset, value, true);
}
async function sha256Bytes(data: string) {
  const enc = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", enc);
  return new Uint8Array(hash); // 32 bytes
}

// Create canonical JSON string (stable keys, stable formatting)
function canonicalizeJSON(obj: any): string {
  // Sort keys recursively
  function sortKeys(o: any): any {
    if (o === null || typeof o !== "object") {
      return o;
    }
    if (Array.isArray(o)) {
      return o.map(item => sortKeys(item));
    }
    const sorted: any = {};
    const keys = Object.keys(o).sort();
    for (const key of keys) {
      const value = o[key];
      sorted[key] = typeof value === "object" && value !== null
        ? sortKeys(value)
        : value;
    }
    return sorted;
  }
  return JSON.stringify(sortKeys(obj)); // Compact format, no spaces, stable ordering
}


// CPv1 payload = "CPv1" | user(32) | day(i64 LE) | sessionHash(32) | nonce(16) | expiresAt(i64 LE)
function buildPayloadBytes(
  userPk: PublicKey,
  day: bigint,
  sessionHash32: Uint8Array,
  nonce16: Uint8Array,
  expiresAt: bigint
) {
  const out = new Uint8Array(4 + 32 + 8 + 32 + 16 + 8);
  const view = new DataView(out.buffer);

  let o = 0;
  out.set(new TextEncoder().encode("CPv1"), o);
  o += 4;

  out.set(userPk.toBytes(), o);
  o += 32;

  writeI64LE(view, o, day);
  o += 8;

  out.set(sessionHash32, o);
  o += 32;

  out.set(nonce16, o);
  o += 16;

  writeI64LE(view, o, expiresAt);
  o += 8;

  return out;
}

// Anchor discriminator = sha256("global:<name>")[0..8]
async function discriminator(name: string) {
  const msg = new TextEncoder().encode(`global:${name}`);
  const hash = await crypto.subtle.digest("SHA-256", msg);
  return new Uint8Array(hash).slice(0, 8);
}

async function buildInitUserIx(user: PublicKey, userStatePda: PublicKey) {
  const disc = await discriminator("init_user"); // no args
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: user, isSigner: true, isWritable: true },
      { pubkey: userStatePda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc,
  });
}

function friendlyTxError(e: any) {
  const msg = String(e?.message ?? e);
  const logs: string[] = e?.logs ?? e?.transactionLogs ?? [];
  const haystack = [msg, ...logs].join("\n");

  if (haystack.includes("AlreadyClaimedToday") || haystack.includes("6001")) {
    return "✅ You already claimed today. Come back tomorrow for streak +1.";
  }
  if (haystack.toLowerCase().includes("blockhash not found")) {
    return "Network hiccup (blockhash expired). Try again.";
  }
  return msg;
}

function explorerTx(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=${CLUSTER}`;
}

type FeedEvent = {
  t: number;
  msg: string;
  sig?: string;
};

function shortSig(sig: string) {
  return sig.length > 10 ? `${sig.slice(0, 4)}…${sig.slice(-4)}` : sig;
}

export default function Home() {
  type CvStatus = {
    running: boolean;
    toothbrush_visible: boolean;
    confidence: number;
    required_sec: number;
    grace_sec: number;
    accumulated_sec: number;
    progress: number;
    proof: any | null;
  };
  
  const cvUrl = useMemo(() => process.env.NEXT_PUBLIC_CV_URL ?? "http://127.0.0.1:5001", []);
  const [cv, setCv] = useState<CvStatus | null>(null);
  const [cvError, setCvError] = useState<string>("");
  
  const wallet = useWallet();
  const { connection } = useConnection();

  const [receipt, setReceipt] = useState<any>(null);
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [sessionHash, setSessionHash] = useState<string>("");
  const [proofWithWallet, setProofWithWallet] = useState<any>(null);

  // Dashboard refresh trigger (still useful if you want manual bump)
  const [dashboardRefreshNonce, setDashboardRefreshNonce] = useState(0);

  // Live activity feed
  const [feed, setFeed] = useState<FeedEvent[]>([]);

  function pushEvent(msg: string, sig?: string) {
    setFeed((prev) => [{ t: Date.now(), msg, sig }, ...prev].slice(0, 12));
  }
  async function cvStart() {
    setCvError("");
    try {
      await fetch(`${cvUrl}/api/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ required_sec: 20.0, grace_sec: 0.75 }),
      });
    } catch (e: any) {
      setCvError(String(e?.message ?? e));
    }
  }
  
  async function cvStop() {
    setCvError("");
    try {
      await fetch(`${cvUrl}/api/stop`, { method: "POST" });
    } catch (e: any) {
      setCvError(String(e?.message ?? e));
    }
  }
  
  async function cvRefresh() {
    try {
      const r = await fetch(`${cvUrl}/api/status`, { cache: "no-store" });
      const j = await r.json();
      setCv(j);
    } catch (e: any) {
      // don’t spam; just store once
      setCvError((prev) => prev || String(e?.message ?? e));
    }
  }
  
  useEffect(() => {
    cvRefresh();
    const id = setInterval(cvRefresh, 300);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Compute sessionHash when proof is ready
  useEffect(() => {
    async function computeHash() {
      if (cv?.proof && wallet.publicKey) {
        // Add wallet to proof object
        const proof = {
          ...cv.proof,
          wallet: wallet.publicKey.toBase58(),
        };
        setProofWithWallet(proof);
        
        // Create canonical JSON string
        const canonicalJson = canonicalizeJSON(proof);
        
        // SHA-256 hash
        const hashBytes = await sha256Bytes(canonicalJson);
        const hashHex = bytesToHex(hashBytes);
        setSessionHash(hashHex);
        
        // Log to console
        console.log("proof", JSON.stringify(proof, null, 2));
        console.log("sessionHash", hashHex);
      } else {
        setProofWithWallet(null);
        setSessionHash("");
      }
    }
    computeHash();
  }, [cv?.proof, wallet.publicKey]);
  

  // Live program logs (wow factor)
  useEffect(() => {
    const subIdPromise = connection.onLogs(
      PROGRAM_ID,
      (logInfo) => {
        pushEvent("Program logs emitted", logInfo.signature);
      },
      "confirmed"
    );

    return () => {
      Promise.resolve(subIdPromise).then((subId: any) => {
        if (typeof subId === "number") connection.removeOnLogsListener(subId);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection]);

  // If you proxied via Next API route, switch to fetch("/api/oracle-sign")
  const oracleUrl = useMemo(() => "http://127.0.0.1:8787", []);

  // ✅ isDev selects between claim_brush (streak) and claim_brush_dev (unlimited testing)
  async function claimOnChain(isDev = false) {
    setError("");
    setStatus("");
    setReceipt(null);

    if (!wallet.publicKey || !wallet.signTransaction) {
      setError("Connect Phantom first.");
      return;
    }

    // --- 1) Build session request ---
    const now = Math.floor(Date.now() / 1000);
    const dayNum = Math.floor(now / 86400);
    const expiresAt = now + 120;

    if (!cv?.proof || !wallet.publicKey) {
      setError("Run the brush detector until proof is ready (20s) before claiming.");
      return;
    }
    
    // Create proof with wallet
    const proof = {
      ...cv.proof,
      wallet: wallet.publicKey.toBase58(),
    };
    
    // Derive sessionHash from canonical JSON (stable + binds claim to CV result)
    const canonicalJson = canonicalizeJSON(proof);
    const sessionHash = await sha256Bytes(canonicalJson); // 32 bytes
    
    const nonce = randBytes(16);

    const reqBody = {
      user: wallet.publicKey.toBase58(),
      day: dayNum,
      sessionHash: bytesToHex(sessionHash),
      nonce: bytesToHex(nonce),
      expiresAt,
      // optional: tell your oracle you want dev mode (if you want)
      // mode: isDev ? "dev" : "prod",
    };

    // --- 2) Ask oracle to sign ---
    setStatus("Requesting oracle signature...");
    pushEvent("Requesting oracle signature…");
    let json: any;
    try {
      const resp = await fetch(`${oracleUrl}/oracle/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      json = await resp.json();
      if (!resp.ok) {
        setError(json?.error ?? "Oracle request failed");
        pushEvent("Oracle request failed");
        return;
      }
    } catch (e: any) {
      setError(`Oracle unreachable: ${String(e?.message ?? e)}`);
      pushEvent("Oracle unreachable");
      return;
    }

    const oraclePubkey = new PublicKey(json.oraclePubkey);
    const sig = b64ToBytes(json.sigB64); // 64 bytes
    const payloadFromOracle = b64ToBytes(json.payloadB64);

    // --- 3) Rebuild payload locally and ensure it matches oracle ---
    const payloadLocal = buildPayloadBytes(
      wallet.publicKey,
      BigInt(dayNum),
      sessionHash,
      nonce,
      BigInt(expiresAt)
    );

    if (bytesToB64(payloadLocal) !== bytesToB64(payloadFromOracle)) {
      setError("Payload mismatch between client and oracle (serialization bug).");
      pushEvent("Payload mismatch (client vs oracle)");
      return;
    }

    setReceipt({ request: reqBody, response: json });
    pushEvent("Oracle receipt verified locally ✅");

    // --- 4) Derive PDAs ---
    const enc = new TextEncoder();

    const [userStatePda] = PublicKey.findProgramAddressSync(
      [enc.encode("user"), wallet.publicKey.toBytes()],
      PROGRAM_ID
    );

    const [claimPda] = PublicKey.findProgramAddressSync(
      [enc.encode("claim"), wallet.publicKey.toBytes(), nonce],
      PROGRAM_ID
    );

    // Check if user_state exists; if not, add init_user ix
    const userStateInfo = await connection.getAccountInfo(userStatePda);
    const needInitUser = !userStateInfo;
    pushEvent(needInitUser ? "UserState missing → will init_user" : "UserState exists");

    // --- 5) Build ed25519 verify instruction (must be BEFORE claim) ---
    const edIx = Ed25519Program.createInstructionWithPublicKey({
      publicKey: oraclePubkey.toBytes(),
      message: payloadLocal,
      signature: sig,
    });

    // --- 6) Build program instruction data for claim_brush / claim_brush_dev ---
    // Layout: disc[8] | day(i64 LE) | session_hash[32] | nonce[16] | expires_at(i64 LE) | sig[64]
    const disc = await discriminator(isDev ? "claim_brush_dev" : "claim_brush");

    const data = new Uint8Array(8 + 8 + 32 + 16 + 8 + 64);
    const view = new DataView(data.buffer);

    let off = 0;
    data.set(disc, off);
    off += 8;

    writeI64LE(view, off, BigInt(dayNum));
    off += 8;

    data.set(sessionHash, off);
    off += 32;

    data.set(nonce, off);
    off += 16;

    writeI64LE(view, off, BigInt(expiresAt));
    off += 8;

    data.set(sig, off);
    off += 64;

    const claimIx = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: [
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: userStatePda, isSigner: false, isWritable: true },
        { pubkey: claimPda, isSigner: false, isWritable: true },
        { pubkey: IX_SYSVAR, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    // --- 7) Build tx (init_user if needed), then ed25519 verify, then claim ---
    setStatus(needInitUser ? "Initializing user (first time)..." : "Building transaction...");
    pushEvent("Building transaction…");

    const tx = new Transaction();
    if (needInitUser) {
      const initIx = await buildInitUserIx(wallet.publicKey, userStatePda);
      tx.add(initIx);
    }

    tx.add(edIx, claimIx);
    tx.feePayer = wallet.publicKey;

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    tx.recentBlockhash = blockhash;

    // --- 8) Sign, send, confirm ---
    setStatus("Signing with Phantom...");
    pushEvent("Signing with Phantom…");
    let signed: Transaction;
    try {
      signed = await wallet.signTransaction(tx);
    } catch (e: any) {
      setError(`Signing cancelled: ${String(e?.message ?? e)}`);
      pushEvent("Signing cancelled");
      return;
    }

    setStatus("Sending transaction...");
    pushEvent("Sending transaction…");
    let sigTx: string;
    try {
      sigTx = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    } catch (e: any) {
      setError(friendlyTxError(e));
      pushEvent("Send failed");
      return;
    }

    setStatus(`Submitted: ${sigTx} (confirming...)`);
    pushEvent("Submitted", sigTx);

    try {
      await connection.confirmTransaction(
        { signature: sigTx, blockhash, lastValidBlockHeight },
        "confirmed"
      );
    } catch (e: any) {
      setError(`Confirm failed: ${String(e?.message ?? e)}`);
      pushEvent("Confirm failed", sigTx);
      return;
    }

    setStatus(`Confirmed ✅ ${sigTx}`);
    pushEvent("Confirmed ✅", sigTx);

    setDashboardRefreshNonce((n) => n + 1);
    const cvUrl = process.env.NEXT_PUBLIC_CV_URL ?? "http://127.0.0.1:5001";

  }

  return (
    <main style={{ padding: 24, fontFamily: "ui-sans-serif, system-ui", color: "#0a0a0a" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16 }}>
        <img src={logo.src} alt="CavityProof" style={{ width: 80, height: 80, borderRadius: 12 }} />
        <h1 style={{ fontSize: 28, fontWeight: 700, color: "#0a0a0a" }}>CavityProof</h1>
      </div>
      <p style={{ marginTop: 8, opacity: 0.9, textAlign: "center" }}>
        Phase 4: Oracle-enforced claim (ed25519 verify + nonce replay protection)
      </p>

      <div style={{ maxWidth: "1400px", margin: "16px auto 0", border: "1px solid #333", borderRadius: 14, padding: 12 }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center", flexWrap: "wrap" }}>
          <WalletButton />
          <button
            onClick={() => claimOnChain(false)}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ccc",
              cursor: "pointer",
            }}
          >
            Claim on-chain (streak)
          </button>
          <button
            onClick={() => claimOnChain(true)}
            style={{
              padding: "10px 14px",
              borderRadius: 10,
              border: "1px solid #ccc",
              cursor: "pointer",
            }}
          >
            DEV Claim (unlimited)
          </button>
        </div>
        {status && <pre style={{ marginTop: 12, textAlign: "center" }}>{status}</pre>}
        {error && <pre style={{ marginTop: 12, color: "crimson", textAlign: "center" }}>{error}</pre>}
      </div>

      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", marginTop: 16, justifyContent: "center", maxWidth: "1400px", margin: "16px auto 0" }}>
        <div style={{ border: "1px solid #333", borderRadius: 14, padding: 12, flex: "1 1 0", minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 8, color: "#0a0a0a" }}>Video Stream</div>
          <img
            src="http://127.0.0.1:5001/api/stream"
            alt="stream"
            style={{ width: "100%", borderRadius: 8 }}
          />
        </div>

        {/* ✅ CV Detector panel */}
        <div style={{ border: "1px solid #333", borderRadius: 14, padding: 12, flex: "1 1 0", minWidth: 0 }}>
        <div style={{ fontWeight: 600, marginBottom: 8, color: "#0a0a0a" }}>Toothbrush Detector</div>

        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
          <button
            onClick={cvStart}
            style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
          >
            Start detector
          </button>
          <button
            onClick={cvStop}
            style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #ccc", cursor: "pointer" }}
          >
            Stop detector
          </button>
          {cv?.running ? <span>Running ✅</span> : <span>Stopped</span>}
        </div>

        {cvError && <div style={{ color: "crimson", fontFamily: "monospace", fontSize: 12 }}>{cvError}</div>}

        {cv ? (
          <>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <div>
                Status:{" "}
                <b style={{ color: cv.toothbrush_visible ? "limegreen" : "tomato" }}>
                  {cv.toothbrush_visible ? "Detected ✅" : "Not detected ❌"}
                </b>
              </div>
              <div style={{ fontFamily: "monospace", fontSize: 12, opacity: 0.95 }}>
                conf: {cv.confidence.toFixed(2)} | grace: {cv.grace_sec}s
              </div>
            </div>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontFamily: "monospace", fontSize: 12 }}>
                {cv.accumulated_sec.toFixed(2)}s / {cv.required_sec.toFixed(0)}s
              </div>
              <div style={{ height: 10, background: "#222", borderRadius: 999, overflow: "hidden", marginTop: 6 }}>
                <div style={{ height: "100%", width: `${Math.round(cv.progress * 100)}%`, background: "white" }} />
              </div>
            </div>

            {cv.proof && cv.running ? (
              <>
                <div style={{ marginTop: 10, color: "limegreen", fontWeight: 600 }}>
                  Proof ready ✅ You can claim now.
                </div>
                {proofWithWallet && sessionHash && wallet.publicKey ? (
                  <div style={{ marginTop: 16, border: "1px solid #444", borderRadius: 10, padding: 12, background: "#111" }}>
                    <div style={{ fontFamily: "monospace", fontSize: 12, color: "#0f0", whiteSpace: "pre-wrap", marginBottom: 12 }}>
                      {JSON.stringify(proofWithWallet, null, 2)}
                    </div>
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #333" }}>
                      <div style={{ fontSize: 11, opacity: 0.9, marginBottom: 4 }}>sessionHash</div>
                      <div style={{ fontFamily: "monospace", fontSize: 12, color: "#0ff", wordBreak: "break-all" }}>
                        {sessionHash}
                      </div>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div style={{ marginTop: 10, opacity: 0.9 }}>
                {cv?.running ? "Hold toothbrush in view until progress reaches 100%." : "Start the detector to begin."}
              </div>
            )}
          </>
        ) : (
          <div style={{ opacity: 0.9 }}>Loading detector status…</div>
        )}
        </div>
      </div>

      <div style={{ display: "flex", gap: 20, marginTop: 16, maxWidth: "1400px", margin: "16px auto 0" }}>
        {/* ✅ Live Activity feed */}
        <div style={{ flex: "1 1 0", minWidth: 0, border: "1px solid #333", borderRadius: 14, padding: 12, overflow: "hidden", display: "flex", flexDirection: "column" }}>
          <div style={{ fontWeight: 600, marginBottom: 8, color: "#0a0a0a", flexShrink: 0 }}>Live Activity</div>
          {feed.length === 0 ? (
            <div style={{ opacity: 0.9 }}>No events yet.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowY: "auto", maxHeight: 200, wordBreak: "break-all" }}>
              {feed.map((e) => (
                <div key={e.t} style={{ fontFamily: "monospace", fontSize: 12, opacity: 1 }}>
                  {new Date(e.t).toLocaleTimeString()} — {e.msg}{" "}
                  {e.sig ? (
                    <a
                      href={explorerTx(e.sig)}
                      target="_blank"
                      rel="noreferrer"
                      style={{ textDecoration: "underline" }}
                    >
                      {shortSig(e.sig)}
                    </a>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* ✅ On-chain dashboard (live via websocket + refreshNonce fallback) */}
        <div style={{ flex: "1 1 0", minWidth: 0 }}>
          <UserDashboard refreshNonce={dashboardRefreshNonce} />
        </div>
      </div>

      {receipt && (
        <div style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>Receipt</h2>
          <pre
            style={{
              marginTop: 8,
              padding: 12,
              background: "#111",
              color: "#0f0",
              borderRadius: 10,
              overflowX: "auto",
            }}
          >
            {JSON.stringify(receipt, null, 2)}
          </pre>
        </div>
      )}
    </main>
  );
}
