import { afterEach, describe, expect, it } from "bun:test"
import * as vscode from "vscode"
import { registerTestResultsActions } from "../../src/services/code-actions/register-test-results-actions"

type Command = (...args: unknown[]) => unknown

type Api = typeof vscode & {
  commands: {
    registerCommand: (command: string, callback: Command) => { dispose(): void }
    executeCommand: (...args: unknown[]) => Promise<void>
  }
  workspace: {
    openTextDocument: (uri: vscode.Uri) => Promise<{ getText(): string; languageId: string }>
  }
  Uri: {
    from: (parts: { scheme: string; authority: string; path: string; query?: string }) => vscode.Uri
  }
}

const api = vscode as Api
const original = {
  register: api.commands.registerCommand,
  execute: api.commands.executeCommand,
  open: api.workspace.openTextDocument,
  uri: api.Uri.from,
}

function setup(active = false) {
  const commands = new Map<string, Command>()
  const executed: unknown[][] = []
  const events: string[] = []
  const posts: unknown[] = []
  const waits: string[] = []
  const context = { subscriptions: [] as Array<{ dispose(): void }> } as vscode.ExtensionContext
  const provider = {
    postMessage: (msg: unknown) => {
      events.push("post")
      posts.push(msg)
    },
    waitForReady: async () => {
      events.push("wait")
      waits.push("provider")
    },
  }
  const agent = {
    isActive: () => active,
    postMessage: (msg: unknown) => {
      events.push("post")
      posts.push(msg)
    },
  }

  api.commands.registerCommand = (command, callback) => {
    commands.set(command, callback)
    return { dispose: () => undefined }
  }
  api.commands.executeCommand = async (...args) => {
    events.push("focus")
    executed.push(args)
  }
  api.workspace.openTextDocument = original.open
  api.Uri.from = (parts) =>
    ({
      toString: () => `${parts.scheme}://${parts.authority}${parts.path}${parts.query ? `?${parts.query}` : ""}`,
    }) as vscode.Uri

  registerTestResultsActions(context, provider as never, agent as never)

  return { commands, events, executed, posts, waits }
}

afterEach(() => {
  api.commands.registerCommand = original.register
  api.commands.executeCommand = original.execute
  api.workspace.openTextDocument = original.open
  api.Uri.from = original.uri
})

describe("registerTestResultsActions", () => {
  it("reveals the sidebar before adding test results to context", async () => {
    const state = setup()

    await state.commands.get("kilo-code.new.testResultsAddToContext")?.({ selection: "1 failed" })

    expect(state.events).toEqual(["focus", "wait", "post", "post"])
    expect(state.executed).toEqual([["kilo-code.SidebarProvider.focus"]])
    expect(state.waits).toEqual(["provider"])
    expect(state.posts).toEqual([
      {
        type: "appendChatBoxMessage",
        text: "\nTest results:\n```\n1 failed\n```",
      },
      { type: "action", action: "focusInput" },
    ])
  })

  it("sends fix prompts from test messages to the active Agent Manager", async () => {
    const state = setup(true)

    await state.commands.get("kilo-code.new.testResultsFixFailures")?.({
      test: { label: "adds numbers" },
      message: {
        message: "AssertionError",
        expectedOutput: "2",
        actualOutput: "1",
      },
    })

    expect(state.events).toEqual(["post"])
    expect(state.executed).toEqual([])
    expect(state.waits).toEqual([])
    expect(state.posts).toEqual([
      {
        type: "triggerTask",
        text: expect.stringContaining("Fix these test failures"),
      },
    ])
    const text = (state.posts[0] as { text: string }).text
    expect(text).toContain("Test: adds numbers")
    expect(text).toContain("Expected:\n2\nActual:\n1")
  })

  it("reads serialized VS Code test message arguments", async () => {
    const state = setup(true)

    await state.commands.get("kilo-code.new.testResultsFixFailures")?.({
      test: { item: { label: "adds numbers" } },
      message: {
        message: "AssertionError",
        expected: "2",
        actual: "1",
      },
    })

    const text = (state.posts[0] as { text: string }).text
    expect(text).toContain("Test: adds numbers")
    expect(text).toContain("Expected:\n2\nActual:\n1")
  })

  it("reads vscode-test-data output when result context is passed", async () => {
    const state = setup(true)
    const uris: string[] = []
    api.workspace.openTextDocument = async (uri) => {
      uris.push(uri.toString())
      return { getText: () => "bun test output", languageId: "plaintext" }
    }

    await state.commands.get("kilo-code.new.testResultsExplain")?.(
      { tests: [{ item: { extId: "ctrl/test", label: "adds numbers" } }] },
      { resultId: "result-1", taskId: "task-1" },
    )

    expect(uris).toEqual(["vscode-test-data://results/result-1/output/0?ctrl/test"])
    const text = (state.posts[0] as { text: string }).text
    expect(text).toContain("bun test output")
  })
})
