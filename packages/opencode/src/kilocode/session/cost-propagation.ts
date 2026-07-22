// kilocode_change - new file
import { Effect } from "effect"
import { Session } from "@/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionID, MessageID } from "@/session/schema"

export namespace KiloCostPropagation {
  export const childCost = Effect.fn("KiloCostPropagation.childCost")(function* (
    sessions: Session.Interface,
    id: SessionID,
  ) {
    const msgs = yield* sessions.messages({ sessionID: id })
    return msgs.reduce((sum, msg) => sum + (msg.info.role === "assistant" ? msg.info.cost : 0), 0)
  })

  export const propagate = Effect.fn("KiloCostPropagation.propagate")(function* (
    sessions: Session.Interface,
    sid: SessionID,
    mid: MessageID,
    amount: number,
  ) {
    if (!(amount > 0)) return
    const parent = yield* Effect.sync(() => MessageV2.get({ sessionID: sid, messageID: mid }))
    if (parent.info.role !== "assistant") return
    parent.info.cost += amount
    yield* sessions.updateMessage(parent.info)
  })
}
