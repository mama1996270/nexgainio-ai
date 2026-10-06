# nexgainio-ai

Official marketing/landing site for **NEXGAINIO AI Pro** — AI-powered listing
generation, bulk automation, export and publishing for e-commerce sellers.

Served via GitHub Pages from the `main` branch root: https://nexgainiopro.com/

## Structure

Plain static HTML/CSS/JS - no build step, no framework, nothing to install.

```
index.html          Landing page (hero, features, pricing, FAQ, ...)
download.html        Download / trial explainer page
privacy.html          Privacy Policy
terms.html            Terms of Service
refund.html           Refund Policy
contact.html          Contact page
assets/css/styles.css Design system + all page styles
assets/js/main.js     Nav, FAQ accordion, pricing toggle, scroll reveal, showcase tabs
assets/js/checkout-config.js   Centralized placeholder checkout URLs (see below)
assets/img/           Favicon, OG image, generated icons
.nojekyll              Disables Jekyll processing - files are served as-is
robots.txt / sitemap.xml
```

## Local development

No build step - just open `index.html` in a browser, or serve the folder with
any static file server, e.g.:

```
python -m http.server 8000
```

## Checkout / Lemon Squeezy integration

Every pricing button's destination lives in **one file**:
`assets/js/checkout-config.js` → `window.SELLERPILOT_CHECKOUT`.

Payment integration is **not implemented yet**. To wire up Lemon Squeezy later:

1. Replace `proMonthly` / `proYearly` in `checkout-config.js` with the real
   Lemon Squeezy hosted checkout URLs.
2. Nothing else needs to change - every checkout-related button reads its
   `href` from that one config object via `data-checkout-plan="..."`.

## Deployment

GitHub Pages serves directly from `main` / root. Pushing to `main` deploys
automatically - no CI workflow required.

