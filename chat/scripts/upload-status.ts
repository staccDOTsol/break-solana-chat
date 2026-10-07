import { readFileSync, renameSync, writeFileSync } from "node:fs";

export function writeUploadStatus(path: string, status: object) {
  writeFileSync(path + ".tmp", JSON.stringify(status) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}

export function readUploadStatus(path: string, now = Date.now()) {
  const status = JSON.parse(readFileSync(path, "utf8"));
  if (!status.running || status.complete) return status;
  let alive = false;
  if (Number.isInteger(status.pid) && status.pid > 0) {
    try {
      process.kill(status.pid, 0);
      alive = true;
    } catch {
      // A saved status file can outlive its uploader or a machine reboot.
    }
  }
  const age = now - Date.parse(status.updatedAt);
  if (!alive || !Number.isFinite(age) || age < 0 || age > 90_000)
    return {
      ...status,
      running: false,
      stale: true,
      error: !alive
        ? "Uploader process is absent; resume from saved offsets"
        : "Uploader heartbeat is stale; check the process before resuming",
    };
  return status;
}
