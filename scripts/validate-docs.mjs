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
const planningTaskLines = planning
  .split(/\r?\n/)
  .filter((line) => /^\s*- \[[ x]\] [A-Z]{2,7}-\d{3}｜/.test(line))
const planningTaskIds = planningTaskLines.map((line) => line.match(/^\s*- \[[ x]\] ([A-Z]{2,7}-\d{3})｜/)[1])
assert.ok(planningTaskLines.length > 0, '02 必须保留至少一项当前正式任务')
assert.equal(
  new Set(planningTaskIds).size,
  planningTaskIds.length,
  '02 中每个正式任务必须只有一个权威勾选原件',
)

const allowedTaskStatuses = new Set(['未认领', '已认领', '进行中', '阻塞', '待验收', '已完成', '暂缓'])
for (const line of planningTaskLines) {
  const id = line.match(/^\s*- \[[ x]\] ([A-Z]{2,7}-\d{3})｜/)[1]
  const status = line.match(/｜状态：([^｜]+)/)?.[1]
  assert.ok(status && allowedTaskStatuses.has(status), `${id} 缺少有效状态`)
  if (status === '已完成') assert.match(line, /^\s*- \[x\]/, `已完成的 ${id} 必须勾选`)
  else assert.match(line, /^\s*- \[ \]/, `未完成的 ${id} 不得勾选`)
  for (const field of ['目标版本', '模块', '主责', '协作', '任务', '前置', '关联文档', '关联版本', '验证']) {
    assert.ok(line.includes(`｜${field}：`), `${id} 缺少任务字段：${field}`)
  }
}

const completedIndexPath = join(projectRoot, 'doc/03-子文档/39-已完成任务索引.md')
const completedIndex = await readFile(completedIndexPath, 'utf8')
const completedTaskSection = completedIndex.match(/## 2\. 已完成任务总表([\s\S]*?)## 3\./)?.[1] ?? ''
const completedTaskIds = [...completedTaskSection.matchAll(/`([A-Z]+-\d{3})`/g)].map((match) => match[1])
const declaredCompletedCount = Number(completedIndex.match(/合计：\*\*(\d+) 项已完成任务\*{2}/)?.[1])
assert.ok(Number.isInteger(declaredCompletedCount), '39 号索引必须声明已完成任务总数')
assert.ok(declaredCompletedCount >= 66, '39 号索引不得丢失本轮迁移的 66 项已完成任务')
assert.equal(completedTaskIds.length, declaredCompletedCount, '39 号索引的声明总数必须与任务 ID 数一致')
assert.equal(new Set(completedTaskIds).size, completedTaskIds.length, '39 号索引中的已完成任务不得重复')

const history = await readFile(join(projectRoot, 'doc/03-开发历史.md'), 'utf8')
for (const id of completedTaskIds) {
  assert.ok(history.includes(id), `已完成任务 ${id} 必须能在 03 主历史中检索`)
  assert.ok(!planningTaskIds.includes(id), `已完成任务 ${id} 不得继续占用 02 当前任务表`)
}

const migratedHistoryFiles = [
  '31-中长期路线决策与阶段史.md',
  '32-V0.1三模式与项目对接阶段史.md',
  '33-V0.2原型完善与验收阶段史.md',
  '34-V0.3阶段软件封包与验收阶段史.md',
  '35-V0.4完整离线运行时封包阶段史.md',
  '36-V0.6-H3高质量工作流与4060验收阶段史.md',
  '37-V0.6开箱即用封包与签名阶段史.md',
  '38-V0.7项目平台与智能创作阶段史.md',
  '39-已完成任务索引.md',
]
for (const fileName of migratedHistoryFiles) {
  await access(join(projectRoot, 'doc/03-子文档', fileName))
}
const retiredPlanningFiles = [
  '21-中长期优化路线.md',
  '22-三模式与项目对接架构.md',
  '23-V0.2原型完善验收方案.md',
  '24-V0.3阶段软件封包验收方案.md',
  '25-V0.4完整离线运行时封包方案.md',
  '26-V0.6-H3高质量工作流与4060验收方案.md',
  '27-V0.6开箱即用封包与签名方案.md',
  '28-V0.7项目平台与智能创作路线.md',
]
for (const fileName of retiredPlanningFiles) {
  let stillExists = true
  try {
    await access(join(projectRoot, 'doc/02-子文档', fileName))
  } catch {
    stillExists = false
  }
  assert.equal(stillExists, false, `${fileName} 已迁入历史，不得在 02 保留重复原件`)
}

console.log(`✓ Document metadata and relative links passed (${markdownFiles.length} Markdown files)`)
