export const SETTLEMENT_TOKENS: readonly {
  symbol: "USDC" | "USDT";
  tokenId: string;
  decimals: 6;
}[] = [
  {
    symbol: "USDC",
    tokenId: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    decimals: 6,
  },
  { symbol: "USDT", tokenId: "nep141:usdt.tether-token.near", decimals: 6 },
];

export function settlementToken(tokenId: string) {
  const t = SETTLEMENT_TOKENS.find((x) => x.tokenId === tokenId);
  if (!t) throw Error(`Unknown settlement token: ${tokenId}`);
  return t;
}
