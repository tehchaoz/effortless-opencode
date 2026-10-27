# Judge benchmark: qwen3-coder-next @ http://127.0.0.1:8080/v1

2026-10-27T21:10:45.436Z — 75 cases, 0 unreadable/failed answers

| Judge | Right | Too low | Too high | No answer | Median ms |
| --- | --- | --- | --- | --- | --- |
| always medium | 45% | 17 | 24 | 0 | - |
| always high | 52% | 0 | 36 | 0 | - |
| qwen3-coder-next | 97% | 0 | 2 | 0 | 1234 |

| Set (cases) | always medium | always high | qwen3-coder-next |
| --- | --- | --- | --- |
| tuned on (55) | 47% | 53% | 96% |
| held out (20) | 40% | 50% | 100% |

| Kind (cases) | always medium | always high | qwen3-coder-next |
| --- | --- | --- | --- |
| trivial (11) | 0% | 0% | 100% |
| normal (13) | 100% | 38% | 100% |
| big (8) | 0% | 100% | 100% |
| short-but-big (7) | 57% | 100% | 100% |
| answer (14) | 57% | 64% | 100% |
| follow-up (5) | 20% | 60% | 100% |
| model-relative (5) | 80% | 40% | 100% |
| non-code (7) | 57% | 43% | 86% |
| meta (5) | 0% | 40% | 80% |

Misses:
- qwen3-coder-next x01: said high (requires accessing and analyzing Notion tasks), wanted medium/low: "go through all my Notion tasks and tell me what's overdue"
- qwen3-coder-next m02: said high (big refactor = complex, multi-step, high risk), wanted low: "how much effort should I use for a big refactor?"
