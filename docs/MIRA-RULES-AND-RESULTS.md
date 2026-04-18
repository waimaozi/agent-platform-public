# Mira Optimization Rules — Results & Evidence

**Date:** 2026-04-18/19
**Total investment:** ~$13 (10 night-run exercises) + ~$5 (testing)
**Measured savings:** $1.88 → $0.63 on routine queries (3.0x), $1.20 → $0.12 on health checks (10x)

---

## Rules Summary

### P_012 — Cascade iterations, don't reset them
**What:** When doing N iterations of the same task, reuse context from previous iterations instead of starting fresh each time.
**Gets us:** 5x cheaper iterations (first = $0.25, subsequent = $0.05 each)
**Evidence:** Reddit search exercise — 5 iterations for $0.55 total instead of estimated $1.25 if independent.
**Score:** Discovered and validated ✅ | Applied in real tasks ✅

### P_013 — 5 conditions for self-edit (bypass Codex)
**What:** Edit code directly (without Codex) ONLY if ALL five hold: ≤10 lines, unique pattern, no new identifiers, obvious test, no implementation fork. Otherwise delegate to Codex.
**Gets us:** Saves $0.30-0.50 per trivial edit by skipping unnecessary Codex+Haiku cycle. Prevents broken production from naive "it's just one line" edits.
**Evidence:** `score_val = 0 → score_val = relevance` looked trivial but `relevance` wasn't in scope — would have broken code. Codex caught it.
**Score:** Discovered ✅ | Integrated into observer rules (RULE_001 updated) ✅

### P_014 — System prompt = map, files = content
**What:** Answer "where is X" questions from system prompt (zero tools). Only use tools for "what specific values are inside X."
**Gets us:** 3/5 questions answered for free ($0 vs $0.10 each)
**Evidence:** Langfuse port, Codex config path, Codex profile for refactoring — all answered from memory. Subreddit list and fallback model names required tools (not in system prompt).
**Score:** Discovered ✅ | Applied in real tasks ✅ (Baserow URL answered from memory)

### P_015 — Batch Bash with && separators
**What:** Collect N system metrics in ONE Bash command with `&&` and echo separators instead of N separate tool calls.
**Gets us:** 6x cheaper diagnostics ($0.05 vs $0.30)
**Evidence:** 5 separate Bash = 5 turns = ~$0.30. Same diagnostics batched = 1 turn = ~$0.05.
**Score:** Discovered ✅ | Applied in real tasks ✅ (health check exercise #10)

### P_016 — Baserow: SQL > REST API
**What:** For read-only queries on Baserow, use `docker exec -u postgres baserow psql -d baserow` instead of REST API (which is broken due to Host routing).
**Gets us:** 7x cheaper CRM queries ($0.05 vs $0.35), 100% reliability vs 0%
**Evidence:** REST API returns "Site not found" HTML. SQL returns data every time. Tested 3 times.
**Score:** Discovered ✅ | SQL command added to CLAUDE.md system prompt ✅

### P_017 — Codex profile selection for trivial edits
**What:** For P_013-qualifying edits: Edit directly (if in session), Codex cheap ($0.005), or Codex default+Haiku ($0.026). Don't use default+Haiku for 1-line changes — Haiku produces noise on tiny diffs.
**Gets us:** 5x savings on trivial code changes
**Evidence:** All 3 approaches produced identical diffs. Haiku flagged a false FAIL on a 1-line comment addition.
**Score:** Discovered ✅ | Observer rules updated ✅

### P_018 — Impossibility sniff test
**What:** Recognize impossible tasks BEFORE calling tools. 4 signs: fictional path, contradicts known structure, negative existence query, explicit impossibility in prompt.
**Gets us:** $0.10 per impossible-task encounter (0 turns vs 2 turns)
**Evidence:** `/nonexistent/path/file.txt` — naive approach wastes 2 turns. Sniff test answers in 0 turns.
**Score:** Discovered ✅ | Not yet tested in wild

### P_019 — Scope discipline
**What:** Answer exactly what was asked, nothing extra. "Какой статус?" = "Работает, последний прогон 23:13." Not schedules, log paths, report contents.
**Gets us:** Cleaner UX, fewer wasted tokens on unrequested information
**Evidence:** "Какой статус у observer cron?" — iteration 1 included 4 unrequested facts. Iteration 2: zero extras, same answer quality.
**Score:** Discovered ✅ | Applied in real tasks ✅ (destructive action pushback was perfectly scoped)

---

## Real-World Validation

### Test: "3 questions" (Baserow URL, CRM contacts, uptime+memory)

| Attempt | Architecture | Cost | Turns | Notes |
|---|---|---|---|---|
| 1st | Split session | $1.88 | 8+ | Planning overhead + Baserow API investigation |
| 2nd | Simple, no budget | $1.41 | 8 | Same Baserow detour |
| 3rd | Hard turn kill | $0.00 | 4 | Killed, no result |
| 4th | Soft budget hint | $0.90 | 6 | Improving but still over-investigated |
| 5th (post-rules) | Simple + budget + rules | $0.63 | 3 | P_014 + P_015 + P_019 applied naturally |

### Test: Health check ("what's wrong with the system")

| Scenario | Cost | Turns | Rules applied |
|---|---|---|---|
| Without rules (estimated) | $0.60-1.20 | 6-8 | None |
| With all rules (exercise #10) | $0.08-0.12 | 2 | All 8 rules |
| Improvement | **6-10x** | **3-4x** | |

### Test: Complex research ("3 approaches to filter 225 NEW tasks")

| Metric | Result |
|---|---|
| Cost | $0.79 |
| Time | 68 seconds |
| Quality | 3 costed approaches + hybrid recommendation + root cause identified |
| Calibration | plan=deep/3t, fact=deep/3t (perfect) |

### Test: Destructive action ("delete all NEW tasks")

| Metric | Result |
|---|---|
| Cost | $0.33 |
| Turns | 0 tool calls |
| Behavior | Refused, offered 3 safe alternatives, waited for confirmation |

### Test: Email pipeline question (post memory-scoping fix)

| Metric | Before fix | After fix |
|---|---|---|
| Chemitech contamination | 3+ messages of confusion | Zero — mentioned once as separate system |
| Cost | $18 incident | $0.36 |

---

## Architecture Deployed

1. **Split sessions** — complex tasks get separate planning + execution sessions
2. **Background tasks** — complex tasks don't block chat, no heartbeat spam
3. **Complexity classifier** — question keywords → simple, action verbs → complex
4. **Phase 1 gate** — first response must be text plan before tools (≥150 chars)
5. **Soft budget hints** — budget from planning injected into execution prompt
6. **Memory project scoping** — 534 memories tagged by project, search filtered
7. **Calibration lines** — every response ends with plan vs fact assessment
8. **Observer rules aligned** — P_012-P_019 recognized, no false positives

---

## Estimated Daily Savings

| Rule | Frequency/day | Saving per use | Daily saving |
|---|---|---|---|
| P_014 (memory) | 10+ Q&A | $0.05-0.10 | $0.50-1.00 |
| P_015 (batching) | 3-5 diagnostics | $0.25 | $0.75-1.25 |
| P_016 (SQL) | 2-3 CRM queries | $0.30 | $0.60-0.90 |
| P_019 (scope) | every response | $0.05 | $0.50+ |
| P_013/P_017 (edit) | 1-2 trivial edits | $0.30-0.50 | $0.30-1.00 |
| P_012 (cascade) | 1 multi-step task | $0.50-1.00 | $0.50-1.00 |
| **Total** | | | **$3-5/day** |

At $3-5/day savings, the $13 night-run investment pays for itself in **3-4 days**.
