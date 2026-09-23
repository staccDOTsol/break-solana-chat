import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
export class TpuRelay {
  private child: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<
    number,
    { resolve: () => void; reject: (e: Error) => void }
  >();
  readonly ready: Promise<void>;
  constructor(rpc: string) {
    const binary =
      process.env.SEA_TPU_RELAY_BIN ??
      resolve(
        import.meta.dirname,
        "../../inference/tpu-relay/target/release/sea-tpu-relay",
      );
    this.child = spawn(binary, [], {
      env: { ...process.env, SOLANA_TESTNET_RPC: rpc },
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
    this.child.stdin.end();
  }
}
