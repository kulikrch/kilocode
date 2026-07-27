// kilocode_change - new file
function collapse(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function tokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

export function matchesQuery(haystacks: string[], query: string): boolean {
  const parts = tokens(query)
  if (parts.length === 0) return true
  const text = haystacks.map(collapse).join(" ")
  return parts.every((part) => text.includes(part))
}
