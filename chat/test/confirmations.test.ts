import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  AccountRole,
  generateKeyPairSigner,
  type Signature,
} from "@solana/kit";
import { Transport } from "../src/chain/transport.ts";

test("parallel confirmations share capped RPC batches and preserve signature order", async () => {
  const transport = new Transport();
  let calls = 0;
  Object.defineProperty(transport, "rpc", {
    value: {
      getSignatureStatuses: (signatures: Signature[]) => ({
        send: async () => {
          calls++;
          assert(signatures.length <= 256);
          return {
            value: signatures.map((signature) => {
              const i = Number(signature.split("-")[1]);
              return i === 7 ? null : { slot: BigInt(i), signature };
            }),
          };
        },
      }),
    },
  });
  const result = await Promise.all(
    Array.from({ length: 300 }, (_, i) =>
      transport.status(`signature-${i}` as Signature),
    ),
  );
  assert.equal(calls, 2);
  assert.equal(result[7], null);
  result.forEach((status, i) => {
    if (i !== 7) assert.equal(status?.slot, BigInt(i));
  });
});

test("failed batched polls reject every waiter and permit the next poll", async () => {
  const transport = new Transport();
  let fail = true;
  Object.defineProperty(transport, "rpc", {
    value: {
      getSignatureStatuses: (signatures: Signature[]) => ({
        send: async () => {
          if (fail) throw new Error("temporary RPC failure");
          return { value: signatures.map(() => null) };
        },
      }),
    },
  });
  const first = await Promise.allSettled(
    Array.from({ length: 16 }, (_, i) =>
      transport.status(`signature-${i}` as Signature),
    ),
  );
  assert(first.every((result) => result.status === "rejected"));
  fail = false;
  assert.equal(await transport.status("next" as Signature), null);
});

test("full model writes fit the activated 4096-byte v1 wire limit", async () => {
  const [payer, authority, weight, program] = await Promise.all(
    Array.from({ length: 4 }, () => generateKeyPairSigner()),
  );
  const transport = new Transport();
  Object.defineProperty(transport, "rpc", {
    value: {
      getLatestBlockhash: () => ({
        send: async () => ({
          value: {
            blockhash: "11111111111111111111111111111111",
            lastValidBlockHeight: 100n,
          },
        }),
      }),
    },
  });
  const instruction = {
    programAddress: program.address,
    accounts: [
      { address: weight.address, role: AccountRole.WRITABLE },
      {
        address: authority.address,
        role: AccountRole.READONLY_SIGNER,
        signer: authority,
      },
    ],
    data: new Uint8Array(5 + 3760),
  };
  const tx = await transport.sign(
    { payer, instruction },
    [instruction],
    20_000,
  );
  assert.equal(Buffer.from(tx.wire, "base64").length, 4089);
});
