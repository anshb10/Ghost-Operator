"""Run the ML layer over the recorded fixtures offline (no TinyFish / Claude calls). Usage: python -m scripts.analyze_fixtures [domain] [objective]"""
import json
import sys

from backend import config, planner
from backend.ml import matching, normalize, pricing, warranty_risk
from backend.scoring import apply_constraints, compute_tco, rank

domain = sys.argv[1] if len(sys.argv) > 1 else "laptops"
objective = sys.argv[2] if len(sys.argv) > 2 else "50 business laptops, 16GB RAM, Windows 11 Pro, 3 year warranty, budget $75k"
domains = config.load_domains()
req = planner.plan_heuristic(objective, domains)
cfg = domains[domain]
offers = []
for v in cfg["vendors"]:
    p = config.REPLAY_DIR / domain / f"{v['key']}.json"
    if p.exists():
        offers += normalize.normalize_offers(v["name"], json.loads(p.read_text())["result"], cfg)
groups = matching.group_offers(offers)
info = pricing.price_offers(offers, cfg["price_features"])
for o in offers:
    warranty_risk.score_offer(o, 3)
apply_constraints(offers, req)
compute_tco(offers, req, cfg["risk_model"])
ranked = rank(offers)
print("req:", req.quantity, req.budget_total_usd, req.max_unit_price_usd, [(c.attribute, c.op, c.value, c.hard) for c in req.constraints])
print("price model:", info)
print("groups:", groups)
print("cross-vendor:", pricing.cross_vendor_deltas(ranked))
print("families:", json.dumps(matching.family_matches(ranked), indent=0)[:1500])
for o in ranked:
    print(f"{o.rank!s:>4} {o.score:5} {o.vendor:7} ${o.unit_price or 0:>8,.0f} fair ${o.fair_price or 0:>7,.0f} fit {o.fit_score:.2f} "
          f"risk {o.warranty_risk:.2f} {o.warranty.service:8} {o.attributes.get('cpu_tier')} {o.attributes.get('storage_gb')} "
          f"| {o.name[:40]} | {o.anomaly or ''} | {o.failed_constraints}")
