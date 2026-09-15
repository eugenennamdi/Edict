"use client";

import "client-only";

import type { EdictEip1193Provider } from "@/shared/wallet";
import { WalletBoundaryError } from "./errors";
import { SelectedWalletSession } from "./session";

export function isEip1193Provider(candidate: unknown): candidate is EdictEip1193Provider {
  return (
    candidate !== null &&
    typeof candidate === "object" &&
    "request" in candidate &&
    typeof (candidate as { request?: unknown }).request === "function"
  );
}

export function createEdictWalletSession(
  selectionId: string,
  rawProvider: unknown,
): SelectedWalletSession {
  if (!isEip1193Provider(rawProvider)) {
    throw new WalletBoundaryError("PROVIDER_UNAVAILABLE");
  }
  return new SelectedWalletSession(selectionId, "EIP6963", rawProvider);
}
