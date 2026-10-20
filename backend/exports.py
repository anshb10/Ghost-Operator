"""Offer CSV export and vendor quote-request drafts. Nothing here is sent anywhere."""
import csv
import io
import re
from datetime import date

CSV_COLUMNS = ["rank", "recommended", "vendor", "name", "sku", "url", "unit_price", "effective_unit_price", "fair_price",
               "price_delta_pct", "price_flag", "stock", "condition", "seller", "warranty", "warranty_years",
               "warranty_service", "warranty_risk", "verification", "fit_score", "tco", "tco_purchase",
               "tco_repairs", "tco_downtime", "score", "passes_hard", "failed_constraints"]


def _cell(v):
    # Scraped text is untrusted: stop spreadsheets from evaluating it as a formula.
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@", "\t", "\r"):
        return "'" + v
    return "" if v is None else v


def offers_csv(mission) -> str:
    rep = mission.report or {}
    offers = rep.get("offers", [])
    attrs = sorted({k for o in offers for k in o.get("attributes", {})})
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS + [f"attr_{a}" for a in attrs])
    for o in offers:
        t, wa = o.get("tco_breakdown") or {}, o.get("warranty") or {}
        row = [o.get("rank"), o["id"] == rep.get("recommended_offer_id"), o["vendor"], o["name"], o.get("sku"), o.get("url"),
               o.get("unit_price"), o.get("effective_unit_price"), o.get("fair_price"), o.get("price_delta_pct"),
               o.get("price_flag"), o.get("stock"), o.get("condition"), o.get("seller"), wa.get("raw"), wa.get("years"),
               wa.get("service"), o.get("warranty_risk"), (o.get("verification") or {}).get("status"), o.get("fit_score"),
               o.get("tco"), t.get("purchase"), t.get("out_of_warranty_repairs"), t.get("downtime"),
               o.get("score") if o.get("rank") else None, o.get("passes_hard"), "; ".join(o.get("failed_constraints", []))]
        w.writerow([_cell(v) for v in row + [o.get("attributes", {}).get(a) for a in attrs]])
    return buf.getvalue()


SPEC_LABELS = {"ram_gb": "RAM", "storage_gb": "storage", "display_in": "screen", "cpu": "CPU", "os": "OS",
               "count_per_case": "count per case", "thickness_mil": "thickness", "powder_free": "powder-free"}
SPEC_UNITS = {"ram_gb": " GB", "storage_gb": " GB", "display_in": "\"", "thickness_mil": " mil"}


def _num(v):
    return int(v) if isinstance(v, float) and v.is_integer() else v


def quote_request(mission, o: dict) -> dict:
    """A plain-text RFQ for one offer, built from what the agents and Fetch verification found."""
    req = mission.req
    q = req.quantity
    seen = (mission.created or "")[:10] or date.today().isoformat()
    name = o["name"].split(" (")[0]
    asks = [f"Your best unit price for {q} units, including any volume discount."]
    v = o.get("verification") or {}
    if v.get("limit") and o.get("effective_unit_price"):
        asks.append(f"Your site lists ${o['unit_price']:,.2f} as a promo price limited to {v['limit']['max_units']} units per order. "
                    f"Can you extend that price, or a comparable one, to all {q} units?")
    stock = o.get("stock") or ""
    if re.search(r"(?i)backorder|sold out|out of stock|unavailable|limited", stock):
        asks.append(f"The listing shows \"{stock}\". What is the lead time to ship {q} units?")
    else:
        asks.append(f"Lead time to deliver {q} units" + (f" within {req.deadline_days} days." if req.deadline_days else "."))
    want_years = next((c.value for c in req.constraints if c.attribute == "warranty_years"), None)
    wa = o.get("warranty") or {}
    if req.domain == "laptops" and (wa.get("service") != "onsite" or (wa.get("years") or 0) < float(want_years or 3)):
        asks.append(f"A price for {int(float(want_years or 3))}-year onsite warranty coverage "
                    f"(the listing states: {wa.get('raw') or 'no warranty terms'}).")
    if v.get("status") in ("mismatch", "unverified", "partial"):
        asks.append("Written confirmation of the exact configuration and specifications at the quoted price.")
    asks += ["How long the quote is valid, and your payment terms.", "Shipping cost and any applicable taxes."]

    specs = ", ".join(f"{SPEC_LABELS.get(k, k.replace('_', ' '))}: {_num(val)}{SPEC_UNITS.get(k, '')}"
                      for k, val in (o.get("attributes") or {}).items()
                      if val not in (None, "") and k not in ("warranty_onsite", "warranty_years", "cpu_tier"))
    body = "\n".join([
        f"Hello {o['vendor']} sales team,",
        "",
        f"We are planning to purchase {q} × {name} and would like a written quote.",
        "",
        f"Product: {o['name']}",
        *( [f"SKU: {o['sku']}"] if o.get("sku") else [] ),
        *( [f"Listing: {o['url']}"] if o.get("url") else [] ),
        f"Price seen on your website ({seen}): ${o['unit_price']:,.2f} per unit" if o.get("unit_price") else "Price: not shown on the listing",
        *( [f"Configuration: {specs}"] if specs else [] ),
        f"Quantity: {q}",
        "",
        "Could you please confirm:",
        *[f"{i}. {a}" for i, a in enumerate(asks, 1)],
        "",
        "Thank you,",
        (mission.decision or {}).get("approver") or "[Your name]",
        "[Company] · [Phone]",
    ])
    return {"subject": f"Quote request: {q} × {name}", "body": body, "vendor": o["vendor"]}
