# Соответствие требованиям commit AI ratio

Документ фиксирует, как реализация `commit_ai_ratio_calculator` соответствует бизнес-требованиям метрики доли AI-кода в git-коммитах.

## Итоговый статус

| Блок требований | Статус | Комментарий |
|---|---|---|
| Фоновый расчет по git-коммитам | Выполнено | Worker обходит workspace git root-ы и анализирует новые reachable commits. |
| Запуск после релиза фичи | Выполнено | При регистрации сохраняется cutoff `kilo.aiRatio.cutoff`; коммиты до cutoff игнорируются. |
| Фильтр по текущему пользователю | Выполнено | Сравниваются `git config user.email` и author email; если email пустой, используется имя. |
| Дедупликация | Выполнено | Processed key строится как `commit_hash + patch_hash`. |
| Recalculate после amend | Выполнено | При amend меняется commit hash или patch hash, поэтому payload отправляется повторно. |
| Расчет по финальному commit diff | Выполнено | AI chunks сопоставляются с реальными added lines из `git show --unified=0`. |
| Agent / Ask / Code Chat | Выполнено как agent flow | Файловые изменения этих режимов проходят через agent tools и сохраняются как `source: "agent"`. |
| Inline completion | Выполнено | VS Code document listener записывает inline contribution records. |
| Manual-only commit | Выполнено | Commit отправляется с нулевыми AI процентами. |
| Revert / deletion commit | Выполнено | Commit без added lines не создает payload. |
| Несколько репозиториев в workspace | Выполнено | Worker анализирует уникальные git root-ы всех workspace folders. |
| Поврежденное локальное хранилище | Выполнено | Битый `.git/kilo-ai-contributions.json` игнорируется без остановки worker-а. |
| Надежная доставка HTTP 200 перед processed | Не реализуется намеренно | По решению надежная доставка не важна; используется текущий fire-and-forget telemetry layer. |
| Полные UI checkpoints before/after | Не требуется | Используется независимый lightweight attribution store, не завязанный на пользовательскую настройку `Enable Snapshots`. |

## Payload

Событие: `git.commit.ai_contribution`.

| Поле | Источник |
|---|---|
| `commit_hash` | Git commit hash. |
| `commit_whole_lines` | Количество added lines в commit diff. |
| `inline_lines` | Количество surviving inline AI lines. |
| `agent_lines` | Количество surviving agent AI lines. |
| `ask_lines` | Оставлено в payload для совместимости; сейчас Ask/Code Chat идут через `agent_lines`. |
| `ai_percent` | Доля AI chars от всех added chars commit-а. |
| `inline_percent` | Доля inline AI chars. |
| `agent_percent` | Доля agent AI chars. |
| `ask_percent` | Доля Ask chars; сейчас ожидаемо `0`. |
| `analyzer_version` | Версия алгоритма расчета. |

## Как считается AI-доля

1. AI-действие записывает contribution record.
2. Record содержит repo, file, source, time, line count, char count, `beforeHash`, `afterHash`, `patchHash` и hashed chunks добавленных строк.
3. Worker берет commit diff через git.
4. Worker фильтрует records по repo, file и временному окну между parent commit и текущим commit.
5. Worker сопоставляет hashed chunks с финальными added lines commit-а.
6. В метрику попадают только AI lines, которые реально дожили до commit-а.

Такой подход покрывает сценарии, где агент сгенерировал код, пользователь часть удалил или вручную отредактировал файл перед commit-ом.

## Покрытие сценариями

| ID | Требование |
|---|---|
| S01 | Игнорирование commit-ов до cutoff и отправка post-cutoff commit-а. |
| S02 | Игнорирование commit-ов другого автора. |
| S03 | Agent tool output попадает в `agent_lines`. |
| S04 | Inline completion попадает в `inline_lines`. |
| S05 | Mixed inline + agent + manual корректно разделяется. |
| S06 | Удаленный до commit-а AI-код не считается. |
| S07 | Reset до запуска worker-а не отправляет уже недостижимый commit. |
| S08 | Amend отправляется повторно из-за нового processed key. |
| S09 | Несколько commit-ов используют свои временные окна attribution. |
| S10 | Revert deletion commit не создает added-code payload. |
| S11 | Дубли одинаковых generated lines считаются по количеству surviving additions. |
| S12 | Несколько workspace репозиториев обрабатываются за один run. |
| S13 | Corrupted attribution storage не ломает worker. |
| S14 | Record по другому файлу не влияет на commit. |
| S15 | Manual-only commit отправляется с нулевыми AI процентами. |
| S16 | Повторный worker run не дублирует уже обработанный commit. |

Подробная матрица пользовательских сценариев находится в `commit-ai-ratio-e2e-scenarios.md`, реализация проверок - в `commit-ai-ratio-e2e.test.ts`.
