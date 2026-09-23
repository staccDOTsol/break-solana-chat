import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import {
  descriptor,
  epochData,
  LANES,
  parallel,
  stride,
  tensorFor,
  tileChunk,
  total,
  type Header,
  type Shard,
} from "./layout.ts";

export const TESTNET_GENESIS = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";
export type SessionKeys = {
  authority: KeyPairSigner;
  state: string;
  workers: string[];
  payers: KeyPairSigner[];
};
export type Deployment = {
  program: string;
  registry: string;
  shards: Shard[];
  genesis: string;
};
export type Work = {
  payer: KeyPairSigner;
  instruction: Instruction;
  lane?: number;
  parts?: Instruction[];
};
const ro = (key: string) => ({
  address: address(key),
  role: AccountRole.READONLY,
});
const rw = (key: string) => ({
  address: address(key),
  role: AccountRole.WRITABLE,
});
const signer = (key: KeyPairSigner) => ({
  address: key.address,
  role: AccountRole.READONLY_SIGNER,
  signer: key,
});

export function workFor(
  h: Header,
  session: SessionKeys,
  deployment: Deployment,
): Work[] {
  if (session.workers.length !== LANES || session.payers.length !== LANES)
    throw new Error("Sixteen independent work lanes are required");
  if (
    new Set(session.payers.map((p) => p.address)).size !== LANES ||
    session.payers.some((p) => p.address === session.authority.address)
  )
    throw new Error("Each lane needs an independent fee payer");
  if (new Set(session.workers).size !== LANES)
    throw new Error("Each lane needs an independent writable worker");
  if (deployment.genesis !== TESTNET_GENESIS)
    throw new Error("This experiment is restricted to testnet");
  const programAddress = address(deployment.program);
  const shardMeta = (d: number | undefined) =>
    d === undefined ? [] : [ro(deployment.shards[d].address)];
  if (!parallel(h.phase)) {
    const d = descriptor(deployment.shards, tensorFor(h));
    return [
      {
        payer: session.authority,
        instruction: {
          programAddress,
          accounts: [
            rw(session.state),
            signer(session.authority),
            ro(deployment.registry),
            ...shardMeta(d),
          ],
          data: epochData(3, h.epoch, d ?? 0),
        },
      },
    ];
  }
  const count = Math.min(
    LANES,
    Math.ceil((total(h) - h.cursor) / stride(h.phase)),
  );
  return Array.from({ length: count }, (_, lane) => {
    const d = descriptor(
      deployment.shards,
      tensorFor(h, h.cursor + lane * stride(h.phase)),
    );
    const base = epochData(4, h.epoch, d ?? 0);
    const count = Math.min(
      stride(h.phase),
      total(h) - h.cursor - lane * stride(h.phase),
    );
    const parts: Instruction[] = Array.from(
      { length: Math.ceil(count / tileChunk(h.phase)) },
      (_, index) => {
        const data = new Uint8Array(9);
        data.set(base);
        new DataView(data.buffer).setUint16(
          7,
          index * tileChunk(h.phase),
          true,
        );
        return {
          programAddress,
          accounts: [
            ro(session.state),
            rw(session.workers[lane]),
            signer(session.authority),
            ro(deployment.registry),
            ...shardMeta(d),
          ],
          data,
        };
      },
    );
    return { payer: session.payers[lane], lane, instruction: parts[0], parts };
  });
}
export function mergeFor(
  h: Header,
  session: SessionKeys,
  deployment: Deployment,
): Work {
  const count = Math.min(
    LANES,
    Math.ceil((total(h) - h.cursor) / stride(h.phase)),
  );
  return {
    payer: session.authority,
    instruction: {
      programAddress: address(deployment.program),
      accounts: [
        rw(session.state),
        signer(session.authority),
        ro(deployment.registry),
        ...session.workers.slice(0, count).map(ro),
      ],
      data: epochData(5, h.epoch),
    },
  };
}
export class Transport {
  readonly rpc;
  constructor(url = "https://api.testnet.solana.com") {
    this.rpc = createSolanaRpc(url);
  }
  async checkNetwork() {
    if ((await this.rpc.getGenesisHash().send()) !== TESTNET_GENESIS)
      throw new Error("RPC is not Solana testnet");
    const gate = await this.rpc
      .getAccountInfo(address("txv1aq4pp281K9um3tnPgkfX8UqtFT6wcVW3hNezGLL"), {
        encoding: "base64",
      })
      .send();
    if (!gate.value)
      throw new Error("Transaction v1 activation could not be verified");
    const bytes = Uint8Array.from(atob(gate.value.data[0]), (c) =>
      c.charCodeAt(0),
    );
    if (bytes[0] !== 1) throw new Error("Transaction v1 is not active");
  }
  async sign(
    work: Work,
    instructions: Instruction[] = [work.instruction],
    computeUnitLimit = 1_400_000,
  ) {
    const { value: lifetime } = await this.rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    const message = pipe(
      createTransactionMessage({ version: 1 }),
      (m) => setTransactionMessageFeePayerSigner(work.payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
      (m) =>
        setTransactionMessageConfig(
          {
            computeUnitLimit,
            heapSize: 256 * 1024,
            loadedAccountsDataSizeLimit: 64 * 1024 * 1024,
            priorityFeeLamports: 0n,
          },
          m,
        ),
    );
    const tx = await signTransactionMessageWithSigners(message);
    return {
      wire: getBase64EncodedWireTransaction(tx),
      signature: getSignatureFromTransaction(tx),
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
    };
  }
  async submit(signed: Awaited<ReturnType<Transport["sign"]>>) {
    // Retry the same signed wire bytes after transport uncertainty. Resigning
    // changes the transaction identity; callers must resolve expiry first.
    await this.rpc
      .sendTransaction(signed.wire, {
        encoding: "base64",
        skipPreflight: false,
        maxRetries: 3n,
        preflightCommitment: "confirmed",
      })
      .send();
    return signed.signature;
  }
}

export async function sendConfirmed(
  transport: Transport,
  work: Work,
  signal?: AbortSignal,
  onReceipt?: (signature: string) => void,
) {
  const signed = await transport.sign(work);
  let submitError: unknown;
  try {
    await transport.submit(signed);
  } catch (error) {
    submitError = error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    signal?.throwIfAborted();
    const result = await transport.rpc
      .getSignatureStatuses([signed.signature], {
        searchTransactionHistory: true,
      })
      .send();
    const status = result.value[0];
    if (status?.err)
      throw new Error(
        `Transaction ${signed.signature} failed: ${JSON.stringify(status.err)}`,
      );
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      onReceipt?.(signed.signature);
      return status.slot;
    }
    if (
      (await transport.rpc.getBlockHeight({ commitment: "confirmed" }).send()) >
      signed.lastValidBlockHeight
    )
      throw new Error(
        `Transaction ${signed.signature} expired or is unresolved. Resume from on-chain state.`,
      );
    if (attempt % 8 === 7) {
      try {
        await transport.submit(signed);
      } catch (error) {
        submitError = error;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Transaction confirmation is unresolved: ${signed.signature}. ${String(submitError ?? "")}`,
  );
}
