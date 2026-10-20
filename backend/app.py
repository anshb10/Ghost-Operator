import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Literal, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import config, discovery, planner
from .exports import offers_csv, quote_request
from .models import Offer, Requirements
from .pipeline import MISSIONS, MISSIONS_DIR, Mission, get_mission, pick_recommendation, run_mission
from .purchase_order import render_po
from .scoring import WEIGHTS, normalize_weights, rank

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
app = FastAPI(title="Ghost Operator")
_tasks: set[asyncio.Task] = set()


class PlanIn(BaseModel):
    objective: str


class VendorIn(BaseModel):
    key: str = Field(pattern=r"^[a-z0-9]{1,40}$")
    name: str = Field(max_length=80)
    url: str = Field(pattern=r"^https://[^\s]{4,500}$")
    hint: str = ""
    discovered: bool = True


class MissionIn(BaseModel):
    objective: str
    requirements: Requirements
    vendor_keys: list[str]
    extra_vendors: list[VendorIn] = []
    planner: str = "user-edited"


class DecisionIn(BaseModel):
    decision: Literal["approve", "reject"]
    offer_id: Optional[str] = None
    approver: str = Field(default="", max_length=120)
    note: str = Field(default="", max_length=1000)
    weights: Optional[dict[str, float]] = None  # what-if weights in effect when the buyer decided


class RerankIn(BaseModel):
    weights: dict[str, float]


@app.get("/api/info")
def info():
    domains = config.load_domains()
    return {"mode": config.effective_mode(), "concurrency": config.TINYFISH_CONCURRENCY,
            "model": config.ANTHROPIC_MODEL,
            "weights": WEIGHTS,
            "domains": {k: {"label": d["label"], "vendors": d["vendors"]} for k, d in domains.items()}}


@app.post("/api/plan")
async def plan(body: PlanIn):
    domains = config.load_domains()
    req, used = await asyncio.to_thread(planner.plan, body.objective, domains)
    known = [dict(v) for v in domains[req.domain]["vendors"]]
    found = await discovery.discover(req, known, config.effective_mode())
    for v in known + found["vendors"]:  # in replay mode only vendors with a recorded agent run can be dispatched
        v["recorded"] = config.effective_mode() == "live" or (config.REPLAY_DIR / req.domain / f"{v['key']}.json").exists()
    return {"requirements": req.model_dump(), "planner": used, "vendors": known, "discovery": found}


@app.post("/api/missions")
async def create_mission(body: MissionIn):
    domains = config.load_domains()
    if body.requirements.domain not in domains:
        raise HTTPException(400, "unknown domain")
    vendors = [v for v in domains[body.requirements.domain]["vendors"] if v["key"] in body.vendor_keys]
    known = {v["key"] for v in vendors}
    vendors += [v.model_dump() for v in body.extra_vendors if v.key not in known][:4]
    if not vendors:
        raise HTTPException(400, "pick at least one vendor")
    m = Mission(body.requirements, vendors, body.objective, body.planner)
    MISSIONS[m.id] = m
    t = asyncio.create_task(run_mission(m))
    _tasks.add(t)
    t.add_done_callback(_tasks.discard)
    return {"id": m.id}


def _brief(d: dict) -> dict:
    rep, dec, req = d.get("report") or {}, d.get("decision") or {}, d["requirements"]
    pick_id = dec.get("offer_id") or rep.get("recommended_offer_id")
    o = next((x for x in rep.get("offers", []) if x["id"] == pick_id), None)
    unit = o and (o.get("effective_unit_price") or o.get("unit_price"))
    return {"id": d["id"], "created": d["created"], "objective": d["objective"], "status": d["status"], "mode": d["mode"],
            "domain": req["domain"], "item": req["item"], "quantity": req["quantity"],
            "budget_total_usd": req.get("budget_total_usd"), "n_offers": len(rep.get("offers", [])),
            "pick": {"name": o["name"], "vendor": o["vendor"], "url": o.get("url", ""),
                     "total": round(unit * req["quantity"], 2) if unit else None} if o else None,
            "approver": dec.get("approver") or None}


@app.get("/api/missions")
def list_missions(limit: int = 50):
    """Saved missions (data/missions/) plus any still running in memory, newest first."""
    seen: dict[str, dict] = {}
    for path in MISSIONS_DIR.glob("*.json") if MISSIONS_DIR.exists() else []:
        try:
            d = json.loads(path.read_text())
            seen[d["id"]] = _brief(d)
        except (ValueError, KeyError, TypeError):
            continue
    for mid, m in MISSIONS.items():
        seen[mid] = _brief(m.snapshot())
    return sorted(seen.values(), key=lambda b: b["created"], reverse=True)[:max(1, min(limit, 200))]


def _get(mid: str) -> Mission:
    m = get_mission(mid)
    if not m:
        raise HTTPException(404, "mission not found")
    return m


@app.get("/api/missions/{mid}")
def mission_detail(mid: str):
    return _get(mid).snapshot()


@app.get("/api/missions/{mid}/events")
async def events(mid: str, since: int = 0):
    m = _get(mid)

    async def gen():
        seq = since
        while True:
            while seq < len(m.events):
                yield f"data: {json.dumps(m.events[seq])}\n\n"
                seq += 1
            if m.status in ("awaiting_approval", "approved", "rejected", "failed") and seq >= len(m.events):
                yield "event: end\ndata: {}\n\n"
                return
            if not await m.wait_for(seq):
                yield ": keepalive\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.post("/api/missions/{mid}/decision")
def decide(mid: str, body: DecisionIn):
    m = _get(mid)
    if not m.report:
        raise HTTPException(409, "mission has no recommendation yet")
    ids = {o["id"] for o in m.report["offers"]}
    offer_id = body.offer_id or m.report["recommended_offer_id"]
    if offer_id not in ids:
        raise HTTPException(400, "unknown offer")
    if body.decision == "approve" and not next(o for o in m.report["offers"] if o["id"] == offer_id).get("rank"):
        raise HTTPException(400, "that offer failed a must-have requirement and can't be approved")
    m.decision = {**body.model_dump(), "offer_id": offer_id, "at": datetime.now(timezone.utc).isoformat()}
    if body.weights:
        m.decision["weights"] = normalize_weights(body.weights)
    m.status = "approved" if body.decision == "approve" else "rejected"
    m.save()
    return m.snapshot()


@app.post("/api/missions/{mid}/rerank")
def rerank(mid: str, body: RerankIn):
    """What-if: re-score the mission's offers under different weights. Nothing is saved."""
    m = _get(mid)
    if not m.report:
        raise HTTPException(409, "mission has no recommendation yet")
    ranked = rank([Offer(**o) for o in m.report["offers"]], body.weights)
    best, value = pick_recommendation(ranked)
    return {"weights": normalize_weights(body.weights), "default_weights": WEIGHTS,
            "recommended_offer_id": best.id if best else None, "value_pick_id": value.id if value else None,
            "offers": [{"id": o.id, "score": o.score, "rank": o.rank} for o in ranked]}


def _offer(m: Mission, offer_id: str) -> dict:
    o = next((x for x in (m.report or {}).get("offers", []) if x["id"] == offer_id), None)
    if not o:
        raise HTTPException(404, "offer not found")
    return o


@app.get("/api/missions/{mid}/offers.csv")
def export_csv(mid: str):
    m = _get(mid)
    if not m.report:
        raise HTTPException(409, "mission has no offers yet")
    return Response(offers_csv(m), media_type="text/csv",
                    headers={"Content-Disposition": f'attachment; filename="ghost-operator-{m.id}-offers.csv"'})


@app.get("/api/missions/{mid}/offers/{offer_id}/quote-request")
def quote(mid: str, offer_id: str):
    m = _get(mid)
    return quote_request(m, _offer(m, offer_id))


@app.get("/missions/{mid}/po", response_class=HTMLResponse)
def po(mid: str, offer: Optional[str] = None):
    m = _get(mid)
    if offer:
        _offer(m, offer)
    return render_po(m, offer)


app.mount("/", StaticFiles(directory=config.FRONTEND_DIR, html=True), name="frontend")
