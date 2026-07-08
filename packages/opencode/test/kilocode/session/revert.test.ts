import { describe, expect } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../../src/effect/cross-spawn-spawner"
import { ModelID, ProviderID } from "../../../src/provider/schema"
import { MessageV2 } from "../../../src/session/message-v2"
import { SessionRevert } from "../../../src/session/revert"
import { MessageID, PartID } from "../../../src/session/schema"
import * as Session from "../../../src/session/session"
import { Snapshot } from "../../../src/snapshot"
import { provideTmpdirInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

const env = Layer.mergeAll(
  Session.defaultLayer,
  SessionRevert.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)
const it = testEffect(env)

describe("partial assistant revert", () => {
  it.live(
    "clears provider errors when the revert becomes permanent",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const session = yield* sessions.create({})
          const providerID = ProviderID.make("test")
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "default",
            model: { providerID, modelID: ModelID.make("test") },
            time: { created: Date.now() },
          })
          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 1,
            tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelID.make("test"),
            providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "error",
            error: MessageV2.fromError(new Error("Provider returned error"), { providerID }),
          })
          const kept = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "text",
            text: "keep",
          })
          const boundary = yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "text",
            text: "remove",
          })

          yield* sessions.setRevert({
            sessionID: session.id,
            revert: { messageID: assistant.id, partID: boundary.id },
            summary: { additions: 0, deletions: 0, files: 0 },
          })
          yield* revert.cleanup(yield* sessions.get(session.id))

          const messages = yield* sessions.messages({ sessionID: session.id })
          const result = messages.find((message) => message.info.id === assistant.id)
          expect(result?.parts.map((p) => p.id)).toEqual([kept.id])
          expect(result?.info).not.toHaveProperty("error")
        }),
      { git: true },
    ),
  )
})

describe("session revert integration", () => {
  it.live(
    "restores files on revert and restores the latest workspace on unrevert",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const revert = yield* SessionRevert.Service
          const snapshot = yield* Snapshot.Service
          const file = path.join(dir, "app.txt")
          yield* Effect.promise(() => Bun.write(file, "base\n"))

          const session = yield* sessions.create({})
          const providerID = ProviderID.make("test")
          const user = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "user",
            agent: "default",
            model: { providerID, modelID: ModelID.make("test") },
            time: { created: Date.now() },
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: user.id,
            sessionID: session.id,
            type: "text",
            text: "Update app.txt",
          } satisfies MessageV2.TextPart)
          const before = yield* snapshot.track()
          expect(before).toBeDefined()

          yield* Effect.promise(() => Bun.write(file, "changed by agent\n"))
          const after = yield* snapshot.track()
          expect(after).toBeDefined()
          const patch = yield* snapshot.patch(before!)
          expect(patch.files).toEqual([file.replaceAll("\\", "/")])

          const assistant = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            sessionID: session.id,
            role: "assistant",
            parentID: user.id,
            mode: "default",
            agent: "default",
            path: { cwd: dir, root: dir },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            modelID: ModelID.make("test"),
            providerID,
            time: { created: Date.now(), completed: Date.now() },
            finish: "stop",
          })
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "step-start",
            snapshot: before!,
          } satisfies MessageV2.StepStartPart)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "text",
            text: "I updated app.txt",
          } satisfies MessageV2.TextPart)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          } satisfies MessageV2.PatchPart)
          yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: session.id,
            type: "step-finish",
            reason: "stop",
            snapshot: after!,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          } satisfies MessageV2.StepFinishPart)

          const reverted = yield* revert.revert({ sessionID: session.id, messageID: user.id })
          expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("base\n")
          expect(reverted.revert?.messageID).toBe(user.id)
          expect(reverted.revert?.snapshot).toBeDefined()
          expect(reverted.summary?.files).toBe(1)

          const redone = yield* revert.unrevert({ sessionID: session.id })
          expect(yield* Effect.promise(() => Bun.file(file).text())).toBe("changed by agent\n")
          expect(redone.revert).toBeUndefined()
        }),
      { git: true },
    ),
    { timeout: 30000 },
  )
})
