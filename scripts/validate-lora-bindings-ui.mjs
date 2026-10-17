import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createProjectCatalog, createWorkspaceProject } from '../src/lib/project/projectCatalog.mjs'
import { startFakeComfyRuntime } from './qa-fake-comfy.mjs'
import { startIsolatedBridge } from './qa-runtime.mjs'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const qaRoot = resolve(projectRoot, '.runtime', 'qa')
const fixturePrefix = 'lora-bindings-fixture-'
const reportPath = join(qaRoot, 'lora-bindings-api.json')
const keepFixture = process.env.AEONQUILL_KEEP_LORA_BINDINGS_QA === '1'

function bytesFor(shape) {
  return shape.reduce((total, value) => total * value, 2)
}

function makeSafetensors(family = 'qwen-image-edit') {
  const entries = {}
  const chunks = []
  let offset = 0
  const add = (name, shape) => {
    const bytes = bytesFor(shape)
    entries[name] = { dtype: 'F16', shape, data_offsets: [offset, offset + bytes] }
    chunks.push(Buffer.alloc(bytes))
    offset += bytes
  }
  add('unet.lora_A.weight', [2, 2])
  add('unet.lora_B.weight', [2, 2])
  const metadata = family === null ? { ss_network_module: 'networks.lora' } : { ss_base_model_version: family }
  const header = Buffer.from(JSON.stringify({ __metadata__: metadata, ...entries }), 'utf8')
  const prefix = Buffer.alloc(8)
  prefix.writeBigUInt64LE(BigInt(header.length), 0)
  return Buffer.concat([prefix, header, ...chunks])
}

async function writeModel(root, relativeName, family) {
  const target = join(root, ...relativeName.split('/'))
  await mkdir(join(target, '..'), { recursive: true })
  await writeFile(target, makeSafetensors(family))
  return target
}

async function requestJson(bridge, pathname, options = {}, expected = 200) {
  const response = await bridge.request(pathname, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json', ...options.headers } : options.headers,
  })
  const payload = await response.json().catch(() => null)
  assert.equal(response.status, expected, (options.method || 'GET') + ' ' + pathname + ': ' + JSON.stringify(payload))
  return payload
}

async function waitForTerminal(bridge, jobId) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const payload = await requestJson(bridge, '/api/jobs/' + encodeURIComponent(jobId))
    if (['completed', 'failed', 'cancelled'].includes(payload.job.status) && payload.job.scheduling?.finishedAt) return payload.job
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100))
  }
  throw new Error('LoRA fixture job did not reach a terminal state: ' + jobId)
}

function qwenObjectInfo() {
  return {
    UNETLoader: { input: { required: { unet_name: [['qwen_image_edit_2511_int8_convrot.safetensors']] } } },
    LoraLoaderModelOnly: {
      input: {
        required: {
          model: ['MODEL', {}],
          lora_name: [['sub/style.safetensors', 'shadow.safetensors']],
          strength_model: ['FLOAT', {}],
        },
      },
    },
    CLIPTextEncode: { input: { required: { text: ['STRING', {}] } } },
    SaveImage: { input: { required: {} } },
  }
}

function qwenWorkflow(loraName) {
  return {
    1: { class_type: 'UNETLoader', inputs: { unet_name: 'qwen_image_edit_2511_int8_convrot.safetensors' } },
    2: { class_type: 'SaveImage', inputs: { images: ['3', 0], filename_prefix: 'lora-fixture' } },
    3: { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: loraName, strength_model: 1 } },
    4: { class_type: 'CLIPTextEncode', inputs: { text: 'fixture prompt' } },
  }
}

function qwenMappings() {
  return {
    prompt: { nodeId: '4', inputName: 'text' },
    loraStrength: { nodeId: '3', inputName: 'strength_model' },
    output: { nodeId: '2' },
  }
}

async function createFixture() {
  await mkdir(qaRoot, { recursive: true })
  const root = await mkdtemp(join(qaRoot, fixturePrefix))
  const comfyRoot = join(root, 'ComfyUI')
  const sharedRoot = join(root, 'Shared')
  await mkdir(join(comfyRoot, 'models', 'loras'), { recursive: true })
  await mkdir(join(sharedRoot, 'models', 'loras'), { recursive: true })
  await writeFile(join(comfyRoot, 'main.py'), '# LoRA API fixture\n', 'utf8')
  const styleFile = await writeModel(comfyRoot, 'models/loras/sub/style.safetensors', 'qwen-image-edit')
  const unknownFile = await writeModel(comfyRoot, 'models/loras/sub/unknown.safetensors', null)
  const shadowLocal = await writeModel(comfyRoot, 'models/loras/shadow.safetensors', 'qwen-image-edit')
  await writeModel(sharedRoot, 'models/loras/shadow.safetensors', 'qwen-image-edit')
  const sharedPath = sharedRoot.replace(/\\/gu, '/')
  await writeFile(join(comfyRoot, 'extra_model_paths.yaml'), [
    'aeonquill_shared:',
    '  base_path: \"' + sharedPath + '\"',
    '  loras: models/loras',
    '',
  ].join('\n'), 'utf8')
  return { root, comfyRoot, styleFile, unknownFile, shadowLocal }
}

async function setupWorkspace(bridge) {
  const created = createWorkspaceProject(createProjectCatalog(), {
    title: 'LoRA 绑定 API 验收项目',
    initialModeId: 'balanced',
    color: 'violet',
  }, { projectId: 'project-lora-qa', documentId: 'document-lora-qa', now: 1_000 })
  await requestJson(bridge, '/api/workspace/catalog', {
    method: 'PUT',
    body: JSON.stringify({ catalog: created.catalog, baseRevision: 0, source: 'lora-bindings-api-qa' }),
  })
}

async function runApiGate() {
  const fixture = await createFixture()
  const comfy = await startFakeComfyRuntime({ objectInfo: qwenObjectInfo() })
  const bridge = await startIsolatedBridge('lora-bindings-api', {
    comfyUrl: comfy.url,
    environment: {
      COMFY_ROOT: fixture.comfyRoot,
      AEONQUILL_COMFY_ROOT: fixture.comfyRoot,
      COMFY_PYTHON: process.execPath,
      AEONQUILL_COMFY_PYTHON: process.execPath,
    },
  })
  const report = {
    schemaVersion: 1,
    kind: 'lora-bindings-api-contract',
    qualityScope: 'fixture-contract-only; no model quality claim',
    browser: { status: 'not-run', reason: 'Root must approve dist-ready Edge validation separately' },
    gpu: { started: false, used: false },
    checks: {},
  }
  try {
    await setupWorkspace(bridge)
    const emptyRoot = join(fixture.root, 'EmptyComfy')
    await mkdir(emptyRoot, { recursive: true })
    await writeFile(join(emptyRoot, 'main.py'), '# empty LoRA runtime fixture\n', 'utf8')
    const emptyBridge = await startIsolatedBridge('lora-bindings-empty', {
      comfyUrl: comfy.url,
      environment: {
        COMFY_ROOT: emptyRoot,
        AEONQUILL_COMFY_ROOT: emptyRoot,
        COMFY_PYTHON: process.execPath,
        AEONQUILL_COMFY_PYTHON: process.execPath,
      },
    })
    try {
      const emptyCatalog = await requestJson(emptyBridge, '/api/workflow-center/loras')
      assert.equal(emptyCatalog.models.length, 0)
      assert.ok(emptyCatalog.warnings.some((warning) => warning.includes('LORA_ROOT_MISSING')))
      report.checks.emptyDirectory = { status: 'empty-with-guidance', warnings: emptyCatalog.warnings.length }
    } finally {
      await emptyBridge.stop({ keepRuntime: false }).catch(() => {})
    }
    const catalog = await requestJson(bridge, '/api/workflow-center/loras')
    report.checks.catalog = { modelCount: catalog.models.length, bindingCount: catalog.bindings.length, warnings: catalog.warnings.length }
    assert.ok(catalog.models.some((model) => model.name === 'sub/style.safetensors'))
    assert.equal(catalog.models.filter((model) => model.name === 'shadow.safetensors').length, 2)

    const styleModel = catalog.models.find((model) => model.name === 'sub/style.safetensors')
    const unknownModel = catalog.models.find((model) => model.name === 'sub/unknown.safetensors')
    const shadowModel = catalog.models.find((model) => model.name === 'shadow.safetensors')
    assert.ok(styleModel && unknownModel && shadowModel)
    const compatible = await requestJson(bridge, '/api/workflow-center/loras/inspect', {
      method: 'POST',
      body: JSON.stringify({ modelId: styleModel.id, expectedFamily: 'qwen-image-edit' }),
    })
    assert.equal(compatible.inspection.family, 'qwen-image-edit')
    assert.equal(compatible.inspection.compatibility, 'compatible')
    const wrongFamily = await requestJson(bridge, '/api/workflow-center/loras/inspect', {
      method: 'POST',
      body: JSON.stringify({ modelId: styleModel.id, expectedFamily: 'sd15' }),
    })
    assert.equal(wrongFamily.inspection.compatibility, 'incompatible')
    const unknown = await requestJson(bridge, '/api/workflow-center/loras/inspect', {
      method: 'POST',
      body: JSON.stringify({ modelId: unknownModel.id, expectedFamily: 'qwen-image-edit' }),
    })
    assert.equal(unknown.inspection.compatibility, 'unverified')
    const rejectedUnknown = await requestJson(bridge, '/api/workflow-center/loras/bindings', {
      method: 'POST',
      body: JSON.stringify({ modelId: unknownModel.id, role: 'character', expectedFamily: 'qwen-image-edit', strength: 1 }),
    }, 409)
    assert.equal(rejectedUnknown.error.code, 'LORA_COMPATIBILITY_UNVERIFIED')
    report.checks.inspect = { compatible: true, wrongFamily: wrongFamily.inspection.compatibility, unknown: unknown.inspection.compatibility }

    const saved = await requestJson(bridge, '/api/workflow-center/loras/bindings', {
      method: 'POST',
      body: JSON.stringify({
        modelId: styleModel.id,
        role: 'character',
        expectedFamily: 'qwen-image-edit',
        strength: 1,
        triggerWords: ['青色角色'],
      }),
    }, 201)
    assert.deepEqual(saved.binding.triggerWords, ['青色角色'])
    const resolved = await requestJson(bridge, '/api/workflow-center/loras/bindings/' + encodeURIComponent(saved.binding.id) + '/resolve', {
      method: 'POST',
      body: JSON.stringify({ family: 'qwen-image-edit' }),
    })
    assert.equal(resolved.binding.sha256, saved.binding.sha256)
    report.checks.binding = { role: saved.binding.role, family: saved.binding.family, triggerWords: saved.binding.triggerWords }

    const imported = await requestJson(bridge, '/api/workflow-center/custom', {
      method: 'POST',
      body: JSON.stringify({
        title: 'LoRA 受控 Qwen 夹具工作流',
        workflow: qwenWorkflow('sub/style.safetensors'),
        mappings: qwenMappings(),
      }),
    }, 201)
    await requestJson(bridge, '/api/workflow-center/custom/' + encodeURIComponent(imported.customWorkflow.id) + '/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
    const recipeInput = {
      name: 'LoRA 夹具配方',
      workflowId: imported.customWorkflow.id,
      workflowHash: imported.customWorkflow.hash,
      mappingHash: imported.customWorkflow.mappingHash,
      parameters: { loraStrength: 1 },
      loraBindings: [saved.binding],
    }
    const recipe = await requestJson(bridge, '/api/workflow-center/recipes', {
      method: 'POST',
      body: JSON.stringify(recipeInput),
    }, 201)
    assert.equal(recipe.recipe.loraBindings[0].id, saved.binding.id)
    const resolvedRecipe = await requestJson(bridge, '/api/workflow-center/recipes/' + encodeURIComponent(recipe.recipe.id) + '/resolve', {
      method: 'POST',
      body: '{}',
    })
    assert.equal(resolvedRecipe.recipe.loraBindings[0].sha256, saved.binding.sha256)

    const jobResponse = await requestJson(bridge, '/api/jobs/custom-workflow', {
      method: 'POST',
      headers: { 'idempotency-key': 'lora-bindings-fixture-job-001' },
      body: JSON.stringify({
        customWorkflowId: imported.customWorkflow.id,
        projectId: 'project-lora-qa',
        title: 'LoRA 夹具输出',
        prompt: 'fixture prompt',
        loraStrength: 1,
        loraBindings: [saved.binding],
      }),
    }, 202)
    const fixtureJob = await waitForTerminal(bridge, jobResponse.job.id)
    assert.equal(fixtureJob.status, 'failed', JSON.stringify(fixtureJob.error || fixtureJob))
    assert.equal(fixtureJob.error.code, 'WORKFLOW_WEIGHT_MISSING')
    assert.equal(comfy.prompts.size, 0)
    report.checks.recipeAndJob = { recipeIdPresent: true, jobStatus: fixtureJob.status, loraVerifiedBeforeBaseGate: true, gpuWakeAvoided: true }
    if (process.argv.includes('--ui')) report.browser = await runUiGate(bridge, comfy)
    const promptsBeforeMutation = comfy.prompts.size

    const changedBytes = await readFile(fixture.styleFile)
    changedBytes[changedBytes.length - 1] ^= 1
    await writeFile(fixture.styleFile, changedBytes)
    const changedResolve = await requestJson(bridge, '/api/workflow-center/loras/bindings/' + encodeURIComponent(saved.binding.id) + '/resolve', {
      method: 'POST',
      body: JSON.stringify({ family: 'qwen-image-edit' }),
    }, 409)
    assert.equal(changedResolve.error.code, 'LORA_SHA256_MISMATCH')
    const changedRecipe = await requestJson(bridge, '/api/workflow-center/recipes', {
      method: 'POST',
      body: JSON.stringify({ ...recipeInput, name: '变更文件后拒绝配方' }),
    }, 409)
    assert.equal(changedRecipe.error.code, 'LORA_SHA256_MISMATCH')
    const changedJob = await requestJson(bridge, '/api/jobs/custom-workflow', {
      method: 'POST',
      headers: { 'idempotency-key': 'lora-bindings-fixture-job-changed-001' },
      body: JSON.stringify({
        customWorkflowId: imported.customWorkflow.id,
        projectId: 'project-lora-qa',
        title: '变更文件后拒绝任务',
        prompt: 'fixture prompt',
        loraStrength: 1,
        loraBindings: [saved.binding],
      }),
    }, 409)
    assert.equal(changedJob.error.code, 'LORA_SHA256_MISMATCH')
    assert.equal(comfy.prompts.size, promptsBeforeMutation)
    report.checks.changedFile = { resolve: changedResolve.error.code, recipe: changedRecipe.error.code, job: changedJob.error.code, gpuWakeAvoided: true }

    const shadowSaved = await requestJson(bridge, '/api/workflow-center/loras/bindings', {
      method: 'POST',
      body: JSON.stringify({ modelId: shadowModel.id, role: 'style', expectedFamily: 'qwen-image-edit', strength: 1 }),
    }, 201)
    const shadowWorkflow = await requestJson(bridge, '/api/workflow-center/custom', {
      method: 'POST',
      body: JSON.stringify({
        title: '同名根目录遮蔽工作流',
        workflow: qwenWorkflow('shadow.safetensors'),
        mappings: qwenMappings(),
      }),
    }, 201)
    await requestJson(bridge, '/api/workflow-center/custom/' + encodeURIComponent(shadowWorkflow.customWorkflow.id) + '/enabled', {
      method: 'POST',
      body: JSON.stringify({ enabled: true }),
    })
    const shadowRecipe = await requestJson(bridge, '/api/workflow-center/recipes', {
      method: 'POST',
      body: JSON.stringify({
        name: '同名根拒绝',
        workflowId: shadowWorkflow.customWorkflow.id,
        workflowHash: shadowWorkflow.customWorkflow.hash,
        mappingHash: shadowWorkflow.customWorkflow.mappingHash,
        parameters: { loraStrength: 1 },
        loraBindings: [shadowSaved.binding],
      }),
    }, 409)
    assert.equal(shadowRecipe.error.code, 'CUSTOM_WORKFLOW_LORA_NAME_AMBIGUOUS')
    report.checks.sameNameRoots = { rejected: shadowRecipe.error.code }
    report.status = 'passed'
  } finally {
    await bridge.stop({ keepRuntime: false }).catch(() => {})
    await comfy.close().catch(() => {})
    if (!keepFixture) await rm(fixture.root, { recursive: true, force: true }).catch(() => {})
  }
  return report
}

async function runUiGate(bridge, comfy) {
  const { chromium } = await import('playwright')
  const executablePath = process.platform === 'win32'
    ? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
    : undefined
  const browser = await chromium.launch({
    headless: true,
    ...(executablePath && existsSync(executablePath) ? { executablePath } : {}),
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const issues = []
  page.on('pageerror', (error) => issues.push('pageerror: ' + error.message))
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') issues.push(message.type() + ': ' + message.text())
  })
  page.on('response', (response) => {
    if (response.status() >= 400) issues.push('http ' + response.status() + ': ' + response.url())
  })
  try {
    await page.goto(bridge.baseUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 })
    await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '打开工作流中心', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: '工作流中心' })
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: /LoRA 受控 Qwen 夹具工作流/u }).click()
    await dialog.getByRole('tab', { name: 'LoRA 与参考配方', exact: true }).click()
    const loraPanel = dialog.locator('.aq-lora-bindings')
    await loraPanel.getByRole('heading', { name: '导入与配方绑定', exact: true }).waitFor({ state: 'visible' })
    await loraPanel.getByRole('button', { name: /sub\/style\.safetensors/u }).click()
    await loraPanel.getByLabel('目标底模家族').selectOption('qwen-image-edit')
    await loraPanel.getByLabel('登记角色').selectOption('character')
    await loraPanel.getByLabel('模型强度').fill('1')
    await loraPanel.getByLabel('触发词（可选，用逗号或换行分隔）').fill('青色角色')
    await loraPanel.getByRole('button', { name: '检查兼容性', exact: true }).click()
    await loraPanel.getByText('格式与家族匹配', { exact: true }).waitFor({ state: 'visible' })
    await loraPanel.getByRole('button', { name: '保存绑定', exact: true }).click()
    await loraPanel.getByText(/LoRA已登记/u).waitFor({ state: 'visible' })
    const resolveButton = loraPanel.getByRole('button', { name: '复核并用于配方', exact: true }).first()
    await resolveButton.click()
    await dialog.getByText(/LoRA 身份与参数已带入当前配方/u).waitFor({ state: 'visible' })
    await dialog.getByLabel('配方名称').fill('UI LoRA 配方')
    await dialog.getByRole('button', { name: '保存配方', exact: true }).click()
    await dialog.getByText(/配方已保存/u).waitFor({ state: 'visible' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: '项目中心', exact: true }).waitFor({ state: 'visible' })
    await page.getByRole('button', { name: '打开工作流中心', exact: true }).first().click()
    await dialog.getByRole('tab', { name: /我的配方/u }).click()
    await dialog.getByRole('heading', { name: 'UI LoRA 配方', exact: true }).waitFor({ state: 'visible' })
    await dialog.locator('.aq-workflow-recipe-card').filter({ hasText: 'UI LoRA 配方' }).getByRole('button', { name: '应用配方', exact: true }).click()
    const runner = dialog.getByRole('region', { name: '自定义工作流运行面板' })
    await runner.waitFor({ state: 'visible' })
    assert.ok(await runner.getByLabel('当前 LoRA 绑定').count())
    await runner.getByLabel('所属项目 *').selectOption('project-lora-qa')
    await runner.getByLabel('输出名称 *').fill('UI LoRA 夹具输出')
    await runner.getByLabel('正向提示词 *').fill('fixture prompt')
    await runner.getByRole('button', { name: '提交统一任务', exact: true }).click()
    await runner.getByText(/执行失败|尚未安装|失败/u).first().waitFor({ state: 'visible', timeout: 20_000 })
    assert.equal(await runner.getByRole('link', { name: '打开不可变输出', exact: true }).count(), 0)
    await page.screenshot({ path: join(qaRoot, 'lora-bindings-ui-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.equal(await page.locator('body').evaluate((body) => body.scrollWidth <= body.clientWidth), true)
    await page.screenshot({ path: join(qaRoot, 'lora-bindings-ui-mobile.png'), fullPage: true })
    assert.deepEqual(issues, [])
    assert.equal(comfy.prompts.size, 0)
    return { status: 'passed', issues: [], desktop: true, mobile: true, jobSubmitted: true, gpuWakeAvoided: true }
  } finally {
    await page.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

async function main() {
  let report
  try {
    report = await runApiGate()
  } catch (error) {
    report = {
      schemaVersion: 1,
      kind: 'lora-bindings-api-contract',
      qualityScope: 'fixture-contract-only; no model quality claim',
      status: 'failed',
      error: error?.message || String(error),
      gpu: { started: false, used: false },
    }
    throw error
  } finally {
    await mkdir(qaRoot, { recursive: true })
    await writeFile(reportPath, JSON.stringify(report || { status: 'failed' }, null, 2) + '\n', 'utf8')
  }
  console.log('✓ LoRA API binding contract passed; fixture-only, no model quality claim')
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
