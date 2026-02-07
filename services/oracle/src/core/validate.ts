import { SignInput } from "./payload";

export function validateSignInput(input: SignInput) {
  const now = Math.floor(Date.now() / 1000);

  if (!input.user) throw new Error("user is required");
  if (!Number.isFinite(input.day)) throw new Error("day must be a number");
  if (!Number.isFinite(input.expiresAt)) throw new Error("expiresAt must be a number");

  // expiresAt must be soon-ish to prevent replay of oracle signatures
  if (input.expiresAt < now) throw new Error("expiresAt is in the past");
  if (input.expiresAt > now + 180) throw new Error("expiresAt too far in the future (max 180s)");
}
