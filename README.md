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
