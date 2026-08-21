import { describe, expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { Config } from "../../src/config"
import type { Provider } from "../../src/provider"
import { KiloCompactionChunks } from "../../src/kilocode/session/compaction-chunks"
import { KiloCompactionPayloadRecovery } from "../../src/kilocode/session/compaction-payload-recovery"
import { KiloLLM } from "../../src/kilocode/session/llm"
import { KiloSessionOverflow } from "../../src/kilocode/session/overflow"
import { MessageV2 } from "../../src/session/message-v2"
import { isOverflow, usable } from "../../src/session/overflow"

function cfg(compaction?: Config.Info["compaction"]): Config.Info {
  return { compaction } as Config.Info
}

function model(input: { context: number; output: number; limit?: number }): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: { context: input.context, input: input.limit, output: input.output },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

function tokens(input: number): MessageV2.Assistant["tokens"] {
  return { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
}

describe("Kilo compaction limits", () => {
  test("uses normalized token fields instead of stale provider totals", () => {
    const mdl = model({ context: 200_000, output: 32_000 })

    expect(isOverflow({ cfg: cfg(), model: mdl, tokens: { ...tokens(80_000), total: 250_000 } })).toBe(false)
    expect(isOverflow({ cfg: cfg(), model: mdl, tokens: { ...tokens(0), total: 168_000 } })).toBe(true)
  })

  test("counts reasoning tokens at the hard post-step boundary", () => {
    const mdl = model({ context: 200_000, output: 32_000 })
    expect(isOverflow({ cfg: cfg(), model: mdl, tokens: { ...tokens(167_999), reasoning: 1 } })).toBe(true)
  })

  test("preflight uses the configured percentage before provider overflow", () => {
    const conf = cfg({ threshold_percent: 75 })
    const mdl = model({ context: 200_000, output: 32_000 })
    const messages = [{ role: "user" as const, content: "x".repeat(600_000) }]

    expect(
      KiloSessionOverflow.shouldCompact({
        cfg: conf,
        model: mdl,
        usable: usable({ cfg: conf, model: mdl }),
        messages,
        tools: {},
      }),
    ).toBe(true)
  })

  test("preflight includes tool schemas", () => {
    const conf = cfg({ threshold_percent: 50 })
    const mdl = model({ context: 10_000, output: 1_000 })

    expect(
      KiloSessionOverflow.shouldCompact({
        cfg: conf,
        model: mdl,
        usable: usable({ cfg: conf, model: mdl }),
        messages: [{ role: "user", content: "hello" }],
        tools: { search: { description: "search", inputSchema: { description: "x".repeat(20_000) } } },
      }),
    ).toBe(true)
  })

  test("defers threshold compaction while continuing after a tool", () => {
    const conf = cfg({ threshold_percent: 1 })
    const mdl = model({ context: 200_000, output: 32_000 })
    const messages = [
      { role: "user", content: "work" },
      {
        role: "assistant",
        content: [{ type: "tool-call", toolCallId: "call-1", toolName: "bash", input: { cmd: "pwd" } }],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "x".repeat(20_000) },
          },
        ],
      },
    ] satisfies ModelMessage[]

    expect(
      KiloSessionOverflow.shouldCompact({
        cfg: conf,
        model: mdl,
        usable: usable({ cfg: conf, model: mdl }),
        messages,
        tools: {},
      }),
    ).toBe(false)
  })

  test("normalizes encoded media but preserves provider-reported vision usage", () => {
    const mdl = model({ context: 300_000, output: 32_000 })
    const messages = [
      { role: "user", content: [{ type: "image", image: `data:image/png;base64,${"x".repeat(600_000)}` }] },
    ] satisfies ModelMessage[]
    const usage = KiloSessionOverflow.measure({ messages, tools: {} })

    expect(usage.raw).toBeGreaterThan(usage.normalized)
    expect(KiloLLM.capOutputTokens({ model: mdl, messages, tools: {}, configured: 32_000, usage })).toBe(32_000)
    expect(
      KiloLLM.capOutputTokens({ model: mdl, messages, tools: {}, configured: 32_000, usage, reported: 280_000 }),
    ).toBe(17_952)
  })

  test("routes oversized compaction requests into recovery", () => {
    const overflow = new MessageV2.ContextOverflowError({ message: "request entity too large" }).toObject()
    const payload = new MessageV2.APIError({
      message: "function_payload_too_large",
      isRetryable: false,
    }).toObject()

    expect(KiloCompactionPayloadRecovery.matches(overflow)).toBe(true)
    expect(KiloCompactionPayloadRecovery.matches(payload)).toBe(true)
    expect(KiloCompactionPayloadRecovery.matches(undefined)).toBe(false)
  })

  test("uses chunked compaction when a summary request cannot fit", () => {
    const conf = cfg()
    const mdl = model({ context: 20_000, output: 8_000 })

    expect(KiloCompactionChunks.needed({ cfg: conf, model: mdl, tokens: 15_000 })).toBe(true)
    expect(KiloCompactionChunks.needed({ cfg: conf, model: mdl, tokens: 1_000 })).toBe(false)
  })
})
