"use client";

import { useEffect, useRef } from "react";
import { useGlobalWallet } from "@/client/wallet/global-wallet-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AlertCircle, AlertTriangle, Check, Loader2, Wallet, X } from "lucide-react";

export function ConnectWalletModal() {
  const {
    isSelectorOpen,
    closeSelector,
    providers,
    selectedProvider,
    status,
    errorMessage,
    connect,
    connectLegacy,
  } = useGlobalWallet();

  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isSelectorOpen) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeSelector();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => {
      closeButtonRef.current?.focus();
    });

    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isSelectorOpen, closeSelector]);

  if (!isSelectorOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="connect-wallet-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-background/80 backdrop-blur-sm transition-opacity"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSelector();
      }}
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-xl border border-border/90 bg-card p-6 shadow-xl space-y-5 animate-in fade-in-0 zoom-in-95"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 id="connect-wallet-title" className="text-lg font-semibold tracking-tight text-foreground">
              Connect wallet
            </h2>
            <p className="text-xs text-muted-foreground leading-relaxed">
              Select an installed browser wallet to connect to Edict.
            </p>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={closeSelector}
            className="rounded-md p-1.5 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {errorMessage && (
          <div role="alert" className="flex items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive-foreground">
            <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
            <p className="flex-1">{errorMessage}</p>
          </div>
        )}

        <div className="space-y-2">
          {providers.length === 0 ? (
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4 text-center space-y-3">
              <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-full bg-muted/60 text-muted-foreground">
                <Wallet className="h-5 w-5" />
              </div>
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">No EIP-6963 browser wallets detected</p>
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  Install an EIP-6963 compatible wallet such as OKX Wallet, Rabby, or MetaMask.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void connectLegacy()}
                disabled={status === "CONNECTING"}
                className="text-xs h-8"
              >
                Connect legacy injected wallet
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              {providers.map((provider) => {
                const isSelected = selectedProvider?.selectionId === provider.selectionId;
                const isCollision = provider.status === "COLLISION";
                const isConnecting = status === "CONNECTING";

                return (
                  <button
                    key={provider.selectionId}
                    type="button"
                    disabled={isCollision || isConnecting}
                    onClick={() => void connect(provider.selectionId)}
                    className="w-full flex items-center justify-between gap-3 p-3 rounded-lg border border-border/80 bg-background hover:bg-muted/50 transition-colors text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 disabled:cursor-not-allowed group"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      {provider.iconDataUri ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={provider.iconDataUri}
                          alt=""
                          className="h-7 w-7 rounded-md object-contain shrink-0 border border-border/40 p-0.5 bg-muted/20"
                        />
                      ) : (
                        <div className="flex h-7 w-7 items-center justify-center rounded-md bg-muted text-muted-foreground shrink-0">
                          <Wallet className="h-4 w-4" />
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-medium text-foreground block truncate group-hover:text-foreground">
                          {provider.displayName}
                        </span>
                        <span className="text-[10px] text-muted-foreground block truncate font-mono">
                          {provider.rdns ?? "Injected provider"}
                        </span>
                      </div>
                    </div>

                    <div className="shrink-0 flex items-center gap-2">
                      {isSelected ? (
                        <Badge variant="success" className="text-[10px] gap-1 px-1.5 py-0.5">
                          <Check className="h-3 w-3" />
                          <span>Connected</span>
                        </Badge>
                      ) : isCollision ? (
                        <Badge variant="destructive" className="text-[10px] gap-1 px-1.5 py-0.5">
                          <AlertTriangle className="h-3 w-3" />
                          <span>Collision</span>
                        </Badge>
                      ) : isConnecting ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                      ) : (
                        <span className="text-[11px] text-muted-foreground group-hover:text-foreground transition-colors">
                          Connect →
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="pt-2 border-t border-border/60 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>Standard EIP-6963 discovery</span>
          <span>Never asks for private keys</span>
        </div>
      </div>
    </div>
  );
}
