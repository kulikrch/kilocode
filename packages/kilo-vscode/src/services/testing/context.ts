import * as vscode from "vscode"
import { truncateTerminalOutput, type TerminalLimitOptions, type TerminalOutput } from "../terminal/truncate"
import { testResultsLog, testResultsWarn } from "./log"

type Result = {
  output?: string
}

type Tests = typeof vscode.tests & {
  testResults?: readonly Result[]
}

function log(msg: string, data?: Record<string, unknown>) {
  testResultsLog(`capture: ${msg}`, data)
}

function readObserved(): string {
  try {
    const tests = vscode.tests as Tests
    const results = tests.testResults
    const output = results?.find((result) => result.output?.trim())?.output?.trim() ?? ""
    log("observer checked", { count: results?.length ?? 0, length: output.length })
    return output
  } catch (err) {
    testResultsWarn("VS Code test observer output is unavailable:", err)
    return ""
  }
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

function record(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined
}

function result(value: unknown) {
  const raw = record(value)
  return text(raw?.resultId)
}

function item(value: unknown) {
  const raw = record(value)
  const test = record(raw?.test)
  const node = record(raw?.item)
  const tests = Array.isArray(raw?.tests) ? raw.tests : undefined
  const last = tests?.at(-1)
  const lastRaw = record(last)
  const lastItem = record(lastRaw?.item)
  return text(test?.extId) ?? text(node?.extId) ?? text(raw?.extId) ?? text(lastItem?.extId)
}

function uri(resultId: string, test?: string) {
  return vscode.Uri.from({
    scheme: "vscode-test-data",
    authority: "results",
    path: `/${resultId}/output/0`,
    query: test,
  })
}

async function readData(args: unknown[]): Promise<string> {
  const id = args.map(result).find(Boolean)
  if (!id) {
    log("vscode-test-data skipped", { reason: "no resultId in command arguments" })
    return ""
  }

  const test = args.map(item).find(Boolean)
  const target = uri(id, test)
  log("opening vscode-test-data document", { uri: target.toString(), assumedTaskIndex: 0 })

  try {
    const doc = await vscode.workspace.openTextDocument(target)
    const text = doc.getText().trim()
    log("vscode-test-data document read", { length: text.length, languageId: doc.languageId })
    return text
  } catch (err) {
    testResultsWarn(`failed to read ${target.toString()}:`, err)
    return ""
  }
}

async function copyVisible(): Promise<string> {
  log("copy fallback skipped", {
    reason: "VS Code renders Test Results output in an internal detached terminal, not vscode.window.activeTerminal",
  })
  return ""
}

export async function getTestResultsContents(args: unknown[] = [], opts?: TerminalLimitOptions): Promise<TerminalOutput> {
  const observed = readObserved()
  if (observed) return truncateTerminalOutput(observed, opts)

  const data = await readData(args)
  if (data) return truncateTerminalOutput(data, opts)

  const copied = await copyVisible()
  return truncateTerminalOutput(copied, opts)
}
