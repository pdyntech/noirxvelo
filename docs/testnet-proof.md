# Testnet proof

Date: 2026-11-06T13:30:27.340Z

Full Noir lifecycle on Stellar Testnet, run by `npx tsx scripts/lifecycle.ts` through the `@noirxvelo/agent` wrapper.

Device hash: `1164edd05ea231d4cec8282c2cf98c3818a85f5cb2ce862b21410824256370d5`

## Transactions

1. 1 registerDevice: [9ba6b79c...](https://stellar.expert/explorer/testnet/tx/9ba6b79cf1b1732d2583f583f2cb7c2674fddf1badb8bc2f6dff2f044ec97c5f)
2. 2 registerAgent (cap 880 XLM): [9bde0260...](https://stellar.expert/explorer/testnet/tx/9bde02602a5a3f4b55f967339d1953133d366b403452647f7d1bb801c5614faa)
3. 3 fundEscrow (LP 850 XLM): [3d546679...](https://stellar.expert/explorer/testnet/tx/3d546679502258b0e8e8d63ff023cca458aeb3a6270142527b233a653e249dd7)
4. 5 authorizePayment (850 XLM -> SHIPOWNER): [d8899a5b...](https://stellar.expert/explorer/testnet/tx/d8899a5bff111ea3a82daa4b421100f88a8589d10c506197aadf5700e2b82385)
5. 6 claim (SHIPOWNER): [0c540e37...](https://stellar.expert/explorer/testnet/tx/0c540e3762d646d2eb84bd1bdfd377f4229c0be974cce5c7d66c8b77989a392c)

Step 4 (`checkPayment` with `requireEscrow: true`) is a read-only simulation returning `{ ok: true }`; it has no transaction.

## Balances (SHIPOWNER, native XLM, from Horizon)

| | XLM |
| --- | --- |
| Before claim | 10876.9948056 |
| After claim | 11726.9937988 |
| Delta | +849.9989932 (850 minus claim fee) |

After claim: device escrow balance `0`, SHIPOWNER pending balance `0`.

## Default recovery

Run by `npm run default-demo` (EXT-01) through the wrapper: DEFAULT scenario, ops-triggered `defaultRecovery` (`unlinkDevice` = revokeAgent + sweepOnRevoke).

Device hash: `bba5925059fcda56331b89dc28f26375af1a11f4f81f1e8b9086fd871b818b25`

1. registerDevice: [25d85019...](https://stellar.expert/explorer/testnet/tx/25d85019f2847a97d1e3fd15682d1635bef4297cda744deeaa6ec401f4310f7d)
2. registerAgent (cap 880 XLM): [88482636...](https://stellar.expert/explorer/testnet/tx/8848263641f3988bda6251a3eb0b71df99eb9f5e1820c758511015d1fc2a1cff)
3. fundEscrow (LP 850 XLM): [ec5381b8...](https://stellar.expert/explorer/testnet/tx/ec5381b899a2390fb0323b43f836c424e734b01e4284b0c26fa75c868cf88e35)
4. Recovery tx 1: [eb14b8b4...](https://stellar.expert/explorer/testnet/tx/eb14b8b43ad44912e29afe9a29de69d23845183a52f389737bef4f6982578d6d)
5. Recovery tx 2: [bef895a6...](https://stellar.expert/explorer/testnet/tx/bef895a6e84895201b518b31ee4469facc89cc270f44c8fa7feffd036daa5f0b)
6. Recovery tx 3: [b18ca2e2...](https://stellar.expert/explorer/testnet/tx/b18ca2e28aeaace389cea32ab9204e84fbe5f4975d9db20cc8871b783a8868a8)

| | XLM |
| --- | --- |
| Escrow before / after | 850 / 0 |
| Treasury before | 11057.8676447 |
| Treasury after | 11907.8654558 |
| Delta | +849.9978111 (850 minus fees) |

After revoke: `checkPayment` returns `no_agent`; wrapper `authorizePayment` returns the same refusal without sending a transaction.
