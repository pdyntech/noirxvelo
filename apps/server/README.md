# apps/server + apps/web

One Node process: the API, the Velo webhook receiver, the settlement agent runtime, and the static frontend in `apps/web` (no build step).

## Run locally

```bash
nvm use                   # Node 24.22.1 (.nvmrc). Older Node installs the retired agent-sdk 0.2.0
npm install               # at the repo root
npm run provision         # once: creates and funds the Testnet wallets in .env.local
npm start                 # http://localhost:3000
```

Press **▶ Run Demo** in the Ops panel. It runs the whole loop on Stellar Testnet in about 90 seconds:

1. `device_registry.register` and `agent_registry.register_agent` (cap 880 XLM) for the invoice hash
2. LP `fund_escrow` 850 XLM
3. The vessel departs. On the first underway AIS tick the agent decides **ADVANCE**, and the executor runs `authorize` + `claim` for the shipowner
4. Berthing rule (800 m Cebu geofence, ≤0.5 kn for 3 ticks): the agent signs a proof-of-delivery attestation
5. Velo checkout session, then a verified `payment.succeeded` webhook. Treasury `fund_escrow` 1,000 XLM
6. Guardrail: the agent tries one 1,000 XLM payout and Noir refuses it (`over_limit`, no tx, no fee)
7. The agent decides **SETTLE**: `authorize` LP 880, shipowner 115, treasury 5, then each payee claims. Escrow ends at 0

Every step is also a manual button in the Shipowner, Investor and Debtor views.

## Environment

| Name | Needed | What it does |
| --- | --- | --- |
| `TREASURY_*`, `SHIPOWNER_*`, `LP_*`, `AGENT_*` (`_PUBLIC`, `_SECRET`) | yes | Testnet wallets from `npm run provision` |
| `VELO_API_KEY` | recommended | Real Velo checkout sessions. Without it, checkout is simulated and labeled |
| `VELO_WEBHOOK_SECRET` | recommended | Verifies real Velo webhooks. Without it, only self-signed simulated deliveries verify |
| `VELO_CHECKOUT_ASSET` | no | Default `native` (handbook example) |
| `APP_URL` | on deploy | Public URL, used for checkout success and cancel links |
| `LLM_API_KEY`, `LLM_MODEL` | no | An LLM writes the decision reason. The amounts always come from code |
| `DEMO_TICK_MS` | no | AIS tick interval, default 1800 |

## Deploy (Render or Railway, not Vercel)

The demo keeps its state and the live event stream in one long-running process, so it needs a host that keeps the process alive. Serverless functions don't.

- **Render:** New → Web Service → this repo. Build command `npm install --include=dev`, start command `npm start`, Node 24. Add the env vars above.
- **Railway:** New project from the repo. Start command `npm start`. Add the env vars above. Set `NIXPACKS_NODE_VERSION=24`.

Then set the Velo webhook URL in the dashboard to `https://<your-host>/api/webhooks/velo`.

Health check: `GET /api/health`.

## API

`GET /api/state`, `GET /api/stream` (SSE), `POST /api/{tokenize|fund|depart|fast-forward|checkout|simulate-webhook|guardrail|default|reset|run-demo}`, `POST /api/webhooks/velo`.

## Where things live

- `src/demo.ts`: the state machine. Every chain call goes through one shared `NoirAgentClient`, one at a time
- `src/agent.ts`: decision policy (`AgentDecision`, roles only). It passes through `execute()` from `@noirxvelo/agent`
- `src/telemetry.ts`: AIS simulator and berthing rule
- `src/velo.ts`: checkout and webhook verification (`Velo.webhooks.verify`, raw body, 300 s tolerance, dedupe by `x-velo-delivery`)
- `../web`: frontend (role switcher, portals, voyage chart, decision stream, ops panel)
