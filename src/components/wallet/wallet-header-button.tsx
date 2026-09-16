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
        <Badge variant="outline" className="text-xs text-muted-foreground">
          Ethereum Sepolia
        </Badge>
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
              <Badge variant="outline" className="text-xs">
                Ethereum Sepolia
              </Badge>
              <Button size="sm" variant="outline" className="text-xs">
                Connect Wallet
              </Button>
            </div>
          );
        }

        if (!connected) {
          return (
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs text-muted-foreground">
                Ethereum Sepolia
              </Badge>
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
            <Badge variant="outline" className="text-xs text-muted-foreground font-normal">
              {chain.name ?? "Ethereum Sepolia"}
            </Badge>
            <Button
              size="sm"
              variant="outline"
              className="font-mono text-xs flex items-center gap-1.5 cursor-pointer hover:bg-muted/50"
              onClick={openAccountModal}
            >
              <span>{account.displayName}</span>
              <span className="text-muted-foreground text-[10px]">▾</span>
            </Button>
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
}
