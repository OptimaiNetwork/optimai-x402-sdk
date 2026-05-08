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
