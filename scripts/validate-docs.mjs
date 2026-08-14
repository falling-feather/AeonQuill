import assert from 'node:assert/strict'
import { access, readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const coreDocuments = [
  'doc/00-项目总纲.md',
  'doc/01-开发者文档.md',
  'doc/02-项目规划.md',
  'doc/03-开发历史.md',
]

async function collectMarkdown(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await collectMarkdown(target))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(target)
  }
  return files
}

for (const relativePath of coreDocuments) {
  const content = await readFile(join(projectRoot, relativePath), 'utf8')
  assert.match(content, /\*\*最后一次更新时间\*\*：\d{4}-\d{2}-\d{2}/, `${relativePath} 缺少有效更新时间`)
  assert.match(content, /\*\*更新者\*\*：\S+/, `${relativePath} 缺少更新者`)
}

const markdownFiles = [join(projectRoot, 'README.md'), ...await collectMarkdown(join(projectRoot, 'doc'))]
const missingLinks = []
for (const filePath of markdownFiles) {
  const content = await readFile(filePath, 'utf8')
  for (const match of content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim()
    if (!target || target.startsWith('#') || /^(?:https?:|mailto:|thread:)/i.test(target)) continue
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
    target = decodeURIComponent(target.split('#', 1)[0].split('?', 1)[0])
    if (!target) continue
    const absoluteTarget = resolve(dirname(filePath), target)
    try {
      await access(absoluteTarget)
    } catch {
      missingLinks.push(`${filePath.slice(projectRoot.length)} -> ${target}`)
    }
  }
}
assert.deepEqual(missingLinks, [], `文档存在失效相对链接：\n${missingLinks.join('\n')}`)

const planning = await readFile(join(projectRoot, 'doc/02-项目规划.md'), 'utf8')
const qaTaskLines = planning.split(/\r?\n/).filter((line) => /^\s*- \[[ x]\] QA-001｜/.test(line))
assert.equal(qaTaskLines.length, 1, 'QA-001 必须只有一个权威任务条目')
assert.match(qaTaskLines[0], /^\s*- \[x\].*状态：已完成/, 'QA-001 状态与复选框必须一致')
const secTaskLines = planning.split(/\r?\n/).filter((line) => /^\s*- \[[ x]\] SEC-001｜/.test(line))
assert.equal(secTaskLines.length, 1, 'SEC-001 必须只有一个权威任务条目')
assert.match(secTaskLines[0], /^\s*- \[[ x]\].*状态：(进行中|待验收|已完成)/, 'SEC-001 状态字段无效')
if (secTaskLines[0].includes('状态：已完成')) assert.match(secTaskLines[0], /^\s*- \[x\]/, '已完成的 SEC-001 必须勾选')
else assert.match(secTaskLines[0], /^\s*- \[ \]/, '未完成的 SEC-001 不得勾选')

console.log(`✓ Document metadata and relative links passed (${markdownFiles.length} Markdown files)`)
