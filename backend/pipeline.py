"""Mission orchestration: plan -> parallel TinyFish agents -> ML analysis -> recommendation -> human approval."""
import asyncio
import json
import re
import logging
import time
import uuid
from datetime import datetime, timezone

from . import config, planner, tinyfish, verify
from .ml import matching, normalize, pricing, warranty_risk
from .models import Offer, Requirements
from .scoring import apply_constraints, compute_tco, rank

log = logging.getLogger("ghost.pipeline")
PRODUCTS_PER_VENDOR = 4


class Mission:
    def __init__(self, req: Requirements, vendors: list[dict], objective: str, planner_used: str):
        self.id = uuid.uuid4().hex[:8]
        self.created = datetime.now(timezone.utc).isoformat()
        self.objective = objective
        self.req = req
        self.vendors = vendors
        self.planner_used = planner_used
        self.mode = config.effective_mode()
        self.status = "browsing"
        self.agents = {v["key"]: {"vendor": v["name"], "url": v["url"], "status": "queued", "steps": [],
                                  "stream_url": None, "run_id": None, "n_offers": 0, "error": None}
                       for v in vendors}
        self.offers: list[Offer] = []
        self.report: dict | None = None
        self.decision: dict | None = None
        self.events: list[dict] = []
        self._cond = asyncio.Condition()

    async def emit(self, kind: str, **data):
        async with self._cond:
            self.events.append({"seq": len(self.events), "kind": kind, "t": time.time(), **data})
            self._cond.notify_all()

    async def wait_for(self, seq: int, timeout: float = 15.0) -> bool:
        async with self._cond:
            try:
                await asyncio.wait_for(self._cond.wait_for(lambda: len(self.events) > seq), timeout)
                return True
            except asyncio.TimeoutError:
                return False

    def snapshot(self) -> dict:
        return {"id": self.id, "objective": self.objective, "created": self.created, "mode": self.mode,
                "status": self.status, "planner": self.planner_used, "requirements": self.req.model_dump(),
                "agents": self.agents, "report": self.report, "decision": self.decision}


    def save(self) -> None:
        MISSIONS_DIR.mkdir(parents=True, exist_ok=True)
        (MISSIONS_DIR / f"{self.id}.json").write_text(json.dumps({**self.snapshot(), "vendors": self.vendors}))

    @classmethod
    def load(cls, mid: str) -> "Mission | None":
        path = MISSIONS_DIR / f"{mid}.json"
        if not mid.isalnum() or not path.exists():
            return None
        d = json.loads(path.read_text())
        m = cls(Requirements(**d["requirements"]), d["vendors"], d["objective"], d["planner"])
        m.id, m.created, m.mode, m.status = d["id"], d["created"], d["mode"], d["status"]
        m.agents, m.report, m.decision = d["agents"], d["report"], d["decision"]
        m.events = [{"seq": 0, "kind": "report", "t": time.time(), "status": m.status}] if m.report else []
        return m


MISSIONS_DIR = config.ROOT / "data" / "missions"
MISSIONS: dict[str, Mission] = {}


def get_mission(mid: str) -> "Mission | None":
    if mid not in MISSIONS:
        m = Mission.load(mid)
        if m:
            MISSIONS[mid] = m
    return MISSIONS.get(mid)


async def _run_agent(m: Mission, v: dict, domain_cfg: dict, sem: asyncio.Semaphore) -> list[Offer]:
    a = m.agents[v["key"]]
    goal = domain_cfg["goal_template"].format(item=m.req.item, criteria=planner.criteria_text(m.req),
                                              n=PRODUCTS_PER_VENDOR, hint=v.get("hint", ""))
    async with sem:
        a["status"] = "running"
        await m.emit("agent", vendor=v["key"], status="running", goal=goal)
        started, steps = time.time(), []
        stream = tinyfish.run_live(v["url"], goal) if m.mode == "live" else tinyfish.run_replay(m.req.domain, v["key"])
        try:
            async for ev in stream:
                if ev["type"] == "started":
                    a["run_id"] = ev["run_id"]
                elif ev["type"] == "stream":
                    a["stream_url"] = ev["url"]
                    await m.emit("agent", vendor=v["key"], status="running", stream_url=ev["url"])
                elif ev["type"] == "progress":
                    steps.append(ev["message"])
                    a["steps"].append(ev["message"])
                    await m.emit("agent_step", vendor=v["key"], message=ev["message"])
                elif ev["type"] == "complete":
                    offers = normalize.normalize_offers(v["name"], ev["result"], domain_cfg)
                    a.update(status="done", n_offers=len(offers))
                    if m.mode == "live":
                        tinyfish.record(m.req.domain, v["key"], steps, ev["result"], started,
                                        f"TinyFish run {a['run_id']} at {datetime.now(timezone.utc).isoformat()}")
                    await m.emit("agent", vendor=v["key"], status="done", n_offers=len(offers),
                                 seconds=round(time.time() - started))
                    return offers
                elif ev["type"] == "error":
                    raise RuntimeError(ev["message"])
            raise RuntimeError("agent ended without a result")
        except Exception as e:
            log.warning("agent %s failed: %s", v["key"], e)
            a.update(status="failed", error=str(e)[:300])
            await m.emit("agent", vendor=v["key"], status="failed", error=a["error"])
            return []


def pick_recommendation(ranked: list[Offer]) -> tuple[Offer | None, Offer | None]:
    """Recommend the best offer whose price was confirmed on the vendor's own page (Fetch API).
    If a higher-scoring offer couldn't be confirmed, return it as the 'value pick' to request a quote for."""
    eligible = [o for o in ranked if o.rank]
    if not eligible:
        return None, None
    unavailable = lambda o: bool(re.search(r"(?i)backorder|sold out|out of stock|unavailable", o.stock or ""))
    confirmed = [o for o in eligible if o.verification.get("status") == "verified" and not unavailable(o)]
    best = confirmed[0] if confirmed else eligible[0]
    value = eligible[0] if eligible[0] is not best else None
    return best, value


def _template_summary(req: Requirements, ranked: list[Offer], best: Offer | None, value: Offer | None) -> str:
    ok = [o for o in ranked if o.rank]
    if not ok:
        from collections import Counter
        reasons = Counter("unit price over budget" if f.startswith("unit price") else f.split(" (")[0]
                          for o in ranked for f in o.failed_constraints if not f.startswith("unverified"))
        why = "; ".join(f"{r} ({n} offers)" for r, n in reasons.most_common(2))
        return (f"No option met every must-have requirement. Most common blockers: {why or 'missing prices'}. "
                "Loosening that constraint or adding vendors may surface a viable choice.")
    unit = best.effective_unit_price or best.unit_price
    vs = best.verification.get("status")
    s = (f"Recommend {req.quantity} × {best.name} from {best.vendor} at ${unit:,.0f}/unit "
         f"(${unit * req.quantity:,.0f} purchase, ${best.tco:,.0f} estimated {req.quantity}-unit lifetime cost). ")
    if vs == "verified":
        s += "Price and specs were re-checked on the product page. "
    elif vs == "partial":
        s += "Specs were re-checked on the product page; confirm the price with a quote. "
    if value:
        vu = value.effective_unit_price or value.unit_price
        why = (f"its ${value.unit_price:,.0f} promo is capped at {value.verification['limit']['max_units']} units per order "
               f"(expected average ≈${vu:,.0f})" if value.verification.get("limit") and value.effective_unit_price
               else f"it is listed as {re.sub(r'(?i)^item ', '', value.stock).lower()}" if re.search(r"(?i)backorder|sold out", value.stock or "")
               else f"its price for {req.quantity} units couldn't be confirmed on the vendor's page")
        s += (f"{value.vendor}'s {value.name.split(' (')[0]} scores higher on paper, but {why}; "
              f"request a written quote before switching. ")
    runner = next((o for o in ok if o is not best and o is not value), None)
    if runner:
        r = runner
        s += (f"The runner-up is {r.name} from {r.vendor} at ${(r.effective_unit_price or r.unit_price):,.0f}/unit, "
              f"scoring {r.score:.0f} vs {best.score:.0f}"
              + (f", but it is {r.stock.lower()}. " if re.search(r"(?i)backorder|sold out", r.stock or "") else ". "))
    trapped = [o for o in ranked if o.verification.get("limit") and o.effective_unit_price and o is not value]
    if trapped:
        t = min(trapped, key=lambda o: o.unit_price)
        where = "a listing of the same model caps" if t.verification["limit"].get("inferred_from") else "its product page caps"
        s += (f"Note: {t.vendor}'s ${t.unit_price:,.0f} {t.name.split(' (')[0]} looks cheapest, but {where} that "
              f"promo at {t.verification['limit']['max_units']} units per order, so the expected average is "
              f"${t.effective_unit_price:,.0f}. ")
    if best.warranty_risk_reasons:
        s += f"Main risk: {best.warranty_risk_reasons[0][0].lower() + best.warranty_risk_reasons[0][1:]}. "
        if req.domain == "laptops" and (best.warranty.service != "onsite" or (best.warranty.years or 0) < 3):
            s += "Ask the vendor to quote a warranty extension or onsite upgrade before approving. "
    if best.anomaly:
        s += f"Pricing note: {best.anomaly}. "
    return s.strip()


async def run_mission(m: Mission) -> None:
    domain_cfg = config.load_domains()[m.req.domain]
    try:
        sem = asyncio.Semaphore(config.TINYFISH_CONCURRENCY if m.mode == "live" else 8)
        results = await asyncio.gather(*[_run_agent(m, v, domain_cfg, sem) for v in m.vendors])
        offers = [o for batch in results for o in batch]

        m.status = "analyzing"
        await m.emit("status", status="analyzing")
        await m.emit("ml", step="normalize", message=f"Normalized {len(offers)} offers from "
                     f"{sum(1 for r in results if r)} vendors into canonical specs")

        vsum = await verify.verify_offers(offers, m.req.domain, m.mode, m.req.quantity)
        await m.emit("verify", step="verify", message=f"TinyFish Fetch API re-read {vsum['pages_fetched']} product pages: "
                     f"{vsum['verified']} verified, {vsum['partial']} partly verified, {vsum['mismatch']} mismatched, {vsum['unverified']} unverifiable, "
                     f"{vsum['corrections']} correction(s) applied", summary=vsum)

        groups = matching.group_offers(offers)
        await m.emit("ml", step="match", message=f"Entity resolution (TF-IDF char n-grams + spec agreement): "
                     f"{len(groups)} product(s) found at multiple listings")

        price_info = pricing.price_offers(offers, domain_cfg["price_features"])
        n_anom = sum(1 for o in offers if o.anomaly)
        await m.emit("ml", step="price", message=f"Fair-price model ({price_info['method']}): {n_anom} anomaly flag(s)")

        target_years = next((float(c.value) for c in m.req.constraints if c.attribute == "warranty_years"),
                            domain_cfg["risk_model"]["lifetime_years"])
        for o in offers:
            warranty_risk.score_offer(o, target_years)
        await m.emit("ml", step="risk", message="Warranty risk: clause classifier (TF-IDF + logistic regression) "
                     "+ structured features (term, service type, condition, seller)")

        apply_constraints(offers, m.req)
        compute_tco(offers, m.req, domain_cfg["risk_model"])
        ranked = rank(offers)
        m.offers = ranked
        n_ok = sum(1 for o in ranked if o.rank)
        await m.emit("ml", step="rank", message=f"Ranked {n_ok} eligible offers by fit, TCO, risk and price sanity; "
                     f"{len(ranked) - n_ok} excluded")

        deltas = pricing.cross_vendor_deltas(ranked)
        families = matching.family_matches(ranked)
        insights = {"cross_vendor": deltas, "families": families, "price_model": price_info, "groups": groups,
                    "verification": vsum}
        best, value = pick_recommendation(ranked)
        top = [{k: v for k, v in o.model_dump().items() if k not in ("evidence",)} for o in ranked[:4]]
        top.insert(0, {"recommended_offer_id": best.id if best else None, "value_pick_needing_quote": value.id if value else None,
                       "rule": "recommend the best offer whose price was confirmed on the vendor page"})
        try:
            summary = await asyncio.to_thread(planner.summarize_with_claude, m.req, top,
                                            {"cross_vendor": deltas, "families": families[:3]})
            summary_by = "claude"
        except Exception as e:
            log.info("summary fallback: %s", e)
            summary, summary_by = _template_summary(m.req, ranked, best, value), "template"

        m.report = {
            "summary": summary, "summary_by": summary_by,
            "recommended_offer_id": best.id if best else None,
            "value_pick_id": value.id if value else None,
            "offers": [o.model_dump() for o in ranked],
            "insights": insights,
            "budget_ok": ((best.effective_unit_price or best.unit_price) * m.req.quantity <= m.req.budget_total_usd)
            if best and m.req.budget_total_usd else None,
        }
        m.status = "awaiting_approval"
        m.save()
        await m.emit("report", status=m.status)
    except Exception as e:
        log.exception("mission failed")
        m.status = "failed"
        await m.emit("status", status="failed", error=str(e))
