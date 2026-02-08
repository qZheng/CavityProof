import { PublicKey } from "@solana/web3.js";
import { PROGRAM_ID } from "./constants";

const enc = new TextEncoder();

export function getUserStatePda(user: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([enc.encode("user"), user.toBytes()], PROGRAM_ID);
}
