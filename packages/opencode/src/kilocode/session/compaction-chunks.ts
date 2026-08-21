import { Effect } from "effect"
import type { Agent } from "@/agent/agent"
import type { Config } from "@/config"
import type { Provider } from "@/provider"
import type { LLM } from "@/session/llm"
import { MessageV2 } from "@/session/message-v2"
import { usable } from "@/session/overflow"
import type { SessionProcessor } from "@/session/processor"
import { MessageID, PartID, type SessionID } from "@/session/schema"
import type * as Session from "@/session/session"
import { Log, Token } from "@/util"

const log = Log.create({ service: "kilocode.compaction.chunks" })
const PART_MAX_CHARS = 16_000
const TOOL_MAX_CHARS = 2_000
const RATIO = 0.6
const OUTPUT = 2_048
const DEPTH = 3

type Chunk = {
  index: number
  messages: MessageV2.WithParts[]
}

type Output = {
  result: SessionProcessor.Result
  output: string | undefined
  error: MessageV2.Assistant["error"]
}

type Input = {
  processors: SessionProcessor.Interface
  session: Pick<Session.Interface, "updateMessage" | "updatePart" | "removeMessage">
  user: MessageV2.User
  agent: Agent.Info
  sessionID: SessionID
  model: Provider.Model
  cfg: Config.Info
  messages: MessageV2.WithParts[]
  prompt: string
  target: MessageV2.Assistant
}

type Replay = {
  info: MessageV2.User
  parts: MessageV2.Part[]
}

function clip(input: { text: string; chars: number; label: string }) {
  if (input.text.length <= input.chars) return input.text
  const cut = input.text.length - input.chars
  return `${input.text.slice(0, input.chars)}\n[${input.label} truncated for compaction: omitted ${cut} chars]`
}

function content(part: MessageV2.Part) {
  if (part.type === "text") return clip({ text: part.text, chars: PART_MAX_CHARS, label: "Text" })
  if (part.type === "reasoning")
    return `[Reasoning]: ${clip({ text: part.text, chars: PART_MAX_CHARS, label: "Reasoning" })}`
  if (part.type === "file") return `[File attachment]: ${part.filename ?? part.url} (${part.mime})`
  if (part.type === "agent") return `[Agent]: ${part.name}`
  if (part.type === "subtask")
    return `[Subtask ${part.agent}]: ${part.description}\n${clip({ text: part.prompt, chars: PART_MAX_CHARS, label: "Subtask prompt" })}`
  if (part.type === "tool") {
    const head = `[Tool ${part.tool} ${part.state.status}]`
    if (part.state.status === "completed") {
      return [
        head,
        `input: ${clip({ text: JSON.stringify(part.state.input), chars: TOOL_MAX_CHARS, label: "Tool input" })}`,
        `output: ${clip({ text: part.state.output, chars: TOOL_MAX_CHARS, label: "Tool output" })}`,
      ].join("\n")
    }
    if (part.state.status === "error")
      return `${head}\n${clip({ text: part.state.error, chars: TOOL_MAX_CHARS, label: "Tool error" })}`
    return `${head}\ninput: ${clip({ text: JSON.stringify(part.state.input), chars: TOOL_MAX_CHARS, label: "Tool input" })}`
  }
  if (part.type === "step-finish") return `[Step finished]: ${part.reason}`
  if (part.type === "compaction") return "[Compaction requested]"
  return `[${part.type}]`
}

function transcript(input: { messages: MessageV2.WithParts[] }) {
  return input.messages
    .map((msg, index) => {
      const body = msg.parts.map(content).join("\n\n")
      return [`<message index="${index + 1}" role="${msg.info.role}">`, body || "[no content]", "</message>"].join(
        "\n",
      )
    })
    .join("\n\n")
}

function text(msg: MessageV2.Assistant) {
  return MessageV2.parts(msg.id)
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join("\n\n")
    .trim()
}

export namespace KiloCompactionChunks {
  export function eligible(input: { result: SessionProcessor.Result; error: MessageV2.Assistant["error"] }) {
    if (input.result === "compact") return true
    return input.result === "stop" && input.error?.name === "ContextOverflowError"
  }

  export function budget(input: { cfg: Config.Info; model: Provider.Model }) {
    return Math.max(1_000, Math.floor(usable({ cfg: input.cfg, model: model(input.model) }) * RATIO))
  }

  export function needed(input: { cfg: Config.Info; model: Provider.Model; tokens: number }) {
    const mdl = model(input.model)
    return Math.ceil(input.tokens * 1.3) + mdl.limit.output > usable({ cfg: input.cfg, model: mdl })
  }

  function model(input: Provider.Model) {
    return {
      ...input,
      limit: { ...input.limit, output: Math.min(input.limit.output || OUTPUT, OUTPUT) },
    } satisfies Provider.Model
  }

  export function split(input: { messages: MessageV2.WithParts[]; size: number }) {
    const chunks: Chunk[] = []
    let buf: MessageV2.WithParts[] = []
    for (const msg of input.messages) {
      const next = [...buf, msg]
      const size = Token.estimate(transcript({ messages: next }))
      if (buf.length && size > input.size) {
        chunks.push({ index: chunks.length, messages: buf })
        buf = [msg]
        continue
      }
      buf = next
    }
    if (buf.length) chunks.push({ index: chunks.length, messages: buf })
    return chunks
  }

  function assistant(input: Input) {
    return {
      ...input.target,
      id: MessageID.ascending(),
      cost: 0,
      tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      time: { created: Date.now() },
      finish: undefined,
      error: undefined,
    } satisfies MessageV2.Assistant
  }

  function run(input: Input & { data: LLM.StreamInput["messages"]; text: string }) {
    return Effect.gen(function* () {
      const msg = yield* input.session.updateMessage(assistant(input))
      const mdl = model(input.model)
      const worker = yield* input.processors.create({ assistantMessage: msg, sessionID: input.sessionID, model: mdl })
      const options = Object.fromEntries(
        Object.entries(input.agent.options).filter(([key]) => key !== "maxOutputTokens"),
      )
      const agent = { ...input.agent, options }
      const output = yield* Effect.gen(function* () {
        const result = yield* worker.process({
          user: input.user,
          agent,
          sessionID: input.sessionID,
          tools: {},
          system: [],
          messages: [...input.data, { role: "user", content: [{ type: "text", text: input.text }] }],
          model: mdl,
        })
        return {
          result,
          output: text(worker.message),
          error: worker.message.error ?? worker.compactError?.(),
        }
      }).pipe(
        Effect.ensuring(
          input.session.removeMessage({ sessionID: input.sessionID, messageID: worker.message.id }).pipe(Effect.ignore),
        ),
      )
      if (output.result !== "continue") return { ...output, output: undefined }
      if (output.output) return { ...output, error: undefined }
      return {
        result: "stop" as const,
        output: undefined,
        error:
          output.error ??
          new MessageV2.APIError({
            message: "Compaction worker returned an empty response",
            isRetryable: true,
          }).toObject(),
      }
    })
  }

  function summarize(input: Input & { chunk: Chunk; total: number }) {
    const body = clip({
      text: transcript({ messages: input.chunk.messages }),
      chars: Math.max(4_000, Math.floor(budget(input) * 3)),
      label: "Transcript",
    })
    const data: LLM.StreamInput["messages"] = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: [
              "The following transcript is an oversized conversation chunk.",
              "Summarize only facts present in it.",
              "<conversation>",
              body,
              "</conversation>",
            ].join("\n"),
          },
        ],
      },
    ]
    const prompt = [
      `Summarize conversation chunk ${input.chunk.index + 1} of ${input.total}.`,
      "Preserve file paths, commands, errors, decisions, and unresolved tasks.",
      "Use terse Markdown bullets. Do not mention chunking or compaction.",
    ].join("\n")
    return run({ ...input, data, text: prompt })
  }

  function reduce(input: Input & { summaries: string[]; depth: number }): Effect.Effect<Output> {
    const messages: LLM.StreamInput["messages"] = input.summaries.map((summary, index) => ({
      role: "user",
      content: [{ type: "text", text: `<partial-summary index="${index + 1}">\n${summary}\n</partial-summary>` }],
    }))
    return run({ ...input, data: messages, text: input.prompt }).pipe(
      Effect.flatMap((result) => {
        if (result.result === "continue" || input.depth >= DEPTH || input.summaries.length <= 1) {
          return Effect.succeed(result)
        }
        const size = Math.ceil(input.summaries.length / 2)
        const groups = Array.from({ length: Math.ceil(input.summaries.length / size) }, (_, index) =>
          input.summaries.slice(index * size, index * size + size),
        )
        return Effect.forEach(groups, (summaries) => reduce({ ...input, summaries, depth: input.depth + 1 }), {
          concurrency: 1,
        }).pipe(
          Effect.flatMap((next) => {
            const failed = next.find((item) => item.result !== "continue" || !item.output)
            if (failed) return Effect.succeed(result)
            return reduce({ ...input, summaries: next.map((item) => item.output!), depth: input.depth + 2 })
          }),
        )
      }),
    )
  }

  function fail(input: Input, output: Output | undefined) {
    if (output?.result !== "stop" || !output.error || output.error.name === "ContextOverflowError")
      return Effect.succeed(false)
    input.target.error = output.error
    input.target.finish = "error"
    input.target.time.completed = Date.now()
    return input.session.updateMessage(input.target).pipe(Effect.as(true))
  }

  export function process(input: Input) {
    return Effect.gen(function* () {
      const size = budget(input)
      const chunks = split({ messages: input.messages, size })
      log.info("fallback", { chunks: chunks.length })
      const partial = yield* Effect.forEach(chunks, (chunk) => summarize({ ...input, chunk, total: chunks.length }), {
        concurrency: Math.min(3, chunks.length),
      })
      const failed = partial.find((item) => item.result !== "continue" || !item.output)
      if (failed) return (yield* fail(input, failed)) ? ("stop" as const) : ("compact" as const)

      const final = yield* reduce({ ...input, summaries: partial.map((item) => item.output!), depth: 0 })
      if (final.result !== "continue" || !final.output) {
        return (yield* fail(input, final)) ? ("stop" as const) : ("compact" as const)
      }

      yield* input.session.updatePart({
        id: PartID.ascending(),
        messageID: input.target.id,
        sessionID: input.sessionID,
        type: "text",
        text: final.output,
      })
      input.target.finish = "stop"
      input.target.error = undefined
      input.target.time.completed = Date.now()
      yield* input.session.updateMessage(input.target)
      return "continue" as const
    })
  }

  export function replay(input: Input & { replay: Replay }) {
    return Effect.gen(function* () {
      const count = Token.estimate(transcript({ messages: [{ info: input.replay.info, parts: input.replay.parts }] }))
      if (count <= budget(input)) return input.replay
      const result = yield* summarize({
        ...input,
        chunk: { index: 0, messages: [{ info: input.replay.info, parts: input.replay.parts }] },
        total: 1,
      })
      if (result.result !== "continue" || !result.output) return input.replay
      return {
        info: input.replay.info,
        parts: [
          {
            id: PartID.ascending(),
            messageID: input.replay.info.id,
            sessionID: input.sessionID,
            type: "text" as const,
            synthetic: true,
            text: [
              "The original replayed request was too large to send after compaction.",
              "Use this compacted representation instead:",
              result.output,
            ].join("\n\n"),
          },
        ],
      } satisfies Replay
    })
  }
}
