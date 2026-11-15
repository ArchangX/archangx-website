# Stripe ticketing for Summit and Exhibition 2027

Paid tickets are sold through **Stripe Payment Links**: Stripe-hosted checkout pages reached by a plain link from
`summit-tickets.html` and `exhibitions.html`. The website stays static (no backend, no Stripe script, decision D9).

```
stripe/catalogue.json              what is sold: names, prices, capacities, status   (edit this)
scripts/stripe/sync-catalogue.mjs  pushes the catalogue to Stripe, idempotently        (run this)
site/data/summit-tickets.json      public result: prices, status, Payment Link URLs   (generated, committed)
tools/render_tickets.py            writes the ticket cards into the two HTML pages     (run after a sync)
scripts/stripe/export-attendees.mjs  attendee list CSV for badges and check-in         (read-only)
```

## Requirements

- Node 18 or newer (`node --version`); no npm packages are needed.
- A Stripe **restricted API key** in the environment variable `STRIPE_API_KEY`. Never put it in a file, a commit,
  a Jira comment, a chat or on a command line (a command line is saved in the shell history). Set it like this:
  - Windows (sandbox key): `powershell -ExecutionPolicy Bypass -File scripts\stripe\set-key.ps1`. It asks for the
    key with the input hidden, accepts only an `rk_test_` key, saves it for your Windows user, and removes any line
    containing a Stripe key from the PowerShell history. Quit VS Code completely and reopen it afterwards. `-Remove`
    deletes it again.
  - bash/zsh: `read -rs STRIPE_API_KEY && export STRIPE_API_KEY`, then paste the key and press Enter (nothing shows).
  - A live key is never saved: set it only in the terminal used for the live run, then close that terminal.
- Key permissions (Dashboard → Developers → API keys → Create restricted key; tick "Authorizing agent access to
  your account" so refunds and payouts stay behind approval rules):

| Resource | Permission | Used by |
|---|---|---|
| Products | Write | sync |
| Prices | Write | sync |
| Payment Links | Write | sync |
| Coupons, Promotion Codes | Write (optional: only if you want discount codes created by script later) | — |
| Checkout Sessions | Read | export |
| Payment Intents | Read | export |
| Charges | Read | export (to leave out refunded orders) |
| Everything else | None | |

Sandbox keys start with `rk_test_`, live keys with `rk_live_`. The scripts refuse a live key unless `--live` is
passed, and refuse `--live` with a sandbox key.

## Run it

```bash
node scripts/stripe/sync-catalogue.mjs --dry-run   # plan: what would be created or changed; no writes
node scripts/stripe/sync-catalogue.mjs             # apply in the sandbox
python tools/render_tickets.py                     # put the new prices/links into the HTML pages
python tools/check_site.py                         # 0 problems
# after a --live run only (sandbox output stays uncommitted, see the checklist below):
git add stripe site/data site/*.html && git commit -m "SCRUM-1377: sync ticket catalogue"
```

A second real run must print `0 change(s) applied`. The dry run also works without a key (offline plan) and
lists every `TODO` still in the catalogue; a real run stops on any `TODO`. The sync prints each Payment Link URL.

## Sandbox test checklist (before going live)

Open each link the sync printed (or the buttons on a local preview, `cd site && python -m http.server 8000`) and pay
with the test card `4242 4242 4242 4242`. Tick each line:

| Check | How | Expected |
|---|---|---|
| Every type can be bought | one purchase per link; passes with quantity 2 | payment succeeds; Dashboard → Payments lists it |
| Fields are captured | fill in edition, other attendees, needs; booths: company name and phone | shown on the payment, and in the export CSV |
| Redirect | after paying | lands on `summit-thanks.html` (a 404 until the pages are merged and published; the URL bar shows the right address) |
| Receipt | Dashboard → the payment → Receipt history → ⋯ → Send receipt | sandbox payments never email receipts by themselves; check the branding and wording of the one you send |
| Promotion code | Product catalog → Coupons → create a 100 % coupon with code `TEST100`, use it at checkout | total drops to 0; delete the coupon afterwards |
| Tax | look at the checkout total | matches `automatic_tax` in the catalogue (no tax line while it is `false`) |
| Capacity closes the link | in `catalogue.json` set one type's `capacity` to the orders it already has plus 1, sync, buy once, sync again | the link shows the inactive message; the card says "Sold out"; restore the real capacity and sync |
| Refund | Dashboard → the payment → Refund | refunded; the next export leaves the order out |
| Export | `node scripts/stripe/export-attendees.mjs` | `exports/attendees-test-<date>.csv` opens in Excel with accents intact |
| Decline | card `4000 0000 0000 0002` | checkout shows the decline; nothing is recorded |

Sandbox Payment Link URLs (`buy.stripe.com/test_...`) should not reach the live site, so don't commit the
output of a sandbox sync. When the tests are done, put the "Coming soon" cards back with
`git restore site/data/summit-tickets.json site/summit-tickets.html site/exhibitions.html`. If sandbox URLs are ever
published by mistake, the cards carry a "Test mode" notice and no real money can be taken.

## Change something

| To | Do |
|---|---|
| Change a price | Edit `price` in `catalogue.json`, run the sync. Stripe prices are immutable, so the script creates a new Price, deactivates the old one, **creates a new Payment Link** (its URL changes) and deactivates the old link. Re-render and commit. |
| Close a ticket type (early-bird ends, booths full) | Set `"status": "closed"` (or let `sales_end` pass) and run the sync: the link is deactivated and the card shows "Sales closed". Reopen with `"status": "on_sale"`: the same link (same URL) is switched back on. |
| Let a type sell out automatically | Set `capacity` to a number. Stripe deactivates the link after that many completed checkouts and the next sync marks the card "Sold out"; it never opens a replacement link. Raise `capacity` and sync to reopen the same link. `null` means unlimited. |
| Change what a ticket includes | Edit `includes`, run `python tools/render_tickets.py` (no sync needed). |
| Create a discount code | Dashboard → Product catalog → Coupons → Create coupon, then "Add promotion code" (for example `SPEAKER100`). Promotion codes are already enabled on every link. Customers type the code at checkout, or use `?prefilled_promo_code=CODE` on the link. |
| Refund an order | Dashboard → Payments → open the payment → Refund. The next attendee export leaves refunded orders out. |
| See how many sold | Dashboard → Payment links → the link → Payments and analytics, or run the export. |
| Turn tax on | Dashboard → Settings → Tax → activate, add registrations (GST/HST, QST), set the default product tax code; then set `"automatic_tax": true` in `catalogue.json` and run the sync. |

**Capacity counts orders, not seats.** Stripe limits the number of completed checkouts on a link, and a pass order
can hold up to 10 people, so `capacity: 100` allows up to 100 orders (between 100 and 1,000 seats). Booths are one
per order, so for booths orders and seats are the same. Orders taken on an earlier link of the same type (before a
price change) count towards the capacity. A refund does not lower Stripe's count: raise `capacity` by one to resell
the seat.

What the sync never does: delete anything, touch objects it did not create (it only looks at objects whose
`metadata.event` matches the catalogue), or run in live mode without `--live`.

## Attendee list

```bash
node scripts/stripe/export-attendees.mjs                 # sandbox orders -> exports/attendees-test-<date>.csv
node scripts/stripe/export-attendees.mjs --live          # real orders
node scripts/stripe/export-attendees.mjs --live --edition toronto --since 2027-01-01
```

One row per order with ticket type, quantity, buyer and organisation name, email, phone (booths), edition, names
of other attendees, dietary or accessibility needs, amounts, tax and discount. Refunded and unpaid orders are
left out (`--include-refunded` to keep them). `exports/` is git-ignored because the file contains personal data.

## Test cards (sandbox only)

`4242 4242 4242 4242`, any future expiry, any CVC and postal code. Declined: `4000 0000 0000 0002`.
