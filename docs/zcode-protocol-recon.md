# ZCode Protocol — разведка (2026-09-06)

Цель: понять, во что обойдётся плагин для Claude Code уровня `openai/codex-plugin-cc`,
но с ZCode/GLM в роли исполнителя и ревьюера.

## Вводные

| | |
|---|---|
| ZCode.app | 3.11.2 |
| CLI | `zcode` 0.16.5 |
| Путь к CLI | `/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs` (на PATH **нет**) |
| Запуск | `node <путь> app-server` |
| Протокол | `ZCode Protocol`, `protocolVersion: 1` |
| Провайдер моделей | Anthropic-совместимый, `https://api.z.ai/api/anthropic` |
| Модели | GLM-5.3, GLM-5.3-Flash, GLM-5-Turbo |

Недокументированный второй сервер: `agent-server` (в `--help` отсутствует, в коде
обрабатывается наравне с `app-server` — `isProtocolServerInvocation`).

## Транспорт

Newline-delimited JSON по stdio. **Это не JSON-RPC 2.0** — поле `jsonrpc` отвергается.

Union из четырёх форм конверта:

```jsonc
{ "id": "1", "method": "session/create", "params": {} }   // запрос
{ "method": "process/mcpTelemetry", "params": {} }        // нотификация (сервер → клиент)
{ "id": "1", "result": {} }                               // ответ
{ "id": "1", "error": { "code": -32602, "message": "" } } // ошибка
```

**Хендшейк не нужен.** `initialize` → `-32601 Method not found`. Методы вызываются сразу.

Коды ошибок: `-32600` невалидное сообщение, `-32601` метод не найден,
`-32602` невалидные параметры, `-32004` `sessionUnavailable`.

## Ключевой рычаг: сервер самодокументируется

Параметры валидируются zod, и ошибки возвращают **полный `ZodError` с путями и
именами недостающих ключей**. Схема любого метода снимается отправкой `{}` и чтением ответа:

```
send {"id":"a","method":"workspace/readState","params":{"workspace":{}}}
→ path ["workspace","workspacePath"] expected string, received undefined
  path ["workspace","workspaceKey"]  expected string, received undefined
```

Реверс превращается в механическую процедуру. Это главная причина, почему уровень 2 дёшев.

## workspace-ссылка

```js
{ workspacePath: "/abs/path",
  workspaceKey: sha256(absPath).hex.slice(0, 12) }
```

Проверено на двух путях — совпало с именами каталогов в `~/.zcode/v2/sessions/`.

## Карта методов (снята с бандла, ~45 штук)

**Сессии** — `session/create` `resume` `send` `subscribe` `event` `events` `messages`
`read` `list` `stop` `close` `fork` `compact` `goal` `usage` `subagents`
`setMode` `setModel` `setThoughtLevel` `updateRuntimeModelConfig`
`cancelBackgroundTask` `requestRuntimePreferences`

**Воркспейс** — `workspace/readState` `generateText` `cancelGenerateText`
`upsertModelProvider` `removeModelProvider` `updateProviderRegistry`
`setDefaultModel` `setDefaultMode` `setDefaultThoughtLevel`
`updateInteractionPreferences` `updateModelIoPreferences` `hooks/trustGrant`

**Прочее** — `mcp/list`, `automation/{create,update,delete,list,checkTaskBinding}`,
`artifacts/exec`, `elicitation/create`, `completion/complete`,
`codex/browserUse`, `codex/toolSurface`

Не в app-server: `controller/workspaces` → `-32601` (вероятно, desktop/agent-server).

## Что подтверждено живым вызовом

`workspace/readState` вернул `{ modelCatalog, settings, slashCommands, workspace }`.
`session/list` вернул реальные сессии проекта — включая `sessionId: "claude-import-..."`,
то есть **ZCode уже умеет импортировать сессии Claude Code**.

## Блокер и его решение

`readState` показал причину ошибки `Model config is missing`:

```json
"model": { "current": { "modelId": "missing-model", "providerId": "zcode-unconfigured" } },
"modelCatalog": { "available": [], "providers": [], "revision": 0 }
```

Реестр провайдеров у CLI пуст. Провайдеры desktop-приложения живут в
`~/.zcode/v2/config.json` (активен `builtin:zai-coding-plan`, ключ на месте),
CLI же читает `~/.zcode/cli/config.json`, где блока `provider` нет.

Три способа починить:
1. `node <cli> login` — OAuth Z.AI;
2. перенести блок `provider` в `~/.zcode/cli/config.json`;
3. **`workspace/upsertModelProvider` + `workspace/setDefaultModel`** — плагин
   настраивает себя сам, руками ничего править не нужно. Предпочтительно.

## Протокол двусторонний

Сервер сам шлёт клиенту **запросы** (не только нотификации) — тот же конверт `{id, method, params}`,
клиент обязан ответить `{id, result}`. Пропустишь — ход встанет.

Известный: `session/requestRuntimePreferences`, приходит дважды —
`scope: "runtime-materialization"` при `session/create` и `scope: "user-execution"` при `session/send`.
Ответ: `{ nativeSearchEnhancementsEnabled: boolean }`.

## Жизненный цикл хода

```
workspace/upsertModelProvider  {workspace, provider}
workspace/setDefaultModel      {workspace, model:{providerId, modelId}}
session/create                 {workspace}                     → {session:{sessionId,...}, projection, protocol, runtime, messages}
   ← SRVREQ session/requestRuntimePreferences (scope: runtime-materialization)
session/subscribe              {sessionId, deliveryKind}        → {eventSeq, events}
session/send                   {sessionId, content}             → {accepted, sessionId, stateRevision}
   ← SRVREQ session/requestRuntimePreferences (scope: user-execution)
   ← поток событий
session/usage                  {sessionId}                      → полный учёт токенов
session/close                  {sessionId}                      → {closed: true}
```

`deliveryKind` — только `"desktop-continuous"` или `"web-remote-replayable"`.
`session/subscribe` отдаёт `eventSeq` — по нему поток переигрывается с нужного места после реконнекта.
`session/send` асинхронный: подтверждает приём, результат приходит событиями.

Параметры `subscribe` / `send` / `stop` / `usage` / `events` / `close` берут **только `sessionId`**,
без `workspace` — он там лишний ключ и валидация упадёт.

### Два класса сообщений — не путать

Проверено на живом сервере (`Object.keys(params)` по каждому типу):

**События сессии** — `turn.started`, `turn.completed`, `turn.failed`, `model.streaming`,
`session.updated`, `session.titleUpdated`. Полный конверт
`{eventId, seq, sessionId, turnId, traceId, timestamp, type, deliveryKind, payload}`,
полезная нагрузка **внутри `payload`**.

**Синхронизация состояния** — `state.updated`. Конверт **другой и без `payload`**:
`{patch, reason, revision, scope, sessionId, type, workspace}`, поля плоские.
Ни `eventId`, ни `seq`, ни `turnId` у него нет.

Обобщать доступ через `params.payload ?? params` можно, но понимая, что это два разных
класса, а не один с необязательной обёрткой.

### События (подтверждены живым прогоном)

Общие поля: `eventId`, `seq`, `sessionId`, `turnId`, `traceId`, `timestamp`, `type`, `deliveryKind`.

| Тип | Смысл |
|---|---|
| `state.updated` | `{patch, reason, revision, scope}`, scope `workspace` или `session`; reason вида `prompt_started`, `model_provider_upserted` |
| `turn.started` | `{turnNumber, input, messageId, queryId, foregroundExecutionId}` |
| `turn.failed` | `{error:{type, code, message, detail, attribution:{source, reason, retryable}}}` |
| `session.titleUpdated` | автозаголовок из первого ввода |
| `session.updated` | запуск хуков и плагинов ZCode |

Параллельные служебные каналы, которые можно игнорировать:
`v4/telemetry/event`, `computer-use/operation-event`, `process/mcpTelemetry`.

### Две разные метрики расхода — не путать

Замерено на одном и том же ходе:

| | `turn.completed.payload.usage` | `session/usage` |
|---|---|---|
| охват | один ход, данные провайдера | вся сессия, накопительно |
| `modelRequestCount` | 1 | **2** |
| `totalTokens` | 64747 | 64997 |
| поля только здесь | `source`, `cacheWriteTokens`, `webFetchRequests`, `webSearchRequests` | `modelErrorCount`, `cacheCreationTokens`, `inputBaselineBySource`, `sessionId` |

Расхождение в один запрос — это скрытая генерация заголовка сессии моделью роли `lite`.

**Порядок величин НЕ фиксирован — не полагаться на него.** На одноходовом «PONG» сессия
больше хода. На реальном ревью с шестью обращениями к модели внутри одного хода — наоборот:

```
turn usage:    in=435045, out=5271, total=440316, requests=6
session usage: in=83949,  out=5286, total=89235,  requests=7
```

Причина: `turn` суммирует входные токены **каждого** обращения внутри хода, а контекст от
обращения к обращению растёт, поэтому при нескольких раундах инструментов метрика хода
раздувается. `session` же ведёт учёт с поправкой на базу (`inputBaselineBySource`).

Практический вывод: для оценки **счёта** брать `session`, для оценки **работы внутри хода**
(сколько раундов, сколько реально прожевала модель) — `turn`. И не выводить одну из другой.

**`modelErrorCount` есть только на уровне сессии.** Для учёта стоимости и для проверки,
что модель не сыпала ошибками, нужен `session/usage`; `turn.completed.payload.usage`
отвечает лишь за конкретный ход. Брать оба.

**Ловушка:** sessionId лежит в `result.session.sessionId`. В `result.projection.sessionId`
при создании стоит литеральное `"unknown"` — брать оттуда нельзя.

### События успешного хода (сняты живьём после `zcode login`)

| Тип | Полезная нагрузка |
|---|---|
| `model.streaming` | `{assistantMessageId, delta, done, kind}`, где `kind` — `reasoning_delta` или `text_delta` |
| `turn.completed` | `{response, tokenCount, usage, toolCallCount, historyRoundCount, duration, resultType, cacheStats}` |

**`turn.completed.response` содержит готовый ответ целиком** — накапливать дельты
`model.streaming` не требуется, они нужны только для живого прогресса.

`usage` внутри `turn.completed`: `{source, modelRequestCount, inputTokens, outputTokens,
totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, webFetchRequests, webSearchRequests}`.

Две операционные детали, важные для стоимости:

- Тривиальный ход «ответь PONG» стоил **64728 входных токенов**: ZCode тащит собственный
  системный промпт, 171 инструмент и свои плагины. Любая делегация несёт этот постоянный
  оверхед — дробить задачу на много мелких ходов невыгодно.
- `session.titleUpdated` приходит дважды, второй раз с `source:"generated"` и ролью модели
  `lite` — на генерацию заголовка тратится **отдельный запрос к модели**
  (`modelRequestCount: 2` в `session/usage` против `1` в `turn.completed`).

## Авторизация — итог (исправлено)

**Плагин не должен трогать секреты вообще.** Ранний вывод про `apiKey: {source:"env"}`
снимался на пустом CLI-конфиге и как рекомендация неверен — см. ниже.

У ZCode **две независимые конфигурации**, и мостика между ними нет:

| | конфиг | провайдеры |
|---|---|---|
| Приложение ZCode.app | `~/.zcode/v2/config.json` | настроены, ключ на месте |
| CLI / `app-server`   | `~/.zcode/cli/config.json` | пусто |

Поэтому `app-server` стартует с `providerId: "zcode-unconfigured"`. Проверено, что
пробросить конфиг приложения нельзя: `--settings` для `app-server` отвергается
(и до, и после подкоманды), `ZCODE_DATA_BASE_DIR` реестр провайдеров не наполняет.

**Правильный путь — разовая настройка CLI** (проверено, работает), а не работа плагина в рантайме:

```bash
node /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs login
```

Хранилище учётных данных у CLI и приложения общее (`createSharedZCodeCredentialStore`,
ключи `oauth:active_provider`, `oauth:zai:access_token`, `oauth:zai:refresh_token`,
`zcodejwttoken`; путь настраивается через `ZCODE_DATA_BASE_DIR`).

`login` дописывает в `~/.zcode/cli/config.json` блоки `provider` и `model`, креды кладёт
в общий `~/.zcode/v2/credentials.json`. После этого `workspace/readState` показывает
`providers: [zai]` и текущую модель вместо `zcode-unconfigured`.

**Подтверждено живым ходом:** после `login` полный цикл `session/create` → `subscribe`
→ `send` → `turn.completed` проходит **без единого вызова `upsertModelProvider`
и `setDefaultModel`**. Плагин секретов не касается вообще.

### Модели: каталог врёт, эндпоинт — нет

`login` записывает провайдер `zai` (внутреннее имя — «Z.AI Coding Plan») с моделями
только **`glm-5.1` и `glm-4.7`**. Встроенный каталог
`Resources/model-providers/models_catalog_china_llm_zcode_2026-06-03.json` для
`zai-coding-plan` перечисляет `glm-5.3`, но **`glm-5.3-flash` в нём отсутствует** —
файл устарел, десктопное приложение подтягивает каталог свежее.

**Проверено живыми ходами: и `glm-5.3`, и `glm-5.3-flash` на кодинг-плане работают.**
Эндпоинт тот же (`https://api.z.ai/api/anthropic`), ограничение было только в списке
моделей внутри конфига. Достаточно дописать их в `provider.zai.models`:

```jsonc
"models": { "glm-5.3": {"name":"GLM-5.3"}, "glm-5.3-flash": {"name":"GLM-5.3-Flash"} }
"model":  { "main": "zai/glm-5.3-flash", "lite": "zai/glm-4.7" }
```

Роль `lite` тратится на служебное (генерация заголовка сессии) — держать её дешёвой.
Выбирать модель можно и на сессию, без правки конфига: `session/setModel`
с `{sessionId, model:{providerId, modelId}}`.

Вывод для плагина: **не полагаться на встроенный каталог** при проверке доступности
модели — он может быть старше реального API.

Внимание: `login` даёт провайдер `zai` с моделями **`glm-5.1` и `glm-4.7`** — это не тот
набор, что у десктопного приложения (`builtin:zai-coding-plan` с GLM-5.3). Роли задаются
в конфиге: `model: {main: "zai/glm-5.1", lite: "zai/glm-4.7"}`; `lite` используется для
служебных задач вроде генерации заголовка.

### Что выяснено про ручную регистрацию провайдера

Актуально только как запасной путь, если `login` почему-то не подойдёт.

Поля провайдера: `providerId`, `kind` (`anthropic|openai|openai-compatible`),
`baseURL`, `models:[{modelId}]`, `apiKey`, `apiKeyRequired`.
`apiKeyEnv`, `authKind`, `oauth`, `options`, `auth` — схемой **отвергаются**.

`apiKey` — дискриминированный union по `source`: `{source:"inline", value}` либо
`{source:"env", name}`.

**Важно:** `apiKeyRequired: false` отключает только собственную предполётную проверку
ZCode. Нижележащий Anthropic-SDK всё равно требует токен и берёт его из
**`ANTHROPIC_API_KEY` в окружении процесса** — подтверждено подстановкой пустышки:
ошибка сменилась с «Anthropic API key is missing» на «Client signing credential must
contain one separator», то есть значение дошло до подписи запроса.

## Запросы разрешения зависят от режима сессии

Проверено живым ходом с задачей «создай файл и выполни команду с перенаправлением»:

| режим (`session/setMode`) | запросов `interaction/requestPermission` | файлы записаны |
|---|---|---|
| `build` | 2 — на `Write` и на `Bash` | да |
| `yolo` | **0** | да |

**В режиме `yolo` ZCode разрешений не спрашивает вовсе** — у клиента нет точки контроля.
В `build` каждый вызов с побочным эффектом приходит к клиенту:

```jsonc
{ "toolName": "Write", "toolCallId": "...", "requestId": "perm_...",
  "input": { "file_path": "/abs/path/a.txt", "content": "x" },
  "riskLevel": "medium", "reason": "Tool has side effects and requires approval",
  "options": [ /* allow_once, allow_project, deny — с готовыми ответами */ ] }

{ "toolName": "Bash", "input": { "command": "echo hi > /abs/path/b.txt", "description": "..." },
  "riskLevel": "high", "reason": "High risk tools require explicit approval" }
```

Выводы для плагина:

- Любое ограничение области правок (`--allow`/`--deny`) реализуемо **только** в режимах со
  спросом разрешений; в `yolo` оно невозможно в принципе, и сочетание надо отвергать.
- Автоматическое разрешение через обработчик в `build` даёт то же поведение, что `yolo`,
  но с сохранённой точкой контроля. Поэтому `yolo` при работе через плагин не нужен.
- Для `Write`/`Edit` путь структурирован (`input.file_path`); для `Bash` — только текст
  команды, из которого надёжно извлечь записываемые пути нельзя.

## Оценка уровня 2

Дёшево. Транспорт тривиальный, хендшейка нет, схемы снимаются автоматически,
поверхность методов богаче кодексовской (`usage`, `fork`, `compact`, `goal`,
`setThoughtLevel`, `subagents` — всё из коробки).

Остаётся снять одно: жизненный цикл хода — `session/create` → `session/subscribe`
→ `session/send` → поток событий, плюс форма запроса разрешений. Полдня.

## Архитектура codex-plugin-cc (образец)

```
plugins/codex/
├── .claude-plugin/plugin.json     манифест
├── hooks/hooks.json               SessionStart / SessionEnd / Stop (timeout 900s)
├── commands/*.md                  /codex:review /status /cancel /result /rescue
├── agents/codex-rescue.md         сабагент
├── prompts/  schemas/             шаблоны + structured output
└── scripts/
    ├── codex-companion.mjs        единая точка входа
    ├── stop-review-gate-hook.mjs  ревью-гейт
    └── lib/app-server.mjs         JSON-RPC клиент + брокер на несколько сессий
```

Специфика Codex изолирована в `lib/codex.mjs` и `lib/app-server.mjs` — заменяются целиком.

## Грабли

- CLI внутри `.app` — путь ломается при обновлении/переустановке. Нужен резолвер, не хардкод.
- Порядок аргументов: `--max-turns` после `-p "текст"` отвергается как unknown option.
  Рабочая форма — `--prompt "текст"` и флаги после.
- `session/list` поднимает MCP-серверы воркспейса (видны `process/mcpTelemetry`) — старт не бесплатный,
  тем нужнее брокер с переиспользованием процесса.
- ZCode читает `AGENTS.md` / `CLAUDE.md` из cwd и тянет свои скиллы и плагины.
  Промпты должны быть самодостаточными.
