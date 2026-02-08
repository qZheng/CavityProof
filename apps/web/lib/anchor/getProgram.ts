import { AnchorProvider, Idl, Program } from "@coral-xyz/anchor";
import { Connection } from "@solana/web3.js";
import idl from "../../idl/cavityproof.json";
import { PROGRAM_ID } from "../solana/constants";

export function getProgram(connection: Connection, wallet: any) {
  const provider = new AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program(idl as Idl, PROGRAM_ID, provider);
}
