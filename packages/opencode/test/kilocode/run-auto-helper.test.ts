// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { KiloRunAuto } from "../../src/kilocode/cli/run-auto"

describe("KiloRunAuto", () => {
  test("tracks task child sessions from root task parts", () => {
    const state = KiloRunAuto.create("ses_root")

    KiloRunAuto.track(state, {
      type: "tool",
      tool: "task",
      sessionID: "ses_root",
      state: {
        metadata: {
          sessionId: "ses_child",
        },
      },
    })

    expect(KiloRunAuto.allowed(state, "ses_root")).toBe(true)
    expect(KiloRunAuto.allowed(state, "ses_child")).toBe(true)
    expect(KiloRunAuto.allowed(state, "ses_other")).toBe(false)
  })

  test("ignores non-root task parts", () => {
    const state = KiloRunAuto.create("ses_root")

    KiloRunAuto.track(state, {
      type: "tool",
      tool: "task",
      sessionID: "ses_other",
      state: {
        metadata: {
          sessionId: "ses_child",
        },
      },
    })

    expect(KiloRunAuto.allowed(state, "ses_child")).toBe(false)
  })
})
