// Thin PayPal REST API wrapper — networking only, no business logic. Every
// function takes its credentials/base URL as explicit parameters (never
// reads Deno.env itself) so callers control exactly what's injected and
// tests can supply a fake `fetchImpl` without ever touching real
// credentials or the network. Verified against PayPal's own REST API
// reference (developer.paypal.com/api/rest/) rather than assumed:
//   - OAuth2:                POST /v1/oauth2/token (client_credentials grant,
//                             HTTP Basic auth with client_id:client_secret)
//   - Subscriptions:         POST /v1/billing/subscriptions
//                             GET  /v1/billing/subscriptions/{id}
//                             POST /v1/billing/subscriptions/{id}/cancel
//   - Refunds:               POST /v2/payments/captures/{capture_id}/refund
//   - Webhook verification:  POST /v1/notifications/verify-webhook-signature
//
// PAYPAL_CLIENT_SECRET (and the client id) are read once, at the Edge
// Function boundary (paypal_provider.ts / paypal-webhook/index.ts), from
// Supabase Function secrets — never hardcoded here, never logged, never
// returned to a caller.

export type PayPalEnv = "sandbox" | "live";

export function payPalBaseUrl(env: PayPalEnv): string {
  return env === "live" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
}

export class PayPalApiError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    // The status/body carry PayPal's own rejection reason (e.g. an
    // `invalid_client` OAuth2 error, or a specific plan/subscription
    // validation failure) - folded into the Error's own `.message` rather
    // than left as separate properties, so a generic `console.error("...",
    // err)` call site (every catch block in this codebase logs errors this
    // way) still surfaces the actual cause instead of just this class's own
    // generic wrapper text.
    super(`${message} (status ${status}): ${body}`);
  }
}

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
}

export interface PayPalClientOptions {
  env: PayPalEnv;
  credentials: PayPalCredentials;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

// Module-level cache, keyed by client id — Edge Function isolates can be
// reused across invocations, so this saves a redundant OAuth round trip
// when that happens; it is a pure optimization, never relied on for
// correctness (a cold isolate simply re-fetches). Never persisted, never
// exposed outside this module.
const tokenCache = new Map<string, CachedToken>();
const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;

async function fetchAccessToken(options: PayPalClientOptions): Promise<string> {
  const { env, credentials, fetchImpl = fetch } = options;
  const cacheKey = `${env}:${credentials.clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAtMs > Date.now() + TOKEN_EXPIRY_SAFETY_MARGIN_MS) {
    return cached.accessToken;
  }

  const basicAuth = btoa(`${credentials.clientId}:${credentials.clientSecret}`);
  const res = await fetchImpl(`${payPalBaseUrl(env)}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });

  const bodyText = await res.text();
  if (!res.ok) {
    // Never include the Authorization header (or credentials) in the thrown
    // error — only PayPal's own response body, which describes the OAuth
    // failure reason without echoing back what we sent.
    throw new PayPalApiError("PayPal OAuth2 token request failed.", res.status, bodyText);
  }

  const parsed = JSON.parse(bodyText) as { access_token?: string; expires_in?: number };
  if (!parsed.access_token) {
    throw new PayPalApiError("PayPal OAuth2 response had no access_token.", res.status, bodyText);
  }

  tokenCache.set(cacheKey, {
    accessToken: parsed.access_token,
    expiresAtMs: Date.now() + (parsed.expires_in ?? 0) * 1000,
  });
  return parsed.access_token;
}

async function payPalFetch(
  options: PayPalClientOptions,
  path: string,
  init: { method: string; body?: unknown; extraHeaders?: Record<string, string> },
): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
  const { fetchImpl = fetch } = options;
  const accessToken = await fetchAccessToken(options);
  const res = await fetchImpl(`${payPalBaseUrl(options.env)}${path}`, {
    method: init.method,
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...init.extraHeaders,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, text };
}

export interface CreateSubscriptionParams {
  planId: string;
  customId: string;
  returnUrl: string;
  cancelUrl: string;
  /** Shown on PayPal's approval page; kept short and non-sensitive. */
  subscriberEmail?: string;
}

export interface CreateSubscriptionResult {
  subscriptionId: string;
  approvalUrl: string | null;
  status: string;
}

/** Extracts the "approve" link PayPal returns alongside a created
 * subscription — the URL the buyer is redirected to. */
function findApproveLink(links: unknown): string | null {
  if (!Array.isArray(links)) return null;
  const approve = links.find(
    (link) => link && typeof link === "object" && (link as Record<string, unknown>).rel === "approve",
  ) as Record<string, unknown> | undefined;
  return typeof approve?.href === "string" ? approve.href : null;
}

export async function createSubscription(
  options: PayPalClientOptions,
  params: CreateSubscriptionParams,
): Promise<CreateSubscriptionResult> {
  const { status, json, text } = await payPalFetch(options, "/v1/billing/subscriptions", {
    method: "POST",
    body: {
      plan_id: params.planId,
      custom_id: params.customId,
      subscriber: params.subscriberEmail ? { email_address: params.subscriberEmail } : undefined,
      application_context: {
        brand_name: "SellerPilot AI Pro",
        user_action: "SUBSCRIBE_NOW",
        return_url: params.returnUrl,
        cancel_url: params.cancelUrl,
      },
    },
    extraHeaders: { "PayPal-Request-Id": crypto.randomUUID() },
  });

  if (status < 200 || status >= 300 || !json || typeof json.id !== "string") {
    throw new PayPalApiError("PayPal create-subscription request failed.", status, text);
  }

  return {
    subscriptionId: json.id,
    approvalUrl: findApproveLink(json.links),
    status: typeof json.status === "string" ? json.status : "unknown",
  };
}

export interface GetSubscriptionResult {
  subscriptionId: string;
  status: string;
  customId: string | null;
  planId: string | null;
}

export async function getSubscription(
  options: PayPalClientOptions,
  subscriptionId: string,
): Promise<GetSubscriptionResult> {
  const { status, json, text } = await payPalFetch(
    options,
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`,
    { method: "GET" },
  );
  if (status < 200 || status >= 300 || !json || typeof json.id !== "string") {
    throw new PayPalApiError("PayPal get-subscription request failed.", status, text);
  }
  return {
    subscriptionId: json.id,
    status: typeof json.status === "string" ? json.status : "unknown",
    customId: typeof json.custom_id === "string" ? json.custom_id : null,
    planId: typeof json.plan_id === "string" ? json.plan_id : null,
  };
}

export async function cancelPayPalSubscription(
  options: PayPalClientOptions,
  subscriptionId: string,
  reason = "Cancelled by SellerPilot AI Pro.",
): Promise<void> {
  const { status, text } = await payPalFetch(
    options,
    `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`,
    { method: "POST", body: { reason } },
  );
  // PayPal returns 204 No Content on success. A 404 means the subscription
  // is already gone/unknown to PayPal - treated as success (idempotent from
  // our side: our own `cancel-subscription/index.ts` DB update already
  // happened regardless), not surfaced as a hard failure.
  if (status !== 204 && status !== 404) {
    throw new PayPalApiError("PayPal cancel-subscription request failed.", status, text);
  }
}

export interface RefundResultRaw {
  refunded: boolean;
  refundId: string | null;
}

export async function refundCapture(options: PayPalClientOptions, captureId: string): Promise<RefundResultRaw> {
  const { status, json } = await payPalFetch(
    options,
    `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
    { method: "POST", body: {}, extraHeaders: { "PayPal-Request-Id": crypto.randomUUID() } },
  );
  if (status < 200 || status >= 300) {
    // A failed refund is a normal, expected outcome (already refunded,
    // capture too old, etc.) - reported back to the caller, not thrown, so
    // it can be recorded the same way MockPaymentProvider.refund() reports
    // "not refunded" rather than treating every non-success as an exception.
    return { refunded: false, refundId: null };
  }
  return { refunded: true, refundId: typeof json?.id === "string" ? json.id : null };
}

export interface VerifyWebhookSignatureParams {
  transmissionId: string;
  transmissionTime: string;
  certUrl: string;
  authAlgo: string;
  transmissionSig: string;
  webhookId: string;
  webhookEvent: unknown;
}

export async function verifyWebhookSignature(
  options: PayPalClientOptions,
  params: VerifyWebhookSignatureParams,
): Promise<boolean> {
  const { status, json } = await payPalFetch(options, "/v1/notifications/verify-webhook-signature", {
    method: "POST",
    body: {
      transmission_id: params.transmissionId,
      transmission_time: params.transmissionTime,
      cert_url: params.certUrl,
      auth_algo: params.authAlgo,
      transmission_sig: params.transmissionSig,
      webhook_id: params.webhookId,
      webhook_event: params.webhookEvent,
    },
  });
  if (status < 200 || status >= 300 || !json) {
    console.error("PayPal verify-webhook-signature API call did not return a usable response. Status:", status, "Body:", json);
    return false;
  }
  if (json.verification_status !== "SUCCESS") {
    console.error("PayPal verify-webhook-signature returned verification_status:", json.verification_status);
  }
  return json.verification_status === "SUCCESS";
}
