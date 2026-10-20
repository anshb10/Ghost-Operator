"""Printable draft purchase order (browser 'Print → Save as PDF')."""
from datetime import date
from html import escape


def render_po(mission, preview_offer_id: str | None = None) -> str:
    rep = mission.report or {}
    offer_id = (mission.decision or {}).get("offer_id") or preview_offer_id or rep.get("recommended_offer_id")
    o = next((x for x in rep.get("offers", []) if x["id"] == offer_id), None)
    if not o:
        return "<p>No offer selected.</p>"
    req = mission.req
    approved = (mission.decision or {}).get("decision") == "approve"
    stamp = ("APPROVED by " + escape(mission.decision.get("approver") or "buyer") + " · " +
             escape(mission.decision.get("at", "")[:16].replace("T", " "))) if approved else "DRAFT — PENDING HUMAN APPROVAL"
    unit = o.get("effective_unit_price") or o["unit_price"]
    total = unit * req.quantity
    lim = (o.get("verification") or {}).get("limit")
    price_note = (f"<p class=\"muted\">Unit price is the expected average: the ${o['unit_price']:,.2f} promo is capped at "
                  f"{lim['max_units']} units per order, the rest are costed at list price. Request a quote to lock it in.</p>"
                  if o.get("effective_unit_price") and lim else "")
    override = ""
    if offer_id != rep.get("recommended_offer_id"):
        rec = next((x for x in rep.get("offers", []) if x["id"] == rep.get("recommended_offer_id")), None)
        note = ((mission.decision or {}).get("note") or "").strip()
        why = escape(note) if note else "<i>not yet given (required at approval)</i>"
        rec_label = f"{escape(rec['name'])} ({escape(rec['vendor'])})" if rec else "offer"
        override = ('<div style="border:1px solid #e7ddcc;border-left:4px solid #b0611c;background:#fcefdf;'
                    'padding:10px 14px;margin:14px 0">'
                    f"<b>Buyer override.</b> Chosen instead of the recommended {rec_label}."
                    f"<br><b>Reason:</b> {why}</div>")
    specs = "".join(f"<li>{escape(str(k))}: {escape(str(v))}</li>" for k, v in o["evidence"].items()
                    if k not in ("product_name", "price_usd", "product_page_url"))
    risks = "".join(f"<li>{escape(r)}</li>" for r in o["warranty_risk_reasons"]) or "<li>None flagged</li>"
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>PO-{mission.id}</title>
<style>
 body{{font:14px/1.55 "Helvetica Neue",Arial,sans-serif;max-width:800px;margin:40px auto;padding:32px 40px;color:#1d2740;background:#fffdf9;border:1px solid #e7ddcc}}
 html{{background:#faf6ef}} h1,h3{{font-family:Georgia,serif;font-weight:500}} h1{{font-size:26px;margin:0}} a{{color:#2b4c9b}}
 .muted{{color:#8a8172}} table{{width:100%;border-collapse:collapse;margin:16px 0}}
 td,th{{border-bottom:1px solid #e7ddcc;padding:8px;text-align:left}} th{{background:#faf6ef;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:#8a8172}}
 .stamp{{display:inline-block;padding:6px 10px;border:2px solid {'#2f6b4f' if approved else '#93561a'};
   color:{'#2f6b4f' if approved else '#93561a'};font-weight:700;letter-spacing:.04em;margin:12px 0}}
 .num{{text-align:right;font-variant-numeric:tabular-nums}} @media print{{button{{display:none}}}}
</style></head><body>
<button onclick="print()" style="float:right">Print / Save PDF</button>
<h1>Purchase Order PO-{mission.id.upper()}</h1>
<div class="muted">Prepared by Ghost Operator on {date.today().isoformat()}, mission {mission.id}</div>
<div class="stamp">{stamp}</div>
<p><b>Vendor:</b> {escape(o['vendor'])} (seller: {escape(o['seller'] or o['vendor'])})<br>
<b>Objective:</b> {escape(mission.objective)}</p>
<table><tr><th>Item</th><th>SKU</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Line total</th></tr>
<tr><td><a href="{escape(o['url'])}">{escape(o['name'])}</a></td><td>{escape(o['sku'] or '—')}</td>
<td class="num">{req.quantity}</td><td class="num">${unit:,.2f}</td><td class="num">${total:,.2f}</td></tr>
<tr><td colspan="4" class="num"><b>Subtotal (excl. tax &amp; shipping)</b></td><td class="num"><b>${total:,.2f}</b></td></tr></table>
{price_note}{override}<p><b>Warranty as listed:</b> {escape(o['warranty']['raw'] or 'not stated')}<br>
<b>Estimated {req.quantity}-unit TCO:</b> ${o['tco']:,.0f} (purchase ${o['tco_breakdown']['purchase']:,}, out-of-warranty repairs
${o['tco_breakdown']['out_of_warranty_repairs']:,}, downtime ${o['tco_breakdown']['downtime']:,})</p>
<h3>Specifications (as extracted from vendor site)</h3><ul>{specs}</ul>
<h3>Risks to resolve before sending</h3><ul>{risks}</ul>
<p class="muted">Prices were captured from the vendor's public website during the mission and may have changed.
Confirm the quote with the vendor before issuing. This document is not sent anywhere automatically.</p>
</body></html>"""
