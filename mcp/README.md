# @verdikt/mcp

An MCP server that gives any MCP-capable agent (Claude, LangGraph, CrewAI, Vercel AI SDK) native tools to escrow and verify agent work on Arc. Wraps `@verdikt/sdk`.

## Tools
- **`verdikt_create_task`** (payer) — register acceptance criteria, escrow USDC on Arc, return a signed Task Offer for a seller.
- **`verdikt_submit_artifact`** (seller) — verify the offer + escrow on-chain, pay the sub-cent x402 fee, return the verdict (`released` / `refunded` / `abstained`). Abstain is free.
- **`verdikt_check_escrow`** — read an escrow's on-chain state (status / outcome / amount / evidence hash). No wallet needed.

## Run
```bash
npm install && npm run build
VERDIKT_PRIVATE_KEY=0x... VERDIKT_ENDPOINT=https://verdikt-worker.fly.dev node dist/server.js
```

## Config (Claude Desktop / any MCP client)
```json
{
  "mcpServers": {
    "verdikt": {
      "command": "node",
      "args": ["/abs/path/to/verdikt-arc/mcp/dist/server.js"],
      "env": {
        "VERDIKT_PRIVATE_KEY": "0x...",
        "VERDIKT_ENDPOINT": "https://verdikt-worker.fly.dev",
        "VERDIKT_RPC_URL": "https://rpc.testnet.arc.network"
      }
    }
  }
}
```

The operating agent supplies one wallet. Acting as a payer it calls `verdikt_create_task`; acting as a seller it calls `verdikt_submit_artifact`. Each agent runs its own server with its own key. Proven live: `tools/list` + a `verdikt_check_escrow` call returning real on-chain escrow state.
