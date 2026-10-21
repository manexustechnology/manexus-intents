import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TEST_CHAIN,
  payment,
  transaction,
  checkWallet,
  preflight,
  submitTestPayment,
  receiptState,
  type Provider,
} from "../src/testnet.ts";
const from = "0x1111111111111111111111111111111111111111",
  to = "0x2222222222222222222222222222222222222222",
  hash = "0x" + "a".repeat(64);
function mock(overrides: Record<string, unknown> = {}): {
  provider: Provider;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    provider: {
      async request({ method }) {
        calls.push(method);
        const responses: Record<string, unknown> = {
          eth_chainId: TEST_CHAIN,
          eth_accounts: [from],
          eth_getCode: "0x",
          eth_getBalance: "0xde0b6b3a7640000",
          eth_estimateGas: "0x5208",
          eth_gasPrice: "0x3b9aca00",
          eth_sendTransaction: hash,
          ...overrides,
        };
        return responses[method];
      },
    },
  };
}
test("test payments reject mainnet, zero addresses, precision and excessive test amounts", () => {
  assert.throws(() => payment(from, "0x" + "0".repeat(40), "0.1"));
  assert.throws(() => payment(from, to, "0.100000000000000001"));
  assert.throws(() => payment(from, to, "1e-3"));
  assert.throws(() => payment(from, to, "0.0000000000000000001"));
  assert.throws(() =>
    transaction({ ...payment(from, to, "0.001"), chainId: "0x1" } as never),
  );
  assert.equal(payment(from, to, "0.000000000000000001").value, "0x1");
});
test("wallet checks block all mainnet and wrong accounts", async () => {
  for (const chain of ["0x1", "0x2105", "0xa4b1"]) {
    const { provider, calls } = mock({ eth_chainId: chain });
    await assert.rejects(() =>
      submitTestPayment(provider, payment(from, to, "0.001")),
    );
    assert.ok(!calls.includes("eth_sendTransaction"));
  }
  await assert.rejects(() =>
    checkWallet(mock({ eth_accounts: [to] }).provider, from),
  );
});
test("preflight blocks insufficient funds and contract recipients", async () => {
  await assert.rejects(() =>
    preflight(
      mock({ eth_getBalance: "0x0" }).provider,
      payment(from, to, "0.001"),
    ),
  );
  await assert.rejects(() =>
    preflight(
      mock({ eth_getCode: "0x123" }).provider,
      payment(from, to, "0.001"),
    ),
  );
  assert.ok(
    (await preflight(mock().provider, payment(from, to, "0.001"))) > 0n,
  );
});
test("send constructs a testnet-only native transfer and validates hash", async () => {
  let tx: unknown;
  const { provider } = mock();
  const p: Provider = {
    async request(args) {
      if (args.method === "eth_sendTransaction") tx = args.params?.[0];
      return provider.request(args);
    },
  };
  assert.equal(await submitTestPayment(p, payment(from, to, "0.001")), hash);
  assert.deepEqual(tx, {
    from,
    to,
    value: "0x38d7ea4c68000",
    chainId: TEST_CHAIN,
    data: "0x",
  });
  await assert.rejects(() =>
    submitTestPayment(
      mock({ eth_sendTransaction: "bad" }).provider,
      payment(from, to, "0.001"),
    ),
  );
});
test("receipt confirmation requires matching hash and successful mined status", () => {
  assert.equal(receiptState(null, hash), "pending");
  assert.equal(
    receiptState(
      { transactionHash: hash, blockNumber: "0x1", status: "0x1" },
      hash,
    ),
    "confirmed",
  );
  assert.equal(
    receiptState(
      { transactionHash: hash, blockNumber: "0x1", status: "0x0" },
      hash,
    ),
    "reverted",
  );
  assert.throws(() =>
    receiptState(
      { transactionHash: "0xwrong", blockNumber: "0x1", status: "0x1" },
      hash,
    ),
  );
});
