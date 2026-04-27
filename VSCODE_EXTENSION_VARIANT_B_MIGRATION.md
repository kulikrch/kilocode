# Вариант B: Extension + CLI (полный контроль)

Дата: 2026-04-27  
Ветка: `chore/vscode-cli-fork-variant-b`

## Что уже сделано в этой ветке

1. Создана отдельная ветка от текущего состояния репозитория.
2. Добавлена автоматизация подготовки форка под `Вариант B`:
   - `script/fork-variant-b.ts`
   - `package.json` scripts:
     - `fork:variant-b:plan`
     - `fork:variant-b:create`
3. Скрипт генерирует manifest зависимостей и может развернуть отдельный scaffold форка.
4. Сгенерирован manifest: `fork/variant-b/manifest.json`.
5. Создан отдельный scaffold: `c:\\Users\\rocks\\work\\gigacode\\kilocode-vscode-cli-fork`.

## Фактический статус прогонов

1. В текущем репозитории (`kilocode`):
   - `bun run --cwd packages/kilo-vscode lint`: проходит
   - `bun run --cwd packages/kilo-vscode typecheck`: падает (локальная проблема резолва `solid-js/web`)
   - `bun run --cwd packages/kilo-vscode test:unit`: есть падения и Windows-специфичные `EPERM`

2. В новом scaffold (`kilocode-vscode-cli-fork`):
   - `bun install`: в этом окружении падает на `tree-sitter-powershell` (`node-gyp` / `tar`)
   - `bun install --ignore-scripts`: проходит (использовалось для валидации)
   - `bun run --cwd packages/kilo-vscode typecheck`: проходит
   - `bun run --cwd packages/kilo-vscode lint`: проходит
   - `bun run --cwd packages/kilo-vscode test:unit`: частично падает из-за Windows/file-lock/git-shell условий (`EPERM`, shell/git env tests)

## Как пройти чеклист миграции (исполняемо)

1. Сгенерировать manifest:
```bash
bun run fork:variant-b:plan
```

2. Посмотреть состав:
- `fork/variant-b/manifest.json`
- `fork/variant-b/README.md`

3. Создать отдельный контур форка:
```bash
bun run fork:variant-b:create
```

По умолчанию scaffold создается в `../kilocode-vscode-cli-fork`.

4. В новом контуре проверить базовую работоспособность:
```bash
bun install
bun run --cwd packages/kilo-vscode typecheck
bun run --cwd packages/kilo-vscode lint
bun run --cwd packages/kilo-vscode test:unit
```

Если `bun install` блокируется на native postinstall (как в текущем окружении), временно:
```bash
bun install --ignore-scripts
```
и затем запустить проверки.

5. Проверить extension + встроенный CLI:
```bash
bun run extension
```

## Что кладет `fork:variant-b`

1. Пакеты по workspace dependency-closure от seed:
   - `kilo-code` (`packages/kilo-vscode`)
   - `@kilocode/cli` (`packages/opencode`)
2. Root-конфиги и служебные файлы для сборки/CI.
3. `patches/` (для корректной установки зависимостей).

## Примечания

1. `Вариант B` намеренно сохраняет CLI внутри контура, чтобы API backend и extension эволюционировали синхронно.
2. При изменениях server endpoints в CLI нужно регенерировать SDK:
```bash
bun ./script/generate.ts
```
