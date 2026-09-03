import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const distRoot = join(projectRoot, 'dist')
const manifestPath = join(distRoot, '.vite', 'manifest.json')
const reportPath = join(projectRoot, '.runtime', 'qa', 'mode-splitting.json')

const V0752_BASELINE = {
  entryJavaScriptBytes: 1_013_060,
  entryCssBytes: 285_880,
}

const ENTRY_BUDGET = {
  javascriptBytes: 525_000,
  cssBytes: 80_000,
  minimumJavaScriptReductionPercent: 45,
}

const REQUIRED_SURFACES = [
  { kind: 'mode', source: 'src/App.tsx', maximumBytes: 260_000, requiresCss: true },
  { kind: 'mode', source: 'src/modes/pixel/PixelModeWorkbench.tsx', maximumBytes: 150_000, requiresCss: true },
  { kind: 'mode', source: 'src/modes/video/SmartVideoWorkbench.tsx', maximumBytes: 210_000, requiresCss: true },
  { kind: 'dialog', source: 'src/components/Library/AssetLibraryDialog.tsx', maximumBytes: 50_000 },
  { kind: 'dialog', source: 'src/components/WorkflowCenter/WorkflowCenterDialog.tsx', maximumBytes: 70_000 },
  { kind: 'dialog', source: 'src/components/Home/RuntimeSettingsDialog.tsx', maximumBytes: 60_000 },
  { kind: 'dialog', source: 'src/components/Home/ProjectRecoveryDialog.tsx', maximumBytes: 25_000 },
]

async function artifactFact(relativePath) {
  const absolutePath = join(distRoot, relativePath)
  const [metadata, bytes] = await Promise.all([stat(absolutePath), readFile(absolutePath)])
  assert.equal(metadata.isFile(), true, `Expected build artifact ${relativePath}`)
  return {
    file: relativePath.replaceAll('\\', '/'),
    bytes: metadata.size,
    gzipBytes: gzipSync(bytes).byteLength,
  }
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const entry = Object.values(manifest).find((candidate) => candidate?.isEntry)
assert.ok(entry, 'Vite manifest must expose one production entry')
assert.equal(entry.src, 'index.html', 'Production entry must remain index.html')

const dynamicImports = new Set(entry.dynamicImports ?? [])
const staticImports = new Set(entry.imports ?? [])
const surfaceFacts = []

for (const requirement of REQUIRED_SURFACES) {
  const record = manifest[requirement.source]
  assert.ok(record, `Manifest is missing ${requirement.source}`)
  assert.equal(record.isDynamicEntry, true, `${requirement.source} must remain a dynamic entry`)
  assert.equal(dynamicImports.has(requirement.source), true, `${requirement.source} must be requested from the entry through import()`)
  assert.equal(staticImports.has(requirement.source), false, `${requirement.source} must not be a static entry dependency`)
  const artifact = await artifactFact(record.file)
  assert.ok(artifact.bytes <= requirement.maximumBytes, `${requirement.source} exceeds ${requirement.maximumBytes} bytes (${artifact.bytes})`)
  const css = await Promise.all((record.css ?? []).map(artifactFact))
  if (requirement.requiresCss) {
    assert.ok(css.length > 0, `${requirement.source} must keep its mode stylesheet outside the home entry`)
  }
  surfaceFacts.push({ ...requirement, ...artifact, css })
}

const entryJavaScript = await artifactFact(entry.file)
const entryCss = await Promise.all((entry.css ?? []).map(artifactFact))
const entryCssBytes = entryCss.reduce((sum, artifact) => sum + artifact.bytes, 0)
const reductionPercent = Number((
  (1 - (entryJavaScript.bytes / V0752_BASELINE.entryJavaScriptBytes)) * 100
).toFixed(2))

assert.ok(
  entryJavaScript.bytes <= ENTRY_BUDGET.javascriptBytes,
  `Home entry exceeds ${ENTRY_BUDGET.javascriptBytes} bytes (${entryJavaScript.bytes})`,
)
assert.ok(
  entryCssBytes <= ENTRY_BUDGET.cssBytes,
  `Home CSS exceeds ${ENTRY_BUDGET.cssBytes} bytes (${entryCssBytes})`,
)
assert.ok(
  reductionPercent >= ENTRY_BUDGET.minimumJavaScriptReductionPercent,
  `Home entry reduction must remain at least ${ENTRY_BUDGET.minimumJavaScriptReductionPercent}% (actual ${reductionPercent}%)`,
)
assert.equal(
  (entry.assets ?? []).some((asset) => /sample-summer-character/iu.test(asset)),
  false,
  'Balanced-mode sample imagery must not be eagerly attached to the home entry',
)

const report = {
  schemaVersion: 1,
  status: 'passed',
  generatedAt: new Date().toISOString(),
  baseline: V0752_BASELINE,
  budget: ENTRY_BUDGET,
  entry: {
    ...entryJavaScript,
    css: entryCss,
    cssBytes: entryCssBytes,
    reductionPercent,
  },
  surfaces: surfaceFacts,
}

await mkdir(join(projectRoot, '.runtime', 'qa'), { recursive: true })
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')

console.table([
  { surface: 'home', bytes: entryJavaScript.bytes, gzipBytes: entryJavaScript.gzipBytes, cssBytes: entryCssBytes },
  ...surfaceFacts.map((surface) => ({
    surface: surface.source,
    bytes: surface.bytes,
    gzipBytes: surface.gzipBytes,
    cssBytes: surface.css.reduce((sum, artifact) => sum + artifact.bytes, 0),
  })),
])
console.log(`✓ mode splitting gate passed: home JS ${entryJavaScript.bytes} bytes (${reductionPercent}% below V0.7.52), home CSS ${entryCssBytes} bytes`)
