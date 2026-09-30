// PayPal webhook signature verification.
//
// Unlike Paddle (a local HMAC the receiver can compute itself — see
// paddle_signature.ts), PayPal does not document a local verification
// scheme for webhooks. The officially supported method
// (developer.paypal.com/api/rest/webhooks/#verify-webhook-signature) is a
// server-to-server call: POST the five `PAYPAL-*` transmission headers plus
// the raw event body to PayPal's own `/v1/notifications/verify-webhook-
// signature` endpoint (using an authenticated API call, same OAuth2 token as
// every other PayPal API call) and trust only a `verification_status:
// "SUCCESS"` response. This module only verifies; it has no knowledge of
// what the webhook does once accepted, and never has PayPal credentials of
// its own — both the access-token getter and the webhook id are passed in by
// the caller (paypal-webhook/index.ts), read from Supabase Function secrets
// at the edge function's boundary, never hardcoded here.
import { verifyWebhookSignature, type PayPalClientOptions } from "./paypal_client.ts";

export interface PayPalWebhookHeaders {
  transmissionId: string | null;
  transmissionTime: string | null;
  certUrl: string | null;
  authAlgo: string | null;
  transmissionSig: string | null;
}

/** PayPal's transmission headers are case-insensitive HTTP headers; `Headers`
 * already normalizes lookup case, so this just names the five required ones. */
export function extractPayPalWebhookHeaders(headers: Headers): PayPalWebhookHeaders {
  return {
    transmissionId: headers.get("paypal-transmission-id"),
    transmissionTime: headers.get("paypal-transmission-time"),
    certUrl: headers.get("paypal-cert-url"),
    authAlgo: headers.get("paypal-auth-algo"),
    transmissionSig: headers.get("paypal-transmission-sig"),
  };
}

export interface VerifyPayPalWebhookOptions {
  clientOptions: PayPalClientOptions;
  headers: PayPalWebhookHeaders;
  /** PAYPAL_WEBHOOK_ID — the id of the webhook configured in the PayPal
   * Developer Dashboard for this endpoint, a Supabase Function secret. */
  webhookId: string;
  /** The parsed JSON webhook event body — PayPal's verify endpoint wants the
   * event as a JSON object, not the raw byte string (unlike Paddle's HMAC,
   * which signs the raw body). */
  webhookEvent: unknown;
}

export async function verifyPayPalWebhookSignature(options: VerifyPayPalWebhookOptions): Promise<boolean> {
  const { headers, webhookId, webhookEvent, clientOptions } = options;

  // Never treat "no webhook id configured" as "skip verification" - same
  // fail-safe policy as Paddle's `if (!secret) return false;`.
  if (!webhookId) {
    console.error("verifyPayPalWebhookSignature: PAYPAL_WEBHOOK_ID is not configured.");
    return false;
  }

  const { transmissionId, transmissionTime, certUrl, authAlgo, transmissionSig } = headers;
  if (!transmissionId || !transmissionTime || !certUrl || !authAlgo || !transmissionSig) {
    console.error("verifyPayPalWebhookSignature: missing one or more PAYPAL-* transmission headers:", {
      transmissionId: !!transmissionId,
      transmissionTime: !!transmissionTime,
      certUrl: !!certUrl,
      authAlgo: !!authAlgo,
      transmissionSig: !!transmissionSig,
    });
    return false;
  }

  try {
    const verified = await verifyWebhookSignature(clientOptions, {
      transmissionId,
      transmissionTime,
      certUrl,
      authAlgo,
      transmissionSig,
      webhookId,
      webhookEvent,
    });
    if (!verified) {
      console.error("verifyPayPalWebhookSignature: PayPal did not confirm this delivery (verification_status != SUCCESS).");
    }
    return verified;
  } catch (err) {
    // Any network/API failure while verifying is treated as "not verified",
    // never as "assume valid" - fail closed.
    console.error("verifyPayPalWebhookSignature: verify-webhook-signature API call threw:", err);
    return false;
  }
}
