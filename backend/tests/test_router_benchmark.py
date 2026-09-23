import json
import pytest

from app.router import RouterDecision, SelectedScenario
from scripts import evaluate_router


def test_latency_summary_reports_tail_and_all_budget_misses():
    summary = evaluate_router.summarize_latencies([100, 200, 300, 400, 500, 1000])
    assert summary == {"count": 6, "p50_ms": 350, "p95_ms": 1000, "max_ms": 1000,
                       "over_500_ms": 1}


@pytest.mark.asyncio
async def test_benchmark_artifact_contains_predictions_and_timings_without_transcripts(tmp_path):
    class Router:
        async def route(self, text, context):
            return RouterDecision(language="ru", scenarios=[SelectedScenario(
                scenario_id="SYS_UNCLEAR", reason="Need details", confidence_estimate=None)],
                alternatives=[], slots={}, is_continuation=False, needs_clarification=True)

    output = tmp_path / "result.json"
    report = await evaluate_router.evaluate("gpt-6-sol", router=Router(),
                                           output_path=output, concurrency=3)
    stored = json.loads(output.read_text())
    assert len(stored["predictions"]) == 104
    assert set(stored["predictions"]) == set(stored["latency_ms"])
    assert stored["latency_stage"] == "router"
    assert stored["concurrency"] == 3
    assert stored["summary"]["count"] == 104
    assert report == stored
    assert "text" not in stored and "transcript" not in stored


@pytest.mark.asyncio
async def test_continue_on_error_counts_failures_as_wrong_predictions(tmp_path):
    class Router:
        async def route(self, text, context):
            return RouterDecision(language="ru", scenarios=[SelectedScenario(
                scenario_id="SYS_UNCLEAR", reason="Fallback", confidence_estimate=None)],
                alternatives=[], slots={}, is_continuation=False, needs_clarification=True,
                routing_error="ValueError")

    report = await evaluate_router.evaluate("gpt-6-sol", router=Router(),
        output_path=tmp_path / "errors.json", concurrency=3, continue_on_error=True)
    assert len(report["failures"]) == 104
    assert all(ids == [] for ids in report["predictions"].values())
    assert report["successful_summary"] is None
