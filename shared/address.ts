import { isAddress } from "viem";

const EVM_CHAINS = new Set(["eth", "arb", "base", "op", "pol", "bsc", "avax", "gnosis"]);
const BASE58 = "[1-9A-HJ-NP-Za-km-z]";
// Same rule as the sign-in normalisation in server/auth.ts.
const NEAR_ACCOUNT = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

export function validDestination(chain: string, address: string): boolean {
  if (EVM_CHAINS.has(chain))
    return (
      isAddress(address, { strict: true }) &&
      !/^0x0{40}$/i.test(address)
    );
  switch (chain) {
    case "near":
      if (/^0x[a-fA-F0-9]{40}$/.test(address)) return false;
      return (
        /^[a-f0-9]{64}$/.test(address) ||
        /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(address)
      );
    case "sol":
      return new RegExp(`^${BASE58}{32,44}$`).test(address);
    case "btc":
      return (
        /^bc1[02-9ac-hj-np-z]{11,87}$/.test(address) ||
        new RegExp(`^[13]${BASE58}{24,33}$`).test(address)
      );
    case "tron":
      return new RegExp(`^T${BASE58}{33}$`).test(address);
    default:
      return false;
  }
}

/** Chains we can validate a refund address for (and so can refund to). */
export function supportedChain(chain: string): boolean {
  return EVM_CHAINS.has(chain) || ["near", "sol", "btc", "tron"].includes(chain);
}

/**
 * Account id inside intents.near for an INTENTS recipient: a NEAR account id (named or implicit) or a
 * lowercase EVM address (intents.near ids EVM accounts by the lowercase address).
 */
export function validIntentsAccount(account: string): boolean {
  // Anything 0x-prefixed must be a full lowercase EVM address, never a look-alike NEAR name.
  if (/^0x/i.test(account)) return /^0x[0-9a-f]{40}$/.test(account) && !/^0x0{40}$/.test(account);
  return account.length >= 2 && account.length <= 64 && NEAR_ACCOUNT.test(account);
}
