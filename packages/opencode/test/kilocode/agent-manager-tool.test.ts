import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime, Queue } from "effect"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { AgentManagerEvent, type AgentManagerStart } from "../../src/kilocode/agent-manager/event"
import { AgentManagerTool } from "../../src/kilocode/tool/agent-manager"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { MessageID, SessionID } from "../../src/session/schema"
import { Tool, Truncate } from "../../src/tool"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"

const providers = {
  test: {
    id: "test",
    name: "Test Provider",
    models: {
      "reasoning/model": {
        id: "reasoning/model",
        providerID: "test",
        name: "Reasoning Model",
        variants: { low: {}, high: {} },
      },
      "test/shared": { id: "test/shared", providerID: "test", name: "Shared", variants: { low: {}, high: {} } },
    },
  } as unknown as Provider.Info,
  kilo: {
    id: "kilo",
    name: "Kilo Gateway",
    models: {
      "kilo/shared": { id: "kilo/shared", providerID: "kilo", name: "Shared", variants: { low: {} } },
      "kilo/only": { id: "kilo/only", providerID: "kilo", name: "Gateway Only", variants: { low: {} } },
    },
  } as unknown as Provider.Info,
  alpha: {
    id: "alpha",
    name: "Alpha Provider",
    models: {
      "alpha/shared": { id: "alpha/shared", providerID: "alpha", name: "External Shared", variants: {} },
    },
  } as unknown as Provider.Info,
  zeta: {
    id: "zeta",
    name: "Zeta Provider",
    models: {
      "zeta/shared": { id: "zeta/shared", providerID: "zeta", name: "External Shared", variants: {} },
    },
  } as unknown as Provider.Info,
}

function runtime(defaultProviderID = "test") {
  return ManagedRuntime.make(
    Layer.mergeAll(
      Truncate.defaultLayer,
      Agent.defaultLayer,
      Bus.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      Layer.mock(Provider.Service)({
        list: () => Effect.succeed(providers),
        defaultModel: () =>
          Effect.succeed({
            providerID: ProviderID.make(defaultProviderID),
            modelID: ModelID.make("reasoning/model"),
          }) as never,
      }),
    ),
  )
}

const rt = runtime()

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("msg_test"),
  callID: "call_agent_manager",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [] as Tool.Context["messages"],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

function msg(
  id: string,
  provider: string,
  model: string,
  variant?: string,
  created = 1,
): Tool.Context["messages"][number] {
  return {
    info: {
      id: MessageID.make(id),
      sessionID: ctx.sessionID,
      role: "user",
      time: { created },
      agent: "build",
      model: {
        providerID: ProviderID.make(provider),
        modelID: ModelID.make(model),
        ...(variant ? { variant } : {}),
      },
    },
    parts: [],
  }
}

async function init() {
  return rt.runPromise(
    Effect.gen(function* () {
      const info = yield* AgentManagerTool
      return yield* Tool.init(info)
    }),
  )
}

function publish(
  runner: ReturnType<typeof runtime>,
  task: Record<string, unknown>,
  messages: Tool.Context["messages"] = ctx.messages,
) {
  return runner.runPromise(
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const tool = yield* Tool.init(yield* AgentManagerTool)
        const bus = yield* Bus.Service
        const events = yield* Queue.unbounded<AgentManagerStart>()
        const off = yield* bus.subscribeCallback(AgentManagerEvent.Start, (item) =>
          Queue.offerUnsafe(events, item.properties),
        )
        yield* Effect.addFinalizer(() => Effect.sync(off))
        yield* tool.execute({ mode: "local", tasks: [task] }, { ...ctx, messages, ask: () => Effect.void })
        const event = yield* Queue.take(events).pipe(Effect.timeout("2 seconds"))
        return event.tasks[0]
      }),
    ).pipe(Effect.scoped),
  )
}

describe("agent_manager tool", () => {
  test("asks for agent_manager permission", async () => {
    const tool = await init()
    const calls: unknown[] = []

    await rt.runPromise(
      provideTmpdirInstance(() =>
        tool.execute(
          { mode: "local", tasks: [{ prompt: "Fix issue" }] },
          { ...ctx, ask: (input: unknown) => Effect.sync(() => calls.push(input)) },
        ),
      ).pipe(Effect.scoped),
    )

    expect(calls).toEqual([
      {
        permission: "agent_manager",
        patterns: ["local"],
        always: ["local"],
        metadata: { mode: "local", count: 1 },
      },
    ])
  })

  test("inherits latest invoking model and variant when omitted", async () => {
    const task = await publish(rt, { prompt: "Fix" }, [
      msg("msg_current", "kilo", "kilo/shared", "low", 2),
      msg("msg_old", "test", "reasoning/model", "high", 1),
    ])

    expect(String(task?.model?.providerID)).toBe("kilo")
    expect(String(task?.model?.modelID)).toBe("kilo/shared")
    expect(task?.variant).toBe("low")
  })

  test("leaves prepared sessions on defaults", async () => {
    const task = await publish(rt, { name: "Prepared" }, [msg("msg_current", "test", "reasoning/model", "high")])

    expect(task?.model).toBeUndefined()
    expect(task?.variant).toBeUndefined()
  })

  test("explicit model and variant override invoking selection", async () => {
    const task = await publish(rt, { prompt: "Fix", model: "test/reasoning/model", variant: "high" }, [
      msg("msg_current", "kilo", "kilo/shared", "low"),
    ])

    expect(String(task?.model?.providerID)).toBe("test")
    expect(String(task?.model?.modelID)).toBe("reasoning/model")
    expect(task?.variant).toBe("high")
  })

  test("overrides only inherited variant when model is omitted", async () => {
    const task = await publish(rt, { prompt: "Fix", variant: "high" }, [
      msg("msg_current", "test", "reasoning/model", "low"),
    ])

    expect(String(task?.model?.providerID)).toBe("test")
    expect(String(task?.model?.modelID)).toBe("reasoning/model")
    expect(task?.variant).toBe("high")
  })

  test("resolves model name to preferred provider, then kilo, then stable id", async () => {
    const first = await publish(rt, { prompt: "Fix", model: "Shared", variant: "low" })
    const second = await publish(runtime("kilo"), { prompt: "Fix", model: "Shared", variant: "low" })
    const third = await publish(rt, { prompt: "Fix", model: "External Shared" })

    expect(String(first?.model?.providerID)).toBe("test")
    expect(String(second?.model?.providerID)).toBe("kilo")
    expect(String(third?.model?.providerID)).toBe("alpha")
  })

  test("rejects unavailable variant before requesting permission", async () => {
    const tool = await init()
    const calls: unknown[] = []

    const result = await rt.runPromise(
      provideTmpdirInstance(() =>
        tool.execute(
          { mode: "local", tasks: [{ prompt: "Fix issue", model: "test/reasoning/model", variant: "toString" }] },
          { ...ctx, ask: (input: unknown) => Effect.sync(() => calls.push(input)) },
        ),
      ).pipe(Effect.scoped),
    )

    expect(calls).toEqual([])
    expect(result.output).toContain("Available variants: low, high")
    expect(result.metadata.count).toBe(0)
  })

  test("rejects empty tasks", async () => {
    const tool = await init()

    await expect(
      rt.runPromise(
        provideTmpdirInstance(() =>
          tool.execute({ mode: "local", tasks: [{}] }, { ...ctx, ask: () => Effect.void }),
        ).pipe(Effect.scoped),
      ),
    ).rejects.toThrow("Each task must include prompt, name, or branchName")
  })
})
