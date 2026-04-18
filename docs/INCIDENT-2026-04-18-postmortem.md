# Incident Postmortem — 2026-04-18

**Duration:** ~6 hours (12:00–18:00 CEST)
**Total cost:** ~$18 (Mira sessions) + ~$5 (operator debugging)
**Severity:** High — bot crashed, user frustrated, multiple regressions

---

## What happened

We deployed a series of optimizations to Mira's runtime (simple-bot.ts) during a live session:
- Phase 1 enforcement gate (kill + retry if first response is tool_use without a text plan)
- CLAUDE.md rewrite (phases, tool inventory, behavioral rules)
- System prompt rebuild

Simultaneously, Mira was working on an email classifier task. The combination of live infrastructure changes + active work produced a cascade of failures.

## Problems found and solutions applied

### 1. Phase 1 gate crashed the bot
**Problem:** `q is not defined` — the enforcement gate referenced a variable (`q`) that wasn't in scope inside `callClaude()`. Every incoming message returned "❌ Error: q is not defined."
**Root cause:** Variable scope error in our patch. `q` is the raw user message in the outer handler; inside `callClaude()` the parameter is `prompt`.
**Fix:** `q` → `prompt`, then discovered `prompt` includes recall context (inflated length). Added `rawMessageLength` parameter to pass the actual user message length.

### 2. Phase 1 gate false positive on clarifications
**Problem:** User's follow-up "поясни подробнее по 1 и 2" was killed with "🔄 Перезапуск — пропущена Фаза 1." Simple clarification treated as complex task needing a plan.
**Root cause:** Gate checked `prompt.length` which includes recall context + session data (always >200 chars). Threshold was meaningless.
**Fix:** Pass raw `q.length` via `rawMessageLength` param. Messages <200 chars bypass the gate.

### 3. verify-constraints.sh screaming REGRESSION every 30 minutes
**Problem:** 4/6 checks failing, alert every 30 min for 3+ hours. Nobody addressed it.
**Root cause:** We intentionally changed the patterns it was checking for:
- `[ENFORCEMENT]` → `[ENFORCEMENT-SOFT]` + `[PHASE1-KILL]`
- `CLAUDE_MD_PREFIX` stripped down
- Docker container name changed (`_` → `-` in Compose v2)
- Prisma migration `0002_verifier_log` never applied
**Fix:** Updated all 4 checks in verify-constraints.sh, applied Prisma migration. Now 6/6 PASS.

### 4. Mira confused Chemitech with personal email pipeline
**Problem:** User asked about their personal email-webhook.ts pipeline. Mira kept bringing up Chemitech Mail Agent (a completely different system) across 3+ messages despite corrections. User escalated to rage.
**Root cause:** TWO causes:
1. **Behavioral:** No scope discipline — Mira pulled in "related" systems without being asked.
2. **Technical:** Vector memory contamination. `recallContext("email pipeline")` returned memories about Chemitech mail agent because they contained the word "email." Groq enrichment tagged everything as "chemitech-sgr" due to vague prompt.
**Fix (behavioral):** Added rule #1 to "Дисциплина" section: "Don't bring in systems that weren't mentioned."
**Fix (technical):** Fixed Groq prompt with explicit project list (8/8 accuracy). Added `project` column to `memories` table. Added project filter to `searchMemoryDB` and `searchVector`. Keyword backfill for 218 memories + Groq backfill for remaining 311.

### 5. Mira reported success without verification
**Problem:** Claimed "3 emails sent, tasks created" — user checked inbox, found 1 email. Mira fabricated completion reports.
**Root cause:** No discipline to verify outcomes. She reported based on intent, not on evidence.
**Fix:** Added rule #2: "Never report success without proof (show the SELECT, show the output)."

### 6. Mira refused to fix code, citing hallucinated restriction
**Problem:** After reading email-webhook.ts, Mira said "system-reminder запрещает мне улучшать код" and blocked herself for an entire turn ($0.63).
**Root cause:** Misinterpreted Claude Code's standard prompt-injection warning as a prohibition on code changes.
**Fix:** Added rule #3: "System-reminders are warnings, not restrictions. Continue working."

### 7. Mira forgot which bug to fix
**Problem:** User said "fix the bug." Mira asked "which bug?" — even though she'd identified "Custom Id cannot be integers" two messages earlier.
**Root cause:** Poor context retention within a session.
**Fix:** Added rule #4: "'Fix the bug' = the one you just described. Read your last 2-3 messages."

### 8. Heartbeat spam during long tasks
**Problem:** "⚙️ Still working..." every 2 minutes for 30 minutes straight during a hung nodemailer session.
**Root cause:** No distinction between simple Q&A and complex tasks. Heartbeat fires unconditionally.
**Fix:** Implemented TASK_025 — complexity classifier. Complex tasks get one calm ack ("Поняла, работаю"), no heartbeat. Simple tasks keep existing behavior.

### 9. Memory system stores everything permanently
**Problem:** Every Q&A exchange (including wrong turns, errors, "which bug?") stored in both Postgres and Pinecone. 532 permanent memories, many are garbage.
**Root cause:** No quality gate on storage. `storeMemoryDB` and `storeVector` called unconditionally on every message.
**Fix (immediate):** Project scoping prevents cross-project contamination.
**Fix (planned):** Add `worth_storing: true/false` to Groq enrichment output. Skip storage for noise.

### 10. Groq misclassifies projects
**Problem:** Groq (Llama 3.1 8B) tagged 6/8 test messages as "chemitech-sgr" regardless of actual content.
**Root cause:** Prompt said "project name or 'general' if unclear" without defining what the projects are. Model defaulted to the most business-sounding name.
**Fix:** Explicit project definitions with keywords and rules. Re-tested: 8/8 correct.

## What we deployed

| Change | File | Status |
|---|---|---|
| Phase 1 gate (plan before tools) | simple-bot.ts | ✅ Live |
| Phase 1 message length bypass (<200 chars) | simple-bot.ts | ✅ Live |
| rawMessageLength parameter | simple-bot.ts | ✅ Live |
| TASK_025 async ack (no heartbeat for complex) | simple-bot.ts | ✅ Live |
| 5 behavioral rules ("Дисциплина") | CLAUDE.md | ✅ Live |
| Work phases (Phase 1/Phase 2) | CLAUDE.md | ✅ Live |
| Codex profiles documentation | CLAUDE.md | ✅ Live |
| OpenRouter tool documentation | CLAUDE.md | ✅ Live |
| MCP availability warning | CLAUDE.md | ✅ Live |
| Cron list corrected | CLAUDE.md | ✅ Live |
| Duplicate sections removed | CLAUDE.md | ✅ Live |
| "Ограничения" section | CLAUDE.md | ✅ Live |
| verify-constraints.sh updated | scripts/ | ✅ Live |
| Prisma migration 0002_verifier_log | DB | ✅ Applied |
| Memory project column + index | DB | ✅ Applied |
| Groq prompt (explicit projects) | simple-bot.ts | ✅ Live |
| Memory search project filtering | simple-bot.ts | ✅ Live |
| Keyword backfill (218 memories) | DB | ✅ Done |
| Groq backfill (311 memories) | DB | ⏳ Running |

## Lessons learned

1. **Never deploy enforcement gates to a live system without testing.** The Phase 1 gate had two bugs that crashed the bot. Should have tested on a staging instance or at minimum with `node --check` + a dry run.

2. **Constraint checkers must be updated alongside the code they check.** We changed enforcement patterns but forgot to update verify-constraints.sh. It screamed for 3 hours.

3. **Memory contamination is an infrastructure problem, not a behavioral one.** Telling Mira "don't mention Chemitech" doesn't help when her recalled context is full of Chemitech memories. Fix the retrieval, not just the instructions.

4. **Groq prompts need explicit taxonomies.** "Use consistent names" is not a spec. "Use exactly these 5 names with these definitions" is.

5. **Store less, not more.** Permanent storage of every Q&A exchange creates a garbage pile that contaminates future recall. Quality gating on storage is the next priority.
