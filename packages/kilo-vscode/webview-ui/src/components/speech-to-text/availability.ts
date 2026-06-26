import { getSpeechToTextModel } from "../../../../src/speech-to-text/models"

type Settings = Record<string, unknown>

export function canUseSpeechToText(
  _settings: Settings,
  _config: unknown,
  _connected: unknown,
  _profile: unknown,
): boolean {
  return false
}

export function selectedSpeechToTextModel(settings: Settings): string {
  const id = settings["speechToText.model"]
  return getSpeechToTextModel(typeof id === "string" ? id : undefined).id
}

