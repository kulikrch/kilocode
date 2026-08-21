# Backport автокомпрессии Kilo Code на версию 7.2.24

## 1. Назначение документа

Этот документ описывает функциональный перенос исправлений и улучшений автокомпрессии контекста из развития Kilo Code после версии `7.2.24` в отдельную ветку, основанную строго на теге `v7.2.24`.

Документ предназначен для:

- владельца форка, который должен понимать, что именно было перенесено;
- разработчика, который будет сопровождать этот backport;
- ревьюера, которому необходимо проверить полноту переноса;
- инженера выпуска, который будет собирать CLI или VS Code Extension из опубликованного тега;
- разработчика следующего backport, которому понадобится повторить перенос на другую старую версию.

Исходная проблема обсуждалась в issue:

- <https://github.com/Kilo-Org/kilocode/issues/9774>

Особенно важен комментарий пользователя о том, что первоначального исправления было недостаточно:

- <https://github.com/Kilo-Org/kilocode/issues/9774#issuecomment-5005472301>

## 2. База и результат переноса

| Параметр | Значение |
|---|---|
| Исходный тег | `v7.2.24` |
| Исходный commit | `f6be4ee44ea6b06d1ca8332d8c481593ba2cadc7` |
| Рабочая ветка | `fix/compaction-v7.2.24` |
| Целевой тег backport | `v7.2.24-auto-compaction-backport` |
| Целевой remote | `kulikrch` |
| Целевой репозиторий | `https://github.com/kulikrch/kilocode.git` |

Функциональные коммиты backport:

| Commit | Назначение |
|---|---|
| `36c55325f5` | Исправления CLI: очередь, preflight, токены, payload recovery и chunked compaction |
| `0ae7b28ce0` | Настройка порога автокомпрессии в VS Code и переводы |
| `6e558cbb4e` | Синхронизация OpenAPI и TypeScript-типа SDK |

Документ и changeset находятся в отдельном завершающем коммите, чтобы функциональные изменения можно было переносить независимо от документации.

## 3. Что было не так в версии 7.2.24

### 3.1. Основная ошибка очереди запросов

Kilo Code поддерживает очередь пользовательских запросов. Когда новый запрос поступает во время выполнения предыдущего, очередь временно ограничивает видимый набор сообщений. Это необходимо, чтобы выполняющийся turn не увидел более новый queued prompt раньше времени.

Проблемный сценарий выглядел так:

1. Пользователь отправляет первый запрос.
2. Пока первый запрос выполняется, пользователь отправляет второй запрос.
3. Второй запрос сохраняется и ждёт в очереди.
4. После начала второго queued turn контекст оказывается переполнен.
5. CLI создаёт служебное user-сообщение с part типа `compaction`.
6. Идентификатор нового служебного сообщения больше идентификатора исходного queued prompt.
7. `KiloSessionPromptQueue.scope()` считает новое сообщение посторонним более поздним запросом и скрывает его.
8. Цикл сессии не видит задачу `compaction`.
9. Вместо суммаризации снова отправляется переполненный исходный контекст.
10. Повторение продолжается до исчерпания `MAX_COMPACTION_ATTEMPTS`.

Именно поэтому наличие кода создания compaction-marker само по себе не означало, что проблема исправлена. Marker сохранялся, но не попадал в видимую область активного queued turn.

### 3.2. Переполнение до получения usage

Версия `7.2.24` в основном ориентировалась на token usage уже завершённого ответа провайдера. Такой подход не защищал от запроса, который не мог быть принят вообще:

- история уже слишком велика;
- схема инструментов занимает значительную часть окна;
- модель объявляет слишком большой output limit;
- encoded media увеличивает HTTP payload;
- провайдер отклоняет запрос до начала stream.

### 3.3. Устаревшее поле `tokens.total`

Некоторые провайдеры или старые сохранённые сообщения содержат `tokens.total`, которое не совпадает с актуальной суммой нормализованных полей:

```text
input + output + reasoning + cache.read + cache.write
```

Если безусловно доверять большему устаревшему `total`, только что сжатая сессия может немедленно попасть в повторную автокомпрессию.

### 3.4. Payload может быть больше token context

Token context и HTTP payload — разные ограничения.

Например, base64-изображение может:

- занимать сотни килобайт или мегабайты в JSON;
- преобразовываться провайдером в сравнительно небольшое число vision tokens;
- быть отклонено gateway по лимиту размера тела запроса ещё до tokenization.

Поэтому одной проверки token count недостаточно.

### 3.5. Суммаризация тоже может не помещаться

Если вся история передаётся модели одним compaction-запросом, сама суммаризация может получить `ContextOverflowError`. Без дополнительной стратегии сессия становится непригодной для продолжения.

## 4. Какие изменения из последующих релизов учтены

Backport объединяет функциональный результат следующей цепочки изменений основной ветки Kilo Code:

| Upstream commit | Смысл изменения |
|---|---|
| `d9453f0da2` | Сделать queued compaction-marker видимым активному turn |
| `03630064ad` | Восстановление compaction после отказа по размеру payload |
| `4860e654ca` | Настраиваемый процентный порог автокомпрессии |
| `c1a797c1f1` | Суммаризация слишком большой истории частями |
| `94564f3588` | Исключить повторную автокомпрессию из-за порядка отфильтрованных сообщений |
| `a13064167d` | Выполнять threshold-проверку до отправки provider request |
| `9a1f424e35` | Усилить replay после proactive compaction |
| `bc3af9a145` | Не использовать устаревший `tokens.total`, когда доступны компоненты usage |
| `9857c9861e` | Не считать размер encoded media текстовыми context tokens |
| `ca055f0bfc` | Ограничивать output по usage, сообщённому провайдером |
| `a0a6a29e34` | Не использовать usage summary-сообщения как актуальный пользовательский контекст |
| `6f11e35764` | Сохранять реальные ошибки worker во время chunked compaction |
| `f0621df7ec` | Считать пустой ответ compaction worker ошибкой |
| `2a097f3af7` | Расширить список текстовых форматов context-overflow |
| `56be86ef04` | Не передавать `maxOutputTokens` как постороннюю provider option worker-запроса |
| `7d3f50c2e8` | Не прерывать threshold-compaction незавершённый tool-loop |

Прямой cherry-pick этой цепочки невозможен без большого количества конфликтов, потому что между `7.2.24` и `7.4.23` изменились:

- структура пакета LLM;
- Effect-сервисы;
- интерфейс `SessionProcessor`;
- API преобразования `MessageV2`;
- схема хранения и получения частей сообщений;
- импорты и расположение Kilo-specific модулей;
- SDK generator и порядок OpenAPI endpoint.

Поэтому перенос выполнен функционально: сохранено требуемое поведение, но реализация адаптирована к архитектуре `7.2.24`.

## 5. Итоговое правило срабатывания автокомпрессии

### 5.1. Жёсткая граница после provider step

Сначала вычисляется доступный размер контекста `usable`.

Если модель имеет отдельный `limit.input`:

```text
usable = max(0, limit.input - reserved)
```

Если отдельного `limit.input` нет:

```text
usable = max(0, limit.context - maxOutputTokens(model))
```

Резерв:

```text
reserved = config.compaction.reserved
           ?? min(20 000, maxOutputTokens(model))
```

Нормализованное использование:

```text
normalized = input
           + output
           + reasoning
           + cache.read
           + cache.write
```

Правило выбора usage:

```text
usage = normalized != 0 ? normalized : tokens.total ?? 0
```

Автокомпрессия после шага требуется, когда:

```text
usage >= usable
```

Процентный пользовательский threshold после завершённого provider step намеренно не применяется. Это предотвращает немедленную повторную компрессию по usage старого pre-compaction сообщения.

### 5.2. Процентный preflight-порог

Параметр:

```json
{
  "compaction": {
    "threshold_percent": 80
  }
}
```

Допустимые значения:

- число больше `0` и не больше `100`;
- `null`;
- отсутствие поля.

Если задано число:

```text
threshold = floor((limit.input || limit.context) * threshold_percent / 100)
preflight_limit = min(usable, threshold)
```

То есть процент никогда не отменяет более раннюю безопасную границу `usable`.

Если значение равно `null` или отсутствует, процентный preflight выключен, но обычная hard-limit автокомпрессия продолжает работать.

### 5.3. Оценка исходящего запроса

Preflight учитывает:

- system prompt;
- историю model messages;
- текущий user prompt;
- описания инструментов;
- JSON Schema входных параметров инструментов.

Базовая оценка выполняется через `Token.estimate()`, после чего применяется коэффициент безопасности:

```text
estimated = ceil((messageTokens + toolSchemaTokens) * 1.3)
```

Коэффициент `1.3` компенсирует типичное занижение по сравнению с provider tokenizer, особенно на коде и JSON.

### 5.4. Encoded media

Base64 и другие encoded media не должны напрямую считаться обычным текстом. Иначе строка base64 может преждевременно занять всё token window по грубой оценке.

Для token preflight содержимое media временно нормализуется до маркера:

```text
[encoded media]
```

Одновременно сохраняется отдельная raw-оценка размера. Она нужна для диагностики различия между token context и HTTP payload.

Если предыдущий provider response сообщил большое реальное usage для изображения, это usage используется как нижняя граница оценки.

### 5.5. Tool-loop

Если после последнего user-сообщения уже присутствует tool result, текущий turn считается продолжением tool-loop.

В этом случае процентная preflight-компрессия откладывается. Причина: суммаризация между tool call и следующим ответом модели может разорвать обязательную последовательность tool-use/tool-result.

Жёсткий provider overflow по-прежнему обрабатывается как ошибка и запускает recovery.

## 6. Адаптивный output budget

Некоторые модели объявляют output limit, равный почти всему context window. Если безусловно отправить такое `maxOutputTokens`, провайдер может отклонить даже небольшой input.

Backport вычисляет:

```text
contextUsage = max(providerReportedUsage, clientEstimatedUsage)
available = limit.context - contextUsage - 2 048
```

Правила:

1. Если output limit не задан, поведение не меняется.
2. Если context limit неизвестен или равен нулю, поведение не меняется.
3. Если `available` больше исходного output limit, используется исходный limit.
4. Если `available` положителен, output ограничивается оставшимся окном.
5. Минимальный output budget после ограничения — `1 024` токена.
6. Если input уже сам превышает context, сохраняется исходное значение, чтобы провайдер вернул естественный overflow и запустил стандартный compaction flow.

Encoded media нормализуется в client estimate, но provider-reported vision usage имеет приоритет, если оно больше.

## 7. Исправление queued compaction-marker

`KiloSessionPromptQueue` хранит:

- базовый идентификатор queued user message;
- множество разрешённых дополнительных служебных сообщений `extras`.

После создания одного из внутренних сообщений вызывается:

```ts
KiloSessionPromptQueue.retarget(sessionID, messageID)
```

Это выполняется для:

- compaction-marker;
- replay user message;
- synthetic continue user message.

Важно: `retarget()` не двигает основную границу видимости вперёд. Он разрешает только конкретный внутренний message ID. Поэтому посторонние пользовательские prompts, поставленные в очередь во время turn, остаются скрытыми.

Регрессионный тест воспроизводит точную последовательность:

```text
первый user -> assistant -> queued user -> auto-compaction marker
```

И проверяет, что marker виден и является последним сообщением scoped history.

## 8. Защита от повторной компрессии

### 8.1. Нормализованные токены

Функция `KiloSessionOverflow.count()` сначала суммирует нормализованные поля. `tokens.total` используется только как fallback, когда сумма компонентов равна нулю.

### 8.2. Последнее сообщение определяется по ID

`filterCompacted()` может вернуть сообщения в порядке, удобном для model consumption, но не полностью совпадающем с хронологией сохранения.

Функция `MessageV2.latest()` выбирает:

- последнего user;
- последнего assistant;
- последнего завершённого assistant;
- ещё не обработанные compaction/subtask tasks.

Выбор выполняется по максимальному монотонному `MessageID`, а не по позиции элемента в массиве.

Summary assistant не используется как источник `reportedContextTokens`, потому что его usage описывает запрос суммаризации, а не актуальный пользовательский контекст после компрессии.

## 9. Payload recovery

Payload recovery включается для сообщений ошибок, содержащих, например:

- `request entity too large`;
- `function_payload_too_large`.

Допустимые классы ошибок:

- `ContextOverflowError`;
- `APIError`.

Алгоритм:

1. Выполняется обычный compaction request.
2. Проверяется result и сохранённая ошибка processor.
3. Если ошибка соответствует payload limit, error/finish summary-сообщения очищаются.
4. Завершённые старые tool outputs помечаются как `compacted`.
5. Media parts заменяются текстовыми описаниями вложений.
6. История повторно преобразуется в model messages с `stripMedia: true`.
7. Compaction request повторяется с пояснением о предварительном удалении тяжёлого содержимого.

Изменение persisted parts намеренно. Иначе следующий обычный model request снова соберёт исходный oversized payload.

## 10. Chunked compaction

### 10.1. Когда включается fallback

Chunked compaction запускается, если:

- предварительная оценка показывает, что исходный summary request не помещается;
- обычный compaction возвращает result `compact`;
- worker останавливается с `ContextOverflowError`.

### 10.2. Ограниченная worker-модель

Для промежуточных worker-запросов output ограничивается значением:

```text
min(model.limit.output, 2 048)
```

Параметр `maxOutputTokens` удаляется из `agent.options`, чтобы не попасть в provider-specific options и не обойти ограничение модели.

### 10.3. Размер chunk

Целевой budget:

```text
chunkBudget = max(1 000, floor(usable(workerModel) * 0.6))
```

История последовательно разбивается на группы сообщений, оценка которых не превышает budget.

### 10.4. Безопасный transcript

Для worker создаётся текстовый transcript. Он сохраняет:

- роли сообщений;
- обычный текст;
- reasoning с явной меткой;
- имена и MIME-типы вложений;
- subtask prompt и description;
- tool name, status, input и output;
- step finish reason;
- compaction marker.

Ограничения содержимого:

| Содержимое | Ограничение |
|---|---|
| Один text/reasoning/subtask fragment | `16 000` символов |
| Tool input | `2 000` символов |
| Tool output или tool error | `2 000` символов |
| Итоговый transcript worker | динамически, не более безопасной доли budget |

Каждое усечение получает явный маркер с количеством пропущенных символов.

### 10.5. Частичные summaries

Каждый chunk суммаризируется отдельно. Prompt требует сохранить:

- пути файлов;
- команды;
- ошибки;
- решения;
- незавершённые задачи.

Частичные summaries объединяются финальным worker-запросом.

Если массив partial summaries снова не помещается, он делится пополам и рекурсивно сокращается. Максимальная глубина дополнительного объединения — `3`.

### 10.6. Параллельность

Независимые chunks обрабатываются с concurrency не больше `3`. Это сокращает задержку, но не создаёт неограниченный поток provider requests.

### 10.7. Временные сообщения worker

Для каждого worker создаётся временный assistant message, потому что старый `SessionProcessor` версии `7.2.24` ожидает persisted target message.

После worker request временное сообщение удаляется через `Effect.ensuring()`, включая случаи ошибки или отмены.

### 10.8. Пустой ответ worker

Result `continue` без непустого text part считается ошибкой:

```text
Compaction worker returned an empty response
```

Это предотвращает сохранение формально успешной, но фактически пустой summary.

### 10.9. Сохранение реальной ошибки

Если worker завершился не из-за context overflow, его исходная ошибка переносится в целевое summary-сообщение. Ошибка авторизации, rate limit или network failure не маскируется общим сообщением о размере контекста.

## 11. Oversized replay

После overflow-компрессии Kilo может повторно создать предыдущий user request. Если сам replay слишком велик, простое восстановление снова приводит к overflow.

Backport оценивает replay отдельно. Если он не помещается:

1. replay преобразуется в один chunk;
2. worker создаёт компактное представление запроса;
3. вместо исходных частей сохраняется synthetic text;
4. текст явно сообщает модели, что это сжатое представление исходного запроса.

Если worker не смог получить summary, используется исходный replay, чтобы не потерять пользовательские данные молча.

## 12. Распознавание ошибок провайдеров

Добавлены дополнительные варианты сообщений:

- `request_too_large`;
- превышение `maximum context length` с разными форматами чисел;
- превышение `maximum allowed input length`;
- `input (...) is longer than the model's context length (...)`;
- `prompt has ... tokens, but the configured context size is ...`;
- `too many tokens`;
- `token limit exceeded`.

Добавлены исключения, чтобы широкие формулировки не классифицировали как context overflow:

- rate limit;
- too many requests;
- throttling error;
- service unavailable.

## 13. Поведение при отключённой автокомпрессии

Конфигурация:

```json
{
  "compaction": {
    "auto": false
  }
}
```

При таком значении:

- процентный preflight отключён;
- post-step autocompaction отключён;
- provider context overflow сохраняется как ошибка assistant message;
- сессия переходит в idle;
- скрытый цикл автоматических compaction retries не запускается.

Manual compaction остаётся отдельным пользовательским действием.

## 14. Настройка в VS Code

В `Context Settings` добавлено поле `Auto Compaction Limit`.

Поведение поля:

- принимаются числа от `1` до `100`;
- дробные значения технически допустимы схемой;
- UI ограничивает введённое число диапазоном;
- пустое значение сохраняет `null`;
- placeholder показывает пример `80`, но не устанавливает его автоматически.

Также UI приведён к server defaults:

```text
compaction.auto  отсутствует -> true
compaction.prune отсутствует -> true
```

Ранее старый UI показывал выключенные переключатели при отсутствии полей, хотя CLI трактовал отсутствие как включённое состояние.

Новые строки добавлены во все поддерживаемые sidebar locale dictionaries:

- Arabic;
- Brazilian Portuguese;
- Bosnian;
- Danish;
- German;
- English;
- Spanish;
- French;
- Japanese;
- Korean;
- Dutch;
- Norwegian;
- Polish;
- Russian;
- Thai;
- Turkish;
- Ukrainian;
- Simplified Chinese;
- Traditional Chinese.

## 15. SDK и OpenAPI

В схему `Config.compaction` добавлено:

```ts
threshold_percent?: number | null
```

OpenAPI-ограничения:

```json
{
  "anyOf": [
    {
      "type": "number",
      "exclusiveMinimum": 0,
      "maximum": 100
    },
    {
      "type": "null"
    }
  ]
}
```

Без обновления SDK extension мог бы отображать поле, но другие типизированные клиенты не знали бы о нём или удаляли бы его при преобразовании конфигурации.

## 16. Карта изменённых файлов

### 16.1. Новые Kilo-specific CLI-модули

| Файл | Ответственность |
|---|---|
| `packages/opencode/src/kilocode/session/overflow.ts` | Нормализованные токены, preflight estimate, threshold и tool-loop defer |
| `packages/opencode/src/kilocode/session/llm.ts` | Адаптивный output budget |
| `packages/opencode/src/kilocode/session/compaction-payload-recovery.ts` | Очистка oversized payload и повтор compaction |
| `packages/opencode/src/kilocode/session/compaction-chunks.ts` | Разбиение, worker summaries, reduction и replay fallback |

### 16.2. Узкие точки интеграции в shared CLI-коде

| Файл | Изменение |
|---|---|
| `packages/opencode/src/config/config.ts` | Схема `threshold_percent` |
| `packages/opencode/src/session/overflow.ts` | Экспорт `usable()` и нормализованный count |
| `packages/opencode/src/session/llm.ts` | Preflight и output cap перед `streamText()` |
| `packages/opencode/src/session/processor.ts` | Внутренний preflight signal и сохранение compact error |
| `packages/opencode/src/session/prompt.ts` | Передача preflight/reported usage и корректное создание marker |
| `packages/opencode/src/session/message-v2.ts` | Выбор последних сообщений по ID |
| `packages/opencode/src/session/compaction.ts` | Payload/chunk/replay flow и queue retarget |
| `packages/opencode/src/provider/error.ts` | Дополнительные overflow patterns и exclusions |

Все изменения shared-файлов помечены `kilocode_change`. Основная новая логика находится в каталоге `kilocode`, чтобы уменьшить конфликты при будущих upstream merge.

### 16.3. Тесты

| Файл | Покрытие |
|---|---|
| `packages/opencode/test/kilocode/session-overflow.test.ts` | Usage, threshold, tool schema, tool-loop, media, provider usage, payload и chunks |
| `packages/opencode/test/kilocode/session-prompt-queue.test.ts` | Видимость compaction-marker в queued turn |

### 16.4. VS Code и SDK

| Область | Файлы |
|---|---|
| Настройка UI | `packages/kilo-vscode/webview-ui/src/components/settings/ContextTab.tsx` |
| Тип webview config | `packages/kilo-vscode/webview-ui/src/types/messages/config.ts` |
| Переводы | `packages/kilo-vscode/webview-ui/src/i18n/*.ts` |
| SDK type | `packages/sdk/js/src/v2/gen/types.gen.ts` |
| OpenAPI | `packages/sdk/openapi.json` |

## 17. Примеры конфигурации

### 17.1. Рекомендуемый ранний порог

```json
{
  "compaction": {
    "auto": true,
    "threshold_percent": 80,
    "prune": true
  }
}
```

### 17.2. Только стандартный safety buffer

```json
{
  "compaction": {
    "auto": true,
    "threshold_percent": null,
    "prune": true
  }
}
```

### 17.3. Пользовательский резерв

```json
{
  "compaction": {
    "auto": true,
    "threshold_percent": 90,
    "reserved": 30000,
    "prune": true
  }
}
```

Фактическая граница будет более ранней из процентного threshold и `usable`, рассчитанного с резервом `30 000`.

### 17.4. Полное отключение автоматического режима

```json
{
  "compaction": {
    "auto": false
  }
}
```

## 18. Порядок переноса в другой форк 7.2.24

Если нужен этот backport целиком, предпочтительно использовать опубликованный тег.

```bash
git fetch kulikrch tag v7.2.24-auto-compaction-backport
git switch -c fix/compaction-v7.2.24 v7.2.24-auto-compaction-backport
```

Если нужны отдельные части, коммиты следует применять в таком порядке:

```bash
git cherry-pick 36c55325f5
git cherry-pick 0ae7b28ce0
git cherry-pick 6e558cbb4e
```

Назначение вариантов:

- только CLI: первый commit;
- CLI и VS Code UI: первый и второй commits;
- полный согласованный продукт: все три функциональных commits и документационный commit.

Не рекомендуется применять UI или SDK без CLI: поле будет отображаться и сохраняться, но backend `7.2.24` без первого commit не будет использовать threshold.

## 19. Выполненные проверки

### 19.1. CLI

```bash
cd packages/opencode
bun run typecheck
bun test ./test/kilocode/session-overflow.test.ts
bun test ./test/kilocode/session-prompt-queue.test.ts -t "keeps auto-compaction markers"
bun test ./test/session/compaction.test.ts ./test/kilocode/session-compaction-cap.test.ts
```

Результат:

- CLI typecheck прошёл;
- 8 новых overflow/recovery-тестов прошли;
- queued compaction regression прошёл;
- 51 существующий compaction/cap-тест прошёл;
- всего 60 профильных CLI-тестов без ошибок.

### 19.2. VS Code Extension

```bash
cd packages/kilo-vscode
bun run typecheck
bun run lint
bun run knip
bun test ./tests/unit/i18n-keys.test.ts
```

Результат:

- extension typecheck прошёл;
- webview typecheck прошёл;
- ESLint прошёл;
- Knip прошёл;
- 7 тестов ключей и полноты переводов прошли.

### 19.3. Полный unit-suite extension

Полный запуск дал:

- `1959` успешно пройденных тестов;
- Windows-specific сбои, не связанные с backport.

Наблюдавшиеся ограничения окружения:

- `EPERM` при создании symlink без Windows Developer Mode или повышенных прав;
- `EPERM` на временных файлах Agent Manager;
- отсутствие Unix-переменной `HOME` в отдельных shell fixtures;
- Unix shell-команды в тестовых scripts;
- git fixture failures, зависящие от локального Windows shell.

Единственный связанный с изменением сбой — отсутствие новых i18n-ключей в остальных локалях — был исправлен. После этого `i18n-keys.test.ts` полностью проходит.

### 19.4. Дополнительные проверки

- `git diff --check` не обнаруживает whitespace errors;
- новые Kilo-модули проходят Oxlint без предупреждений;
- проверка `kilocode_change` для Kilo-only каталогов не обнаруживает запрещённых markers;
- OpenAPI и SDK type содержат одинаковое поле и одинаковую nullability;
- changeset добавлен для `@kilocode/cli` и `kilo-code`.

## 20. Диагностика после установки

### 20.1. Компрессия не запускается на проценте

Проверить:

1. `compaction.auto` не равно `false`.
2. `compaction.threshold_percent` действительно сохранён как число, а не строка.
3. Модель сообщает ненулевой `limit.context`.
4. Текущий запрос не находится непосредственно после tool result.
5. Extension использует CLI binary, собранный из этого backport, а не старый bundled binary.

### 20.2. Компрессия запускается только около hard limit

Это ожидаемо, если:

- `threshold_percent` отсутствует;
- `threshold_percent` равен `null`;
- процентная граница выше safety boundary `usable`.

### 20.3. Повторяется `ContextOverflowError`

Проверить provider message. Если текст не соответствует известным patterns, его нужно добавить в `packages/opencode/src/provider/error.ts` с отдельным тестом и исключить пересечение с rate-limit сообщениями.

### 20.4. Компрессия завершается пустой summary

Это должно классифицироваться как `APIError` с текстом `Compaction worker returned an empty response`. Не следует считать такой worker успешным.

### 20.5. После компрессии потеряно вложение

При payload recovery media намеренно заменяется текстовым marker. Пользователю следует предложить повторить отправку с меньшим количеством или размером вложений.

## 21. Производительность и стоимость

Обычный запрос получает дополнительную локальную работу:

- сериализация model messages для оценки;
- `Token.estimate()`;
- оценка tool schemas.

Внешний provider request для preflight не выполняется.

Chunked fallback может выполнить несколько provider requests. Ограничения:

- fallback используется только для oversized compaction;
- concurrency ограничен тремя workers;
- output каждого worker ограничен `2 048` токенами;
- рекурсивное объединение ограничено глубиной;
- временные worker messages удаляются.

Цена нескольких коротких summaries считается приемлемой по сравнению с полной потерей работоспособности длинной сессии.

## 22. Безопасность и целостность данных

- Recovery не выполняет команды и не включает tools.
- Compaction agent получает `tools: {}`.
- Transcript ограничивает размеры tool input/output.
- Media payload не дублируется в summaries.
- Временные сообщения удаляются даже при ошибке через finalizer.
- Существующие unrelated queued prompts не становятся видимыми после `retarget()`.
- Реальные ошибки авторизации, сети и rate limit не маскируются context overflow.

## 23. Известные ограничения

1. Client token estimate остаётся приблизительным; окончательным источником истины является provider usage.
2. Первый multimodal request не имеет предыдущего provider-reported vision usage.
3. При одном гигантском сообщении с большим числом частей transcript может быть усечён для безопасности worker request.
4. Payload limits отличаются у провайдеров; regex recovery покрывает известные формулировки, но не гарантирует все будущие варианты.
5. Пустой threshold не означает значение placeholder `80`; это режим без процентного preflight.
6. Extension необходимо пересобрать с новым CLI binary, иначе UI и backend будут разных версий.

## 24. Откат

### 24.1. Откат полного backport

Если commits не объединялись с другими изменениями:

```bash
git revert <документационный-commit>
git revert 6e558cbb4e
git revert 0ae7b28ce0
git revert 36c55325f5
```

Откат выполняется в обратном порядке.

### 24.2. Временное отключение без отката кода

```json
{
  "compaction": {
    "auto": false
  }
}
```

### 24.3. Отключение только раннего threshold

```json
{
  "compaction": {
    "threshold_percent": null
  }
}
```

Payload/chunk recovery при реальном overflow при этом остаётся доступен, если `auto` не отключён.

## 25. Рекомендации для будущей синхронизации

1. При merge новой версии OpenCode сначала сохранить Kilo-specific файлы в `src/kilocode/session`.
2. Shared hooks переносить минимальными блоками с `kilocode_change`.
3. Не заменять provider-reported usage чистой client estimate.
4. Не возвращать процентную проверку в post-step `isOverflow()` без анализа stale totals.
5. Не удалять tool-loop defer.
6. Не менять `retarget()` на простое перемещение base boundary: это раскроет посторонние queued prompts.
7. После изменения config schema синхронизировать OpenAPI, SDK и webview type.
8. После добавления английского i18n-ключа обновлять все locale dictionaries.
9. Сохранять тест queued marker как обязательный regression guard issue #9774.

## 26. Критерии готовности

Backport считается работоспособным, если выполняются все условия:

- [x] Ветка основана точно на `v7.2.24`.
- [x] Compaction-marker виден внутри queued turn.
- [x] Посторонние queued prompts остаются скрытыми.
- [x] Поддерживается optional `threshold_percent`.
- [x] Preflight учитывает сообщения и tool schemas.
- [x] Encoded media не считается обычным текстом.
- [x] Provider-reported usage ограничивает output budget.
- [x] Threshold не разрывает tool-loop.
- [x] Устаревший `tokens.total` не вызывает повторную компрессию.
- [x] Payload-limit запускает очистку и retry.
- [x] Oversized history обрабатывается chunks.
- [x] Oversized replay может быть сокращён отдельно.
- [x] Реальные worker errors сохраняются.
- [x] Пустой worker response считается ошибкой.
- [x] `auto: false` действительно отключает автоматический recovery.
- [x] Настройка доступна в VS Code.
- [x] Все локали содержат новые ключи.
- [x] OpenAPI и SDK синхронизированы.
- [x] Профильные тесты и typecheck проходят.

## 27. Краткое резюме

Главная проблема issue #9774 заключалась не только в расчёте токенов. В queued turn служебный compaction-marker скрывался тем же механизмом, который должен был скрывать более новые пользовательские prompts. После этого CLI повторял исходный oversized request до исчерпания попыток.

Backport исправляет весь путь, а не только один симптом:

```text
оценка до запроса
  -> корректный marker внутри очереди
  -> обычная суммаризация
  -> payload cleanup при необходимости
  -> chunked fallback для oversized history
  -> безопасный replay
  -> продолжение пользовательского turn
```

Результат сохраняет архитектуру версии `7.2.24`, минимизирует изменения shared OpenCode-кода и предоставляет настройку, типы, переводы, тесты и инструкции сопровождения как единый законченный backport.
