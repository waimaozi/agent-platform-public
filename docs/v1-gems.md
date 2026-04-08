# V1 Hidden Gems — Worth Reimplementing Later

## Worth keeping (proven value)
1. **Frontdesk regex filter** — BANTER_RE + GREETING_RE + junk detection. Copy verbatim.
2. **Cost tracking from Claude JSON envelope** — parsing total_cost_usd, modelUsage, token counts. Simple and useful.
3. **Typing indicator** — sendChatAction("typing") every 4s. Great UX.
4. **Clean error messages** — user-facing Russian, no internal jargon.
5. **/start welcome message** — first impression matters.
6. **SOUL.md loading via --system-prompt-file** — gives Mira personality.
7. **Stuck task cleanup on startup** — prevents ghost tasks.

## Worth reimplementing when needed
8. **Scoped memory concept** — 6 layers is overkill, but "pinned facts" per user is valuable. Simplify to: user_facts table, /pin and /forget commands.
9. **answer_self routing** — the IDEA is right (don't run coder for questions). In v2 this is automatic since there's no coder pipeline.
10. **Approval flow** — only needed when Mira can actually do dangerous things (deploy, delete). Not needed for Q&A.
11. **directAnswer** — the concept of Claude answering directly in the plan call. In v2, every call IS a direct answer.
12. **N8N workflow registry** — useful when Mira needs to call workflows. Add when she actually uses n8n.
13. **Secrets service** — encrypted DB storage with actor-based access. Good for multi-user. Overkill for single user.
14. **execution_packet / result_packet contracts** — good for Codex integration when we enable real coding. Park until then.
15. **Improvement notes / scriptization_candidates** — great concept for continuous improvement. Add when system is stable enough to improve.

## Concepts that were premature
16. **BullMQ job queue** — adds latency and complexity for no benefit with single user. Just call Claude inline.
17. **Researcher → Coder → Verifier pipeline** — the mock coder produces fake results that the real verifier rejects. Useless until real Codex is wired.
18. **Context bundle builder** — Claude with --add-dir already reads files. The bundle builder duplicates this.
19. **Memory consolidation cron** — no real memories to consolidate yet.
20. **Voice notes via Groq Whisper** — good idea, add when someone actually sends voice.
