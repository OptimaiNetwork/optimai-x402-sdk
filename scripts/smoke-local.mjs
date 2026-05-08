import {
  createOptimaiX402Client,
  createViemPaymentHandler,
} from "../dist/index.js";

const BASE_URL = process.env.OPTIMAI_X402_BASE_URL ?? "https://api-onchain.optimai.network";
const QUERY = process.env.OPTIMAI_X402_QUERY ?? "What is BNB?";
const PRIVATE_KEY = process.env.X402_PAYER_PRIVATE_KEY;
const IDEMPOTENCY_KEY = process.env.OPTIMAI_X402_IDEMPOTENCY_KEY
  ?? `sdk-smoke-${Date.now()}`;
const TIMEOUT_MS = Number(process.env.OPTIMAI_X402_TIMEOUT_MS ?? "300000");
const INTERVAL_MS = Number(process.env.OPTIMAI_X402_INTERVAL_MS ?? "2000");
const RUN_CANCEL = process.env.OPTIMAI_X402_RUN_CANCEL === "1";

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Set ${name} before running the local SDK smoke test.`);
  }
  return value;
}

function getRpcUrls() {
  const rpcUrls = {
    "eip155:8453": process.env.X402_RPC_URL_BASE
      ?? process.env.X402_RPC_URL
      ?? "https://mainnet.base.org",
  };

  if (process.env.X402_RPC_URL_BASE_SEPOLIA) {
    rpcUrls["eip155:84532"] = process.env.X402_RPC_URL_BASE_SEPOLIA;
  } else if (process.env.X402_RPC_URL) {
    rpcUrls["eip155:84532"] = process.env.X402_RPC_URL;
  }

  return rpcUrls;
}

function logStep(title, details) {
  console.log(`\n[${title}]`);
  if (details) {
    console.log(details);
  }
}

async function main() {
  requireEnv("X402_PAYER_PRIVATE_KEY", PRIVATE_KEY);

  const paymentHandler = createViemPaymentHandler({
    privateKey: PRIVATE_KEY,
    rpcUrls: getRpcUrls(),
  });

  const client = createOptimaiX402Client({
    baseUrl: BASE_URL,
    paymentHandler,
  });

  logStep("config", [
    `baseUrl=${BASE_URL}`,
    `query=${QUERY}`,
    `idempotencyKey=${IDEMPOTENCY_KEY}`,
    `runCancel=${RUN_CANCEL ? "yes" : "no"}`,
  ].join("\n"));

  logStep("createSearch", "Creating the initial paid search through the SDK...");
  const { search, paymentContext } = await client.createSearch(
    { query: QUERY },
    { idempotencyKey: IDEMPOTENCY_KEY },
  );

  console.log(JSON.stringify({
    searchId: search.id,
    status: search.status,
    x402PaymentStatus: search.x402_payment_status ?? null,
    storedPaymentSignature: Boolean(paymentContext.paymentSignature),
  }, null, 2));

  logStep("cross-process get", "Creating a fresh client instance and fetching with persisted paymentContext...");
  const secondClient = createOptimaiX402Client({
    baseUrl: BASE_URL,
    paymentHandler,
  });
  const fetched = await secondClient.getSearch(search.id, { paymentContext });
  console.log(JSON.stringify({
    searchId: fetched.id,
    status: fetched.status,
    x402PaymentStatus: fetched.x402_payment_status ?? null,
  }, null, 2));

  logStep("303 retry", "Retrying createSearch with the same idempotency key and existingPaymentContext...");
  const retried = await secondClient.createSearch(
    { query: QUERY },
    {
      idempotencyKey: IDEMPOTENCY_KEY,
      existingPaymentContext: paymentContext,
    },
  );
  console.log(JSON.stringify({
    searchId: retried.search.id,
    status: retried.search.status,
    reusedSearchId: retried.search.id === search.id,
  }, null, 2));

  logStep("waitForSearchCompletion", "Polling until the search reaches a terminal state...");
  const completed = await secondClient.waitForSearchCompletion(search.id, {
    paymentContext,
    timeoutMs: TIMEOUT_MS,
    intervalMs: INTERVAL_MS,
  });
  console.log(JSON.stringify({
    searchId: completed.id,
    status: completed.status,
    x402PaymentStatus: completed.x402_payment_status ?? null,
    hasResult: Boolean(completed.result),
    hasError: Boolean(completed.error),
  }, null, 2));

  if (RUN_CANCEL) {
    logStep("cancel flow", "Creating a second search and attempting cancellation...");
    const cancelTarget = await secondClient.createSearch({
      query: `${QUERY} (cancel smoke test)`,
    });
    const cancelled = await secondClient.cancelSearch(cancelTarget.search.id, {
      paymentContext: cancelTarget.paymentContext,
    });
    console.log(JSON.stringify(cancelled, null, 2));
  }

  logStep("result", "SDK local smoke test completed successfully.");
}

main().catch((error) => {
  console.error("\n[smoke-local failed]");
  console.error(error);
  process.exit(1);
});
