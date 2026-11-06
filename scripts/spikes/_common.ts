/** Shared helpers for the live Testnet spikes. Never prints secrets. */
import { Asset, Networks } from "@stellar/stellar-sdk";
import { NoirAgentClient, keypairSigner, toStroops, NoirContractError } from "@noirx402/agent-sdk";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

process.loadEnvFile(resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env.local"));

export { NoirAgentClient, toStroops, NoirContractError };
export const XLM = Asset.native().contractId(Networks.TESTNET);
export const client = new NoirAgentClient();

const env = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`missing ${k} in .env.local`);
  return v;
};
export const pub = (role: string) => env(`${role}_PUBLIC`);
export const signer = (role: string) => keypairSigner(env(`${role}_SECRET`));
export const freshHash = () => randomBytes(32).toString("hex");

export const txLink = (hash: string) => `https://stellar.expert/explorer/testnet/tx/${hash}`;
export const log = (...a: unknown[]) => console.log(...a);

/** Run a step; return {ok, hash?} or {ok:false, error shape}. Prints one line. */
export async function step<T extends { hash?: string }>(label: string, fn: () => Promise<T>) {
  try {
    const r = await fn();
    log(`OK   ${label}${r?.hash ? ` ${txLink(r.hash)}` : ""}`);
    return { ok: true as const, value: r };
  } catch (e: any) {
    const shape = {
      class: e?.constructor?.name,
      name: e?.name,
      errorName: e?.errorName,
      code: e?.code,
      contract: e?.contract,
      method: e?.method,
      message: String(e?.message ?? e).slice(0, 300),
    };
    log(`FAIL ${label}`, JSON.stringify(shape));
    return { ok: false as const, error: shape, raw: e };
  }
}
