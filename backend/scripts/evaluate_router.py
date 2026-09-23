"""Run the catalog router over the labeled dev set with an explicit API key.

Usage: uv run --project backend python backend/scripts/evaluate_router.py --model gpt-6-sol
Run again with --model gpt-6-luna to compare the same dev set.
"""

import argparse
import asyncio
import json
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


async def evaluate(model: str, *, router: LLMRouter | None = None) -> None:
    catalog = Catalog.load(DATA_DIR)
    if router is None:
        router = LLMRouter(catalog, Settings(data_dir=DATA_DIR, router_model=model))
    dev_path = DATA_DIR / "dev_utterances.json"
    utterances = json.loads(dev_path.read_text(encoding="utf-8"))["utterances"]
    predictions: dict[str, list[str]] = {}
    latencies_ms: list[float] = []

    for index, utterance in enumerate(utterances, start=1):
        started = time.perf_counter()
        decision = await router.route(utterance["text"], RouterContext.empty())
        if decision.routing_error is not None:
            raise RuntimeError(
                f"{model} evaluation aborted at {utterance['id']}: router error {decision.routing_error}"
            )
        latencies_ms.append((time.perf_counter() - started) * 1000)
        predictions[utterance["id"]] = [item.scenario_id for item in decision.scenarios]
        if index % 10 == 0 or index == len(utterances):
            print(f"{model}: {index}/{len(utterances)}", file=sys.stderr, flush=True)

    with tempfile.TemporaryDirectory(prefix="voice-router-eval-") as temporary_dir:
        predictions_path = Path(temporary_dir) / "predictions.json"
        predictions_path.write_text(json.dumps(predictions, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"Model: {model}")
        print(f"Median router latency: {statistics.median(latencies_ms):.0f} ms")
        subprocess.run(
            [sys.executable, str(DATA_DIR / "evaluate.py"), str(predictions_path), str(dev_path)],
            check=True,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", choices=("gpt-6-sol", "gpt-6-luna"), default="gpt-6-sol")
    args = parser.parse_args()
    if not os.environ.get("OPENAI_API_KEY"):
        print("OPENAI_API_KEY is required for live evaluation.", file=sys.stderr)
        return 2
    try:
        asyncio.run(evaluate(args.model))
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
