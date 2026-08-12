import { ExactEvmScheme, toClientEvmSigner, type ClientEvmSigner } from "@x402/evm";
import { type PaymentRequired, x402Client, x402HTTPClient } from "@x402/fetch";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { Keypair } from "@solana/web3.js";
import { base58 } from "@scure/base";
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

export interface SolanaPaymentHandlerConfig {
  privateKey?: string | Uint8Array;
  keypair?: Keypair;
  rpcUrls?: Record<string, string>;
}

interface PaymentClientBundle {
  client: ReturnType<typeof x402Client.fromConfig>;
  httpClient: x402HTTPClient;
}

const DEFAULT_CHAINS: Record<string, Chain> = {
  "eip155:8453": base,
  "eip155:84532": baseSepolia,
};

const SOLANA_MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOLANA_DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
const DEFAULT_SOLANA_RPC_URLS: Record<string, string> = {
  [SOLANA_MAINNET_CAIP2]: "https://api.mainnet-beta.solana.com",
  [SOLANA_DEVNET_CAIP2]: "https://api.devnet.solana.com",
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

export function clonePaymentRequiredWithAccept(
  paymentRequired: X402PaymentRequired,
  networkPrefix: string,
  isSupported: (requirement: X402PaymentRequired["accepts"][number]) => boolean = () => true,
): X402PaymentRequired {
  const accepted = paymentRequired.accepts.find((requirement) =>
    requirement.network.startsWith(networkPrefix) && isSupported(requirement),
  );
  if (!accepted) {
    throw new OptimaiX402Error(`x402 payment challenge does not include a supported ${networkPrefix} network.`);
  }

  return {
    ...paymentRequired,
    accepts: [accepted],
  };
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

function canUseViemPaymentRequirement(
  requirement: X402PaymentRequired["accepts"][number],
  config: ViemPaymentHandlerConfig,
): boolean {
  try {
    const chain = resolveChain(requirement.network, config);
    resolveRpcUrl(requirement.network, chain, config);
    return true;
  } catch (_error) {
    return false;
  }
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
      const selectedPaymentRequired = clonePaymentRequiredWithAccept(
        paymentRequired,
        "eip155:",
        (requirement) => canUseViemPaymentRequirement(requirement, config),
      );
      const network = selectedPaymentRequired.accepts[0]!.network;

      let bundle = bundles.get(network);
      if (!bundle) {
        bundle = createPaymentClientBundle(network, account, config);
        bundles.set(network, bundle);
      }

      const paymentPayload = await bundle.client.createPaymentPayload(selectedPaymentRequired as PaymentRequired);
      return normalizeHeaders(bundle.httpClient.encodePaymentSignatureHeader(paymentPayload));
    },
  };
}

function normalizeSolanaPrivateKey(value: string | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) {
    if (value.length !== 64) {
      throw new OptimaiX402Error("Invalid Solana private key. Expected a 64-byte secret key.");
    }
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new OptimaiX402Error("Invalid Solana private key. Expected a base58 or JSON-encoded 64-byte secret key.");
  }

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length === 64 &&
        parsed.every((item) => Number.isInteger(item) && item >= 0 && item <= 255)
      ) {
        return Uint8Array.from(parsed as number[]);
      }
    } catch (_error) {
      // Fall through to base58 parsing for a consistent user-facing error.
    }
  }

  try {
    const decoded = base58.decode(trimmed);
    if (decoded.length !== 64) {
      throw new Error("invalid length");
    }
    return decoded;
  } catch (_error) {
    throw new OptimaiX402Error("Invalid Solana private key. Expected a base58 or JSON-encoded 64-byte secret key.");
  }
}

function resolveSolanaRpcUrl(network: string, config: SolanaPaymentHandlerConfig): string | undefined {
  return config.rpcUrls?.[network] ?? DEFAULT_SOLANA_RPC_URLS[network];
}

export async function createSolanaPaymentHandler(config: SolanaPaymentHandlerConfig): Promise<PaymentHandler> {
  const secretKey = config.keypair?.secretKey ?? (config.privateKey ? normalizeSolanaPrivateKey(config.privateKey) : null);
  if (!secretKey) {
    throw new OptimaiX402Error("Solana payment handler requires privateKey or keypair.");
  }

  const signer = await createKeyPairSignerFromBytes(secretKey);
  const bundles = new Map<string, PaymentClientBundle>();

  return {
    async createPaymentHeaders(paymentRequired: X402PaymentRequired): Promise<Record<string, string>> {
      const selectedPaymentRequired = clonePaymentRequiredWithAccept(paymentRequired, "solana:");
      const network = selectedPaymentRequired.accepts[0]!.network;

      let bundle = bundles.get(network);
      if (!bundle) {
        const rpcUrl = resolveSolanaRpcUrl(network, config);
        const client = x402Client.fromConfig({
          schemes: [
            {
              network: "solana:*",
              client: new ExactSvmScheme(signer, rpcUrl ? { rpcUrl } : undefined),
            },
          ],
        });
        bundle = {
          client,
          httpClient: new x402HTTPClient(client),
        };
        bundles.set(network, bundle);
      }

      const paymentPayload = await bundle.client.createPaymentPayload(selectedPaymentRequired as PaymentRequired);
      return normalizeHeaders(bundle.httpClient.encodePaymentSignatureHeader(paymentPayload));
    },
  };
}
