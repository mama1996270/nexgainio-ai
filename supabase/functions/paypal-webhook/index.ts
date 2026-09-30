// paypal-webhook — receives, verifies, and applies PayPal webhook
// notifications for Subscriptions. Mirrors paddle-webhook/index.ts's shape
// deliberately: `withSupabase({ auth: "none" })` (the caller is PayPal, not
// a Supabase-authenticated user — authenticity comes entirely from
// verifyPayPalWebhookSignature, checked before anything else happens),
// idempotent recording in `webhook_events` keyed by the provider's own event
// id, and a service-role client for the one part of this function that can
// mutate entitlement state.
//
// Two outcomes are applied, per paypal_events.ts's documented scope
// boundary:
//   - BILLING.SUBSCRIPTION.ACTIVATED -> the SAME applyPaymentEvent()
//     pipeline from _shared/commerce_events.ts that checkout-pay-mock uses -
//     not a parallel implementation. This is the checkout -> approval ->
//     webhook -> subscription -> entitlement path this phase's end-to-end
//     scope covers.
//   - BILLING.SUBSCRIPTION.CANCELLED / EXPIRED / SUSPENDED -> a direct,
//     narrow `subscriptions` update keyed by provider_subscription_id (the
//     same simple update shape cancel-subscription/index.ts already uses),
//     since applyPaymentEvent()'s "cancelled" outcome only ever models a
//     checkout that never paid, not an already-active subscription ending.
// Every other event type is acknowledged and recorded (for idempotency/
// audit) but otherwise ignored, exactly like paddle-webhook's transaction.*
// handling.
import { withSupabase } from "npm:@supabase/server@^1";
import { verifyPayPalWebhookSignature, extractPayPalWebhookHeaders } from "../_shared/paypal_signature.ts";
import {
  mapPayPalActivationEvent,
  mapPayPalCancellationEvent,
  type PayPalWebhookEvent,
} from "../_shared/paypal_events.ts";
import { applyPaymentEvent } from "../_shared/commerce_events.ts";
import { createServiceRoleClient } from "../_shared/supabase_clients.ts";
import type { PayPalClientOptions, PayPalEnv } from "../_shared/paypal_client.ts";

const TERMINAL_STATUSES = ["applied", "ignored", "skipped"];

function loadPayPalClientOptions(): PayPalClientOptions | null {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  const env = ((Deno.env.get("PAYPAL_ENV") ?? "sandbox").toLowerCase() as PayPalEnv);
  return { env: env === "live" ? "live" : "sandbox", credentials: { clientId, clientSecret } };
}

export default {
  fetch: withSupabase({ auth: "none" }, async (req: Request) => {
    const clientOptions = loadPayPalClientOptions();
    const webhookId = Deno.env.get("PAYPAL_WEBHOOK_ID") ?? "";

    if (!clientOptions || !webhookId) {
      // Never process an event when verification itself can't be performed -
      // same fail-closed policy as Paddle's `if (!secret) return false`.
      console.error("paypal-webhook: PAYPAL_CLIENT_ID/SECRET/WEBHOOK_ID are not fully configured.");
      return new Response("PayPal webhook is not configured.", { status: 503 });
    }

    let event: PayPalWebhookEvent;
    try {
      event = await req.json();
    } catch (err) {
      console.error("paypal-webhook: could not parse request body as JSON:", err);
      return new Response("Malformed JSON body.", { status: 400 });
    }
    if (!event.id || !event.event_type) {
      console.error("paypal-webhook: request body missing id/event_type. Received keys:", Object.keys(event ?? {}));
      return new Response("Missing id/event_type.", { status: 400 });
    }

    const signatureValid = await verifyPayPalWebhookSignature({
      clientOptions,
      headers: extractPayPalWebhookHeaders(req.headers),
      webhookId,
      webhookEvent: event,
    });
    if (!signatureValid) {
      // Never store or process an unverified delivery. The specific reason
      // (missing header, PayPal API failure, or a genuine FAILURE verdict)
      // is already logged inside verifyPayPalWebhookSignature/
      // verifyWebhookSignature - this line just correlates it to the event.
      console.error(`paypal-webhook: signature verification failed for event id=${event.id} type=${event.event_type}.`);
      return new Response("Invalid signature.", { status: 401 });
    }

    const db = createServiceRoleClient();

    // Idempotency: the event's own id is the primary key, same semantics as
    // paddle-webhook/index.ts - a delivery whose id was already fully
    // handled (applied/ignored/skipped) short-circuits here; one that
    // previously failed is retried, not silently dropped (PayPal retries
    // failed/non-2xx webhook deliveries).
    const { data: existing } = await db
      .from("webhook_events")
      .select("id, processing_status")
      .eq("id", event.id)
      .maybeSingle();

    if (existing && TERMINAL_STATUSES.includes(existing.processing_status)) {
      return Response.json({ ok: true, duplicate: true });
    }

    if (existing) {
      await db
        .from("webhook_events")
        .update({ payload: event, processing_status: "received", error_message: null })
        .eq("id", event.id);
    } else {
      const { error: insertError } = await db.from("webhook_events").insert({
        id: event.id,
        provider: "paypal",
        event_type: event.event_type,
        payload: event,
        processing_status: "received",
      });
      if (insertError) {
        if (insertError.code === "23505") {
          // Concurrent delivery of the same new event won the race.
          return Response.json({ ok: true, duplicate: true });
        }
        console.error("Failed to record webhook event:", insertError);
        return new Response("Could not record event.", { status: 500 });
      }
    }

    let processingStatus: string;
    let errorMessage: string | null = null;

    const activation = mapPayPalActivationEvent(event);
    if (activation.kind === "event") {
      const applied = await applyPaymentEvent(db, activation.event);
      processingStatus = applied.status === "duplicate" ? "applied" : applied.status;
      errorMessage = applied.status === "failed" ? applied.errorMessage ?? "apply_failed" : null;
    } else if (activation.kind === "skipped") {
      processingStatus = "skipped";
      errorMessage = activation.reason;
    } else {
      const cancellation = mapPayPalCancellationEvent(event);
      if (cancellation.kind === "cancellation") {
        const { error: updateError, count } = await db
          .from("subscriptions")
          .update({ status: "cancelled", cancel_at_period_end: true }, { count: "exact" })
          .eq("provider", "paypal")
          .eq("provider_subscription_id", cancellation.subscription.subscriptionId);
        if (updateError) {
          processingStatus = "failed";
          errorMessage = updateError.message;
        } else if (!count) {
          // No matching subscription row yet (e.g. cancellation arrived
          // before/without ever seeing an ACTIVATED event for it) - nothing
          // to update; recorded as skipped, not treated as a hard failure
          // Paddle would retry forever.
          processingStatus = "skipped";
          errorMessage = "no_matching_subscription";
        } else {
          processingStatus = "applied";
        }
      } else if (cancellation.kind === "skipped") {
        processingStatus = "skipped";
        errorMessage = cancellation.reason;
      } else {
        processingStatus = "ignored";
      }
    }

    await db
      .from("webhook_events")
      .update({
        processed_at: new Date().toISOString(),
        processing_status: processingStatus,
        error_message: errorMessage,
      })
      .eq("id", event.id);

    if (processingStatus === "failed") {
      // Signal failure so PayPal retries delivery - the event is already
      // safely recorded, so a retry hits the idempotency check above and
      // simply retries the underlying write.
      return new Response("Failed to apply event.", { status: 500 });
    }
    return Response.json({ ok: true, status: processingStatus });
  }),
};
