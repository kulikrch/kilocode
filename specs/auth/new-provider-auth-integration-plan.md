# План внедрения нового провайдера и его авторизации в текущую архитектуру

## Цель
Дать практический, безопасный и минимально конфликтный план интеграции нового провайдера авторизации в Kilo/OpenCode fork с учетом текущей архитектуры плагинов, `ProviderAuth`, `Auth`-store и UI-слоев.

## 0. Выбор целевой модели интеграции
Перед реализацией зафиксировать, какой тип auth у нового провайдера:
1. `api` only (статический API key)
2. `oauth code` (redirect + ручной code)
3. `oauth auto/device` (authorize + polling, без ручного ввода)
4. гибрид (`api` + `oauth` несколько методов)

От этого зависит состав `methods[]` и UI.

## 1. Минимальная архитектурная стратегия (рекомендуемая)
Чтобы уменьшить конфликты с upstream:
1. Реализовать auth-плагин как отдельный модуль (по аналогии с `@kilocode/kilo-gateway` plugin).
2. Подключить его через список internal plugins (`packages/opencode/src/plugin/index.ts`) минимальным diff.
3. Не расширять shared-код `provider/auth.ts` без крайней необходимости.
4. Хранить provider-specific runtime логику в `packages/opencode/src/kilocode/...` или в отдельном `packages/<your-provider>/`.

## 2. Контракт, который обязан соблюдаться

### 2.1 Auth methods
Плагин должен вернуть:
- `auth.provider = "<providerID>"`
- `auth.methods = Method[]`, где каждый `Method` содержит:
  - `type`: `"oauth" | "api"`
  - `label`
  - `prompts?`
  - `authorize?` (для oauth)

### 2.2 OAuth authorize return
`authorize()` должен вернуть объект:
- `url`
- `method`: `"auto" | "code"`
- `instructions`
- `callback(...)`

### 2.3 OAuth callback return
`callback()` должен вернуть `type: "success"` и одно из:
- API-ветка: `{ key }`
- OAuth-ветка: `{ refresh, access, expires, accountId?, enterpriseUrl? }`

Иначе `ProviderAuth.callback` не сможет корректно записать в `Auth`.

## 3. Последовательность внедрения (код)

### Шаг 1. Добавить provider models/meta
Файлы:
- `packages/opencode/src/provider/models.ts`
- при необходимости `packages/opencode/src/kilocode/provider/provider.ts`

Действия:
1. Добавить provider id и модели.
2. Убедиться, что provider не отфильтровывается `enabled/disabled_providers`.
3. Если нужен custom SDK factory, добавить bundled/custom loader.

Проверка:
- `GET /provider` показывает новый provider.

### Шаг 2. Реализовать auth plugin для нового provider
Новый модуль по аналогии с `packages/kilo-gateway/src/plugin.ts`:
1. Экспортировать `YourAuthPlugin`.
2. Реализовать `loader(getAuth)` -> маппинг `Auth.Info` в runtime options SDK.
3. Описать `methods[]`.
4. Для OAuth реализовать `authorize()` и `callback()`.

Проверка:
- `GET /provider/auth` содержит ваш provider + методы.

### Шаг 3. Зарегистрировать плагин
Файл:
- `packages/opencode/src/plugin/index.ts`

Действия:
1. Импорт plugin.
2. Включить в `INTERNAL_PLUGINS`.

Проверка:
- после старта инстанса метод виден в `/provider/auth`.

### Шаг 4. Реализовать серверную auth-специфику (если нужно)
Если нужно provider-specific API (profile/org/tenant switch):
1. Добавить маршруты в отдельном модуле (аналог `createKiloRoutes`).
2. Смонтировать через `packages/opencode/src/kilocode/server/instance.ts`.
3. Использовать `Auth.get("<providerID>")` для извлечения токена.

Проверка:
- новые маршруты доступны и возвращают 401/200 корректно.

### Шаг 5. UI/TUI интеграция

#### 5.1 Базовый вариант (без кастома)
Если достаточно стандартного UI:
- ничего не менять в `dialog-provider.tsx`; он уже поддерживает `api`, `oauth code`, `oauth auto`.

#### 5.2 Кастомный вариант
Если нужен спец-flow (например, выбор org/tenant после login):
1. Добавить override-компонент в `packages/opencode/src/kilocode/components/`.
2. Подключить через `packages/opencode/src/kilocode/cli/cmd/tui/component/dialog-provider.tsx`.
3. После успешного callback делать:
   - optional provider profile fetch
   - `instance.dispose`
   - `sync.bootstrap`.

### Шаг 6. VS Code интеграция
Файлы:
- `packages/kilo-vscode/src/provider-actions.ts`
- `packages/kilo-vscode/src/kilo-provider/handlers/auth.ts` (или новый handler)

Действия:
1. Добавить обработчики authorize/callback/set/remove для нового provider.
2. Пробросить вебвью-сообщения для device/code flow.
3. После auth change выполнять refresh providers и dispose global.

### Шаг 7. Обновить SDK (если менялись endpoint-ы)
Если добавляли/меняли server routes в `packages/opencode/src/server/`:
1. Запустить из корня: `./script/generate.ts`
2. Проверить изменения в `packages/sdk/js/`.

### Шаг 8. Тесты (без моков, по возможности интеграционные)
Приоритетные тест-кейсы:
1. `provider.auth` возвращает метод.
2. `oauth.authorize` создает pending state.
3. `oauth.callback` сохраняет `Auth.Info` корректно.
4. `auth.remove` удаляет credentials.
5. provider list/модели меняются корректно после dispose/reload.
6. org/tenant switch (если есть) обновляет auth и сбрасывает cache.

Подходящие каталоги:
- `packages/opencode/test/provider/`
- `packages/opencode/test/kilocode/`
- `packages/kilo-vscode/tests/unit/`

## 4. Порядок изменения файлов (рекомендуемая последовательность PR)
1. Provider metadata/loaders
2. Auth plugin
3. Server-specific routes (опционально)
4. TUI custom UI (опционально)
5. VS Code handlers
6. Tests
7. SDK regen (если нужно)

Так проще ревьюить и откатывать по частям.

## 5. Что обязательно сделать после внедрения
1. Проверить `bun turbo typecheck`.
2. Прогнать целевые тесты `bun test` из `packages/opencode/`.
3. Если тронуты source links-пути, выполнить `bun run script/extract-source-links.ts`.
4. Если PR user-facing, добавить changeset (`.changeset/*.md`).
5. Для shared-файлов opencode убедиться, что Kilo-изменения помечены `kilocode_change`.

## 6. Частые ошибки и как их избежать
1. Не записывается auth после OAuth callback.
- Причина: callback вернул shape не с `key` и не с `refresh/access/expires`.
- Решение: привести return type к контракту `ProviderAuth.callback`.

2. Provider "подключился", но модели не грузятся.
- Причина: `loader(getAuth)` не прокинул нужные runtime options в SDK.
- Решение: проверить маппинг auth -> options и custom loader.

3. UI зависает на auto flow.
- Причина: `callback()` в authorize-result не завершает polling/не возвращает success/failed.
- Решение: добавить таймаут, обработку denied/expired, явный failed path.

4. После логина старые модели/сессии.
- Причина: не вызван dispose/cache clear.
- Решение: после auth change выполнять `ModelCache.clear(providerID)` и dispose instance.

5. Организация/tenant не применяется.
- Причина: не сохраняется `accountId` (или аналог) в oauth записи.
- Решение: при switch обновлять `Auth.set(providerID, oauth + accountId)`.

## 7. Чек-лист готовности
1. Provider виден в `/provider`.
2. Auth methods видны в `/provider/auth`.
3. `authorize` и `callback` проходят end-to-end.
4. `auth.json` содержит корректную запись.
5. После рестарта auth подхватывается автоматически.
6. Модели провайдера реально вызываются с новым токеном.
7. Logout очищает состояние и UI.
8. (Если есть org/tenant) переключение меняет поведение API и модельный контекст.

## 8. Рекомендуемая миграция на новый auth-сервис с минимальным риском
1. Сначала добавить новый provider параллельно текущему (feature flag).
2. Прогнать internal dogfooding на OAuth/device flow.
3. Включить dual-read конфигурации (старый + новый токен) на переходный период.
4. После стабилизации перевести default provider selection.
5. Удалять старый flow только после успешной телеметрии по login success/error rate.
