// kilocode_change - new file
import { Provider } from "@/provider"
import type { ProviderID } from "@/provider/schema"
import { Tool } from "@/tool"
import { Effect } from "effect"
import z from "zod"
import DESCRIPTION from "./agent-manager-models.txt"
import { matchesQuery } from "./model-search"

const Params = z.object({
  query: z.string().optional().describe("Case-insensitive search across model names and IDs"),
  offset: z.number().int().min(0).optional().describe("Result offset for pagination"),
  limit: z.number().int().min(1).optional().describe("Maximum models to return"),
})

const MAX = 20

type Entry = {
  name: string
  providers: string[]
  variants: string[]
  ids: string[]
  rank: number
}

function entries(providers: Record<ProviderID, Provider.Info>): Entry[] {
  const grouped = new Map<string, Entry>()
  for (const provider of Object.values(providers)) {
    for (const model of Object.values(provider.models)) {
      const entry = grouped.get(model.name) ?? {
        name: model.name,
        providers: [],
        variants: [],
        ids: [],
        rank: Number.POSITIVE_INFINITY,
      }
      if (!entry.providers.includes(provider.id)) entry.providers.push(provider.id)
      entry.ids.push(`${provider.id}/${model.id}`)
      for (const variant of Object.keys(model.variants ?? {})) {
        if (!entry.variants.includes(variant)) entry.variants.push(variant)
      }
      const index = typeof model.recommendedIndex === "number" ? model.recommendedIndex : Number.POSITIVE_INFINITY
      entry.rank = Math.min(entry.rank, index)
      grouped.set(model.name, entry)
    }
  }
  return [...grouped.values()].sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
}

function view(entry: Entry) {
  return { name: entry.name, providers: entry.providers, variants: entry.variants }
}

export const AgentManagerModelsTool = Tool.define<
  typeof Params,
  { count: number; total: number },
  Provider.Service,
  "agent_manager_models"
>(
  "agent_manager_models",
  Effect.gen(function* () {
    const provider = yield* Provider.Service
    return {
      description: DESCRIPTION,
      parameters: Params,
      execute: (params) =>
        Effect.gen(function* () {
          const providers = yield* provider.list()
          const all = entries(providers)
          const query = params.query?.trim()
          const found = query ? all.filter((entry) => matchesQuery([entry.name, ...entry.ids], query)) : all
          const offset = params.offset ?? 0
          const limit = Math.min(params.limit ?? MAX, MAX)
          const models = found.slice(offset, offset + limit).map(view)
          const nextOffset = offset + models.length < found.length ? offset + models.length : undefined
          return {
            title: query
              ? `${found.length} model${found.length === 1 ? "" : "s"} matching "${query}"`
              : `${found.length} available models`,
            output: JSON.stringify({
              models,
              offset,
              total: found.length,
              nextOffset,
              hint: "Pass a model name (or one of its providers/IDs) as the agent_manager task `model`. Agent Manager picks the provider, preferring the invoking model provider, then your default provider.",
            }),
            metadata: { count: models.length, total: found.length },
          }
        }),
    }
  }),
)
