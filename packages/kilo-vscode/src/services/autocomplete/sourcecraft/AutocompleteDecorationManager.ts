import * as vscode from "vscode"
import { AUTOCOMPLETE_PREFIX } from "./constants"
import { getSourceCraftAutocompleteSettings } from "./settings"

type DecorationName = "loading" | "notFound" | "emptyLine"

export class AutocompleteDecorationManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = []
  private readonly decorationTypes: Map<DecorationName, vscode.TextEditorDecorationType>
  private readonly activeDecorations = new Set<DecorationName>()
  private activeEditor = vscode.window.activeTextEditor
  private previousLine: number | undefined

  constructor(private readonly context: vscode.ExtensionContext) {
    this.decorationTypes = new Map([
      [
        "loading",
        vscode.window.createTextEditorDecorationType({
          gutterIconPath: context.asAbsolutePath("assets/icons/autocomplete-loading.svg"),
          gutterIconSize: "80%",
        }),
      ],
      [
        "notFound",
        vscode.window.createTextEditorDecorationType({
          gutterIconPath: context.asAbsolutePath("assets/icons/autocomplete-not-found.svg"),
          gutterIconSize: "80%",
        }),
      ],
      [
        "emptyLine",
        vscode.window.createTextEditorDecorationType({
          after: {
            contentText: "Kilo Code: open chat",
            color: new vscode.ThemeColor("descriptionForeground"),
            margin: "0 0 0 2ch",
            textDecoration: "none; opacity: 0.55; font-style: normal;",
          },
        }),
      ],
    ])

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        this.clearAll()
        this.activeEditor = editor
      }),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        const scheme = event.textEditor.document.uri.scheme
        if (scheme !== "file" && scheme !== "untitled") {
          return
        }

        if (this.activeDecorations.has("notFound")) {
          this.updateDecoration("notFound", false)
        }

        const line = event.selections[0]?.active.line
        if (line !== undefined && line !== this.previousLine && this.activeDecorations.has("loading")) {
          this.updateDecoration("loading", false)
        }

        this.previousLine = line
      }),
      vscode.commands.registerCommand(`${AUTOCOMPLETE_PREFIX}.autocomplete.disableStatusIndicator`, async () => {
        this.clearStatusDecorations()
        await context.globalState.update("enableLoadingIndicator", false)
        await context.globalState.update("enableEmptyIndicator", false)
      }),
      vscode.commands.registerCommand(`${AUTOCOMPLETE_PREFIX}.autocomplete.enableStatusIndicator`, async () => {
        await context.globalState.update("enableLoadingIndicator", true)
        await context.globalState.update("enableEmptyIndicator", true)
      }),
    )
  }

  updateDecoration(name: DecorationName, visible: boolean, line?: number): void {
    const settings = getSourceCraftAutocompleteSettings(this.context)
    if (!this.isEnabled(name, settings)) {
      return
    }

    if (visible) {
      this.activeDecorations.add(name)
    } else {
      this.activeDecorations.delete(name)
    }

    if (name !== "emptyLine") {
      void vscode.commands.executeCommand(
        "setContext",
        `${AUTOCOMPLETE_PREFIX}.autocompleteCurrentLines`,
        typeof line === "number" ? [line + 1] : [],
      )
    }

    const editor = this.activeEditor
    const type = this.decorationTypes.get(name)
    if (!editor || !type) {
      return
    }

    if (typeof line === "number" && this.hasBreakpointOnLine(editor, line)) {
      return
    }

    const char = name === "emptyLine" ? Number.MAX_SAFE_INTEGER : 0
    const pos = editor.document.validatePosition(new vscode.Position(line ?? 0, char))
    const range = new vscode.Range(pos, pos)
    editor.setDecorations(type, visible ? [{ range }] : [])
  }

  clearAll(): void {
    for (const name of [...this.activeDecorations]) {
      this.updateDecoration(name, false)
    }
  }

  clearStatusDecorations(): void {
    this.updateDecoration("loading", false)
    this.updateDecoration("notFound", false)
  }

  dispose(): void {
    this.clearAll()
    for (const type of this.decorationTypes.values()) {
      type.dispose()
    }
    for (const disposable of this.disposables) {
      disposable.dispose()
    }
  }

  private isEnabled(name: DecorationName, settings = getSourceCraftAutocompleteSettings(this.context)): boolean {
    switch (name) {
      case "loading":
        return settings.enableLoadingIndicator
      case "notFound":
        return settings.enableEmptyIndicator
      case "emptyLine":
        return settings.enableEmptyLineHint
    }
  }

  private hasBreakpointOnLine(editor: vscode.TextEditor, line: number): boolean {
    const uri = editor.document.uri.toString()
    return vscode.debug.breakpoints.some((breakpoint) => {
      return (
        breakpoint instanceof vscode.SourceBreakpoint &&
        breakpoint.location.uri.toString() === uri &&
        breakpoint.location.range.start.line === line
      )
    })
  }
}

