# Prompt для Codex: старт реализации adaptive orchestrator

Прочитай файл `adaptive_orchestrator_tz_v0_1.md` и реализуй **первый вертикальный срез** системы.

## Цель этой итерации
Сделать рабочий foundation проекта, который уже умеет:
- принимать задачи из Telegram webhook;
- создавать task в Postgres;
- вести event log;
- поддерживать state machine;
- делать approve/reject через Telegram;
- запускать supervisor loop с моковыми subagents;
- считать cost ledger на уровне интерфейса, даже если часть провайдеров пока заглушки.

## Не пытайся сразу сделать всё
В этой итерации **не надо** полноценно подключать все реальные модели и все интеграции.
Нужно собрать правильный каркас.

## Обязательный стек
- TypeScript
- Node.js 22+
- pnpm workspaces
- Fastify
- Postgres
- Redis
- BullMQ
- Prisma или аналогичный ORM
- Zod
- Pino

## Структура проекта
Сконфигурируй монорепу в стиле, описанном в ТЗ.
Минимально нужны:
- `apps/api`
- `apps/worker`
- `apps/telegram-bot`
- `packages/core`
- `packages/contracts`
- `packages/policy-engine`
- `packages/supervisor`
- `packages/observability`
- `packages/memory-service`
- `packages/model-gateway`
- `packages/codex-runtime`
- `packages/integrations`

## Что нужно реализовать сейчас

### 1. Database schema
Создай таблицы / модели для:
- users
- tasks
- task_events
- approvals
- user_profiles
- project_profiles
- budget_policies
- llm_call_logs
- task_cost_snapshots
- policy_patches

### 2. Core contracts
Опиши и заэкспорти:
- Task
- TaskState
- EventEnvelope
- ApprovalRequest
- ApprovalDecision
- BudgetPolicy
- UserProfile
- ProjectProfile
- PolicyPatch
- SubagentResult
- CoderRuntime interface

### 3. State machine
Реализуй явную state machine с переходами:
- NEW
- INTAKE_NORMALIZED
- PLANNING
- AWAITING_APPROVAL
- RUNNING
- VERIFYING
- AWAITING_HUMAN
- COMPLETED
- FAILED
- CANCELLED
- PAUSED

Сделай unit tests на допустимые и недопустимые переходы.

### 4. Telegram ingestion
Сделай webhook endpoint, который:
- принимает текстовые сообщения;
- создаёт user/task;
- пишет initial events;
- отправляет acknowledgment;
- умеет обрабатывать inline callback для approve/reject.

### 5. Approval flow
Сделай:
- создание approval request;
- отправку кнопок в Telegram;
- обработку callback;
- запись решения в БД;
- event log;
- возобновление task после approve.

### 6. Supervisor skeleton
Сделай сервис, который:
- читает task;
- создает простой plan;
- пишет `task.planned`;
- вызывает моковые researcher/coder/verifier;
- агрегирует их ответы;
- переводит задачу в финальное состояние.

На этой итерации subagents могут быть stub/mocked, но их контракты должны быть реальными.

### 7. Cost ledger skeleton
Реализуй:
- pricing catalog interface;
- llm call logger interface;
- task cost snapshot updater;
- budget checker;
- warning thresholds.

Даже если реальные вызовы моделей пока моковые, cost subsystem должен быть встроен архитектурно.

### 8. Observability
Сделай:
- structured logging;
- request id / task id correlation;
- базовый health endpoint;
- базовый status endpoint по task id.

## Что должно получиться в конце итерации
1. Локально поднимается стек через docker-compose.
2. Telegram webhook получает сообщение и создаёт задачу.
3. Задача проходит через state machine.
4. Можно отправить approve/reject через Telegram inline buttons.
5. Supervisor skeleton завершает задачу и пишет артефакты в event log.
6. Есть unit tests для state machine и approval flow.
7. Есть README с инструкцией запуска.
8. Есть `.env.example`.
9. Есть базовый `AGENTS.md` для самого проекта.

## Ограничения
- Не делать сложную магию без надобности.
- Не прятать core logic за тяжёлым фреймворком.
- Все важные переходы и правила должны быть явно видны в коде.
- Контракты и policy должны быть first-class, а не размазаны по обработчикам.

## Формат результата
После выполнения:
- покажи структуру проекта;
- перечисли реализованные пакеты;
- перечисли database models;
- приложи список API endpoints;
- перечисли, что уже работает;
- перечисли, что пока stub/mock;
- перечисли следующие 5 шагов.
