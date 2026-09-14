"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useGlobalWallet } from "@/client/wallet/global-wallet-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Copy,
  LogOut,
  Repeat,
  Wallet,
} from "lucide-react";

function shortenAddress(address: string | null): string {
  if (!address) return "";
  if (address.length <= 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletHeaderControl() {
  const {
    status,
    selectedProvider,
    address,
    isSepolia,
    openSelector,
    disconnect,
    switchChain,
  } = useGlobalWallet();

  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const isConnected = status === "CONNECTED" && address !== null;

  useEffect(() => {
    if (!menuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(event.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(event.target as Node)
      ) {
        setMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setMenuOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore clipboard write failures.
    }
  }

  return (
    <div className="flex items-center gap-2.5 relative">
      {/* Network Indicator */}
      {isConnected && !isSepolia ? (
        <Button
          type="button"
          variant="destructive"
          size="sm"
          onClick={() => void switchChain()}
          className="h-8 gap-1.5 text-xs font-medium rounded-full px-3 animate-pulse"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>Wrong network · Switch to Sepolia</span>
        </Button>
      ) : (
        <div className="flex items-center gap-2 px-2.5 py-1 rounded-full bg-secondary/80 border border-border/70 text-xs">
          <Image
            src="/ethereum-logo.svg"
            alt="Ethereum"
            width={9}
            height={14}
            className="h-3.5 w-auto shrink-0"
          />
          <span className="font-medium text-foreground text-[11px] sm:text-xs">Ethereum Sepolia</span>
          <Separator orientation="vertical" className="h-3 bg-border" />
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 font-medium">
            Sandbox
          </Badge>
        </div>
      )}

      {/* Wallet Trigger / Connect Button */}
      {isConnected ? (
        <div className="relative">
          <button
            ref={buttonRef}
            type="button"
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((prev) => !prev)}
            className="flex items-center gap-2 px-3 py-1 rounded-full bg-secondary/90 hover:bg-secondary border border-border/80 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {selectedProvider?.iconDataUri ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={selectedProvider.iconDataUri}
                alt=""
                className="h-3.5 w-3.5 rounded-sm object-contain"
              />
            ) : (
              <Wallet className="h-3.5 w-3.5 text-muted-foreground" />
            )}
            <span className="max-w-[100px] truncate hidden sm:inline">
              {selectedProvider?.displayName ?? "Wallet"}
            </span>
            <span className="text-muted-foreground hidden sm:inline">•</span>
            <span className="font-mono text-[11px] text-foreground">
              {shortenAddress(address)}
            </span>
            <ChevronDown className="h-3 w-3 text-muted-foreground ml-0.5" />
          </button>

          {/* Connected Wallet Dropdown Popover */}
          {menuOpen && (
            <div
              ref={menuRef}
              role="menu"
              className="absolute right-0 mt-2 w-72 rounded-xl border border-border/90 bg-card p-3 shadow-xl z-50 text-xs space-y-3 animate-in fade-in-0 zoom-in-95"
            >
              {/* Provider Info Header */}
              <div className="flex items-center justify-between pb-2 border-b border-border/60">
                <div className="flex items-center gap-2 min-w-0">
                  {selectedProvider?.iconDataUri ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={selectedProvider.iconDataUri}
                      alt=""
                      className="h-4 w-4 rounded-sm object-contain shrink-0"
                    />
                  ) : (
                    <Wallet className="h-4 w-4 text-muted-foreground shrink-0" />
                  )}
                  <span className="font-semibold text-foreground truncate">
                    {selectedProvider?.displayName ?? "Connected Wallet"}
                  </span>
                </div>
                <Badge variant="success" className="text-[10px] px-1.5 py-0">
                  Connected
                </Badge>
              </div>

              {/* Account Address & Copy */}
              <div className="rounded-lg border border-border/60 bg-muted/30 p-2.5 space-y-1.5">
                <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                  <span>Active address</span>
                  <button
                    type="button"
                    onClick={() => void copyAddress()}
                    className="inline-flex items-center gap-1 text-[10px] font-medium text-foreground hover:text-primary transition-colors"
                  >
                    {copied ? (
                      <>
                        <Check className="h-3 w-3 text-emerald-500" />
                        <span className="text-emerald-600 dark:text-emerald-400">Copied</span>
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        <span>Copy address</span>
                      </>
                    )}
                  </button>
                </div>
                <p className="font-mono text-[11px] text-foreground break-all select-all">
                  {address}
                </p>
              </div>

              {/* Network Row */}
              <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
                <span>Network</span>
                <span className="font-medium text-foreground">
                  {isSepolia ? "Ethereum Sepolia (Sandbox)" : "Non-Sepolia Chain"}
                </span>
              </div>

              <Separator />

              {/* Action Buttons */}
              <div className="space-y-1">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    openSelector();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-foreground hover:bg-muted/60 transition-colors text-xs font-medium"
                >
                  <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>Switch wallet</span>
                </button>

                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    disconnect();
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-destructive hover:bg-destructive/10 transition-colors text-xs font-medium"
                >
                  <LogOut className="h-3.5 w-3.5" />
                  <span>Disconnect</span>
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          onClick={openSelector}
          className="h-8 gap-1.5 text-xs font-medium rounded-full px-3.5 shadow-xs"
        >
          <Wallet className="h-3.5 w-3.5" />
          <span>Connect wallet</span>
        </Button>
      )}
    </div>
  );
}
