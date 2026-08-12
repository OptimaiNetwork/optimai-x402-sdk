# `@optimai-network/x402-sdk`

Typed client SDK for the `api-server-onchain` x402 search endpoints.

Source code is published at
[OptimaiNetwork/optimai-x402-sdk](https://github.com/OptimaiNetwork/optimai-x402-sdk)
under the ISC License.

It wraps the two awkward parts of the flow:

- the initial `402 Payment Required` challenge
- the follow-up `payment-signature` header generation

It also returns a serializable `paymentContext` object. The context starts with the
authorization proof used to create the search and is rotated in place when a completed
result requires its own fresh x402 proof, so another agent or process can resume safely.

## Install

Requires Node.js 20.18.0 or newer.

```bash
pnpm add @optimai-network/x402-sdk
```

## Quick start: EVM / Base

```ts
import {
  createOptimaiX402Client,
  createViemPaymentHandler,
} from "@optimai-network/x402-sdk";

const paymentHandler = createViemPaymentHandler({
  privateKey: process.env.X402_EVM_PAYER_PRIVATE_KEY!,
  rpcUrls: {
    "eip155:84532": "https://sepolia.base.org",
  },
});

const client = createOptimaiX402Client({
  baseUrl: "http://localhost:3002",
  paymentHandler,
});

const { search, paymentContext } = await client.createSearch({
  query: "What is liquidation?",
});

const completed = await client.waitForSearchCompletion(search.id, {
  paymentContext,
});

console.log(completed.result?.answer);
```

## Quick start: Solana

```ts
import {
  createOptimaiX402Client,
  createSolanaPaymentHandler,
} from "@optimai-network/x402-sdk";

const paymentHandler = await createSolanaPaymentHandler({
  privateKey: process.env.X402_SOLANA_PAYER_PRIVATE_KEY!,
  rpcUrls: {
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp":
      process.env.X402_SOLANA_MAINNET_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  },
});

const client = createOptimaiX402Client({
  baseUrl: "https://api-onchain.optimai.network",
  paymentHandler,
});

const { search, paymentContext } = await client.createSearch({
  query: "What is liquidation?",
});

const completed = await client.waitForSearchCompletion(search.id, {
  paymentContext,
});

console.log(completed.result?.answer);
```

## Payment requirements and `payTo`

SDK users do not manually set `payTo`, amount, asset, network, or Solana `feePayer`.
Those values come from the server's `402 Payment Required` challenge, and the selected payment handler signs one compatible offer from that challenge.

If your product needs to verify the receiver, inspect `paymentContext.paymentRequired.accepts` and confirm the selected offer's `payTo` matches the merchant wallet you expect before continuing.

## API

### `createOptimaiX402Client(config)`

Creates the high-level SDK client.

Methods:

- `createSearch(input, options?)`
- `getSearch(id, options?)`
- `getSearchWithPaymentContext(id, options?)` (returns the search and latest context)
- `getSearchResult(id, options?)` (alias for `getSearchWithPaymentContext`)
- `cancelSearch(id, options?)`
- `waitForSearchCompletion(id, options?)`
- `waitForSearchCompletionWithPaymentContext(id, options?)`
- `rememberPaymentContext(context)`
- `forgetPaymentContext(id)`

### `createViemPaymentHandler(config)`

Creates a payment handler backed by `@x402/evm`, `@x402/fetch`, and `viem`.

Built-in network support:

- `eip155:8453` -> Base
- `eip155:84532` -> Base Sepolia

When a challenge includes multiple `accepts`, this handler selects the first EVM offer.

### `createSolanaPaymentHandler(config)`

Creates a payment handler backed by `@x402/svm` for Solana/SVM x402 payments.

```ts
import {
  createOptimaiX402Client,
  createSolanaPaymentHandler,
} from "@optimai-network/x402-sdk";

const paymentHandler = await createSolanaPaymentHandler({
  privateKey: process.env.X402_SOLANA_PAYER_PRIVATE_KEY!, // base58 or JSON-encoded 64-byte secret key
  rpcUrls: {
    "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "https://api.mainnet-beta.solana.com",
  },
});

const client = createOptimaiX402Client({
  baseUrl: "https://api-onchain.optimai.network",
  paymentHandler,
});
```

Built-in network support:

- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` -> Solana mainnet
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` -> Solana devnet

When a challenge includes multiple `accepts`, this handler selects the first Solana offer. The server challenge must include a facilitator-managed `extra.feePayer`; the SDK payer key only signs as the token owner.

## Base vs Solana

Both payment handlers use the same `createOptimaiX402Client` API. The difference is only how the wallet signs the x402 payment:

- EVM / Base uses `createViemPaymentHandler`, a 32-byte hex private key, Base USDC, and Base gas.
- Solana uses `createSolanaPaymentHandler`, a base58 or JSON-encoded 64-byte Solana secret key, SPL USDC, and SOL for network fees.
- EVM addresses are `0x...`; Solana addresses are base58 public keys.
- On Solana, `extra.feePayer` is facilitator-managed and comes from the server challenge. It is not the SDK user's payer wallet.

## x402 payment status meanings

`x402_payment_status` in responses can be:

- `verified_unsettled`: canonical server status for a verified payment whose settlement is not finalized in OptimAI yet. Chain transfer may already exist while the server is still confirming or persisting the settlement id.
- `settlement_unconfirmed`: legacy name retained for compatibility with older server responses and SDK callers.
- `settled`: settlement is finalized and settlement id (tx hash) is persisted.
- `voided`: payment was voided (usually request cancelled/failed before settlement).
- `settlement_failed`: server exhausted settlement retries and needs manual/operator follow-up.

## Persisting search access across agents

The SDK replays the initial authorization `payment-signature` while a search is pending or
running. When a completed result is ready, the server can return a fresh result-bound
`402 Payment Required`; the SDK signs that challenge once, retries the GET, and updates
the same context object with the new proof. The initial POST proof is only an authorization
for job creation; the SDK never submits it for settlement. Because of that, the SDK returns:

```ts
type SearchPaymentContext = {
  id: string;
  paymentRequired: X402PaymentRequired;
  paymentSignature?: string;
};
```

Persist this object alongside the search id if another agent or process will poll or fetch the search later:

```ts
const { search, paymentContext } = await client.createSearch({ query: "..." });

// store paymentContext somewhere durable; it is updated in place after a fresh result proof
const latest = await client.getSearchWithPaymentContext(search.id, { paymentContext });
const serializedPaymentContext = JSON.stringify(latest.paymentContext);
```

If you retry `createSearch()` with the same `Idempotency-Key` from another process, pass the
initial authorization context back in `options.existingPaymentContext` so the SDK can
authenticate the `303` redirect target:

```ts
const retry = await client.createSearch(
  { query: "..." },
  {
    idempotencyKey: "search-123",
    existingPaymentContext: paymentContext,
  },
);
```

## Local smoke tests

The package includes separate smoke scripts for EVM and Solana payment handlers.

EVM:

```bash
X402_EVM_PAYER_PRIVATE_KEY=0x... pnpm smoke:local:evm
```

The legacy `pnpm smoke:local` alias still runs the EVM smoke test.

Solana:

```bash
X402_SOLANA_PAYER_PRIVATE_KEY='[...]' pnpm smoke:local:solana
```

What to pass:

- `X402_EVM_PAYER_PRIVATE_KEY` is a normal EVM wallet private key: 32-byte hex, with or without `0x`
- `X402_SOLANA_PAYER_PRIVATE_KEY` is a base58 or JSON-encoded 64-byte Solana secret key
- payer private keys are not server keys, Coinbase facilitator keys, or API keys
- for Solana, the payer key is not the facilitator `feePayer`; the server discovers or configures that separately

If you use MetaMask:

- use the private key for the account that should pay for the x402 request
- in MetaMask, export the account private key and pass that exported value as `X402_EVM_PAYER_PRIVATE_KEY`
- the account should have enough funds on the chain required by the server challenge
- treat this key as highly sensitive and only use it in a secure local/dev environment you control

Defaults:

- `OPTIMAI_X402_BASE_URL=https://api-onchain.optimai.network`
- mainnet RPC for `eip155:8453` defaults to `https://mainnet.base.org`
- Solana RPC defaults to the public Solana mainnet/devnet endpoints

Optional overrides:

- `OPTIMAI_X402_QUERY="What is liquidation?"`
- `OPTIMAI_X402_BASE_URL=http://localhost:3002`
- `X402_EVM_BASE_RPC_URL=https://mainnet.base.org`
- `X402_EVM_BASE_SEPOLIA_RPC_URL=https://sepolia.base.org`
- `X402_SOLANA_MAINNET_RPC_URL=https://api.mainnet-beta.solana.com`
- `X402_SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com`
- `OPTIMAI_X402_RUN_CANCEL=1`

Backward-compatible EVM aliases are also accepted:

- `X402_PAYER_PRIVATE_KEY`
- `X402_RPC_URL_BASE`
- `X402_RPC_URL_BASE_SEPOLIA`
- `X402_RPC_URL`

## Local compatibility test

For a stronger end-to-end check against `api-server-onchain`, use:

```bash
X402_EVM_PAYER_PRIVATE_KEY=0x... OPTIMAI_X402_BASE_URL=http://localhost:3002 pnpm compat:local:evm
```

The legacy `pnpm compat:local` alias still runs the EVM compatibility test.

This script validates the full x402 contract described in the server integration notes:

- create a paid search with query `Compare ETH and BTC`
- open `GET /external/v1/x402/search/:id/events` using the stored original `payment-signature`
- wait for `search.completed` and `search.done`
- verify the completed SSE answer matches the final `GET /external/v1/x402/search/:id` answer
- create a second search and verify `DELETE /external/v1/x402/search/:id`
- verify the cancelled search later returns:
  - `status: "cancelled"`
  - `x402_payment_status: "voided"`

If the script finishes with:

```text
[result]
Compatibility test completed successfully.
```

then the SDK and the current `api-server-onchain` implementation are compatible for the tested create, SSE, GET, and DELETE flows.
