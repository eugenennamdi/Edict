import { PHASE8_ACTIONS, PHASE8_OPERATIONS, type Phase8Action, type Phase8Operation, type Phase8PublicTarget } from "./types";
import type { Phase8ActionEvidenceV1 } from "./evidence";
import { Phase8OutputCollisionError } from "./safe-terminal";

export const PHASE8_BOOTSTRAP_OUTPUT_PREFIX = "Edict Phase 8 one-time bootstrap secret: ";
export const PHASE8_ARGUMENT_ERROR_OUTPUT =
  '{"ok":false,"error":{"code":"PHASE8_ARGUMENTS_REFUSED"}}\n';
export const PHASE8_START_ERROR_OUTPUT =
  '{"ok":false,"error":{"code":"PHASE8_CLI_START_FAILED"}}\n';

export const BRICKKEN_READ_LIMITATIONS = Object.freeze([
  "Proves only that a credential-bearing Brickken sandbox network-information request succeeded.",
  "Does not prove signer approval, license status, remaining credits, prepare eligibility, wallet compatibility, write capability, or blockchain execution readiness.",
] as const);

export const BRICKKEN_READ_REDACTIONS = Object.freeze([
  "CREDENTIALS",
  "RAW_EXTERNAL_RESPONSES",
  "REQUEST_RESPONSE_HEADERS",
  "DATABASE_RPC_URLS",
  "RUN_CAPABILITIES",
  "CHALLENGE_TOKENS",
  "APPROVAL_SIGNATURES",
  "PRIVATE_SIGNING_MATERIAL",
  "TOKENIZER_EMAIL",
  "CLAIMED_SIGNER_IDENTITY",
  "COMPLETE_PREPARED_TRANSACTIONS",
  "COMPLETE_CALLDATA",
] as const);

export const PHASE8_HARNESS_PAGE = `<!doctype html><meta charset="utf-8"><title>Edict Phase 8 Harness</title>
<style>body{font:16px system-ui;max-width:52rem;margin:3rem auto;padding:0 1rem}button,input{font:inherit;margin:.4rem;padding:.6rem}pre{white-space:pre-wrap}</style>
<h1>Edict Phase 8 one-action harness</h1><p id="target">Authenticate to reveal the fixed action target.</p>
<label>One-time bootstrap secret <input id="secret" type="password" autocomplete="off" maxlength="256"></label>
<button id="login">Establish session</button><button id="arm" disabled>Arm exact action</button>
<button id="execute" disabled>Execute once</button><button id="stop" disabled>Stop</button><pre id="status"></pre>
<script>'use strict';let target=null,csrfToken=null,grantId=null;
const status=document.getElementById('status');
async function post(path,value){const response=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(value)});const result=await response.json();status.textContent=JSON.stringify(result);return result}
document.getElementById('login').onclick=async()=>{const input=document.getElementById('secret');const result=await post('/session',{bootstrapSecret:input.value});input.value='';if(result.ok){target=result.target;csrfToken=result.csrfToken;document.getElementById('target').textContent=JSON.stringify(target);document.getElementById('arm').disabled=false;document.getElementById('stop').disabled=false}};
document.getElementById('arm').onclick=async()=>{if(target===null)return;const result=await post('/arm',{csrfToken,...target});if(result.ok){grantId=result.grantId;document.getElementById('execute').disabled=false;document.getElementById('arm').disabled=true}};
document.getElementById('execute').onclick=async()=>{document.getElementById('execute').disabled=true;await post('/execute',{csrfToken,grantId,confirmation:'EXECUTE'})};
document.getElementById('stop').onclick=async()=>{await post('/stop',{csrfToken})};</script>`;

// These definitions generate both actual responses and their preflight inventory.
export const PHASE8_PUBLIC_ERRORS = Object.freeze([
  "ORIGIN_REFUSED", "HOST_REFUSED", "NOT_FOUND", "HARNESS_STOPPED", "SESSION_REFUSED",
  "BAD_REQUEST", "BOOTSTRAP_REFUSED", "ARM_REFUSED", "EXECUTE_REFUSED",
  "ACTION_DEADLINE_EXCEEDED", "ACTION_FAILED",
] as const);
export type Phase8PublicError = (typeof PHASE8_PUBLIC_ERRORS)[number];
export const PHASE8_COOKIE_NAME = "edict_phase8_session";
export const PHASE8_SESSION_TTL_MS = 15 * 60 * 1_000;
export const PHASE8_JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
});
export const PHASE8_HTML_HEADERS = Object.freeze({
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
});
export function phase8SessionHeaders(token: string) {
  return { "set-cookie": `${PHASE8_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${PHASE8_SESSION_TTL_MS / 1_000}` };
}
export const BRICKKEN_READ_DETAILS = Object.freeze({
  checkKind: "BRICKKEN_SANDBOX_NETWORK_INFO", checkVersion: "1.0", environment: "sandbox",
  requestedChainId: "11155111", currencyName: "Sepolia ETH", blockExplorerHost: "sepolia.etherscan.io",
  credentialBearingRequestSucceeded: true, resultCategory: "BRICKKEN_NETWORK_READ_PASSED",
  adapterVersion: "1.0", sdkVersion: "0.2.1",
} as const);
export function brickkenReadEvidence(input: {
  observedAt: string; runId: string; operation: Phase8Operation; resultFingerprint: `sha256:${string}`;
}): Phase8ActionEvidenceV1 {
  return {
    evidenceVersion: "1.0", harnessVersion: "1.0", observedAt: input.observedAt,
    action: "BRICKKEN_READ", runId: input.runId, operation: input.operation, walletRequestHash: null,
    evidenceStatus: "PASSED", resultFingerprint: input.resultFingerprint, details: BRICKKEN_READ_DETAILS,
    limitations: [...BRICKKEN_READ_LIMITATIONS], redactions: [...BRICKKEN_READ_REDACTIONS],
  };
}
export const phase8Bodies = Object.freeze({
  error: (code: Phase8PublicError) => ({ ok: false, error: { code } }),
  session: (csrfToken: string, target: Phase8PublicTarget) => ({ ok: true, csrfToken, target }),
  arm: (grantId: string, target: Phase8PublicTarget) => ({ ok: true, grantId, target }),
  execute: (action: Phase8Action, evidence: Phase8ActionEvidenceV1) => ({ ok: true, category: action, evidence }),
  stopped: () => ({ ok: true, category: "HARNESS_STOPPED" }),
});

// Used by every application response, including HTML and server-level fallbacks.
// Check the fully merged, normalized headers, not only caller-supplied overrides.
export function phase8Response(status: number, body: string, headers: HeadersInit, sensitive: readonly string[]): Response {
  const normalized = new Headers(headers);
  const publicValues = [body, JSON.stringify([...normalized]), ...[...normalized].flat()];
  if (sensitive.some((secret) => secret.length === 0 || publicValues.some((value) => value.includes(secret)))) {
    throw new Phase8OutputCollisionError();
  }
  return new Response(body, { status, headers: normalized });
}

// A marker denotes unpredictable fields; splitting serialized samples preserves
// every fixed fragment, including quotes, separators and adjacent fixed fields.
const DYNAMIC = "@@PHASE8_DYNAMIC@@";
function inventoryFragments(value: unknown): string[] {
  const serialized = JSON.stringify(value);
  const result = serialized.split(DYNAMIC).filter(Boolean);
  if (typeof value === "string") result.push(...value.split(DYNAMIC).filter(Boolean));
  else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) result.push(key, ...inventoryFragments(child));
  }
  return result;
}
export function phase8Target(action: Phase8Action, runId: string, operation: Phase8Operation, walletRequestHash: `sha256:${string}` | null): Phase8PublicTarget {
  return Object.freeze({ action, runId, operation, walletRequestHash });
}
function responseSamples(targets: readonly Phase8PublicTarget[]): unknown[] {
  // Adding a response builder requires adding its preflight sample here.
  const bodies: Record<keyof typeof phase8Bodies, unknown[]> = {
    error: PHASE8_PUBLIC_ERRORS.map(phase8Bodies.error), session: [], arm: [], execute: [],
    stopped: [phase8Bodies.stopped()],
  };
  for (const target of targets) {
    const evidence = brickkenReadEvidence({ observedAt: DYNAMIC, runId: target.runId, operation: target.operation, resultFingerprint: DYNAMIC as `sha256:${string}` });
    bodies.session.push(phase8Bodies.session(DYNAMIC, target));
    bodies.arm.push(phase8Bodies.arm(DYNAMIC, target));
    bodies.execute.push(phase8Bodies.execute(target.action, evidence));
  }
  const headers = [PHASE8_JSON_HEADERS, PHASE8_HTML_HEADERS, phase8SessionHeaders(DYNAMIC)]
    .flatMap((value) => [value, [...new Headers(value)]]);
  return [...headers, ...Object.values(bodies).flat()];
}
export function phase8PublicOutputsForTarget(target: Phase8PublicTarget): string[] {
  return responseSamples([target]).flatMap(inventoryFragments);
}
export const PHASE8_STATIC_PUBLIC_OUTPUTS: readonly string[] = Object.freeze([...new Set([
  PHASE8_BOOTSTRAP_OUTPUT_PREFIX, PHASE8_ARGUMENT_ERROR_OUTPUT, PHASE8_START_ERROR_OUTPUT,
  PHASE8_HARNESS_PAGE, ...responseSamples(PHASE8_ACTIONS.flatMap((action) => PHASE8_OPERATIONS.map((operation) => phase8Target(action, DYNAMIC, operation, null)))).flatMap(inventoryFragments),
])]);

export function renderHarnessPage(): string {
  return PHASE8_HARNESS_PAGE;
}
