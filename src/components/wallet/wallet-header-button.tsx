import { useContext } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Context } from "wagmi";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function WalletHeaderButton() {
  const wagmiContext = useContext(Context);

  if (!wagmiContext) {
    return (
      <div className="flex items-center gap-2">
        <Button size="sm" variant="outline" className="text-xs font-medium cursor-pointer">
          Connect Wallet
        </Button>
      </div>
    );
  }

  return (
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        mounted,
      }) => {
        const ready = mounted;
        const connected = ready && account && chain;

        if (!ready) {
          return (
            <div
              aria-hidden="true"
              className="flex items-center gap-2 opacity-0 pointer-events-none select-none"
            >
              <Button size="sm" variant="outline" className="text-xs">
                Connect Wallet
              </Button>
            </div>
          );
        }

        if (!connected) {
          return (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="text-xs font-medium cursor-pointer"
                onClick={openConnectModal}
              >
                Connect Wallet
              </Button>
            </div>
          );
        }

        if (chain.unsupported) {
          return (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="destructive"
                className="text-xs font-medium cursor-pointer"
                onClick={openChainModal}
              >
                Wrong Network
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="font-mono text-xs cursor-pointer"
                onClick={openAccountModal}
              >
                {account.displayName}
              </Button>
            </div>
          );
        }

        return (
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-[11px] font-mono text-muted-foreground font-normal border-border/70 bg-secondary/40 flex items-center gap-1.5">
              <EthereumIcon className="h-3.5 w-auto shrink-0" />
              <span>{chain.id === 11155111 || chain.name?.toLowerCase().includes("sepolia") ? "Ethereum Sepolia" : (chain.name ?? "Ethereum Sepolia")}</span>
            </Badge>
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2.5 font-mono text-xs flex items-center gap-1.5 cursor-pointer hover:bg-secondary/80 border-border/80 shadow-2xs"
              onClick={openAccountModal}
            >
              <span>{account.displayName}</span>
              <span className="text-muted-foreground text-[10px] opacity-70">▾</span>
            </Button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}

function EthereumIcon({ className = "h-3.5 w-auto" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 784.37 1277.39"
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      fillRule="evenodd"
      clipRule="evenodd"
      aria-hidden="true"
    >
      <polygon fill="#343434" className="dark:fill-[#D4D4D8]" fillRule="nonzero" points="392.07,0 383.5,29.11 383.5,873.74 392.07,882.29 784.13,650.54" />
      <polygon fill="#8C8C8C" className="dark:fill-[#A1A1AA]" fillRule="nonzero" points="392.07,0 0,650.54 392.07,882.29 392.07,472.33" />
      <polygon fill="#3C3C3B" className="dark:fill-[#E4E4E7]" fillRule="nonzero" points="392.07,956.52 387.24,962.41 387.24,1263.28 392.07,1277.38 784.37,724.89" />
      <polygon fill="#8C8C8C" className="dark:fill-[#A1A1AA]" fillRule="nonzero" points="392.07,1277.38 392.07,956.52 0,724.89" />
      <polygon fill="#141414" className="dark:fill-[#71717A]" fillRule="nonzero" points="392.07,882.29 784.13,650.54 392.07,472.33" />
      <polygon fill="#393939" className="dark:fill-[#52525B]" fillRule="nonzero" points="0,650.54 392.07,882.29 392.07,472.33" />
    </svg>
  );
}
