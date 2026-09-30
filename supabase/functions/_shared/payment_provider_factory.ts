// Selects the active PaymentProvider. Two independent switches must BOTH
// agree before mock payments are reachable at all - a single flag left on
// by accident in production is not enough by itself:
//
//   PAYMENT_PROVIDER        - which provider is configured ("mock", "paypal";
//                              "revolut" not implemented yet)
//   MOCK_PAYMENTS_ENABLED   - a second, explicit opt-in required even when
//                              PAYMENT_PROVIDER=mock
//
// Fails safe: if PAYMENT_PROVIDER names a provider that isn't implemented
// yet, isn't configured, or isn't set, this throws rather than silently
// falling back to mock - "the application must fail safely if a real
// payment provider is not configured" is implemented here, not left to each
// caller to remember.
import { MockPaymentProvider } from "./mock_payment_provider.ts";
import type { PaymentProvider } from "./payment_provider.ts";
import { PayPalProvider } from "./paypal_provider.ts";
import { loadPayPalPlanMap } from "./paypal_plans.ts";
import type { PayPalEnv } from "./paypal_client.ts";

export class PaymentProviderNotConfiguredError extends Error {}
export class MockPaymentsDisabledError extends Error {}

const DEFAULT_WEBSITE_BASE_URL = "https://mama1996270.github.io/sellerpilot-ai";

function buildPayPalProvider(): PaymentProvider {
  const clientId = Deno.env.get("PAYPAL_CLIENT_ID");
  const clientSecret = Deno.env.get("PAYPAL_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    throw new PaymentProviderNotConfiguredError(
      "PAYMENT_PROVIDER=paypal but PAYPAL_CLIENT_ID/PAYPAL_CLIENT_SECRET are not configured.",
    );
  }
  const env = (Deno.env.get("PAYPAL_ENV") ?? "sandbox").toLowerCase() as PayPalEnv;
  const websiteBaseUrl = (Deno.env.get("WEBSITE_URL") ?? DEFAULT_WEBSITE_BASE_URL).replace(/\/+$/, "");
  return new PayPalProvider({
    env: env === "live" ? "live" : "sandbox",
    credentials: { clientId, clientSecret },
    planMap: loadPayPalPlanMap(),
    websiteBaseUrl,
  });
}

export function getActivePaymentProvider(): PaymentProvider {
  const configured = (Deno.env.get("PAYMENT_PROVIDER") ?? "").toLowerCase();

  if (configured === "mock") {
    if (Deno.env.get("MOCK_PAYMENTS_ENABLED") !== "true") {
      throw new MockPaymentsDisabledError(
        "PAYMENT_PROVIDER=mock but MOCK_PAYMENTS_ENABLED is not \"true\" - mock payments are disabled.",
      );
    }
    return new MockPaymentProvider();
  }

  if (configured === "paypal") {
    return buildPayPalProvider();
  }

  // "revolut" / anything else: not implemented in this phase.
  throw new PaymentProviderNotConfiguredError(
    `No real payment provider is configured (PAYMENT_PROVIDER=${JSON.stringify(configured)}). ` +
      "Only \"mock\" (development/test only) and \"paypal\" exist today.",
  );
}
