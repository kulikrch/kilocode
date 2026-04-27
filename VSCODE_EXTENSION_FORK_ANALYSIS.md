# Анализ форка под только VS Code Extension

Дата анализа: 2026-04-27
Репозиторий: `kilocode`
Цель: выделить минимально необходимую часть монорепозитория для самостоятельного развития только `packages/kilo-vscode`.

## 1) Ключевой факт архитектуры

VS Code расширение не содержит AI runtime внутри себя. Оно всегда поднимает отдельный CLI backend (`kilo serve`) из встроенного бинарника `bin/kilo` и работает с ним по HTTP/SSE через SDK типы.

Что это означает практически:
- Без CLI бинарника расширение нерабочее.
- Любые API изменения CLI рано или поздно потребуют обновления SDK (`@kilocode/sdk`).

Подтверждение:
- `packages/kilo-vscode/src/services/cli-backend/server-manager.ts` (spawn `kilo serve --port 0`, путь к `bin/kilo`)
- `packages/kilo-vscode/src/services/cli-backend/connection-service.ts` (использует `createKiloClient` из `@kilocode/sdk/v2/client`)

## 2) Что обязательно нужно переносить

Ниже список для рабочего форка расширения (с сохранением текущей сборки и тестов).

| Компонент | Зачем нужен |
|---|---|
| `packages/kilo-vscode/` | Собственно extension, webview, команды, packaging, тесты |
| `packages/sdk/js/` (`@kilocode/sdk`) | Типы и клиент для общения extension ↔ CLI |
| `packages/kilo-ui/` (`@kilocode/kilo-ui`) | Компоненты webview UI |
| `packages/ui/` (`@opencode-ai/ui`) | Транзитивно нужен `kilo-ui`; также используется напрямую для provider icons |
| `packages/shared/` (`@opencode-ai/shared`) | Транзитивная зависимость `kilo-ui` и `ui` |
| `packages/kilo-i18n/` | Локали/переводы в webview |
| `packages/opencode/` ИЛИ источник готовых CLI артефактов | Нужен бинарник `kilo` для runtime |

Подтверждение по зависимостям:
- `packages/kilo-vscode/package.json`: workspace зависимости на `@kilocode/kilo-i18n`, `@kilocode/kilo-ui`, `@kilocode/sdk`, `@opencode-ai/ui`.
- `packages/kilo-ui/package.json`: зависимость на `@opencode-ai/ui` и `@opencode-ai/shared`.
- `packages/ui/package.json`: зависимость на `@kilocode/sdk` и `@opencode-ai/shared`.

## 3) Что можно НЕ переносить (если цель только VS Code extension)

В типовом сценарии не нужны:
- `packages/app/` (web client)
- `packages/desktop/`, `packages/desktop-electron/` (desktop clients)
- `packages/kilo-jetbrains/` (JetBrains plugin)
- `packages/kilo-docs/` (документация)
- большая часть root CI/workflows, не относящаяся к extension
- любые product-ветки, которые не участвуют в сборке extension

Важно: если вы оставляете `packages/opencode/` для сборки CLI из исходников, тогда транзитивно могут понадобиться и его workspace-зависимости (`kilo-gateway`, `kilo-telemetry`, `plugin`, `script`) как часть backend toolchain.

## 4) Два практичных варианта форка

## Вариант A: Минимальный форк "только extension как продукт"

Идея:
- Не развивать CLI в этом форке.
- Хранить/подкладывать готовый CLI бинарник(и) в `packages/kilo-vscode/bin` или отдельный artifacts pipeline.
- SDK фиксировать на совместимой версии (без локальной регенерации в каждом цикле).

Что нужно изменить в скриптах:
- Сейчас `compile/package/watch` в `packages/kilo-vscode/package.json` вызывают `rebuild-sdk` и `prepare:cli-binary`.
- `prepare:cli-binary` (`script/local-bin.ts`) по умолчанию ожидает соседний `packages/opencode` и при отсутствии пытается его собрать.
- Для truly-minimal форка нужно:
  - либо отключить автосборку CLI из `opencode`;
  - либо заменить на стратегию "используй уже готовый binary/artifact".

Плюсы:
- Сильно меньше кодовой базы и конфликтов.
- Быстрее CI.

Минусы:
- Вы зависите от внешнего жизненного цикла CLI.
- При несовместимости API придется вручную синхронизировать SDK/CLI версии.

## Вариант B: Extension + полный контроль над CLI

Идея:
- Оставить `packages/opencode` и его внутренние зависимости.
- Продолжать локально собирать `kilo` и регенерировать SDK как в исходном монорепо.

Плюсы:
- Полный контроль и синхронное развитие extension/backend.

Минусы:
- Существенно больший объем переносимого кода.
- Сложнее поддержка форка.

## 5) Что НЕ нужно для runtime даже в extension форке

Для уже собранного `.vsix` runtime-пакета нужны только артефакты:
- `dist/**`
- `bin/**`
- `assets/**`
- `package.json` и метаданные extension

Это прямо видно в `.vscodeignore`: исходники `src/**`, `webview-ui/**`, `script/**` исключаются, `dist/**` и `bin/**` включаются.

## 6) Точки риска при переносе

1. SDK drift
- `packages/sdk/js/script/build.ts` берет OpenAPI из `packages/opencode`.
- Если CLI меняется быстрее SDK в вашем форке, поймаете runtime/typing рассинхрон.

2. Хрупкость `local-bin.ts`
- Скрипт рассчитан на соседний `packages/opencode`.
- Без правки этого скрипта минимальный форк будет ломаться на `prepare:cli-binary`.

3. Тесты extension смотрят за пределы пакета
- Пример: `tests/unit/i18n-keys.test.ts` импортирует `../../../kilo-i18n/src/*`.
- Если вы вырежете `kilo-i18n`, тестовый контур нужно адаптировать.

4. UI dependency chain
- Даже если прямых импортов `@opencode-ai/ui` мало, он нужен транзитивно через `kilo-ui`.

## 7) Рекомендованный состав форка

Если задача: "развивать только VS Code extension, но без слома существующего DX", рекомендую стартовый состав:
- оставить: `packages/kilo-vscode`, `packages/sdk/js`, `packages/kilo-ui`, `packages/ui`, `packages/shared`, `packages/kilo-i18n`
- оставить временно: `packages/opencode` (пока не стабилизируете внешний канал CLI артефактов)
- убрать сразу: `packages/app`, `packages/desktop`, `packages/desktop-electron`, `packages/kilo-jetbrains`, `packages/kilo-docs`

После стабилизации pipeline CLI binaries можно удалить `packages/opencode` из этого форка и упростить скрипты в `kilo-vscode`.

## 8) Чеклист миграции

1. Скопировать минимальный набор пакетов из раздела 7.
2. Проверить `bun install` и разрешение workspace ссылок.
3. Прогнать в `packages/kilo-vscode`:
   - `bun run typecheck`
   - `bun run lint`
   - `bun run test:unit`
4. Выбрать стратегию CLI:
   - временно local build из `opencode`, или
   - внешний binary artifacts pipeline.
5. Если выбираете внешний pipeline:
   - переписать `script/local-bin.ts` и скрипты `compile/package/watch` чтобы не требовали `packages/opencode`.
6. После этого удалить лишние пакеты и зафиксировать новый CI только под extension.

---

Если нужно, следующим шагом могу подготовить отдельный "план вырезания `packages/opencode`" с конкретными патчами в `packages/kilo-vscode/package.json` и `script/local-bin.ts`.