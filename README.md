# `@optimai-network/x402-sdk`

Typed client SDK for the `api-server-onchain` x402 search endpoints.

It wraps the two awkward parts of the flow:

- the initial `402 Payment Required` challenge
- the follow-up `payment-signature` header generation

It also returns a serializable `paymentContext` object, including the original `payment-signature`, so another agent or process can keep working with the same paid search later.

## Install

```bash
pnpm add @optimai-network/x402-sdk
```

## Quick start

```ts
import {
  createOptimaiX402Client,
  createViemPaymentHandler,
} from "@optimai-network/x402-sdk";

const paymentHandler = createViemPaymentHandler({
  privateKey: process.env.X402_PAYER_PRIVATE_KEY!,
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

## API

### `createOptimaiX402Client(config)`

Creates the high-level SDK client.

Methods:

- `createSearch(input, options?)`
- `getSearch(id, options?)`
- `cancelSearch(id, options?)`
- `waitForSearchCompletion(id, options?)`
- `rememberPaymentContext(context)`
- `forgetPaymentContext(id)`

### `createViemPaymentHandler(config)`

Creates a payment handler backed by `@x402/evm`, `@x402/fetch`, and `viem`.

Built-in network support:

- `eip155:8453` -> Base
- `eip155:84532` -> Base Sepolia

## x402 payment status meanings

`x402_payment_status` in responses can be:

- `settlement_unconfirmed`: payment is verified, but settlement is not finalized in OptimAI yet. Chain transfer may already exist while the server is still confirming/persisting settlement id.
- `settled`: settlement is finalized and settlement id (tx hash) is persisted.
- `voided`: payment was voided (usually request cancelled/failed before settlement).
- `settlement_failed`: server exhausted settlement retries and needs manual/operator follow-up.

## Persisting search access across agents

`GET /external/v1/x402/search/:id` works best when the client replays the exact original `payment-signature` used for the paid create call.
Because of that, the SDK returns:

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

// store paymentContext somewhere durable

client.rememberPaymentContext(paymentContext);
const latest = await client.getSearch(search.id);
```

If you retry `createSearch()` with the same `Idempotency-Key` from another process, pass the previously stored context back in `options.existingPaymentContext` so the SDK can authenticate the `303` redirect target with the original signature:

```ts
const retry = await client.createSearch(
  { query: "..." },
  {
    idempotencyKey: "search-123",
    existingPaymentContext: paymentContext,
  },
);
```

## Local smoke test

The package includes a smoke script for testing the built SDK against a live OptimAI x402 endpoint:

```bash
X402_PAYER_PRIVATE_KEY=0x... pnpm smoke:local
```

What to pass:

- `X402_PAYER_PRIVATE_KEY` must be the payer wallet private key used to sign the x402 payment payload
- this is a normal EVM wallet private key: 32-byte hex, with or without `0x`
- it is not a server key, not a Coinbase facilitator key, and not an API key

If you use MetaMask:

- use the private key for the account that should pay for the x402 request
- in MetaMask, export the account private key and pass that exported value as `X402_PAYER_PRIVATE_KEY`
- the account should have enough funds on the chain required by the server challenge
- treat this key as highly sensitive and only use it in a secure local/dev environment you control

Defaults:

- `OPTIMAI_X402_BASE_URL=https://api-onchain.optimai.network`
- mainnet RPC for `eip155:8453` defaults to `https://mainnet.base.org`

Optional overrides:

- `OPTIMAI_X402_QUERY="What is liquidation?"`
- `OPTIMAI_X402_BASE_URL=http://localhost:3002`
- `X402_RPC_URL_BASE=https://mainnet.base.org`
- `X402_RPC_URL_BASE_SEPOLIA=https://sepolia.base.org`
- `OPTIMAI_X402_RUN_CANCEL=1`

## Local compatibility test

For a stronger end-to-end check against `api-server-onchain`, use:

```bash
X402_PAYER_PRIVATE_KEY=0x... OPTIMAI_X402_BASE_URL=http://localhost:3002 pnpm compat:local
```

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

## Manual release checklist

First release is intentionally manual. From the package root:

```bash
pnpm install
pnpm build
pnpm test
X402_PAYER_PRIVATE_KEY=0x... OPTIMAI_X402_BASE_URL=http://localhost:3002 pnpm compat:local
pnpm pack
```

What to verify before publish:

- `pnpm build` succeeds
- `pnpm test` succeeds
- `pnpm compat:local` succeeds against a running `api-server-onchain`
- `pnpm pack` produces the tarball without missing entrypoints or type declarations

Publish steps:

```bash
npm whoami
npm publish --access public
```

Post-publish verification:

```bash
mkdir -p /tmp/optimai-x402-sdk-smoke
cd /tmp/optimai-x402-sdk-smoke
pnpm init
pnpm add @optimai-network/x402-sdk
```

Then import `createOptimaiX402Client` and `createViemPaymentHandler` from the installed package and run a smoke request against `api-server-onchain`.
