import { describe, expect, it } from "bun:test"

const { AiCodeFlowMetrics, classify } = await import("../../src/services/telemetry/ai-code-flow")

describe("ai code flow metrics", () => {
  it("counts single character edits as manual input", () => {
    expect(classify("x")).toEqual({ ai: 0, manual: 1, ide: 0, pasted: 0 })
  })

  it("splits editor auto indentation from the manual newline", () => {
    expect(classify("\n  ")).toEqual({ ai: 0, manual: 1, ide: 2, pasted: 0 })
  })

  it("counts clipboard text as pasted input", () => {
    expect(classify("const value = 1", "const value = 1")).toEqual({ ai: 0, manual: 0, ide: 0, pasted: 15 })
  })

  it("counts marked inline completion text as ai input", () => {
    AiCodeFlowMetrics.markAi("return value")

    expect(classify("return value")).toEqual({ ai: 12, manual: 0, ide: 0, pasted: 0 })
  })

  it("counts marked inline completion chunks as ai input", () => {
    AiCodeFlowMetrics.markAi("first second")

    expect(classify("first ")).toEqual({ ai: 6, manual: 0, ide: 0, pasted: 0 })
    expect(classify("second")).toEqual({ ai: 6, manual: 0, ide: 0, pasted: 0 })
  })
})
