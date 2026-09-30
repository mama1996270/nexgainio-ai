// PayPalProvider — real PaymentProvider implementation backed by PayPal's
// Subscriptions API (Sandbox or live, per PAYPAL_ENV). Constructed by
// payment_provider_factory.ts's "paypal" branch from Supabase Function
// secrets; nothing calling through the PaymentProvider interface
// (create-checkout, cancel-subscription) needs to know this class exists.
import type {
  CreateProviderCheckoutParams,
  PaymentProvider,
  PaymentResult,
  ProviderCheckoutHandle,
  RefundResult,
} from "./payment_provider.ts";
import {
  cancelPayPalSubscription,
  createSubscription,
  refundCapture,
  type PayPalClientOptions,
  type PayPalCredentials,
  type PayPalEnv,
} from "./paypal_client.ts";
import { resolvePayPalPlanId } from "./paypal_plans.ts";

export class PayPalPlanNotConfiguredError extends Error {}
export class PayPalVerifyPaymentNotSupportedError extends Error {}

export interface PayPalProviderOptions {
  env: PayPalEnv;
  credentials: PayPalCredentials;
  /** From loadPayPalPlanMap() — injected rather than read internally, same
   * reasoning as everywhere else in this module: keeps env access at the
   * Edge Function boundary, not scattered through business logic. */
  planMap: Record<string, string>;
  /** Base URL (no trailing slash) the buyer is sent back to after
   * approving/cancelling on PayPal's hosted page — e.g. the marketing
   * website's checkout page. */
  websiteBaseUrl: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class PayPalProvider implements PaymentProvider {
  readonly kind = "paypal";

  constructor(private readonly options: PayPalProviderOptions) {}

  private clientOptions(): PayPalClientOptions {
    return { env: this.options.env, credentials: this.options.credentials, fetchImpl: this.options.fetchImpl };
  }

  async createCheckout(params: CreateProviderCheckoutParams): Promise<ProviderCheckoutHandle> {
    const planId = resolvePayPalPlanId(this.options.planMap, params.plan, params.billingCycle);
    if (!planId) {
      // Never fall back to creating an ad-hoc/unmapped subscription - a
      // plan+cycle without a configured PayPal plan id is a rejected
      // checkout, exactly like resolveAmountCents() returning null for an
      // unknown plan in pricing.ts.
      throw new PayPalPlanNotConfiguredError(
        `No PayPal plan id configured for ${params.plan}/${params.billingCycle} (PAYPAL_PLAN_MAP).`,
      );
    }

    const checkoutPage = `${this.options.websiteBaseUrl}/checkout.html?token=${encodeURIComponent(params.checkoutToken)}`;
    const result = await createSubscription(this.clientOptions(), {
      planId,
      customId: params.checkoutToken,
      returnUrl: `${checkoutPage}&paypal=success`,
      cancelUrl: `${checkoutPage}&paypal=cancel`,
    });

    return { providerReferenceId: result.subscriptionId, approvalUrl: result.approvalUrl };
  }

  // deno-lint-ignore require-await
  async verifyPayment(_params: {
    checkoutToken: string;
    simulateOutcome?: "success" | "failure" | "cancel";
  }): Promise<PaymentResult> {
    // Deliberately unsupported for a real provider (see supabase/README.md's
    // "Connecting a real provider later" section, point 1): a real
    // provider's payment status is never client-driven, and is resolved
    // exclusively from PayPal's verified webhook (paypal-webhook/index.ts),
    // not by polling here. The only existing caller of verifyPayment(),
    // checkout-pay-mock/index.ts, is itself unreachable once
    // PAYMENT_PROVIDER is no longer "mock" (getActivePaymentProvider()'s own
    // fail-safe), so this method is not expected to ever actually run in
    // production - it throws rather than silently trusting the caller.
    throw new PayPalVerifyPaymentNotSupportedError(
      "PayPalProvider.verifyPayment() is not supported - payment outcome is resolved from PayPal's webhook, never from the caller.",
    );
  }

  async refund(providerPaymentId: string): Promise<RefundResult> {
    const result = await refundCapture(this.clientOptions(), providerPaymentId);
    return { refunded: result.refunded, providerRefundId: result.refundId };
  }

  async cancelSubscription(providerSubscriptionId: string): Promise<void> {
    await cancelPayPalSubscription(this.clientOptions(), providerSubscriptionId);
  }
}
