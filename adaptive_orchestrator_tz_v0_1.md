# Техническое задание v0.1
## Проект: управляемый аналог OpenClaw с адаптивным оркестратором

Статус: baseline-спецификация для первой реализации через Codex.
Дата: 2026-04-06.

---

## 1. Суть проекта

Нужно построить систему, которая внешне ведёт себя как один агент, но внутри управляет специализированными субагентами и инструментами.

Главный пользовательский сценарий:
- пользователь пишет в Telegram или Slack свободным текстом;
- внешний агент понимает задачу, декомпозирует её;
- выбирает нужные субагенты, модели и инструменты;
- получает проверяемый результат;
- при необходимости запрашивает подтверждение у человека;
- возвращает итог, артефакты и стоимость.

Ключевой продуктовый тезис:
**мы заранее не знаем “идеальную” форму агента**, поэтому система должна быть спроектирована как **адаптивный control plane**, который умеет:
- менять стратегию выполнения под конкретного пользователя;
- менять структуру плана под конкретный проект;
- менять выбор моделей и степень автономности в рамках безопасных границ;
- улучшать свои playbooks по итогам обратной связи;
- оставаться управляемой, аудируемой и ограниченной по бюджету.

Проект не должен быть жёстко привязан к одной вендорской экосистеме, хотя на первом этапе:
- orchestrator = Claude Opus 4.6;
- основной coding agent = OpenAI Codex;
- запасной модельный зоопарк = через LiteLLM/OpenRouter;
- основной канал = Telegram;
- дополнительный канал = Slack;
- хостинг = VPS.

---

## 2. Главная архитектурная идея

Система делится на два слоя:

### 2.1. Неподвижный слой (human-controlled)
Это то, что агент **не имеет права менять сам**.

Сюда входят:
- доступы и секреты;
- allowlist репозиториев;
- permission matrix инструментов;
- лимиты бюджета;
- approval policy;
- правила работы с продом, базами и инфраструктурой;
- список запрещённых команд и действий;
- максимальная автономность по классам задач.

### 2.2. Подвижный слой (orchestrator-controlled)
Это то, что агент **может адаптировать под пользователя и задачу**.

Сюда входят:
- декомпозиция задач;
- количество и тип субагентов;
- маршрутизация по моделям;
- степень подробности ответов;
- стратегия экономии токенов;
- выбор последовательной или параллельной работы;
- объём проверок;
- шаблоны планов;
- стиль итоговых отчётов;
- правила краткой/длинной сводки;
- выбор “сначала дешевле” / “сначала надёжнее” в рамках policy.

Именно это обеспечивает адаптацию “под себя” и “под конкретного пользователя” без потери контроля.

---

## 3. Цели MVP

Горизонт MVP: 7 дней на первую работающую версию.

### 3.1. MVP должен уметь
1. Принять задачу из Telegram.
2. Превратить её в task с явным lifecycle.
3. Дать задачу оркестратору.
4. Оркестратор должен уметь:
   - понять класс задачи;
   - выбрать, нужны ли researcher / coder / verifier / executor;
   - сформировать план;
   - установить бюджет и лимиты;
   - выбрать режим выполнения.
5. Codex должен уметь:
   - прочитать указанный GitHub repo;
   - работать в изолированном workspace;
   - менять код;
   - запускать проверки;
   - возвращать diff, логи, summary.
6. Verifier должен уметь:
   - проверить, решена ли задача;
   - указать риски;
   - вернуть verdict.
7. Оркестратор должен уметь:
   - принять или отклонить результат;
   - запросить доработку;
   - эскалировать человеку;
   - показать стоимость и прогресс.
8. Все критические действия должны требовать подтверждения пользователя в Telegram.
9. Все model/tool вызовы должны попадать в cost ledger и audit log.

### 3.2. MVP не обязан уметь
- полноценную self-healing infra orchestration;
- автодеплой без согласования;
- полноценный MCP mesh;
- обучение на собственных весах;
- многопользовательскую RBAC-систему enterprise-уровня;
- продвинутую web-admin-панель;
- сложную долгую память с векторной БД.

---

## 4. Архитектура компонентов

```text
Telegram / Slack / Admin UI
            |
        Ingress API
            |
     Session / Task Manager
            |
   Policy Engine + Cost Guard
            |
   Supervisor (Claude Opus 4.6)
      |         |         |         |
      |         |         |         |
  Researcher   Coder    Verifier   Executor
   (cheap)    (Codex)   (cheap)   (privileged)
            \    |    /
             \   |   /
          Model Gateway
   (LiteLLM + direct APIs + OpenRouter)
                 |
     GitHub / Files / Logs / Artifacts
                 |
         Postgres + Redis + S3-like store
```

### 4.1. Ingress API
Задачи:
- принимать сообщения из Telegram webhook;
- принимать события из Slack;
- нормализовать сообщения, вложения, voice input;
- связывать входящее сообщение с session/thread/task;
- отдавать команды на отправку ответов и approval prompts.

### 4.2. Session / Task Manager
Задачи:
- создавать task и thread;
- поддерживать state machine;
- хранить checkpoints;
- обеспечивать pause/resume/cancel;
- сохранять связь между user, project, repo и задачей.

### 4.3. Policy Engine
Задачи:
- накладывать разрешения на субагентов;
- вычислять бюджет на задачу;
- определять, когда нужен human approval;
- запрещать опасные операции;
- ограничивать маршрутизацию по моделям;
- отличать mutable и immutable конфигурацию.

### 4.4. Supervisor
Главный внешний агент. Всегда один голос наружу.

Задачи:
- intake;
- план;
- декомпозиция;
- запуск субагентов;
- контроль затрат;
- принятие финального решения;
- коммуникация с пользователем;
- предложение улучшений системы под конкретного пользователя.

### 4.5. Researcher
Нужен для:
- чтения issue/PR/logs/docs;
- поиска контекста по репозиторию;
- резюмирования больших файлов/логов;
- подготовки брифа для Codex;
- экономии токенов оркестратора.

На старте researcher не должен иметь destructive tools.

### 4.6. Coder
Основной coding runtime = Codex.

Задачи:
- читать код;
- вносить изменения;
- запускать build/test/lint/typecheck;
- создавать ветку и артефакты;
- готовить patch/PR summary.

### 4.7. Verifier
Нужен для независимой проверки:
- соответствует ли результат задаче;
- не сломал ли patch смежные области;
- достаточно ли тестов;
- насколько высок риск;
- нужно ли вернуть задачу на доработку.

### 4.8. Executor
Отдельный агент для опасных side effects.

Только он может работать с:
- production APIs;
- инфраструктурой;
- деплоями;
- записью в БД;
- секретами;
- нестандартными shell-командами вне coding sandbox.

Executor не используется без явной policy и approval.

### 4.9. Model Gateway
Единая точка вызова обычных LLM, кроме собственно Codex runtime.

Задачи:
- стандартизовать вызовы;
- вести spend tracking;
- делать fallback;
- делать rate limiting;
- управлять ключами;
- вести routing по price/performance policy.

### 4.10. Хранилища
**Postgres**:
- пользователи;
- проекты;
- репозитории;
- задачи;
- события;
- approvals;
- policy bundles;
- user preferences;
- cost ledger.

**Redis**:
- queue;
- locks;
- rate limits;
- dedup;
- short-lived cache.

**Object storage**:
- артефакты;
- diff snapshots;
- terminal logs;
- test results;
- voice attachments;
- uploaded files.

---

## 5. Почему делаем именно так

1. Оркестратор и кодинговый агент разделены.
2. Внешний UX всегда единый: пользователь говорит с одним агентом.
3. Внутри допускается гибкая композиция субагентов.
4. Критические permissions не отдаются модели на самонастройку.
5. Система должна улучшать execution strategy, но не должна самовольно расширять свои полномочия.

---

## 6. Модель адаптации под пользователя

Это ключевое требование.

Нужен **Adaptive Personalization Layer**.

### 6.1. Что система должна запоминать

#### UserProfile
- preferred verbosity;
- отношение к риску;
- tolerance to cost;
- tolerance to latency;
- стиль отчёта;
- язык общения;
- частота апдейтов;
- склонность к ручному approve;
- предпочтение “сначала дешевле” или “сначала качественнее”.

#### ProjectProfile
- repo URL;
- package manager;
- базовые команды build/test/lint/typecheck;
- branch policy;
- PR style;
- опасные директории;
- файлы, которые часто ломаются;
- known pitfalls;
- локальные правила проекта;
- ссылки на AGENTS.md / CONTRIBUTING / docs.

#### InteractionProfile
- какие ответы пользователь чаще принимает;
- какие планы чаще отклоняются;
- какие размеры бюджета пользователь считает “слишком много”; 
- какие типы задач лучше делать автономно;
- где пользователь почти всегда хочет подтверждение.

### 6.2. Что оркестратор может менять сам
- структуру плана;
- длину промежуточных статусов;
- распределение задач между субагентами;
- долю дешёвых и дорогих моделей;
- режим compaction;
- формат финального ответа;
- количество попыток до эскалации;
- критерии “достаточно проверить/достаточно объяснить” внутри допустимого диапазона.

### 6.3. Что оркестратор не может менять сам
- верхние лимиты бюджета;
- права доступа;
- список доступных репозиториев;
- доступ к прод-системам;
- политику destructive действий;
- список разрешённых моделей для чувствительных задач;
- правила работы с секретами.

### 6.4. Как система учится
После каждого task-run формируется retrospective:
- accepted / rejected / revised;
- сколько было итераций;
- сколько стоило;
- сколько заняло времени;
- пользователь попросил упростить / удешевить / углубить;
- были ли откаты или правки после результата.

На базе retrospective orchestrator может сформировать **proposed policy patch**.

Пример:
- “для пользователя X в проекте Y отвечать короче”;
- “для багфиксов в repo Z сначала запускать targeted tests, а не full test suite”;
- “для issue triage использовать cheap classifier до Opus”;
- “для этого пользователя не открывать draft PR без подтверждения”.

Важно:
- policy patch не применяется к immutable layer;
- risk-sensitive patches требуют approval;
- все patch-и версионируются.

---

## 7. Роли агентов и их контракты

Субагенты не должны общаться свободным текстом “как люди”.
Они должны возвращать структурированные объекты.

### 7.1. Базовый контракт субагента

```json
{
  "status": "completed | failed | needs_input | blocked",
  "summary": "краткая сводка результата",
  "artifacts": [
    {
      "type": "diff | log | test_report | note | branch | pr | file",
      "ref": "artifact reference"
    }
  ],
  "confidence": 0.0,
  "risks": ["..."],
  "next_actions": ["..."],
  "budget_used": {
    "input_tokens": 0,
    "output_tokens": 0,
    "estimated_usd": 0
  },
  "proposed_policy_patch": null
}
```

### 7.2. Researcher contract
Вход:
- task goal;
- repo or issue references;
- allowed sources;
- budget cap.

Выход:
- compressed context;
- relevant files;
- hypotheses;
- suggested scope for coder.

### 7.3. Coder contract
Вход:
- coding brief;
- repo/profile;
- workspace ref;
- allowed commands;
- expected deliverables;
- budget cap.

Выход:
- diff;
- changed files list;
- commands run;
- command outcomes;
- branch ref;
- optional PR draft metadata.

### 7.4. Verifier contract
Вход:
- original task;
- coder output;
- logs;
- diff;
- changed files.

Выход:
- verdict: pass / revise / fail;
- why;
- risk note;
- missing checks;
- rollback concerns.

### 7.5. Executor contract
Вход:
- approved operation;
- target system;
- exact action;
- rollback hint;
- approval token.

Выход:
- execution result;
- logs;
- side effects summary;
- rollback status if needed.

---

## 8. Состояния задачи

Нужна явная state machine.

```text
NEW
 -> INTAKE_NORMALIZED
 -> PLANNING
 -> AWAITING_APPROVAL (optional)
 -> RUNNING
 -> VERIFYING
 -> AWAITING_HUMAN (optional)
 -> COMPLETED
 -> FAILED
 -> CANCELLED
 -> PAUSED
```

Дополнительные подстадии RUNNING:
- DISPATCHING_SUBAGENTS
- RESEARCHING
- CODING
- EXECUTING_CHECKS
- AGGREGATING_RESULTS
- RETRYING
- ESCALATING

Требования:
- каждое состояние должно быть записано в event log;
- допустим resume после рестарта VPS;
- допустим pause/resume по команде пользователя;
- у каждого task должен быть deadline и budget snapshot.

---

## 9. Каналы взаимодействия

### 9.1. Telegram — основной канал

Обязательные возможности:
- свободный текст;
- вложения;
- voice;
- status updates;
- inline approval buttons;
- reply semantics;
- команды `/status`, `/pause`, `/resume`, `/cancel`, `/approve`, `/reject`, `/cost`.

### 9.2. Slack — дополнительный канал

Обязательные возможности:
- thread-based ответы;
- app mention / direct mention;
- approvals;
- статусы задач;
- возврат ссылок на артефакты и PR.

### 9.3. Admin UI — аварийный fallback

MVP-функции:
- список задач;
- просмотр статусов;
- approve/reject;
- просмотр стоимости;
- просмотр артефактов;
- базовое редактирование policy bundles.

---

## 10. Интеграция с GitHub

Первая версия работает только с GitHub.

Поддерживаем:
- чтение репозиториев;
- создание веток;
- push;
- opening draft PR;
- чтение issues;
- чтение PR diff;
- комментарии в PR — позже;
- merge — только вручную человеком.

### 10.1. Базовая git-политика
- новая ветка на задачу: `agent/<taskId>-<slug>`;
- PR по умолчанию открывается как draft;
- merge никогда не делается автоматически в MVP;
- force-push запрещён по умолчанию;
- изменения в `main`/`master` напрямую запрещены;
- commit style: `type(agent): short summary`.

Где:
- `type = feat | fix | refactor | test | chore | docs`.

---

## 11. Codex integration strategy

Использовать гибридный подход.

### 11.1. Что считаем основным путём
Основной путь:
- Codex SDK / App Server / CLI как coding runtime,
- управляемый из нашего orchestrator.

### 11.2. Почему гибрид, а не один режим
Потому что системе нужны три режима:
1. **interactive/local-style run** — для контролируемой работы и ручной отладки;
2. **server-orchestrated run** — для фоновых задач на VPS;
3. **one-shot exec mode** — для CI-подобных коротких запусков.

### 11.3. Что жёстко фиксируем
- интеграционный слой с Codex должен быть абстракцией, а не захардкоженным вызовом одной команды;
- каждый Codex run должен иметь свой `codex_run_id`;
- orchestrator должен знать только контракт `CoderRuntime`, а не детали CLI/App Server.

### 11.4. Интерфейс CoderRuntime

```ts
interface CoderRuntime {
  startRun(input: StartCoderRunInput): Promise<RunHandle>
  streamEvents(runId: string): AsyncIterable<CoderEvent>
  cancelRun(runId: string): Promise<void>
  getResult(runId: string): Promise<CoderResult>
}
```

### 11.5. Режимы работы Codex
- READ_ONLY_ANALYSIS
- PATCH_ONLY
- PATCH_AND_TEST
- PATCH_TEST_AND_PR

Режим выбирает orchestrator по policy.

---

## 12. Approval matrix

### 12.1. Автоматически разрешено
- read-only анализ репозитория;
- чтение issues/PR/logs;
- создание локального рабочего дерева;
- изменение файлов в task workspace;
- запуск безопасных тестов/линтеров/typecheck/build в task workspace;
- повторные попытки в рамках бюджета;
- формирование diff и артефактов;
- подготовка draft PR без публикации — если это разрешено project policy;
- создание proposed policy patches.

### 12.2. Требует человеческого approve
- публикация PR в GitHub, если пользователь так настроил;
- любая запись вне task workspace;
- добавление/обновление зависимостей, если меняются lockfile или package manifest;
- сетевой доступ coding runtime, если по умолчанию сеть выключена;
- изменение CI/CD конфигов;
- изменение infra/Terraform/Docker/K8s;
- доступ к продовым логам/метрикам;
- запись в БД;
- выполнение миграций;
- использование секретов;
- merge;
- деплой.

### 12.3. Требует двухэтапного approve
- действия с продом;
- действия с платёжными системами;
- destructive DB operations;
- удаление инфраструктурных ресурсов;
- доступ к чувствительным секретам;
- изменение security-critical конфигурации.

---

## 13. Экономика токенов и cost ledger

Это обязательный, а не вторичный модуль.

### 13.1. Цели cost subsystem
- считать стоимость на каждый LLM call;
- считать стоимость на задачу;
- считать стоимость на пользователя;
- считать стоимость на проект;
- считать стоимость на тип задач;
- давать hard stop по лимиту;
- давать early warning по threshold;
- поддерживать routing “дешевле / надёжнее / быстрее”.

### 13.2. Обязательные сущности

#### pricing_catalog
- provider;
- model;
- pricing_version;
- input_cost_per_1m;
- output_cost_per_1m;
- cached_input_discount;
- effective_from;
- effective_to.

#### llm_call_log
- id;
- task_id;
- subagent_id;
- provider;
- model;
- prompt_tokens;
- completion_tokens;
- cached_tokens;
- reasoning_tokens_if_known;
- latency_ms;
- estimated_cost_usd;
- final_cost_usd_if_known;
- started_at;
- finished_at.

#### task_cost_snapshot
- task_id;
- total_input_tokens;
- total_output_tokens;
- total_estimated_cost_usd;
- total_wall_time_ms;
- model_breakdown_json.

#### budget_policy
- max_task_cost_usd;
- max_task_tokens;
- max_opus_calls;
- max_codex_runs;
- max_wall_time_minutes;
- warn_at_percent;
- stop_at_percent.

### 13.3. Базовая экономическая стратегия
1. Всё, что можно сделать дешёвой моделью, не должно идти в Opus.
2. Opus используется на:
   - декомпозицию сложной задачи;
   - арбитраж между вариантами;
   - принятие результата;
   - сложные ambiguous tasks.
3. Researcher и verifier по умолчанию дешевле Opus.
4. Codex используется только там, где реально нужен coding runtime.
5. Большие логи и diff не возвращаются целиком в контекст; в контекст идёт summary + artifact refs.
6. Повторные прогоны должны использовать repo profile и прошлые summaries, а не заново “изучать мир”.

### 13.4. Правила остановки по бюджету
- при достижении 50% — тихий внутренний warning;
- при достижении 75% — показать пользователю текущий cost/progress snapshot;
- при достижении 90% — спросить continue/stop, если задача не критична;
- при достижении 100% — hard stop, кроме whitelisted workflows.

### 13.5. Экономия контекста
- compaction после каждого крупного этапа;
- terminal logs в object storage, не в prompt;
- большие файлы читаются чанками;
- summary per repo / per issue / per task;
- reuse project profile вместо повторной разведки;
- вынос фактов в structured memory, а не в raw transcript.

---

## 14. Model routing policy

### 14.1. Основные роли по умолчанию
- Supervisor: Claude Opus 4.6
- Coder: Codex
- Researcher: дешёвая быстрая модель
- Verifier: дешёвая, но достаточно сильная reasoning/coding модель
- Cheap classifier / parser: nano-class model

### 14.2. Общие правила routing
- сначала минимально достаточная модель;
- если задача ambiguous/high risk, повышаем класс модели;
- если verifier не уверен, escalation к более сильной модели;
- если провайдер недоступен, используем fallback chain;
- политика должна быть настраиваемой по user/project.

### 14.3. Routing profiles
- `cheap_first`
- `balanced`
- `quality_first`
- `latency_first`

Профиль может назначаться:
- глобально;
- на пользователя;
- на проект;
- на конкретную задачу.

---

## 15. Инструменты в MVP

### 15.1. Внутренние адаптеры, обязательные в MVP
- GitHub adapter;
- Filesystem adapter;
- Shell adapter;
- Artifact storage adapter;
- Telegram adapter;
- Slack adapter;
- STT adapter;
- Cost adapter;
- Policy adapter.

### 15.2. MCP
В MVP не является обязательным ядром.

Требование:
- архитектура инструментов должна позволять позже заменить часть adapters на MCP servers;
- внутренний tool contract должен быть близок по смыслу к MCP capability model.

### 15.3. Разделение инструментов по уровню риска
- read-only tools;
- workspace write tools;
- privileged tools;
- external side-effect tools.

---

## 16. Memory service

Отдельного “memory-агента” в MVP не нужно.
Нужен **Memory Service**.

### 16.1. Что хранит memory service
- user profile;
- project profile;
- accepted playbooks;
- task summaries;
- cost heuristics;
- verified commands;
- common failure modes;
- approved policy patches.

### 16.2. Что memory service не хранит по умолчанию
- сырой большой transcript навсегда;
- секреты в явном виде;
- чувствительные артефакты без TTL/шифрования;
- всё подряд из голосовых сообщений и вложений бессрочно.

### 16.3. TTL политика
- ephemeral attachments: короткий TTL;
- logs/test output: средний TTL;
- policy bundles/project profiles: бессрочно до удаления;
- аудио и чувствительные вложения: отдельная retention policy.

---

## 17. Безопасность

### 17.1. Базовые принципы
- least privilege;
- sandbox everything;
- no direct prod access for general agents;
- secrets only through controlled injection;
- all dangerous operations are auditable;
- human remains final authority.

### 17.2. Обязательные security требования
- отдельный workspace на task;
- очистка workspace после завершения;
- нет shared mutable workspace между задачами;
- явная allowlist shell-команд или command classes;
- секреты выдаются только executor или whitelisted coder runs;
- сетевой доступ у coding tasks выключен по умолчанию;
- все approvals подписываются и журналируются.

### 17.3. Минимальный audit trail
- кто поставил задачу;
- кто её выполнял;
- какие модели использовались;
- какие tool calls были сделаны;
- какие команды запускались;
- какие approvals были запрошены;
- какая была итоговая стоимость;
- какие policy patches предлагались и применялись.

---

## 18. Наблюдаемость

### 18.1. Что обязательно логировать
- task lifecycle events;
- model call events;
- subagent dispatch events;
- shell execution events;
- approval events;
- GitHub events;
- errors;
- retries;
- final result summary.

### 18.2. Что должно быть видно в UI
- текущая стадия задачи;
- какие субагенты уже отработали;
- какая модель сейчас работает;
- сколько уже потрачено;
- какие артефакты доступны;
- нужна ли реакция человека.

### 18.3. Что должно быть видно пользователю в Telegram
- короткий статус;
- текущая стадия;
- запрос подтверждения при необходимости;
- итог;
- стоимость;
- ссылки/идентификаторы артефактов.

---

## 19. Определение “задача выполнена”

Task считается завершённым только если одновременно выполняется следующее:
- есть понятный summary;
- есть изменённые файлы или подтверждённый вывод, что изменений не требуется;
- есть terminal/test evidence;
- verifier дал verdict;
- orchestrator принял verdict;
- итог донесён пользователю;
- стоимость записана в ledger.

Для coding tasks желательно также:
- есть branch ref;
- есть diff summary;
- есть список проверок;
- есть список рисков;
- есть rollback note, если риск не нулевой.

---

## 20. Правила самонастройки оркестратора

Это одна из самых важных частей.

### 20.1. Оркестратор имеет право
- менять количество субагентов на задачу;
- создавать экземпляры role templates;
- менять очередность шагов;
- дробить задачу на подзадачи;
- менять prompt pack в mutable scope;
- вносить предложения по новым playbooks;
- снижать/повышать степень проверки в допустимых рамках;
- выбирать более дешёвую или более сильную модель по policy.

### 20.2. Оркестратор не имеет права
- сам создавать новые privileged tools;
- сам выдавать себе новый доступ;
- сам снимать budget caps;
- сам менять destructive action policy;
- сам включать доступ к новым секретам;
- сам повышать себе уровень автономности вне разрешённого диапазона.

### 20.3. Механизм self-tuning
После завершения задач orchestrator может предложить одно из трёх:
- `prompt_patch`
- `playbook_patch`
- `routing_patch`

Каждый patch содержит:
- target scope: global / user / project;
- rationale;
- expected benefit;
- estimated risk;
- rollback path.

Применение:
- low-risk patch — можно автоактивировать, если так разрешено policy;
- medium/high-risk patch — только после approve.

### 20.4. Режимы персонализации
- global defaults;
- per-user overrides;
- per-project overrides;
- per-task transient overrides.

Порядок приоритета:
`task > project > user > global`

---

## 21. Suggested tech stack

### 21.1. Язык и рантайм
- TypeScript
- Node.js 22+
- pnpm workspaces

### 21.2. Сервер
- Fastify для API/webhook слоя
- BullMQ для очередей
- Redis для queue/locks
- Postgres для основного state
- Prisma или аналогичный ORM
- Zod для валидации входов/выходов
- Pino для structured logs
- OpenTelemetry для traces

### 21.3. Почему не heavy framework в MVP
В первой неделе важнее:
- явная state machine;
- явные контракты;
- явные policy checks;
- простое дебажение;
- контроль затрат.

Поэтому orchestration лучше сделать кастомным и прозрачным.

---

## 22. Suggested repository structure

```text
agent-platform/
  apps/
    api/
      src/
        main.ts
        routes/
        webhooks/
        controllers/
    worker/
      src/
        main.ts
        jobs/
        runners/
    telegram-bot/
      src/
        webhook.ts
        ui/
    slack-bot/
      src/
        socket.ts
        ui/
    admin-ui/
      src/
  packages/
    core/
      src/
        task/
        session/
        state-machine/
        events/
    supervisor/
      src/
        planner/
        dispatcher/
        aggregator/
        retrospective/
    subagents/
      src/
        researcher/
        verifier/
        executor/
    codex-runtime/
      src/
        app-server/
        cli/
        sdk/
        mapper/
    model-gateway/
      src/
        litellm/
        openrouter/
        anthropic/
        pricing/
    policy-engine/
      src/
        budgets/
        approvals/
        permissions/
        personalization/
    memory-service/
      src/
        profiles/
        summaries/
        playbooks/
    integrations/
      src/
        github/
        telegram/
        slack/
        stt/
        storage/
    contracts/
      src/
        task.ts
        agent.ts
        policy.ts
        artifacts.ts
    observability/
      src/
        logging/
        tracing/
        metrics/
  infra/
    docker/
    compose/
    migrations/
  docs/
    architecture.md
    prompts/
    playbooks/
    agents/
  AGENTS.md
  pnpm-workspace.yaml
  package.json
  turbo.json
```

---

## 23. Схемы данных

### 23.1. Task

```ts
interface Task {
  id: string
  userId: string
  channel: 'telegram' | 'slack' | 'admin'
  threadId: string
  title: string
  rawInput: string
  normalizedInput: string
  state: TaskState
  repoRefs: string[]
  priority: 'low' | 'normal' | 'high' | 'urgent'
  routingProfile: 'cheap_first' | 'balanced' | 'quality_first' | 'latency_first'
  budgetPolicyId: string
  createdAt: string
  updatedAt: string
}
```

### 23.2. UserProfile

```ts
interface UserProfile {
  userId: string
  language: string
  verbosity: 'short' | 'medium' | 'long'
  costSensitivity: 'high' | 'medium' | 'low'
  latencySensitivity: 'high' | 'medium' | 'low'
  autonomyPreference: 'manual' | 'balanced' | 'high'
  notifyStyle: 'every_stage' | 'major_only' | 'final_only'
  preferredRoutingProfile: 'cheap_first' | 'balanced' | 'quality_first' | 'latency_first'
}
```

### 23.3. PolicyPatch

```ts
interface PolicyPatch {
  id: string
  scope: 'global' | 'user' | 'project'
  patchType: 'prompt_patch' | 'playbook_patch' | 'routing_patch'
  rationale: string
  expectedBenefit: string
  riskLevel: 'low' | 'medium' | 'high'
  requiresApproval: boolean
  status: 'proposed' | 'approved' | 'rejected' | 'applied' | 'rolled_back'
  diffJson: Record<string, unknown>
}
```

---

## 24. Event model

Все важные действия должны быть events.

```ts
interface EventEnvelope {
  id: string
  taskId: string
  type: string
  actor: 'system' | 'user' | 'supervisor' | 'researcher' | 'coder' | 'verifier' | 'executor'
  payload: Record<string, unknown>
  createdAt: string
}
```

Примеры event types:
- `task.created`
- `task.normalized`
- `task.planned`
- `subagent.dispatched`
- `model.called`
- `tool.called`
- `approval.requested`
- `approval.received`
- `codex.run.started`
- `codex.run.completed`
- `verifier.failed`
- `task.completed`
- `task.failed`
- `policy.patch.proposed`

---

## 25. Промптовая архитектура

Промпты должны быть versioned assets, а не строками в коде.

### 25.1. Prompt bundles
- `supervisor.system`
- `supervisor.planning`
- `researcher.brief`
- `coder.brief`
- `verifier.brief`
- `executor.brief`
- `retrospective.brief`
- `policy_patch.brief`

### 25.2. Override слои
- global
- user
- project
- task

### 25.3. Ограничение
Оркестратор не может произвольно переписывать системные prompt bundles без policy.
Он может:
- выбирать bundle variant;
- включать approved overrides;
- предлагать patch.

---

## 26. AGENTS.md стратегия

Так как у пользователя нет ещё нормализованных repo instructions, MVP должен включать bootstrap:

### 26.1. Для каждого активного repo нужно создать
- `AGENTS.md`
- краткий `REPO_PROFILE.md`
- список команд проверки
- описание risky paths
- описание branch/PR style

### 26.2. Как это делать
Отдельная onboarding-задача:
1. researcher изучает repo;
2. coder генерирует первичный AGENTS.md;
3. verifier проверяет на практическую полезность;
4. пользователь подтверждает.

---

## 27. Acceptance criteria для MVP

MVP принимается, если выполняются все условия:

1. Пользователь может создать задачу из Telegram свободным текстом.
2. Задача получает явный lifecycle и отображается в системе.
3. Orchestrator строит план и пишет его в event log.
4. Система умеет вызвать Codex на GitHub repo и получить результат.
5. Результат проходит через verifier.
6. Критические шаги требуют approve в Telegram.
7. По завершении пользователь получает:
   - summary,
   - статус,
   - артефакты,
   - стоимость.
8. Все model calls записаны в ledger.
9. После завершения задачи формируется retrospective.
10. Orchestrator умеет создать хотя бы один proposed policy patch на основе user feedback.

---

## 28. Этапы реализации

### Этап 0. Scaffold
- монорепа;
- базовые пакеты;
- Postgres/Redis;
- event model;
- task state machine.

### Этап 1. Telegram-first task loop
- webhook;
- task create;
- status updates;
- approve/reject.

### Этап 2. Supervisor loop
- planning;
- dispatch;
- aggregation;
- final response.

### Этап 3. Codex runtime
- abstract CoderRuntime;
- workspace creation;
- run + logs + diff + artifacts.

### Этап 4. Verifier + cost ledger
- verifier contract;
- llm_call logging;
- task budget caps;
- warnings.

### Этап 5. Adaptive layer
- user/project profiles;
- retrospective;
- policy patch proposals;
- prompt bundle overrides.

### Этап 6. Slack + Admin UI
- secondary channel;
- аварийный fallback.

---

## 29. Что должен сделать Codex первым

Если отдавать это ТЗ самому Codex, первый рабочий backlog должен быть таким:

1. Инициализировать монорепу TypeScript.
2. Поднять API + worker + telegram-bot приложения.
3. Описать contracts и state machine.
4. Сделать Postgres schema для tasks/events/users/policies/costs.
5. Реализовать task ingestion из Telegram.
6. Реализовать approval flow в Telegram.
7. Реализовать Supervisor service с моковыми субагентами.
8. Реализовать CoderRuntime abstraction.
9. Подключить первый реальный Codex runtime adapter.
10. Реализовать cost ledger.
11. Реализовать verifier.
12. Реализовать retrospective + proposed policy patches.
13. Сделать минимальную admin-страницу просмотра задач и approvals.

---

## 30. Финальное решение, которое фиксируем

### 30.1. Что является “ядром системы”
Не Codex, не Telegram-бот и не отдельная модель.

Ядро системы — это:
**Task Manager + Policy Engine + Supervisor + Cost Ledger + Artifacted Execution**.

### 30.2. Что делает систему ценной
Не просто “умение писать код”, а сочетание пяти вещей:
- оркестрация;
- адаптация под пользователя;
- доказуемость результата;
- контроль риска;
- контроль стоимости.

### 30.3. Самый важный продуктовый принцип
**Система должна уметь переделывать стратегию работы под конкретного пользователя, не переделывая саму безопасность и границы доступа.**

Это и есть правильный компромисс между гибкостью и контролем.

