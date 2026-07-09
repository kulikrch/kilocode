import * as vscode from "vscode"
import { TelemetryEventName } from "./types"
import { TelemetryProxy } from "./telemetry-proxy"
import { chunks, hash, type Chunk, type Source } from "./commit-ai-ratio"

export type Counters = {
  ai: number
  manual: number
  ide: number
  pasted: number
}

const empty = (): Counters => ({ ai: 0, manual: 0, ide: 0, pasted: 0 })

const ttl = 10_000
const interval = 15 * 60_000
const marks: { text: string; expires: number; source: Source }[] = []

function add(into: Counters, from: Counters) {
  into.ai += from.ai
  into.manual += from.manual
  into.ide += from.ide
  into.pasted += from.pasted
}

function takeMarked(text: string, now = Date.now()): Source | undefined {
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i]!
    if (mark.expires < now) {
      marks.splice(i, 1)
      continue
    }
    if (mark.text === text) {
      marks.splice(i, 1)
      return mark.source
    }
    if (!mark.text.includes(text) && !text.includes(mark.text)) continue
    if (mark.text.startsWith(text)) {
      mark.text = mark.text.slice(text.length)
      return mark.source
    }
    marks.splice(i, 1)
    return mark.source
  }
  return undefined
}

function analyze(text: string, clipboard = "", now = Date.now(), replaced = 0): { counters: Counters; source?: Source } {
  if (!text) return { counters: empty() }
  const length = Math.max(0, text.length - replaced)
  if (length <= 0) return { counters: empty() }
  const source = takeMarked(text, now)
  if (source) return { counters: { ...empty(), ai: length }, source }
  if (clipboard && text === clipboard) return { counters: { ...empty(), pasted: length } }
  if (text === "\n" || text === "\r\n") return { counters: { ...empty(), manual: length } }
  const indent = /^(\r?\n)([ \t]+)$/.exec(text)
  if (indent) {
    const manual = Math.min(indent[1]!.length, length)
    return { counters: { ...empty(), manual, ide: length - manual } }
  }
  if (text.length === 1) return { counters: { ...empty(), manual: length } }
  return { counters: { ...empty(), ide: length } }
}

export function classify(text: string, clipboard = "", now = Date.now(), replaced = 0): Counters {
  return analyze(text, clipboard, now, replaced).counters
}

type Ratio = {
  record(input: {
    file: string
    source: Source
    chars: number
    lines: number
    time?: number
    beforeHash?: string
    afterHash?: string
    patchHash?: string
    chunks?: Chunk[]
  }): Promise<void> | void
}

export class AiCodeFlowMetrics implements vscode.Disposable {
  private counters = empty()
  private timer: NodeJS.Timeout
  private docs = new Map<string, string>()

  constructor(
    private readonly proxy = TelemetryProxy.getInstance(),
    private readonly ratio?: Ratio,
  ) {
    this.timer = setInterval(() => this.flush(), interval)
  }

  static markAi(text: string, source: Source = "inline") {
    if (!text) return
    marks.push({ text, expires: Date.now() + ttl, source })
  }

  register(context: vscode.ExtensionContext) {
    for (const editor of vscode.window.visibleTextEditors ?? []) {
      const doc = editor.document
      if (doc?.uri?.fsPath && typeof doc.getText === "function") this.docs.set(doc.uri.fsPath, doc.getText())
    }
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        void this.process(event)
      }),
      this,
    )
  }

  private async process(event: vscode.TextDocumentChangeEvent) {
    if (event.document.uri.scheme !== "file" && event.document.uri.scheme !== "untitled") return
    const changes = event.contentChanges.filter((change) => change.text)
    if (!changes.length) return
    const clipboard = await Promise.resolve(vscode.env.clipboard.readText()).catch(() => "")
    const file = event.document.uri.fsPath
    const before = file ? this.docs.get(file) : undefined
    const after = typeof event.document.getText === "function" ? event.document.getText() : undefined
    for (const change of changes) {
      const now = Date.now()
      const result = analyze(change.text, clipboard, now, change.rangeLength)
      add(this.counters, result.counters)
      if (result.source && result.counters.ai > 0 && file) {
        void this.ratio?.record({
          file,
          source: result.source,
          chars: result.counters.ai,
          lines: change.text.split(/\r?\n/).length,
          time: now,
          beforeHash: before === undefined ? undefined : hash(before),
          afterHash: after === undefined ? undefined : hash(after),
          patchHash: hash(change.text),
          chunks: this.lines(event.document, change) ?? chunks(change.text),
        })
      }
    }
    if (file && after !== undefined) this.docs.set(file, after)
  }

  private lines(doc: vscode.TextDocument, change: vscode.TextDocumentContentChangeEvent) {
    if (typeof doc.lineAt !== "function") return undefined
    const count = Math.max(1, change.text.split(/\r?\n/).length)
    const parts = change.text.split(/\r?\n/)
    const found: Chunk[] = []
    for (let i = 0; i < count; i++) {
      const line = change.range.start.line + i
      if (line >= doc.lineCount) break
      const text = doc.lineAt(line).text
      found.push({ hash: hash(text), chars: parts[i]?.length ?? text.length })
    }
    return found
  }

  flush() {
    const total = this.counters.ai + this.counters.manual + this.counters.pasted
    if (total <= 0 && this.counters.ide <= 0) return
    this.proxy.capture(TelemetryEventName.AI_CODE_FLOW, {
      ai_chars: this.counters.ai,
      manual_chars: this.counters.manual,
      ide_chars: this.counters.ide,
      pasted_chars: this.counters.pasted,
      total_chars: total,
      repo_name: null,
      source: "vscode_document",
    })
    this.counters = empty()
  }

  dispose() {
    clearInterval(this.timer)
    this.flush()
  }
}
