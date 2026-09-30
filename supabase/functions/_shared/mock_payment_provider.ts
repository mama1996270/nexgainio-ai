// MockPaymentProvider — development/test mode ONLY.
//
// Real payment status is normally something only the provider (via a
// webhook or a signed redirect) is trusted to assert — a client can never
// mark its own payment "paid" here in the normal sense. The mock provider is
// the deliberate, clearly-labelled exception: `verifyPayment`'s
// `simulateOutcome` IS the caller's choice, because that is the entire
// point of a mock provider in a test/dev flow (the test harness/QA person
// IS the thing standing in for a real bank). This is safe only because of
// the two independent gates in checkout-pay-mock/index.ts
// (MOCK_PAYMENTS_ENABLED === "true" AND PAYMENT_PROVIDER === "mock") - this
// class has no gating logic of its own and must never be reachable unless
// both are true.
import type {
  CreateProviderCheckoutParams,
  PaymentProvider,
  PaymentResult,
  ProviderCheckoutHandle,
  RefundResult,
} from "./payment_provider.ts";

function randomId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`;
}

export class MockPaymentProvider implements PaymentProvider {
  readonly kind = "mock";

  // deno-lint-ignore require-await
  async createCheckout(_params: CreateProviderCheckoutParams): Promise<ProviderCheckoutHandle> {
    // The mock provider has no real hosted checkout to redirect to - our
    // own /checkout/:token page IS the checkout UI. Nothing to reference
    // yet until a payment is actually simulated.
    return { providerReferenceId: null };
  }

  // deno-lint-ignore require-await
  async verifyPayment(params: {
    checkoutToken: string;
    simulateOutcome?: "success" | "failure" | "cancel";
  }): Promise<PaymentResult> {
    const outcome =
      params.simulateOutcome === "success" ? "paid" : params.simulateOutcome === "cancel" ? "cancelled" : "failed";
    return { outcome, providerPaymentId: randomId("mock_pay") };
  }

  // deno-lint-ignore require-await
  async refund(_providerPaymentId: string): Promise<RefundResult> {
    // Not implemented in this phase - refunds are out of scope until a real
    // provider exists. Explicitly returns "not refunded" rather than
    // pretending to succeed.
    return { refunded: false, providerRefundId: null };
  }

  // deno-lint-ignore require-await
  async cancelSubscription(_providerSubscriptionId: string): Promise<void> {
    // No-op: the mock provider has no real recurring-billing engine to
    // notify. `cancel-subscription/index.ts` still updates our own
    // `subscriptions` row regardless of what this returns.
    return;
  }
}
