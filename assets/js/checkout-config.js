/**
 * Centralized checkout / plan-action configuration.
 *
 * Payment integration (Lemon Squeezy) is NOT wired up yet. Every URL below
 * is a placeholder. When Lemon Squeezy checkout links exist, replace the
 * values in this one file only - no other file references a checkout URL
 * directly, so nothing else needs to change or be redesigned.
 *
 * Expected replacement values (once available):
 *   proMonthly / proYearly -> Lemon Squeezy hosted checkout URLs for the
 *                             NEXGAINIO AI Pro "Pro" variant (monthly /
 *                             yearly), e.g. "https://sellerpilot.lemonsqueezy.com/checkout/buy/xxxx"
 *   free                   -> Should stay pointed at the in-app trial/download
 *                             flow, not a paid checkout.
 *   enterprise             -> Should stay a contact link (mailto or a form),
 *                             Enterprise is sales-assisted, not self-serve.
 */
window.SELLERPILOT_CHECKOUT = {
  free: "download.html",
  proMonthly: "#pro-checkout-placeholder",
  proYearly: "#pro-checkout-placeholder",
  enterprise: "mailto:sales@sellerpilotai.pro?subject=NEXGAINIO%20AI%20Pro%20Enterprise%20Inquiry",
};

/**
 * Applies the config above to every element carrying a data-checkout-plan
 * attribute, whose value must be one of the keys in SELLERPILOT_CHECKOUT.
 * Keeps the actual URLs out of the markup entirely.
 */
(function applyCheckoutLinks() {
  var targets = document.querySelectorAll("[data-checkout-plan]");
  for (var i = 0; i < targets.length; i++) {
    var el = targets[i];
    var plan = el.getAttribute("data-checkout-plan");
    var url = window.SELLERPILOT_CHECKOUT[plan];
    if (url) {
      el.setAttribute("href", url);
    }
  }
})();
