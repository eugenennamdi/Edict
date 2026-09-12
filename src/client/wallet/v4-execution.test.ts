import { describe, expect, it, vi } from "vitest";
import type { WalletExecutionHttpGateway } from "@/client/run-api/wallet-execution-gateway";
import type { EdictEip1193Provider, SendAuthorizedEnvelopeV1 } from "@/shared/wallet";
import { SelectedWalletSession } from "./session";
import { executeSendAuthorizedEnvelopeFromUserAction } from "./v4-execution";

const SIGNER = "0x1111111111111111111111111111111111111111";
const OTHER = "0x2222222222222222222222222222222222222222";
const HASH = `0x${"ab".repeat(32)}`;

const envelope: SendAuthorizedEnvelopeV1 = Object.freeze({
  domain: "edict.send-authorized-envelope.v1",
  expectedRevision: 9,
  invocationAttemptId: "inv-test-1",
  walletIntentHash: `sha256:${"cd".repeat(32)}`,
  requiredSigner: SIGNER,
  chainRequirement: Object.freeze({ decimalChainId: "11155111", rpcChainId: "0xaa36a7" }),
  walletRequest: Object.freeze({
    from: SIGNER,
    to: "0x3333333333333333333333333333333333333333",
    data: "0x12345678",
    value: "0x0",
    nonce: "0x7",
    gas: "0x5208",
    type: "0x2",
    maxFeePerGas: "0x20",
    maxPriorityFeePerGas: "0x2",
  }),
});

class Provider implements EdictEip1193Provider {
  accounts = [OTHER, SIGNER];
  chainId = "0xaa36a7";
  sendResult: unknown = HASH;
  sendError: unknown = null;
  onSend: (() => void) | null = null;
  onAccountRead: ((readNumber: number) => void) | null = null;
  onChainRead: ((readNumber: number) => void) | null = null;
  accountReads = 0;
  chainReads = 0;
  readonly calls: Array<{ method: string; params?: readonly unknown[] | Record<string, unknown> }> = [];
  readonly listeners = new Map<string, Set<(...args: readonly unknown[]) => void>>();

  readonly request = vi.fn(async (request: { method: string; params?: readonly unknown[] | Record<string, unknown> }) => {
    this.calls.push(request);
    if (request.method === "eth_accounts" || request.method === "eth_requestAccounts") {
      this.accountReads += 1;
      this.onAccountRead?.(this.accountReads);
      return this.accounts;
    }
    if (request.method === "eth_chainId") {
      this.chainReads += 1;
      this.onChainRead?.(this.chainReads);
      return this.chainId;
    }
    if (request.method === "wallet_switchEthereumChain") {
      this.chainId = "0xaa36a7";
      return null;
    }
    if (request.method === "eth_sendTransaction") {
      this.onSend?.();
      if (this.sendError !== null) throw this.sendError;
      return this.sendResult;
    }
    throw new Error("unexpected provider request");
  });

  on = (event: string, listener: (...args: readonly unknown[]) => void) => {
    const values = this.listeners.get(event) ?? new Set();
    values.add(listener);
    this.listeners.set(event, values);
  };
  removeListener = (event: string, listener: (...args: readonly unknown[]) => void) => {
    this.listeners.get(event)?.delete(listener);
  };
  emit(event: string) {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function harness(provider = new Provider()) {
  const hashes: unknown[] = [];
  const unknowns: unknown[] = [];
  let authorityAvailable = true;
  const gateway: WalletExecutionHttpGateway = {
    authorize: vi.fn(async () => {
      if (!authorityAvailable) throw new Error("revision conflict");
      authorityAvailable = false;
      return envelope;
    }),
    ingestHash: vi.fn(async (_runId, input) => {
      hashes.push(input);
      return {} as never;
    }),
    recordUnknown: vi.fn(async (_runId, input) => {
      unknowns.push(input);
      return {} as never;
    }),
  };
  return {
    provider,
    gateway,
    hashes,
    unknowns,
    wallet: new SelectedWalletSession("wallet-1", "EIP6963", provider),
  };
}

function execute(value: ReturnType<typeof harness>) {
  return executeSendAuthorizedEnvelopeFromUserAction({
    runId: "11111111-1111-4111-8111-111111111111",
    expectedRevision: 8,
    requiredSigner: SIGNER,
    wallet: value.wallet,
    gateway: value.gateway,
  });
}

function sends(provider: Provider) {
  return provider.calls.filter((call) => call.method === "eth_sendTransaction");
}

describe("V4 browser wallet execution coordinator", () => {
  it("accepts the required signer at a later account index and sends the exact nonce-bearing request once", async () => {
    const value = harness();
    await expect(execute(value)).resolves.toEqual({ outcome: "BROADCAST_RECORDED", txHash: HASH });
    expect(sends(value.provider)).toHaveLength(1);
    expect(sends(value.provider)[0]?.params).toEqual([envelope.walletRequest]);
    expect((sends(value.provider)[0]?.params as readonly [Record<string, unknown>])[0].nonce).toBe("0x7");
    expect(value.provider.calls.slice(-3).map(({ method }) => method)).toEqual([
      "eth_chainId",
      "eth_accounts",
      "eth_sendTransaction",
    ]);
    expect(value.hashes).toEqual([{
      expectedRevision: 9,
      invocationAttemptId: "inv-test-1",
      walletIntentHash: envelope.walletIntentHash,
      txHash: HASH,
    }]);
  });

  it("switches Sepolia explicitly and rechecks before sending", async () => {
    const provider = new Provider();
    provider.chainId = "0x1";
    const value = harness(provider);
    await execute(value);
    expect(provider.calls.map(({ method }) => method).filter((method) =>
      ["wallet_switchEthereumChain", "eth_sendTransaction"].includes(method)
    )).toEqual(["wallet_switchEthereumChain", "eth_sendTransaction"]);
  });

  it("fails a missing required signer before authority release or provider invocation", async () => {
    const value = harness();
    value.provider.accounts = [OTHER];
    await expect(execute(value)).rejects.toMatchObject({ code: "REQUIRED_ACCOUNT_UNAVAILABLE" });
    expect(value.gateway.authorize).not.toHaveBeenCalled();
    expect(sends(value.provider)).toHaveLength(0);
  });

  it("turns account or provider-generation changes after authority release into reconciliation without sending", async () => {
    for (const change of ["account", "generation"] as const) {
      const value = harness();
      vi.mocked(value.gateway.authorize).mockImplementationOnce(async () => {
        if (change === "account") value.provider.accounts = [OTHER];
        else value.provider.emit("accountsChanged");
        return envelope;
      });
      await expect(execute(value)).rejects.toMatchObject({ code: "BROADCAST_OUTCOME_UNKNOWN" });
      expect(sends(value.provider)).toHaveLength(0);
      expect(value.unknowns).toHaveLength(1);
    }
  });

  it.each(["chain", "account", "generation"] as const)(
    "fails closed when the latest injectable %s state changes before the one send invocation",
    async (change) => {
      const value = harness();
      if (change === "chain") {
        value.provider.onChainRead = (readNumber) => {
          if (readNumber === 3) {
            value.provider.chainId = "0x1";
            value.provider.emit("chainChanged");
          }
        };
      } else {
        value.provider.onAccountRead = (readNumber) => {
          if (readNumber !== 3) return;
          if (change === "account") {
            value.provider.accounts = [OTHER];
            value.provider.emit("accountsChanged");
          } else value.provider.emit("disconnect");
        };
      }
      await expect(execute(value)).rejects.toMatchObject({ code: "BROADCAST_OUTCOME_UNKNOWN" });
      expect(sends(value.provider)).toHaveLength(0);
      expect(value.unknowns).toHaveLength(1);
    },
  );

  it.each([
    ["4001", Object.assign(new Error("rejected"), { code: 4001 }), "PROVIDER_4001"],
    ["provider error", new Error("provider failed"), "PROVIDER_ERROR"],
  ])("records %s as BROADCAST_UNKNOWN and never retries", async (_label, error, reason) => {
    const value = harness();
    value.provider.sendError = error;
    await expect(execute(value)).rejects.toMatchObject({ code: "BROADCAST_OUTCOME_UNKNOWN" });
    await expect(execute(value)).rejects.toMatchObject({ code: "AUTHORIZATION_REQUEST_REFUSED" });
    expect(sends(value.provider)).toHaveLength(1);
    expect(value.unknowns).toEqual([expect.objectContaining({ reason })]);
  });

  it("treats a never-settling provider request as ambiguous and does not retry", async () => {
    const value = harness();
    let expire: (() => void) | null = null;
    let sent: (() => void) | null = null;
    const invoked = new Promise<void>((resolve) => { sent = resolve; });
    value.provider.request.mockImplementation(async (request) => {
      value.provider.calls.push(request);
      if (request.method === "eth_accounts") return value.provider.accounts;
      if (request.method === "eth_chainId") return value.provider.chainId;
      if (request.method === "eth_sendTransaction") {
        sent?.();
        return new Promise<never>(() => undefined);
      }
      throw new Error("unexpected provider request");
    });
    const wallet = new SelectedWalletSession("wallet-timeout", "EIP6963", value.provider, {
      timers: {
        setTimeout(callback, delayMs) {
          if (delayMs === 1) expire = callback;
          return delayMs;
        },
        clearTimeout: vi.fn(),
      },
      deadlinesMs: { sendTransaction: 1 },
    });
    const pending = execute({ ...value, wallet });
    await invoked;
    (expire as unknown as () => void)();
    await expect(pending).rejects.toMatchObject({ code: "BROADCAST_OUTCOME_UNKNOWN" });
    expect(sends(value.provider)).toHaveLength(1);
    expect(value.unknowns).toEqual([expect.objectContaining({ reason: "PROVIDER_TIMEOUT" })]);
  });

  it("treats a malformed returned hash and a lost hash response as ambiguous", async () => {
    const malformed = harness();
    malformed.provider.sendResult = "0x0";
    await expect(execute(malformed)).rejects.toMatchObject({ code: "BROADCAST_OUTCOME_UNKNOWN" });
    expect(malformed.unknowns).toEqual([expect.objectContaining({ reason: "PROVIDER_ERROR" })]);

    const lost = harness();
    vi.mocked(lost.gateway.ingestHash).mockRejectedValueOnce(new Error("response lost"));
    await expect(execute(lost)).rejects.toMatchObject({ code: "BROADCAST_OUTCOME_UNKNOWN" });
    expect(sends(lost.provider)).toHaveLength(1);
    expect(lost.unknowns).toEqual([
      expect.objectContaining({ reason: "HASH_PERSISTENCE_UNCONFIRMED" }),
    ]);
  });

  it("canonicalizes a mixed-case provider hash before durable ingestion", async () => {
    const value = harness();
    value.provider.sendResult = `0x${"Ab".repeat(32)}`;
    await expect(execute(value)).resolves.toEqual({ outcome: "BROADCAST_RECORDED", txHash: HASH });
    expect(value.hashes).toEqual([expect.objectContaining({ txHash: HASH })]);
  });

  it("allows one send across repeated clicks, concurrent coordinators, and a retrying authorization request", async () => {
    const value = harness();
    const results = await Promise.allSettled([execute(value), execute(value)]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(sends(value.provider)).toHaveLength(1);
  });
});
