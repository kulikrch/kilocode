import { createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { ExtensionMessage, WebviewMessage } from "../../types/messages"

type VSCode = {
  postMessage: (message: WebviewMessage) => void
  onMessage: (handler: (message: ExtensionMessage) => void) => () => void
}

type Server = {
  startLogin?: () => void
  goToLogin?: () => void
}

type Lang = {
  t: (key: string) => string
}

export type SpeechState = "idle" | "recording" | "transcribing" | "error"

export type InsertTranscript = (text: string) => void

type StartOptions = {
  model: string
  insert: InsertTranscript
}

type StopOptions = {
  done?: () => void
  ready?: () => boolean
}

export type SpeechToText = {
  state: Accessor<SpeechState>
  error: Accessor<string | undefined>
  active: Accessor<boolean>
  start: (opts: StartOptions) => void
  stop: (opts?: StopOptions) => void
  cancel: () => void
  clear: () => void
}

export function useSpeechToText(vscode: VSCode, server: Server, lang: Lang): SpeechToText {
  const [state, setState] = createSignal<SpeechState>("idle")
  const [error, setError] = createSignal<string | undefined>()
  const active = () => state() === "recording" || state() === "transcribing"
  const prefix = globalThis.crypto?.randomUUID?.() ?? `stt-${Math.random().toString(36).slice(2)}`

  let req = ""
  let count = 0
  let insert: InsertTranscript | undefined
  let done: (() => void) | undefined
  let ready: (() => boolean) | undefined

  const unsub = vscode.onMessage((msg) => {
    if (!isSpeechMessage(msg)) return
    if (msg.requestId !== req) return

    if (msg.type === "speechToTextStarted") {
      setState("recording")
      return
    }

    if (msg.type === "speechToTextCancelled") {
      cleanup()
      setState("idle")
      setError(undefined)
      return
    }

    if (msg.type === "speechToTextError") {
      if (msg.code === "not_authenticated") {
        login()
        return
      }
      fail(msg.error)
      return
    }

    const text = msg.text.trim()
    if (!text) {
      fail(lang.t("speechToText.error.emptyTranscript"))
      return
    }

    const next = ready?.() === false ? undefined : done
    insert?.(text)
    cleanup()
    setState("idle")
    setError(undefined)
    next?.()
  })

  onCleanup(() => {
    unsub()
    cancel()
  })

  function start(opts: StartOptions) {
    if (active()) return
    insert = opts.insert
    setError(undefined)

    count++
    req = `${prefix}-${count}`
    setState("recording")
    vscode.postMessage({
      type: "speechToTextStart",
      requestId: req,
      model: opts.model,
      language: langCode(),
    })
  }

  function stop(opts?: StopOptions) {
    if (state() !== "recording") return
    done = opts?.done
    ready = opts?.ready
    setState("transcribing")
    vscode.postMessage({ type: "speechToTextStop", requestId: req })
  }

  function cancel() {
    if (req && active()) vscode.postMessage({ type: "speechToTextCancel", requestId: req })
    cleanup()
    setState("idle")
    setError(undefined)
  }

  function clear() {
    if (state() !== "error") return
    cleanup()
    setState("idle")
    setError(undefined)
  }

  function login() {
    server.goToLogin?.()
    server.startLogin?.()
    fail(lang.t("speechToText.error.loginRequired"), false)
  }

  function fail(message: string, _toast = true) {
    cleanup()
    setState("error")
    setError(message)
  }

  function cleanup() {
    req = ""
    insert = undefined
    done = undefined
    ready = undefined
  }

  return { state, error, active, start, stop, cancel, clear }
}

function isSpeechMessage(
  msg: ExtensionMessage,
): msg is Extract<
  ExtensionMessage,
  { type: "speechToTextStarted" | "speechToTextCancelled" | "speechToTextResult" | "speechToTextError" }
> {
  return (
    msg.type === "speechToTextStarted" ||
    msg.type === "speechToTextCancelled" ||
    msg.type === "speechToTextResult" ||
    msg.type === "speechToTextError"
  )
}

function langCode() {
  return (navigator.language || "en").split("-")[0] || "en"
}

