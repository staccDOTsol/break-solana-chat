import { createSignerFromKeyPair } from "@solana/kit";
import { createWallet, type Wallet } from "./chain/engine.ts";
const database = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("break-testnet-wallet", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("wallets");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
export async function saveWallet(registry: string, wallet: Wallet) {
  const db = await database();
  const pairs = {
    authority: wallet.authority.keyPair,
    state: wallet.state.keyPair,
    workers: wallet.workers.map((k) => k.keyPair),
    payers: wallet.payers.map((k) => k.keyPair),
  };
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("wallets", "readwrite");
    tx.objectStore("wallets").put(pairs, registry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
export async function loadWallet(registry: string): Promise<Wallet> {
  const db = await database();
  const pairs = await new Promise<
    | {
        authority: CryptoKeyPair;
        state: CryptoKeyPair;
        workers: CryptoKeyPair[];
        payers: CryptoKeyPair[];
      }
    | undefined
  >((resolve, reject) => {
    const request = db
      .transaction("wallets")
      .objectStore("wallets")
      .get(registry);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  if (!pairs) {
    const wallet = await createWallet();
    await saveWallet(registry, wallet);
    return wallet;
  }
  return {
    authority: await createSignerFromKeyPair(pairs.authority),
    state: await createSignerFromKeyPair(pairs.state),
    workers: await Promise.all(pairs.workers.map(createSignerFromKeyPair)),
    payers: await Promise.all(pairs.payers.map(createSignerFromKeyPair)),
  };
}
