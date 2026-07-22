// kilocode_change - new file
import { describe, expect, test } from "bun:test"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"
import type { Agent } from "../../src/agent/agent"
import type { Permission } from "../../src/permission"

function agent(permission: Permission.Ruleset): Agent.Info {
  return {
    name: "agent",
    mode: "subagent",
    permission,
    options: {},
  } as Agent.Info
}

describe("deriveSubagentSessionPermission", () => {
  test("keeps parent deny ceilings and preserves subagent task/todo allows", () => {
    const rules = deriveSubagentSessionPermission({
      parentAgent: agent([{ permission: "edit", pattern: "src/**", action: "deny" }]),
      parentSessionPermission: [
        { permission: "bash", pattern: "rm *", action: "deny" },
        { permission: "external_directory", pattern: "/tmp/outside", action: "allow" },
        { permission: "read", pattern: "*", action: "allow" },
      ],
      subagent: agent([
        { permission: "task", pattern: "*", action: "allow" },
        { permission: "todowrite", pattern: "*", action: "allow" },
      ]),
    })

    expect(rules).toEqual([
      { permission: "edit", pattern: "src/**", action: "deny" },
      { permission: "bash", pattern: "rm *", action: "deny" },
      { permission: "external_directory", pattern: "/tmp/outside", action: "allow" },
    ])
  })
})
