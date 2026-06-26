import * as vscode from "vscode"
import type { ReplaceCompletion } from "./types"

export type NextEditSuggestionRequest = {
  document: vscode.TextDocument
  position: vscode.Position
  prefix: string
  suffix: string
  languageId: string
}

export type NextEditSuggestionAdapter = {
  getNextEdits(req: NextEditSuggestionRequest, token: vscode.CancellationToken): Promise<ReplaceCompletion[]>
}

export const noopNextEditSuggestionAdapter: NextEditSuggestionAdapter = {
  async getNextEdits() {
    return []
  },
}

