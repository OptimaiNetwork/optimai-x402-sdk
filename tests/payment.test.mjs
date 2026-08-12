import test from "node:test";
import assert from "node:assert/strict";

import { clonePaymentRequiredWithAccept } from "../dist/payment.js";

function createRequirement(network, payTo) {
  return {
    scheme: "exact",
    network,
    asset: "0xasset",
    amount: "10000",
    payTo,
    maxTimeoutSeconds: 300,
  };
}

test("clonePaymentRequiredWithAccept selects the first supported matching network", () => {
  const paymentRequired = {
    x402Version: 2,
    resource: { url: "/external/v1/x402/search" },
    accepts: [
      createRequirement("eip155:1", "0xunsupported"),
      createRequirement("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", "solana-pay-to"),
      createRequirement("eip155:84532", "0xsupported"),
    ],
  };

  const selected = clonePaymentRequiredWithAccept(
    paymentRequired,
    "eip155:",
    (requirement) => requirement.network === "eip155:84532",
  );

  assert.equal(selected.accepts.length, 1);
  assert.equal(selected.accepts[0].network, "eip155:84532");
  assert.equal(selected.accepts[0].payTo, "0xsupported");
});
