"""Constraint checking, total cost of ownership, and the final explainable ranking."""
from .models import Constraint, Offer, Requirements

DOWNTIME_COST = {"onsite": 40, "depot": 300, "carry_in": 250, "mail_in": 350, "unknown": 300, "none": 400}
ANOMALY_PENALTY = {"suspicious": 1.0, "overpriced": 0.6, "outlier": 0.4, "deal": 0.0}
TRUST = {"verified": 1.0, "partial": 0.8, "unverified": 0.6, "mismatch": 0.15}
WEIGHTS = {"fit": 0.35, "value": 0.30, "risk": 0.15, "anomaly": 0.10, "trust": 0.10}


def _check(c: Constraint, v) -> tuple[bool | None, float]:
    """Returns (passed, partial_credit). passed=None means the attribute couldn't be verified."""
    if v is None:
        return None, 0.0
    if c.op == "contains":
        ok = str(c.value).lower() in str(v).lower()
        return ok, 1.0 if ok else 0.0
    try:
        v, t = float(v), float(c.value)
    except (TypeError, ValueError):
        ok = str(v).lower() == str(c.value).lower()
        return ok, float(ok)
    if c.op == ">=":
        return v >= t, 1.0 if v >= t else max(0.0, v / t) if t else 0.0
    if c.op == "<=":
        return v <= t, 1.0 if v <= t else max(0.0, t / v) if v else 0.0
    return v == t, float(v == t)


def apply_constraints(offers: list[Offer], req: Requirements) -> None:
    for o in offers:
        fails, credit, total = [], 0.0, 0.0
        for c in req.constraints:
            passed, partial = _check(c, o.attributes.get(c.attribute))
            if c.hard:
                if passed is False:
                    fails.append(f"{c.attribute} {c.op} {c.value} (got {o.attributes.get(c.attribute)})")
                elif passed is None:
                    fails.append(f"unverified: {c.attribute}")
                    credit += 0.5 * c.weight
                    total += c.weight
                else:
                    credit += c.weight
                    total += c.weight
            else:
                total += c.weight
                credit += c.weight * partial
        if req.max_unit_price_usd and o.unit_price and o.unit_price > req.max_unit_price_usd:
            fails.append(f"unit price ${o.unit_price:,.0f} > max ${req.max_unit_price_usd:,.0f}")
        o.failed_constraints = fails
        o.passes_hard = not any(not f.startswith("unverified") for f in fails) and o.unit_price is not None
        o.fit_score = round(credit / total, 3) if total else 1.0


def compute_tco(offers: list[Offer], req: Requirements, risk_cfg: dict) -> None:
    afr, ratio, life = risk_cfg["annual_failure_rate"], risk_cfg["repair_cost_ratio"], risk_cfg["lifetime_years"]
    q = req.quantity
    for o in offers:
        if not o.unit_price:
            continue
        unit = o.effective_unit_price or o.unit_price
        covered = min(life, o.warranty.years or 0.0)
        uncovered = max(0.0, life - covered)
        purchase = unit * q
        repairs = q * afr * uncovered * unit * ratio
        downtime = q * afr * life * DOWNTIME_COST.get(o.warranty.service, 300) if req.domain == "laptops" else 0.0
        o.tco_breakdown = {"purchase": round(purchase), "out_of_warranty_repairs": round(repairs),
                           "downtime": round(downtime)}
        o.tco = round(purchase + repairs + downtime, 2)


def normalize_weights(weights: dict | None) -> dict:
    """Missing keys fall back to the defaults; the result always sums to 1."""
    w = {k: max(0.0, float((weights or {}).get(k, d))) for k, d in WEIGHTS.items()}
    total = sum(w.values())
    return {k: v / total for k, v in w.items()} if total else dict(WEIGHTS)


def rank(offers: list[Offer], weights: dict | None = None) -> list[Offer]:
    w = normalize_weights(weights)
    eligible = [o for o in offers if o.passes_hard and o.tco]
    if eligible:
        lo, hi = min(o.tco for o in eligible), max(o.tco for o in eligible)
        for o in eligible:
            value = 1.0 if hi == lo else 1 - (o.tco - lo) / (hi - lo)
            anomaly_pen = ANOMALY_PENALTY.get(o.price_flag, 0.0)
            o.score = round(100 * (w["fit"] * o.fit_score + w["value"] * value
                                   + w["risk"] * (1 - o.warranty_risk)
                                   + w["anomaly"] * (1 - anomaly_pen)
                                   + w["trust"] * TRUST.get(o.verification.get("status"), 0.6)), 1)
    ordered = sorted(eligible, key=lambda o: -o.score) + \
        sorted([o for o in offers if o not in eligible], key=lambda o: -o.fit_score)
    for i, o in enumerate(ordered):
        o.rank = i + 1 if o in eligible else None
    return ordered
