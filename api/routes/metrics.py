"""FastAPI adapter for the greenhouse MetricFlow service."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from api.services.metricflow import (
    MetricFlowError,
    MetricFlowValidationError,
    MetricQuery,
    list_dimensions,
    list_metrics,
    query_metrics,
)

router = APIRouter(prefix="/api/metrics", tags=["metrics"])


class MetricQueryBody(BaseModel):
    metrics: list[str] = Field(min_length=1, max_length=5)
    group_by: list[str] = Field(default_factory=list, max_length=5)
    start_time: str
    end_time: str
    limit: int = Field(default=100, ge=1, le=500)
    order_by: list[str] = Field(default_factory=list)


def _raise_http(exc: MetricFlowError) -> None:
    if isinstance(exc, MetricFlowValidationError):
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    raise HTTPException(status_code=503, detail="MetricFlow temporarily unavailable; check API logs") from exc


@router.get("")
def metrics_catalog():
    try:
        return {"metrics": list_metrics()}
    except MetricFlowError as exc:
        _raise_http(exc)


@router.get("/{metric_name}/dimensions")
def metric_dimensions(metric_name: str):
    try:
        return {"metric": metric_name, "dimensions": list_dimensions([metric_name])}
    except MetricFlowError as exc:
        _raise_http(exc)


@router.post("/query")
def metrics_query(body: MetricQueryBody):
    try:
        return query_metrics(MetricQuery(**body.model_dump()))
    except MetricFlowError as exc:
        _raise_http(exc)
