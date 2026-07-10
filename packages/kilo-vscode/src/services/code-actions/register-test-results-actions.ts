import * as vscode from "vscode"
import type { KiloProvider } from "../../KiloProvider"
import type { AgentManagerProvider } from "../../agent-manager/AgentManagerProvider"
import { getTestResultsContents } from "../testing/context"
import { showTestResultsLog, testResultsLog } from "../testing/log"
import { createPrompt } from "./support-prompt"

type Args = {
  selection?: unknown
  output?: unknown
  text?: unknown
  test?: {
    label?: unknown
  }
  item?: {
    label?: unknown
  }
  message?: {
    message?: unknown
    expectedOutput?: unknown
    actualOutput?: unknown
    expected?: unknown
    actual?: unknown
    stackTrace?: unknown
  }
  testMessage?: {
    message?: unknown
    expectedOutput?: unknown
    actualOutput?: unknown
    expected?: unknown
    actual?: unknown
    stackTrace?: unknown
  }
}

type Message = NonNullable<Args["message"]>

function preview(value: unknown, depth = 0): unknown {
  if (value === undefined || value === null) return value
  if (typeof value === "string") return value.length > 300 ? `${value.slice(0, 300)}...` : value
  if (typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) return depth > 1 ? `[array:${value.length}]` : value.slice(0, 5).map((item) => preview(item, depth + 1))
  if (typeof value !== "object") return typeof value
  if (depth > 1) return `[object:${Object.keys(value).join(",")}]`
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, preview(item, depth + 1)]))
}

function log(action: string, msg: string, data?: Record<string, unknown>) {
  testResultsLog(`${action}: ${msg}`, data)
}

function valueText(value: unknown) {
  if (typeof value === "string") return value
  if (value && typeof value === "object" && "value" in value && typeof value.value === "string") return value.value
  return undefined
}

function stackText(value: unknown) {
  if (!Array.isArray(value)) return undefined
  const lines = value
    .map((frame) => {
      if (!frame || typeof frame !== "object") return undefined
      const label = "label" in frame && typeof frame.label === "string" ? frame.label : undefined
      const uri =
        "uri" in frame && frame.uri && typeof frame.uri === "object" && "fsPath" in frame.uri
          ? String(frame.uri.fsPath)
          : undefined
      return [label, uri].filter(Boolean).join(" ")
    })
    .filter(Boolean)
  return lines.length ? `Stack:\n${lines.join("\n")}` : undefined
}

function testLabel(value: unknown) {
  if (!value || typeof value !== "object") return undefined
  const args = value as Args
  const raw = value as Record<string, unknown>
  const test = record(args.test)
  const node = record(args.item)
  const testItem = record(test?.item)
  const rawItem = record(raw.item)
  if (typeof testItem?.label === "string") return testItem.label
  if (typeof test?.label === "string") return test.label
  if (typeof node?.label === "string") return node.label
  if (typeof rawItem?.label === "string") return rawItem.label
  if (typeof args.item?.label === "string") return args.item.label
  if (typeof raw.label === "string") return raw.label
  return undefined
}

function record(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function messageValue(value: unknown): Message | undefined {
  if (!value || typeof value !== "object") return undefined
  const args = value as Args
  const raw = value as Record<string, unknown>
  const message = args.message ?? args.testMessage
  if (message && typeof message === "object") return message
  if ("message" in raw || "expectedOutput" in raw || "actualOutput" in raw || "expected" in raw || "actual" in raw) {
    return {
      message: raw.message,
      expectedOutput: raw.expectedOutput,
      actualOutput: raw.actualOutput,
      expected: raw.expected,
      actual: raw.actual,
      stackTrace: raw.stackTrace,
    }
  }
  return undefined
}

function messageText(test: unknown, value: unknown) {
  const msg = messageValue(value)
  if (!msg) return undefined
  const label = testLabel(test) ?? testLabel(value)
  const title = label ? `Test: ${label}` : undefined
  const message = valueText(msg.message)
  const expected = valueText(msg.expectedOutput) ?? valueText(msg.expected)
  const actual = valueText(msg.actualOutput) ?? valueText(msg.actual)
  const diff = expected || actual ? `Expected:\n${expected ?? ""}\nActual:\n${actual ?? ""}` : undefined
  const stack = stackText(msg.stackTrace)
  return [title, message, diff, stack].filter(Boolean).join("\n\n")
}

function argText(args: unknown) {
  if (!args || typeof args !== "object") {
    log("context", "no object argument", { type: typeof args, value: preview(args) })
    return undefined
  }
  log("context", "received argument", { keys: Object.keys(args), value: preview(args) })
  const value = (args as Args).selection ?? (args as Args).output ?? (args as Args).text
  if (typeof value === "string" && value.trim()) {
    log("context", "using direct text field", { length: value.length })
    return value
  }
  const message = messageText(args, args)
  if (message?.trim()) {
    log("context", "using TestMessage argument", { length: message.length })
  } else {
    log("context", "argument did not contain readable text")
  }
  return message?.trim() ? message : undefined
}

function argsText(args: unknown[]) {
  const direct = args.map(argText).find((item) => item?.trim())
  if (direct) return direct
  const test = args.find((item) => testLabel(item))
  const message = args.find((item) => messageValue(item))
  const text = messageText(test, message)
  if (text?.trim()) {
    log("context", "using combined TestItem/TestMessage arguments", { length: text.length })
    return text
  }
  return undefined
}

export function registerTestResultsActions(
  context: vscode.ExtensionContext,
  provider: KiloProvider,
  agentManager?: AgentManagerProvider,
): void {
  const target = () => (agentManager?.isActive() ? agentManager : provider)
  const reveal = async () => {
    await vscode.commands.executeCommand("kilo-code.SidebarProvider.focus")
    await provider.waitForReady()
  }
  const read = async (action: string, args: unknown[]) => {
    log(action, "command invoked", { count: args.length, args: args.map((arg) => preview(arg)) })
    const text = argsText(args)
    if (text) return text
    log(action, "falling back to Test Results output capture")
    const output = await getTestResultsContents(args)
    log(action, "fallback finished", { length: output.content.length, truncated: output.truncated })
    return output.content
  }
  const send = async (...messages: unknown[]) => {
    const view = target()
    if (view === provider) {
      await reveal()
    }
    for (const msg of messages) {
      view.postMessage(msg)
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("kilo-code.new.testResultsAddToContext", async (...args: unknown[]) => {
      const content = await read("addToContext", args)
      if (!content) {
        log("addToContext", "no content available")
        showTestResultsLog()
        vscode.window.showInformationMessage("No test results output available. Run tests and open Test Results first.")
        return
      }
      await send(
        {
          type: "appendChatBoxMessage",
          text: createPrompt("TEST_RESULTS_ADD_TO_CONTEXT", {
            testResultsContent: content,
            userInput: "",
          }),
        },
        { type: "action", action: "focusInput" },
      )
    }),

    vscode.commands.registerCommand("kilo-code.new.testResultsFixFailures", async (...args: unknown[]) => {
      const content = await read("fixFailures", args)
      if (!content) {
        log("fixFailures", "no content available")
        showTestResultsLog()
        vscode.window.showInformationMessage("No test results output available. Run tests and open Test Results first.")
        return
      }
      await send({
        type: "triggerTask",
        text: createPrompt("TEST_RESULTS_FIX", {
          testResultsContent: content,
          userInput: "",
        }),
      })
    }),

    vscode.commands.registerCommand("kilo-code.new.testResultsExplain", async (...args: unknown[]) => {
      const content = await read("explain", args)
      if (!content) {
        log("explain", "no content available")
        showTestResultsLog()
        vscode.window.showInformationMessage("No test results output available. Run tests and open Test Results first.")
        return
      }
      await send({
        type: "triggerTask",
        text: createPrompt("TEST_RESULTS_EXPLAIN", {
          testResultsContent: content,
          userInput: "",
        }),
      })
    }),
  )
}
