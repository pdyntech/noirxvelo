export const EXPLORER_TX_BASE = "https://stellar.expert/explorer/testnet/tx/";

export const explorerTxUrl = (hash: string): string => `${EXPLORER_TX_BASE}${hash}`;

export interface TxResult {
  hash: string;
  explorerUrl: string;
}

export const txResult = (hash: string): TxResult => ({ hash, explorerUrl: explorerTxUrl(hash) });
