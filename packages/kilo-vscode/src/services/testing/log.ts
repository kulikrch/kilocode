import * as vscode from "vscode"

let channel: vscode.OutputChannel | undefined

function output() {
  channel ??= vscode.window.createOutputChannel("Kilo Code Test Results")
  return channel
}

export function showTestResultsLog() {
  output().show(true)
}

export function testResultsLog(msg: string, data?: Record<string, unknown>) {
  const line = `[Kilo New] Test Results: ${msg}${data ? ` ${JSON.stringify(data, null, 2)}` : ""}`
  console.log(line)
  output().appendLine(line)
}

export function testResultsWarn(msg: string, err: unknown) {
  const line = `[Kilo New] Test Results: ${msg} ${err instanceof Error ? err.stack ?? err.message : String(err)}`
  console.warn(line)
  output().appendLine(line)
}
