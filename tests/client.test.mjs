import test from "node:test";
import assert from "node:assert/strict";

import {
  OptimaiX402ApiError,
  createOptimaiX402Client,
} from "../dist/index.js";

function createJsonResponse(body, init = {}) {
  const responseHeaders = {
    "content-type": "application/json",
    ...(init.headers ?? {}),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: responseHeaders,
  });
}

function createPaymentRequired(network, payTo, resourceUrl = "/external/v1/x402/search") {
  return {
    x402Version: 2,
    resource: { url: resourceUrl, mimeType: "application/json" },
    accepts: [
      {
        scheme: "exact",
        network,
        asset: network.startsWith("solana:") ? "solana-usdc" : "0xasset",
        amount: "10000",
        payTo,
        maxTimeoutSeconds: 300,
      },
    ],
  };
}

function encodePaymentRequired(paymentRequired) {
  return Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64");
}

test("createSearch stores the original payment signature and replays it on follow-up requests", async () => {
  const paymentRequired = {
    x402Version: 2,
    resource: {
      url: "/external/v1/x402/search",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0xasset",
        amount: "10000",
        payTo: "0xpayto",
        maxTimeoutSeconds: 300,
      },
    ],
  };

  const encodedChallenge = Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64");
  const paidSignature = "signed-payment-payload";
  const seenSignatures = [];
  let requestCount = 0;

  const fetchImpl = async (url, init) => {
    requestCount += 1;
    const headers = new Headers(init?.headers);

    if (requestCount === 1) {
      assert.equal(String(url), "https://example.com/external/v1/x402/search");
      assert.equal(init?.method, "POST");
      return new Response(JSON.stringify({
        error: { code: "payment_required", message: "Payment is required" },
      }), {
        status: 402,
        headers: { "payment-required": encodedChallenge },
      });
    }

    const signature = headers.get("payment-signature");
    seenSignatures.push(signature);

    if (requestCount === 2) {
      return createJsonResponse({
        id: "search-1",
        status: "pending",
        query: "What is OptimAI?",
        x402_payment_status: "settlement_unconfirmed",
      }, { status: 202 });
    }

    return createJsonResponse({
      id: "search-1",
      status: "completed",
      query: "What is OptimAI?",
      x402_payment_status: "settled",
      result: {
        answer: "OptimAI is a search product.",
        citations: [],
      },
    });
  };

  const paymentHandler = {
    async createPaymentHeaders() {
      return {
        "payment-signature": paidSignature,
      };
    },
  };

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler,
    fetch: fetchImpl,
  });

  const { search, paymentContext } = await client.createSearch({
    query: "What is OptimAI?",
  });

  assert.equal(search.id, "search-1");
  assert.equal(paymentContext.paymentSignature, paidSignature);

  await client.getSearch(search.id);

  assert.deepEqual(seenSignatures, [paidSignature, paidSignature]);
});

test("createSearch reuses the original stored context for idempotent 303 retries in the same process", async () => {
  const originalPaymentRequired = {
    x402Version: 2,
    resource: { url: "/external/v1/x402/search" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0xasset-old",
        amount: "10000",
        payTo: "0xpayto-old",
        maxTimeoutSeconds: 300,
      },
    ],
  };
  const updatedPaymentRequired = {
    x402Version: 2,
    resource: { url: "/external/v1/x402/search" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0xasset-new",
        amount: "20000",
        payTo: "0xpayto-new",
        maxTimeoutSeconds: 300,
      },
    ],
  };

  const originalChallenge = Buffer.from(JSON.stringify(originalPaymentRequired), "utf8").toString("base64");
  const updatedChallenge = Buffer.from(JSON.stringify(updatedPaymentRequired), "utf8").toString("base64");
  const originalSignature = "original-signature";
  const newSignature = "new-signature";
  const seenSignatures = [];
  let paymentHeaderCalls = 0;
  let requestCount = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders(paymentRequired) {
        paymentHeaderCalls += 1;
        const payTo = paymentRequired.accepts[0]?.payTo;
        return {
          "payment-signature": payTo === "0xpayto-old" ? originalSignature : newSignature,
        };
      },
    },
    fetch: async (_url, init) => {
      requestCount += 1;
      const headers = new Headers(init?.headers);

      if (requestCount === 1) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": originalChallenge },
        });
      }
      if (requestCount === 2) {
        assert.equal(headers.get("payment-signature"), originalSignature);
        return createJsonResponse({
          id: "search-303",
          status: "pending",
          query: "same request",
        }, { status: 202 });
      }
      if (requestCount === 3) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": updatedChallenge },
        });
      }
      if (requestCount === 4) {
        assert.equal(headers.get("payment-signature"), newSignature);
        return createJsonResponse({ id: "search-303" }, { status: 303 });
      }

      seenSignatures.push(headers.get("payment-signature"));
      return createJsonResponse({
        id: "search-303",
        status: "completed",
        query: "same request",
        x402_payment_status: "settled",
        result: {
          answer: "done",
          citations: [],
        },
      });
    },
  });

  await client.createSearch({ query: "same request" }, { idempotencyKey: "idem-1" });
  const retried = await client.createSearch({ query: "same request" }, { idempotencyKey: "idem-1" });

  assert.equal(retried.search.id, "search-303");
  assert.deepEqual(seenSignatures, [originalSignature]);
  assert.equal(paymentHeaderCalls, 2, "the SDK still pays the retry challenge, but reuses the original context for follow-up access");
});

test("createSearch accepts a caller-supplied existingPaymentContext for cross-process 303 retries", async () => {
  const stalePaymentRequired = {
    x402Version: 2,
    resource: { url: "/external/v1/x402/search" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0xasset-old",
        amount: "10000",
        payTo: "0xpayto-old",
        maxTimeoutSeconds: 300,
      },
    ],
  };
  const currentPaymentRequired = {
    x402Version: 2,
    resource: { url: "/external/v1/x402/search" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0xasset-new",
        amount: "20000",
        payTo: "0xpayto-new",
        maxTimeoutSeconds: 300,
      },
    ],
  };

  const currentChallenge = Buffer.from(JSON.stringify(currentPaymentRequired), "utf8").toString("base64");
  const persistedSignature = "persisted-original-signature";
  const currentSignature = "current-signature";
  const seenSignatures = [];
  let requestCount = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders() {
        return {
          "payment-signature": currentSignature,
        };
      },
    },
    fetch: async (_url, init) => {
      requestCount += 1;
      const headers = new Headers(init?.headers);

      if (requestCount === 1) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": currentChallenge },
        });
      }
      if (requestCount === 2) {
        assert.equal(headers.get("payment-signature"), currentSignature);
        return createJsonResponse({ id: "search-cross-process" }, { status: 303 });
      }

      seenSignatures.push(headers.get("payment-signature"));
      return createJsonResponse({
        id: "search-cross-process",
        status: "completed",
        query: "cross process",
        x402_payment_status: "settled",
        result: {
          answer: "ok",
          citations: [],
        },
      });
    },
  });

  const result = await client.createSearch(
    { query: "cross process" },
    {
      idempotencyKey: "idem-cross-process",
      existingPaymentContext: {
        id: "search-cross-process",
        paymentRequired: stalePaymentRequired,
        paymentSignature: persistedSignature,
      },
    },
  );

  assert.equal(result.search.id, "search-cross-process");
  assert.deepEqual(seenSignatures, [persistedSignature]);
});

test("createSearch preserves the rotated result context after a 303 redirect", async () => {
  const initialPaymentRequired = createPaymentRequired(
    "eip155:8453",
    "0xinitial-payto",
    "/external/v1/x402/search",
  );
  const resultPaymentRequired = createPaymentRequired(
    "eip155:8453",
    "0xresult-payto",
    "/external/v1/x402/search/search-303-result",
  );
  const initialSignature = "initial-303-signature";
  const resultSignature = "result-303-signature";
  const seenSignatures = [];
  let paymentHandlerCalls = 0;
  let requestCount = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders(paymentRequired) {
        paymentHandlerCalls += 1;
        assert.equal(
          paymentRequired.accepts[0].payTo,
          paymentHandlerCalls === 1 ? "0xinitial-payto" : "0xresult-payto",
        );
        return {
          "payment-signature": paymentHandlerCalls === 1 ? initialSignature : resultSignature,
        };
      },
    },
    fetch: async (_url, init) => {
      requestCount += 1;
      const headers = new Headers(init?.headers);
      const signature = headers.get("payment-signature");
      seenSignatures.push(signature);

      if (requestCount === 1) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": encodePaymentRequired(initialPaymentRequired) },
        });
      }
      if (requestCount === 2) {
        assert.equal(init?.method, "POST");
        assert.equal(signature, initialSignature);
        return createJsonResponse({ id: "search-303-result" }, { status: 303 });
      }
      if (requestCount === 3) {
        assert.equal(init?.method, "GET");
        assert.equal(signature, initialSignature);
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": encodePaymentRequired(resultPaymentRequired) },
        });
      }

      assert.equal(init?.method, "GET");
      assert.equal(signature, resultSignature);
      return createJsonResponse({
        id: "search-303-result",
        status: "completed",
        query: "303 result",
        result: { answer: "redirected result", citations: [] },
      });
    },
  });

  const result = await client.createSearch({ query: "303 result" });

  assert.equal(result.search.result?.answer, "redirected result");
  assert.equal(result.paymentContext.paymentSignature, resultSignature);
  assert.deepEqual(result.paymentContext.paymentRequired, resultPaymentRequired);

  await client.getSearch(result.search.id);
  assert.deepEqual(seenSignatures, [null, initialSignature, initialSignature, resultSignature, resultSignature]);
});

test("getSearch falls back to payment handler generation for legacy contexts without a stored signature", async () => {
  const generatedSignature = "generated-payment-signature";
  let paymentHeaderCalls = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders() {
        paymentHeaderCalls += 1;
        return {
          "payment-signature": generatedSignature,
        };
      },
    },
    fetch: async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("payment-signature"), generatedSignature);
      return createJsonResponse({
        id: "search-legacy",
        status: "completed",
        query: "legacy",
        x402_payment_status: "settled",
        result: {
          answer: "ok",
          citations: [],
        },
      });
    },
  });

  const response = await client.getSearch("search-legacy", {
    paymentContext: {
      id: "search-legacy",
      paymentRequired: {
        x402Version: 2,
        resource: {
          url: "/external/v1/x402/search",
        },
        accepts: [
          {
            scheme: "exact",
            network: "eip155:8453",
            asset: "0xasset",
            amount: "10000",
            payTo: "0xpayto",
            maxTimeoutSeconds: 300,
          },
        ],
      },
    },
  });

  assert.equal(response.id, "search-legacy");
  assert.equal(paymentHeaderCalls, 1);
});

test("getSearch pays one fresh result challenge, retries, and rotates the serializable context", async () => {
  const initialPaymentRequired = createPaymentRequired(
    "eip155:8453",
    "0xinitial-payto",
    "/external/v1/x402/search",
  );
  const resultPaymentRequired = createPaymentRequired(
    "eip155:8453",
    "0xresult-payto",
    "/external/v1/x402/search/search-result",
  );
  const initialSignature = "initial-authorization-signature";
  const resultSignature = "result-bound-signature";
  const seenSignatures = [];
  const signedChallenges = [];
  let requestCount = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders(paymentRequired) {
        signedChallenges.push(paymentRequired);
        return {
          "payment-signature": signedChallenges.length === 1 ? initialSignature : resultSignature,
        };
      },
    },
    fetch: async (_url, init) => {
      requestCount += 1;
      const headers = new Headers(init?.headers);
      seenSignatures.push(headers.get("payment-signature"));

      if (requestCount === 1) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": encodePaymentRequired(initialPaymentRequired) },
        });
      }
      if (requestCount === 2) {
        assert.equal(headers.get("payment-signature"), initialSignature);
        return createJsonResponse({
          id: "search-result",
          status: "pending",
          query: "result challenge",
          x402_payment_status: "settlement_unconfirmed",
        }, { status: 202 });
      }
      if (requestCount === 3) {
        assert.equal(headers.get("payment-signature"), initialSignature);
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": encodePaymentRequired(resultPaymentRequired) },
        });
      }

      assert.equal(requestCount, 4);
      assert.equal(headers.get("payment-signature"), resultSignature);
      return createJsonResponse({
        id: "search-result",
        status: "completed",
        query: "result challenge",
        x402_payment_status: "settled",
        result: { answer: "paid result", citations: [] },
      });
    },
  });

  const { search, paymentContext } = await client.createSearch({ query: "result challenge" });
  assert.equal(search.status, "pending");
  assert.equal(paymentContext.paymentSignature, initialSignature);

  const completed = await client.getSearch(search.id, { paymentContext });

  assert.equal(completed.result?.answer, "paid result");
  assert.deepEqual(seenSignatures, [null, initialSignature, initialSignature, resultSignature]);
  assert.deepEqual(signedChallenges, [initialPaymentRequired, resultPaymentRequired]);
  assert.equal(paymentContext.paymentSignature, resultSignature);
  assert.deepEqual(paymentContext.paymentRequired, resultPaymentRequired);
  assert.equal(JSON.parse(JSON.stringify(paymentContext)).paymentSignature, resultSignature);
});

test("getSearchWithPaymentContext returns the rotated context for persistence", async () => {
  const initialPaymentRequired = createPaymentRequired("eip155:84532", "0xinitial");
  const resultPaymentRequired = createPaymentRequired(
    "eip155:84532",
    "0xresult",
    "/external/v1/x402/search/search-persist",
  );
  const paymentContext = {
    id: "search-persist",
    paymentRequired: initialPaymentRequired,
    paymentSignature: "initial-signature",
  };
  let requestCount = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders() {
        return { "payment-signature": "rotated-signature" };
      },
    },
    fetch: async (_url, init) => {
      requestCount += 1;
      assert.equal(new Headers(init?.headers).get("payment-signature"), requestCount === 1 ? "initial-signature" : "rotated-signature");
      if (requestCount === 1) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": encodePaymentRequired(resultPaymentRequired) },
        });
      }
      return createJsonResponse({
        id: "search-persist",
        status: "completed",
        query: "persist",
        result: { answer: "persisted", citations: [] },
      });
    },
  });

  const refreshed = await client.getSearchWithPaymentContext("search-persist", { paymentContext });

  assert.equal(refreshed.search.result?.answer, "persisted");
  assert.equal(refreshed.paymentContext, paymentContext);
  assert.equal(refreshed.paymentContext.paymentSignature, "rotated-signature");

  const resumedContext = JSON.parse(JSON.stringify(refreshed.paymentContext));
  let resumedSignature;
  const resumedClient = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders() {
        throw new Error("the resumed proof should be replayed without signing again");
      },
    },
    fetch: async (_url, init) => {
      resumedSignature = new Headers(init?.headers).get("payment-signature");
      return createJsonResponse({
        id: "search-persist",
        status: "completed",
        query: "persist",
        result: { answer: "resumed", citations: [] },
      });
    },
  });

  const resumed = await resumedClient.getSearch("search-persist", { paymentContext: resumedContext });
  assert.equal(resumed.result?.answer, "resumed");
  assert.equal(resumedSignature, "rotated-signature");
});

test("fresh result challenges preserve Base and Solana network requirements", async () => {
  const networkFixtures = [
    ["eip155:84532", "base-result-signature"],
    ["solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "solana-result-signature"],
  ];

  for (const [network, resultSignature] of networkFixtures) {
    const paymentRequired = createPaymentRequired(network, `${network}-payto`, `/search/${network}`);
    const context = {
      id: `search-${network}`,
      paymentRequired: createPaymentRequired(network, `${network}-initial`),
      paymentSignature: `${network}-initial-signature`,
    };
    let signCalls = 0;
    let requests = 0;
    let retrySignature;

    const client = createOptimaiX402Client({
      baseUrl: "https://example.com",
      paymentHandler: {
        async createPaymentHeaders(challenge) {
          signCalls += 1;
          assert.equal(challenge.accepts[0].network, network);
          return { "payment-signature": resultSignature };
        },
      },
      fetch: async (_url, init) => {
        requests += 1;
        if (requests === 1) {
          assert.equal(new Headers(init?.headers).get("payment-signature"), context.paymentSignature);
          return new Response("{}", {
            status: 402,
            headers: { "payment-required": encodePaymentRequired(paymentRequired) },
          });
        }

        retrySignature = new Headers(init?.headers).get("payment-signature");
        return createJsonResponse({
          id: context.id,
          status: "completed",
          query: network,
          result: { answer: network, citations: [] },
        });
      },
    });

    const result = await client.getSearchWithPaymentContext(context.id, { paymentContext: context });
    assert.equal(result.search.result?.answer, network);
    assert.equal(signCalls, 1);
    assert.equal(retrySignature, resultSignature);
    assert.equal(context.paymentRequired.accepts[0].network, network);
    assert.equal(context.paymentSignature, resultSignature);
  }
});

test("terminal failed, cancelled, and resultless responses do not trigger a fresh payment", async () => {
  const terminalStatuses = ["failed", "cancelled", "completed"];

  for (const status of terminalStatuses) {
    const context = {
      id: `search-${status}`,
      paymentRequired: createPaymentRequired("eip155:8453", "0xinitial"),
      paymentSignature: `${status}-initial-signature`,
    };
    let paymentHandlerCalls = 0;

    const client = createOptimaiX402Client({
      baseUrl: "https://example.com",
      paymentHandler: {
        async createPaymentHeaders() {
          paymentHandlerCalls += 1;
          return { "payment-signature": "unexpected-signature" };
        },
      },
      fetch: async (_url, init) => {
        assert.equal(new Headers(init?.headers).get("payment-signature"), context.paymentSignature);
        return createJsonResponse({
          id: context.id,
          status,
          query: status,
          ...(status === "failed" ? { error: { code: "search_failed", message: "failed" } } : {}),
        });
      },
    });

    const result = await client.getSearch(context.id, { paymentContext: context });
    assert.equal(result.status, status);
    assert.equal(paymentHandlerCalls, 0);
    assert.equal(context.paymentSignature, `${status}-initial-signature`);
  }
});

test("waitForSearchCompletion times out without requesting or paying a result", async () => {
  const context = {
    id: "search-timeout",
    paymentRequired: createPaymentRequired("eip155:8453", "0xinitial"),
    paymentSignature: "initial-signature",
  };
  let requests = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders() {
        throw new Error("the existing authorization should be replayed");
      },
    },
    fetch: async (_url, init) => {
      requests += 1;
      assert.equal(new Headers(init?.headers).get("payment-signature"), "initial-signature");
      return createJsonResponse({
        id: context.id,
        status: "pending",
        query: "timeout",
      }, { status: 202 });
    },
  });

  await assert.rejects(
    () => client.waitForSearchCompletion(context.id, {
      paymentContext: context,
      intervalMs: 0,
      timeoutMs: -1,
    }),
    /Timed out waiting for search search-timeout to finish/,
  );
  assert.equal(requests, 1);
});

test("waitForSearchCompletion keeps polling with the initial proof and pays only the final result challenge", async () => {
  const initialPaymentRequired = createPaymentRequired("eip155:8453", "0xinitial");
  const resultPaymentRequired = createPaymentRequired("eip155:8453", "0xresult", "/search/wait");
  const context = {
    id: "search-wait",
    paymentRequired: initialPaymentRequired,
    paymentSignature: "initial-signature",
  };
  const seenSignatures = [];
  let requests = 0;
  let paymentHandlerCalls = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders(challenge) {
        paymentHandlerCalls += 1;
        assert.deepEqual(challenge, resultPaymentRequired);
        return { "payment-signature": "result-signature" };
      },
    },
    fetch: async (_url, init) => {
      requests += 1;
      const signature = new Headers(init?.headers).get("payment-signature");
      seenSignatures.push(signature);
      if (requests === 1) {
        return createJsonResponse({ id: context.id, status: "pending", query: "wait" }, { status: 202 });
      }
      if (requests === 2) {
        return createJsonResponse({ id: context.id, status: "searching", query: "wait" }, { status: 202 });
      }
      if (requests === 3) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": encodePaymentRequired(resultPaymentRequired) },
        });
      }

      return createJsonResponse({
        id: context.id,
        status: "completed",
        query: "wait",
        result: { answer: "waited", citations: [] },
      });
    },
  });

  const completed = await client.waitForSearchCompletion(context.id, {
    paymentContext: context,
    intervalMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(completed.result?.answer, "waited");
  assert.deepEqual(seenSignatures, ["initial-signature", "initial-signature", "initial-signature", "result-signature"]);
  assert.equal(paymentHandlerCalls, 1);
  assert.equal(context.paymentSignature, "result-signature");
});

test("waitForSearchCompletion keeps polling completed verified_unsettled responses until the settled result arrives", async () => {
  const initialPaymentRequired = createPaymentRequired("eip155:8453", "0xinitial");
  const resultPaymentRequired = createPaymentRequired("eip155:8453", "0xresult", "/search/recovery");
  const context = {
    id: "search-recovery",
    paymentRequired: initialPaymentRequired,
    paymentSignature: "initial-signature",
  };
  const seenSignatures = [];
  let requests = 0;
  let paymentHandlerCalls = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders(challenge) {
        paymentHandlerCalls += 1;
        assert.deepEqual(challenge, resultPaymentRequired);
        return { "payment-signature": "result-signature" };
      },
    },
    fetch: async (_url, init) => {
      requests += 1;
      const signature = new Headers(init?.headers).get("payment-signature");
      seenSignatures.push(signature);
      if (requests === 1) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": encodePaymentRequired(resultPaymentRequired) },
        });
      }
      if (requests === 2) {
        assert.equal(signature, "result-signature");
        return createJsonResponse({
          id: context.id,
          status: "completed",
          x402_payment_status: "verified_unsettled",
          query: "recovery",
        }, { status: 202 });
      }

      assert.equal(signature, "result-signature");
      return createJsonResponse({
        id: context.id,
        status: "completed",
        x402_payment_status: "settled",
        query: "recovery",
        result: { answer: "recovered result", citations: [] },
      });
    },
  });

  const completed = await client.waitForSearchCompletionWithPaymentContext(context.id, {
    paymentContext: context,
    intervalMs: 0,
    timeoutMs: 1_000,
  });

  assert.equal(completed.search.result?.answer, "recovered result");
  assert.equal(completed.search.x402_payment_status, "settled");
  assert.deepEqual(seenSignatures, ["initial-signature", "result-signature", "result-signature"]);
  assert.equal(paymentHandlerCalls, 1);
  assert.equal(context.paymentSignature, "result-signature");
  assert.deepEqual(context.paymentRequired, resultPaymentRequired);
});

test("waitForSearchCompletion returns completed no-result voided and settlement_failed responses", async () => {
  for (const paymentStatus of ["voided", "settlement_failed"]) {
    const context = {
      id: `search-${paymentStatus}`,
      paymentRequired: createPaymentRequired("eip155:8453", "0xinitial"),
      paymentSignature: `${paymentStatus}-signature`,
    };
    let requests = 0;

    const client = createOptimaiX402Client({
      baseUrl: "https://example.com",
      paymentHandler: {
        async createPaymentHeaders() {
          throw new Error("a stored terminal proof should be replayed");
        },
      },
      fetch: async (_url, init) => {
        requests += 1;
        assert.equal(new Headers(init?.headers).get("payment-signature"), context.paymentSignature);
        return createJsonResponse({
          id: context.id,
          status: "completed",
          x402_payment_status: paymentStatus,
          query: paymentStatus,
        });
      },
    });

    const response = await client.waitForSearchCompletion(context.id, {
      paymentContext: context,
      intervalMs: 0,
      timeoutMs: 1_000,
    });

    assert.equal(response.status, "completed");
    assert.equal(response.x402_payment_status, paymentStatus);
    assert.equal(response.result, undefined);
    assert.equal(requests, 1);
  }
});

test("getSearch does not loop when the retried result request is challenged again", async () => {
  const initialPaymentRequired = createPaymentRequired("eip155:8453", "0xinitial");
  const resultPaymentRequired = createPaymentRequired("eip155:8453", "0xresult", "/search/loop");
  const context = {
    id: "search-loop",
    paymentRequired: initialPaymentRequired,
    paymentSignature: "initial-signature",
  };
  let paymentHandlerCalls = 0;
  let requests = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders(challenge) {
        paymentHandlerCalls += 1;
        assert.deepEqual(challenge, resultPaymentRequired);
        return { "payment-signature": "result-signature" };
      },
    },
    fetch: async (_url, init) => {
      requests += 1;
      const signature = new Headers(init?.headers).get("payment-signature");
      if (requests === 1) {
        assert.equal(signature, "initial-signature");
      } else {
        assert.equal(signature, "result-signature");
      }
      return new Response("{}", {
        status: 402,
        headers: { "payment-required": encodePaymentRequired(resultPaymentRequired) },
      });
    },
  });

  await assert.rejects(
    () => client.getSearch(context.id, { paymentContext: context }),
    (error) => {
      assert.ok(error instanceof OptimaiX402ApiError);
      assert.equal(error.status, 402);
      return true;
    },
  );
  assert.equal(requests, 2);
  assert.equal(paymentHandlerCalls, 1);
  assert.equal(context.paymentSignature, "result-signature");
});

test("createSearch surfaces JSON API errors from the paid request", async () => {
  const paymentRequired = {
    x402Version: 2,
    resource: {
      url: "/external/v1/x402/search",
    },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:8453",
        asset: "0xasset",
        amount: "10000",
        payTo: "0xpayto",
        maxTimeoutSeconds: 300,
      },
    ],
  };

  const encodedChallenge = Buffer.from(JSON.stringify(paymentRequired), "utf8").toString("base64");
  let requestCount = 0;

  const client = createOptimaiX402Client({
    baseUrl: "https://example.com",
    paymentHandler: {
      async createPaymentHeaders() {
        return {
          "payment-signature": "paid-signature",
        };
      },
    },
    fetch: async () => {
      requestCount += 1;
      if (requestCount === 1) {
        return new Response("{}", {
          status: 402,
          headers: { "payment-required": encodedChallenge },
        });
      }

      return createJsonResponse({
        error: {
          code: "invalid_payment_verification",
          message: "Payment was rejected",
          details: { reason: "expired" },
        },
        request_id: "req_123",
      }, { status: 402 });
    },
  });

  await assert.rejects(
    () => client.createSearch({ query: "fail" }),
    (error) => {
      assert.ok(error instanceof OptimaiX402ApiError);
      assert.equal(error.status, 402);
      assert.equal(error.code, "invalid_payment_verification");
      assert.deepEqual(error.details, { reason: "expired" });
      return true;
    },
  );
});
