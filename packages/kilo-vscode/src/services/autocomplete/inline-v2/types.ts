export type ReplaceCompletion = {
  id: string
  startLine: number
  search: string
  replace: string
}

export type InlineV2AutocompleteSettings = {
  enableNextEditSuggestion: boolean
  enableEmptyIndicator: boolean
  enableLoadingIndicator: boolean
  enableEmptyLineHint: boolean
  delayedRequestTimeoutMs: number
}

export type NextEditStatus = "hidden" | "ready" | "visible" | "accepted" | "rejected"

export type NextEditSuggestion = {
  status: NextEditStatus
  block: {
    start: number
    numRed: number
    numGreen: number
  }
  data: ReplaceCompletion
}
