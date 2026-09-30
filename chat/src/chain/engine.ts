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
  sendConfirmed,
  Transport,
  workFor,
  type Deployment,
  type SessionKeys,
  type Work,
} from "./transport.ts";

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
    this.session = {
      authority: wallet.authority,
      state: wallet.state.address,
      workers: wallet.workers.map((w) => w.address),
      payers: wallet.payers,
    };
  }
  private async submit(work: Work, signal?: AbortSignal) {
    const slot = await sendConfirmed(this.transport, work, signal, (s) =>
      this.receipt(s, work.lane),
    );
    if (slot > this.slot) this.slot = slot;
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
          `Fund this session authority with at least ${(Number(needed) / 1e9).toFixed(3)} test SOL: ${authority.address}`,
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
      await this.transport.submit(signed);
      // Account creation and initialization are atomic. Resolve the signed
      // transaction before continuing; never create a replacement session key.
      await this.confirmExisting(signed, signal);
    }
    await this.read();
    for (let i = 0; i < LANES; i++) {
      signal?.throwIfAborted();
      const worker = this.wallet.workers[i],
        payer = this.wallet.payers[i];
      const existing = await rpc
        .getAccountInfo(worker.address, {
          encoding: "base64",
          dataSlice: { offset: 0, length: 64 },
        })
        .send();
      if (!existing.value) {
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
        const signed = await this.transport.sign(
          { payer: authority, instruction: instructions[0] },
          instructions,
        );
        await this.transport.submit(signed);
        await this.confirmExisting(signed, signal);
      } else {
        const bytes = Uint8Array.from(atob(existing.value.data[0]), (c) =>
          c.charCodeAt(0),
        );
        if (
          existing.value.owner !== programAddress ||
          new TextDecoder().decode(bytes.slice(0, 8)) !== "SEALANE2" ||
          getAddressDecoder().decode(bytes.slice(8, 40)) !==
            this.wallet.state.address ||
          new DataView(bytes.buffer).getUint32(40, true) !== i
        )
          throw new Error("Worker/session binding mismatch");
      }
      const balance = (await rpc.getBalance(payer.address).send()).value;
      if (balance < 2_000_000_000n)
        await this.submit(
          {
            payer: authority,
            instruction: getTransferSolInstruction({
              source: authority,
              destination: payer.address,
              amount: 2_000_000_000n - balance,
            }),
          },
          signal,
        );
    }
  }
  private async confirmExisting(
    signed: Awaited<ReturnType<Transport["sign"]>>,
    signal?: AbortSignal,
  ) {
    for (let i = 0; i < 100; i++) {
      signal?.throwIfAborted();
      const status = (
        await this.transport.rpc
          .getSignatureStatuses([signed.signature], {
            searchTransactionHistory: true,
          })
          .send()
      ).value[0];
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
        (await this.transport.rpc
          .getBlockHeight({ commitment: "confirmed" })
          .send()) > signed.lastValidBlockHeight
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
      const work = workFor(h, this.session, this.deployment);
      // Each lane progresses independently. Only complete 128-row results
      // cross the session barrier; unfinished/replayed work cannot merge.
      const results = await Promise.allSettled(
        work.map(async (item) => {
          for (const instruction of item.parts ?? [item.instruction])
            await this.submit({ ...item, instruction }, signal);
        }),
      );
      const failure = results.find((r) => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      if (parallel(h.phase))
        await this.submit(mergeFor(h, this.session, this.deployment), signal);
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
  async close(signal?: AbortSignal) {
    await this.submit(
      {
        payer: this.wallet.authority,
        instruction: {
          programAddress: address(this.deployment.program),
          accounts: [
            { address: this.wallet.state.address, role: AccountRole.WRITABLE },
            signing(this.wallet.authority, true),
            ...this.wallet.workers.map((w) => ({
              address: w.address,
              role: AccountRole.WRITABLE,
            })),
          ],
          data: Uint8Array.of(6),
        },
      },
      signal,
    );
    for (const payer of this.wallet.payers) {
      const balance = (
        await this.transport.rpc.getBalance(payer.address).send()
      ).value;
      if (balance > 5000n)
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
    }
  }
}
