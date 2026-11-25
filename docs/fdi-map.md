# FDI map

`https://www.archangx.com/fdi-map.html`: investors and partners outside Canada, and the Canadian space, defence-tech
and AI companies they have backed, as an interactive map and a filterable table. Refreshed after every quarter.
A refresh touches data only.

| File | Role |
|---|---|
| `site/data/fdi-map.json` | The data: the single source of truth, also published for download. Edit this. |
| `tools/fdi_map.py` | Validates the data and writes the generated blocks of the page. Python 3, standard library only. |
| `site/fdi-map.html` | The page. Text between `<!-- fdi-...:start -->` and `<!-- fdi-...:end -->` is generated: never edit it by hand. |
| `tools/fdi_map_png.mjs` | Dev-only: writes `site/assets/fdi-map-post.png` (2400 × 3000, for posts) and `site/assets/fdi-map-og.png` (1200 × 630, the link preview). |
| `.github/workflows/deploy.yml` | Runs `python3 tools/fdi_map.py --check` before every deploy: invalid data or a stale page stops the deploy. |

```bash
python tools/fdi_map.py            # validate, then regenerate the page (prints the counts and the three figures)
python tools/fdi_map.py --check    # validate, and fail if the page does not match the data (what CI runs)
node tools/fdi_map_png.mjs         # regenerate both images (Node 22+, uses the Edge or Chrome already installed)
python tools/check_site.py         # every link and file exists
```

## Data schema

One JSON object. Ids are lowercase letters, digits and hyphens, unique within their list.

| Key | Type | Meaning |
|---|---|---|
| `as_of` | `YYYY-MM-DD` | Date the public sources were last checked. |
| `quarter` | `"Q4 2026"` | Quarter this edition covers. Optional: if missing, it is derived from `as_of`. |
| `sectors[]` | `{id, name, color}` | Company sectors, in display order. `color` is `#rrggbb` and must reach 3:1 contrast with the page background (`#f7f8f6`); the validator checks it. |
| `regions[]` | `{id, name}` | Investor regions, in display order. |
| `companies[]` | `{id, name, sector, city?, what?}` | Canadian companies. `sector` is a sector id. `what` is a few words on what the company does. |
| `investors[]` | `{id, name, region, country?, sources[]}` | Investors and partners outside Canada. `region` is a region id; `country` is shown when the region covers several countries (Europe). `sources` is required for any investor with a link. |
| `links[]` | `{investor, company, kind, label, status, date?, ended?, last_verified?, sources?[]}` | One documented deal. `kind` is `equity` or `partnership` (partnership covers contracts, MOUs and offsets: say which in the label). `status` is `active` or `ended`. `date` is when it was announced (`YYYY`, `YYYY-MM` or `YYYY-MM-DD`); `ended` is required when the status is `ended`; `last_verified` is the day the source was last opened (`YYYY-MM-DD`). `sources` on a link takes priority over the investor's sources. |
| `changelog[]` | `{date, quarter?, summary?, added?[], changed?[], ended?[]}` | One entry per edition, newest shown first. Each list holds short plain-text lines. |

A source is a URL string, or `{"url": "...", "title": "..."}`. The table shows each source as its web address.

The validator fails on: a missing required field or top-level key, an id that does not resolve, a duplicate id or
link, an investor with links but no source, a source that is not an `http(s)` URL, a malformed or impossible date,
an `ended` link without its date, a sector colour below 3:1 contrast, a headline-figure id missing from the data,
and anything listed under Exclusions.

## Headline figures

Computed by `figures()` in `tools/fdi_map.py` from **active** links only; ended links stay on the map and in the
table but do not count. The ids they use are in `FIGURES` at the top of the script.

1. **US share of foreign equity into space:** of the active equity links into companies in the satellite and space
   sector, how many come from investors in the United States region.
2. **Partnership share from Europe and South Korea:** of the active links from the Europe and South Korea regions
   into satellite and space or defence companies, how many are partnerships (contracts, MOUs, offsets) rather than equity.
3. **Breadth of backing, AI against space:** the number of distinct investor regions behind the most widely backed AI
   company, against the most behind any satellite and space company (ties broken by number of links).

## Inclusion rules

- The investor or partner is headquartered outside Canada. The company is headquartered or mainly operating in
  Canada, in satellite and space, defence, dual-use or wildfire technology, or AI.
- The deal is publicly announced and has a primary source (a company or government release) or a reputable trade or
  business publication.
- Equity and partnerships are recorded separately. An MOU is labelled as an MOU. A deal that ended is kept with
  status `ended` and its date, not deleted.
- A claim that rests on one weak source, or where sources disagree on the amount or date, is not added: it goes on
  the "needs review" list in the pull request instead.

## Exclusions

The map is public. It must never contain:

- ArchangX's own investor research: shortlists, priorities, fit scores, approach order or outreach notes. These stay
  outside the repository. The validator rejects such fields (`priority`, `shortlist`, `approach`, `fit`, `routes`, ...).
- The firm named in the private update instructions. The validator blocks its name in the data file and on the page;
  it holds only a hash of the name, so the name itself is not in the repository.
- Any programme name other than Metatron.

## Quarterly update checklist

Run in the first week of January, April, July and October, for the quarter that just ended.

1. Create a branch, for example `fdi/2026-q4`.
2. Re-check every existing link: open its source, confirm it still supports the label, and look for anything new in
   the quarter (a follow-on round, an exit, an agreement completed or cancelled). Update `label` and `status`, set
   `ended` for a deal that ended, and set `last_verified` to today.
3. Find new links announced in the quarter: foreign investors, strategic groups, defence primes and public funds
   taking equity in, or signing contracts, MOUs or offset investments with, Canadian companies in the four sectors.
   Search company and investor releases; Government of Canada, Canadian Space Agency, National Defence and NATO
   (DIANA and the Innovation Fund) announcements; and trade press such as SpaceQ, BetaKit, The Logic, Payload,
   SpaceNews and Via Satellite.
4. Check the private watchlist (kept outside the repository) for a first Canadian deal.
5. Add each new investor, company and link with its source URL. Every new or changed fact needs a source opened
   during the update; nothing from memory.
6. Update `as_of`, `quarter` and add a `changelog` entry (added, changed, ended).
7. Run `python tools/fdi_map.py` (note the three figures it prints before and after), `node tools/fdi_map_png.mjs`
   and `python tools/check_site.py`.
8. Open a pull request titled "FDI map: <quarter> update" with: what was added, changed and ended, each with its
   source; the three headline figures before and after; any foreign-share figures for the quarter from CVCA,
   CPE Analytics or BDC, with links; the "needs review" list; and a draft LinkedIn post under 1,500 characters.
9. Change only the data file, the generated page blocks and the two images. A schema change also updates this
   document and `tools/fdi_map.py`.

## Accessibility

The map is inline SVG: every investor and company is a button reachable with Tab, with a text label that includes
its region or sector and its number of links; Enter or Space selects it, Escape closes the details. Highlighting greys
other labels rather than fading them, so text keeps 4.5:1 contrast. Meaning never rests on colour alone: the line
pattern (solid or dashed) and the table's Kind and Sector columns carry the same information. The table is the
default view on phones, and both views work without JavaScript.
