// applyPaymentEvent — the ONE place a payment outcome (from any provider)
// turns into order/subscription/invoice state. checkout-pay-mock calls this
// today; a future real webhook handler (paypal-webhook, revolut-webhook,
// mirroring paddle-webhook/index.ts's shape) would verify that provider's
// signature, map its payload into the same NormalizedPaymentEvent shape,
// and call this exact function - not a parallel/duplicated implementation.
//
// Idempotent by (provider, provider_event_id) via `payment_events`' unique
// constraint, the same pattern `paddle-webhook` already established for
// `webhook_events`: a delivery whose id was already fully handled is a true
// duplicate and short-circuits; one that previously failed is retried, not
// silently dropped.
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import type { Plan } from "./pricing.ts";

export interface NormalizedPaymentEvent {
  provider: string;
  providerEventId: string;
  checkoutToken: string;
  outcome: "paid" | "failed" | "cancelled";
  providerPaymentId: string;
  occurredAt: string;
}

const TERMINAL_STATUSES = ["applied", "ignored", "skipped"];

function periodEndFor(billingCycle: string, from: Date): Date {
  const end = new Date(from);
  if (billingCycle === "yearly") {
    end.setUTCFullYear(end.getUTCFullYear() + 1);
  } else {
    end.setUTCMonth(end.getUTCMonth() + 1);
  }
  return end;
}

export async function applyPaymentEvent(
  db: SupabaseClient,
  event: NormalizedPaymentEvent,
): Promise<{ status: "applied" | "duplicate" | "failed"; orderId?: string; errorMessage?: string }> {
  const { data: existing } = await db
    .from("payment_events")
    .select("id, processing_status")
    .eq("provider", event.provider)
    .eq("provider_event_id", event.providerEventId)
    .maybeSingle();

  if (existing && TERMINAL_STATUSES.includes(existing.processing_status)) {
    return { status: "duplicate" };
  }

  const { data: checkout, error: checkoutError } = await db
    .from("checkout_sessions")
    .select("id, user_id, plan, billing_cycle, amount_cents, currency, status, expires_at")
    .eq("secure_token", event.checkoutToken)
    .maybeSingle();

  if (checkoutError || !checkout) {
    await recordEvent(db, event, existing?.id, "failed", "checkout_session_not_found");
    return { status: "failed", errorMessage: "checkout_session_not_found" };
  }

  // Get-or-create the order for this checkout (unique on checkout_id - see
  // migration comment on why one checkout maps to exactly one order).
  const { data: order, error: orderUpsertError } = await db
    .from("orders")
    .upsert(
      {
        user_id: checkout.user_id,
        checkout_id: checkout.id,
        plan: checkout.plan,
        billing_cycle: checkout.billing_cycle,
        amount_cents: checkout.amount_cents,
        currency: checkout.currency,
        status: event.outcome,
        provider: event.provider,
        provider_payment_id: event.providerPaymentId,
      },
      { onConflict: "checkout_id" },
    )
    .select("id")
    .single();

  if (orderUpsertError || !order) {
    await recordEvent(db, event, existing?.id, "failed", orderUpsertError?.message ?? "order_upsert_failed");
    return { status: "failed", errorMessage: orderUpsertError?.message ?? "order_upsert_failed" };
  }

  await db.from("checkout_sessions").update({ status: event.outcome }).eq("id", checkout.id);

  if (event.outcome === "paid") {
    const now = new Date();
    const periodEnd = periodEndFor(checkout.billing_cycle, now);

    // One row per user+provider - updated in place across repeat purchases
    // (e.g. upgrading Pro -> Business goes through a fresh checkout, not a
    // revision of the existing PayPal subscription) rather than accumulating
    // rows, mirroring paddle_events.ts's per-user upsert shape.
    //
    // provider_subscription_id is always overwritten to
    // event.providerPaymentId - the real, provider-issued id (a genuine
    // PayPal subscription id like "I-XXXXXXXXXXXX" for PayPal;
    // MockPaymentProvider.verifyPayment()'s own generated placeholder for
    // mock, which has no real recurring-billing object) - never a
    // locally-invented string. This is required for correctness, not just
    // cosmetic: paypal-webhook's cancellation/expiration/suspension handler
    // looks up this exact row by matching this column against the real
    // subscription id PayPal sends in those events - a locally-invented id
    // here would mean that lookup can never find this row, silently
    // stranding the row as "active" forever regardless of what actually
    // happens to the subscription on PayPal's side.
    const { data: existingSub } = await db
      .from("subscriptions")
      .select("id")
      .eq("user_id", checkout.user_id)
      .eq("provider", event.provider)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const subscriptionRow = {
      user_id: checkout.user_id,
      provider: event.provider,
      provider_customer_id: null,
      provider_subscription_id: event.providerPaymentId,
      provider_product_id: null,
      provider_price_id: null,
      plan: checkout.plan as Plan,
      status: "active",
      current_period_start: now.toISOString(),
      current_period_end: periodEnd.toISOString(),
      cancel_at_period_end: false,
    };

    if (existingSub) {
      await db.from("subscriptions").update(subscriptionRow).eq("id", existingSub.id);
    } else {
      await db.from("subscriptions").insert(subscriptionRow);
    }

    await db.from("invoices").insert({
      user_id: checkout.user_id,
      order_id: order.id,
      plan: checkout.plan,
      amount_cents: checkout.amount_cents,
      currency: checkout.currency,
      status: "paid",
      paid_at: now.toISOString(),
    });
  }

  await recordEvent(db, event, existing?.id, "applied", null, order.id);
  return { status: "applied", orderId: order.id };
}

async function recordEvent(
  db: SupabaseClient,
  event: NormalizedPaymentEvent,
  existingId: string | undefined,
  processingStatus: string,
  errorMessage: string | null,
  orderId?: string,
): Promise<void> {
  const row = {
    provider: event.provider,
    provider_event_id: event.providerEventId,
    order_id: orderId ?? null,
    outcome: event.outcome,
    payload: event,
    processed_at: new Date().toISOString(),
    processing_status: processingStatus,
    error_message: errorMessage,
  };
  if (existingId) {
    await db.from("payment_events").update(row).eq("id", existingId);
    return;
  }
  const { error } = await db.from("payment_events").insert(row);
  if (error && error.code === "23505") {
    // Lost a race against a concurrent delivery of the same event id - the
    // other request's insert already recorded it; nothing more to do here.
    return;
  }
}
