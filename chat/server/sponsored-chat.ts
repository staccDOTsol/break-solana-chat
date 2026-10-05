import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Engine, type Wallet } from "../src/chain/engine.ts";
import { MAX_SEQ, type Header } from "../src/chain/layout.ts";
import { Transport, type Deployment } from "../src/chain/transport.ts";
import { writeUploadStatus } from "../scripts/upload-status.ts";
import { readSigner, savedSigner } from "./keys.ts";
import { recordPace, runProgress, type Pace } from "./run-progress.ts";

type Message = { id: string; role: "you" | "model"; text: string; createdAt: string };
type PendingToken = { countBefore: number; token: number; emit: boolean };
type Job = { input: number[]; processed: number; generated: number[]; maximum: number;
  nextToken?: number; pending?: PendingToken; startedAt?: string; outputId: string;
  baseCount?: number; pace?: Pace; measuredAt?: string };
export type ChatState = {
  id: string; accessHash: string; createdAt: string; updatedAt: string;
  stage: "idle" | "queued" | "setup" | "running" | "paused" | "done" | "error" | "closed";
  stateAddress?: string; messages: Message[]; job?: Job; header?: Header; confirmed: number;
  receipts: { signature: string; lane?: number; at: string }[]; error?: string;
  independentSlices?: boolean;
};
type Config = {
  directory: string; sponsorPath: string; transport: Transport;
  deployment: () => Promise<Deployment | undefined>;
  tokenize: (text: string, continuation: boolean) => Promise<number[]>;
  decode: (tokens: number[]) => Promise<string>;
  independentSlices?: boolean;
  engineFactory?: (state: ChatState, receipt: (signature: string, lane?: number) => void) => Promise<Engine>;
};
export class ChatError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const now = () => new Date().toISOString();
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

/** The browser holds only an access token. The sponsor and session signing keys
 * stay on this server; requests can select text, never arbitrary transactions. */
export class SponsoredChat {
  private states = new Map<string, ChatState>();
  private queue: string[] = [];
  private active?: { id: string; abort: AbortController; task: Promise<void> };
  private ready?: Promise<void>;
  private wallets = new Map<string, Promise<Wallet>>();
  private sponsor?: ReturnType<typeof readSigner>;
  private shuttingDown = false;
  private lastSaved = new Map<string, number>();
  private mutations = new Map<string, Promise<unknown>>();
  private listeners = new Map<string, Set<(state: ReturnType<SponsoredChat["publicState"]>) => void>>();
  constructor(private readonly config: Config) {}
  start() { return this.init(); }
  serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.mutations.get(id) ?? Promise.resolve()).catch(() => {}).then(operation);
    this.mutations.set(id, result);
    void result.finally(() => { if (this.mutations.get(id) === result) this.mutations.delete(id); }).catch(() => {});
    return result;
  }
  private path(id: string) { return resolve(this.config.directory, id, "session.json"); }
  private save(state: ChatState, force = true) {
    if (!force && Date.now() - (this.lastSaved.get(state.id) ?? 0) < 2000) return;
    state.updatedAt = now(); this.lastSaved.set(state.id, Date.now());
    writeUploadStatus(this.path(state.id), state);
    for (const listener of this.listeners.get(state.id) ?? []) listener(this.publicState(state));
  }
  private init() {
    return this.ready ??= (async () => {
      await mkdir(this.config.directory, { recursive: true, mode: 0o700 });
      for (const id of await readdir(this.config.directory)) {
        if (!/^[a-f0-9-]{36}$/.test(id)) continue;
        let state: ChatState;
        try { state = JSON.parse(await readFile(this.path(id), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (state.id !== id) throw new Error("Saved chat identity mismatch");
        this.states.set(id, state);
        if (["running", "setup", "queued"].includes(state.stage) && state.job) {
          state.stage = "queued"; this.queue.push(id); this.save(state);
        }
      }
      queueMicrotask(() => this.pump());
    })();
  }
  async sponsorship() {
    const signer = await (this.sponsor ??= readSigner(this.config.sponsorPath).catch(error => { this.sponsor = undefined; throw error; }));
    return { enabled: true, address: signer.address, queued: this.queue.length, active: !!this.active };
  }
  async create() {
    await this.init(); await this.sponsorship();
    if ([...this.states.values()].filter(s => s.stage !== "closed").length >= 512)
      throw new ChatError("All sponsored chat slots are occupied. Please try again shortly.", 429);
    const id = randomUUID(), accessToken = randomBytes(32).toString("hex");
    await mkdir(resolve(this.config.directory, id), { recursive: true, mode: 0o700 });
    const state: ChatState = { id, accessHash: digest(accessToken), createdAt: now(), updatedAt: now(),
      stage: "idle", messages: [], confirmed: 0, receipts: [], independentSlices: this.config.independentSlices || undefined };
    this.states.set(id, state); this.save(state);
    return { accessToken, session: this.publicState(state) };
  }
  private async authorized(id: string, token: string) {
    await this.init();
    const state = this.states.get(id), given = Buffer.from(digest(token), "hex");
    if (!state || !token || !timingSafeEqual(Buffer.from(state.accessHash, "hex"), given))
      throw new ChatError("This chat could not be found. Start a new chat.", 404);
    return state;
  }
  private publicState(state: ChatState) {
    return { id: state.id, createdAt: state.createdAt, updatedAt: state.updatedAt, stage: state.stage,
      stateAddress: state.stateAddress, messages: state.messages, header: state.header,
      confirmed: state.confirmed, receipts: state.receipts, error: state.error,
      queuePosition: this.queue.indexOf(state.id) + 1, sponsored: true,
      run: state.job ? { promptTokens: state.job.input.length, processedPromptTokens: state.job.processed,
        generatedTokens: state.job.generated.length, maximumOutputTokens: state.job.maximum,
        startedAt: state.job.startedAt,
        progress: runProgress(state.job, state.header, state.stage, state.independentSlices) } : undefined };
  }
  async get(id: string, token: string) { return this.publicState(await this.authorized(id, token)); }
  async shared(id: string) {
    await this.init(); const state = this.states.get(id);
    if (!state) throw new ChatError("This chat could not be found.", 404);
    return this.publicState(state);
  }
  async subscribeShared(id: string, listener: (state: ReturnType<SponsoredChat["publicState"]>) => void) {
    await this.shared(id);
    return this.watch(this.states.get(id)!, listener);
  }
  async subscribe(id: string, token: string, listener: (state: ReturnType<SponsoredChat["publicState"]>) => void) {
    const state = await this.authorized(id, token);
    return this.watch(state, listener);
  }
  private watch(state: ChatState, listener: (state: ReturnType<SponsoredChat["publicState"]>) => void) {
    const id = state.id, listeners = this.listeners.get(id) ?? new Set();
    listeners.add(listener); this.listeners.set(id, listeners);
    listener(this.publicState(state));
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(id); };
  }
  async send(id: string, token: string, text: string, maximum = 8) {
    const state = await this.authorized(id, token);
    if (typeof text !== "string" || !text.trim() || text.length > 2000 || !Number.isInteger(maximum) || maximum < 1 || maximum > 8)
      throw new ChatError("Enter a message and choose between one and eight response tokens.");
    if (!["idle", "done"].includes(state.stage)) throw new ChatError("Finish or resume the current turn first.", 409);
    if (this.queue.length >= 4) throw new ChatError("The sponsored queue is full. Try again shortly.", 429);
    if (!state.stateAddress && [...this.states.values()].filter(s => s.stage !== "closed" && !!s.job).length >= 12)
      throw new ChatError("All sponsored chat slots are occupied. Please try again shortly.", 429);
    const input = await this.config.tokenize(text.trim(), (state.header?.count ?? 0) > 0);
    if (this.queue.length >= 4) throw new ChatError("The sponsored queue is full. Try again shortly.", 429);
    if (!state.stateAddress && [...this.states.values()].filter(s => s.stage !== "closed" && !!s.job).length >= 12)
      throw new ChatError("All sponsored chat slots are occupied. Please try again shortly.", 429);
    if ((state.header?.count ?? 0) + input.length + maximum > MAX_SEQ)
      throw new ChatError("This chat has reached its context limit. Start a new chat to continue.");
    const outputId = randomUUID();
    state.messages.push({ id: randomUUID(), role: "you", text: text.trim(), createdAt: now() },
      { id: outputId, role: "model", text: "", createdAt: now() });
    state.job = { input, processed: 0, generated: [], maximum, outputId, baseCount: state.header?.count ?? 0 };
    state.error = undefined; state.stage = "queued"; this.queue.push(id); this.save(state); this.pump();
    return this.publicState(state);
  }
  async resume(id: string, token: string) {
    const state = await this.authorized(id, token);
    if (!["paused", "error"].includes(state.stage) || !state.job) throw new ChatError("There is no paused turn to resume.", 409);
    if (this.queue.length >= 4) throw new ChatError("The sponsored queue is full. Try again shortly.", 429);
    state.error = undefined; state.stage = "queued"; this.queue.push(id); this.save(state); this.pump();
    return this.publicState(state);
  }
  async pause(id: string, token: string) {
    const state = await this.authorized(id, token);
    this.queue = this.queue.filter(key => key !== id);
    if (this.active?.id === id) {
      this.active.abort.abort(new Error("Chat paused")); await this.active.task;
    } else if (["queued", "running", "setup"].includes(state.stage)) {
      state.stage = "paused"; this.save(state);
    }
    return this.publicState(state);
  }
  private wallet(state: ChatState) {
    let wallet = this.wallets.get(state.id);
    if (!wallet) {
      wallet = (async () => {
        const authority = await (this.sponsor ??= readSigner(this.config.sponsorPath));
        const directory = resolve(this.config.directory, state.id);
        const key = (name: string) => savedSigner(resolve(directory, `${name}-keypair.json`));
        const result: Wallet = { authority, state: await key("state"),
          workers: await Promise.all(Array.from({ length: 16 }, (_, i) => key(`worker-${i}`))),
          payers: await Promise.all(Array.from({ length: 16 }, (_, i) => savedSigner(resolve(this.config.directory, `fee-payer-${i}-keypair.json`)))) };
        if (state.independentSlices) {
          result.sliceWorkers = await Promise.all(Array.from({ length: 256 }, (_, i) => key(`slice-${i}`)));
          result.slicePayers = await Promise.all(Array.from({ length: 256 }, (_, i) => savedSigner(resolve(this.config.directory, `slice-fee-payer-${i}-keypair.json`))));
        }
        state.stateAddress = result.state.address; this.save(state); return result;
      })();
      this.wallets.set(state.id, wallet);
    }
    return wallet;
  }
  private async engine(state: ChatState) {
    const receipt = (signature: string, lane?: number) => {
      state.confirmed++; state.receipts.unshift({ signature, lane, at: now() });
      state.receipts.length = Math.min(state.receipts.length, 24); this.save(state, false);
    };
    if (this.config.engineFactory) return this.config.engineFactory(state, receipt);
    const deployment = await this.config.deployment();
    if (!deployment) throw new Error("Model deployment is not ready");
    return new Engine(this.config.transport, deployment, await this.wallet(state), receipt);
  }
  private pump() {
    if (this.active || this.shuttingDown) return;
    const id = this.queue.shift(); if (!id) return;
    const state = this.states.get(id)!, abort = new AbortController();
    const task = this.run(state, abort.signal).finally(() => { this.active = undefined; this.pump(); });
    this.active = { id, abort, task };
  }
  private async run(state: ChatState, signal: AbortSignal) {
    try {
      const engine = await this.engine(state), job = state.job!;
      state.stage = "setup"; job.startedAt ??= now(); this.save(state);
      await engine.setup(signal); state.stage = "running"; this.save(state);
      let previous: { header: Header; at: number } | undefined;
      const progress = (header: Header) => {
        const at = performance.now();
        if (previous && header.count === previous.header.count && header.epoch > previous.header.epoch)
          recordPace(job, previous.header.phase, at - previous.at);
        previous = { header: { ...header }, at };
        state.header = header; this.save(state, false);
      };
      const runToken = async (token: number, emit: boolean) => {
        signal.throwIfAborted(); let header = await engine.read();
        job.pending ??= { countBefore: header.count, token, emit };
        if (job.pending.token !== token || job.pending.emit !== emit) throw new Error("Saved token does not match the current turn");
        this.save(state);
        if (header.count === job.pending.countBefore) header = await engine.token(token, emit, signal, progress);
        else if (header.count === job.pending.countBefore + 1) header = await engine.drive(signal, progress);
        else throw new Error("On-chain context differs from the saved turn");
        state.header = header; return header;
      };
      while (job.processed < job.input.length) {
        const result = await runToken(job.input[job.processed], job.processed === job.input.length - 1);
        job.processed++; job.nextToken = result.token; job.pending = undefined; this.save(state);
      }
      for (;;) {
        signal.throwIfAborted();
        // A pending token has already been displayed. Consume it exactly once
        // before predicting the following token, including across restarts.
        if (job.pending) {
          const result = await runToken(job.pending.token, true);
          job.nextToken = result.token; job.pending = undefined; this.save(state);
          continue;
        }
        if (job.generated.length >= job.maximum || [151643, 151645].includes(job.nextToken!)) break;
        const prediction = job.nextToken!;
        const header = await engine.read();
        const generated = [...job.generated, prediction], text = await this.config.decode(generated);
        job.generated = generated; job.pending = { countBefore: header.count, token: prediction, emit: true };
        state.messages.find(message => message.id === job.outputId)!.text = text;
        this.save(state);
      }
      state.stage = "done"; state.error = undefined; this.save(state);
    } catch (error) {
      state.stage = signal.aborted ? "paused" : "error";
      state.error = signal.aborted ? undefined : String(error instanceof Error ? error.message : error);
      this.save(state);
      if (!signal.aborted) console.error(JSON.stringify({ chatError: state.id, error: state.error }));
    }
  }
  async close(id: string, token: string) {
    const state = await this.authorized(id, token); await this.pause(id, token);
    if (state.stateAddress) {
      const engine = await this.engine(state);
      const account = (await this.config.transport.rpc.getAccountInfo(engine.wallet.state.address,
        { encoding: "base64", dataSlice: { offset: 0, length: 0 } }).send()).value;
      if (account) await engine.close(undefined, { reclaimPayers: false });
    }
    state.stage = "closed"; state.job = undefined; state.error = undefined; this.save(state);
    return this.publicState(state);
  }
  async shutdown() {
    this.shuttingDown = true;
    if (this.active) {
      const { id, abort, task } = this.active;
      abort.abort(new Error("Service restarting")); await task;
      const state = this.states.get(id)!;
      if (state.stage === "paused") { state.stage = "queued"; this.save(state); }
    }
  }
}
