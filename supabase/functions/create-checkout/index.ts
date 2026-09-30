// create-checkout — the ONLY place a checkout session is created.
//
// Requires a Supabase JWT (`withSupabase({ auth: "user" })`); the caller's
// verified identity (not anything in the request body) becomes the
// session's user_id. Price is resolved server-side from pricing.ts's
// authoritative table using the client's plan/billing_cycle choice — a
// client sending `{"plan":"pro","amount_cents":1}` has no way to make that
// stick, because amount_cents is never read from the request at all.
//
// After the session row exists, also asks the currently active
// PaymentProvider to create its own checkout (PayPalProvider calls PayPal's
// Subscriptions API and returns a real approval URL; MockPaymentProvider
// returns a bare null reference, unchanged from before this existed). This
// is additive and fails soft: if no real provider is configured (today's
// default — see supabase/README.md) or mock payments are disabled,
// `approval_url` is simply omitted and every existing caller (the website's
// checkout page, falling back to its own UI) keeps working exactly as it
// did before PayPal existed.
import { withSupabase } from "npm:@supabase/server@^1";
import { isValidBillingCycle, isValidPlan, resolveAmountCents, CURRENCY } from "../_shared/pricing.ts";
import { createServiceRoleClient } from "../_shared/supabase_clients.ts";
import {
  getActivePaymentProvider,
  MockPaymentsDisabledError,
  PaymentProviderNotConfiguredError,
} from "../_shared/payment_provider_factory.ts";

const CHECKOUT_EXPIRY_MINUTES = 30;

export default {
  fetch: withSupabase(
    { auth: "user" },
    async (req: Request, ctx: { userClaims?: { id?: string; sub?: string } }) => {
      const userId = ctx.userClaims?.id ?? ctx.userClaims?.sub;
      if (!userId) {
        return new Response(JSON.stringify({ error: "unauthenticated" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      let body: { plan?: unknown; billing_cycle?: unknown };
      try {
        body = await req.json();
      } catch {
        return new Response(JSON.stringify({ error: "invalid_body" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      if (!isValidPlan(body.plan)) {
        return new Response(JSON.stringify({ error: "invalid_plan" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (!isValidBillingCycle(body.billing_cycle)) {
        return new Response(JSON.stringify({ error: "invalid_billing_cycle" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const amountCents = resolveAmountCents(body.plan, body.billing_cycle);
      if (amountCents === null) {
        // Unreachable given the two checks above, but never fall back to a
        // guessed price if it somehow is.
        return new Response(JSON.stringify({ error: "unpriced_plan" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }

      const expiresAt = new Date(Date.now() + CHECKOUT_EXPIRY_MINUTES * 60_000).toISOString();
      const db = createServiceRoleClient();
      const { data, error } = await db
        .from("checkout_sessions")
        .insert({
          user_id: userId,
          plan: body.plan,
          billing_cycle: body.billing_cycle,
          currency: CURRENCY,
          amount_cents: amountCents,
          status: "pending",
          expires_at: expiresAt,
        })
        .select("id, secure_token, expires_at")
        .single();

      if (error || !data) {
        console.error("Failed to create checkout session:", error);
        return new Response(JSON.stringify({ error: "checkout_creation_failed" }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }

      let approvalUrl: string | null = null;
      try {
        const provider = getActivePaymentProvider();
        const handle = await provider.createCheckout({
          plan: body.plan,
          billingCycle: body.billing_cycle,
          amountCents,
          currency: CURRENCY,
          userId,
          checkoutToken: data.secure_token,
        });
        approvalUrl = handle.approvalUrl ?? null;

        // Persist alongside the session so get-checkout (called later, by
        // the website's own checkout page load) can read it back - this is
        // the ONLY write to these two columns; a checkout session's provider
        // reference never changes after creation, same as every other field
        // on this row.
        if (approvalUrl || handle.providerReferenceId) {
          const { error: updateError } = await db
            .from("checkout_sessions")
            .update({
              provider_approval_url: approvalUrl,
              provider_reference_id: handle.providerReferenceId,
            })
            .eq("id", data.id);
          if (updateError) {
            // Non-fatal: the checkout session and its price are already
            // correct and usable; the customer just won't get an automatic
            // PayPal redirect from the website and would need a fresh
            // checkout. Logged for operator visibility, not surfaced as a
            // failed request.
            console.error("Failed to persist provider checkout reference:", updateError);
          }
        }
      } catch (err) {
        if (!(err instanceof PaymentProviderNotConfiguredError || err instanceof MockPaymentsDisabledError)) {
          // A real provider IS configured but its own API call failed
          // (network error, misconfigured plan map, etc.) - the checkout
          // session already exists and is still usable, so this does not
          // fail the whole request; logged for operator visibility instead.
          console.error("Provider createCheckout failed:", err);
        }
      }

      return Response.json({
        checkout_token: data.secure_token,
        expires_at: data.expires_at,
        ...(approvalUrl ? { approval_url: approvalUrl } : {}),
      });
    },
  ),
};
