export { OptimaiX402ApiError, OptimaiX402Error } from "./errors.js";
export { OptimaiX402Client, createOptimaiX402Client, type OptimaiX402ClientConfig } from "./client.js";
export {
  createSolanaPaymentHandler,
  createViemPaymentHandler,
  type PaymentHandler,
  type SolanaPaymentHandlerConfig,
  type ViemPaymentHandlerConfig,
} from "./payment.js";
export type {
  CancelSearchResponse,
  CreateSearchOptions,
  CreateSearchRequest,
  CreateSearchResult,
  ExternalSearchCitation,
  ExternalSearchError,
  ExternalSearchProgress,
  ExternalSearchResponse,
  ExternalSearchResult,
  ExternalSearchStatus,
  RequestOptions,
  SearchAccessOptions,
  SearchAccessResult,
  SearchPaymentContext,
  WaitForSearchCompletionOptions,
  X402AcceptedPaymentRequirements,
  X402PaymentRequired,
  X402PaymentResource,
  X402PaymentStatus,
} from "./types.js";
