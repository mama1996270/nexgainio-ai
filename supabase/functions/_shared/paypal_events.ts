// PayPal webhook event -> NormalizedPaymentEvent mapping — isolated on
// purpose, mirroring paddle_events.ts's pure/testable shape (no network, no
// Supabase client), so the mapping logic can be exercised with plain fixture
// objects.
//
// Event names and payload field names verified against PayPal's own webhook
// event reference (developer.paypal.com/api/rest/webhooks/event-names/):
//   BILLING.SUBSCRIPTION.ACTIVATED / .CANCELLED / .EXPIRED / .SUSPENDED
//     resource.id (the subscription id), resource.custom_id (the merchant
//     reference we set at creation — this codebase's checkout_token),
//     resource.plan_id, resource.status
//
// Scope boundary, deliberate and documented (same pattern as paddle_events.ts
// explicitly not acting on transaction.* events): PAYMENT.SALE.COMPLETED
// (individual recurring-billing payment captures) is NOT handled here. Its
// resource shape does not reliably carry the same custom_id/checkout_token
// this codebase's applyPaymentEvent() pipeline requires for every event, and
// the authorized scope for this phase is the subscription-activation flow
// (checkout -> approval -> webhook -> subscription -> entitlement), not full
// recurring-payment history. Extending to renewal payments is a clean
// follow-up once there's a real requirement and real sandbox payloads to
// verify the shape against.
import type { NormalizedPaymentEvent } from "./commerce_events.ts";

export const ACTIVATION_EVENT_TYPE = "BILLING.SUBSCRIPTION.ACTIVATED";
export const CANCELLATION_EVENT_TYPES = [
  "BILLING.SUBSCRIPTION.CANCELLED",
  "BILLING.SUBSCRIPTION.EXPIRED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
] as const;

export const HANDLED_EVENT_TYPES = [ACTIVATION_EVENT_TYPE, ...CANCELLATION_EVENT_TYPES] as const;

export interface PayPalWebhookEvent {
  id: string;
  event_type: string;
  create_time?: string;
  resource: Record<string, unknown>;
}

export interface SubscriptionResource {
  subscriptionId: string;
  customId: string | null;
  planId: string | null;
  status: string | null;
}

function extractSubscriptionResource(event: PayPalWebhookEvent): SubscriptionResource | null {
  const resource = event.resource ?? {};
  if (typeof resource.id !== "string") return null;
  return {
    subscriptionId: resource.id,
    customId: typeof resource.custom_id === "string" ? resource.custom_id : null,
    planId: typeof resource.plan_id === "string" ? resource.plan_id : null,
    status: typeof resource.status === "string" ? resource.status : null,
  };
}

export type ActivationMapResult =
  | { kind: "event"; event: NormalizedPaymentEvent; subscription: SubscriptionResource }
  | { kind: "skipped"; reason: string }
  | { kind: "ignored" };

/** Maps a BILLING.SUBSCRIPTION.ACTIVATED event into the NormalizedPaymentEvent
 * shape applyPaymentEvent() (commerce_events.ts) expects — the "checkout
 * completed, first payment succeeded" path this phase's end-to-end scope
 * covers. Returns "skipped" (never guessed/defaulted) when the resource
 * doesn't carry what's needed. */
export function mapPayPalActivationEvent(event: PayPalWebhookEvent): ActivationMapResult {
  if (event.event_type !== ACTIVATION_EVENT_TYPE) {
    return { kind: "ignored" };
  }
  const subscription = extractSubscriptionResource(event);
  if (!subscription) {
    return { kind: "skipped", reason: "missing_resource_id" };
  }
  if (!subscription.customId) {
    return { kind: "skipped", reason: "missing_resource_custom_id" };
  }

  return {
    kind: "event",
    subscription,
    event: {
      provider: "paypal",
      providerEventId: event.id,
      checkoutToken: subscription.customId,
      outcome: "paid",
      providerPaymentId: subscription.subscriptionId,
      occurredAt: typeof event.create_time === "string" ? event.create_time : new Date().toISOString(),
    },
  };
}

export type CancellationMapResult =
  | { kind: "cancellation"; subscription: SubscriptionResource }
  | { kind: "skipped"; reason: string }
  | { kind: "ignored" };

/** Maps a subscription-lifecycle-ended event (cancelled/expired/suspended).
 * Deliberately NOT routed through applyPaymentEvent() — that function's
 * "cancelled" outcome updates checkout_sessions/orders only (modelling "the
 * one-time checkout was cancelled before ever paying"), it does not touch
 * `subscriptions` at all once a subscription is already active. The caller
 * (paypal-webhook/index.ts) applies this result directly to the matching
 * `subscriptions` row via provider_subscription_id — the same simple,
 * well-established `.update(...).eq(...)` shape cancel-subscription/
 * index.ts already uses, not a new pattern. */
export function mapPayPalCancellationEvent(event: PayPalWebhookEvent): CancellationMapResult {
  if (!(CANCELLATION_EVENT_TYPES as readonly string[]).includes(event.event_type)) {
    return { kind: "ignored" };
  }
  const subscription = extractSubscriptionResource(event);
  if (!subscription) {
    return { kind: "skipped", reason: "missing_resource_id" };
  }
  return { kind: "cancellation", subscription };
}
