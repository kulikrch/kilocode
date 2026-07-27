// kilocode_change - new file
import { Database, eq } from "@/storage"
import { SessionTable } from "@/session/session.sql"
import type { SessionID } from "@/session/schema"

export namespace KiloHeadless {
  const roots = new Set<string>()

  export function mark(id: string) {
    roots.add(id)
  }

  export function clear(id: string) {
    roots.delete(id)
  }

  export function denies(id: string): boolean {
    if (roots.size === 0) return false
    if (roots.has(id)) return false
    for (let parent = lookup(id); parent; parent = lookup(parent)) {
      if (roots.has(parent)) return true
    }
    return false
  }

  function lookup(id: string) {
    const row = Database.use((db) =>
      db
        .select({ parent: SessionTable.parent_id })
        .from(SessionTable)
        .where(eq(SessionTable.id, id as SessionID))
        .get(),
    )
    return row?.parent ?? undefined
  }
}
