"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getUserStatePda } from "../lib/solana/pdas";
import { formatHMS, secondsUntilNextUnixDay, unixDayNow } from "../lib/solana/time";

type UserStateVM = {
  wallet: string;
  userStatePda: string;
  exists: boolean;
  owner?: string;
  streak: number;
  totalClaims: number;
  lastDayClaimed: bigint;
  claimedToday: boolean;
  nextClaimInSec: number;
};

function shortPk(pk: string) {
  return pk.length > 10 ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : pk;
}

function readU32LE(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}
function readU64LE(view: DataView, offset: number): bigint {
  return view.getBigUint64(offset, true);
}
function readI64LE(view: DataView, offset: number): bigint {
  return view.getBigInt64(offset, true);
}

/**
 * Supports:
 * A) 56 bytes total: disc(8) + owner(32) + streak(u32) + last_day_claimed(i64) + total_claims(u32)
 * B) 64+ bytes total: disc(8) + owner(32) + streak(u64) + last_day_claimed(i64) + total_claims(u64)
 */
function decodeUserState(data: Uint8Array) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let o = 8; // skip discriminator

  if (data.length < o + 32) {
    throw new Error(`UserState too small: ${data.length} bytes (need at least 40)`);
  }

  const ownerBytes = data.slice(o, o + 32);
  const owner = new PublicKey(ownerBytes).toBase58();
  o += 32;

  const remaining = data.length - o;

  if (remaining === 16) {
    const streak = BigInt(readU32LE(view, o));
    o += 4;

    const lastDayClaimed = readI64LE(view, o);
    o += 8;

    const totalClaims = BigInt(readU32LE(view, o));
    o += 4;

    return { owner, streak, lastDayClaimed, totalClaims, layout: "u32/i64/u32" as const };
  }

  if (remaining >= 24) {
    const streak = readU64LE(view, o);
    o += 8;

    const lastDayClaimed = readI64LE(view, o);
    o += 8;

    const totalClaims = readU64LE(view, o);
    o += 8;

    return { owner, streak, lastDayClaimed, totalClaims, layout: "u64/i64/u64" as const };
  }

  throw new Error(
    `Unexpected UserState size: ${data.length} bytes (remaining after owner: ${remaining}). Expected remaining 16 or >=24.`
  );
}

export default function UserDashboard({ refreshNonce }: { refreshNonce: number }) {
  const { connection } = useConnection();
  const wallet = useWallet();
  const userPk = wallet.publicKey;

  const [vm, setVm] = useState<UserStateVM | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const subIdRef = useRef<number | null>(null);

  // countdown ticker
  useEffect(() => {
    const t = setInterval(() => {
      setVm((prev) =>
        prev
          ? {
              ...prev,
              nextClaimInSec: secondsUntilNextUnixDay(),
            }
          : prev
      );
    }, 1000);
    return () => clearInterval(t);
  }, []);

  const applyAccount = useMemo(() => {
    return (pda: PublicKey, data: Uint8Array) => {
      const decoded = decodeUserState(data);
      const today = unixDayNow();

      setVm({
        wallet: userPk!.toBase58(),
        userStatePda: pda.toBase58(),
        exists: true,
        owner: decoded.owner,
        streak: Number(decoded.streak),
        totalClaims: Number(decoded.totalClaims),
        lastDayClaimed: decoded.lastDayClaimed,
        claimedToday: decoded.lastDayClaimed === today,
        nextClaimInSec: secondsUntilNextUnixDay(),
      });

      setStatus("ready");
      setError(null);
    };
  }, [userPk]);

  const refresh = useMemo(() => {
    return async () => {
      if (!userPk) return;

      setStatus("loading");
      setError(null);

      try {
        const [pda] = getUserStatePda(userPk);
        const info = await connection.getAccountInfo(pda, "confirmed");
        const today = unixDayNow();

        if (!info?.data) {
          setVm({
            wallet: userPk.toBase58(),
            userStatePda: pda.toBase58(),
            exists: false,
            streak: 0,
            totalClaims: 0,
            lastDayClaimed: -1n,
            claimedToday: false,
            nextClaimInSec: secondsUntilNextUnixDay(),
          });
          setStatus("ready");
          return;
        }

        applyAccount(pda, info.data);
      } catch (e: any) {
        setStatus("error");
        setError(String(e?.message ?? e));
      }
    };
  }, [applyAccount, connection, userPk]);

  // initial + manual refresh bumps
  useEffect(() => {
    void refresh();
  }, [refresh, refreshNonce]);

  // LIVE websocket subscription to UserState PDA changes
  useEffect(() => {
    if (!userPk) return;

    const [pda] = getUserStatePda(userPk);

    // cleanup old
    if (subIdRef.current !== null) {
      connection.removeAccountChangeListener(subIdRef.current);
      subIdRef.current = null;
    }

    // subscribe
    const subId = connection.onAccountChange(
      pda,
      (info) => {
        try {
          if (!info?.data) return;
          applyAccount(pda, info.data);
        } catch (e: any) {
          setStatus("error");
          setError(String(e?.message ?? e));
        }
      },
      "confirmed"
    );

    subIdRef.current = subId;

    return () => {
      if (subIdRef.current !== null) {
        connection.removeAccountChangeListener(subIdRef.current);
        subIdRef.current = null;
      }
    };
  }, [applyAccount, connection, userPk]);

  if (!userPk) return null;

  return (
    <div style={{ border: "1px solid #333", borderRadius: 14, padding: 16, marginTop: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "start", gap: 12 }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 600 }}>Your CavityProof Account</div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4 }}>
            Wallet: <span style={{ fontFamily: "monospace" }}>{shortPk(userPk.toBase58())}</span>
          </div>
        </div>

        <button
          onClick={() => void refresh()}
          disabled={status === "loading"}
          style={{ padding: "8px 12px", borderRadius: 10, border: "1px solid #333" }}
        >
          {status === "loading" ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {status === "error" && (
        <div style={{ marginTop: 12, color: "salmon", whiteSpace: "pre-wrap" }}>{error}</div>
      )}

      {status !== "error" && vm && (
        <>
          <div style={{ marginTop: 12, fontSize: 13, opacity: 0.8 }}>
            UserState PDA: <span style={{ fontFamily: "monospace" }}>{shortPk(vm.userStatePda)}</span>
          </div>

          {!vm.exists ? (
            <div style={{ marginTop: 12, padding: 12, borderRadius: 12, border: "1px solid #333", opacity: 0.9 }}>
              No on-chain profile found yet. Make your first claim (your claim flow can also auto-init).
            </div>
          ) : (
            <>
              {vm.owner && (
                <div style={{ marginTop: 10, fontSize: 13, opacity: 0.8 }}>
                  Owner: <span style={{ fontFamily: "monospace" }}>{shortPk(vm.owner)}</span>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 12, marginTop: 14 }}>
                <Stat label="Streak" value={vm.streak} />
                <Stat label="Total Claims" value={vm.totalClaims} />
                <Stat label="Last Day Claimed" value={vm.lastDayClaimed.toString()} />
                <Stat
                  label="Claimed Today?"
                  value={
                    <span
                      style={{
                        padding: "4px 10px",
                        borderRadius: 999,
                        border: "1px solid #333",
                        background: vm.claimedToday ? "rgba(0,255,0,0.12)" : "rgba(255,255,255,0.06)",
                      }}
                    >
                      {vm.claimedToday ? "Yes ✅" : "No"}
                    </span>
                  }
                />
              </div>
            </>
          )}

          <div style={{ marginTop: 12, fontSize: 13, opacity: 0.85 }}>
            Next claim window in: <span style={{ fontFamily: "monospace" }}>{formatHMS(vm.nextClaimInSec)}</span>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: any }) {
  return (
    <div style={{ border: "1px solid #333", borderRadius: 12, padding: 12 }}>
      <div style={{ fontSize: 13, opacity: 0.8 }}>{label}</div>
      <div style={{ fontSize: 20, marginTop: 6 }}>{value}</div>
    </div>
  );
}
