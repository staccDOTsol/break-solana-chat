import { createDefaultRpcTransport, createSolanaRpc, type RpcTransport, type RpcResponse } from "@solana/kit";
import { TESTNET_GENESIS } from "./network.ts";
type Config = Parameters<RpcTransport>[0];
export const rpcErrorText = (value: unknown) => JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);

// Configuration is operator-owned. Gossip discovery is a separate, bounded
// read-only check; visitors cannot supply RPC URLs to this service.
export async function verifyRpcEndpoints(urls: string[], referenceUrl: string, expectedGenesis = TESTNET_GENESIS): Promise<string[]> {
  const reference = createSolanaRpc(referenceUrl);
  const options = { abortSignal: AbortSignal.timeout(5000) };
  const [referenceGenesis, slot] = await Promise.all([
    reference.getGenesisHash().send(options),
    reference.getSlot({ commitment: "confirmed" }).send(options),
  ]);
  if (referenceGenesis !== expectedGenesis) throw new Error("Reference RPC genesis mismatch");
  const results = await Promise.allSettled([...new Set(urls)].slice(0, 3).map(async url => {
    const rpc = createSolanaRpc(url), options = { abortSignal: AbortSignal.timeout(5000) };
    const [genesis, health, current] = await Promise.all([
      rpc.getGenesisHash().send(options), rpc.getHealth().send(options),
      rpc.getSlot({ commitment: "confirmed" }).send(options),
    ]);
    if (genesis !== expectedGenesis || health !== "ok" || current < slot - 64n) throw new Error("RPC is unhealthy, behind, or on another chain");
    return url;
  }));
  return results.flatMap(result => result.status === "fulfilled" ? [result.value] : []);
}

function endpoint(url: string): RpcTransport {
  const base = createDefaultRpcTransport({ url });
  let sendQueue = Promise.resolve(), pauseUntil = 0, active = 0;
  const waiters: (() => void)[] = [];
  return async <T>(config: Config) => {
    const method = (config.payload as { method?: string }).method;
    if (Date.now() < pauseUntil) throw new Error("RPC cooling down");
    if (method === "sendTransaction") {
      // Bound fanout per provider; reads must not sit behind a wave of writes.
      sendQueue = sendQueue.then(() => new Promise(resolve => setTimeout(resolve, 50)));
      await sendQueue;
      if (active >= 8) await new Promise<void>(resolve => waiters.push(resolve));
      else active++;
    }
    try {
      config.signal?.throwIfAborted();
      if (Date.now() < pauseUntil) throw new Error("RPC cooling down");
      const signal = config.signal ? AbortSignal.any([config.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
      const value = await base<T>({ ...config, signal });
      if (value && typeof value === "object" && "error" in value) throw new Error(rpcErrorText(value.error));
      return value;
    } catch (error) {
      // Do not back off a provider because another raced read won and aborted.
      if (!config.signal?.aborted) pauseUntil = Date.now() + 5000;
      throw error;
    } finally {
      if (method === "sendTransaction") { const next = waiters.shift(); if (next) next(); else active--; }
    }
  };
}

export function raceTransports(peers: RpcTransport[], fallback: RpcTransport, stripeWrites = false): RpcTransport {
  const sends = new Map<string, Promise<unknown>>();
  let nextWriter = 0;
  return async <T>(config: Config) => {
    const payload = config.payload as { method?: string; params?: unknown[] };
    const wire = payload.method === "sendTransaction" ? String(payload.params?.[0]) : undefined;
    const cached = wire && sends.get(wire);
    if (cached) return cached as Promise<RpcResponse<T>>;
    const operation = (async () => {
      if (!peers.length) return fallback<T>(config);
      if (wire && stripeWrites) {
        // Different transactions use different RPC queues. The caller races
        // each with TPU delivery; RPC failures fail over using the same bytes.
        // Broadcasting every slice to every RPC would cap useful throughput
        // at one provider's allowance, even with many peers available.
        const start = nextWriter++ % peers.length;
        for (let offset = 0; offset < peers.length; offset++) {
          try { return await peers[(start + offset) % peers.length]<T>(config); }
          catch { config.signal?.throwIfAborted(); }
        }
        return fallback<T>(config);
      }
      // A fast null status is not a confirmation. Give the other peers a
      // chance to return evidence before falling back to the empty response.
      let empty: Awaited<ReturnType<RpcTransport>> | undefined;
      const requests = peers.map(async peer => {
        const result = await peer<T>(config);
        if (payload.method === "getSignatureStatuses") {
          const response = result as { result?: { value?: ({ confirmationStatus?: string } | null)[] } };
          if (!response.result?.value?.some(value => value?.confirmationStatus === "confirmed" || value?.confirmationStatus === "finalized")) {
            empty ??= result; throw new Error("Confirmation not observed yet");
          }
        }
        return result;
      });
      try { return await Promise.any(requests); }
      catch { return empty ?? await fallback<T>(config); }
    })();
    if (wire) {
      sends.set(wire, operation);
      void operation.finally(() => { if (sends.get(wire) === operation) sends.delete(wire); }).catch(() => {});
    }
    return operation as Promise<RpcResponse<T>>;
  };
}

export const createRacingRpcTransport = (urls: string[], fallback: RpcTransport, stripeWrites = true) => raceTransports(urls.slice(0, 3).map(endpoint), fallback, stripeWrites);
