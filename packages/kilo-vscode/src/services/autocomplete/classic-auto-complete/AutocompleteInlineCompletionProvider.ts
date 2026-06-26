import * as vscode from "vscode"
import {
  extractPrefixSuffix,
  AutocompleteSuggestionContext,
  contextToAutocompleteInput,
  AutocompleteContextProvider,
  FillInAtCursorSuggestion,
  AutocompletePrompt,
  MatchingSuggestionResult,
  CostTrackingCallback,
  LLMRetrievalResult,
  PendingRequest,
  AutocompleteContext,
  LastSuggestionInfo,
} from "../types"
import {
  findMatchingSuggestion as _findMatchingSuggestion,
  applyFirstLineOnly as _applyFirstLineOnly,
  countLines as _countLines,
  shouldShowOnlyFirstLine as _shouldShowOnlyFirstLine,
  getFirstLine as _getFirstLine,
  calcDebounceDelay,
  MatchingSuggestionWithFillIn as _MatchingSuggestionWithFillIn,
} from "./inline-utils"
import { FimPromptBuilder } from "./FillInTheMiddle"
import { AutocompleteModel } from "../AutocompleteModel"
import { ContextRetrievalService } from "../continuedev/core/autocomplete/context/ContextRetrievalService"
import { VsCodeIde } from "../continuedev/core/vscode-test-harness/src/VSCodeIde"
import { RecentlyVisitedRangesService } from "../continuedev/core/vscode-test-harness/src/autocomplete/RecentlyVisitedRangesService"
import { RecentlyEditedTracker } from "../continuedev/core/vscode-test-harness/src/autocomplete/recentlyEdited"
import type { AutocompleteServiceSettings } from "../AutocompleteServiceManager"
import { postprocessAutocompleteSuggestion } from "./uselessSuggestionFilter"
import { shouldSkipAutocomplete } from "./contextualSkip"
import { FileIgnoreController } from "../shims/FileIgnoreController"
import { AutocompleteTelemetry } from "./AutocompleteTelemetry"
import { ErrorBackoff } from "./ErrorBackoff"
import { AutocompleteDecorationManager, NextEditSuggestionProvider, noopNextEditSuggestionAdapter } from "../inline-v2"
import type { NextEditSuggestionAdapter } from "../inline-v2"

const MAX_SUGGESTIONS_HISTORY = 20

/**
 * Minimum debounce delay in milliseconds.
 * The adaptive debounce delay will never go below this value, even when
 * average latencies are very fast.
 */
const MIN_DEBOUNCE_DELAY_MS = 150

/**
 * Initial debounce delay in milliseconds.
 * This value is used as the starting debounce delay before enough latency samples
 * are collected. Once LATENCY_SAMPLE_SIZE samples are collected, the debounce delay
 * is dynamically adjusted to the average of recent request latencies.
 */
const INITIAL_DEBOUNCE_DELAY_MS = 300

/**
 * Maximum debounce delay in milliseconds.
 * This caps the adaptive debounce delay to prevent excessive waiting times
 * even when latencies are high.
 */
const MAX_DEBOUNCE_DELAY_MS = 1000

/**
 * Number of latency samples to collect before using adaptive debounce delay.
 * Once this many samples are collected, the debounce delay becomes the average
 * of the stored latencies, updated after each request.
 */
const LATENCY_SAMPLE_SIZE = 10

export type { CostTrackingCallback, AutocompletePrompt, MatchingSuggestionResult, LLMRetrievalResult }

export type MatchingSuggestionWithFillIn = _MatchingSuggestionWithFillIn

export function findMatchingSuggestion(
  prefix: string,
  suffix: string,
  suggestionsHistory: FillInAtCursorSuggestion[],
): MatchingSuggestionWithFillIn | null {
  return _findMatchingSuggestion(prefix, suffix, suggestionsHistory)
}

export function applyFirstLineOnly(
  result: MatchingSuggestionWithFillIn | null,
  prefix: string,
): MatchingSuggestionWithFillIn | null {
  return _applyFirstLineOnly(result, prefix)
}

/**
 * Command ID for tracking inline completion acceptance.
 * This command is executed after the user accepts an inline completion.
 */
export const INLINE_COMPLETION_ACCEPTED_COMMAND = "kilocode.autocomplete.inline-completion.accepted"

export function countLines(text: string): number {
  return _countLines(text)
}

export function shouldShowOnlyFirstLine(prefix: string, suggestion: string): boolean {
  return _shouldShowOnlyFirstLine(prefix, suggestion)
}

export function getFirstLine(text: string): string {
  return _getFirstLine(text)
}

export function stringToInlineCompletions(text: string, position: vscode.Position): vscode.InlineCompletionItem[] {
  if (text === "") {
    return []
  }

  const item = new vscode.InlineCompletionItem(text, new vscode.Range(position, position), {
    command: INLINE_COMPLETION_ACCEPTED_COMMAND,
    title: "Autocomplete Accepted",
  })
  return [item]
}

export class AutocompleteInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  public suggestionsHistory: FillInAtCursorSuggestion[] = []
  /** Tracks all pending/in-flight requests */
  private pendingRequests: PendingRequest[] = []
  private fimPromptBuilder: FimPromptBuilder
  private contextProvider: AutocompleteContextProvider
  private model: AutocompleteModel
  private costTrackingCallback: CostTrackingCallback
  private getSettings: () => AutocompleteServiceSettings | null
  private recentlyVisitedRangesService: RecentlyVisitedRangesService
  private recentlyEditedTracker: RecentlyEditedTracker
  private debounceTimer: NodeJS.Timeout | null = null
  /** The pending request associated with the current debounce timer (if any) */
  private debouncedPendingRequest: PendingRequest | null = null
  private isFirstCall: boolean = true
  private workspacePath = ""
  private ignoreController: Promise<FileIgnoreController>
  /** Abort controller for the current in-flight FIM request */
  private fimAbortController: AbortController | null = null
  private acceptedCommand: vscode.Disposable | null = null
  private contextService: ContextRetrievalService | null = null
  private debounceDelayMs: number = INITIAL_DEBOUNCE_DELAY_MS
  private latencyHistory: number[] = []
  private telemetry: AutocompleteTelemetry | null
  /** Information about the last suggestion shown to the user */
  private lastSuggestion: LastSuggestionInfo | null = null
  private decorationManager: AutocompleteDecorationManager
  private uiDisposables: vscode.Disposable[] = []
  private activeNextEditProvider: NextEditSuggestionProvider | null = null
  private nextEditSuggestionAdapter: NextEditSuggestionAdapter = noopNextEditSuggestionAdapter
  private lastEditorState:
    | {
        document: vscode.TextDocument
        version: number
        selection: vscode.Selection
      }
    | null = null
  /** Circuit breaker / exponential backoff for API errors */
  public readonly backoff = new ErrorBackoff()
  /** Optional callback fired once when a fatal (non-retriable) error is first detected */
  private onFatalError: ((status: number | null) => void) | null = null
  /** Whether the fatal error notification has already been fired (avoid repeating) */
  private fatalNotified = false

  constructor(
    context: vscode.ExtensionContext,
    model: AutocompleteModel,
    costTrackingCallback: CostTrackingCallback,
    getSettings: () => AutocompleteServiceSettings | null,
    workspacePath: string,
    telemetry: AutocompleteTelemetry | null = null,
    onFatalError?: (status: number | null) => void,
  ) {
    this.telemetry = telemetry
    this.model = model
    this.costTrackingCallback = costTrackingCallback
    this.getSettings = getSettings
    this.onFatalError = onFatalError ?? null
    this.workspacePath = workspacePath
    this.ignoreController = this.createIgnore(workspacePath)

    const ide = new VsCodeIde(context)
    this.contextService = new ContextRetrievalService(ide)
    this.contextProvider = {
      ide,
      contextService: this.contextService,
      model,
      ignoreController: this.ignoreController,
    }
    this.fimPromptBuilder = new FimPromptBuilder(this.contextProvider)

    this.recentlyVisitedRangesService = new RecentlyVisitedRangesService(ide)
    this.recentlyEditedTracker = new RecentlyEditedTracker(ide)
    this.decorationManager = new AutocompleteDecorationManager(context)

    this.acceptedCommand = vscode.commands.registerCommand(INLINE_COMPLETION_ACCEPTED_COMMAND, () => {
      this.telemetry?.captureAcceptSuggestion(this.lastSuggestion?.length)
      vscode.commands.executeCommand("setContext", "kilo-code.new.autocomplete.hasSuggestions", false)
    })

    this.uiDisposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        this.updateEmptyLineDecoration(event.textEditor)
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const editor = vscode.window.activeTextEditor
        if (editor?.document === event.document) {
          this.updateEmptyLineDecoration(editor)
        }
      }),
      vscode.commands.registerCommand("kilo-code.new.autocomplete.acceptNextEditSuggestion", async (args) => {
        await this.activeNextEditProvider?.acceptActiveSuggestion(args?.reason)
      }),
      vscode.commands.registerCommand("kilo-code.new.autocomplete.discardNextEditSuggestion", async (args) => {
        await this.activeNextEditProvider?.discardActiveSuggestion(args?.reason)
      }),
    )
  }

  private async createIgnore(dir: string): Promise<FileIgnoreController> {
    const controller = new FileIgnoreController(dir)
    await controller.initialize()
    return controller
  }

  public updateWorkspacePath(dir: string): void {
    if (dir === this.workspacePath) {
      return
    }

    this.clearWorkspaceState()
    this.workspacePath = dir
    this.ignoreController = this.createIgnore(dir)
    this.contextProvider.ignoreController = this.ignoreController
  }

  private clearWorkspaceState(): void {
    this.suggestionsHistory = []
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.settleDebouncedPendingRequest()
    this.pendingRequests.length = 0
    this.fimAbortController?.abort()
    this.fimAbortController = null
    this.isFirstCall = true
    this.lastSuggestion = null
    this.activeNextEditProvider?.dispose()
    this.activeNextEditProvider = null
    this.decorationManager.clearAll()
    this.telemetry?.cancelVisibilityTracking()
    void vscode.commands.executeCommand("setContext", "kilo-code.new.autocomplete.hasSuggestions", false)
  }

  public updateSuggestions(fillInAtCursor: FillInAtCursorSuggestion): void {
    const isDuplicate = this.suggestionsHistory.some(
      (existing) =>
        existing.text === fillInAtCursor.text &&
        existing.prefix === fillInAtCursor.prefix &&
        existing.suffix === fillInAtCursor.suffix,
    )

    if (isDuplicate) {
      return
    }

    // Add to the end of the array (most recent)
    this.suggestionsHistory.push(fillInAtCursor)

    // Remove oldest if we exceed the limit
    if (this.suggestionsHistory.length > MAX_SUGGESTIONS_HISTORY) {
      this.suggestionsHistory.shift()
    }
  }

  public async getPrompt(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): Promise<{ prompt: AutocompletePrompt; prefix: string; suffix: string }> {
    // Build complete context with all tracking data
    const recentlyVisitedRanges = this.recentlyVisitedRangesService.getSnippets()
    const recentlyEditedRanges = await this.recentlyEditedTracker.getRecentlyEditedRanges()

    const context: AutocompleteSuggestionContext = {
      document,
      range: new vscode.Range(position, position),
      recentlyVisitedRanges,
      recentlyEditedRanges,
    }

    const autocompleteInput = contextToAutocompleteInput(context)

    const { prefix, suffix } = extractPrefixSuffix(document, position)
    const languageId = document.languageId

    const prompt = await this.fimPromptBuilder.getFimPrompts(
      autocompleteInput,
      this.model.getModelName() ?? "codestral",
    )

    return { prompt, prefix, suffix }
  }

  private processSuggestion(
    suggestionText: string,
    prefix: string,
    suffix: string,
    model: AutocompleteModel,
    telemetryContext: AutocompleteContext,
    languageId?: string,
  ): FillInAtCursorSuggestion {
    if (!suggestionText) {
      this.telemetry?.captureSuggestionFiltered("empty_response", telemetryContext)
      return { text: "", prefix, suffix }
    }

    const processedText = postprocessAutocompleteSuggestion({
      suggestion: suggestionText,
      prefix,
      suffix,
      model: model.getModelName() || "",
      languageId,
    })

    if (processedText) {
      return { text: processedText, prefix, suffix }
    }

    this.telemetry?.captureSuggestionFiltered("filtered_by_postprocessing", telemetryContext)
    return { text: "", prefix, suffix }
  }

  private async disposeIgnoreController(): Promise<void> {
    const ignoreController = await this.ignoreController.catch(() => null)
    ignoreController?.dispose()
  }

  /**
   * Records a latency measurement and updates the adaptive debounce delay.
   * Maintains a rolling window of the last LATENCY_SAMPLE_SIZE latencies.
   * Once enough samples are collected, the debounce delay is set to the
   * average of all stored latencies, clamped between MIN_DEBOUNCE_DELAY_MS
   * and MAX_DEBOUNCE_DELAY_MS.
   *
   * @param latencyMs - The latency of the most recent request in milliseconds
   */
  public recordLatency(latencyMs: number): void {
    this.latencyHistory.push(latencyMs)
    if (this.latencyHistory.length > LATENCY_SAMPLE_SIZE) {
      this.latencyHistory.shift()
      this.debounceDelayMs = calcDebounceDelay(this.latencyHistory)
    }
  }

  /**
   * Reset error backoff and allow fatal notifications to fire again.
   * Call this when auth state changes (login, reconnect, org switch).
   */
  public resetBackoff(): void {
    this.backoff.reset()
    this.fatalNotified = false
  }

  public setNextEditSuggestionAdapter(adapter: NextEditSuggestionAdapter | null): void {
    this.nextEditSuggestionAdapter = adapter ?? noopNextEditSuggestionAdapter
  }

  public dispose(): void {
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    this.settleDebouncedPendingRequest()
    this.pendingRequests.length = 0
    this.fimAbortController?.abort()
    this.fimAbortController = null
    this.telemetry?.dispose()
    this.contextService?.dispose()
    this.contextService = null
    this.activeNextEditProvider?.dispose()
    this.activeNextEditProvider = null
    this.decorationManager.dispose()
    for (const disposable of this.uiDisposables) {
      disposable.dispose()
    }
    this.uiDisposables = []
    this.recentlyVisitedRangesService.dispose()
    this.recentlyEditedTracker.dispose()
    void this.disposeIgnoreController()
    if (this.acceptedCommand) {
      this.acceptedCommand.dispose()
      this.acceptedCommand = null
    }
  }

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
    const settings = this.getSettings()
    const isAutoTriggerEnabled = settings?.enableAutoTrigger ?? false

    if (!isAutoTriggerEnabled) {
      return []
    }

    return this.provideInlineCompletionItems_Internal(document, position, _context, _token)
  }

  public async provideInlineCompletionItems_Internal(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    _token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList> {
    vscode.commands.executeCommand("setContext", "kilo-code.new.autocomplete.hasSuggestions", false)

    if (this.activeNextEditProvider?.isActiveSuggestionVisibleOrReady) {
      return []
    }

    // Build telemetry context
    const telemetryContext: AutocompleteContext = {
      languageId: document.languageId,
      modelId: this.model?.getModelName(),
      provider: this.model?.getProviderDisplayName(),
    }

    this.telemetry?.captureSuggestionRequested(telemetryContext)

    if (!this.model || !this.model.hasValidCredentials()) {
      // bail if no model is available or no valid API credentials configured
      // this prevents errors when autocomplete is enabled but no provider is set up
      return []
    }

    // Circuit breaker / backoff: skip requests when the API is returning errors.
    // This prevents flooding the API with thousands of failed requests when
    // credits are depleted (402), auth is invalid (401/403), or the server
    // is rate-limiting (429) / having issues (5xx).
    if (await this.isBackoffBlocked()) {
      return []
    }

    try {
      if (!(await this.isDocumentAccessible(document))) {
        return []
      }

      const { prefix, suffix } = extractPrefixSuffix(document, position)

      // Check cache first - allow mid-word lookups from cache
      const matchingResult = applyFirstLineOnly(findMatchingSuggestion(prefix, suffix, this.suggestionsHistory), prefix)

      if (matchingResult !== null) {
        this.lastSuggestion = {
          ...telemetryContext,
          length: matchingResult.text.length,
        }
        this.telemetry?.captureCacheHit(matchingResult.matchType, telemetryContext, matchingResult.text.length)
        this.telemetry?.startVisibilityTracking(matchingResult.fillInAtCursor, "cache", telemetryContext)
        this.decorationManager.updateDecoration("emptyLine", false, position.line)
        this.decorationManager.updateDecoration("notFound", false, position.line)
        vscode.commands.executeCommand("setContext", "kilo-code.new.autocomplete.hasSuggestions", true)
        return stringToInlineCompletions(matchingResult.text, position)
      }

      this.telemetry?.cancelVisibilityTracking() // No suggestion to show - cancel any pending visibility tracking

      // Only skip new LLM requests during mid-word typing or at end of statement
      // Cache lookups above are still allowed
      if (shouldSkipAutocomplete(prefix, suffix, document.languageId)) {
        return []
      }

      const { prompt, prefix: promptPrefix, suffix: promptSuffix } = await this.getPrompt(document, position)

      await this.debouncedFetchAndCacheSuggestion(prompt, promptPrefix, promptSuffix, document.languageId)

      const cachedResult = applyFirstLineOnly(findMatchingSuggestion(prefix, suffix, this.suggestionsHistory), prefix)
      if (cachedResult) {
        this.lastSuggestion = {
          ...telemetryContext,
          length: cachedResult.text.length,
        }
        this.telemetry?.captureLlmSuggestionReturned(telemetryContext, cachedResult.text.length)
        this.telemetry?.startVisibilityTracking(cachedResult.fillInAtCursor, "llm", telemetryContext)
        this.decorationManager.updateDecoration("emptyLine", false, position.line)
        this.decorationManager.updateDecoration("notFound", false, position.line)
        vscode.commands.executeCommand("setContext", "kilo-code.new.autocomplete.hasSuggestions", true)
      } else {
        this.telemetry?.cancelVisibilityTracking() // No suggestion to show - cancel any pending visibility tracking
        const shown = await this.showNextEditSuggestion(document, position, prefix, suffix, _token)
        if (!shown) {
          this.updateNoHintDecoration(document, position)
        }
      }

      return stringToInlineCompletions(cachedResult?.text ?? "", position)
    } catch {
      // only big catch at the top of the call-chain, if anything goes wrong at a lower level
      // do not catch, just let the error cascade
      return []
    }
  }

  private async isBackoffBlocked(): Promise<boolean> {
    if (!this.backoff.blocked()) {
      return false
    }

    // For 402 (credits depleted), periodically check the balance endpoint
    // instead of sending a probe FIM request. If the user has added credits,
    // reset the backoff so autocomplete resumes.
    if (this.backoff.getFatalStatus() === 402 && this.backoff.shouldProbe()) {
      const funded = await this.model.hasBalance()
      if (funded) {
        this.backoff.reset()
        this.fatalNotified = false
      }
    }

    return this.backoff.blocked()
  }

  private async isDocumentAccessible(document: vscode.TextDocument): Promise<boolean> {
    if (!document?.uri?.fsPath) {
      return false
    }

    // Check if file is ignored (for manual trigger via codeSuggestion)
    // Skip ignore check for untitled documents
    if (document.isUntitled) {
      return true
    }

    try {
      const controller = await Promise.race([
        this.ignoreController,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 50)),
      ])

      if (!controller) {
        return false
      }

      return controller.validateAccess(document.fileName)
    } catch {
      return false
    }
  }

  private updateEmptyLineDecoration(editor: vscode.TextEditor): void {
    if (!editor.selection.isEmpty) {
      this.decorationManager.updateDecoration("emptyLine", false)
      return
    }

    if (
      this.lastEditorState?.document === editor.document &&
      this.lastEditorState.version === editor.document.version &&
      this.lastEditorState.selection.isEqual(editor.selection)
    ) {
      return
    }

    const position = editor.selection.active
    const line = editor.document.lineAt(position.line).text
    const { prefix, suffix } = extractPrefixSuffix(editor.document, position)
    const hasCached = findMatchingSuggestion(prefix, suffix, this.suggestionsHistory) !== null
    this.decorationManager.updateDecoration("emptyLine", line.trim().length === 0 && !hasCached, position.line)
    this.lastEditorState = {
      document: editor.document,
      version: editor.document.version,
      selection: editor.selection,
    }
  }

  private updateNoHintDecoration(document: vscode.TextDocument, position: vscode.Position): void {
    const editor = vscode.window.activeTextEditor
    if (editor?.document !== document || !editor.selection.active.isEqual(position)) {
      return
    }

    this.decorationManager.updateDecoration("notFound", true, position.line)
  }

  private async showNextEditSuggestion(
    document: vscode.TextDocument,
    position: vscode.Position,
    prefix: string,
    suffix: string,
    token: vscode.CancellationToken,
  ): Promise<boolean> {
    const settings = this.getSettings()
    if (!settings?.enableNextEditSuggestion) {
      return false
    }

    const editor = vscode.window.activeTextEditor
    if (!editor || editor.document !== document) {
      return false
    }

    const items = await this.nextEditSuggestionAdapter.getNextEdits(
      {
        document,
        position,
        prefix,
        suffix,
        languageId: document.languageId,
      },
      token,
    )

    if (items.length === 0 || token.isCancellationRequested) {
      return false
    }

    this.activeNextEditProvider?.dispose()
    this.activeNextEditProvider = new NextEditSuggestionProvider(editor, crypto.randomUUID(), items)
    return this.activeNextEditProvider.showActiveSuggestion()
  }

  /**
   * Find a pending request that covers the current prefix/suffix.
   * A request covers the current position if:
   * 1. The suffix matches (user hasn't changed text after cursor)
   * 2. The current prefix either equals or extends the pending prefix
   *    (user is typing forward, not backspacing or editing earlier)
   *
   * @returns The covering pending request, or null if none found
   */
  private findCoveringPendingRequest(prefix: string, suffix: string): PendingRequest | null {
    for (const pendingRequest of this.pendingRequests) {
      // Suffix must match exactly (text after cursor unchanged)
      if (suffix !== pendingRequest.suffix) {
        continue
      }

      // Current prefix must start with the pending prefix (user typed more)
      // or be exactly equal (same position)
      if (prefix.startsWith(pendingRequest.prefix)) {
        return pendingRequest
      }
    }
    return null
  }

  /**
   * Remove a pending request from the list when it completes.
   */
  private removePendingRequest(request: PendingRequest): void {
    const index = this.pendingRequests.indexOf(request)
    if (index !== -1) {
      this.pendingRequests.splice(index, 1)
    }
  }

  private settleDebouncedPendingRequest(): void {
    const pending = this.debouncedPendingRequest
    if (!pending) return

    this.removePendingRequest(pending)
    pending.resolve?.()
    this.debouncedPendingRequest = null
  }

  /**
   * Debounced fetch with leading edge execution and pending request reuse.
   * - First call executes immediately (leading edge)
   * - Subsequent calls reset the timer and wait for DEBOUNCE_DELAY_MS of inactivity (trailing edge)
   * - If a pending request covers the current prefix/suffix, reuse it instead of starting a new one
   */
  private debouncedFetchAndCacheSuggestion(
    prompt: AutocompletePrompt,
    prefix: string,
    suffix: string,
    languageId: string,
  ): Promise<void> {
    // Check if any existing pending request covers this one
    const coveringRequest = this.findCoveringPendingRequest(prefix, suffix)
    if (coveringRequest) {
      // Wait for the existing request to complete - no need to start a new one
      return coveringRequest.promise
    }

    // If this is the first call (no pending debounce), execute immediately
    // but still track it as a pending request so subsequent calls can reuse it
    if (this.isFirstCall && this.debounceTimer === null) {
      this.isFirstCall = false
      const promise = this.fetchAndCacheSuggestion(prompt, prefix, suffix, languageId)
      const leading: PendingRequest = { prefix, suffix, promise }
      promise.finally(() => this.removePendingRequest(leading))
      this.pendingRequests.push(leading)
      return promise
    }

    // Clear any existing timer and remove the stale pending request it belongs to.
    // The cancelled timer's callback will never fire, so the pending entry would
    // otherwise linger with a never-resolving promise.
    if (this.debounceTimer !== null) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
      this.settleDebouncedPendingRequest()
    }

    // Create the pending request object first so we can reference it in the cleanup
    const pendingRequest: PendingRequest = {
      prefix,
      suffix,
      promise: null!, // Will be set immediately below
    }

    const requestPromise = new Promise<void>((resolve) => {
      pendingRequest.resolve = resolve
      this.debounceTimer = setTimeout(async () => {
        this.debounceTimer = null
        this.debouncedPendingRequest = null
        this.isFirstCall = true // Reset for next sequence
        try {
          await this.fetchAndCacheSuggestion(prompt, prefix, suffix, languageId)
        } finally {
          this.removePendingRequest(pendingRequest)
          resolve()
        }
      }, this.getRequestDelayMs())
    })

    // Complete the pending request object
    pendingRequest.promise = requestPromise

    // Track so we can remove it if the timer is cleared by a subsequent call
    this.debouncedPendingRequest = pendingRequest

    // Add to the list of pending requests
    this.pendingRequests.push(pendingRequest)

    return requestPromise
  }

  public async fetchAndCacheSuggestion(
    prompt: AutocompletePrompt,
    prefix: string,
    suffix: string,
    languageId: string,
  ): Promise<void> {
    // Abort any previous in-flight FIM request before starting a new one
    this.fimAbortController?.abort()
    const controller = new AbortController()
    this.fimAbortController = controller

    const startTime = performance.now()
    const editor = vscode.window.activeTextEditor
    const position =
      prompt.autocompleteInput.pos &&
      new vscode.Position(prompt.autocompleteInput.pos.line, prompt.autocompleteInput.pos.character)

    // Build telemetry context for this request
    const telemetryContext: AutocompleteContext = {
      languageId,
      modelId: this.model?.getModelName(),
      provider: this.model?.getProviderDisplayName(),
    }

    // Defense-in-depth: credentials may become invalid between the provider gate and the actual
    // debounced execution (e.g., profile reload calling AutocompleteModel.cleanup()).
    // In that case, do not attempt an LLM call at all.
    if (!this.model || !this.model.hasValidCredentials()) {
      return
    }

    try {
      if (position && editor?.document.uri.fsPath === prompt.autocompleteInput.filepath) {
        this.decorationManager.updateDecoration("loading", true, position.line)
      }

      // Curry processSuggestion with prefix, suffix, model, telemetry context, and languageId
      const curriedProcessSuggestion = (text: string) =>
        this.processSuggestion(text, prefix, suffix, this.model, telemetryContext, languageId)

      const result = await this.fimPromptBuilder.getFromFIM(
        this.model,
        prompt,
        curriedProcessSuggestion,
        controller.signal,
      )

      const latencyMs = performance.now() - startTime

      this.telemetry?.captureLlmRequestCompleted(
        {
          latencyMs,
          cost: result.cost,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
        },
        telemetryContext,
      )

      // Record latency for adaptive debounce delay
      this.recordLatency(latencyMs)

      this.costTrackingCallback(result.cost, result.inputTokens, result.outputTokens)

      // Successful response — reset any backoff / circuit breaker state
      this.backoff.success()
      this.fatalNotified = false

      // Always update suggestions, even if text is empty (for caching)
      this.updateSuggestions(result.suggestion)
    } catch (error) {
      // Aborted requests are expected (user typed again) — don't report as failures
      if (controller.signal.aborted) return

      const latencyMs = performance.now() - startTime
      this.telemetry?.captureLlmRequestFailed(
        {
          latencyMs,
          error: error instanceof Error ? error.message : String(error),
        },
        telemetryContext,
      )

      // Update circuit breaker / backoff state based on the error kind
      const kind = this.backoff.failure(error)

      // Notify once when a fatal error (402/401/403) is first detected
      if (kind === "fatal" && !this.fatalNotified) {
        this.fatalNotified = true
        this.onFatalError?.(this.backoff.getFatalStatus())
      }
    } finally {
      if (position && editor?.document.uri.fsPath === prompt.autocompleteInput.filepath) {
        this.decorationManager.updateDecoration("loading", false, position.line)
      }
    }
  }

  private getRequestDelayMs(): number {
    const configured = this.getSettings()?.delayedRequestTimeoutMs
    if (typeof configured === "number") {
      return Math.max(configured, 200)
    }

    return this.debounceDelayMs
  }
}
