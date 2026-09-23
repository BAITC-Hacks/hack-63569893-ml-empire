# Voice latency — 2026-09-23

## Decision

Deploy compact `gpt-6-sol` routing with `ROUTER_REASONING_EFFORT=none`, pooled TTS connections and immediate upstream PCM chunk forwarding. Keep all catalog rules and public routing fields. Do not promote Luna: its faster run dropped two secondary intents.

**Neither the 500 ms routing target nor the 1500 ms final-STT-to-first-audio target is demonstrated.** A timeout or a fallback is not a successful fast route.

## Live router comparison

The same 104 bundled synthetic utterances were evaluated against the real provider. Times include the complete validated router call, including retries. No provider/validation failures occurred in these final runs.

| Implementation | Concurrency | Primary correct | Full intent-set correct | p50 | p95 | First request | >500 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Original Sol, low | 3 | 104/104 | 103/104 | 2983 ms | 4234 ms | 3433 ms | 104/104 |
| Compact Luna, none | 3 | 104/104 | 102/104 | 1847 ms | 2701 ms | 2483 ms | 104/104 |
| Compact Sol, none | 2 | 104/104 | 104/104 | 2183 ms | 3103 ms | 2318 ms | 104/104 |

Original Sol missed the second intent in U083. Compact Luna missed the second intents in U086 and U090. Compact Sol matched every labeled intent set in this sample; this is not a guarantee on unseen conversations.

The original baseline used `LLMRouter` loaded from commit `d141057`, not the new router with `--effort low`. The original/Luna runs overlapped; compact Sol ran with a different concurrency. Network/provider load and scheduling are not controlled, so the observed difference is not a controlled percentage speedup. “First request” means first application request, not a guarantee of an empty provider prompt cache. Remaining-request p50/p95 values are included in the JSON artifacts.

- `2026-09-23-router-baseline.json`
- `2026-09-23-router-compact-luna.json`
- `2026-09-23-router-compact-sol.json`

Artifacts contain synthetic case IDs, predictions and timings only. To reproduce a current compact-router run, export the existing key without logging it and use:

```sh
uv run --project backend --env-file .env python backend/scripts/evaluate_router.py \
  --model gpt-6-sol --effort none --concurrency 1 \
  --continue-on-error --output /tmp/router-sol.json
```

## End-to-end measurement boundary

`latency_ms.post_stt_first_audio` starts after valid final STT text and ends after the first successful server WebSocket PCM send. A text turn starts at processing entry. It includes graph/routing and TTS startup, excludes recognition time, and is absent if TTS sends no audio. This is not physical sound at the browser speaker.

Before deployment, three real-provider text turns through the original backend measured:

| Synthetic request | Router | First TTS PCM | Text to first PCM |
| --- | ---: | ---: | ---: |
| Office RU | 3952 ms | 632 ms | 4603 ms |
| Office KK | 3089 ms | 721 ms | 3827 ms |
| Claim status RU | 4260 ms | 601 ms | 4876 ms |

These small sequential samples are smoke tests, not a p95 benchmark. Post-deployment measurements are recorded below after restarting the application.

## Verification

- Backend: 279 tests passed.
- Frontend: 165 tests passed; production build passed.
- Independent review: no blocking findings; public-schema compatibility, catalog preservation, TTS client ownership and failure accounting checked.
- TTS gated-stream regression test verifies first PCM is forwarded before upstream EOF without waiting for a 4096-byte application buffer.

## Remaining target gap

In these real-provider runs routing alone exceeds 1500 ms at the median. Removing TTS buffering cannot by itself meet either target. Further model/prompt/provider or pipeline changes require the same bilingual/multiple-intent quality gate; no hidden premium tier or speculative action execution was enabled.
