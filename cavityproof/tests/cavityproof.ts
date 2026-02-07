import * as anchor from "@coral-xyz/anchor";
import BN from "bn.js";

describe("cavityproof", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.Cavityproof as any;

  it("initializes user and claims two consecutive days (streak increments)", async () => {
    const provider = anchor.getProvider() as anchor.AnchorProvider;
    const userPubkey = provider.wallet.publicKey;

    // Derive the UserState PDA: seeds = ["user", user_pubkey]
    const [userStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("user"), userPubkey.toBuffer()],
      program.programId
    );

    // init_user (idempotent: ignore "already in use" if PDA exists)
    try {
      await program.methods
        .initUser()
        .accounts({
          user: userPubkey,
          userState: userStatePda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
    } catch (err: any) {
      const msg = `${err}`;
      if (msg.includes("already in use") || msg.includes("Allocate: account")) {
        console.warn("⚠️ UserState already initialized, continuing");
      } else {
        throw err;
      }
    }

    // UTC day number
    const day = Math.floor(Date.now() / 1000 / 86400);

    // Claim day (skip if already claimed today from earlier runs)
    try {
      await program.methods
        .claimBrush(new BN(day))
        .accounts({
          user: userPubkey,
          userState: userStatePda,
        })
        .rpc();
    } catch (err: any) {
      const msg = `${err}`;
      if (msg.includes("Already claimed") || msg.includes("AlreadyClaimedToday")) {
        console.warn("⚠️ Already claimed for today previously, continuing");
      } else {
        throw err;
      }
    }

    // Claim day + 1 (should increment streak)
    await program.methods
      .claimBrush(new BN(day + 1))
      .accounts({
        user: userPubkey,
        userState: userStatePda,
      })
      .rpc();

    const userState = await program.account.userState.fetch(userStatePda);
    console.log("UserState after day+1:", userState);

    // If you've run before, streak may be > 2, so require >= 2
    if (userState.streak < 2) {
      throw new Error(`Expected streak >= 2, got ${userState.streak}`);
    }
  });
});
