import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  createSolanaRpc,
  createDefaultRpcTransport,
  createSolanaRpcFromTransport,
  type RpcTransport,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageConfig,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type Signature,
  type GetSignatureStatusesApi,
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
import { createRacingRpcTransport, rpcErrorText } from "./rpc-race.ts";
import { TESTNET_GENESIS, TESTNET_RPC } from "./network.ts";

export { TESTNET_GENESIS, TESTNET_RPC } from "./network.ts";
export type SessionKeys = {
  authority: KeyPairSigner;
  state: string;
  workers: string[];
  payers: KeyPairSigner[];
  sliceWorkers?: string[];
  slicePayers?: KeyPairSigner[];
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
  batch?: Instruction[];
};
export function interleaveSlices(work: Work[]): Work[] {
  const depth = Math.max(0, ...work.map(item => item.parts?.length ?? 1));
  return Array.from({ length: depth }, (_, part) => work.flatMap(item => {
    const instruction = item.parts ? item.parts[part] : part === 0 ? item.instruction : undefined;
    return instruction ? [{ ...item, instruction }] : [];
  })).flat();
}
export const independentMatrix = (h: Header, session: SessionKeys) => !!session.sliceWorkers && [3, 6, 8, 10, 13].includes(h.phase);
type Confirmation = ReturnType<
  GetSignatureStatusesApi["getSignatureStatuses"]
>["value"][number];
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
  expectedGenesis = TESTNET_GENESIS,
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
  if (deployment.genesis !== expectedGenesis)
    throw new Error("Deployment genesis does not match the configured chain");
  const programAddress = address(deployment.program);
  const shardMeta = (d: number | undefined) =>
    d === undefined ? [] : [ro(deployment.shards[d].address)];
  if (!parallel(h.phase)) {
    const d = descriptor(deployment.shards, tensorFor(h));
    const work: Work[] = [
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
    const pair = ([2, 12].includes(h.phase) && h.cursor < 4) ||
      (h.phase === 7 && h.cursor > 0 && h.cursor < 4) ||
      (h.phase === 15 && h.cursor < 3072) || (h.phase === 16 && h.cursor < 11264);
    if (pair) work[0].batch = [work[0].instruction, { ...work[0].instruction, data: epochData(3, h.epoch + 1, d ?? 0) }];
    return work;
  }
  const count = Math.min(
    LANES,
    Math.ceil((total(h) - h.cursor) / stride(h.phase)),
  );
  if (independentMatrix(h, session)) {
    if (session.sliceWorkers?.length !== 256 || session.slicePayers?.length !== 256)
      throw new Error("Independent matrix work requires 256 slice accounts and fee payers");
    const writable = [...session.sliceWorkers, ...session.slicePayers.map(p => p.address)];
    if (new Set(writable).size !== 512 || writable.includes(session.authority.address) || writable.includes(session.state))
      throw new Error("Slice accounts and fee payers must have disjoint writable addresses");
    const result: Work[] = [];
    for (let part = 0; part < Math.ceil(128 / tileChunk(h.phase)); part++) for (let lane = 0; lane < count; lane++) {
      const row = h.cursor + lane * 128, n = Math.min(128, total(h) - row);
      if (part * tileChunk(h.phase) >= n) continue;
      const d = descriptor(deployment.shards, tensorFor(h, row));
      const data = new Uint8Array(9); data.set(epochData(8, h.epoch, d ?? 0));
      new DataView(data.buffer).setUint16(7, part * tileChunk(h.phase), true);
      const index = lane * 16 + part;
      result.push({ payer: session.slicePayers![index], lane, instruction: {
        programAddress, accounts: [ro(session.state), rw(session.sliceWorkers![index]), signer(session.authority), ro(deployment.registry), ...shardMeta(d)], data,
      } });
    }
    return result;
  }
  const work = Array.from({ length: count }, (_, lane) => {
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
  // Activation cost depends on gate values: real later-layer activations can
  // exceed the synthetic fixture's cost. Leave room by packing four lanes.
  if (h.phase === 9) return Array.from({ length: Math.ceil(work.length / 4) }, (_, i) => {
    const group = work.slice(i * 4, i * 4 + 4);
    return { payer: group[0].payer, lane: group[0].lane, instruction: group[0].instruction, batch: group.map(item => item.instruction) };
  });
  return work;
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
export function collectSlicesFor(h: Header, session: SessionKeys, deployment: Deployment): Work[] {
  if (!independentMatrix(h, session)) return [];
  const count = Math.min(LANES, Math.ceil((total(h) - h.cursor) / 128));
  return Array.from({ length: count }, (_, lane) => {
    const parts = Math.ceil(Math.min(128, total(h) - h.cursor - lane * 128) / tileChunk(h.phase));
    return { payer: session.payers[lane], lane, instruction: {
      programAddress: address(deployment.program),
      accounts: [ro(session.state), rw(session.workers[lane]), signer(session.authority), ro(deployment.registry),
        ...session.sliceWorkers!.slice(lane * 16, lane * 16 + parts).map(ro)],
      data: epochData(9, h.epoch),
    } };
  });
}
export class Transport {
  readonly rpc;
  confirmationPollMs = 400;
  submitter?: (wire: string) => Promise<void>;
  private lifetime?: Promise<{
    blockhash: Blockhash;
    lastValidBlockHeight: bigint;
  }>;
  private lifetimeAt = 0;
  private heightAt = 0;
  private heightValue?: Promise<bigint>;
  private statusRequests: {
    signature: Signature;
    searchTransactionHistory: boolean;
    resolve: (status: Confirmation) => void;
    reject: (e: unknown) => void;
  }[] = [];
  private statusTimer?: ReturnType<typeof setTimeout>;
  private pollingStatuses = false;
  private genesisCheckedAt = 0;
  constructor(
    url = TESTNET_RPC,
    readonly raceUrls: string[] = [],
    stripeWrites = true,
    readonly expectedGenesis = TESTNET_GENESIS,
  ) {
    if (new URL(url).hostname !== "api.testnet.solana.com") {
      this.rpc = raceUrls.length ? createSolanaRpcFromTransport(createRacingRpcTransport(raceUrls, createDefaultRpcTransport({ url }), stripeWrites)) : createSolanaRpc(url);
      return;
    }
    const base = createDefaultRpcTransport({ url });
    let queue = Promise.resolve(),
      pauseUntil = 0;
    const limited: RpcTransport = async (config) => {
      for (let attempt = 0; ; attempt++) {
        queue = queue.then(
          () =>
            new Promise<void>((resolve) =>
              setTimeout(resolve, Math.max(500, pauseUntil - Date.now())),
            ),
        );
        await queue;
        config.signal?.throwIfAborted();
        try {
          return await base(config);
        } catch (error) {
          const status = (error as { context?: { statusCode?: number } })
            .context?.statusCode;
          if (attempt >= 4 || ![429, 502, 503, 504].includes(status ?? 0))
            throw error;
          pauseUntil = Date.now() + Math.min(30_000, 2000 * 2 ** attempt);
        }
      }
    };
    this.rpc = createSolanaRpcFromTransport(raceUrls.length ? createRacingRpcTransport(raceUrls, limited, stripeWrites) : limited);
  }
  // Sixteen lanes share one status poll instead of multiplying public RPC
  // requests by the number of workers. Each response retains its signature.
  status(signature: Signature, searchTransactionHistory = true): Promise<Confirmation> {
    return new Promise((resolve, reject) => {
      this.statusRequests.push({ signature, searchTransactionHistory, resolve, reject });
      if (!this.pollingStatuses)
        this.statusTimer ??= setTimeout(() => {
          void this.flushStatuses();
        }, 100);
    });
  }
  private async flushStatuses() {
    this.statusTimer = undefined;
    this.pollingStatuses = true;
    // Collect arrivals while the previous request is in flight, instead of
    // queueing many small RPC calls behind the public endpoint's rate limit.
    while (this.statusRequests.length) {
      const searchTransactionHistory = this.statusRequests[0].searchTransactionHistory;
      const requests: typeof this.statusRequests = [];
      this.statusRequests = this.statusRequests.filter((request) => {
        if (requests.length < 256 && request.searchTransactionHistory === searchTransactionHistory) {
          requests.push(request);
          return false;
        }
        return true;
      });
      try {
        const result = await this.rpc
          .getSignatureStatuses(
            requests.map((r) => r.signature),
            { searchTransactionHistory },
          )
          .send();
        requests.forEach((r, i) => r.resolve(result.value[i]));
      } catch (error) {
        requests.forEach((r) => r.reject(error));
      }
    }
    this.pollingStatuses = false;
  }
  height(): Promise<bigint> {
    if (!this.heightValue || Date.now() - this.heightAt > 2000) {
      this.heightAt = Date.now();
      this.heightValue = this.rpc
        .getBlockHeight({ commitment: "confirmed" })
        .send()
        .catch((error) => {
          this.heightValue = undefined;
          throw error;
        });
    }
    return this.heightValue;
  }
  async assertGenesis() {
    if (Date.now() - this.genesisCheckedAt < 30_000) return;
    const actual = await this.rpc.getGenesisHash().send();
    if (actual !== this.expectedGenesis)
      throw new Error(`RPC genesis mismatch: expected ${this.expectedGenesis}, received ${actual}`);
    this.genesisCheckedAt = Date.now();
  }
  async checkNetwork() {
    await this.assertGenesis();
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
    if (!this.lifetime || Date.now() - this.lifetimeAt > 10_000) {
      this.lifetimeAt = Date.now();
      this.lifetime = this.rpc
        .getLatestBlockhash({ commitment: "confirmed" })
        .send()
        .then((r) => r.value)
        .catch((error) => {
          this.lifetime = undefined;
          throw error;
        });
    }
    const lifetime = await this.lifetime;
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
  async submit(signed: Awaited<ReturnType<Transport["sign"]>>, viaRpc = false) {
    await this.assertGenesis();
    // Retry the same signed wire bytes after transport uncertainty. Resigning
    // changes the transaction identity; callers must resolve expiry first.
    const rpcSend = () => this.rpc
      .sendTransaction(signed.wire, {
        encoding: "base64",
        skipPreflight: !viaRpc,
        maxRetries: 3n,
        preflightCommitment: "confirmed",
      }).send();
    if (this.submitter && !viaRpc && this.raceUrls.length) {
      await Promise.any([this.submitter(signed.wire), rpcSend()]);
      return signed.signature;
    }
    if (this.submitter && !viaRpc) {
      await this.submitter(signed.wire);
      return signed.signature;
    }
    await rpcSend();
    return signed.signature;
  }
}

export class DeliveryUnresolvedError extends Error {}

export async function sendConfirmed(
  transport: Transport,
  work: Work,
  signal?: AbortSignal,
  onReceipt?: (signature: string) => void,
  viaRpc = false,
) {
  const signed = await transport.sign(work, work.batch);
  let submitError: unknown;
  try {
    await transport.submit(signed, viaRpc);
  } catch (error) {
    submitError = error;
  }
  const started = Date.now(); let lastSent = started;
  for (let attempt = 0; Date.now() - started < 100_000; attempt++) {
    signal?.throwIfAborted();
    const status = await transport.status(signed.signature, false);
    if (status?.err)
      throw new Error(
        `Transaction ${signed.signature} failed: ${rpcErrorText(status.err)}`,
      );
    if (
      status?.confirmationStatus === "confirmed" ||
      status?.confirmationStatus === "finalized"
    ) {
      onReceipt?.(signed.signature);
      return status.slot;
    }
    if ((await transport.height()) > signed.lastValidBlockHeight) {
      const historical = await transport.status(signed.signature, true);
      if (historical?.err) throw new Error(`Transaction ${signed.signature} failed: ${rpcErrorText(historical.err)}`);
      if (historical?.confirmationStatus === "confirmed" || historical?.confirmationStatus === "finalized") {
        onReceipt?.(signed.signature); return historical.slot;
      }
      throw new DeliveryUnresolvedError(`Transaction ${signed.signature} expired or is unresolved. Resume from on-chain state.`);
    }
    if (Date.now() - lastSent >= 8000) {
      lastSent = Date.now();
      try {
        // Stragglers get the same signed bytes through RPC after two TPU
        // attempts. This does not create a second transaction identity.
        await transport.submit(signed, viaRpc || Date.now() - started >= 16_000);
      } catch (error) {
        submitError = error;
      }
    }
    // A full second at every barrier compounds over tens of thousands of
    // waves. Status requests are batched; back off once a send is a straggler.
    await new Promise((r) => setTimeout(r, transport.raceUrls.length && Date.now() - started < 8000 ? transport.confirmationPollMs : 1000));
  }
  throw new DeliveryUnresolvedError(
    `Transaction confirmation is unresolved: ${signed.signature}. ${String(submitError ?? "")}`,
  );
}
