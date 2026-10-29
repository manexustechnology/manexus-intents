export function validAmount(value: string, decimals = 8): boolean {
  return (
    /^(0|[1-9]\d*)(\.\d+)?$/.test(value) &&
    value.length <= 32 &&
    Number(value) > 0 &&
    Number(value) <= 1e12 &&
    (value.split(".")[1]?.length ?? 0) <= decimals
  );
}

export function baseUnits(amount: string, decimals: number): bigint {
  if (!validAmount(amount, decimals))
    throw Error("Enter a valid positive amount.");
  const [whole, fraction = ""] = amount.split(".");
  return (
    BigInt(whole) * 10n ** BigInt(decimals) +
    BigInt(fraction.padEnd(decimals, "0") || "0")
  );
}

export function formatAmount(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = (abs % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? "." + fraction : ""}`;
}
