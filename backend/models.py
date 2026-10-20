from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


class Constraint(BaseModel):
    attribute: str = Field(description="Normalized attribute key, e.g. ram_gb, storage_gb, os, warranty_years")
    op: Literal[">=", "<=", "==", "contains"]
    value: str | float
    hard: bool = Field(description="True = must-have (filters out offers). False = preference (affects score).")
    weight: float = Field(default=1.0, description="Importance for soft constraints, 0-3")

    @field_validator("value", mode="before")
    @classmethod
    def _ints_are_floats(cls, v):
        return float(v) if isinstance(v, int) and not isinstance(v, bool) else v


class Requirements(BaseModel):
    domain: str = Field(description="One of the configured domain keys, e.g. laptops, lab_supplies")
    item: str = Field(description="Short noun phrase for what is being bought")
    quantity: int
    budget_total_usd: Optional[float] = None
    max_unit_price_usd: Optional[float] = None
    constraints: list[Constraint]
    deadline_days: Optional[int] = None
    notes: str = ""


class Warranty(BaseModel):
    raw: str = ""
    years: Optional[float] = None
    service: Literal["onsite", "depot", "mail_in", "carry_in", "unknown", "none"] = "unknown"


class Offer(BaseModel):
    id: str
    vendor: str
    name: str
    sku: str = ""
    unit_price: Optional[float] = None
    url: str = ""
    attributes: dict = {}
    warranty: Warranty = Warranty()
    seller: str = ""
    condition: Literal["new", "refurbished", "used", "unknown"] = "unknown"
    stock: str = ""
    evidence: dict = {}  # raw extracted fields from TinyFish, kept for the audit trail
    verification: dict = {}  # Fetch API second-source check (see verify.py)
    effective_unit_price: Optional[float] = None  # set when a promo price only covers part of the quantity

    # Filled by the ML layer
    group_id: Optional[str] = None
    passes_hard: bool = True
    failed_constraints: list[str] = []
    fit_score: float = 0.0
    warranty_risk: float = 0.0
    warranty_risk_reasons: list[str] = []
    fair_price: Optional[float] = None
    price_delta_pct: Optional[float] = None
    anomaly: Optional[str] = None
    price_flag: Optional[Literal["deal", "suspicious", "overpriced", "outlier"]] = None
    tco: Optional[float] = None
    tco_breakdown: dict = {}
    score: float = 0.0
    rank: Optional[int] = None
