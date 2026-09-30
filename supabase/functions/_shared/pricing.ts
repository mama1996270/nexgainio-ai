// The ONE authoritative price table. create-checkout resolves amount_cents
// from here based on the client's chosen plan+billing_cycle — the client
// never supplies (or is trusted for) a price. Matches the exact figures
// specified for this phase; nothing here is invented or estimated.
//
// Amounts are integer cents (EUR) - avoids floating-point currency bugs.

export type Plan = "starter" | "pro" | "business";
export type BillingCycle = "monthly" | "yearly";

export const CURRENCY = "EUR";

const PRICING_TABLE: Record<Plan, Record<BillingCycle, number>> = {
  starter: { monthly: 1900, yearly: 19000 },
  pro: { monthly: 3900, yearly: 39000 },
  business: { monthly: 7900, yearly: 79000 },
};

export const PLANS = Object.keys(PRICING_TABLE) as Plan[];

export function isValidPlan(value: unknown): value is Plan {
  return typeof value === "string" && (PLANS as string[]).includes(value);
}

export function isValidBillingCycle(value: unknown): value is BillingCycle {
  return value === "monthly" || value === "yearly";
}

/** Returns null for an unknown plan/cycle combination - callers must treat
 * that as a rejected request, never fall back to a guessed price. */
export function resolveAmountCents(plan: Plan, billingCycle: BillingCycle): number | null {
  return PRICING_TABLE[plan]?.[billingCycle] ?? null;
}
