"""Objective -> structured Requirements (Claude), with a rule-based fallback so the demo never hard-fails."""
import json
import logging
import re

from . import config
from .models import Constraint, Requirements

log = logging.getLogger("ghost.planner")

_client = None


def _claude():
    global _client
    if _client is None:
        import anthropic
        _client = anthropic.Anthropic(timeout=90, max_retries=1)
    return _client


def _domain_brief(domains: dict) -> str:
    return json.dumps({k: {"label": d["label"], "attributes": list(d["attributes"]) + ["warranty_years", "warranty_onsite"],
                           "default_constraints": d["default_constraints"]} for k, d in domains.items()}, indent=1)


def plan_with_claude(objective: str, domains: dict) -> Requirements:
    system = (
        "You are the planning module of an autonomous procurement agent. Convert the buyer's objective into "
        "a Requirements object. Pick the closest domain. Start from that domain's default_constraints and adjust "
        "them to what the buyer actually said: add, tighten, loosen, or mark hard/soft. Only use attribute keys "
        "listed for the domain. If the buyer gives a total budget, also set max_unit_price_usd = budget/quantity. "
        "Put anything you could not encode as constraints into notes.\n\nDomains:\n" + _domain_brief(domains)
    )
    resp = _claude().messages.parse(
        model=config.ANTHROPIC_MODEL,
        max_tokens=16000,
        system=system,
        messages=[{"role": "user", "content": objective}],
        output_format=Requirements,
    )
    if resp.stop_reason == "refusal" or resp.parsed_output is None:
        raise RuntimeError(f"planner returned no output (stop_reason={resp.stop_reason})")
    req = resp.parsed_output
    if req.domain not in domains:
        raise RuntimeError(f"planner chose unknown domain {req.domain!r}")
    return req


def plan_heuristic(objective: str, domains: dict) -> Requirements:
    s = objective.lower()
    domain = max(domains, key=lambda k: sum(w in s for w in domains[k]["keywords"]))
    d = domains[domain]
    cons = [Constraint(**c) for c in d["default_constraints"]]

    def set_c(attr, op, val, hard):
        for c in cons:
            if c.attribute == attr:
                c.op, c.value, c.hard = op, val, hard
                return
        cons.append(Constraint(attribute=attr, op=op, value=val, hard=hard, weight=1.5))

    qty = re.search(r"(\d[\d,]*)\s+(?:x\s+)?(?:new\s+)?(?:\w+\s+){0,2}?(?:" + "|".join(d["keywords"]) + r"|cases?|boxes|units)", s)
    quantity = int(qty.group(1).replace(",", "")) if qty else 10
    budget = re.search(r"(?:budget|under|max(?:imum)?|up to)[^\d$]{0,15}\$?\s*([\d,.]+)\s*(k)?", s)
    budget_total = None
    if budget:
        budget_total = float(budget.group(1).replace(",", "")) * (1000 if budget.group(2) else 1)
    m = re.search(r"(\d+)\s*gb\s*(?:of\s*)?ram", s) or re.search(r"(\d+)\s*gb", s)
    if m and domain == "laptops":
        set_c("ram_gb", ">=", float(m.group(1)), True)
    m = re.search(r"(\d+)\s*(?:tb|gb)\s*(?:ssd|storage)", s)
    if m and domain == "laptops":
        v = float(m.group(1)) * (1024 if "tb" in m.group(0) else 1)
        set_c("storage_gb", ">=", v, False)
    m = re.search(r"(\d+)[\s-]*year", s)
    if m:
        set_c("warranty_years", ">=", float(m.group(1)), "must" in s or "require" in s)
    if "onsite" in s or "on-site" in s:
        set_c("warranty_onsite", "==", 1.0, "must" in s)
    item = d["label"].split(":")[-1].strip().lower()
    return Requirements(
        domain=domain, item=item, quantity=quantity, budget_total_usd=budget_total,
        max_unit_price_usd=round(budget_total / quantity, 2) if budget_total else None,
        constraints=cons, notes="Parsed with rule-based fallback planner (no Claude credentials found).",
    )


def plan(objective: str, domains: dict) -> tuple[Requirements, str]:
    try:
        return plan_with_claude(objective, domains), f"claude ({config.ANTHROPIC_MODEL})"
    except Exception as e:  # missing credentials, network, refusal: fall back, never block the demo
        log.warning("Claude planner unavailable, using heuristic: %s", e)
        return plan_heuristic(objective, domains), "rule-based fallback"


def criteria_text(req: Requirements) -> str:
    parts = []
    for c in req.constraints:
        if c.attribute in ("warranty_onsite",):
            parts.append("onsite warranty preferred")
            continue
        parts.append(f"{c.attribute.replace('_', ' ')} {c.op} {c.value}" + ("" if c.hard else " (preferred)"))
    if req.max_unit_price_usd:
        parts.append(f"price <= ${req.max_unit_price_usd:,.0f} per unit")
    return "; ".join(parts)


def summarize_with_claude(req: Requirements, top: list[dict], insights: dict) -> str:
    prompt = (
        "Write a 4-6 sentence procurement recommendation memo for a small-business owner. Lead with the "
        "recommended option, quantity and total cost. Explain the trade-off versus the runner-up, call out "
        "the most important warranty or pricing risk, and say what to verify before approving. Plain prose, "
        "no headings, no bullet points.\n\n"
        f"Requirements: {req.model_dump_json()}\n\nRanked options: {json.dumps(top)}\n\nInsights: {json.dumps(insights)}"
    )
    resp = _claude().messages.create(
        model=config.ANTHROPIC_MODEL, max_tokens=16000,
        output_config={"effort": "low"},
        messages=[{"role": "user", "content": prompt}],
    )
    if resp.stop_reason == "refusal":
        raise RuntimeError("summary refused")
    return "".join(b.text for b in resp.content if b.type == "text").strip()
