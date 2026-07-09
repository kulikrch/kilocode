import { Telemetry } from "@kilocode/kilo-telemetry"
import type { Snapshot } from "@/snapshot"

export namespace KiloAiCodeFlow {
  const added = /^\+(?!\+\+)(.*)$/

  export function chars(diff: Pick<Snapshot.FileDiff, "patch">) {
    if (!diff.patch) return 0
    return diff.patch.split(/\r?\n/).reduce((sum, line) => {
      const match = added.exec(line)
      if (!match) return sum
      return sum + match[1]!.length
    }, 0)
  }

  export function total(diffs: readonly Pick<Snapshot.FileDiff, "patch">[]) {
    return diffs.reduce((sum, diff) => sum + chars(diff), 0)
  }

  export function track(input: {
    diffs: readonly Snapshot.FileDiff[]
    sessionID?: string
    messageID?: string
    source: "tool"
    tool: string
  }) {
    const ai = total(input.diffs)
    if (ai <= 0) return
    Telemetry.trackAiCodeFlow({
      aiChars: ai,
      sessionId: input.sessionID,
      messageId: input.messageID,
      files: input.diffs.length,
      additions: input.diffs.reduce((sum, diff) => sum + diff.additions, 0),
      deletions: input.diffs.reduce((sum, diff) => sum + diff.deletions, 0),
      source: input.source,
      tool: input.tool,
    })
  }
}
