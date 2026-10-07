import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SponsoredChat, ChatError, type ChatState } from "../server/sponsored-chat.ts";
import { savedSigner } from "../server/keys.ts";
import { Transport } from "../src/chain/transport.ts";
import { type Engine } from "../src/chain/engine.ts";
import { type Header } from "../src/chain/layout.ts";

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "sponsored-chat-"));
  const sponsorPath = join(directory, "sponsor-keypair.json");
  const sponsor = await savedSigner(sponsorPath);
  const chains = new Map<string, Header>();
  const inputs: number[] = [];
  let failAfterStart = false, hold = false, holdAt = Infinity;
  const config = {
    directory, sponsorPath, transport: new Transport(), deployment: async () => undefined,
    tokenize: async () => [10, 11], decode: async (tokens: number[]) => tokens.map(t => `word${t}`).join(" "),
    engineFactory: async (state: ChatState, receipt: (signature: string) => void) => {
      let h = chains.get(state.id);
      if (!h) { h = { phase: 0, layer: 0, position: 0, cursor: 0, epoch: 0, token: 0, count: 0 }; chains.set(state.id, h); }
      const drive = async (signal?: AbortSignal, progress?: (h: Header) => void) => {
        if (hold || h!.count >= holdAt) await new Promise<void>((resolve, reject) => {
          if (signal?.aborted) reject(signal.reason);
          else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        signal?.throwIfAborted(); h!.phase = 14; h!.token += 1; h!.epoch++;
        progress?.({ ...h! }); receipt(`receipt-${h!.count}`); return { ...h! };
      };
      return { setup: async () => {}, read: async () => ({ ...h! }), drive,
        token: async (token: number, _emit: boolean, signal?: AbortSignal, progress?: (h: Header) => void) => {
          inputs.push(token); h!.count++; h!.token = token; h!.phase = 3;
          progress?.({ ...h! });
          if (failAfterStart) { failAfterStart = false; throw new Error("Delivery interrupted after token start"); }
          return drive(signal, progress);
        },
      } as unknown as Engine;
    },
  };
  const chat = new SponsoredChat(config);
  return { chat, config, sponsor, inputs, chains, directory,
    holdAfter: (count: number) => { holdAt = count; },
    fail: () => { failAfterStart = true; }, hold: (value: boolean) => { hold = value; },
    cleanup: async () => { await chat.shutdown(); await rm(directory, { recursive: true, force: true }); } };
}
async function until(chat: SponsoredChat, credentials: { accessToken: string; session: { id: string } }, stage: string) {
  for (let i = 0; i < 100; i++) {
    const value = await chat.get(credentials.session.id, credentials.accessToken);
    if (value.stage === stage) return value;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(`Did not reach ${stage}`);
}

test("the sponsor signs server-side; public sessions exclude access hashes and signing keys", async () => {
  const f = await fixture();
  try {
    const auth = await f.chat.create();
    assert.equal((await f.chat.sponsorship()).address, f.sponsor.address);
    const value = await f.chat.get(auth.session.id, auth.accessToken);
    assert(!JSON.stringify(value).includes("accessHash"));
    assert(!JSON.stringify(value).includes("secretKey"));
    assert(!JSON.stringify(value).includes(auth.accessToken));
    assert.deepEqual(await f.chat.shared(auth.session.id), value);
    const publicSnapshots: unknown[] = [];
    const unwatch = await f.chat.subscribeShared(auth.session.id, snapshot => publicSnapshots.push(snapshot));
    assert.deepEqual(publicSnapshots, [value]); unwatch();
    await assert.rejects(f.chat.get(auth.session.id, "wrong"), (error: unknown) => error instanceof ChatError && error.status === 404);
    await assert.rejects(f.chat.send(auth.session.id, auth.accessToken, "hello", 100));
    assert.equal(f.inputs.length, 0);
  } finally { await f.cleanup(); }
});

test("an interrupted token resumes from chain state exactly once, including after restart", async () => {
  const f = await fixture(); let restored: SponsoredChat | undefined;
  try {
    const auth = await f.chat.create(); f.fail();
    await f.chat.send(auth.session.id, auth.accessToken, "hello", 2);
    await until(f.chat, auth, "error");
    assert.deepEqual(f.inputs, [10]);
    await f.chat.shutdown();
    restored = new SponsoredChat(f.config); await restored.start();
    await restored.resume(auth.session.id, auth.accessToken);
    const done = await until(restored, auth, "done");
    assert.deepEqual(f.inputs, [10, 11, 12, 13]);
    assert.equal(done.messages[1].text, "word12 word13");
    assert.equal(done.header?.count, 4);
    assert.equal(done.run?.generatedTokens, 2);
    const disk = JSON.parse(await readFile(join(f.directory, auth.session.id, "session.json"), "utf8"));
    assert.equal(disk.job.pending, undefined);
    assert.equal(disk.stage, "done");
  } finally { await restored?.shutdown(); await f.cleanup(); }
});

test("pause keeps a token checkpoint; other sessions queue and can be cancelled independently", async () => {
  const f = await fixture();
  try {
    const first = await f.chat.create(), second = await f.chat.create(); f.hold(true);
    await f.chat.send(first.session.id, first.accessToken, "first", 1);
    await until(f.chat, first, "running");
    await f.chat.send(second.session.id, second.accessToken, "second", 1);
    assert.equal((await f.chat.get(second.session.id, second.accessToken)).queuePosition, 1);
    await f.chat.pause(second.session.id, second.accessToken);
    await f.chat.pause(first.session.id, first.accessToken);
    assert.equal((await f.chat.get(first.session.id, first.accessToken)).stage, "paused");
    f.hold(false); await f.chat.resume(first.session.id, first.accessToken);
    await until(f.chat, first, "done");
    assert.deepEqual(f.inputs, [10, 11, 12]);
    assert.equal((await f.chat.get(second.session.id, second.accessToken)).stage, "paused");
  } finally { await f.cleanup(); }
});

test("serialized sends cannot enqueue two turns for one chat", async () => {
  const f = await fixture();
  try {
    const auth = await f.chat.create(); f.hold(true);
    const results = await Promise.allSettled([1, 2].map(() => f.chat.serialize(auth.session.id,
      () => f.chat.send(auth.session.id, auth.accessToken, "hello", 1))));
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.equal((await f.chat.get(auth.session.id, auth.accessToken)).messages.length, 2);
  } finally { await f.cleanup(); }
});

test("restart restores queued work and tolerates an empty interrupted session directory", async () => {
  const f = await fixture(); let restored: SponsoredChat | undefined;
  try {
    const auth = await f.chat.create(); f.hold(true);
    await f.chat.send(auth.session.id, auth.accessToken, "hello", 1);
    await until(f.chat, auth, "running"); await f.chat.shutdown();
    await mkdir(join(f.directory, "00000000-0000-0000-0000-000000000000"));
    f.hold(false); restored = new SponsoredChat(f.config); await restored.start();
    await until(restored, auth, "done"); assert.deepEqual(f.inputs, [10, 11, 12]);
  } finally { await restored?.shutdown(); await f.cleanup(); }
});


test("a generated token is published while the next on-chain token is still running", async () => {
  const f = await fixture(); let unsubscribe: (() => void) | undefined;
  try {
    const auth = await f.chat.create(); f.holdAfter(3);
    const snapshots: { stage: string; text: string }[] = [];
    await assert.rejects(f.chat.subscribe(auth.session.id, "wrong", () => {}));
    unsubscribe = await f.chat.subscribe(auth.session.id, auth.accessToken, value => {
      snapshots.push({ stage: value.stage, text: value.messages[1]?.text ?? "" });
    });
    assert.equal(snapshots[0].stage, "idle");
    await f.chat.send(auth.session.id, auth.accessToken, "hello", 2);
    for (let i = 0; i < 100 && !snapshots.some(value => value.text === "word12"); i++)
      await new Promise(resolve => setTimeout(resolve, 5));
    assert(snapshots.some(value => value.stage === "running" && value.text === "word12"));
    assert(!snapshots.some(value => value.stage === "done"));
    assert.equal((await f.chat.get(auth.session.id, auth.accessToken)).run?.generatedTokens, 1);
    unsubscribe(); unsubscribe = undefined;
    const count = snapshots.length;
    await f.chat.pause(auth.session.id, auth.accessToken);
    assert.equal(snapshots.length, count, "disconnected stream received more snapshots");
  } finally { unsubscribe?.(); await f.cleanup(); }
});
