import {
  createOptimaiX402Client,
  createViemPaymentHandler,
  OptimaiX402ApiError,
  OptimaiX402Error,
} from "../dist/index.js";

const BASE_URL = process.env.OPTIMAI_X402_BASE_URL ?? "https://api-onchain.optimai.network";
const QUERY = process.env.OPTIMAI_X402_QUERY ?? "Compare ETH and BTC";
const PRIVATE_KEY = process.env.X402_PAYER_PRIVATE_KEY;
const COMPLETION_TIMEOUT_MS = Number(process.env.OPTIMAI_X402_TIMEOUT_MS ?? "300000");
const POLL_INTERVAL_MS = Number(process.env.OPTIMAI_X402_INTERVAL_MS ?? "2000");

function requireEnv(name, value) {
  if (!value) {
    throw new Error(`Set ${name} before running the local compatibility test.`);
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

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function openSearchEvents(baseUrl, searchId, paymentSignature) {
  const response = await fetch(`${baseUrl}/external/v1/x402/search/${searchId}/events`, {
    method: "GET",
    headers: {
      "payment-signature": paymentSignature,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SSE request failed with ${response.status}: ${body}`);
  }

  if (!response.body) {
    throw new Error("SSE response did not include a body stream.");
  }

  return response.body.getReader();
}

function parseSseChunk(buffer) {
  const events = [];
  let rest = buffer.replace(/\r\n/g, "\n");

  while (true) {
    const separatorIndex = rest.indexOf("\n\n");
    if (separatorIndex === -1) {
      break;
    }

    const rawEvent = rest.slice(0, separatorIndex);
    rest = rest.slice(separatorIndex + 2);

    let eventName = "message";
    const dataLines = [];
    let id = undefined;

    for (const rawLine of rawEvent.split("\n")) {
      const line = rawLine.replace(/\r$/, "");
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      } else if (line.startsWith("id:")) {
        id = line.slice(3).trim();
      }
    }

    let data = null;
    const dataText = dataLines.join("\n");
    if (dataText) {
      try {
        data = JSON.parse(dataText);
      } catch {
        data = dataText;
      }
    }

    events.push({
      id,
      event: eventName,
      data,
    });
  }

  return { events, rest };
}

async function collectSearchCompletionFromSse(baseUrl, searchId, paymentSignature, timeoutMs) {
  let reader;
  try {
    reader = await openSearchEvents(baseUrl, searchId, paymentSignature);
  } catch (error) {
    if (String(error?.message ?? "").includes("409")) {
      return {
        completedEvent: null,
        doneSeen: false,
        seenEvents: [],
        streamAlreadyTerminal: true,
      };
    }
    throw error;
  }
  const decoder = new TextDecoder();
  const startedAt = Date.now();
  let buffer = "";
  let completedEvent = null;
  let doneSeen = false;
  const seenEvents = [];

  try {
    while (Date.now() - startedAt < timeoutMs) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const parsed = parseSseChunk(buffer);
      buffer = parsed.rest;

      for (const event of parsed.events) {
        seenEvents.push(event.event);
        if (event.event === "search.completed") {
          completedEvent = event;
        }
        if (event.event === "search.done") {
          doneSeen = true;
          if (completedEvent) {
            return {
              completedEvent,
              doneSeen,
              seenEvents,
              streamAlreadyTerminal: false,
            };
          }
        }
      }
    }
  } finally {
    await reader.cancel();
  }

  throw new Error(
    `Timed out waiting for SSE completion. Seen events: ${seenEvents.join(", ") || "<none>"}`,
  );
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
    `completionTimeoutMs=${COMPLETION_TIMEOUT_MS}`,
    `pollIntervalMs=${POLL_INTERVAL_MS}`,
  ].join("\n"));

  logStep("create-get-sse", "Creating a search, verifying SSE completion, then verifying final GET response...");
  const createResult = await client.createSearch({
    query: QUERY,
  });

  assert(createResult.paymentContext.paymentSignature, "Missing stored payment signature after createSearch().");
  console.log(JSON.stringify({
    searchId: createResult.search.id,
    initialStatus: createResult.search.status,
    x402PaymentStatus: createResult.search.x402_payment_status ?? null,
  }, null, 2));

  const sseResult = await collectSearchCompletionFromSse(
    BASE_URL,
    createResult.search.id,
    createResult.paymentContext.paymentSignature,
    COMPLETION_TIMEOUT_MS,
  );

  const completed = await client.waitForSearchCompletion(createResult.search.id, {
    paymentContext: createResult.paymentContext,
    timeoutMs: COMPLETION_TIMEOUT_MS,
    intervalMs: POLL_INTERVAL_MS,
  });

  assert(completed.status === "completed", `Expected GET status=completed, received ${completed.status}`);
  assert(Boolean(completed.result?.answer), "GET completed response did not include result.answer");
  if (!sseResult.streamAlreadyTerminal) {
    assert(Boolean(sseResult.completedEvent?.data?.answer), "SSE completed event did not include answer");
    assert(
      completed.result.answer === sseResult.completedEvent.data.answer,
      "GET and SSE answers differ for the completed search.",
    );
  }

  console.log(JSON.stringify({
    searchId: completed.id,
    getStatus: completed.status,
    sseStreamAlreadyTerminal: sseResult.streamAlreadyTerminal,
    sseDoneSeen: sseResult.doneSeen,
    sseEvents: sseResult.seenEvents,
    answerLength: completed.result.answer.length,
  }, null, 2));

  logStep("delete-endpoint", "Creating a second search and cancelling it through DELETE...");
  const cancelTarget = await client.createSearch({
    query: `${QUERY} - cancel test`,
  });

  const cancelled = await client.cancelSearch(cancelTarget.search.id, {
    paymentContext: cancelTarget.paymentContext,
  });
  assert(cancelled.status === "cancelled", `Expected delete response status=cancelled, received ${cancelled.status}`);

  let latestCancelled = null;
  try {
    latestCancelled = await client.getSearch(cancelTarget.search.id, {
      paymentContext: cancelTarget.paymentContext,
    });
  } catch (error) {
    if (!(error instanceof OptimaiX402ApiError || error instanceof OptimaiX402Error)) {
      throw error;
    }
  }

  console.log(JSON.stringify({
    cancelledSearchId: cancelTarget.search.id,
    deleteStatus: cancelled.status,
    followupStatus: latestCancelled?.status ?? null,
    followupPaymentStatus: latestCancelled?.x402_payment_status ?? null,
  }, null, 2));

  logStep("result", "Compatibility test completed successfully.");
}

main().catch((error) => {
  console.error("\n[compat-local failed]");
  console.error(error);
  process.exit(1);
});
