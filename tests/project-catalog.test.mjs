import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ProjectCatalogError,
  addProjectDocument,
  assertProjectCatalog,
  createProjectCatalog,
  createWorkspaceProject,
  deserializeProjectCatalog,
  openWorkspaceProject,
  projectModeDocument,
  purgeExpiredProjects,
  serializeProjectCatalog,
  setProjectStatus,
  touchProjectDocument,
} from '../src/lib/project/projectCatalog.mjs'

function createFixture() {
  return createWorkspaceProject(createProjectCatalog(), {
    title: '光阴砚品牌叙事短片',
    description: '武侠品牌叙事广告',
    color: 'amber',
    initialModeId: 'smart-video',
  }, { now: 1_000, projectId: 'project-brand-film', documentId: 'document-brand-film' })
}

test('project creation establishes one isolated initial mode document', () => {
  const { catalog, project, document } = createFixture()
  assert.equal(catalog.revision, 1)
  assert.equal(project.id, 'project-brand-film')
  assert.equal(project.initialModeId, 'smart-video')
  assert.equal(document.modeId, 'smart-video')
  assert.deepEqual(projectModeDocument(project, 'balanced'), null)
})

test('multiple projects and mode documents never share identifiers', () => {
  let { catalog } = createFixture()
  ;({ catalog } = createWorkspaceProject(catalog, {
    title: '像素素材',
    initialModeId: 'pixel',
  }, { now: 2_000, projectId: 'project-pixel', documentId: 'document-pixel' }))
  const added = addProjectDocument(catalog, 'project-brand-film', {
    modeId: 'balanced',
    title: '主视觉画布',
  }, { now: 3_000, documentId: 'document-brand-canvas' })
  assert.equal(added.catalog.projects.length, 2)
  assert.equal(added.project.documents.length, 2)
  assert.equal(added.catalog.projects[1].documents[0].id, 'document-pixel')
})

test('document updates touch only the owning project', () => {
  const { catalog } = createFixture()
  const updated = touchProjectDocument(catalog, 'project-brand-film', 'document-brand-film', {
    title: '导演版',
    revision: 7,
  }, { now: 4_000 })
  assert.equal(updated.projects[0].documents[0].title, '导演版')
  assert.equal(updated.projects[0].documents[0].revision, 7)
  assert.equal(updated.projects[0].updatedAt, 4_000)
  assert.equal(catalog.projects[0].documents[0].revision, 0)
})

test('archive, trash and restore preserve project documents', () => {
  const { catalog } = createFixture()
  const archived = setProjectStatus(catalog, 'project-brand-film', 'archived', { now: 2_000 })
  const trashed = setProjectStatus(archived, 'project-brand-film', 'trashed', { now: 3_000 })
  assert.equal(trashed.projects[0].trashedAt, 3_000)
  const restored = setProjectStatus(trashed, 'project-brand-film', 'active', { now: 4_000 })
  assert.equal(restored.projects[0].status, 'active')
  assert.equal(restored.projects[0].documents[0].id, 'document-brand-film')
})

test('opening a trashed project fails closed until it is restored explicitly', () => {
  const { catalog } = createFixture()
  const trashed = setProjectStatus(catalog, 'project-brand-film', 'trashed', { now: 2_000 })
  assert.throws(
    () => openWorkspaceProject(trashed, 'project-brand-film', { now: 3_000 }),
    (error) => error instanceof ProjectCatalogError && error.code === 'PROJECT_TRASHED',
  )
  const restored = setProjectStatus(trashed, 'project-brand-film', 'active', { now: 4_000 })
  assert.equal(restored.projects[0].status, 'active')
})

test('trash is retained for 15 days and then purged deterministically', () => {
  const day = 24 * 60 * 60 * 1_000
  const { catalog } = createFixture()
  const trashed = setProjectStatus(catalog, 'project-brand-film', 'trashed', { now: day })
  assert.equal(purgeExpiredProjects(trashed, { now: day * 16 - 1 }).projects.length, 1)
  assert.equal(purgeExpiredProjects(trashed, { now: day * 16 }).projects.length, 0)
})

test('catalog serialization round-trips exactly', () => {
  const { catalog } = createFixture()
  assert.deepEqual(deserializeProjectCatalog(serializeProjectCatalog(catalog)), catalog)
  assert.deepEqual(deserializeProjectCatalog(''), createProjectCatalog())
})

test('unknown fields, malformed ids and cross-project document reuse are rejected', () => {
  const { catalog } = createFixture()
  assert.throws(() => assertProjectCatalog({ ...catalog, hiddenPrompt: 'unsafe' }), /unsupported fields/u)
  assert.throws(() => createWorkspaceProject(catalog, { title: 'x' }, { projectId: '../escape', documentId: 'safe' }), /invalid/u)
  const duplicate = structuredClone(catalog)
  duplicate.projects.push({ ...structuredClone(duplicate.projects[0]), id: 'project-copy' })
  assert.throws(
    () => assertProjectCatalog(duplicate),
    (error) => error instanceof ProjectCatalogError && error.code === 'DUPLICATE_DOCUMENT',
  )
})
