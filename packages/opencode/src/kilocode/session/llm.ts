import type { ModelMessage } from "ai"
import type { Provider } from "@/provider"
import { KiloSessionOverflow } from "./overflow"

const SAFETY = 2_048
const MIN_OUTPUT = 1_024

export namespace KiloLLM {
  export function needsEstimate(input: { model: Provider.Model; configured: number | undefined }) {
    return input.configured !== undefined && input.configured > 0 && input.model.limit.context > 0
  }

  export function capOutputTokens(input: {
    model: Provider.Model
    messages: ModelMessage[]
    tools: Record<string, { description?: string; inputSchema?: unknown }>
    configured: number | undefined
    usage?: ReturnType<typeof KiloSessionOverflow.measure>
    reported?: number
  }) {
    if (input.configured == null) return input.configured
    if (input.configured <= 0) return undefined
    const context = input.model.limit.context
    if (!context) return input.configured

    const estimated =
      input.usage?.normalized ??
      KiloSessionOverflow.measure({ messages: input.messages, tools: input.tools }).normalized
    const tokens = Math.max(input.reported ?? 0, estimated)
    const available = context - tokens - SAFETY
    if (available <= 0 || available >= input.configured) return input.configured
    return Math.max(MIN_OUTPUT, available)
  }
}
