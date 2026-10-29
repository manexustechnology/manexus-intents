// Browser half of every outbound transfer (withdraw, swap, bill, payroll): sign the exact
// 1Click-generated intent the server stored for a quote in the owner's wallet, then hand only the
// signature back to /api/transfers/submit. Named NEAR accounts first register their wallet key on
// intents.near (docs/NEAR-INTENTS.md); EVM accounts sign ERC-191.
import { erc191SignedData, nep413SignArgs, nep413SignedData, type Nep413Payload } from "../shared/intent-sign.ts";
import type { TransferView } from "../server/transfers.ts";
import { api, postJson } from "./api.ts";
import { ensureWallet, nearPublicKey, registerIntentsKey, signErc191, signNep413, type NearWalletId, type Session } from "./wallet/index.ts";

export type { TransferView };
export type SignStep = "key" | "sign" | "submit";
export type SignableQuote = { depositAddress: string; intent: { standard: "nep413" | "erc191"; payload: unknown } };
export type SignOptions = {
  nearWallet?: NearWalletId;
  /**
   * The NEAR wallet key must be registered on intents.near before its signature is accepted. Resolve once
   * the key is registered (typically after the user approves `registerKey`), reject to cancel. Without
   * this hook the registration transaction is requested right away.
   */
  confirmKeyRegistration?: (publicKey: string) => Promise<void>;
};

/** Whether intents.near accepts NEP-413 signatures from `publicKey` for the signed-in account. */
export async function keyRegistered(publicKey: string): Promise<boolean> {
  const st = await api<{ registered: boolean }>(`/api/transfers/key-status?publicKey=${encodeURIComponent(publicKey)}`);
  return st.registered === true;
}

/** Ask the wallet to call intents.near `add_public_key`, then report whether the key is now registered. */
export async function registerKey(publicKey: string): Promise<boolean> {
  await registerIntentsKey(publicKey);
  return keyRegistered(publicKey);
}

async function defaultConfirm(publicKey: string): Promise<void> {
  if (!(await registerKey(publicKey))) throw new Error("The key is not registered yet. Wait a few seconds and try again.");
}

/**
 * Sign `quote.intent` with the session's wallet and submit it. `onStep` reports progress: "key" when a key
 * registration is needed, "sign" while the wallet is asked to sign, "submit" while the signature is relayed.
 * Throws on any wallet or server error; nothing is submitted unless the signature was produced.
 */
export async function signAndSubmit<T = TransferView>(
  quote: SignableQuote,
  session: Session,
  onStep: (s: SignStep) => void,
  opts: SignOptions = {},
): Promise<T> {
  const confirm = opts.confirmKeyRegistration ?? defaultConfirm;
  const ensureKey = async (publicKey: string) => {
    if (await keyRegistered(publicKey)) return;
    onStep("key");
    await confirm(publicKey);
  };
  await ensureWallet(session, opts.nearWallet);
  let signedData: unknown;
  if (quote.intent.standard === "erc191") {
    if (typeof quote.intent.payload !== "string") throw new Error("Invalid intent payload.");
    onStep("sign");
    signedData = erc191SignedData(quote.intent.payload, await signErc191(quote.intent.payload));
  } else if (quote.intent.standard === "nep413") {
    const payload = quote.intent.payload as Nep413Payload;
    // Register before signing when the wallet reports its key; otherwise check the key that signed.
    const known = await nearPublicKey();
    if (known) await ensureKey(known);
    onStep("sign");
    const signed = await signNep413(nep413SignArgs(payload));
    if (signed.publicKey !== known) await ensureKey(signed.publicKey);
    signedData = nep413SignedData(payload, signed);
  } else {
    throw new Error("Unsupported signature standard.");
  }
  onStep("submit");
  return postJson<T>("/api/transfers/submit", { depositAddress: quote.depositAddress, signedData });
}
