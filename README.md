# 👻 Ghost Operator: an autonomous procurement employee

Give it an **objective**, not instructions:

> "I need 50 laptops for my new office. 16GB RAM, Windows 11 Pro, ideally 3-year onsite warranty. Budget $75k."

Ghost Operator plans the mission, **finds vendors on the live web**, sends **web agents** to their sites in parallel, **re-checks every claim against the vendor's own product page**, and runs an **ML layer** over the verified data. It then hands a human a ranked, evidence-backed recommendation and a draft purchase order to approve. Nothing is ever bought automatically.

```
Objective ──► Planner (Claude) ──► editable Requirements (hard/soft constraints, budget)
                                          │
                         ① TinyFish Search API: discover more stores for this item
                                          │
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
   ② TinyFish Web Agent: Dell   Web Agent: Lenovo          Web Agent: Office Depot (discovered) …
              └───────────────────────────┼───────────────────────────┘   (parallel, SSE, live browser view)
                                          ▼
   ③ TinyFish Fetch API: re-read every cited product page → verify price/specs/stock, detect promo caps
                                          ▼
   ML layer: normalize → entity resolution → fair-price regression + anomaly detection
             → warranty-risk classifier → constraint fit → lifetime cost → explainable ranking
                                          ▼
   Recommend the best *page-verified, in-stock* offer ──► Human approve/reject ──► Draft PO
```

## Who it's for, and why it matters

**Who:** office managers, lab managers, IT leads and founders at companies of 10 to 500 people, plus schools and clinics. They buy laptops, gloves and other equipment in bulk a few times a year, and none of them has a procurement team.

**The problem today:**
- **It eats time.** In a Walmart Business survey of 500+ decision-makers at 10–500-person companies, 37% said they spend 4 to 7 hours a week on routine ordering alone ([PYMNTS](https://www.pymnts.com/?p=3882849)).
- **Most have no tooling.** Nearly two-thirds of finance leaders in a CFO Connect survey had no dedicated procurement tool ([Spendesk](https://www.spendesk.com/blog/procurement-software-adoption/)).
- **Each order costs money to process.** APQC puts the median cost of processing one purchase order at about $42, with a range of $14 to $54+ ([APQC](https://www.apqc.org/resource-library/resource/how-efficient-your-procurement-process-benchmarks-reveal-wide-performance)).
- **The web is full of traps for a one-time buyer.** Promo prices are capped per order, configurators show a different spec at the advertised price, warranties turn out to be mail-in, and stock is backordered. A busy person comparing tabs misses these.

**What changes with Ghost Operator.** The buyer types one sentence, and within minutes (live runs take 3 to 12 minutes; replay takes under a minute) gets a ranked shortlist in which every price was re-checked on the vendor's own page. They also get a memo that explains the trade-offs, a ready purchase order and, where needed, a drafted quote-request email.

These are real catches from the recorded runs (see [What verification caught](#what-verification-caught-on-real-pages-2026-10-16)):

| Trap | What a tab-by-tab buyer would have done | What Ghost Operator did |
|---|---|---|
| Lenovo ThinkBook 14x at **$849**, "Max 5 units per order" | Budgeted 50 × $849 = **$42,450** | Re-costed the other 45 units at list: expected **$61,975**, so a **$19,525 (46%) budget gap** was caught before approval. It ranked the offer "ask for a quote" and drafted that email. |
| Dell Pro 16 at $1,255 advertised with 16 GB | Bought 50 machines with **8 GB** RAM | The page showed 8 GB at that price, so the offer was corrected and excluded. |
| Uline gloves priced "per 1,000" by the agent | Ordered 10× the intended quantity, or 10× short | The page sells cartons of 100, so the offer was flagged as a mismatch. |
| Same ThinkPad E14 at Lenovo and CDW | Picked whichever tab was open | Lenovo direct was 3% cheaper, with a better CPU and 2× the storage. |

**Why it's realistic:**
- **A human stays in charge.** Nothing is ever bought or sent automatically. The buyer can override the pick (with a reason that's recorded on the PO), tune the scoring weights and export everything to CSV.
- **It doesn't depend on any one store.** It works on vendors' public websites, so there are no supplier integrations to sign. New categories are a JSON file in `config/domains/`.
- **It works without a network.** Replay mode runs on recorded real TinyFish runs, so a demo never depends on the network.
- **Known limits:**
  - Live runs take 3 to 12 minutes.
  - The recorded vendors are US stores.
  - A listed price isn't a contract, which is why quotes are drafted for anything uncertain.

## How TinyFish is used

TinyFish is the product's eyes and hands on the live web. All three APIs do work that the product can't do without them:

| TinyFish API | Where | What it does in Ghost Operator | Why it's needed |
|---|---|---|---|
| **Search API** (`GET api.search.tinyfish.ai`) | [`backend/discovery.py`](backend/discovery.py) | Turns the requirements into a shopping query, then filters results down to real stores (forums, blogs, social and review sites dropped; ranked by commerce signals). The buyer ticks which ones to dispatch agents to. | A small business doesn't know every supplier. Search turns "50 laptops" into a vendor shortlist, e.g. it surfaced **Office Depot** and **Eagle Protect** (gloves), which weren't in the config. |
| **Web Agent** (`POST agent.tinyfish.ai/v1/automation/run-sse`) | [`backend/tinyfish.py`](backend/tinyfish.py), [`backend/pipeline.py`](backend/pipeline.py) | One goal-driven agent per vendor, run in parallel, navigates listings and configurators and returns structured JSON (price, specs, warranty, seller, stock, URL). Progress steps and the live browser stream are shown in the UI. | Vendor sites are dynamic: filters, configurators, cookie walls. A plain scraper can't do "find business laptops with ≥16 GB and read the warranty line". |
| **Fetch API** (`POST api.fetch.tinyfish.ai`) | [`backend/verify.py`](backend/verify.py) | Re-reads every product page the agents cited (≤10 per call, in parallel) and checks each claim: price present on page, RAM/storage/thickness *at that price*, warranty line, stock, and **"Max N units per order"** promo caps. The page wins: specs are corrected, capped promos are re-costed at list price for the rest of the quantity. | Agents can misread a configurator. For a 50-unit purchase the price and specs must come from the source, not from one agent's read. |

### What verification caught on real pages (2026-10-16)

- **Dell Pro 16 (AMD), $1,255:** the agent reported 16 GB RAM, but Dell's page shows the $1,255 config has **8 GB**. The offer was corrected and excluded by the 16 GB must-have.
- **Lenovo ThinkBook 14x, $949 and ThinkPad E14, $1,259:** the page says **"Promo price: Max 5 units per order"**. For 50 units the expected average is **$1,386** and **$1,655**. The $849 sibling's page didn't render, so its cap was inferred from the same-model listing (labelled as inferred).
- **Dell Pro 16 Plus, $1,826:** the price changed; the page now shows $1,836 / $1,868. Two Dell configs are **sold out**.
- **CDW Dell Pro 14 Plus:** price verified, but **backordered**, so it's excluded from the recommendation for a 50-unit order.
- **Uline gloves:** the agent priced 1,000 gloves as $150, while the page prices a **carton of 100** at $17/$15. Flagged as a mismatch.
- **Office Depot (discovered by Search):** all 4 offers verified (price, RAM, storage, warranty).

Net effect: the naive cheapest pick ($849 ThinkBook) becomes "ask Lenovo for a 50-unit quote", and the recommendation goes to the best offer whose **price is confirmed on the vendor's page and that is in stock**.

## Revenue model

**Who pays:** the 10–500-person company, per mission (one buying objective, e.g. "50 laptops"). We sell to the buyer only. We take **no vendor commissions or paid placement**, because a ranking that can be bought is worthless to the buyer.

### What one mission costs us (measured on the recorded runs)

| Cost | Rate | Laptops (5 vendors) | Gloves (2 vendors) |
|---|---|---|---|
| TinyFish Web Agent | $0.016 / step ([pricing](https://tinyfish.ai/pricing)) | 124 steps = **$1.98** | 131 steps = **$2.10** |
| TinyFish Search + Fetch | free on every plan ([pricing](https://tinyfish.ai/pricing)) | $0 | $0 |
| Claude (planner + memo) | Opus 5.5 at $4 / $20 per M input/output tokens ([pricing](https://www.eesel.ai/blog/claude-opus-5-5-pricing)) | ≈ $0.20 (est.) | ≈ $0.20 (est.) |
| **Total** | | **≈ $2.20** | **≈ $2.30** |

We budget **$2.50 per mission** to cover retries and the occasional long agent run (Uline alone took 101 steps).

### Pricing

| Plan | Price | Included | Our cost at $2.50 / mission | Gross margin |
|---|---|---|---|---|
| **Free** | $0 | 2 live missions / month, unlimited replay | $5 | acquisition cost |
| **Pay as you go** | **$19 / mission** | 1 mission + PO + quote drafts | $2.50 | **87%** |
| **Team** | **$149 / month** | 20 missions ($7.45 each), extra at $9, shared mission history | $50 | **66%** |
| **Business** | **$499 / month** | 80 missions, CSV export, custom categories, priority support | $200 | **60%** |

These margins are a floor:
- **Unused missions:** they cost us nothing.
- **Batch API:** the memo can run on Anthropic's Batch API at half price.
- **Repeat visits:** they can reuse a vendor's known navigation, which needs fewer agent steps.
- **Volume rates:** TinyFish offers enterprise contract pricing at volume.

### Why these prices are justified

- **It costs less than the order it replaces.** At $19, a mission costs less than half of APQC's ~$42 median cost to process one purchase order, and it also does the sourcing and verification that the $42 doesn't include.
- **One catch pays for a year.** The capped-promo catch above was a $19,525 budget error on one order. The 3% same-model price gap is about $2,000 on a $69,000 laptop order. Either one covers more than a year of the Team plan ($1,788).
- **It undercuts existing tools and does something they don't.** Spend-management tools like Procurify are quote-based. Third-party listings start around $23 per user per month ([TrustRadius](https://trustradius.com/products/procurify/pricing)), with small-business deployments reported at around $1,000 per month ([ERP Research](https://erpresearch.com/erp-add-ons/procurement/procurify/pricing)). Those tools route approvals and POs for suppliers you already know. Ghost Operator does the step before that: it finds and verifies the offer on the live web. It complements them (CSV export), and Team is priced below them.

### Go-to-market

1. **Free tier and replay demo.** Anyone can see a full mission in under a minute with no signup.
2. **Templates for the three most common bulk buys.** These are IT hardware, lab and medical consumables, and office supplies. Each is one `config/domains/*.json` file.
3. **Channels that already serve these buyers.** These are IT managed-service providers, lab-supply consultants and coworking operators.
4. **India next.** Adding Indian vendor domains (e.g. Amazon Business India, IndiaMART) is a config change, not a rewrite.

**Illustrative target, not a forecast:** 500 companies on Team is $74,500 a month, or about $0.9M ARR, at a ~66% gross margin.

## Run it

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env          # add TINYFISH_API_KEY (and ANTHROPIC_API_KEY) for live mode
.venv/bin/uvicorn backend.app:app --port 8077
```

Open http://localhost:8077.

| Mode | When | What happens |
|---|---|---|
| **live** | `TINYFISH_API_KEY` set | Real TinyFish Search, Web Agent and Fetch calls, with the live browser view embedded per vendor. Every agent run, search and page fetch is recorded to `data/recorded/` and can be replayed later. |
| **replay** | no key, or `GHOST_MODE=replay` | Plays back recorded TinyFish responses (`fixtures/replay/`: real runs, searches and page fetches from 2026-10-16) at `REPLAY_SPEED`× so the demo never depends on venue Wi-Fi. |

Without Claude credentials, the planner and memo fall back to rule-based versions, so the app always works.

## Working with a decision brief

| Feature | What it does |
|---|---|
| **Past missions** | Every saved mission is listed under the console. Click one to reopen its brief. Briefs are linkable (`/#m=<id>`). |
| **What-if scoring** | Sliders for fit, lifetime cost, warranty risk, price sanity and source trust re-rank the offers server-side (`POST /api/missions/{id}/rerank`) using the same scorer. Nothing is saved; the weights in effect are recorded with the approval. |
| **Approve a different offer** | "Choose this offer" on any eligible row (or in the what-if / compare views) switches the sign-off to it. An override needs a reason, which is printed on the PO. Excluded offers can't be approved. |
| **Compare** | Tick 2 to 3 offers for a side-by-side table with the best value per row highlighted. |
| **Export CSV** | `GET /api/missions/{id}/offers.csv`: every offer with prices, verification, TCO, scores and attributes. Formula-like cells are neutralised. |
| **Quote request draft** | `GET /api/missions/{id}/offers/{offer_id}/quote-request` builds an RFQ email from what was found (promo caps, backorders, warranty gaps, unverified specs). Copy it or open it in your mail app; it's never sent automatically. |

The PO prices the order at the *expected* unit price, so a capped promo is no longer understated.

## The AI/ML pieces (`backend/ml/`, `backend/scoring.py`)

| Module | Technique | Why it matters |
|---|---|---|
| `normalize.py` | Spec parsers (RAM/storage/CPU tier/warranty terms/condition) | "16 GB LPDDR5X", "16GB" and "16 GB DDR5" all become `ram_gb=16`. "One Year Onsite" becomes `{years: 1, service: onsite}`. |
| `matching.py` | TF-IDF char n-grams + cosine; complete-linkage clustering with spec compatibility; model-family matching | Finds the same product or model line across vendors, e.g. *ThinkPad E14 Gen 7 is 3% cheaper at Lenovo direct than CDW **and** has a better CPU and 2× the storage* (real finding). |
| `pricing.py` | Leave-one-out ridge regression on log(price) from specs + Isolation Forest | Predicts a "fair price" for each listing. Flags **deals** (first-party, new) vs **suspicious** cheap listings (refurb/third-party) vs **overpriced**. |
| `warranty_risk.py` | TF-IDF + logistic regression clause classifier (`fixtures/warranty_clauses.json`) + structured risk features | Flags mail-in/depot service, short terms, third-party sellers and refurb. Explains *which words* triggered it. |
| `scoring.py` | Hard/soft constraint fit, lifetime cost (purchase at the *effective* unit price + expected out-of-warranty repairs + downtime by service type), weighted score incl. a **source-trust** term from Fetch verification | The ranking is explainable: every row has a "why" with risk reasons, cost breakdown, verification checks and raw TinyFish evidence. |

## Adding a new domain

Drop a JSON file in `config/domains/` with a vendor list, the fields to extract, attribute parsers, default constraints and a goal template. `lab_supplies.json` (nitrile gloves) is a worked example. The planner and UI pick it up automatically.

## Recorded fixtures (real TinyFish runs, 2026-10-16)

| Vendor | Steps | Duration | Notable |
|---|---|---|---|
| Dell | 28 | 4m21s | Base configs ship with **1-yr mail-in** warranty |
| Lenovo | 20 | 3m21s | ThinkBook 14x promo at $849 (flagged as a deal) |
| CDW | 24 | 4m46s | Resells Lenovo/Dell; backorder status captured |
| Uline (gloves) | 101 | 11m48s | ASTM D6319 certs; agent priced per 1,000 while page prices per 100 (caught by Fetch) |
| Office Depot (found by Search) | 12 | 2m12s | 4 offers, all verified by Fetch |
| Eagle Protect (gloves, found by Search) | 30 | 3m48s | 4mil exam grade, D6319; wins the glove mission |

Search results (`_search.json`) and fetched product pages (`_fetch.json`) from the same day sit next to the agent runs. Long pages are trimmed to the relevant lines and marked `_excerpt`.

Live runs take **3 to 12 minutes**, so stream progress, cap `max_duration_seconds`, and keep the replay mode ready for the demo.

## Testing

```bash
.venv/bin/python -m scripts.analyze_fixtures        # ML layer on fixtures, no network
.venv/bin/python -m scripts.smoke_test              # full API flow against a running server
```
