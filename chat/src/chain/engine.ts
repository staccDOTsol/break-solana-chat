import {
  AccountRole,
  address,
  generateKeyPairSigner,
  getAddressDecoder,
  type KeyPairSigner,
  type Instruction,
} from "@solana/kit";
import {
  getCreateAccountInstruction,
  getTransferSolInstruction,
} from "@solana-program/system";
import {
  header,
  LANES,
  LANE_SIZE,
  MAX_SEQ,
  parallel,
  STATE_SIZE,
  type Header,
} from "./layout.ts";
import {
  mergeFor,
  interleaveSlices,
  collectSlicesFor,
  sendConfirmed,
  Transport,
  DeliveryUnresolvedError,
  workFor,
  type Deployment,
  type SessionKeys,
  type Work,
} from "./transport.ts";
import { executeWave } from "./wave.ts";
import { TESTNET_GENESIS } from "./network.ts";

const signing = (key: KeyPairSigner, writable = false) => ({
  address: key.address,
  role: writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER,
  signer: key,
});
export type Wallet = {
  authority: KeyPairSigner;
  state: KeyPairSigner;
  workers: KeyPairSigner[];
  payers: KeyPairSigner[];
  sliceWorkers?: KeyPairSigner[];
  slicePayers?: KeyPairSigner[];
};
export async function createWallet(): Promise<Wallet> {
  const keys = await Promise.all(
    Array.from({ length: LANES * 2 + 2 }, () => generateKeyPairSigner()),
  );
  return {
    authority: keys[0],
    state: keys[1],
    workers: keys.slice(2, 2 + LANES),
    payers: keys.slice(2 + LANES),
  };
}
export class Engine {
  readonly session: SessionKeys;
  private slot = 0n;
  constructor(
    readonly transport: Transport,
    readonly deployment: Deployment,
    readonly wallet: Wallet,
    readonly receipt: (signature: string, lane?: number) => void = () => {},
  ) {
    if (deployment.genesis !== transport.expectedGenesis)
      throw new Error("Deployment genesis does not match the configured chain");
    this.session = {
      authority: wallet.authority,
      state: wallet.state.address,
      workers: wallet.workers.map((w) => w.address),
      payers: wallet.payers,
      sliceWorkers: wallet.sliceWorkers?.map(worker => worker.address),
      slicePayers: wallet.slicePayers,
    };
  }
  private async submit(work: Work, signal?: AbortSignal) {
    const control = work.lane === undefined || work.instruction.programAddress === "11111111111111111111111111111111" ||
      [6, 9, 10].includes(work.instruction.data?.[0] ?? -1);
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        const slot = await sendConfirmed(this.transport, work, signal, (s) =>
          this.receipt(s, work.lane), control || attempt > 0,
        );
        if (slot > this.slot) this.slot = slot;
        return;
      } catch (error) {
        // Only row tiles are idempotent within a fixed epoch. Never blindly
        // re-sign account creation, transfers, token starts or state advances.
        if (!(error instanceof DeliveryUnresolvedError) || ![4, 8, 9].includes(work.instruction.data?.[0] ?? -1) || attempt >= 2) throw error;
      }
    }
  }
  async read(): Promise<Header> {
    const result = await this.transport.rpc
      .getAccountInfo(this.wallet.state.address, {
        encoding: "base64",
        dataSlice: { offset: 0, length: 144 },
        commitment: "confirmed",
        minContextSlot: this.slot,
      })
      .send();
    if (!result.value || result.value.owner !== this.deployment.program)
      throw new Error("Session is not initialized for this program");
    const bytes = Uint8Array.from(atob(result.value.data[0]), (c) =>
      c.charCodeAt(0),
    );
    const decoder = getAddressDecoder();
    if (
      decoder.decode(bytes.slice(8, 40)) !== this.wallet.authority.address ||
      decoder.decode(bytes.slice(40, 72)) !== this.deployment.registry
    )
      throw new Error("Session authority/model mismatch");
    this.slot = result.context.slot;
    return header(bytes);
  }
  async setup(signal?: AbortSignal) {
    await this.transport.checkNetwork();
    const rpc = this.transport.rpc,
      authority = this.wallet.authority,
      programAddress = address(this.deployment.program);
    const [stateRent, laneRent] = await Promise.all([
      rpc.getMinimumBalanceForRentExemption(BigInt(STATE_SIZE)).send(),
      rpc.getMinimumBalanceForRentExemption(BigInt(LANE_SIZE)).send(),
    ]);
    const stateAccount = await rpc
      .getAccountInfo(this.wallet.state.address, {
        encoding: "base64",
        dataSlice: { offset: 0, length: 0 },
      })
      .send();
    if (!stateAccount.value) {
      const needed = stateRent + laneRent * BigInt(LANES) + 35_000_000_000n;
      if ((await rpc.getBalance(authority.address).send()).value < needed)
        throw new Error(
          `Fund this session authority with at least ${(Number(needed) / 1e9).toFixed(3)} ${this.transport.expectedGenesis === TESTNET_GENESIS ? "test" : "chain-native"} SOL: ${authority.address}`,
        );
      const instructions: Instruction[] = [
        getCreateAccountInstruction({
          payer: authority,
          newAccount: this.wallet.state,
          lamports: stateRent,
          space: BigInt(STATE_SIZE),
          programAddress,
        }),
        {
          programAddress,
          accounts: [
            signing(this.wallet.state, true),
            signing(authority),
            {
              address: address(this.deployment.registry),
              role: AccountRole.READONLY,
            },
          ],
          data: Uint8Array.of(0),
        },
      ];
      const signed = await this.transport.sign(
        { payer: authority, instruction: instructions[0] },
        instructions,
      );
      await this.transport.submit(signed, true);
      // Account creation and initialization are atomic. Resolve the signed
      // transaction before continuing; never create a replacement session key.
      await this.confirmExisting(signed, signal);
    }
    await this.read();
    const existingAccounts = await rpc.getMultipleAccounts([
      ...this.wallet.workers.map(worker => worker.address),
      ...this.wallet.payers.map(payer => payer.address),
    ], { encoding: "base64", dataSlice: { offset: 0, length: 64 }, commitment: "confirmed", minContextSlot: this.slot }).send();
    const setupBatches: Instruction[][] = Array.from({ length: 4 }, () => []);
    for (let i = 0; i < LANES; i++) {
      signal?.throwIfAborted();
      const worker = this.wallet.workers[i],
        payer = this.wallet.payers[i];
      const existing = existingAccounts.value[i], batch = setupBatches[Math.floor(i / 4)];
      if (!existing) {
        const instructions: Instruction[] = [
          getCreateAccountInstruction({
            payer: authority,
            newAccount: worker,
            lamports: laneRent,
            space: BigInt(LANE_SIZE),
            programAddress,
          }),
          {
            programAddress,
            accounts: [
              signing(worker, true),
              {
                address: this.wallet.state.address,
                role: AccountRole.READONLY,
              },
              signing(authority),
            ],
            data: Uint8Array.of(1, i),
          },
        ];
        batch.push(...instructions);
      } else {
        const bytes = Uint8Array.from(atob(existing.data[0]), (c) =>
          c.charCodeAt(0),
        );
        if (
          existing.owner !== programAddress ||
          new TextDecoder().decode(bytes.slice(0, 8)) !== "SEALANE2" ||
          getAddressDecoder().decode(bytes.slice(8, 40)) !==
            this.wallet.state.address ||
          new DataView(bytes.buffer).getUint32(40, true) !== i
        )
          throw new Error("Worker/session binding mismatch");
      }
      const balance = existingAccounts.value[LANES + i]?.lamports ?? 0n;
      if (balance < 2_000_000_000n)
        batch.push(getTransferSolInstruction({
              source: authority,
              destination: payer.address,
              amount: 2_000_000_000n - balance,
            }));
    }
    // All worker addresses, bindings and funding amounts are known now.
    // Four lanes fit in one atomic transaction; settle every group before
    // beginning inference or allowing a paused setup to resume.
    const settled = await Promise.allSettled(setupBatches.filter(batch => batch.length).map(async batch => {
      signal?.throwIfAborted();
      const signed = await this.transport.sign({ payer: authority, instruction: batch[0] }, batch);
      try { await this.transport.submit(signed, true); } catch { /* Resolve uncertain delivery by signature. */ }
      await this.confirmExisting(signed, signal);
    }));
    const failed = settled.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
    if (this.wallet.sliceWorkers) await this.setupSlices(laneRent, signal);
  }
  private async setupSlices(rent: bigint, signal?: AbortSignal) {
    const workers = this.wallet.sliceWorkers!, payers = this.wallet.slicePayers!, authority = this.wallet.authority;
    if (workers.length !== 256 || payers?.length !== 256) throw new Error("Incomplete independent-slice wallet");
    const keys = [...workers, ...payers].map(key => key.address), accounts = [];
    for (let offset = 0; offset < keys.length; offset += 64) {
      signal?.throwIfAborted();
      const result = await this.transport.rpc.getMultipleAccounts(keys.slice(offset, offset + 64), {
        encoding: "base64", dataSlice: { offset: 0, length: 72 }, commitment: "confirmed", minContextSlot: this.slot,
      }).send();
      accounts.push(...result.value);
    }
    const batches: Instruction[][] = Array.from({ length: 64 }, () => []);
    for (let i = 0; i < 256; i++) {
      const existing = accounts[i], batch = batches[Math.floor(i / 4)];
      if (existing) {
        const bytes = Uint8Array.from(atob(existing.data[0]), c => c.charCodeAt(0));
        if (existing.owner !== this.deployment.program || new TextDecoder().decode(bytes.slice(0, 8)) !== "SEASLCE3" ||
          getAddressDecoder().decode(bytes.slice(8, 40)) !== this.wallet.state.address ||
          new DataView(bytes.buffer).getUint32(40, true) !== Math.floor(i / 16) || new DataView(bytes.buffer).getUint32(68, true) !== i % 16)
          throw new Error("Slice/session binding mismatch");
      } else batch.push(getCreateAccountInstruction({ payer: authority, newAccount: workers[i], lamports: rent,
        space: BigInt(LANE_SIZE), programAddress: address(this.deployment.program) }), {
        programAddress: address(this.deployment.program),
        accounts: [signing(workers[i], true), { address: this.wallet.state.address, role: AccountRole.READONLY }, signing(authority)],
        data: Uint8Array.of(7, Math.floor(i / 16), i % 16),
      });
      const balance = accounts[256 + i]?.lamports ?? 0n;
      if (balance < 125_000_000n) batch.push(getTransferSolInstruction({ source: authority, destination: payers[i].address, amount: 125_000_000n - balance }));
    }
    const results = await Promise.allSettled(batches.filter(batch => batch.length).map(async batch => {
      signal?.throwIfAborted();
      const signed = await this.transport.sign({ payer: authority, instruction: batch[0] }, batch);
      try { await this.transport.submit(signed, true); } catch { /* Resolve by signature before resuming setup. */ }
      await this.confirmExisting(signed, signal);
    }));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  private async confirmExisting(
    signed: Awaited<ReturnType<Transport["sign"]>>,
    signal?: AbortSignal,
  ) {
    for (let i = 0; i < 100; i++) {
      signal?.throwIfAborted();
      const status = await this.transport.status(signed.signature, false);
      if (status?.err)
        throw new Error(`Setup transaction failed: ${signed.signature}`);
      if (
        status?.confirmationStatus === "confirmed" ||
        status?.confirmationStatus === "finalized"
      ) {
        this.slot = status.slot > this.slot ? status.slot : this.slot;
        this.receipt(signed.signature);
        return;
      }
      if (
        (await this.transport.height()) > signed.lastValidBlockHeight
      )
        throw new Error(
          `Setup transaction expired/unresolved: ${signed.signature}`,
        );
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Setup confirmation timed out: ${signed.signature}`);
  }
  async drive(
    signal?: AbortSignal,
    onProgress?: (h: Header) => void,
  ): Promise<Header> {
    for (;;) {
      signal?.throwIfAborted();
      const h = await this.read();
      onProgress?.(h);
      if (h.phase === 0 || h.phase === 14) return h;
      const work = workFor(h, this.session, this.deployment, this.transport.expectedGenesis);
      // Each lane progresses independently. Only complete 128-row results
      // cross the session barrier; unfinished/replayed work cannot merge.
      const started = performance.now(), slices = interleaveSlices(work);
      const collectors = collectSlicesFor(h, this.session, this.deployment);
      await executeWave(slices, collectors, item => this.submit(item, signal));
      if (parallel(h.phase))
        await this.submit(mergeFor(h, this.session, this.deployment), signal);
      console.log(JSON.stringify({ event: "inference-wave", state: this.session.state, phase: h.phase,
        layer: h.layer, epoch: h.epoch, cursor: h.cursor, transactions: slices.length + collectors.length + Number(parallel(h.phase)),
        milliseconds: Math.round(performance.now() - started) }));
    }
  }
  async token(
    token: number,
    emit: boolean,
    signal?: AbortSignal,
    onProgress?: (h: Header) => void,
  ) {
    const h = await this.read();
    if (![0, 14].includes(h.phase))
      throw new Error("Resume the in-flight token before starting another");
    if (
      h.count >= MAX_SEQ ||
      !Number.isInteger(token) ||
      token < 0 ||
      token >= 151936
    )
      throw new Error("Token/context limit reached");
    const data = new Uint8Array(10),
      v = new DataView(data.buffer);
    data[0] = 2;
    v.setUint32(1, token, true);
    data[5] = Number(emit);
    v.setUint32(6, h.epoch, true);
    await this.submit(
      {
        payer: this.wallet.authority,
        instruction: {
          programAddress: address(this.deployment.program),
          accounts: [
            { address: this.wallet.state.address, role: AccountRole.WRITABLE },
            signing(this.wallet.authority),
          ],
          data,
        },
      },
      signal,
    );
    return this.drive(signal, onProgress);
  }
  async close(signal?: AbortSignal, { reclaimPayers = true } = {}) {
    if (this.wallet.sliceWorkers) {
      for (let offset = 0; offset < this.wallet.sliceWorkers.length; offset += 48) {
        const keys = this.wallet.sliceWorkers.slice(offset, offset + 48);
        const accounts = await this.transport.rpc.getMultipleAccounts(keys.map(key => key.address), {
          encoding: "base64", dataSlice: { offset: 0, length: 40 }, commitment: "confirmed", minContextSlot: this.slot,
        }).send();
        const existing = keys.filter((key, i) => {
          const account = accounts.value[i]; if (!account) return false;
          const bytes = Uint8Array.from(atob(account.data[0]), c => c.charCodeAt(0));
          if (account.owner !== this.deployment.program || new TextDecoder().decode(bytes.slice(0, 8)) !== "SEASLCE3" ||
            getAddressDecoder().decode(bytes.slice(8, 40)) !== this.wallet.state.address) throw new Error("Cannot close a slice from another session");
          return true;
        });
        if (existing.length) await this.submit({ payer: this.wallet.authority, instruction: {
          programAddress: address(this.deployment.program), data: Uint8Array.of(10),
          accounts: [{ address: this.wallet.state.address, role: AccountRole.READONLY }, signing(this.wallet.authority, true),
            ...existing.map(key => ({ address: key.address, role: AccountRole.WRITABLE }))],
        } }, signal);
      }
    }
    const accounts = await this.transport.rpc.getMultipleAccounts(
      this.wallet.workers.map(worker => worker.address),
      { encoding: "base64", commitment: "confirmed", minContextSlot: this.slot,
        dataSlice: { offset: 0, length: 64 } },
    ).send();
    const existingWorkers = this.wallet.workers.filter((worker, index) => {
      const account = accounts.value[index];
      if (!account) return false;
      const bytes = Uint8Array.from(atob(account.data[0]), character => character.charCodeAt(0));
      if (account.owner !== this.deployment.program ||
          new TextDecoder().decode(bytes.slice(0, 8)) !== "SEALANE2" ||
          getAddressDecoder().decode(bytes.slice(8, 40)) !== this.wallet.state.address)
        throw new Error("Cannot close a worker belonging to another session");
      return true;
    });
    await this.submit(
      {
        payer: this.wallet.authority,
        instruction: {
          programAddress: address(this.deployment.program),
          accounts: [
            { address: this.wallet.state.address, role: AccountRole.WRITABLE },
            signing(this.wallet.authority, true),
            ...existingWorkers.map((w) => ({
              address: w.address,
              role: AccountRole.WRITABLE,
            })),
          ],
          data: Uint8Array.of(6),
        },
      },
      signal,
    );
    const payers = reclaimPayers ? [...this.wallet.payers, ...(this.wallet.slicePayers ?? [])] : [];
    for (let offset = 0; offset < payers.length; offset += 64) {
      const group = payers.slice(offset, offset + 64);
      const accounts = await this.transport.rpc.getMultipleAccounts(group.map(key => key.address), {
        encoding: "base64", dataSlice: { offset: 0, length: 0 }, commitment: "confirmed", minContextSlot: this.slot,
      }).send();
      const results = await Promise.allSettled(group.map(async (payer, i) => {
        const balance = accounts.value[i]?.lamports ?? 0n;
        if (balance <= 5000n) return;
        await this.submit(
          {
            payer,
            instruction: getTransferSolInstruction({
              source: payer,
              destination: this.wallet.authority.address,
              amount: balance - 5000n,
            }),
          },
          signal,
        );
      }));
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
  }
}
