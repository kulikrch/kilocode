import { describe, expect, it } from "bun:test"
import * as vscode from "vscode"

const { AiCodeFlowMetrics, classify } = await import("../../src/services/telemetry/ai-code-flow")

function change(text: string, rangeLength = 0) {
  return { text, rangeLength }
}

function event(contentChanges: ReturnType<typeof change>[], scheme = "file") {
  return {
    document: { uri: { scheme } },
    contentChanges,
  }
}

function create() {
  const captures: Array<{ event: string; properties?: Record<string, unknown> }> = []
  const metrics = new AiCodeFlowMetrics({
    capture: (name: string, properties?: Record<string, unknown>) => {
      captures.push({ event: name, properties })
    },
  } as never)
  return { captures, metrics }
}

function setClipboard(text: string) {
  const previous = vscode.env.clipboard.readText
  ;(vscode.env.clipboard as { readText: () => Thenable<string> }).readText = () => Promise.resolve(text)
  return () => {
    ;(vscode.env.clipboard as { readText: () => Thenable<string> }).readText = previous
  }
}

function registered() {
  const previous = vscode.workspace.onDidChangeTextDocument
  const listeners: Array<(input: unknown) => void> = []
  ;(vscode.workspace as { onDidChangeTextDocument: (listener: (input: unknown) => void) => vscode.Disposable })
    .onDidChangeTextDocument = (listener) => {
    listeners.push(listener)
    return { dispose: () => {} } as vscode.Disposable
  }
  const context = { subscriptions: [] as vscode.Disposable[] }
  const state = create()
  state.metrics.register(context as vscode.ExtensionContext)
  return {
    ...state,
    emit: async (input: unknown) => {
      for (const listener of listeners) listener(input)
      await Promise.resolve()
      await Promise.resolve()
    },
    dispose: () => {
      state.metrics.dispose()
      for (const item of context.subscriptions) item.dispose()
      ;(vscode.workspace as { onDidChangeTextDocument: typeof previous }).onDidChangeTextDocument = previous
    },
  }
}

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

  it("uses net-new length for replacements", () => {
    expect(classify("abcdef", "abcdef", Date.now(), 2)).toEqual({ ai: 0, manual: 0, ide: 0, pasted: 4 })
    expect(classify("x", "", Date.now(), 3)).toEqual({ ai: 0, manual: 0, ide: 0, pasted: 0 })
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

  it("does not count expired ai marks as ai input", () => {
    const now = Date.now()
    AiCodeFlowMetrics.markAi("expired completion")

    expect(classify("expired completion", "", now + 11_000)).toEqual({ ai: 0, manual: 0, ide: 18, pasted: 0 })
  })

  it("aggregates a mixed user flow before flush", async () => {
    const reset = setClipboard("")
    const { captures, metrics } = create()
    try {
      await (metrics as unknown as { process: (input: unknown) => Promise<void> }).process(event([change("x")]))

      AiCodeFlowMetrics.markAi("return value")
      await (metrics as unknown as { process: (input: unknown) => Promise<void> }).process(event([change("return value")]))

      reset()
      const restore = setClipboard("copied()")
      await (metrics as unknown as { process: (input: unknown) => Promise<void> }).process(event([change("copied()")]))
      restore()

      await (metrics as unknown as { process: (input: unknown) => Promise<void> }).process(event([change("\n  ")]))
      metrics.flush()

      expect(captures).toEqual([
        {
          event: "ai_code_flow",
          properties: {
            ai_chars: 12,
            manual_chars: 2,
            ide_chars: 2,
            pasted_chars: 8,
            total_chars: 22,
            repo_name: null,
            source: "vscode_document",
          },
        },
      ])
    } finally {
      metrics.dispose()
      reset()
    }
  })

  it("keeps agent tool telemetry separate from later local edits", async () => {
    const reset = setClipboard("manual paste")
    const { captures, metrics } = create()
    try {
      await (metrics as unknown as { process: (input: unknown) => Promise<void> }).process(
        event([change("r"), change("manual paste")]),
      )

      AiCodeFlowMetrics.markAi("autocomplete")
      await (metrics as unknown as { process: (input: unknown) => Promise<void> }).process(event([change("autocomplete")]))

      metrics.flush()

      expect(captures[0]?.properties).toMatchObject({
        ai_chars: 12,
        manual_chars: 1,
        ide_chars: 0,
        pasted_chars: 12,
        total_chars: 25,
      })
    } finally {
      metrics.dispose()
      reset()
    }
  })

  it("counts paste-over-selection by net-new chars and ignores pure deletion", async () => {
    const reset = setClipboard("abcdefghij")
    const { captures, metrics } = create()
    try {
      await (metrics as unknown as { process: (input: unknown) => Promise<void> }).process(
        event([change("abcdefghij", 3), change("", 5)]),
      )
      metrics.flush()

      expect(captures[0]?.properties).toMatchObject({
        ai_chars: 0,
        manual_chars: 0,
        ide_chars: 0,
        pasted_chars: 7,
        total_chars: 7,
      })
    } finally {
      metrics.dispose()
      reset()
    }
  })

  it("lets marked ai text win over clipboard classification", async () => {
    const reset = setClipboard("same text")
    const { captures, metrics } = create()
    try {
      AiCodeFlowMetrics.markAi("same text")
      await (metrics as unknown as { process: (input: unknown) => Promise<void> }).process(event([change("same text")]))
      metrics.flush()

      expect(captures[0]?.properties).toMatchObject({
        ai_chars: 9,
        manual_chars: 0,
        pasted_chars: 0,
        total_chars: 9,
      })
    } finally {
      metrics.dispose()
      reset()
    }
  })

  it("ignores non-editor document schemes", async () => {
    const { captures, metrics } = create()
    try {
      await (metrics as unknown as { process: (input: unknown) => Promise<void> }).process(
        event([change("virtual text")], "output"),
      )
      metrics.flush()

      expect(captures).toEqual([])
    } finally {
      metrics.dispose()
    }
  })

  it("resets counters after flush", async () => {
    const { captures, metrics } = create()
    try {
      await (metrics as unknown as { process: (input: unknown) => Promise<void> }).process(event([change("x")]))
      metrics.flush()
      metrics.flush()

      expect(captures).toHaveLength(1)
      expect(captures[0]?.properties).toMatchObject({ manual_chars: 1, total_chars: 1 })
    } finally {
      metrics.dispose()
    }
  })

  it("runs through the registered VS Code listener for a realistic editing session", async () => {
    const reset = setClipboard("")
    const flow = registered()
    try {
      await flow.emit(event([change("f"), change("n")]))

      AiCodeFlowMetrics.markAi(" generatedCall()")
      await flow.emit(event([change(" generatedCall()")]))

      reset()
      const paste = setClipboard("const pasted = true")
      await flow.emit(event([change("const pasted = true")]))
      paste()

      await flow.emit(event([change("replacement", 4), change("\n    ")]))
      flow.metrics.flush()

      expect(flow.captures).toEqual([
        {
          event: "ai_code_flow",
          properties: {
            ai_chars: 16,
            manual_chars: 3,
            ide_chars: 11,
            pasted_chars: 19,
            total_chars: 38,
            repo_name: null,
            source: "vscode_document",
          },
        },
      ])
    } finally {
      flow.dispose()
      reset()
    }
  })

  it("separates two work periods with a flush between agent turns", async () => {
    const flow = registered()
    try {
      await flow.emit(event([change("a")]))
      AiCodeFlowMetrics.markAi("firstCompletion")
      await flow.emit(event([change("firstCompletion")]))
      flow.metrics.flush()

      const paste = setClipboard("second paste")
      await flow.emit(event([change("second paste")]))
      paste()
      await flow.emit(event([change("z")]))
      AiCodeFlowMetrics.markAi("secondCompletion")
      await flow.emit(event([change("secondCompletion")]))
      flow.metrics.flush()

      expect(flow.captures).toHaveLength(2)
      expect(flow.captures[0]?.properties).toMatchObject({
        ai_chars: 15,
        manual_chars: 1,
        pasted_chars: 0,
        total_chars: 16,
      })
      expect(flow.captures[1]?.properties).toMatchObject({
        ai_chars: 16,
        manual_chars: 1,
        pasted_chars: 12,
        total_chars: 29,
      })
    } finally {
      flow.dispose()
    }
  })
})
