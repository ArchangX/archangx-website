#!/usr/bin/env node
// Creates or updates one Stripe Product, Price and Payment Link per ticket type and edition (city) in
// stripe/catalogue.json, idempotently, and writes the public link URLs to site/data/summit-tickets.json.
//
//   node scripts/stripe/sync-catalogue.mjs --dry-run      plan only, no writes (works without a key too)
//   node scripts/stripe/sync-catalogue.mjs                 apply in the sandbox (rk_test_ key)
//   node scripts/stripe/sync-catalogue.mjs --live          apply in live mode (rk_live_ key, only after Shahin's explicit go)
//
// Each catalogue product is sold per edition unless it says "per_edition": false, so "hackathon" becomes
// "hackathon-toronto" and "hackathon-montreal", each with its own capacity and link.
// Matching: Product by metadata.catalogue_key, Price by lookup_key "<event_slug>-<key>", Payment Link by
// metadata.catalogue_key. Running twice changes nothing. A changed price creates a new Price, deactivates the
// old one and, because a link's line items cannot be swapped, creates a new Payment Link and deactivates the
// old link (so the public URL changes: re-render the site afterwards).
//
// Capacity is a number of completed checkouts (orders), as Stripe counts them. Stripe deactivates a link by
// itself when its limit is reached; the sync then reports the type as sold out and never opens a replacement.
// Orders on earlier links of the same type (before a price change) count towards the capacity.

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Stripe, ROOT, loadKey, readCatalogue, isTodo, toCents, money, fail } from "./stripe-api.mjs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const live = args.has("--live");
for (const a of args) if (!["--dry-run", "--live"].includes(a)) fail(`unknown option ${a}`);

const cat = readCatalogue();
const OUT = path.join(ROOT, "site", "data", "summit-tickets.json");
const today = new Date().toISOString().slice(0, 10);
const editions = cat.editions || [];

// ---- 1. expand per edition, validate, list blockers ----------------------------------------------------
const byEdition = (v, ed) => v && typeof v === "object" && !Array.isArray(v) ? v[ed] : v;
function expand(p) {
  if (p.per_edition === false || !editions.length)
    return [{ ...p, base_key: p.key, edition: null, edition_label: null, display_name: p.name, stripe_name: p.name }];
  return editions.map(ed => {
    const display = byEdition(p.name_by_edition, ed.value) || p.name;
    return { ...p, key: `${p.key}-${ed.value}`, base_key: p.key, edition: ed.value, edition_label: ed.label,
      price: byEdition(p.price, ed.value), capacity: byEdition(p.capacity, ed.value), sales_end: byEdition(p.sales_end, ed.value),
      status: byEdition(p.status, ed.value), display_name: display, stripe_name: `${display} · ${ed.label}` };
  });
}
const items = cat.products.flatMap(expand);

const blockers = [];
const autoTax = cat.automatic_tax === true ? true : cat.automatic_tax === false ? false : null;
if (autoTax === null) blockers.push(`automatic_tax is "${cat.automatic_tax}" (must be true or false)`);
const taxBehavior = cat.tax_behavior ?? (autoTax ? "exclusive" : undefined);
if (taxBehavior !== undefined && !["exclusive", "inclusive"].includes(taxBehavior)) blockers.push(`tax_behavior must be "exclusive" or "inclusive", not ${JSON.stringify(taxBehavior)}`);
const taxCode = isTodo(cat.tax_code) ? null : cat.tax_code || null;
if (isTodo(cat.tax_code)) blockers.push("tax_code is TODO (allowed: the default product tax code in the Stripe Tax settings applies until it is set)");
if (!/^https:\/\/www\.archangx\.com\//.test(cat.redirect_url)) blockers.push("redirect_url must be on https://www.archangx.com/");
if ((cat.inactive_message || "").length > 500) blockers.push("inactive_message is longer than Stripe's 500 characters");
for (const ed of editions) if (!/^[a-z0-9]+$/.test(ed.value)) blockers.push(`edition value ${JSON.stringify(ed.value)} must be lowercase letters and digits`);
const keys = new Set();
for (const p of items) {
  if (keys.has(p.key)) blockers.push(`duplicate key ${p.key}`); keys.add(p.key);
  if (p.price === undefined || isTodo(p.price)) blockers.push(`${p.key}: price is TODO`);
  else if (!/^\d+(\.\d{1,2})?$/.test(String(p.price))) blockers.push(`${p.key}: price must look like "450.00" (CAD dollars), not ${JSON.stringify(p.price)}`);
  if (p.capacity === undefined || isTodo(p.capacity)) blockers.push(`${p.key}: capacity is TODO (use null for unlimited)`);
  else if (p.capacity !== null && !(Number.isInteger(Number(p.capacity)) && Number(p.capacity) > 0)) blockers.push(`${p.key}: capacity must be a whole number above 0, or null`);
  if (isTodo(p.sales_end)) blockers.push(`${p.key}: sales_end is TODO (remove the field if sales simply close at the event)`);
  else if (p.sales_end && !/^\d{4}-\d{2}-\d{2}$/.test(p.sales_end)) blockers.push(`${p.key}: sales_end must be a date like 2027-03-31`);
  if (!["on_sale", "closed", "coming_soon"].includes(p.status || "on_sale")) blockers.push(`${p.key}: status must be on_sale, closed or coming_soon`);
  for (const line of p.includes || []) if (isTodo(line)) blockers.push(`${p.key}: an "includes" line is TODO`);
  if ((p.checkout_note || "").length > 1200) blockers.push(`${p.key}: checkout_note is longer than Stripe's 1200 characters`);
  for (const f of p.fields || []) if (!/^[A-Za-z0-9]+$/.test(f.key || "") || !f.label || f.label.length > 100) blockers.push(`${p.key}: each extra field needs an alphanumeric key and a label of up to 100 characters`);
  if (customFieldsFor(p).length > 3) blockers.push(`${p.key}: Stripe allows at most 3 custom fields per link`);
}
const hardBlockers = blockers.filter(b => !b.includes("tax_code"));

console.log(`${cat.event}: ${cat.products.length} ticket types, ${items.length} products (${editions.length ? "per city" : "single edition"}), currency ${cat.currency.toUpperCase()}, automatic tax ${autoTax ?? "TODO"}, prices ${taxBehavior || "without tax behaviour"}`);
if (blockers.length) {
  console.log(`\n${blockers.length} value(s) still need Shahin's decision (SCRUM-1374):`);
  for (const b of blockers) console.log("  - " + b);
}
if (hardBlockers.length && !dryRun) fail("the catalogue has TODO or invalid values; nothing was sent to Stripe. Fix them and run again.", 1);

// ---- 2. desired state per product ----------------------------------------------------------------------
const slug = cat.event_slug || "summit2027";

function customFieldsFor(p) {
  const isBooth = p.kind === "booth";
  return [
    // The city dropdown is only needed when one link serves both editions.
    !p.edition && editions.length ? { key: "edition", type: "dropdown", optional: false, label: { type: "custom", custom: "Which edition will you attend?" },
      dropdown: { options: editions.map(e => ({ label: e.label, value: e.value })) } } : null,
    isBooth ? null : { key: "attendees", type: "text", optional: true, label: { type: "custom", custom: "Names of the other attendees (if buying more than one)" } },
    isBooth ? null : { key: "needs", type: "text", optional: true, label: { type: "custom", custom: "Dietary or accessibility needs" } },
    ...(p.fields || []).map(f => ({ key: f.key, type: "text", optional: !!f.optional, label: { type: "custom", custom: f.label } })),
  ].filter(Boolean);
}

function desiredFor(p) {
  const isBooth = p.kind === "booth";
  const todo = isTodo(p.price) || p.price === undefined || isTodo(p.capacity) || p.capacity === undefined;
  const unitAmount = todo ? null : toCents(p.price);
  const capacity = p.capacity === null || todo ? null : Number(p.capacity);
  const salesEnded = !!(p.sales_end && !isTodo(p.sales_end) && p.sales_end < today);
  const active = (p.status || "on_sale") === "on_sale" && !salesEnded;
  const meta = { catalogue_key: p.key, event: cat.event, ticket_type: p.base_key, ...(p.edition ? { edition: p.edition } : {}) };
  return {
    product: { name: p.stripe_name, metadata: { ...meta, managed_by: "scripts/stripe/sync-catalogue.mjs" }, tax_code: taxCode || undefined },
    lookupKey: `${slug}-${p.key}`,
    unitAmount,
    capacity,
    active,
    salesEnded,
    // Settings compared field by field with the existing link; restrictions and active are worked out below.
    link: {
      allow_promotion_codes: true,
      billing_address_collection: "required",
      automatic_tax: { enabled: autoTax === true },
      after_completion: { type: "redirect", redirect: { url: `${cat.redirect_url}?t=${encodeURIComponent(p.key)}` } },
      phone_number_collection: { enabled: isBooth },
      name_collection: isBooth
        ? { business: { enabled: true, optional: false }, individual: { enabled: true, optional: false } }
        : { individual: { enabled: true, optional: false }, business: { enabled: true, optional: true } },
      custom_fields: customFieldsFor(p),
      custom_text: p.checkout_note ? { submit: { message: p.checkout_note } } : undefined,
      inactive_message: cat.inactive_message,
      submit_type: "pay",
      metadata: meta,
      payment_intent_data: { metadata: meta },
    },
    // Booths are one per order: no quantity selector at all.
    adjustable: isBooth ? undefined : { enabled: true, minimum: 1, maximum: 10 },
  };
}

// ---- 3. talk to Stripe ---------------------------------------------------------------------------------
let stripe = null, livemode = false;
if (process.env.STRIPE_API_KEY || !dryRun) { const k = loadKey({ live }); stripe = new Stripe(k.key, { dryRun }); livemode = k.livemode; }
else console.log("\n(no STRIPE_API_KEY: offline plan, assuming nothing exists in Stripe yet)");
console.log(dryRun ? "\nDRY RUN: nothing will be written.\n" : `\nApplying to ${livemode ? "LIVE MODE" : "the sandbox"}.\n`);

const existing = { products: new Map(), prices: new Map(), links: new Map() };
if (stripe) {
  for (const active of [true, false]) for await (const pr of stripe.list("/products", { active })) {
    const k = pr.metadata?.catalogue_key;
    if (k && pr.metadata?.event === cat.event && !existing.products.has(k)) existing.products.set(k, pr); // an active product wins over an archived copy
  }
  const lookupKeys = items.map(p => `${slug}-${p.key}`);
  for (let i = 0; i < lookupKeys.length; i += 10) // Stripe takes at most 10 lookup keys per request
    for await (const price of stripe.list("/prices", { lookup_keys: lookupKeys.slice(i, i + 10), active: true })) existing.prices.set(price.lookup_key, price);
  // Every link made for this event, active or not: a sold-out link was deactivated by Stripe, and its orders
  // still count towards the capacity.
  for await (const l of stripe.list("/payment_links", { expand: ["data.line_items"] })) {
    const k = l.metadata?.catalogue_key;
    if (!k || l.metadata?.event !== cat.event) continue;
    if (!existing.links.has(k)) existing.links.set(k, []);
    existing.links.get(k).push(l);
  }
}

const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
function norm(v) { // drop undefined/null-ish and sort keys so Stripe's response compares equal to our request
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).filter(k => v[k] !== undefined && v[k] !== null).sort().map(k => [k, norm(v[k])]));
  return v;
}
const ordersOn = l => l?.restrictions?.completed_sessions?.count || 0;
const priceOn = l => l?.line_items?.data?.[0]?.price?.id;
const metaKeys = ["catalogue_key", "event", "ticket_type", "edition"];

const summary = [], output = [];
let changes = 0;
for (const p of items) {
  const d = desiredFor(p);
  const log = m => console.log(`  ${m}`);
  console.log(`${p.key}  (${p.stripe_name})`);
  const row = { key: p.key, ticket_type: p.base_key, edition: p.edition, edition_label: p.edition_label, name: p.display_name, kind: p.kind, currency: cat.currency,
    includes: p.includes || [], note: p.note || null, show_price: p.show_price !== false, sales_end: p.sales_end && !isTodo(p.sales_end) ? p.sales_end : null,
    capacity: d.capacity, price_cents: d.unitAmount, price_display: d.unitAmount === null ? null : money(d.unitAmount, cat.currency), url: null, status: "coming_soon", sold: 0 };

  if (d.unitAmount === null) { log("skipped: price or capacity is TODO"); summary.push([p.key, "blocked"]); output.push(row); continue; }
  if (!stripe) { log(`would create product, price ${row.price_display}, payment link (${d.active ? "active" : "none: sales closed"}${d.capacity ? `, limit ${d.capacity} orders` : ""})`); changes++; summary.push([p.key, "create"]); output.push(row); continue; }

  // Product
  let product = existing.products.get(p.key);
  if (!product) { product = await stripe.post("/products", d.product, `create product ${p.stripe_name}`); log("product: create"); changes++; }
  else {
    const patch = {};
    if (product.name !== d.product.name) patch.name = d.product.name;
    if ((product.tax_code || null) !== (taxCode || null) && taxCode) patch.tax_code = taxCode;
    if (!product.active) patch.active = true;
    if (!same(pickKeys(product.metadata, metaKeys), pickKeys(d.product.metadata, metaKeys))) patch.metadata = d.product.metadata;
    if (Object.keys(patch).length) { await stripe.post(`/products/${product.id}`, patch, `update product ${Object.keys(patch).join(",")}`); log(`product: update ${Object.keys(patch).join(", ")}`); changes++; }
    else log("product: unchanged");
  }

  // Price (immutable: a changed amount or tax behaviour creates a new one and moves the lookup key)
  let price = existing.prices.get(d.lookupKey);
  if (price && price.product !== product.id && !product.dry_run) { log("warning: lookup key belongs to another product; creating a fresh price"); price = null; }
  const taxMismatch = price && taxBehavior && price.tax_behavior !== taxBehavior;
  if (!price || price.unit_amount !== d.unitAmount || price.currency !== cat.currency || taxMismatch) {
    const old = price;
    price = await stripe.post("/prices", { product: product.id, currency: cat.currency, unit_amount: d.unitAmount, lookup_key: d.lookupKey, transfer_lookup_key: true,
      tax_behavior: taxBehavior, metadata: { catalogue_key: p.key } }, `create price ${row.price_display}`);
    if (old) { await stripe.post(`/prices/${old.id}`, { active: false }, "deactivate old price"); log(`price: ${money(old.unit_amount, old.currency)} ${old.tax_behavior || ""} -> ${row.price_display} ${taxBehavior || ""} (new price, old one deactivated)`); }
    else log(`price: create ${row.price_display}${taxBehavior ? ` (${taxBehavior} of tax)` : ""}`);
    changes++;
  } else log(`price: unchanged (${row.price_display})`);

  // Payment Link
  const links = existing.links.get(p.key) || [];
  if (links.filter(l => l.active).length > 1) log("warning: more than one active payment link for this type; using the first, deactivate the others in the Dashboard");
  const ordersAll = links.reduce((n, l) => n + ordersOn(l), 0);
  let link = links.find(l => l.active) || links.find(l => priceOn(l) === price.id) || null;
  if (link && priceOn(link) !== price.id) { // the price changed: retire the link, a new one (new URL) follows
    if (link.active) { await stripe.post(`/payment_links/${link.id}`, { active: false }, "deactivate old payment link"); changes++; }
    log(`payment link: old link is on the previous price, ${link.active ? "deactivated" : "already inactive"}`);
    link = null;
  }
  const remaining = d.capacity === null ? null : d.capacity - ordersAll;
  const soldOut = remaining !== null && remaining <= 0;
  const wantActive = d.active && !soldOut;
  // A link may take the capacity minus the orders already taken on the other links of this type.
  const limitFor = l => d.capacity === null ? undefined : Math.max(d.capacity - (ordersAll - ordersOn(l)), ordersOn(l), 1);
  const restrictionsFor = l => d.capacity === null ? undefined : { completed_sessions: { limit: limitFor(l) } };

  if (!link) {
    if (wantActive) {
      link = await stripe.post("/payment_links", { line_items: [{ price: price.id, quantity: 1, adjustable_quantity: d.adjustable }], ...d.link, restrictions: restrictionsFor(null) }, "create payment link");
      log(`payment link: create${d.capacity === null ? "" : ` (limit ${limitFor(null)} orders)`}`); changes++;
    } else log(`payment link: none created (${soldOut ? "sold out" : "sales closed"})`);
  } else {
    const want = { ...d.link, restrictions: restrictionsFor(link), active: wantActive };
    const have = { allow_promotion_codes: link.allow_promotion_codes, billing_address_collection: link.billing_address_collection, automatic_tax: { enabled: link.automatic_tax?.enabled },
      after_completion: { type: link.after_completion?.type, redirect: { url: link.after_completion?.redirect?.url } }, phone_number_collection: { enabled: link.phone_number_collection?.enabled },
      name_collection: link.name_collection ? { individual: pick(link.name_collection.individual), business: pick(link.name_collection.business) } : undefined,
      custom_fields: (link.custom_fields || []).map(f => ({ key: f.key, type: f.type, optional: f.optional, label: { type: f.label?.type, custom: f.label?.custom }, dropdown: f.dropdown ? { options: f.dropdown.options.map(o => ({ label: o.label, value: o.value })) } : undefined })),
      custom_text: link.custom_text?.submit?.message ? { submit: { message: link.custom_text.submit.message } } : undefined,
      restrictions: link.restrictions?.completed_sessions?.limit ? { completed_sessions: { limit: link.restrictions.completed_sessions.limit } } : undefined,
      inactive_message: link.inactive_message, submit_type: link.submit_type, metadata: pickKeys(link.metadata, metaKeys),
      payment_intent_data: { metadata: pickKeys(link.payment_intent_data?.metadata, metaKeys) }, active: link.active };
    const patch = {};
    for (const k of Object.keys(want)) if (!same(want[k], have[k])) // null is sent as "" and clears the field
      patch[k] = want[k] !== undefined ? want[k] : k === "custom_text" ? { submit: null } : null;
    const li = link.line_items?.data?.[0];
    if (li && d.adjustable && !same(li.adjustable_quantity, d.adjustable)) patch.line_items = [{ id: li.id, adjustable_quantity: d.adjustable }];
    if (Object.keys(patch).length) {
      await stripe.post(`/payment_links/${link.id}`, patch, `update payment link ${Object.keys(patch).join(",")}`);
      const what = Object.keys(patch).map(k => k === "active" ? (wantActive ? "reactivated" : `deactivated (${soldOut ? "sold out" : "sales closed"})`) : k);
      log(`payment link: ${what.join(", ")}`); changes++;
    } else log(`payment link: unchanged${link.active ? "" : ` (inactive: ${soldOut ? "sold out" : "sales closed"})`}`);
    link = { ...link, active: wantActive };
  }

  // Public state for the website
  row.sold = ordersAll;
  row.url = link?.url && !link.dry_run ? link.url : null;
  row.status = !d.active ? "closed" : soldOut ? "sold_out" : row.url ? "on_sale" : "coming_soon";
  summary.push([p.key, row.status + (d.capacity ? ` (${ordersAll}/${d.capacity} orders)` : ""), row.url]);
  output.push(row);
}

// Links of ticket types that are no longer in the catalogue (removed, renamed, or switched between per-city
// and single) are switched off so they cannot keep selling. Nothing is deleted.
for (const [k, ls] of existing.links) {
  if (keys.has(k)) continue;
  for (const l of ls.filter(x => x.active)) {
    await stripe.post(`/payment_links/${l.id}`, { active: false }, `deactivate link of ${k}, no longer in the catalogue`);
    console.log(`${k}  (no longer in the catalogue)\n  payment link: deactivated`); changes++;
  }
}

// ---- 4. write the public file --------------------------------------------------------------------------
const publicFile = { generated_at: new Date().toISOString(), livemode, event: cat.event, currency: cat.currency, tax_note: cat.tax_note, support_email: cat.support_email,
  editions, tickets: output };
if (!dryRun) { mkdirSync(path.dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(publicFile, null, 2) + "\n"); }
console.log(`\n${changes} change(s) ${dryRun ? "planned" : "applied"}; ${stripe?.writes || 0} write call(s)${dryRun ? " skipped" : ""}.`);
for (const [k, s, url] of summary) console.log(`  ${k.padEnd(30)} ${s}${url ? "  " + url : ""}`);
if (!dryRun) console.log(`\nWrote ${path.relative(ROOT, OUT)}. Now run:  python tools/render_tickets.py`);
if (dryRun && hardBlockers.length) console.log("\nA real run is blocked until the TODO values above are filled in.");

function pick(o) { return o ? { enabled: o.enabled, optional: o.optional } : undefined; }
function pickKeys(o, ks) { return Object.fromEntries(ks.filter(k => o && o[k] !== undefined).map(k => [k, o[k]])); }
