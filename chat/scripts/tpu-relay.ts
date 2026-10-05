import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { TESTNET_GENESIS } from "../src/chain/network.ts";
export class TpuRelay {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<
    number,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  readonly ready: Promise<void>;
  private singles: { wire: string; resolve: () => void; reject: (error: Error) => void }[] = [];
  private batchTimer?: ReturnType<typeof setTimeout>;
  constructor(rpc: string, expectedGenesis = TESTNET_GENESIS) {
    const binary =
      process.env.SEA_TPU_RELAY_BIN ??
      resolve(
        import.meta.dirname,
        "../../inference/tpu-relay/target/release/sea-tpu-relay",
      );
    this.child = spawn(binary, [], {
      env: { ...process.env, SEA_RPC_URL: rpc, SEA_EXPECTED_GENESIS: expectedGenesis },
      stdio: "pipe",
    });
    this.ready = new Promise((resolveReady, rejectReady) => {
      const fail = (error: Error) => {
        rejectReady(error);
        for (const p of this.pending.values()) p.reject(error);
        this.pending.clear();
      };
      this.child.on("error", fail);
      this.child.on("exit", (code) =>
        fail(new Error(`TPU relay exited (${code})`)),
      );
      this.child.stderr.on("data", (bytes) => process.stderr.write(bytes));
      createInterface({ input: this.child.stdout }).on("line", (line) => {
        try {
          const value = JSON.parse(line);
          if (value.ready) {
            resolveReady();
            return;
          }
          const request = this.pending.get(value.id);
          if (request) {
            this.pending.delete(value.id);
            if (value.error) request.reject(new Error(value.error));
            else request.resolve();
          }
        } catch {
          fail(new Error("Invalid TPU relay response"));
        }
      });
    });
  }
  async send(wires: string[]) {
    await this.ready;
    if (wires.length < 1 || wires.length > 256)
      throw new Error("Invalid relay batch size");
    if (wires.length === 1) {
      return new Promise<void>((resolve, reject) => {
        this.singles.push({ wire: wires[0], resolve, reject });
        this.batchTimer ??= setTimeout(() => {
          this.batchTimer = undefined;
          while (this.singles.length) {
            const batch = this.singles.splice(0, 256);
            void this.sendBatch(batch.map(item => item.wire)).then(
              () => batch.forEach(item => item.resolve()),
              error => batch.forEach(item => item.reject(error)),
            );
          }
        }, 20);
      });
    }
    return this.sendBatch(wires);
  }
  private sendBatch(wires: string[]) {
    const id = ++this.next;
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(JSON.stringify({ id, wires }) + "\n", (error) => {
        if (error) {
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }
  close() {
    if (this.batchTimer) clearTimeout(this.batchTimer);
    for (const item of this.singles.splice(0)) item.reject(new Error("TPU relay closing"));
    this.child.stdin.end();
  }
}
