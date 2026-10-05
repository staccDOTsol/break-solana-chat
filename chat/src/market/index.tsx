import { createRoot } from "react-dom/client";
import { WalletProvider } from "@solana/wallet-adapter-react";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import { ModelMarket } from "./ModelMarket";
import { ModelTrade } from "./ModelTrade";
import "./market.css";

const wallets = [new PhantomWalletAdapter(), new SolflareWalletAdapter()];

export function mountMarket(element: HTMLElement) {
  createRoot(element).render(
    <WalletProvider wallets={wallets} autoConnect>
      <div className="model-market-grid">
        <ModelMarket />
        <ModelTrade />
      </div>
    </WalletProvider>,
  );
}
