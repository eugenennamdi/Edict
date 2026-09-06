import { PHASE8_ACTIONS, PHASE8_OPERATIONS } from "./types";

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

const RUNTIME_STATIC_TOKENS = [
  "ok", "error", "code", "csrfToken", "target", "grantId", "category", "evidence",
  "bootstrapSecret", "action", "runId", "operation", "walletRequestHash", "confirmation",
  "ORIGIN_REFUSED", "HOST_REFUSED", "NOT_FOUND", "HARNESS_STOPPED", "SESSION_REFUSED",
  "BAD_REQUEST", "BOOTSTRAP_REFUSED", "ARM_REFUSED", "EXECUTE_REFUSED",
  "ACTION_DEADLINE_EXCEEDED", "ACTION_FAILED", "EXECUTE", "edict_phase8_session",
] as const;

const EVIDENCE_STATIC_TOKENS = [
  "evidenceVersion", "harnessVersion", "observedAt", "evidenceStatus", "resultFingerprint",
  "details", "limitations", "redactions", "PASSED", "checkKind", "checkVersion",
  "environment", "requestedChainId", "currencyName", "blockExplorerHost",
  "credentialBearingRequestSucceeded", "resultCategory", "adapterVersion", "sdkVersion",
  "BRICKKEN_SANDBOX_NETWORK_INFO", "1.0", "sandbox", "11155111", "Sepolia ETH",
  "sepolia.etherscan.io", "BRICKKEN_NETWORK_READ_PASSED", "0.2.1",
] as const;

export const PHASE8_STATIC_PUBLIC_OUTPUTS = Object.freeze([
  PHASE8_BOOTSTRAP_OUTPUT_PREFIX,
  PHASE8_ARGUMENT_ERROR_OUTPUT,
  PHASE8_START_ERROR_OUTPUT,
  PHASE8_HARNESS_PAGE,
  ...RUNTIME_STATIC_TOKENS,
  ...EVIDENCE_STATIC_TOKENS,
  ...PHASE8_ACTIONS,
  ...PHASE8_OPERATIONS,
  ...BRICKKEN_READ_LIMITATIONS,
  ...BRICKKEN_READ_REDACTIONS,
] as const);

export function renderHarnessPage(): string {
  return PHASE8_HARNESS_PAGE;
}
