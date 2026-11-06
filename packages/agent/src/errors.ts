import { NoirContractError } from "@noirx402/agent-sdk";

export type KnownChainErrorName =
  | "AlreadyRegistered"
  | "InvalidAsset"
  | "AgentNotAuthorized"
  | "InsufficientBalance"
  | "NothingToClaim";

export interface ChainErrorInit {
  errorName?: string;
  code?: number;
  contract?: string;
  method?: string;
  cause?: unknown;
}

/** Typed error for any failure coming out of the Noir SDK. */
export class ChainError extends Error {
  readonly errorName: string;
  readonly code?: number;
  readonly contract?: string;
  readonly method?: string;
  readonly cause?: unknown;

  constructor(message: string, init: ChainErrorInit = {}) {
    super(message);
    this.name = "ChainError";
    this.errorName = init.errorName ?? "Unknown";
    this.code = init.code;
    this.contract = init.contract;
    this.method = init.method;
    this.cause = init.cause;
  }
}

/** Raised when registerDevice hits AlreadyRegistered: the invoice hash is already on-chain. */
export class InvoiceAlreadyFinancedError extends ChainError {
  constructor(init: ChainErrorInit = {}) {
    super("invoice already financed", { ...init, errorName: "AlreadyRegistered" });
    this.name = "InvoiceAlreadyFinancedError";
  }
}

const isNoirError = (e: unknown): e is NoirContractError =>
  e instanceof NoirContractError ||
  (e instanceof Error && typeof (e as any).errorName === "string" && typeof (e as any).contract === "string");

/** Normalise anything thrown by the SDK into a ChainError. */
export function normalizeError(e: unknown): ChainError {
  if (e instanceof ChainError) return e;
  if (isNoirError(e)) {
    const init = { errorName: e.errorName, code: e.code, contract: e.contract, method: e.method, cause: e };
    if (e.errorName === "AlreadyRegistered") return new InvoiceAlreadyFinancedError(init);
    return new ChainError(e.message, init);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new ChainError(msg, { errorName: "Unknown", cause: e });
}
