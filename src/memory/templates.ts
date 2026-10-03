/** Text blocks `orchestra-memory init` writes into a repository. */
import type { Lang } from './lang';
import { RULES_START, RULES_END, GLOBAL_START, GLOBAL_END, COMMAND_MARK } from './markers';
export { RULES_START, RULES_END, GLOBAL_START, GLOBAL_END, COMMAND_MARK };
import { AGENT_RULES_EN, GLOBAL_RULES_EN, ORCHESTRA_COMMAND_EN, INVARIANTS_TEMPLATE_EN, GIT_HOOK_COMMENT_EN, GIT_HOOK_PATH_COMMENT_EN } from './templates-en';


/**
 * Rules for every AI agent working in the repo (Claude Code reads CLAUDE.md, Codex and others read AGENTS.md).
 * Kept between markers so `init` can update them without touching the owner's own text.
 */
export const AGENT_RULES = `${RULES_START}
## Память проекта, wiki и логи (обязательно)

В репозитории есть память проекта. Её ведут все агенты, в каждой сессии.

**Новая задача.** Если владелец пишет \`/orchestra <задача>\` — следуй этой команде: память → бриф → утверждение → Orchestra или сам. Если задача большая и поставлена без неё, предложи оформить её через \`/orchestra\`.

**Перед задачей.** Выполни \`orchestra-memory context "<суть задачи>"\` (или MCP-инструмент \`memory_context\`). Там факты (что уже известно и сделано) и решения (почему сделано именно так). Не переделывай то, что уже сделано. Не нарушай принятые решения молча: если решение нужно пересмотреть, запиши новое с причиной (\`--supersedes D-xxxx\`).

**Во время работы.**
- Новый установленный факт: \`orchestra-memory add-fact "<факт>" --tags a,b --files путь\`.
- Принятое решение: \`orchestra-memory add-decision --title "…" --decision "…" --why "…" [--alt "отвергнутый вариант"] [--files …] [--facts F-0001]\`.
- Заметное действие (фича, исправление, тесты, деплой, безопасность): \`orchestra-memory log --type feature|fix|change|security|test|deploy|docs|note --files … "<что сделано>"\`. Правки файлов и команды пишутся в лог автоматически.
- **wiki** (\`wiki/\`): обновляй страницы, которых касается изменение (архитектура, API, решения, состояние проекта). Код без обновления wiki считается незаконченным.

**Микросессия = 30–40 минут.** Когда хук напомнит, что время вышло, или задача закончена, закрой сессию:
\`\`\`
orchestra-memory session-end --summary "<2–3 понятных предложения для владельца>" \\
  --done "<пункт>" --done "<пункт>" --why "<почему так>" \\
  --gate "<обязательно до следующей задачи>" (не больше трёх) --next "<ровно одна следующая задача>" \\
  --details '<JSON с подробностями для ИИ: файлы, команды, результаты тестов, открытые вопросы>'
\`\`\`
Получаются две записи: короткая понятная в \`wiki/JOURNAL.md\` и подробная JSON в \`.memory/log/\`. Обязательных пунктов не больше трёх и следующая задача ровно одна: важное тонет в длинных списках, остальное — ссылкой в \`wiki/status/current.md\`.

**Журнал с «почему».** \`orchestra-memory log\` для feature, fix, change, security, deploy, refactor, removed требует \`--why\`. Ручная чистка данных, после которой причина осталась, — тип \`cleanup\`, не \`fix\`: иначе следующий повтор прочитают как «мы же уже чинили».

**Инварианты.** \`wiki/INVARIANTS.md\` — то, что не должно стать неправдой никогда. Сверяй с ними каждое изменение. Тест, который стережёт инвариант, готов только когда краснеет при намеренном проломе именно этого места.

**Прод.** Выкладку, команды с \`--remote\`, секреты воркера, запуск workflow и push, который выкладывает прод, останавливает сторож прода (хук). Не обходи его: объясни владельцу, что сделает команда, и попроси написать «разрешаю прод».

**Роли.** Для разведки по коду — роль \`scout\` (дешёвая модель, только чтение), для применения готового плана — \`applier\`, для проверки diff — \`reviewer\`. Механическую работу не делай дорогой моделью.

**CHANGELOG.** После завершения этапа или по просьбе владельца: \`orchestra-memory changelog --draft\` покажет значимые события с прошлого раза. Напиши по ним краткую выжимку для людей, сгруппированную по Added / Changed / Fixed / Security / Removed, без мелких технических деталей, и сохрани: \`orchestra-memory changelog --write <файл.md>\` (или \`--release "<этап>"\`).

**«Дай свежую выжимку».** Выполни \`orchestra-memory digest\` и перескажи последние записи коротко и по-русски: что сделано, что решено, что дальше.

**Коммит и push.** Память (\`.memory/\`), \`wiki/\` и \`CHANGELOG.md\` автоматически добавляются в каждый коммит git-хуком. Если \`git push\` остановится с сообщением «память дописана отдельным коммитом», просто повтори push. Или сразу используй \`orchestra-memory push\`.

**Как работать (эти правила — последние нарочно: в середине длинного текста правило перестаёт работать).**
- **Сначала разбор, потом работа.** Любое поручение, даже жалобу, сначала разбери вслух: суть, твоё мнение с цифрой, если есть, вопрос, если что-то неясно. Называй допущения; если задачу можно понять по-разному — покажи варианты, не выбирай молча. Потом делай. Согласие — тоже позиция: скажи, с чем согласен и почему.
- **Простота прежде всего.** Ничего сверх просьбы: никаких «на будущее», абстракций ради одного места, лишней обработки ошибок. Если 200 строк можно написать в 50 — перепиши.
- **Хирургические правки.** Трогай только то, что нужно задаче. Не улучшай соседний код и форматирование без просьбы, держи стиль файла. Удаляй только то, что стало лишним из-за твоих правок.
- **От цели.** Задачу переводи в проверяемые критерии успеха и короткий план с точками проверки; работай, пока критерии не выполнены и не проверены.
- **Лечи причину устройством, а не обещанием.** Признаки костыля: правка в одном месте из нескольких, «буду внимательнее», «пока так». Нужна конструкция, в которой ошибка невозможна.
- **«Готово» — только с фактом.** Существование не равно работе: зелёные тесты и строка в конфиге не доказывают, что это хоть раз сработало. Назови вывод команды, ответ сайта или запись в базе.
- **Честный отчёт.** «Не запускалось», «пропущено», «упало» — прямо и с выводом, без смягчений.
- **Необратимое — вопрос владельцу.** Обратимое делай сам малыми шагами, каждый проверяй до следующего.
${RULES_END}
`;

export const GIT_HOOK = (name: string, lang?: Lang) => `#!/bin/sh
${lang === 'en' ? GIT_HOOK_COMMENT_EN : '# orchestra-memory: память проекта и wiki уходят в git вместе с каждым коммитом.\n# Сначала выполняется прежний хук из .git/hooks, если он был.'}
HOOKS_DIR="$(git rev-parse --git-common-dir)/hooks"
if [ -x "$HOOKS_DIR/${name}" ]; then "$HOOKS_DIR/${name}" "$@" || exit $?; fi
[ -n "$ORCHESTRA_MEMORY_OFF" ] && exit 0
${lang === 'en' ? GIT_HOOK_PATH_COMMENT_EN : '# Приложения, запущенные из Dock (Orca, GUI-клиенты git), получают урезанный PATH.'}
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.npm-global/bin:$HOME/.local/bin"
command -v orchestra-memory >/dev/null 2>&1 || exit 0
exec orchestra-memory hook ${name} "$@"
`;

/** Claude Code hooks for the project (.claude/settings.json). Missing binary = silent no-op. */
export const CLAUDE_HOOKS = {
  // Prod guard first: it may refuse the call (see guard.ts).
  PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit', hooks: [{ type: 'command', command: 'command -v orchestra-memory >/dev/null && orchestra-memory hook guard || true', timeout: 15 }] }],
  SessionStart: [{ hooks: [{ type: 'command', command: 'command -v orchestra-memory >/dev/null && orchestra-memory hook session-start || true', timeout: 20 }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'command -v orchestra-memory >/dev/null && orchestra-memory hook prompt || true', timeout: 20 }] }],
  PostToolUse: [{ matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash', hooks: [{ type: 'command', command: 'command -v orchestra-memory >/dev/null && orchestra-memory hook tool || true', timeout: 20 }] }],
  SessionEnd: [{ hooks: [{ type: 'command', command: 'command -v orchestra-memory >/dev/null && orchestra-memory hook session-end || true', timeout: 30 }] }],
};

/** Marker: the command file is ours and may be updated by `orchestra-memory init` / diagnostics. */

/**
 * Claude Code project command `/orchestra <задача>`: a task is set up the same way every time —
 * project memory first, then a brief the owner approves, then Orchestra (or this session) does it.
 */
export const ORCHESTRA_COMMAND = `---
description: Поставить задачу по порядку — память проекта, бриф, утверждение, затем Orchestra или сам
argument-hint: <что нужно сделать>
---
${COMMAND_MARK}
Задача владельца: $ARGUMENTS

Работай строго по шагам. Владелец не программист: пиши по-русски, простыми словами.

## 1. Что уже известно
- Прочитай память проекта по теме задачи: инструмент \`memory_context\` (если подключена Orchestra) или \`orchestra-memory context "<суть задачи>"\` в терминале.
- Прочитай \`wiki/status/current.md\`, \`wiki/INVARIANTS.md\` и страницы wiki, которые касаются задачи.
- Посмотри код ровно настолько, чтобы понять, где будут изменения. Ничего не меняй.
- Если задача уже сделана или противоречит принятому решению — скажи об этом и остановись.

## 2. Бриф
Составь бриф, **сохрани его файлом** \`.memory/briefs/<ГГГГ-ММ-ДД>-<коротко-латиницей>.md\` (план, который живёт только в разговоре, пропадает с \`/clear\`) и покажи владельцу целиком. Разделы — ровно эти заголовки:

**Цель** — одно-два предложения: что должно получиться для человека.
**Что уже известно** — факты и решения из памяти, которые важны (с номерами F-… и D-…).
**Границы** — что не трогаем; прод, миграции, боевые флаги и секреты не меняются без явного «да».
**Подзадачи** — пронумерованный список. У каждой: что сделать, какие файлы, роль (фича, багфикс, тесты, рефакторинг, документация), от каких подзадач зависит. Последняя подзадача — обновить wiki.
**Готово, когда** — проверяемые критерии.
**Как проверить** — команды тестов и что посмотреть глазами.
**Вопросы** — что нужно решить владельцу (если нет — «нет»).

В брифе не должно быть TODO, TBD, «уточнить позже». Проверь: \`orchestra-memory brief check <файл>\` — он скажет, чего не хватает.

## 3. Утверждение
Спроси: «Утверждаете бриф? И как делаем: А — раздать исполнителям через Orchestra, я проверяю и сливаю; Б — отдать Orchestra целиком (автопилот); В — сделаю сам в этой сессии».
Если инструментов Orchestra нет (\`list_workers\`, \`autopilot_start\`), предложи только В и скажи, что Orchestra выключена (включить: Orchestra.command → пункт 1).
**Не начинай, пока владелец явно не ответил.** Утверждение записывает хук, когда владелец пишет «утверждаю»: оно привязано к версии файла брифа. Изменил бриф после утверждения — утверждение сброшено, покажи что поменялось и попроси снова. Перед выполнением: \`orchestra-memory brief check <файл>\` должен сказать «утверждён».

## 4. Выполнение
- **А.** \`list_workers\` → для каждой подзадачи \`delegate\` (spec = подзадача + цель + границы + инварианты + «готово, когда» из брифа; роль и исполнитель — подходящие) → \`wait_for\` → \`get_diff\` → проверь по критериям → \`merge_task\` или \`discard_task\` с объяснением. После слияний — тесты. В конце \`end_session\`.
- **Б.** \`autopilot_start\` с целью = весь бриф; дальше \`run_status\`, пока не закончится. Если просит подтвердить модель — покажи владельцу рекомендацию.
- **В.** Делай по подзадачам по порядку, после каждой — проверка. Разведку отдавай роли \`scout\`, проверку diff — \`reviewer\`.
- После каждой законченной подзадачи отмечай её в файле брифа (\`- [x]\`), чтобы работа пережила обрыв сессии.

## 5. Итог
- Отчёт владельцу: 2–3 фразы что сделано, затем «Сделано:» и «Дальше:» списком.
- Новые факты — \`memory_add_fact\` / \`orchestra-memory add-fact\`; новые решения с причиной — \`memory_add_decision\` / \`orchestra-memory add-decision\`.
- Обнови \`wiki/status/current.md\`.
- Закрой микросессию: \`memory_session_end\` / \`orchestra-memory session-end --summary "…" --done "…" --gate "…" --next "<одна задача>"\`.
`;

/** Starter wiki/INVARIANTS.md (Skaro's invariants plus prod guards): what must never become false. */
export const INVARIANTS_TEMPLATE = (project: string) => `# Инварианты: ${project}

То, что не должно стать неправдой **никогда**. Агенты сверяют с этим списком каждое изменение, Orchestra даёт его каждому исполнителю и проверяет по нему diff перед слиянием.

Как писать: одна строка — одно утверждение «никогда …» или «всегда …»; в скобках — чем это проверяется (тест, хук, CI). Тест, который стережёт инвариант, готов, только когда краснеет при намеренном проломе именно этого места. Менять или снимать инвариант — только решением с причиной (\`orchestra-memory add-decision\`).

- Прод меняется только после явного разрешения владельца (сторож прода).
- Секреты не попадают в код, wiki и память — только их имена.
- Миграции базы только добавляются; применённую миграцию не правят (новая миграция вместо правки).
<!-- Допишите свои: например, «ни один защищённый путь не отдаёт данные без входа и принятого NDA» (тест …). -->
`;

/** Claude Code subagent roles with a pinned model. English: only a model reads them. */
export const AGENT_ROLES: Record<string, string> = {
  scout: `---
name: scout
description: Cheap read-only reconnaissance. Use for finding where something lives in the code, listing files, reading config, summarizing a module before a change. Never edits.
tools: Read, Grep, Glob, Bash
model: haiku
---
<!-- orchestra-role v1 -->
You are a read-only scout. Answer exactly the question asked with file paths and line numbers.
- Do not edit, write or delete files. Bash only for read-only commands (ls, cat, grep, git log/show/diff).
- Never run deploy, migration, secret or push commands.
- Report facts only; if you could not verify something, say "could not verify" and why.
- Keep the answer under 300 words unless asked otherwise.
`,
  applier: `---
name: applier
description: Applies an already decided plan or patch mechanically - renames, moving code, repetitive edits, updating call sites, writing straightforward tests from a given spec. Use when the decision is made and only execution remains.
model: sonnet
---
<!-- orchestra-role v1 -->
You apply a plan that is already decided. Do not redesign.
- Follow the given steps exactly; if a step is ambiguous or wrong, stop and report instead of guessing.
- Small steps; run the project's tests after the change and show the output.
- Never run deploy, --remote, secret or push commands.
- Final report: what changed (files), how it was verified (command + result), anything skipped and why.
`,
  reviewer: `---
name: reviewer
description: Reviews a diff before merge against the task brief, wiki/INVARIANTS.md and recorded decisions. Use before merging any non-trivial change.
tools: Read, Grep, Glob, Bash
model: opus
---
<!-- orchestra-role v1 -->
You review a diff; you do not fix it.
- Check against: the brief's "done when", wiki/INVARIANTS.md, decisions in .memory/logic.json (orchestra-memory context "<topic>").
- Look for: broken invariants, missing tests for changed behaviour, a test that would stay green if the protected code were removed, secrets in the diff, migrations edited instead of added, silent fallbacks to empty values.
- Verdict first: MERGE / FIX / REJECT, then numbered findings with file:line and why.
- Say plainly what you could not verify.
`,
};

/**
 * Global block for ~/.claude/CLAUDE.md: Karpathy's four coding principles (github.com/multica-ai/andrej-karpathy-skills, MIT),
 * short, in Russian for the owner. Between markers so diagnostics can add, update and undo it without touching the rest.
 */
export const GLOBAL_RULES = `${GLOBAL_START}
## Как писать код (принципы Карпатого, для всех проектов)

1. **Думай до кода.** Называй допущения. Если задачу можно понять по-разному — покажи варианты, не выбирай молча. Есть путь проще — скажи. Неясно — остановись и спроси.
2. **Простота прежде всего.** Ничего сверх просьбы: никаких «на будущее», абстракций ради одного места, лишней обработки ошибок. 200 строк, которые можно написать в 50, — переписать.
3. **Хирургические правки.** Трогай только нужное. Не улучшай соседний код и форматирование без просьбы, держи стиль файла. Удаляй только то, что стало лишним из-за твоих правок.
4. **От цели.** Переводи задачу в проверяемые критерии успеха и короткий план с точками проверки; работай, пока критерии не выполнены и не проверены. «Готово» — только с фактом: вывод команды, ответ, запись.

Отчёты владельцу — по-русски, простыми словами. Прод, миграции и секреты — только после его явного «да».
${GLOBAL_END}
`;

// ---------- language selectors: the workflow follows the RU/EN switch (see lang.ts) ----------

export const agentRules = (lang?: Lang) => (lang === 'en' ? AGENT_RULES_EN : AGENT_RULES);
export const globalRules = (lang?: Lang) => (lang === 'en' ? GLOBAL_RULES_EN : GLOBAL_RULES);
export const orchestraCommand = (lang?: Lang) => (lang === 'en' ? ORCHESTRA_COMMAND_EN : ORCHESTRA_COMMAND);
export const invariantsTemplate = (project: string, lang?: Lang) => (lang === 'en' ? INVARIANTS_TEMPLATE_EN(project) : INVARIANTS_TEMPLATE(project));
