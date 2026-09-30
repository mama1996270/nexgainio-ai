// PayPal Plan ID <-> internal (plan, billing_cycle) mapping.
//
// PayPal's Subscriptions API is plan-based, not amount-based: creating a
// subscription requires an existing PayPal "Plan" id (created ahead of time
// under a PayPal "Product", via the PayPal dashboard or PayPal's own
// Products/Plans API — that one-time setup is outside this repo's scope,
// same as Paddle's price IDs being created in the Paddle dashboard rather
// than by this codebase). This module never invents/guesses a plan id.
//
// Mirrors entitlement.ts's PADDLE_PRICE_PLAN_MAP pattern exactly: a single
// JSON object read from a Supabase Function secret, defaulting to `{}` so
// that until it's configured, every lookup safely resolves to "not
// configured" rather than a guessed id.
import type { BillingCycle, Plan } from "./pricing.ts";
import { isValidBillingCycle, isValidPlan } from "./pricing.ts";

function mapKey(plan: Plan, billingCycle: BillingCycle): string {
  return `${plan}_${billingCycle}`;
}

/**
 * Reads PAYPAL_PLAN_MAP, a Supabase Function secret holding a JSON object of
 * `{ "<plan>_<billing_cycle>": "<paypal_plan_id>", ... }`, e.g.
 * `{"starter_monthly": "P-5ML4271244454362WXNWU5NQ", "starter_yearly": "P-...", ...}`
 * for all 6 plan/cycle combinations in pricing.ts. Defaults to an empty map:
 * until real PayPal Sandbox (or live) plan ids exist and this secret is
 * configured, every lookup safely resolves to "not configured" — the caller
 * treats that as a rejected checkout, never a guessed plan id.
 */
export function loadPayPalPlanMap(): Record<string, string> {
  const raw = Deno.env.get("PAYPAL_PLAN_MAP");
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, string>;
    }
  } catch {
    // Malformed secret: fail safe to "no mappings" rather than throwing and
    // rejecting every checkout until someone notices - same policy as
    // entitlement.ts's loadPriceToPlanMap().
  }
  return {};
}

/** (plan, billing_cycle) -> PayPal plan id, or null if unmapped. Used by
 * PayPalProvider.createCheckout() to pick which PayPal plan to subscribe
 * the buyer to. */
export function resolvePayPalPlanId(
  map: Record<string, string>,
  plan: Plan,
  billingCycle: BillingCycle,
): string | null {
  return map[mapKey(plan, billingCycle)] ?? null;
}

/** The reverse lookup: PayPal plan id -> (plan, billing_cycle), or null.
 * Used defensively by the webhook handler to cross-check that the plan
 * PayPal says the subscription is on actually matches the checkout session
 * the custom_id points at — a mismatch is treated as suspicious and
 * rejected rather than trusted, never used to silently substitute a
 * "corrected" plan. */
export function resolveInternalPlanFromPayPalPlanId(
  map: Record<string, string>,
  paypalPlanId: string,
): { plan: Plan; billingCycle: BillingCycle } | null {
  for (const [key, value] of Object.entries(map)) {
    if (value !== paypalPlanId) continue;
    const separatorIndex = key.lastIndexOf("_");
    if (separatorIndex === -1) continue;
    const plan = key.slice(0, separatorIndex);
    const billingCycle = key.slice(separatorIndex + 1);
    if (isValidPlan(plan) && isValidBillingCycle(billingCycle)) {
      return { plan, billingCycle };
    }
  }
  return null;
}
