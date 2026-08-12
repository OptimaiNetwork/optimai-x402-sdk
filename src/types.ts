export interface X402PaymentResource {
  url: string;
  description?: string;
  mimeType?: string;
}

export interface X402AcceptedPaymentRequirements {
  scheme: "exact";
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown> | null;
}

export interface X402PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: X402PaymentResource;
  accepts: X402AcceptedPaymentRequirements[];
  extensions?: Record<string, unknown> | null;
}

export interface CreateSearchRequest {
  query: string;
  callback_url?: string;
  metadata?: Record<string, unknown>;
  options?: {
    timeout_seconds?: number;
    min_sources?: number;
  };
}

export type ExternalSearchStatus =
  | "pending"
  | "planning"
  | "searching"
  | "processing"
  | "aggregating"
  | "completed"
  | "failed"
  | "cancelled";

export type X402PaymentStatus =
  // Canonical server status: payment is verified, but settlement is not finalized in OptimAI yet.
  // On-chain transfer may already exist while the server is still confirming/persisting settlement id.
  | "verified_unsettled"
  // Legacy name retained for compatibility with older server responses and SDK callers.
  | "settlement_unconfirmed"
  // Settlement is finalized and the server has persisted settlement id (transaction hash).
  | "settled"
  // Payment was voided (typically when the request is cancelled or fails before settlement).
  | "voided"
  // Server exhausted settlement retries and needs manual/operator follow-up.
  | "settlement_failed";

export interface ExternalSearchCitation {
  id: number;
  url: string;
  title?: string | null;
  snippet?: string | null;
  domain?: string;
  published_date?: string | null;
}

export interface ExternalSearchProgress {
  stage: string;
  percent?: number;
  current_step?: string;
  sources_found?: number;
  sources_analyzed?: number;
  sources_relevant?: number;
}

export interface ExternalSearchResult {
  answer: string;
  summary?: string;
  citations: ExternalSearchCitation[];
  related_questions?: string[];
  sources_found?: number;
  sources_analyzed?: number;
  sources_relevant?: number;
  search_queries_used?: string[];
}

export interface ExternalSearchError {
  code: string;
  message: string;
}

export interface ExternalSearchResponse {
  id: string;
  status: ExternalSearchStatus;
  query: string;
  x402_payment_status?: X402PaymentStatus;
  progress?: ExternalSearchProgress;
  result?: ExternalSearchResult;
  error?: ExternalSearchError;
}

export interface CancelSearchResponse {
  id: string;
  status: "cancelled";
  cancelled_at: string;
}

export interface SearchPaymentContext {
  id: string;
  paymentRequired: X402PaymentRequired;
  paymentSignature?: string;
}

export interface CreateSearchResult {
  search: ExternalSearchResponse;
  paymentContext: SearchPaymentContext;
}

export interface SearchAccessResult {
  search: ExternalSearchResponse;
  paymentContext: SearchPaymentContext;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

export interface CreateSearchOptions extends RequestOptions {
  idempotencyKey?: string;
  existingPaymentContext?: SearchPaymentContext;
}

export interface SearchAccessOptions extends RequestOptions {
  paymentContext?: SearchPaymentContext;
}

export interface WaitForSearchCompletionOptions extends SearchAccessOptions {
  intervalMs?: number;
  timeoutMs?: number;
}
