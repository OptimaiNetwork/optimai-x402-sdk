import { ExactEvmScheme, toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import { type PaymentRequired, x402Client, x402HTTPClient } from "@x402/fetch";
import { createPublicClient, http, type Chain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { OptimaiX402Error } from "./errors.js";
import type { X402PaymentRequired } from "./types.js";

export interface PaymentHandler {
  createPaymentHeaders(paymentRequired: X402PaymentRequired): Promise<Record<string, string>>;
}

export interface ViemPaymentHandlerConfig {
  privateKey: string;
  rpcUrls?: Record<string, string>;
  chains?: Record<string, Chain>;
}

interface PaymentClientBundle {
  client: ReturnType<typeof x402Client.fromConfig>;
  httpClient: x402HTTPClient;
}

const DEFAULT_CHAINS: Record<string, Chain> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};

function normalizePrivateKey(privateKey: string): `0x${string}` {
  const trimmed = privateKey.trim();
  const normalized = trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new OptimaiX402Error(
      "Invalid private key format. Expected 32-byte hex, with or without 0x prefix.",
    );
  }
  return normalized as `0x${string}`;
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function resolveChain(network: string, config: ViemPaymentHandlerConfig): Chain {
  const configured = config.chains?.[network];
  if (configured) {
    return configured;
  }

  const builtin = DEFAULT_CHAINS[network];
  if (builtin) {
    return builtin;
  }

  throw new OptimaiX402Error(`Unsupported x402 network: ${network}`);
}

function resolveRpcUrl(network: string, chain: Chain, config: ViemPaymentHandlerConfig): string {
  const configured = config.rpcUrls?.[network];
  if (configured) {
    return configured;
  }

  const defaultRpcUrl = chain.rpcUrls.default.http[0];
  if (defaultRpcUrl) {
    return defaultRpcUrl;
  }

  throw new OptimaiX402Error(`Missing RPC URL for x402 network: ${network}`);
}

function createPaymentClientBundle(
  network: string,
  account: ReturnType<typeof privateKeyToAccount>,
  config: ViemPaymentHandlerConfig,
): PaymentClientBundle {
  const chain = resolveChain(network, config);
  const publicClient = createPublicClient({
    chain,
    transport: http(resolveRpcUrl(network, chain, config)),
  });

  const signer = toClientEvmSigner(account, {
    readContract: publicClient.readContract.bind(publicClient),
    getTransactionCount: async ({ address }) => publicClient.getTransactionCount({ address }),
    estimateFeesPerGas: async () => {
      const fees = await publicClient.estimateFeesPerGas();
      if (!("maxFeePerGas" in fees) || !fees.maxFeePerGas || !fees.maxPriorityFeePerGas) {
        throw new OptimaiX402Error("EIP-1559 fee data is required for x402 payments.");
      }

      return {
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    },
  } satisfies Pick<ClientEvmSigner, "readContract" | "getTransactionCount" | "estimateFeesPerGas">);

  const client = x402Client.fromConfig({
    schemes: [
      {
        network: "eip155:*",
        client: new ExactEvmScheme(signer),
      },
    ],
  });

  return {
    client,
    httpClient: new x402HTTPClient(client),
  };
}

export function createViemPaymentHandler(config: ViemPaymentHandlerConfig): PaymentHandler {
  const account = privateKeyToAccount(normalizePrivateKey(config.privateKey));
  const bundles = new Map<string, PaymentClientBundle>();

  return {
    async createPaymentHeaders(paymentRequired: X402PaymentRequired): Promise<Record<string, string>> {
      const network = paymentRequired.accepts[0]?.network;
      if (!network) {
        throw new OptimaiX402Error("x402 payment challenge does not include a supported network.");
      }

      let bundle = bundles.get(network);
      if (!bundle) {
        bundle = createPaymentClientBundle(network, account, config);
        bundles.set(network, bundle);
      }

      const paymentPayload = await bundle.client.createPaymentPayload(paymentRequired as PaymentRequired);
      return normalizeHeaders(bundle.httpClient.encodePaymentSignatureHeader(paymentPayload));
    },
  };
}
