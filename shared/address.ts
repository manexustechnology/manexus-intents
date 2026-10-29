import { isAddress } from "viem";

const EVM_CHAINS = new Set(["eth", "arb", "base", "op", "pol", "bsc", "avax", "gnosis"]);
const BASE58 = "[1-9A-HJ-NP-Za-km-z]";

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
