/**
 * PayPal JS SDK configuration — the Client ID only.
 *
 * Safe to expose client-side: PayPal documents the Client ID as a public
 * identifier, not a secret (unlike PAYPAL_CLIENT_SECRET, which only ever
 * exists as a Supabase Edge Function secret and is never sent to the
 * browser). Mirrors assets/js/supabase-config.js's placeholder-file pattern.
 *
 * This is currently the PayPal SANDBOX app's Client ID, for building and
 * testing the Credit/Debit Card (Card Fields) checkout option in isolation
 * from Live traffic. Swap to the Live Client ID only once Card Fields has
 * been verified end-to-end in Sandbox and PayPal has confirmed Advanced
 * Credit/Debit Card Payments (ACDC) is approved for this account on
 * Subscriptions.
 */
window.SELLERPILOT_PAYPAL = {
  clientId: "BAA5zmsCRILtrU7ENPz8m0zKpXLOMoRhUlQbU6FzJwtRWe7JgxQ8ZTivN_2aH91248Pq7w8dHdkEHN6CDk",
};
