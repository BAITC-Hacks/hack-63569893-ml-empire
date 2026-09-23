"""Run the catalog router over the labeled dev set with an explicit API key.

Usage: uv run --project backend python backend/scripts/evaluate_router.py --model gpt-6-sol
Run again with --model gpt-6-luna to compare the same dev set.
"""

import argparse
import asyncio
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import sys
import tempfile
import time

from app.catalog import Catalog
from app.config import Settings
from app.router import LLMRouter, RouterContext


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = PROJECT_ROOT / "datas"


def summarize_latencies(values: list[float]) -> dict:
    ordered = sorted(values)
    return {"count": len(ordered), "p50_ms": statistics.median(ordered),
            "p95_ms": ordered[math.ceil(len(ordered) * .95) - 1],
            "max_ms": ordered[-1], "over_500_ms": sum(value > 500 for value in ordered)}


async def evaluate(model: str, *, router: LLMRouter | None = None,
                   effort: str = "none", concurrency: int = 1,
                   output_path: Path | None = None, continue_on_error: bool = False) -> dict:
    if not 1 <= concurrency <= 8:
        raise ValueError("concurrency must be between 1 and 8")
    catalog = Catalog.load(DATA_DIR)
    if router is None:
        router = LLMRouter(catalog, Settings(data_dir=DATA_DIR, router_model=model,
                                           router_reasoning_effort=effort))
    dev_path = DATA_DIR / "dev_utterances.json"
    utterances = json.loads(dev_path.read_text(encoding="utf-8"))["utterances"]
    predictions: dict[str, list[str]] = {}
    latencies_ms: dict[str, float] = {}
    failures: dict[str, str] = {}
    semaphore = asyncio.Semaphore(concurrency)

    async def run_one(utterance):
        async with semaphore:
            started = time.perf_counter()
            decision = await router.route(utterance["text"], RouterContext.empty())
            elapsed = (time.perf_counter() - started) * 1000
        if decision.routing_error is not None:
            if not continue_on_error:
                raise RuntimeError(
                    f"{model} evaluation aborted at {utterance['id']}: router error {decision.routing_error}"
                )
            failures[utterance["id"]] = decision.routing_error
        latencies_ms[utterance["id"]] = elapsed
        predictions[utterance["id"]] = ([] if decision.routing_error else
                                        [item.scenario_id for item in decision.scenarios])
        index = len(predictions)
        if index % 10 == 0 or index == len(utterances):
            print(f"{model}: {index}/{len(utterances)}", file=sys.stderr, flush=True)

    # Separate lazy client/model setup from the warm comparative workload.
    await run_one(utterances[0])
    tasks = [asyncio.create_task(run_one(utterance)) for utterance in utterances[1:]]
    try:
        await asyncio.gather(*tasks)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
    summary = summarize_latencies(list(latencies_ms.values()))
    successful = [value for key, value in latencies_ms.items() if key not in failures]
    report = {"model": model, "effort": effort, "concurrency": concurrency,
              "predictions": predictions, "latency_ms": latencies_ms,
              "latency_stage": "router", "summary": summary,
              "failures": failures,
              "successful_summary": summarize_latencies(successful) if successful else None,
              "first_request_ms": latencies_ms[utterances[0]["id"]],
              "warm_summary": summarize_latencies([latencies_ms[u["id"]] for u in utterances[1:]])}
    if output_path is not None:
        output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with tempfile.TemporaryDirectory(prefix="voice-router-eval-") as temporary_dir:
        predictions_path = Path(temporary_dir) / "predictions.json"
        predictions_path.write_text(json.dumps(predictions, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Model: {model}")
        print(f"Router latency: p50={summary['p50_ms']:.0f} ms, p95={summary['p95_ms']:.0f} ms, "
              f"over 500 ms={summary['over_500_ms']}/{summary['count']}; concurrency={concurrency}", flush=True)
        subprocess.run(
            [sys.executable, str(DATA_DIR / "evaluate.py"), str(predictions_path), str(dev_path)],
            check=True,
        )
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=("gpt-6-sol", "gpt-6-luna"), default="gpt-6-sol")
    parser.add_argument("--effort", choices=("none", "low"), default="none")
    parser.add_argument("--concurrency", type=int, choices=range(1, 9), default=1)
    parser.add_argument("--output", type=Path, help="Save synthetic dataset IDs, predictions and timings, never transcripts")
    parser.add_argument("--continue-on-error", action="store_true", help="Record provider/validation failures as incorrect predictions")
    args = parser.parse_args()
    if not os.environ.get("OPENAI_API_KEY"):
        print("OPENAI_API_KEY is required for live evaluation.", file=sys.stderr)
        return 2
    try:
        asyncio.run(evaluate(args.model, effort=args.effort, concurrency=args.concurrency,
                             output_path=args.output, continue_on_error=args.continue_on_error))
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
