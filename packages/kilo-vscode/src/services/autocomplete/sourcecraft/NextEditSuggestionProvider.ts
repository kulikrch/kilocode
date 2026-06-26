import * as vscode from "vscode"
import { AUTOCOMPLETE_PREFIX } from "./constants"
import type { NextEditSuggestion, ReplaceCompletion } from "./types"

type NextEditAction = "accept" | "discard"

export function splitEditLines(text: string): string[] {
  if (text.length === 0) {
    return []
  }

  const lines = text.replace(/\r/g, "").split("\n")
  if (lines.at(-1) === "") {
    lines.pop()
  }

  return lines
}

export function getDocumentEol(doc: vscode.TextDocument): string {
  return doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"
}

export function wholeLineRange(
  doc: vscode.TextDocument,
  startLine: number,
  lineCount: number,
): vscode.Range | undefined {
  if (lineCount <= 0 || startLine >= doc.lineCount) {
    return undefined
  }

  const start = new vscode.Position(Math.max(0, startLine), 0)
  const endLine = Math.min(doc.lineCount, startLine + lineCount)

  if (endLine < doc.lineCount) {
    return new vscode.Range(start, new vscode.Position(endLine, 0))
  }

  return new vscode.Range(start, doc.lineAt(doc.lineCount - 1).rangeIncludingLineBreak.end)
}

export class NextEditSuggestionProvider implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly redDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.removedLineBackground"),
  })
  private readonly greenDecoration = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor("diffEditor.insertedLineBackground"),
  })
  private readonly jumpDecoration = vscode.window.createTextEditorDecorationType({
    after: {
      contentText: "Tab: preview edit",
      border: "1px solid",
      borderColor: new vscode.ThemeColor("editorWidget.border"),
      color: new vscode.ThemeColor("editor.foreground"),
      margin: "0 0 0 2em",
      textDecoration: "none; border-radius: 3px; padding: 1px 6px;",
    },
  })

  private suggestions: NextEditSuggestion[]
  private activeSuggestionIndex = 0
  private isPreparingSave = false

  constructor(
    private readonly editor: vscode.TextEditor,
    private readonly requestId: string,
    items: ReplaceCompletion[],
    private readonly autoShowDiff = false,
  ) {
    this.suggestions = items.map((item) => {
      const red = splitEditLines(item.search)
      const green = splitEditLines(item.replace)

      return {
        status: "hidden",
        block: {
          start: item.startLine,
          numRed: red.length,
          numGreen: green.length,
        },
        data: item,
      }
    })

    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection(async (event) => {
        if (event.textEditor.document.uri.toString() !== this.editor.document.uri.toString()) {
          return
        }

        const active = this.activeSuggestion
        if (!active || active.status !== "ready") {
          return
        }

        const line = event.selections[0]?.active.line
        if (line === undefined) {
          return
        }

        const start = active.block.start
        const end = active.block.start + Math.max(active.block.numRed, 1) - 1
        if (line >= start && line <= end) {
          await this.showDiff(active)
        }
      }),
      vscode.workspace.onWillSaveTextDocument((event) => {
        const active = this.activeSuggestion
        if (!active || active.status !== "visible" || event.document.uri.toString() !== this.editor.document.uri.toString()) {
          return
        }

        const range = wholeLineRange(event.document, active.block.start + active.block.numRed, active.block.numGreen)
        if (!range) {
          return
        }

        this.isPreparingSave = true
        event.waitUntil(Promise.resolve([vscode.TextEdit.delete(range)]))
      }),
      vscode.workspace.onDidSaveTextDocument(async (doc) => {
        const active = this.activeSuggestion
        if (!active || active.status !== "visible" || doc.uri.toString() !== this.editor.document.uri.toString()) {
          return
        }

        try {
          await this.showDiff(active)
        } finally {
          this.isPreparingSave = false
        }
      }),
    )
  }

  get isActiveSuggestionVisibleOrReady(): boolean {
    const status = this.activeSuggestion?.status
    return status === "ready" || status === "visible"
  }

  async showActiveSuggestion(): Promise<boolean> {
    const active = this.activeSuggestion
    if (!active || active.status !== "hidden") {
      return false
    }

    this.updateActiveSuggestionStatus("ready")
    this.renderJumpDecoration(active)

    if (this.autoShowDiff) {
      await this.showDiff(active)
    }

    return true
  }

  async acceptActiveSuggestion(reason?: string): Promise<void> {
    await this.processActiveSuggestion("accept", reason)
  }

  async discardActiveSuggestion(reason?: string): Promise<void> {
    await this.processActiveSuggestion("discard", reason)
  }

  dispose(): void {
    this.clearDecorations()
    this.redDecoration.dispose()
    this.greenDecoration.dispose()
    this.jumpDecoration.dispose()
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
    void vscode.commands.executeCommand("setContext", `${AUTOCOMPLETE_PREFIX}.hasNextEditSuggestion`, false)
  }

  private get activeSuggestion(): NextEditSuggestion | undefined {
    return this.suggestions[this.activeSuggestionIndex]
  }

  private updateActiveSuggestionStatus(status: NextEditSuggestion["status"]): void {
    const active = this.activeSuggestion
    if (!active) {
      return
    }

    this.suggestions[this.activeSuggestionIndex] = { ...active, status }
    void vscode.commands.executeCommand(
      "setContext",
      `${AUTOCOMPLETE_PREFIX}.hasNextEditSuggestion`,
      this.isActiveSuggestionVisibleOrReady,
    )
  }

  private async processActiveSuggestion(action: NextEditAction, _reason?: string): Promise<void> {
    const active = this.activeSuggestion
    if (!active) {
      return
    }

    if (active.status === "ready") {
      if (action === "accept") {
        await this.showDiff(active)
        return
      }

      this.updateActiveSuggestionStatus("rejected")
      this.clearDecorations()
      await vscode.commands.executeCommand("setContext", `${AUTOCOMPLETE_PREFIX}.hasNextEditSuggestion`, false)
      return
    }

    if (active.status !== "visible") {
      return
    }

    if (action === "accept") {
      await this.deleteLinesAt(active.block.start, active.block.numRed)
      this.updateActiveSuggestionStatus("accepted")
      this.activeSuggestionIndex += 1
    } else {
      await this.deleteLinesAt(active.block.start + active.block.numRed, active.block.numGreen)
      this.updateActiveSuggestionStatus("rejected")
    }

    this.clearDecorations()
    await this.showActiveSuggestion()
  }

  private async showDiff(suggestion: NextEditSuggestion): Promise<void> {
    if (this.isPreparingSave) {
      return
    }

    const lines = splitEditLines(suggestion.data.replace)
    if (suggestion.status !== "visible" && lines.length > 0) {
      const line = suggestion.block.start + suggestion.block.numRed
      const pos =
        line >= this.editor.document.lineCount
          ? this.editor.document.lineAt(this.editor.document.lineCount - 1).rangeIncludingLineBreak.end
          : new vscode.Position(line, 0)
      const text = lines.join(getDocumentEol(this.editor.document)) + getDocumentEol(this.editor.document)

      await this.editor.edit((edit) => edit.insert(pos, text), {
        undoStopBefore: false,
        undoStopAfter: false,
      })
    }

    this.updateActiveSuggestionStatus("visible")
    this.renderDiffDecorations(suggestion)
  }

  private async deleteLinesAt(startLine: number, lineCount: number): Promise<void> {
    const range = wholeLineRange(this.editor.document, startLine, lineCount)
    if (!range) {
      return
    }

    const active = vscode.window.activeTextEditor?.document.uri.toString() === this.editor.document.uri.toString()
    if (active) {
      await this.editor.edit((edit) => edit.delete(range), {
        undoStopBefore: false,
        undoStopAfter: false,
      })
      return
    }

    const edit = new vscode.WorkspaceEdit()
    edit.delete(this.editor.document.uri, range)
    await vscode.workspace.applyEdit(edit)
  }

  private renderJumpDecoration(suggestion: NextEditSuggestion): void {
    const line = Math.min(suggestion.block.start, this.editor.document.lineCount - 1)
    const pos = this.editor.document.lineAt(line).range.end
    this.editor.setDecorations(this.jumpDecoration, [{ range: new vscode.Range(pos, pos) }])
  }

  private renderDiffDecorations(suggestion: NextEditSuggestion): void {
    const red = wholeLineRange(this.editor.document, suggestion.block.start, suggestion.block.numRed)
    const green = wholeLineRange(this.editor.document, suggestion.block.start + suggestion.block.numRed, suggestion.block.numGreen)

    this.editor.setDecorations(this.redDecoration, red ? [{ range: red }] : [])
    this.editor.setDecorations(this.greenDecoration, green ? [{ range: green }] : [])
    this.editor.setDecorations(this.jumpDecoration, [])
  }

  private clearDecorations(): void {
    this.editor.setDecorations(this.redDecoration, [])
    this.editor.setDecorations(this.greenDecoration, [])
    this.editor.setDecorations(this.jumpDecoration, [])
  }
}

