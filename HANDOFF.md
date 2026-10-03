# HANDOFF — состояние проекта Orchestra

*Для того, кто продолжит работу: человека или ИИ-агента. Прочитать целиком перед первым изменением.*

**Версия:** 0.5.0 (тег `v0.5.0`) · **дата:** 23.09.2026 · **владелец:** автор репозитория
**Код:** GitHub `VProkhorov7/OrchestraPub` (там пока `v0.4.0`, `v0.5.0` нужно запушить: `git push origin main --tags`), рабочая копия на MacBook `~/Downloads/orchestra`.

---

## 1. Что это и зачем

Сильная модель (Claude или ChatGPT) работает ведущим инженером: планирует, пишет брифы, ревьюит diff и сливает. Дешёвые модели (DeepSeek, GLM, Kimi, MiniMax, Qwen) пишут код как headless Claude Code, каждая в своём git worktree. Цель владельца: максимально дешёвая и контролируемая разработка, где оркестрация идёт по уже оплаченным подпискам, а исполнители стоят центы.

**Решения и предпочтения владельца, которые надо соблюдать:**

- Интерфейс и все сообщения пользователю на русском. Код, комментарии и промпты моделям на английском, но отчёты оркестратор пишет по-русски.
- Инструмент личный, возможно станет open source (MIT). Никаких токенов подписок в коде, только запуск официальных CLI.
- Подписки владельца: **Claude Pro** и **ChatGPT (план K-12 Teachers)** — их он хочет использовать для оркестрации. Исполнители на ключах API или coding-планах.
- Целевая инфраструктура: **Mac mini — сервер** (служба `orchestra serve`, Orca, все CLI и логины, репозитории на внешнем диске). **MacBook — клиент** через Tailscale (веб-панель Orchestra, клиент Orca).
- Статистика расходов и лимитов в духе CodexBar для него важна.
- Для каждой задачи модель-планировщик рекомендуется автоматически, а владелец утверждает её или меняет.
- Подключения: неподключённые в выпадающем списке, подключённые карточками со светофором (зелёный / жёлтый / красный).

## 2. Архитектура

```
Electron (src/main/main.ts, IPC)        orchestra serve (src/server/serve.ts: HTTP, SSE, MCP, статика)
                 \                        /
                  └──────── Hub (src/main/hub.ts) ────────┐   реестр запусков, health, triage, MCP-сессии
                               │                          │
        ┌──────────────────────┼──────────────────┐       │
  Orchestrator (API-цикл)   CliOrchestrator (claude -p / codex exec + MCP по HTTP к движку)
        └──────────┬───────────┘
              TaskEngine (src/main/engine.ts): очередь, worktree, воркеры, diff, merge (с блокировкой), бюджеты
                   │
              worker.ts: запуск `claude -p` с ANTHROPIC_BASE_URL провайдера, stream-json, токены → цена
```

| Файл | Что внутри |
|---|---|
| `src/main/types.ts` | все типы: ProviderConfig (kind, billing), AppConfig (orchestrator, plannerPick, serve), RunState, Health, PlannerChoice, Triage |
| `src/main/catalog.ts` | пресеты подключений (подписки, API, coding-планы) с адресами, моделями, ценами |
| `src/main/config.ts` | загрузка и миграция конфига (старые версии → 0.4+), `anthropicKey()` |
| `src/main/health.ts` | светофор: пинг API на 1 токен, баланс DeepSeek, `claude auth status`, `codex login status`, лимиты из CodexBar |
| `src/main/triage.ts` | выбор планировщика: кандидаты, оценка самой дешёвой зелёной моделью, запасная эвристика, учёт лимитов |
| `src/main/planner.ts` | план: через API (tool-use) или через CLI (JSON в ответе) |
| `src/main/orchestrator.ts` | оркестратор на API: цикл tool-use, кэширование промпта, продолжение, бюджетные предупреждения |
| `src/main/cliorch.ts` | оркестратор на подписке: запускает `claude -p` или `codex exec` с MCP-сервером на 127.0.0.1 |
| `src/main/mcphttp.ts` | MCP по HTTP на один запуск (для CliOrchestrator) |
| `src/main/engine.ts` | TaskEngine: общий для всех способов оркестрации |
| `src/main/hub.ts` | всё без Electron: несколько запусков сразу, продолжение, слияние сохранённых, автопилот, MCP-сессии по репозиторию |
| `src/main/runs.ts` | история на диске (`runs/<id>/run.json`, атомарная запись) |
| `src/main/pricing.ts` | цены Claude, стоимость воркера по токенам, эквивалент по API для подписок и планов |
| `src/main/git.ts` | worktree, diff, merge, `withRepoLock` (очередь в процессе + lock-файл в `.git`) |
| `src/mcp/tools.ts` | MCP-инструменты оркестровки и памяти, общие для stdio и службы |
| `src/mcp/server.ts` | stdio MCP-сервер (один клиент, без службы) |
| `src/server/serve.ts` | служба: токен, REST, SSE, `/mcp?repo=`, автопилот, статика `renderer/`, `--install-launchd` |
| `renderer/` | один интерфейс для Electron (preload) и браузера (`api-web.js` подменяет `window.orch` на fetch и SSE) |
| `src/main/globalkit.ts` | глобальный `~/.claude`: блок принципов в CLAUDE.md, состояние RTK, перенос хука RTK исполнителям (`ORCHESTRA_CLAUDE_HOME` для тестов) |
| `src/main/tariff.ts` | тарифы по времени суток: часы пик, ближайшее льготное окно; `ORCHESTRA_NOW` фиксирует время в тестах |
| `src/memory/guard.ts`, `brief.ts` | сторож прода (PreToolUse) и брифы с утверждением владельца |
| `src/main/doctor.ts`, `service.ts`, `src/doctor/cli.ts` | диагностика и режимы: проверки, план изменений, применить/отменить (снимок в `doctor/last-apply.json`), launchd, `claude mcp add-json/remove` в проектах |
| `src/memory/store.ts` | `ProjectMemory`: факты, решения, JSON-лог, микросессии, журнал, CHANGELOG, поиск и контекст к задаче |
| `src/memory/cli.ts` | команда `orchestra-memory` и обработчики хуков (git и Claude Code) |
| `src/memory/setup.ts`, `templates.ts` | `init`: правила в CLAUDE.md/AGENTS.md, хуки, `.githooks/` |
| `src/memory/prompt.ts`, `summarize.ts` | память в промптах оркестратора, планировщика и воркеров; выжимки дешёвой моделью |
| `src/test/` | автотесты, подставные `claude`, `codex` и API провайдеров |

**Папка данных** (`~/Library/Application Support/Orchestra/` на macOS, `ORCHESTRA_HOME` для переопределения):

- `config.json` — ключи, режим 600;
- `serve.json` — токен службы;
- `runs/` — история;
- `worktrees/` — worktree воркеров;
- `worker-home/<id>/` — отдельный `CLAUDE_CONFIG_DIR` для сторонних провайдеров;
- `logs/serve.log`.

## 3. Команды

```bash
npm install
npm run build          # tsc → dist/
npm run smoke          # все автотесты (6 наборов, около минуты, без сети и ключей)
npm link               # orchestra-memory, orchestra-mcp, orchestra-serve в PATH
npm start              # Electron
npm run serve          # служба; флаги: --host --port --print-token --install-launchd
```

## 4. Что проверено и что нет

**Проверено автотестами** (`npm run smoke`, все зелёные на момент передачи):

- основной цикл API-оркестратора;
- продолжение после закрытия;
- бюджеты;
- stdio MCP;
- светофор на всех типах ответов;
- оркестратор через подписку Claude и Codex (подставные CLI, настоящий MCP по HTTP);
- выбор планировщика;
- служба целиком (токен, REST, SSE, MCP по HTTP, автопилот);
- блокировка слияний;
- миграция конфигов;
- память проекта (`smoke-memory`): init, CLI, git-хуки pre-commit/pre-push, хуки Claude Code, запуск через Hub с памятью, MCP-инструменты памяти, выжимки подставной моделью.

Веб-панель прогнана в настоящем Chromium против настоящей службы, путь «рекомендация → план → запуск → слияние» работает.

**Не проверено на реальных программах и аккаунтах:** в тестах форматы предполагаемые, реальные могут отличаться. Проверять по порядку:

1. `claude auth status`: ожидается JSON с `loggedIn`, `subscriptionType`, `authMethod` (`health.ts`).
2. `claude -p … --mcp-config <файл с type:"http">` плюс `--strict-mcp-config --allowedTools "mcp__orchestra,Read,Grep,Glob,Bash" --disallowedTools "Edit,Write,MultiEdit,NotebookEdit"` и `MCP_TOOL_TIMEOUT` (`cliorch.ts`). Проверить, что оркестратор действительно не может править файлы и что `wait_for` не отваливается по таймауту.
3. Модель через подписку: `--model opus` / `sonnet` на плане Pro (доступен ли Opus в Claude Code на Pro).
4. `codex exec --json`: схема событий (`thread.started`, `item.completed` с `agent_message` / `mcp_tool_call`), флаги `-c mcp_servers.orchestra.url=…`, `bearer_token_env_var`, `tool_timeout_sec`, `codex exec resume <id>`. Отдельно: признаёт ли Codex CLI план K-12 Teachers (известная проблема openai/codex#9454).
5. `codexbar usage --format json --provider all --json-only`: реальная структура JSON (`health.ts: codexBarQuotas`).
6. Usage в stream-json у Claude Code на сторонних адресах: считаются ли токены у DeepSeek, GLM и других (`worker.ts`, дедупликация по `message.id`).
7. Id моделей и адреса новых пресетов: `kimi-k3`, `MiniMax-M3`, `deepseek-flash`, `glm-5.3-flash`, OpenRouter (`catalog.ts`). Баланс DeepSeek `GET /user/balance`.
8. Настольное приложение Electron после переноса логики в Hub (v0.5) не запускалось: проверены только тот же интерфейс в браузере и типы. Прогнать `npm start`.
9. `--install-launchd` на реальном macOS: PATH в plist, автозапуск после перезагрузки.
10. Память на macOS: хуки читают сообщение коммита из аргументов родительского `git commit` через `ps` (на Linux через `/proc`). Проверить кириллицу в сообщении и коммит из Orca (GUI-приложение, урезанный PATH — в хуке добавлены `/opt/homebrew/bin` и `/usr/local/bin`).
11. Формат ввода хуков Claude Code (`session_id`, `prompt`, `tool_name`, `tool_input`) и `additionalContext` в ответе на реальной версии.

## 5. Известные ограничения и риски

- Исполнители работают с `--dangerously-skip-permissions` на машине владельца (изоляция только на уровне git). Для чужих задач нужна песочница (см. ROADMAP).
- Codex как оркестратор запускается с `--dangerously-bypass-approvals-and-sandbox`: без этого `codex exec` отклоняет MCP-вызовы (openai/codex#24135).
- Запрет оркестратору править код держится на инструкции и `--disallowedTools`, но у него есть Bash.
- Настольное приложение и служба на одной машине с общей папкой данных работают, но так делать не стоит: две очереди.
- Цены в пресетах актуальны на сентябрь 2026. У DeepSeek дневные и ночные тарифы не учитываются.
- Anthropic может ввести отдельные кредиты для `claude -p` и Agent SDK (изменение от 15 июня 2026 приостановлено). Тогда оркестрация по подписке станет платной сверх лимита.
- Worktree воркеров лежат в папке данных, не в репозитории. Orca может показывать их в своём списке.

## 6. Что делать дальше (по приоритету)

1. **Запушить `v0.6.0`** на GitHub и заполнить поле About (текст ниже).
1a. **Память в проектах** на Mac mini: `npm link` в Orchestra, затем `orchestra-memory init` в каждом своём проекте. Прочитать существующие `wiki/` проектов, создать общую wiki для группы проектов (начальное состояние и все принятые решения) и заполнить `.memory/facts.json` и `logic.json`. Инструкция: [docs/MEMORY.md](docs/MEMORY.md).
2. **Проверка на реальных аккаунтах** по пункту 4 на Mac mini: подписка Claude как оркестратор, DeepSeek как исполнитель, один маленький реальный запуск. Исправить форматы, если отличаются.
3. **Тестовый шлюз**: команда тестов проекта запускается в worktree после каждого воркера, при падении воркер получает одну попытку исправить (ROADMAP v0.4).
4. **Экран статистики**: расходы и лимиты по дням и моделям, из истории запусков и `codexbar cost --format json`. Процент слитых задач и цена одной слитой задачи по каждому исполнителю.
5. **Исполнители в терминалах Orca** как дополнительный способ запуска: `orca terminal create/wait/read` вместо фонового `claude -p`, чтобы видеть их в Orca.
6. Worktree внутри репозитория (`.orchestra/worktrees`, в `.gitignore`), по желанию владельца.
7. Остальное по [ROADMAP.md](ROADMAP.md): турнир best-of-N, дешёвый первый ревьюер, задачи из GitHub Issues, песочница.

## 7. Правила работы с кодом

- Перед коммитом: `npm run build && npm run smoke`, все наборы должны быть зелёными. Новая функциональность приходит вместе с тестом в `src/test/` на подставных CLI и API.
- Секретов в репозитории нет и быть не должно. Ключи только в `config.json` в папке данных.
- Сообщения коммитов по-английски, объясняют «зачем». Автор — владелец, соавтор-ИИ указывается строкой `Co-Authored-By`.
- Новый провайдер добавляется одним пресетом в `catalog.ts` (адрес, модель, цены, роли, подсказка). Остальное подхватится само.
- Любой запуск модели через подписку идёт только через официальный CLI (`cliEnv()` убирает API-ключи из окружения).

## 8. Для GitHub

**About (описание, до 350 символов):**
> Сильная модель планирует и ревьюит, дешёвые пишут код. Claude или ChatGPT (по подписке или API) ведёт задачу, DeepSeek / GLM / Kimi / MiniMax / Qwen работают как headless Claude Code в отдельных git worktree. Бюджеты, светофор подключений, история, веб-панель и MCP для любого ИИ-агента.

**English (если репозиторий станет публичным):**
> Lead model plans and reviews, cheap models write the code. Claude or ChatGPT orchestrates DeepSeek, GLM, Kimi, MiniMax and Qwen workers running as headless Claude Code in isolated git worktrees, with budgets, health checks, run history, a web panel and an MCP server.

**Topics:** `ai-agents` `claude-code` `orchestration` `mcp` `deepseek` `glm` `llm` `developer-tools` `git-worktree` `electron`

## 9. История версий

| Версия | Что появилось |
|---|---|
| 0.2.1 | оркестратор на API, роли, автоплан, русский интерфейс |
| 0.3.0 | история и продолжение запусков, бюджеты, stdio MCP, кэширование промпта |
| 0.4.0 | оркестратор по подписке (Claude Code, Codex), каталог подключений, светофор |
| 0.5.0 | служба `orchestra serve` (веб-панель, MCP по HTTP, автопилот), Hub, выбор планировщика с подтверждением, блокировка слияний |
| 0.7.3 | принципы Карпатого (проекты, исполнители, глобально через диагностику с отменой), проверка RTK, RTK у исполнителей |
| 0.7.2 | тарифы по времени суток (DeepSeek), расход по тарифу в момент работы, запуск «В льготное время» (отложенный старт, задачи ждут окончания часов пик), индикатор тарифа |
| 0.7.1 | сторож прода (хук + фраза владельца), исполнители без ключей к проду, бриф с утверждением по версии, `wiki/INVARIANTS.md`, роли `scout/applier/reviewer`, «почему» в журнале, передача смены ≤3+1, отчёт исполнителя DONE/WHY/RISKS/VERIFY |
| 0.7.0 | диагностика и режимы Orca/Orchestra (`Orchestra.command`, `orchestra-doctor`, вкладка «Диагностика», применить/отменить), новый интерфейс «пульт управления» |
| 0.6.0 | память проекта: wiki, журнал микросессий, факты и решения в `.memory/`, JSON-лог, CHANGELOG по этапам, git-хуки и хуки Claude Code, `orchestra-memory` |


## Напоминание: праздники Китая для тарифа DeepSeek

В `src/main/tariff.ts` (`DEEPSEEK_PEAK.holidays`) праздники 2027 внесены **предварительно** (03.10.2026): только дни, где сошлись два прогноза. Госсовет КНР публикует официальное расписание в начале ноября 2026 — **в ноябре 2026 сверить и заменить**, затем каждый год в ноябре добавлять следующий (правило DeepSeek: часы пик «кроме государственных праздников Китая»).
