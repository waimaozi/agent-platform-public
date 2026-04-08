# AGENTS.md

## Purpose

Этот репозиторий содержит foundation для adaptive orchestrator. Важные правила должны оставаться явными: state machine, policy checks, approval flow и cost accounting не прячем за heavy framework abstractions.

## Engineering Rules

- Сначала меняй контракты и policy-level types, потом обработчики.
- Каждый новый переход состояния должен быть выражен в `packages/core/src/state-machine`.
- Каждое критичное действие должно оставлять запись в `task_events`.
- Любой workflow с side effects должен сначала проходить через approval/policy слой.
- Сначала добавляй unit tests на state logic, затем меняй runtime.

## Current MVP Boundaries

- Telegram является основным ingress-каналом.
- Worker исполняет supervisor skeleton с mock subagents.
- Реальные model providers и Codex integration заменены контрактами и заглушками.
- Cost ledger должен обновляться на каждом существенном LLM/subagent шаге.
