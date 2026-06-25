export type MarkdownRange = {
  start: number
  end: number
}

export type MarkdownBlock =
  | { type: "block"; start: number; end: number }
  | { type: "list"; start: number; end: number; items: MarkdownRange[] }
  | { type: "table"; start: number; end: number; rows: MarkdownRange[] }

type Cursor = {
  index: number
  line: number
}

function blank(line: string): boolean {
  return line.trim() === ""
}

function fence(line: string): boolean {
  return line.trimStart().startsWith("```")
}

function table(line: string): boolean {
  return line.includes("|")
}

function separator(line: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line)
}

function item(line: string): boolean {
  return /^\s*(?:[-*+]|\d+\.)\s+/.test(line)
}

function quote(line: string): boolean {
  return line.trimStart().startsWith(">")
}

function next(pos: Cursor): Cursor {
  return { index: pos.index + 1, line: pos.line + 1 }
}

function readFence(lines: string[], pos: Cursor): [MarkdownBlock, Cursor] {
  let end = pos
  while (end.index + 1 < lines.length) {
    end = next(end)
    if (fence(lines[end.index] ?? "")) break
  }
  return [{ type: "block", start: pos.line, end: end.line }, next(end)]
}

function readTable(lines: string[], pos: Cursor): [MarkdownBlock, Cursor] {
  let end = pos
  while (end.index + 1 < lines.length && table(lines[end.index + 1] ?? "") && !blank(lines[end.index + 1] ?? "")) {
    end = next(end)
  }
  const rows = Array.from({ length: end.line - pos.line + 1 }, (_, index) => pos.line + index)
    .filter((line, index) => index !== 1 && line <= end.line)
    .map((line) => ({ start: line, end: line }))
  return [{ type: "table", start: pos.line, end: end.line, rows }, next(end)]
}

function readList(lines: string[], pos: Cursor): [MarkdownBlock, Cursor] {
  const items: MarkdownRange[] = []
  let cur = pos
  let start = cur.line

  while (cur.index < lines.length) {
    const line = lines[cur.index] ?? ""
    if (blank(line)) break
    if (item(line)) {
      if (items.length > 0) items[items.length - 1]!.end = cur.line - 1
      start = cur.line
    } else if (!/^\s+/.test(line)) {
      break
    }
    items.push({ start, end: cur.line })
    cur = next(cur)
  }

  const end = cur.line - 1
  const compact = items.filter((range, index) => index === items.length - 1 || range.start !== items[index + 1]?.start)
  return [{ type: "list", start: pos.line, end, items: compact }, cur]
}

function readBlock(lines: string[], pos: Cursor, match: (line: string) => boolean): [MarkdownBlock, Cursor] {
  let end = pos
  while (end.index + 1 < lines.length && match(lines[end.index + 1] ?? "")) {
    end = next(end)
  }
  return [{ type: "block", start: pos.line, end: end.line }, next(end)]
}

function readParagraph(lines: string[], pos: Cursor): [MarkdownBlock, Cursor] {
  let end = pos
  while (end.index + 1 < lines.length) {
    const line = lines[end.index + 1] ?? ""
    if (blank(line) || fence(line) || quote(line) || item(line) || table(line)) break
    end = next(end)
  }
  return [{ type: "block", start: pos.line, end: end.line }, next(end)]
}

export function markdownCommentBlocks(text: string): MarkdownBlock[] {
  const lines = text.split("\n")
  const result: MarkdownBlock[] = []
  let pos = { index: 0, line: 1 }

  while (pos.index < lines.length) {
    const line = lines[pos.index] ?? ""
    if (blank(line)) {
      pos = next(pos)
      continue
    }

    const read = (() => {
      if (fence(line)) return readFence(lines, pos)
      if (table(line) && separator(lines[pos.index + 1] ?? "")) return readTable(lines, pos)
      if (item(line)) return readList(lines, pos)
      if (quote(line)) return readBlock(lines, pos, quote)
      return readParagraph(lines, pos)
    })()

    result.push(read[0])
    pos = read[1]
  }

  return result
}
