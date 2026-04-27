#!/usr/bin/env bun

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

type Meta = {
  dir: string
  name: string
  deps: string[]
}

type Manifest = {
  date: string
  mode: "variant-b"
  seed: string[]
  packages: { dir: string; name: string }[]
  root: string[]
}

const root = resolve(dirname(import.meta.dir))
const args = process.argv.slice(2)
const plan = args.includes("--plan")
const out = (() => {
  const i = args.findIndex((item) => item === "--out")
  if (i === -1) return null
  const path = args[i + 1]
  return path ? resolve(path) : null
})()

if (!plan && !out) {
  console.error("Usage: bun script/fork-variant-b.ts --plan | --out <path>")
  process.exit(1)
}

const seed = ["kilo-code", "@kilocode/cli"]

const rootFiles = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "turbo.json",
  "tsconfig.json",
  ".gitignore",
  ".gitattributes",
  ".editorconfig",
  ".prettierignore",
  ".oxlintrc.json",
  "LICENSE",
  "README.md",
  "CONTRIBUTING.md",
  "CODE_OF_CONDUCT.md",
  "PRIVACY.md",
  "AGENTS.md",
  ".github/workflows/test-vscode.yml",
  ".github/actions/setup-bun/action.yml",
  "script/generate.ts",
  "script/format.ts",
]

const find = (obj: Record<string, string> | undefined) =>
  Object.entries(obj ?? {})
    .filter((item) => item[1] === "workspace:*")
    .map((item) => item[0])

const pkgDirs = [
  ...readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name),
  "sdk/js",
]

const metas = pkgDirs.flatMap((dir) => {
  const file = join(root, "packages", dir, "package.json")
  if (!existsSync(file)) return []
  const raw = readFileSync(file, "utf8")
  const json = JSON.parse(raw) as {
    name?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  if (!json.name) return []
  const deps = [...find(json.dependencies), ...find(json.devDependencies), ...find(json.peerDependencies)]
  return [{ dir, name: json.name, deps }]
})

const byName = new Map(metas.map((item) => [item.name, item]))
const seen = new Set<string>()

const walk = (name: string): void => {
  if (seen.has(name)) return
  seen.add(name)
  const item = byName.get(name)
  if (!item) return
  item.deps.forEach(walk)
}

seed.forEach(walk)

const need = metas
  .filter((item) => seen.has(item.name))
  .map((item) => ({ dir: item.dir, name: item.name }))
  .sort((a, b) => a.dir.localeCompare(b.dir))

const manifest: Manifest = {
  date: new Date().toISOString(),
  mode: "variant-b",
  seed,
  packages: need,
  root: rootFiles,
}

const cacheDir = join(root, "fork", "variant-b")
mkdirSync(cacheDir, { recursive: true })
const manifestPath = join(cacheDir, "manifest.json")
await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n")

const lines = [
  "# Variant B Fork Manifest",
  "",
  `Generated: ${manifest.date}`,
  "",
  "## Seed",
  "",
  ...seed.map((item) => `- \`${item}\``),
  "",
  "## Packages",
  "",
  ...need.map((item) => `- \`packages/${item.dir}\` (\`${item.name}\`)`),
  "",
  "## Root Files",
  "",
  ...rootFiles.map((item) => `- \`${item}\``),
  "",
]
await Bun.write(join(cacheDir, "README.md"), lines.join("\n"))

if (plan) {
  console.log(`Manifest written: ${manifestPath}`)
  console.log(`Packages: ${need.length}`)
  process.exit(0)
}

if (!out) {
  process.exit(1)
}

mkdirSync(out, { recursive: true })

const skip = new Set(["node_modules", ".turbo", "dist", "out"])

const copy = (srcRel: string) => {
  const src = join(root, srcRel)
  if (!existsSync(src)) return
  const dst = join(out, srcRel)
  mkdirSync(dirname(dst), { recursive: true })
  const dir = statSync(src).isDirectory()
  cpSync(src, dst, {
    recursive: dir,
    filter: (path) => {
      const name = path.split(/[\\/]/).pop() ?? ""
      if (name === ".git") return false
      return !skip.has(name)
    },
  })
}

rootFiles.forEach(copy)
need.forEach((item) => copy(join("packages", item.dir)))
copy("patches")

console.log(`Fork scaffold created: ${out}`)
console.log(`Manifest: ${manifestPath}`)
