import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { ConfigAgent } from "@/config/agent"
import { ConfigParse } from "@/config/parse"
import * as AgentRequirements from "@/kilocode/agent-requirements"
import type { MCP } from "@/mcp"
import type { Skill } from "@/skill"

type TestAgent = {
  name: string
  requirements?: unknown
}

type Input = {
  active?: boolean
  agents?: Record<string, TestAgent>
  skills?: string[]
  skillError?: string
  mcp?: Record<string, MCP.Status>
  mcpError?: string
}

const dir = "/tmp/agent-requirements"

function services(input: Input = {}) {
  return {
    config: {
      get: () => Effect.succeed({ experimental: input.active ? { agent_requirements: true } : {} }),
    },
    agents: {
      get: (name: string) => Effect.succeed(input.agents?.[name]),
    },
    skills: {
      all: () => {
        if (input.skillError) return Effect.die(new Error(input.skillError))
        return Effect.succeed(
          (input.skills ?? []).map(
            (name) => ({ name, description: "test", location: "test", content: "" }) satisfies Skill.Info,
          ),
        )
      },
    },
    mcp: {
      status: () => {
        if (input.mcpError) return Effect.die(new Error(input.mcpError))
        return Effect.succeed(input.mcp ?? {})
      },
    },
  }
}

function status(name: string, input: Input) {
  return Effect.runPromise(AgentRequirements.status({ ...services(input), name, directory: dir }))
}

async function client(value: string | undefined, run: () => Promise<void>) {
  const prev = process.env.KILO_CLIENT
  try {
    if (value === undefined) delete process.env.KILO_CLIENT
    if (value !== undefined) process.env.KILO_CLIENT = value
    await run()
  } finally {
    if (prev === undefined) delete process.env.KILO_CLIENT
    if (prev !== undefined) process.env.KILO_CLIENT = prev
  }
}

describe("agent requirements", () => {
  test("returns disabled when the experimental flag is absent", async () => {
    const result = await status("missing", {})
    expect(result).toMatchObject({ agent: "missing", directory: dir, enabled: false, state: "disabled" })
  })

  test("returns ready for agents without requirements", async () => {
    const result = await status("demo", { active: true, agents: { demo: { name: "demo" } } })
    expect(result).toMatchObject({ agent: "demo", directory: dir, enabled: true, state: "ready" })
  })

  test("reports unknown agents while requirements are enabled", async () => {
    const result = await status("missing", { active: true })
    expect(result.state).toBe("error")
    expect(result.error?.code).toBe("unknown_agent")
  })

  test("reports discovered and missing skills", async () => {
    const result = await status("demo", {
      active: true,
      agents: { demo: { name: "demo", requirements: { skills: ["ready", "absent"] } } },
      skills: ["ready"],
    })
    expect(result.state).toBe("blocked")
    expect(result.skills).toEqual([
      { name: "ready", status: "ready" },
      { name: "absent", status: "missing" },
    ])
  })

  test("accepts non-empty marketplace skill and MCP names", async () => {
    const result = await status("demo", {
      active: true,
      agents: { demo: { name: "demo", requirements: { skills: ["skill with space"], mcps: ["mcp/with/slash"] } } },
      skills: ["skill with space"],
      mcp: { "mcp/with/slash": { status: "connected" } },
    })
    expect(result.state).toBe("ready")
  })

  test("reports MCP connected, missing, and error states", async () => {
    const result = await status("demo", {
      active: true,
      agents: { demo: { name: "demo", requirements: { mcps: ["connected", "disabled", "failed"] } } },
      mcp: {
        connected: { status: "connected" },
        disabled: { status: "disabled" },
        failed: { status: "failed", error: "server crashed" },
      },
    })
    expect(result.state).toBe("blocked")
    expect(result.mcps).toEqual([
      { name: "connected", status: "ready" },
      { name: "disabled", status: "missing" },
      { name: "failed", status: "error", message: "server crashed" },
    ])
  })

  test("guards unmet requirements for all clients", async () => {
    const input = {
      active: true,
      agents: { demo: { name: "demo", requirements: { skills: ["missing"] } } },
    }

    await client("cli", async () => {
      const exit = await Effect.runPromiseExit(
        AgentRequirements.guard({ ...services(input), agent: input.agents.demo, directory: dir }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isSuccess(exit)) return
      expect(AgentRequirements.BlockedError.isInstance(Cause.squash(exit.cause))).toBe(true)
    })
  })

  test("blocks VS Code extension requirements outside VS Code", async () => {
    const input = {
      active: true,
      agents: {
        demo: {
          name: "demo",
          requirements: { vscode_extensions: [{ name: "Jupyter", id: "ms-toolsai.jupyter" }] },
        },
      },
    }

    await client("cli", async () => {
      const exit = await Effect.runPromiseExit(
        AgentRequirements.guard({ ...services(input), agent: input.agents.demo, directory: dir }),
      )
      expect(Exit.isFailure(exit)).toBe(true)
    })

    await client("vscode", async () => {
      await Effect.runPromise(AgentRequirements.guard({ ...services(input), agent: input.agents.demo, directory: dir }))
    })
  })

  test("keeps requirements out of agent options", () => {
    const agent = ConfigParse.schema(
      ConfigAgent.Info,
      {
        name: "demo",
        requirements: { skills: ["needed"] },
        custom: true,
      },
      "agent/demo.md",
    )
    expect(agent.requirements).toEqual({ skills: ["needed"] })
    expect(agent.options).toEqual({ custom: true })
  })
})
