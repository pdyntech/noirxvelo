import { Keypair } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it } from "vitest";
import { env, missingChainEnv, ROLE_KEYS } from "./env.js";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

function setWallets(edit: (name: string, value: string) => string = (_n, v) => v): void {
  for (const r of ROLE_KEYS) {
    const kp = Keypair.random();
    process.env[`${r}_PUBLIC`] = edit(`${r}_PUBLIC`, kp.publicKey());
    process.env[`${r}_SECRET`] = edit(`${r}_SECRET`, kp.secret());
  }
}

describe("env", () => {
  it("forgives quotes, spaces and a pasted NAME= prefix", () => {
    process.env.X_TEST = '  "abc"  ';
    expect(env("X_TEST")).toBe("abc");
    process.env.X_TEST = "X_TEST=abc";
    expect(env("X_TEST")).toBe("abc");
    process.env.X_TEST = "'abc'";
    expect(env("X_TEST")).toBe("abc");
    process.env.X_TEST = "  ";
    expect(env("X_TEST")).toBeUndefined();
  });
});

describe("missingChainEnv", () => {
  it("is empty for valid, matching wallets, even when pasted with quotes", () => {
    setWallets((_n, v) => `"${v}"`);
    expect(missingChainEnv()).toEqual([]);
  });

  it("names a missing key", () => {
    setWallets();
    delete process.env.LP_SECRET;
    expect(missingChainEnv()).toEqual(["LP_SECRET"]);
  });

  it("names a malformed key instead of failing later", () => {
    setWallets((n, v) => (n === "AGENT_SECRET" ? v.slice(0, -1) + "!" : v));
    expect(missingChainEnv()).toEqual(["AGENT_SECRET is not a valid Stellar secret key"]);
    setWallets((n, v) => (n === "TREASURY_PUBLIC" ? v.toLowerCase() : v));
    expect(missingChainEnv()).toEqual(["TREASURY_PUBLIC is not a valid Stellar address"]);
  });

  it("names a public key that belongs to a different secret", () => {
    setWallets((n, v) => (n === "SHIPOWNER_PUBLIC" ? Keypair.random().publicKey() : v));
    expect(missingChainEnv()).toEqual(["SHIPOWNER_PUBLIC does not match SHIPOWNER_SECRET"]);
  });
});
