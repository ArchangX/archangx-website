"""FDI map: validates site/data/fdi-map.json and writes the generated parts of site/fdi-map.html.

    python tools/fdi_map.py            validate, then rewrite the blocks between the markers
    python tools/fdi_map.py --check    validate, and exit 1 if the page is out of date (run in CI)
    python tools/fdi_map.py --data F   use another data file (for testing); implies no writing unless --write

The data file is the single source of truth. Every number on the page (counts, link totals, the three headline
figures, the as-of date and quarter) is computed here; nothing in the generated blocks is edited by hand.
The page is plain HTML: the map (inline SVG) and the table are readable without JavaScript.
Schema, inclusion rules and the quarterly checklist: docs/fdi-map.md. Python 3 standard library only.
"""
import hashlib
import html
import json
import math
import re
import sys
from collections import Counter, defaultdict
from datetime import date
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "site" / "data" / "fdi-map.json"
PAGE = ROOT / "site" / "fdi-map.html"
PAGE_BG = "#f7f8f6"  # --paper in site/assets/style.css: line colours must reach 3:1 against it (WCAG 1.4.11)

# Which ids the three headline figures use. Change these only if the ids in the data change.
FIGURES = {
    "space_sector": "space",          # figure 1 and 3: the satellite and space sector
    "us_region": "us",                # figure 1: the United States
    "defence_sector": "defence",      # figure 2: defence, dual-use and wildfire
    "partner_regions": ["europe", "south-korea"],  # figure 2
    "ai_sector": "ai",                # figure 3
}

KINDS = {"equity": "Equity investment", "partnership": "Partnership, contract, MOU or offset"}
KIND_SHORT = {"equity": "Equity", "partnership": "Partnership"}
STATUSES = {"active", "ended"}
REQUIRED = {
    "sectors": ("id", "name", "color"),
    "regions": ("id", "name"),
    "companies": ("id", "name", "sector"),
    "investors": ("id", "name", "region"),
    "links": ("investor", "company", "kind", "label", "status"),
}
# The map is public. These keys belong to private research (who to approach, in what order) and must never be
# in the published data file.
PRIVATE_KEYS = {"priority", "prior", "shortlist", "approach", "approach_order", "fit", "template", "routes",
                "outreach", "order", "rank", "intro", "contact", "notes_private"}
# Words that must not appear in the data or on the page (see "Exclusions" in docs/fdi-map.md). Kept as SHA-256
# hashes of the lowercase word, so the excluded names are not written anywhere in the repository.
EXCLUDED_HASHES = {"613c4d7547a8af3ae8eb2ab75da0a281c1ea440533b4501f6f26f2f377b59fc4"}


def has_excluded(text):
    words = set(re.findall(r"[a-z0-9]+", text.lower()))
    return any(hashlib.sha256(w.encode()).hexdigest() in EXCLUDED_HASHES for w in words)
DATE_FULL = re.compile(r"^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$")
DATE_ANY = re.compile(r"^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$")
MONTHS = "January February March April May June July August September October November December".split()

esc = lambda s: html.escape(str(s), quote=True)


# ---------------------------------------------------------------- validation

def check_date(value, where, problems, full=False):
    pattern = DATE_FULL if full else DATE_ANY
    if not isinstance(value, str) or not pattern.match(value):
        problems.append(f"{where}: date {value!r} is not {'YYYY-MM-DD' if full else 'YYYY, YYYY-MM or YYYY-MM-DD'}")
        return
    parts = [int(p) for p in value.split("-")] + [1, 1]
    try:
        date(parts[0], parts[1], parts[2])
    except ValueError:
        problems.append(f"{where}: date {value!r} does not exist")


def source_urls(obj):
    """Sources may be plain URLs or {"url": ..., "title": ...} objects."""
    out = []
    for s in obj.get("sources") or []:
        url = s.get("url") if isinstance(s, dict) else s
        title = s.get("title") if isinstance(s, dict) else None
        out.append((url, title))
    return out


def luminance(hex_colour):
    h = hex_colour.lstrip("#")
    rgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in rgb]
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]


def contrast(a, b):
    la, lb = sorted((luminance(a), luminance(b)), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def validate(d, raw_text):
    problems, warnings = [], []
    for key in ("as_of", "sectors", "regions", "companies", "investors", "links", "changelog"):
        if key not in d:
            problems.append(f"top level: missing {key!r}")
    if problems:
        return problems, warnings
    check_date(d["as_of"], "as_of", problems, full=True)
    if "quarter" in d and not re.match(r"^Q[1-4] \d{4}$", str(d["quarter"])):
        problems.append(f"quarter: {d['quarter']!r} is not like 'Q4 2026'")

    # private keys anywhere in the file
    def walk(node, path):
        if isinstance(node, dict):
            for k, v in node.items():
                if k.lower() in PRIVATE_KEYS:
                    problems.append(f"{path}.{k}: private research field; it must not be in the public data file")
                walk(v, f"{path}.{k}")
        elif isinstance(node, list):
            for i, v in enumerate(node):
                walk(v, f"{path}[{i}]")
    walk(d, "data")
    if has_excluded(raw_text):
        problems.append("data: contains an excluded name (see Exclusions in docs/fdi-map.md)")

    ids = {}
    for coll, fields in REQUIRED.items():
        seen = set()
        for i, item in enumerate(d[coll]):
            where = f"{coll}[{i}]" + (f" ({item.get('id') or item.get('label')})" if isinstance(item, dict) else "")
            if not isinstance(item, dict):
                problems.append(f"{where}: not an object")
                continue
            for f in fields:
                if item.get(f) in (None, ""):
                    problems.append(f"{where}: missing {f!r}")
            if "id" in fields and item.get("id"):
                if not re.match(r"^[a-z0-9][a-z0-9-]*$", item["id"]):
                    problems.append(f"{where}: id {item['id']!r} should be lowercase letters, digits and hyphens")
                if item["id"] in seen:
                    problems.append(f"{where}: duplicate id {item['id']!r}")
                seen.add(item["id"])
        ids[coll] = seen

    for s in d["sectors"]:
        c = s.get("color", "")
        if not re.match(r"^#[0-9a-fA-F]{6}$", c):
            problems.append(f"sectors ({s.get('id')}): color {c!r} is not #rrggbb")
        elif contrast(c, PAGE_BG) < 3:
            problems.append(f"sectors ({s.get('id')}): color {c} has {contrast(c, PAGE_BG):.2f}:1 contrast with the page; needs 3:1")
    for c in d["companies"]:
        if c.get("sector") not in ids["sectors"]:
            problems.append(f"companies ({c.get('id')}): sector {c.get('sector')!r} does not resolve")
    for inv in d["investors"]:
        if inv.get("region") not in ids["regions"]:
            problems.append(f"investors ({inv.get('id')}): region {inv.get('region')!r} does not resolve")

    linked = set()
    seen_links = set()
    for i, l in enumerate(d["links"]):
        where = f"links[{i}] ({l.get('investor')} -> {l.get('company')})"
        if l.get("investor") not in ids["investors"]:
            problems.append(f"{where}: investor {l.get('investor')!r} does not resolve")
        if l.get("company") not in ids["companies"]:
            problems.append(f"{where}: company {l.get('company')!r} does not resolve")
        if l.get("kind") not in KINDS:
            problems.append(f"{where}: kind {l.get('kind')!r} is not equity or partnership")
        if l.get("status") not in STATUSES:
            problems.append(f"{where}: status {l.get('status')!r} is not active or ended")
        for f in ("date", "ended", "last_verified"):
            if l.get(f) not in (None, ""):
                check_date(l[f], f"{where}.{f}", problems, full=(f == "last_verified"))
        if l.get("status") == "ended" and not l.get("ended"):
            problems.append(f"{where}: an ended link needs its date ('ended')")
        key = (l.get("investor"), l.get("company"), l.get("kind"), l.get("label"))
        if key in seen_links:
            problems.append(f"{where}: duplicate link")
        seen_links.add(key)
        linked.add(l.get("investor"))
        for url, _ in source_urls(l):
            if not (isinstance(url, str) and urlparse(url).scheme in ("http", "https") and urlparse(url).netloc):
                problems.append(f"{where}: source {url!r} is not an http(s) URL")

    for inv in d["investors"]:
        urls = source_urls(inv)
        for url, _ in urls:
            if not (isinstance(url, str) and urlparse(url).scheme in ("http", "https") and urlparse(url).netloc):
                problems.append(f"investors ({inv.get('id')}): source {url!r} is not an http(s) URL")
        if inv.get("id") in linked and not urls:
            problems.append(f"investors ({inv.get('id')}): has links but no source URL")
        if inv.get("id") not in linked:
            warnings.append(f"investors ({inv.get('id')}): no links (shown in the map without lines)")
    for c in d["companies"]:
        if not any(l.get("company") == c.get("id") for l in d["links"]):
            warnings.append(f"companies ({c.get('id')}): no links")

    for i, e in enumerate(d["changelog"]):
        if not isinstance(e, dict):
            problems.append(f"changelog[{i}]: not an object")
            continue
        if not (e.get("date") or e.get("quarter")):
            problems.append(f"changelog[{i}]: needs a 'date' or a 'quarter'")
        if e.get("date"):
            check_date(e["date"], f"changelog[{i}].date", problems, full=True)

    for key in ("space_sector", "defence_sector", "ai_sector"):
        if FIGURES[key] not in ids["sectors"]:
            problems.append(f"headline figures: sector id {FIGURES[key]!r} ({key}) is not in the data; update FIGURES in tools/fdi_map.py")
    for rid in [FIGURES["us_region"], *FIGURES["partner_regions"]]:
        if rid not in ids["regions"]:
            problems.append(f"headline figures: region id {rid!r} is not in the data; update FIGURES in tools/fdi_map.py")
    return problems, warnings


# ---------------------------------------------------------------- model and figures

class Model:
    def __init__(self, d):
        self.d = d
        self.sectors = {s["id"]: s for s in d["sectors"]}
        self.regions = {r["id"]: r for r in d["regions"]}
        self.companies = {c["id"]: c for c in d["companies"]}
        self.investors = {i["id"]: i for i in d["investors"]}
        self.links = d["links"]
        self.active = [l for l in self.links if l["status"] == "active"]

    def sector_of(self, link):
        return self.companies[link["company"]]["sector"]

    def region_of(self, link):
        return self.investors[link["investor"]]["region"]


def pct(n, d):
    return f"{math.floor(100 * n / d + 0.5)}%" if d else "–"


def region_phrase(m, rid):
    """'the United States' reads better than 'United States' in a sentence."""
    name = m.regions[rid]["name"]
    return f"the {name}" if re.match(r"^(United|Netherlands|Gulf|Philippines|Czech)", name) else name


def figures(m):
    f = FIGURES
    out = []
    # 1. US share of foreign equity investments in space companies
    eq = [l for l in m.active if l["kind"] == "equity" and m.sector_of(l) == f["space_sector"]]
    us = [l for l in eq if m.region_of(l) == f["us_region"]]
    out.append({
        "big": f"{len(us)} of {len(eq)}",
        "text": f"foreign equity investments documented in Canadian {m.sectors[f['space_sector']]['name'].lower()} companies "
                f"came from {region_phrase(m, f['us_region'])} ({pct(len(us), len(eq))}).",
        "n": len(us), "d": len(eq)})
    # 2. share of links from the partner regions into space and defence that are partnerships
    regs = f["partner_regions"]
    secs = (f["space_sector"], f["defence_sector"])
    pl = [l for l in m.active if m.region_of(l) in regs and m.sector_of(l) in secs]
    pp = [l for l in pl if l["kind"] == "partnership"]
    reg_names = " and ".join(region_phrase(m, r) for r in regs)
    out.append({
        "big": f"{len(pp)} of {len(pl)}",
        "text": f"links from {reg_names} into Canadian space and defence companies are partnerships, contracts, MOUs "
                f"or offsets, not equity ({pct(len(pp), len(pl))}).",
        "n": len(pp), "d": len(pl)})
    # 3. regions behind the most-connected AI company vs the most-connected space company
    def best(sector):
        rows = []
        for c in m.d["companies"]:
            if c["sector"] != sector:
                continue
            ls = [l for l in m.active if l["company"] == c["id"]]
            rows.append((len({m.region_of(l) for l in ls}), len(ls), c["name"]))
        rows.sort(key=lambda r: (-r[0], -r[1], r[2]))
        return rows[0] if rows else (0, 0, "")
    ai, sp = best(f["ai_sector"]), best(f["space_sector"])
    out.append({
        "big": f"{ai[0]} vs {sp[0]}",
        "text": f"regions behind {ai[2]}, the most widely backed Canadian AI company, against the most behind any "
                f"Canadian space company.",
        "n": ai[0], "d": sp[0]})
    return out


def quarter_label(d):
    if d.get("quarter"):
        return d["quarter"]
    y, mth, _ = (int(p) for p in d["as_of"].split("-"))
    return f"Q{(mth - 1) // 3 + 1} {y}"


def nice_date(iso):
    p = [int(x) for x in iso.split("-")]
    if len(p) == 1:
        return str(p[0])
    if len(p) == 2:
        return f"{MONTHS[p[1] - 1]} {p[0]}"
    return f"{p[2]} {MONTHS[p[1] - 1]} {p[0]}"


# ---------------------------------------------------------------- rendering

def host(url):
    h = urlparse(url).netloc.lower()
    return h[4:] if h.startswith("www.") else h


def sources_html(urls):
    return " ".join(f'<a href="{esc(u)}" rel="noopener" title="{esc(t or host(u))}">{esc(host(u))}</a>' for u, t in urls) or "–"


def link_sources(m, l):
    return source_urls(l) or source_urls(m.investors[l["investor"]])


def render_counts(m):
    n_inv = len({l["investor"] for l in m.active})
    n_co = len({l["company"] for l in m.active})
    n_ended = len(m.links) - len(m.active)
    ended = f" {n_ended} ended {'link is' if n_ended == 1 else 'links are'} kept for the record." if n_ended else ""
    return (f'<p class="fdi-counts">{n_inv} investors and partners outside Canada with {len(m.active)} documented links '
            f'to {n_co} Canadian companies, drawn from public deal and contract announcements.{ended} '
            f'Public sources as of <time datetime="{esc(m.d["as_of"])}">{nice_date(m.d["as_of"])}</time> '
            f'({esc(quarter_label(m.d))}).</p>')


def render_figures(m):
    cards = "".join(f'<div class="card fdi-figure"><p class="fdi-big">{esc(f["big"])}</p><p>{esc(f["text"])}</p></div>'
                    for f in figures(m))
    return f'<div class="cards fdi-figures">{cards}</div>'


def render_legend(m):
    items = [f'<li><svg width="34" height="10" aria-hidden="true"><line x1="1" y1="5" x2="33" y2="5" stroke="{esc(s["color"])}" '
             f'stroke-width="3"/></svg>{esc(s["name"])}</li>' for s in m.d["sectors"]]
    items += ['<li><svg width="34" height="10" aria-hidden="true"><line x1="1" y1="5" x2="33" y2="5" class="lg-line"/></svg>Equity investment</li>',
              '<li><svg width="34" height="10" aria-hidden="true"><line x1="1" y1="5" x2="33" y2="5" class="lg-line dashed"/></svg>Partnership, contract, MOU or offset</li>']
    if len(m.active) != len(m.links):
        items.append('<li><svg width="34" height="10" aria-hidden="true"><line x1="1" y1="5" x2="33" y2="5" class="lg-line ended"/></svg>Ended (kept for the record)</li>')
    return f'<ul class="fdi-legend" aria-label="Legend">{"".join(items)}</ul>'


def render_map(m):
    W, XL, XR = 1200, 486, 742          # width, investor dot x, company dot x
    ROW, RHEAD, TOP = 23, 38, 54
    # investors: by region order, then by the average position of the companies they link to (fewer crossings)
    co_order = [c["id"] for s in m.d["sectors"] for c in m.d["companies"] if c["sector"] == s["id"]]
    co_pos = {cid: i for i, cid in enumerate(co_order)}
    by_inv = defaultdict(list)
    for l in m.links:
        by_inv[l["investor"]].append(l)
    def bary(inv):
        ls = by_inv[inv["id"]]
        return sum(co_pos[l["company"]] for l in ls) / len(ls) if ls else 99
    left, y = [], TOP
    for r in m.d["regions"]:
        invs = [i for i in m.d["investors"] if i["region"] == r["id"]]
        if not invs:
            continue
        left.append(("head", r, y, len(invs)))
        y += RHEAD
        for inv in sorted(invs, key=lambda i: (bary(i), i["name"].lower())):
            left.append(("inv", inv, y, None))
            y += ROW
        y += 8
    left_h = y
    # companies: spread over the same height, grouped by sector
    groups = [(s, [c for c in m.d["companies"] if c["sector"] == s["id"]]) for s in m.d["sectors"]]
    groups = [(s, cs) for s, cs in groups if cs]
    n_co = sum(len(cs) for _, cs in groups)
    SHEAD = 40
    block = max(50, (left_h - TOP - SHEAD * len(groups)) / max(n_co, 1))
    right, y = [], TOP
    for s, cs in groups:
        right.append(("head", s, y))
        y += SHEAD
        for c in cs:
            right.append(("co", c, y + 14))
            y += block
    H = math.ceil(max(left_h, y) + 16)
    pos_i = {item[1]["id"]: item[2] for item in left if item[0] == "inv"}
    pos_c = {item[1]["id"]: item[2] for item in right if item[0] == "co"}
    deg_c = Counter(l["company"] for l in m.active)
    deg_i = Counter(l["investor"] for l in m.active)

    out = [f'<svg class="fdi-svg" viewBox="0 0 {W} {H}" role="group" aria-labelledby="fdi-map-title" '
           f'preserveAspectRatio="xMidYMin meet">',
           '<text class="col-head" x="486" y="22" text-anchor="end">INVESTORS AND PARTNERS, BY REGION</text>',
           '<text class="col-head" x="742" y="22">CANADIAN COMPANIES, BY SECTOR</text>',
           '<text class="col-head" x="1188" y="22" text-anchor="end">LINKS</text>',
           '<g class="lines" aria-hidden="true">']
    # ended links first (underneath), then partnerships, then equity on top
    order = sorted(m.links, key=lambda l: (l["status"] == "active", l["kind"] == "equity"))
    for l in order:
        y1, y2 = pos_i[l["investor"]], pos_c[l["company"]]
        xm = (XL + XR) / 2
        cls = f'ln k-{l["kind"]}' + (" ended" if l["status"] == "ended" else "")
        out.append(f'<path class="{cls}" data-i="{esc(l["investor"])}" data-c="{esc(l["company"])}" '
                   f'stroke="{esc(m.sectors[m.sector_of(l)]["color"])}" '
                   f'd="M{XL + 6} {y1:.1f} C{xm:.1f} {y1:.1f} {xm:.1f} {y2:.1f} {XR - 7} {y2:.1f}"/>')
    out.append('</g>')
    for kind, obj, y, n in left:
        if kind == "head":
            out.append(f'<text class="grp-head" x="{XL}" y="{y + 22}" text-anchor="end">{esc(obj["name"].upper())} · {n}</text>')
            continue
        k = deg_i[obj["id"]]
        country = f'<tspan class="muted"> {esc(obj["country"])}</tspan>' if obj.get("country") else ""
        label = f'{obj["name"]}{", " + obj["country"] if obj.get("country") else ""}, {m.regions[obj["region"]]["name"]}: {k} link{"s" if k != 1 else ""}'
        out.append(f'<g class="node inv" data-id="{esc(obj["id"])}" tabindex="0" role="button" aria-pressed="false" aria-label="{esc(label)}">'
                   f'<rect class="hit" x="0" y="{y - 11}" width="{XL + 10}" height="{ROW}"/>'
                   f'<text x="{XL - 12}" y="{y + 5}" text-anchor="end">{esc(obj["name"])}{country}</text>'
                   f'<circle cx="{XL}" cy="{y}" r="5"/></g>')
    for kind, obj, y in right:
        if kind == "head":
            out.append(f'<text class="grp-head" x="{XR}" y="{y + 22}">{esc(obj["name"].upper())}</text>')
            continue
        k = deg_c[obj["id"]]
        sub = " · ".join(x for x in (obj.get("city"), obj.get("what")) if x)
        label = f'{obj["name"]}, {m.sectors[obj["sector"]]["name"]}: {k} foreign link{"s" if k != 1 else ""}'
        out.append(f'<g class="node co" data-id="{esc(obj["id"])}" tabindex="0" role="button" aria-pressed="false" aria-label="{esc(label)}">'
                   f'<rect class="hit" x="{XR - 10}" y="{y - 16}" width="{W - XR + 10}" height="{min(block, 46):.0f}"/>'
                   f'<circle cx="{XR}" cy="{y}" r="7"/>'
                   f'<text class="co-name" x="{XR + 16}" y="{y + 6}">{esc(obj["name"])}</text>'
                   + (f'<text class="co-sub" x="{XR + 16}" y="{y + 25}">{esc(sub)}</text>' if sub else "")
                   + f'<text class="co-n" x="{W - 12}" y="{y + 6}" text-anchor="end">{k}</text></g>')
    out.append('</svg>')
    return "\n".join(out)


def render_table(m):
    def opts(items, label):
        return f'<option value="">{label}</option>' + "".join(f'<option value="{esc(i)}">{esc(n)}</option>' for i, n in items)
    filters = ('<div class="fdi-filters" hidden>'
               f'<label>Region<select data-filter="region">{opts([(r["id"], r["name"]) for r in m.d["regions"]], "All regions")}</select></label>'
               f'<label>Sector<select data-filter="sector">{opts([(s["id"], s["name"]) for s in m.d["sectors"]], "All sectors")}</select></label>'
               f'<label>Kind<select data-filter="kind">{opts(list(KIND_SHORT.items()), "All kinds")}</select></label>'
               f'<p class="fdi-shown" aria-live="polite">Showing all {len(m.links)} links</p></div>')
    rows = []
    co_order = {c["id"]: i for i, c in enumerate(m.d["companies"])}
    reg_order = {r["id"]: i for i, r in enumerate(m.d["regions"])}
    for l in sorted(m.links, key=lambda l: (reg_order[m.region_of(l)], m.investors[l["investor"]]["name"].lower(), co_order[l["company"]])):
        inv, co = m.investors[l["investor"]], m.companies[l["company"]]
        sec = m.sectors[co["sector"]]
        where = m.regions[inv["region"]]["name"] + (f' ({inv["country"]})' if inv.get("country") else "")
        when = f' <span class="muted">({esc(nice_date(l["date"]))})</span>' if l.get("date") else ""
        status = "Active" if l["status"] == "active" else f'Ended{" " + esc(nice_date(l["ended"])) if l.get("ended") else ""}'
        kind_svg = f'<svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" class="lg-line{" dashed" if l["kind"] == "partnership" else ""}"/></svg>'
        sec_svg = f'<svg width="12" height="12" aria-hidden="true"><circle cx="6" cy="6" r="5" fill="{esc(sec["color"])}"/></svg>'
        rows.append(
            f'<tr data-i="{esc(inv["id"])}" data-c="{esc(co["id"])}" data-region="{esc(inv["region"])}" data-sector="{esc(co["sector"])}" '
            f'data-kind="{esc(l["kind"])}"{" class=ended" if l["status"] == "ended" else ""}>'
            f'<td data-th="Investor">{esc(inv["name"])}</td><td data-th="From">{esc(where)}</td>'
            f'<td data-th="Company">{esc(co["name"])}</td><td data-th="Sector">{sec_svg} {esc(sec["name"])}</td>'
            f'<td data-th="Kind">{kind_svg} {KIND_SHORT[l["kind"]]}</td><td data-th="Deal">{esc(l["label"])}{when}</td>'
            f'<td data-th="Status">{status}</td><td data-th="Sources">{sources_html(link_sources(m, l))}</td></tr>')
    table = ('<div class="fdi-table-wrap"><table class="fdi-table"><caption class="sr-only">Documented links: one row per '
             'investment or partnership</caption><thead><tr><th scope="col">Investor or partner</th><th scope="col">From</th>'
             '<th scope="col">Company</th><th scope="col">Sector</th><th scope="col">Kind</th><th scope="col">Deal</th>'
             '<th scope="col">Status</th><th scope="col">Sources</th></tr></thead><tbody>' + "\n".join(rows) + '</tbody></table></div>')
    return filters + "\n" + table


def render_changelog(m):
    items = []
    entries = sorted(m.d["changelog"], key=lambda e: e.get("date") or "", reverse=True)
    for e in entries:
        head = " · ".join(x for x in (e.get("quarter"), nice_date(e["date"]) if e.get("date") else None) if x)
        parts = [f'<h3>{esc(head)}</h3>']
        if e.get("summary"):
            parts.append(f'<p>{esc(e["summary"])}</p>')
        for key, title in (("added", "Added"), ("changed", "Changed"), ("ended", "Ended")):
            vals = e.get(key) or []
            if isinstance(vals, str):
                vals = [vals]
            if vals:
                parts.append(f'<p><b>{title}:</b></p><ul>' + "".join(f"<li>{esc(v)}</li>" for v in vals) + '</ul>')
        items.append(f'<li>{"".join(parts)}</li>')
    return f'<ol class="fdi-changelog">{"".join(items)}</ol>'


def render_asof(m):
    return (f'<p class="fdi-asof">Data as of <time datetime="{esc(m.d["as_of"])}">{nice_date(m.d["as_of"])}</time> · '
            f'{esc(quarter_label(m.d))} · <a href="data/fdi-map.json">download the data (JSON)</a> · '
            f'<a href="assets/fdi-map-post.png">map image for sharing (PNG, 2400 × 3000)</a></p>')


BLOCKS = {"fdi-counts": render_counts, "fdi-figures": render_figures, "fdi-legend": render_legend,
          "fdi-map": render_map, "fdi-table": render_table, "fdi-changelog": render_changelog, "fdi-asof": render_asof}


def render_page(page_text, m):
    for name, fn in BLOCKS.items():
        pattern = re.compile(rf"(<!-- {name}:start -->)(.*?)(<!-- {name}:end -->)", re.S)
        if not pattern.search(page_text):
            sys.exit(f"{PAGE.name}: no <!-- {name}:start --> ... <!-- {name}:end --> markers")
        body = fn(m)
        page_text = pattern.sub(lambda mt: mt.group(1) + "\n" + body + "\n" + mt.group(3), page_text, count=1)
    return page_text


def main():
    args = sys.argv[1:]
    check = "--check" in args
    data_file = Path(args[args.index("--data") + 1]) if "--data" in args else DATA
    write = not check and (data_file == DATA or "--write" in args)
    raw = data_file.read_text(encoding="utf-8")
    try:
        d = json.loads(raw)
    except json.JSONDecodeError as e:
        sys.exit(f"{data_file.name}: not valid JSON: {e}")
    problems, warnings = validate(d, raw)
    for w in warnings:
        print("warning: " + w)
    if problems:
        print(f"{data_file.name}: {len(problems)} problem(s)")
        for p in problems:
            print("  - " + p)
        sys.exit(1)
    m = Model(d)
    print(f"{data_file.name}: {len(d['investors'])} investors and partners, {len(d['links'])} links "
          f"({len(m.active)} active), {len(d['companies'])} companies, {len(d['regions'])} regions, "
          f"{len(d['sectors'])} sectors; as of {d['as_of']} ({quarter_label(d)}); 0 problems")
    for f in figures(m):
        print(f"  figure: {f['big']}  {f['text']}")
    page_text = PAGE.read_text(encoding="utf-8")
    new = render_page(page_text, m)
    if has_excluded(new):
        sys.exit(f"{PAGE.name}: contains an excluded name (see Exclusions in docs/fdi-map.md)")
    if check:
        if new != page_text:
            sys.exit(f"{PAGE.name} is out of date with {data_file.name}: run  python tools/fdi_map.py  and commit the result")
        print(f"{PAGE.name} is up to date")
    elif write:
        PAGE.write_text(new, encoding="utf-8", newline="\n")
        print(f"wrote {PAGE.relative_to(ROOT)}")
    else:
        print("(test data: page not written; add --write to write it)")


if __name__ == "__main__":
    main()
