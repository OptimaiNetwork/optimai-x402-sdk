import { OptimaiX402ApiError, OptimaiX402Error } from "./errors.js";
import type {
  CancelSearchResponse,
  CreateSearchOptions,
  CreateSearchRequest,
  CreateSearchResult,
  ExternalSearchResponse,
  SearchAccessResult,
  SearchAccessOptions,
  SearchPaymentContext,
  WaitForSearchCompletionOptions,
  X402PaymentRequired,
} from "./types.js";
import type { PaymentHandler } from "./payment.js";

export interface OptimaiX402ClientConfig {
  baseUrl: string;
  paymentHandler: PaymentHandler;
  fetch?: typeof fetch;
}

interface JsonApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
  request_id?: string;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function normalizePath(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function mergeHeaders(...headerSets: Array<HeadersInit | undefined>): Headers {
  const merged = new Headers();
  for (const headerSet of headerSets) {
    if (!headerSet) {
      continue;
    }

    const headers = new Headers(headerSet);
    headers.forEach((value, key) => {
      merged.set(key, value);
    });
  }
  return merged;
}

function cloneInitWithHeaders(init: RequestInit, headers: Headers): RequestInit {
  return {
    ...init,
    headers,
  };
}

function withOptionalSignal<T extends object>(value: T, signal?: AbortSignal): T & { signal?: AbortSignal } {
  return signal ? { ...value, signal } : value;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout);
      reject(new OptimaiX402Error("The request was aborted."));
    };
    const resolveWithCleanup = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timeout = setTimeout(resolveWithCleanup, ms);

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function decodePaymentRequiredHeader(headerValue: string): X402PaymentRequired {
  try {
    const decoded = Buffer.from(headerValue, "base64").toString("utf8");
    return JSON.parse(decoded) as X402PaymentRequired;
  } catch (_error) {
    throw new OptimaiX402Error("Invalid payment-required header received from the server.");
  }
}

function getPaymentSignatureFromHeaders(headers: HeadersInit): string | undefined {
  const normalized = new Headers(headers);
  const paymentSignature = normalized.get("payment-signature")
    ?? normalized.get("Payment-Signature");
  return paymentSignature ?? undefined;
}

function isTerminalStatus(search: ExternalSearchResponse): boolean {
  if (search.status === "failed" || search.status === "cancelled") {
    return true;
  }

  if (search.status !== "completed") {
    return false;
  }

  if (search.result) {
    return true;
  }

  // Settlement recovery can briefly expose a completed job without its result.
  // Keep polling while the verified payment is still unsettled.
  return search.x402_payment_status !== "verified_unsettled"
    && search.x402_payment_status !== "settlement_unconfirmed";
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) {
    return null;
  }

  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toApiError(status: number, body: unknown): OptimaiX402ApiError {
  if (body && typeof body === "object") {
    const errorBody = body as JsonApiErrorBody;
    const message = errorBody.error?.message ?? `Request failed with status ${status}`;
    return new OptimaiX402ApiError(
      message,
      status,
      errorBody.error?.code,
      errorBody.error?.details,
      body,
    );
  }

  return new OptimaiX402ApiError(`Request failed with status ${status}`, status, undefined, undefined, body);
}

export class OptimaiX402Client {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly paymentContexts = new Map<string, SearchPaymentContext>();
  private readonly paymentContextsByIdempotencyKey = new Map<string, SearchPaymentContext>();

  constructor(private readonly config: OptimaiX402ClientConfig) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.fetchImpl = config.fetch ?? globalThis.fetch.bind(globalThis);
  }

  rememberPaymentContext(context: SearchPaymentContext): void {
    this.paymentContexts.set(context.id, context);
  }

  forgetPaymentContext(searchId: string): void {
    this.paymentContexts.delete(searchId);
  }

  async createSearch(
    input: CreateSearchRequest,
    options: CreateSearchOptions = {},
  ): Promise<CreateSearchResult> {
    const path = "/external/v1/x402/search";
    const baseHeaders = mergeHeaders(
      {
        "content-type": "application/json",
      },
      options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : undefined,
    );

    const unpaidInit: RequestInit = withOptionalSignal({
      method: "POST",
      body: JSON.stringify(input),
      headers: baseHeaders,
    }, options.signal);

    const unpaidResponse = await this.fetchImpl(`${this.baseUrl}${path}`, unpaidInit);
    const challengeHeader = unpaidResponse.headers.get("payment-required")
      ?? unpaidResponse.headers.get("x-payment-required");

    if (unpaidResponse.status !== 402 || !challengeHeader) {
      const body = await parseResponseBody(unpaidResponse);
      if (!unpaidResponse.ok) {
        throw toApiError(unpaidResponse.status, body);
      }

      throw new OptimaiX402Error("Expected a 402 payment challenge when creating an x402 search.");
    }

    const paymentRequired = decodePaymentRequiredHeader(challengeHeader);
    const paymentHeaders = await this.config.paymentHandler.createPaymentHeaders(paymentRequired);
    const paymentSignature = getPaymentSignatureFromHeaders(paymentHeaders);
    if (!paymentSignature) {
      throw new OptimaiX402Error("Payment handler did not return a payment-signature header.");
    }
    const paidResponse = await this.fetchImpl(
      `${this.baseUrl}${path}`,
      cloneInitWithHeaders(unpaidInit, mergeHeaders(baseHeaders, paymentHeaders)),
    );

    const paidBody = await parseResponseBody(paidResponse);
    if (!paidResponse.ok && paidResponse.status !== 303) {
      throw toApiError(paidResponse.status, paidBody);
    }

    let search: ExternalSearchResponse;
    let paymentContext: SearchPaymentContext;
    if (paidResponse.status === 303) {
      const id = this.extractSearchIdFromRedirect(paidBody);
      const existingPaymentContext =
        options.existingPaymentContext
        ?? (options.idempotencyKey ? this.paymentContextsByIdempotencyKey.get(options.idempotencyKey) : undefined);
      paymentContext = existingPaymentContext
        ? { ...existingPaymentContext, id }
        : { id, paymentRequired, paymentSignature };
      search = await this.getSearch(id, {
        paymentContext,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } else {
      search = paidBody as ExternalSearchResponse;
      paymentContext = {
        id: search.id,
        paymentRequired,
        paymentSignature,
      };
    }

    paymentContext.id = search.id;
    this.rememberPaymentContext(paymentContext);
    if (options.idempotencyKey) {
      this.paymentContextsByIdempotencyKey.set(options.idempotencyKey, paymentContext);
    }

    return {
      search,
      paymentContext,
    };
  }

  async getSearch(
    searchId: string,
    options: SearchAccessOptions = {},
  ): Promise<ExternalSearchResponse> {
    const response = await this.requestWithStoredContext<ExternalSearchResponse>(
      `/external/v1/x402/search/${searchId}`,
      withOptionalSignal({
        method: "GET",
      }, options.signal),
      searchId,
      options.paymentContext,
    );
    return response.body;
  }

  async getSearchWithPaymentContext(
    searchId: string,
    options: SearchAccessOptions = {},
  ): Promise<SearchAccessResult> {
    const response = await this.requestWithStoredContext<ExternalSearchResponse>(
      `/external/v1/x402/search/${searchId}`,
      withOptionalSignal({
        method: "GET",
      }, options.signal),
      searchId,
      options.paymentContext,
    );
    return {
      search: response.body,
      paymentContext: response.paymentContext,
    };
  }

  async getSearchResult(
    searchId: string,
    options: SearchAccessOptions = {},
  ): Promise<SearchAccessResult> {
    return this.getSearchWithPaymentContext(searchId, options);
  }

  async cancelSearch(
    searchId: string,
    options: SearchAccessOptions = {},
  ): Promise<CancelSearchResponse> {
    const response = await this.requestWithStoredContext<CancelSearchResponse>(
      `/external/v1/x402/search/${searchId}`,
      withOptionalSignal({
        method: "DELETE",
      }, options.signal),
      searchId,
      options.paymentContext,
    );
    return response.body;
  }

  async waitForSearchCompletion(
    searchId: string,
    options: WaitForSearchCompletionOptions = {},
  ): Promise<ExternalSearchResponse> {
    const response = await this.waitForSearchCompletionWithPaymentContext(searchId, options);
    return response.search;
  }

  async waitForSearchCompletionWithPaymentContext(
    searchId: string,
    options: WaitForSearchCompletionOptions = {},
  ): Promise<SearchAccessResult> {
    const intervalMs = options.intervalMs ?? 2_000;
    const timeoutMs = options.timeoutMs ?? 300_000;
    const startedAt = Date.now();

    while (true) {
      const response = await this.getSearchWithPaymentContext(searchId, options);
      if (isTerminalStatus(response.search)) {
        return response;
      }

      if (Date.now() - startedAt > timeoutMs) {
        throw new OptimaiX402Error(`Timed out waiting for search ${searchId} to finish.`);
      }

      await sleep(intervalMs, options.signal);
    }
  }

  private async requestWithStoredContext<T>(
    path: string,
    init: RequestInit,
    searchId: string,
    providedContext?: SearchPaymentContext,
  ): Promise<{ body: T; paymentContext: SearchPaymentContext }> {
    const paymentContext = providedContext ?? this.paymentContexts.get(searchId);
    if (!paymentContext) {
      throw new OptimaiX402Error(
        `Missing payment context for search ${searchId}. Persist the value returned by createSearch().`,
      );
    }

    this.rememberPaymentContext(paymentContext);
    const paymentHeaders = paymentContext.paymentSignature
      ? { "payment-signature": paymentContext.paymentSignature }
      : await this.config.paymentHandler.createPaymentHeaders(paymentContext.paymentRequired);
    const generatedPaymentSignature = getPaymentSignatureFromHeaders(paymentHeaders);
    if (!generatedPaymentSignature) {
      throw new OptimaiX402Error("Payment handler did not return a payment-signature header.");
    }
    if (!paymentContext.paymentSignature) {
      paymentContext.paymentSignature = generatedPaymentSignature;
      this.rememberPaymentContext(paymentContext);
    }

    const response = await this.fetchImpl(
      `${this.baseUrl}${normalizePath(path)}`,
      cloneInitWithHeaders(init, mergeHeaders(init.headers, paymentHeaders)),
    );
    const body = await parseResponseBody(response);

    const challengeHeader = response.status === 402
      ? response.headers.get("payment-required") ?? response.headers.get("x-payment-required")
      : undefined;
    if (init.method?.toUpperCase() === "GET" && challengeHeader) {
      const resultPaymentRequired = decodePaymentRequiredHeader(challengeHeader);
      const resultPaymentHeaders = await this.config.paymentHandler.createPaymentHeaders(resultPaymentRequired);
      const resultPaymentSignature = getPaymentSignatureFromHeaders(resultPaymentHeaders);
      if (!resultPaymentSignature) {
        throw new OptimaiX402Error("Payment handler did not return a payment-signature header.");
      }

      paymentContext.paymentRequired = resultPaymentRequired;
      paymentContext.paymentSignature = resultPaymentSignature;
      this.rememberPaymentContext(paymentContext);

      const retriedResponse = await this.fetchImpl(
        `${this.baseUrl}${normalizePath(path)}`,
        cloneInitWithHeaders(init, mergeHeaders(init.headers, resultPaymentHeaders)),
      );
      const retriedBody = await parseResponseBody(retriedResponse);
      if (!retriedResponse.ok) {
        throw toApiError(retriedResponse.status, retriedBody);
      }

      return {
        body: retriedBody as T,
        paymentContext,
      };
    }

    if (!response.ok) {
      throw toApiError(response.status, body);
    }

    return {
      body: body as T,
      paymentContext,
    };
  }

  private extractSearchIdFromRedirect(body: unknown): string {
    if (body && typeof body === "object" && typeof (body as { id?: unknown }).id === "string") {
      return (body as { id: string }).id;
    }

    throw new OptimaiX402Error("Redirect response did not include a search id.");
  }
}

export function createOptimaiX402Client(config: OptimaiX402ClientConfig): OptimaiX402Client {
  return new OptimaiX402Client(config);
}
