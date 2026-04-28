# Текущий поток базовой авторизации (Kilo + Provider OAuth/API)

## Цель документа
Подробно зафиксировать, как сейчас работает авторизация в проекте: от UI/CLI до хранения токена и применения credentials при вызовах моделей.

## 0. Термины и слои
- Control plane auth API: `PUT/DELETE /auth/:providerID` (установка/удаление credentials в хранилище auth).
- Instance provider OAuth API: `GET /provider/auth`, `POST /provider/:providerID/oauth/authorize`, `POST /provider/:providerID/oauth/callback`.
- Kilo API-роуты instance: `/kilo/*` (profile, organization switch, modes, notifications и т.д.).
- Auth store: файл `auth.json` в `Global.Path.data`.

Ключевые файлы:
- `packages/opencode/src/auth/index.ts`
- `packages/opencode/src/provider/auth.ts`
- `packages/opencode/src/server/routes/control/index.ts`
- `packages/opencode/src/server/routes/instance/provider.ts`
- `packages/opencode/src/kilocode/server/instance.ts`
- `packages/kilo-gateway/src/plugin.ts`
- `packages/kilo-gateway/src/auth/device-auth-tui.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/kilocode/provider/provider.ts`

## 1. Загрузка auth-состояния и формат данных

### 1.1 Где лежат данные
`packages/opencode/src/auth/index.ts`:
- Путь к файлу: `path.join(Global.Path.data, "auth.json")`.
- Схема записи (union):
  - `oauth`: `{ type, refresh, access, expires, accountId?, enterpriseUrl? }`
  - `api`: `{ type, key, metadata? }`
  - `wellknown`: `{ type, key, token }`

### 1.2 Чтение
- `Auth.Service.all()`:
  1. Сначала пытается прочитать `process.env.KILO_AUTH_CONTENT`.
  2. Если env нет или невалидный JSON, читает `auth.json`.
  3. Фильтрует записи через schema decode.
- `Auth.Service.get(providerID)` возвращает запись по ключу provider.

### 1.3 Нормализация ключей
- При `set/remove` ключ provider нормализуется (убираются trailing slash), старые варианты ключа удаляются.

### 1.4 Запись/удаление
- `Auth.Service.set()` пишет `auth.json` с mode `0600`.
- `Auth.Service.remove()` удаляет запись и:
  - для `kilo` сбрасывает telemetry identity;
  - трекает logout event.

## 2. Как auth-провайдеры регистрируются

### 2.1 Встроенные плагины
`packages/opencode/src/plugin/index.ts`:
- В `INTERNAL_PLUGINS` включен `KiloAuthPlugin` из `@kilocode/kilo-gateway`.
- При инициализации `Plugin.Service` этот плагин загружается и его `auth`-hook становится доступным для `ProviderAuth`.

### 2.2 Kilo auth plugin
`packages/kilo-gateway/src/plugin.ts`:
- `auth.provider = "kilo"`.
- `loader(getAuth)` преобразует запись из `Auth` в runtime options:
  - `api` -> `kilocodeToken`
  - `oauth` -> `kilocodeToken` + `kilocodeOrganizationId` (если есть `accountId`)
- `methods` содержит OAuth-метод `Kilo Gateway (Device Authorization)` с `authorize()` -> `authenticateWithDeviceAuthTUI()`.

## 3. Текущий OAuth flow (общий) в server instance

### 3.1 Получение доступных auth-методов
1. Клиент вызывает `GET /provider/auth`.
2. Роут: `packages/opencode/src/server/routes/instance/provider.ts`.
3. `ProviderAuth.Service.methods()` возвращает map `providerID -> Method[]`.
4. Источник данных: auth hooks из plugin system (`packages/opencode/src/provider/auth.ts`).

### 3.2 Старт OAuth
1. Клиент вызывает `POST /provider/:providerID/oauth/authorize` с payload:
   - `method` (индекс метода)
   - `inputs` (опционально, если метод требует prompts)
2. `ProviderAuth.authorize()`:
   - берет hook нужного provider;
   - валидирует prompt inputs;
   - вызывает `method.authorize()`;
   - кладет результат в pending-map (in-memory) по `providerID`.
3. Возвращается `{ url, method: auto|code, instructions }`.

### 3.3 Завершение OAuth
1. Клиент вызывает `POST /provider/:providerID/oauth/callback` с payload:
   - `method`
   - `code` (для `method=code`)
2. `ProviderAuth.callback()`:
   - достает pending authorize state;
   - вызывает `match.callback(...)`;
   - при success сохраняет auth в `Auth`:
     - если есть `key` -> `type: api`
     - если есть `refresh/access/expires` -> `type: oauth`.
3. Для `providerID === "kilo"` дополнительно:
   - `Telemetry.updateIdentity(token, accountId)`;
   - `Telemetry.trackAuthSuccess("kilo")`;
   - `ModelCache.clear("kilo")`;
   - `Instance.disposeAll()`.

## 4. Текущий Kilo-specific device auth flow

### 4.1 Запуск
`packages/kilo-gateway/src/auth/device-auth-tui.ts`:
1. `POST {KILO_API_BASE}/api/device-auth/codes` -> получает `code`, `verificationUrl`, `expiresIn`.
2. Пытается открыть браузер (`open`/`cmd start`/`xdg-open`).
3. Возвращает OAuth descriptor:
   - `url`
   - `instructions` (с кодом)
   - `method: "auto"`
   - `callback()` для долгого polling.

### 4.2 Polling
`callback()`:
1. Периодически вызывает `GET {KILO_API_BASE}/api/device-auth/codes/{code}`.
2. Статусы:
   - `202` -> pending
   - `403` -> denied
   - `410` -> expired
   - `200` -> approved + token/user.
3. При approved:
   - берет `token`;
   - получает default model (`getKiloDefaultModel`);
   - возвращает `success` результат в формате OAuth:
     - `refresh=token`, `access=token`, `expires=+1y`, `provider="kilo"`.

### 4.3 Запись токена
- На этапе `ProviderAuth.callback()` этот результат записывается в `auth.json` как `type: oauth`.

## 5. UI flow в TUI

### 5.1 Общий диалог выбора провайдера
`packages/opencode/src/cli/cmd/tui/component/dialog-provider.tsx`:
1. Выбор провайдера.
2. Чтение `sync.data.provider_auth[provider.id]`.
3. Если OAuth:
   - `authorize()`
   - дальше UI зависит от `authorization.method`.

### 5.2 Kilo auto method override
- Для `kilo` используется кастомный рендерер:
  - `packages/opencode/src/kilocode/cli/cmd/tui/component/dialog-provider.tsx`
  - `packages/opencode/src/kilocode/components/dialog-kilo-auto-method.tsx`
- Шаги:
  1. показывает URL+code;
  2. вызывает `provider.oauth.callback` (ждет completion polling);
  3. вызывает `kilo.profile`;
  4. если есть организации -> открывает `DialogKiloOrganization`;
  5. если нет -> переходит к выбору модели.

### 5.3 Выбор организации
`packages/opencode/src/kilocode/components/dialog-kilo-organization.tsx`:
1. Пользователь выбирает org.
2. Вызов `POST /kilo/organization`.
3. Сервер перезаписывает `Auth.set("kilo", oauth + accountId)`.
4. `ModelCache.clear("kilo")`, `clearModesCache()`, `Instance.disposeAll()`.
5. UI делает `instance.dispose + sync.bootstrap`.

## 6. UI flow в VS Code extension

Файл: `packages/kilo-vscode/src/kilo-provider/handlers/auth.ts`

### 6.1 Login
1. `provider.oauth.authorize({ providerID: "kilo", method: 0 })`.
2. Парсит code из `instructions` и шлет в webview `deviceAuthStarted`.
3. Вызывает `provider.oauth.callback(...)` (блокируется до завершения polling).
4. После успеха делает `disposeGlobal()`.
5. Вызывает `kilo.profile()` и шлет `profileData`.

### 6.2 Logout
1. `auth.remove({ providerID: "kilo" })`.
2. `disposeGlobal()`.
3. Обновляет provider list.

### 6.3 Organization switch
1. `kilo.organization.set({ organizationId })`.
2. `disposeGlobal()`.
3. Рефреш profile/providers/agents.

## 7. Control plane API для API-key auth

`packages/opencode/src/server/routes/control/index.ts`:
- `PUT /auth/:providerID` -> `Auth.set(providerID, info)`.
- `DELETE /auth/:providerID` -> `Auth.remove(providerID)`.
- После set/remove вызывается `KiloServer.authChanged(providerID)`.

Это используется для провайдеров с прямым API key и для ручных сценариев VS Code (`client.auth.set/remove`).

## 8. Как auth попадает в runtime provider options

### 8.1 Сборка provider state
`packages/opencode/src/provider/provider.ts`:
1. Строится `providers` map из models.dev + config + custom loaders + plugin hooks.
2. Для каждого provider читается `auth.get(providerID)`.
3. Plugin auth loader (например Kilo) добавляет provider options (`kilocodeToken`, `kilocodeOrganizationId`).

### 8.2 Kilo runtime provider
`packages/opencode/src/kilocode/provider/provider.ts` + `packages/kilo-gateway/src/provider.ts`:
- `createKilo(options)` строит SDK provider с:
  - `Authorization: Bearer <kilocodeToken>`
  - custom headers (org/context)
  - base URL для openrouter gateway.

## 9. Kilo instance API, зависящие от auth

Маршруты монтируются через `packages/opencode/src/kilocode/server/instance.ts` -> `createKiloRoutes(...)`.
Ключевой файл: `packages/kilo-gateway/src/server/routes.ts`.

Используют `Auth.get("kilo")`:
- `GET /kilo/profile`
- `POST /kilo/organization`
- `GET /kilo/modes`
- `POST /kilo/fim`
- `GET /kilo/notifications`
- cloud session routes
- kiloclaw routes

Логика везде типовая:
- взять `token` из `oauth.access` или `api.key`;
- при `oauth` опционально пробросить `accountId` как organization header.

## 10. Legacy migration при старте CLI

`packages/opencode/src/index.ts` + `packages/kilo-gateway/src/auth/legacy-migration.ts`:
1. На startup вызывается `migrateLegacyKiloAuth(...)`.
2. Если в `~/.kilocode/cli/config.json` найден legacy token, переносит в `Auth`:
   - с `organizationId` -> `type: oauth` + `accountId`
   - без org -> `type: api`.
3. Затем telemetry identity синхронизируется с текущим `Auth.get("kilo")`.

## 11. Критические точки для миграции на другой auth-сервис
- Контракт `ProviderAuth.authorize/callback` должен сохраниться.
- В `callback` обязательно возвращать `success` shape, который умеет преобразоваться в `Auth.Info`.
- Для Kilo-like org context важно поле `accountId` в `oauth` записи.
- После auth-change нужны `ModelCache.clear(providerID)` и instance dispose.
- UI для `auto` flow рассчитывает на блокирующий callback + человекочитаемый `instructions`.
