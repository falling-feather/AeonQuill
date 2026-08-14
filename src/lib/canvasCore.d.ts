import type { Camera, CanvasElement } from '../types'

export type CanvasActor = 'user' | 'tool' | 'agent' | 'system'
export type CanvasCommandType =
  | 'elements.add'
  | 'elements.patch'
  | 'elements.remove'
  | 'elements.replace'
  | 'camera.set'
  | 'document.reset'

export type CanvasDocument = {
  schemaVersion: 1
  id: string
  title: string
  revision: number
  createdAt: number
  updatedAt: number
  elements: CanvasElement[]
  camera: Camera
}

export type CanvasCommand = {
  schemaVersion: 1
  id: string
  actor: CanvasActor
  type: CanvasCommandType
  baseRevision: number
  payload: Record<string, unknown>
}

export type CanvasDraft = {
  schemaVersion: 1
  id: string
  baseRevision: number
  commands: CanvasCommand[]
  preview: CanvasDocument
}

export class CanvasContractError extends Error {
  code: string
  details?: unknown
}

export const CANVAS_DOCUMENT_SCHEMA_VERSION: 1
export const CANVAS_COMMAND_SCHEMA_VERSION: 1
export const CANVAS_DRAFT_SCHEMA_VERSION: 1

export function assertCanvasDocument(document: unknown): CanvasDocument
export function createCanvasDocument(input: {
  id?: string
  title?: string
  elements: CanvasElement[]
  camera: Camera
  now?: number
}): CanvasDocument
export function migrateCanvasDocument(input: unknown, options?: {
  now?: number
  id?: string
  title?: string
}): CanvasDocument
export function createCanvasCommand(
  document: CanvasDocument,
  type: CanvasCommandType,
  payload: Record<string, unknown>,
  options?: { id?: string; actor?: CanvasActor },
): CanvasCommand
export function applyCanvasCommand(document: CanvasDocument, command: CanvasCommand, options?: { now?: number }): CanvasDocument
export function applyCanvasTransaction(document: CanvasDocument, commands: CanvasCommand[], options?: { now?: number }): CanvasDocument
export function commitCanvasPreview(
  baseDocument: CanvasDocument,
  previewDocument: CanvasDocument,
  options?: { id?: string; actor?: CanvasActor; now?: number },
): CanvasDocument
export function createCanvasDraft(
  document: CanvasDocument,
  commands: CanvasCommand[],
  options?: { id?: string; now?: number },
): CanvasDraft
export function commitCanvasDraft(document: CanvasDocument, draft: CanvasDraft, options?: { now?: number }): CanvasDocument

export type CanvasToolDefinition = {
  id: string
  title: string
  allowedActors: CanvasActor[]
  validateInput(input: unknown): void
  createPayload(input: Record<string, unknown>): { type: CanvasCommandType; payload: Record<string, unknown> }
}
export type CanvasToolRegistry = {
  get(id: string): CanvasToolDefinition | undefined
  list(): CanvasToolDefinition[]
}

export const canvasToolRegistry: CanvasToolRegistry
export function defineCanvasTool(definition: CanvasToolDefinition): CanvasToolDefinition
export function createCanvasToolRegistry(definitions: CanvasToolDefinition[]): CanvasToolRegistry
export function compileCanvasToolInvocation(
  document: CanvasDocument,
  invocation: { toolId: string; callId: string; actor: CanvasActor; input: Record<string, unknown> },
  registry?: CanvasToolRegistry,
): CanvasCommand
export function executeCanvasTool(
  document: CanvasDocument,
  invocation: { toolId: string; callId: string; actor: CanvasActor; input: Record<string, unknown> },
  options?: { now?: number; registry?: CanvasToolRegistry },
): CanvasDocument
export function cloneCanvasDocument(document: CanvasDocument): CanvasDocument
