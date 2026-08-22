import {
  Copy,
  Hand,
  Lock,
  Maximize,
  Minus,
  Plus,
  Scan,
  Trash2,
} from 'lucide-react'
import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from 'react'
import type { Camera, CanvasElement, ResizeHandle, ToolId } from '../types'
import {
  boundsIntersect,
  createCanvasSpatialIndex,
  queryCanvasSpatialIndex,
  screenMarqueeRect,
  screenMarqueeWorldBounds,
  selectElementIdsInWorldBounds,
  viewportWorldBounds,
} from '../lib/canvasSpatialIndex.mjs'
import { CanvasElementView } from './CanvasElementView'
import { SelectionToolbar } from './SelectionToolbar'
import { IconButton } from './ui/IconButton'

type Point = { x: number; y: number }

type Gesture =
  | {
      kind: 'pan'
      pointerId: number
      startClient: Point
      camera: Camera
    }
  | {
      kind: 'drag'
      pointerId: number
      startClient: Point
      startElements: CanvasElement[]
      ids: string[]
      moved: boolean
    }
  | {
      kind: 'resize'
      pointerId: number
      startClient: Point
      startElements: CanvasElement[]
      id: string
      handle: ResizeHandle
      moved: boolean
    }
  | {
      kind: 'marquee'
      pointerId: number
      startScreen: Point
      currentScreen: Point
      camera: Camera
    }

type CanvasWorkspaceProps = {
  elements: CanvasElement[]
  selectedIds: string[]
  camera: Camera
  activeTool: ToolId
  viewportRef: RefObject<HTMLDivElement>
  onSelect: (ids: string[]) => void
  onElementsPreview: (elements: CanvasElement[]) => void
  onTransformCommit: (before: CanvasElement[]) => void
  onCameraChange: (camera: Camera) => void
  onToolChange: (tool: ToolId) => void
  onCreateAt: (tool: ToolId, point: Point) => void
  onDeleteSelection: () => void
  onDuplicateSelection: () => void
  onToggleLock: (id: string) => void
  onBringToFront: (id: string) => void
  onOpenPixel: (id: string) => void
  onImageDrop: (file: File, point: Point) => void
}

const resizeHandles: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

export function CanvasWorkspace({
  elements,
  selectedIds,
  camera,
  activeTool,
  viewportRef,
  onSelect,
  onElementsPreview,
  onTransformCommit,
  onCameraChange,
  onToolChange,
  onCreateAt,
  onDeleteSelection,
  onDuplicateSelection,
  onToggleLock,
  onBringToFront,
  onOpenPixel,
  onImageDrop,
}: CanvasWorkspaceProps) {
  const gestureRef = useRef<Gesture | null>(null)
  const cameraFrameRef = useRef<number | null>(null)
  const pendingCameraRef = useRef<Camera | null>(null)
  const spacePressedRef = useRef(false)
  const lastPixelActivationRef = useRef<{ id: string; time: number } | null>(null)
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  const [isDraggingOver, setIsDraggingOver] = useState(false)
  const [viewportSize, setViewportSize] = useState({ width: 900, height: 700 })

  useEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    const observer = new ResizeObserver(([entry]) => {
      setViewportSize({ width: entry.contentRect.width, height: entry.contentRect.height })
    })
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [viewportRef])

  useEffect(() => () => {
    if (cameraFrameRef.current !== null) cancelAnimationFrame(cameraFrameRef.current)
  }, [])

  const scheduleCameraChange = (nextCamera: Camera) => {
    pendingCameraRef.current = nextCamera
    if (cameraFrameRef.current !== null) return
    cameraFrameRef.current = requestAnimationFrame(() => {
      cameraFrameRef.current = null
      const pending = pendingCameraRef.current
      pendingCameraRef.current = null
      if (pending) onCameraChange(pending)
    })
  }

  const flushScheduledCamera = () => {
    if (cameraFrameRef.current !== null) {
      cancelAnimationFrame(cameraFrameRef.current)
      cameraFrameRef.current = null
    }
    const pending = pendingCameraRef.current
    pendingCameraRef.current = null
    if (pending) onCameraChange(pending)
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Space' && !event.repeat) {
        spacePressedRef.current = true
        viewportRef.current?.classList.add('space-pan-ready')
        if (!(event.target instanceof HTMLInputElement) && !(event.target instanceof HTMLTextAreaElement)) {
          event.preventDefault()
        }
      }
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space') {
        spacePressedRef.current = false
        viewportRef.current?.classList.remove('space-pan-ready')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [viewportRef])

  const visibleElements = useMemo(
    () => elements.filter((element) => element.visible),
    [elements],
  )
  const elementsById = useMemo(
    () => new Map(elements.map((element) => [element.id, element])),
    [elements],
  )
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds])
  const connectors = useMemo(
    () => visibleElements.filter((element) => element.kind === 'connector'),
    [visibleElements],
  )
  const regularElements = useMemo(
    () => visibleElements
      .filter((element) => element.kind !== 'connector')
      .sort((a, b) => a.zIndex - b.zIndex),
    [visibleElements],
  )
  const miniMapElements = useMemo(
    () => regularElements.filter((element) => element.id !== 'canvas-background'),
    [regularElements],
  )
  const spatialIndex = useMemo(
    () => createCanvasSpatialIndex(regularElements),
    [regularElements],
  )
  const viewportBounds = useMemo(
    () => viewportWorldBounds(camera, viewportSize, 240),
    [camera, viewportSize],
  )
  const queriedIds = useMemo(
    () => queryCanvasSpatialIndex(spatialIndex, viewportBounds),
    [spatialIndex, viewportBounds],
  )
  const renderedRegularElements = useMemo(() => {
    const ids = new Set(queriedIds)
    ids.add('canvas-background')
    for (const id of selectedIds) ids.add(id)
    return [...ids]
      .map((id) => elementsById.get(id))
      .filter((element): element is CanvasElement => Boolean(element && element.visible && element.kind !== 'connector'))
      .sort((a, b) => a.zIndex - b.zIndex)
  }, [elementsById, queriedIds, selectedIds])
  const renderedIdSet = useMemo(
    () => new Set(renderedRegularElements.map((element) => element.id)),
    [renderedRegularElements],
  )
  const renderedConnectors = useMemo(
    () => connectors.filter((connector) => {
      const from = elementsById.get(connector.fromId ?? '')
      const to = elementsById.get(connector.toId ?? '')
      if (!from || !to) return false
      if (renderedIdSet.has(from.id) || renderedIdSet.has(to.id)) return true
      const x1 = from.x + from.width
      const y1 = from.y + from.height / 2
      const x2 = to.x
      const y2 = to.y + to.height / 2
      const curve = Math.max(60, Math.abs(x2 - x1) * 0.42)
      return boundsIntersect({
        left: Math.min(x1, x1 + curve, x2 - curve, x2),
        top: Math.min(y1, y2),
        right: Math.max(x1, x1 + curve, x2 - curve, x2),
        bottom: Math.max(y1, y2),
      }, viewportBounds)
    }),
    [connectors, elementsById, renderedIdSet, viewportBounds],
  )

  const screenToWorld = (clientX: number, clientY: number): Point => {
    const rect = viewportRef.current?.getBoundingClientRect()
    if (!rect) return { x: 0, y: 0 }
    return {
      x: (clientX - rect.left - camera.x) / camera.zoom,
      y: (clientY - rect.top - camera.y) / camera.zoom,
    }
  }

  const screenPoint = (clientX: number, clientY: number): Point => {
    const rect = viewportRef.current?.getBoundingClientRect()
    return { x: clientX - (rect?.left ?? 0), y: clientY - (rect?.top ?? 0) }
  }

  const beginPan = (event: ReactPointerEvent) => {
    gestureRef.current = {
      kind: 'pan',
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      camera: { ...camera },
    }
    viewportRef.current?.setPointerCapture(event.pointerId)
    viewportRef.current?.classList.add('is-panning')
  }

  const handleViewportPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return
    const target = event.target as HTMLElement
    if (target.closest('[data-canvas-element]') || target.closest('[data-ui-overlay]')) return

    if (event.button === 1 || activeTool === 'pan' || spacePressedRef.current) {
      event.preventDefault()
      beginPan(event)
      return
    }

    if (activeTool !== 'select') {
      const point = screenToWorld(event.clientX, event.clientY)
      onCreateAt(activeTool, point)
      return
    }

    const start = screenPoint(event.clientX, event.clientY)
    const interactionCamera = pendingCameraRef.current ?? camera
    flushScheduledCamera()
    gestureRef.current = {
      kind: 'marquee',
      pointerId: event.pointerId,
      startScreen: start,
      currentScreen: start,
      camera: interactionCamera,
    }
    setMarquee(screenMarqueeRect(start, start))
    onSelect([])
    viewportRef.current?.setPointerCapture(event.pointerId)
  }

  const handleNodePointerDown = (event: ReactPointerEvent, element: CanvasElement) => {
    if (event.button !== 0 && event.button !== 1) return
    event.stopPropagation()
    if (event.button === 1 || activeTool === 'pan' || spacePressedRef.current) {
      beginPan(event)
      return
    }
    if (activeTool !== 'select') return

    if (element.kind === 'pixel') {
      const now = Date.now()
      const previous = lastPixelActivationRef.current
      lastPixelActivationRef.current = { id: element.id, time: now }
      if (previous?.id === element.id && now - previous.time < 420) {
        lastPixelActivationRef.current = null
        onOpenPixel(element.id)
        return
      }
    }

    let nextSelection = selectedIds
    if (event.shiftKey) {
      nextSelection = selectedIds.includes(element.id)
        ? selectedIds.filter((id) => id !== element.id)
        : [...selectedIds, element.id]
    } else if (!selectedIds.includes(element.id)) {
      nextSelection = [element.id]
    }
    onSelect(nextSelection)

    if (element.locked || !nextSelection.includes(element.id)) return
    gestureRef.current = {
      kind: 'drag',
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startElements: elements,
      ids: nextSelection,
      moved: false,
    }
    viewportRef.current?.setPointerCapture(event.pointerId)
  }

  const handleResizePointerDown = (
    event: ReactPointerEvent,
    element: CanvasElement,
    handle: ResizeHandle,
  ) => {
    event.preventDefault()
    event.stopPropagation()
    if (element.locked) return
    gestureRef.current = {
      kind: 'resize',
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startElements: elements,
      id: element.id,
      handle,
      moved: false,
    }
    viewportRef.current?.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return

    if (gesture.kind === 'pan') {
      scheduleCameraChange({
        ...gesture.camera,
        x: gesture.camera.x + event.clientX - gesture.startClient.x,
        y: gesture.camera.y + event.clientY - gesture.startClient.y,
      })
      return
    }

    if (gesture.kind === 'drag') {
      const dx = (event.clientX - gesture.startClient.x) / camera.zoom
      const dy = (event.clientY - gesture.startClient.y) / camera.zoom
      gesture.moved = gesture.moved || Math.abs(dx) + Math.abs(dy) > 1
      const movingIds = new Set(gesture.ids)
      const next = gesture.startElements.map((element) =>
        movingIds.has(element.id) && !element.locked
          ? { ...element, x: Math.round(element.x + dx), y: Math.round(element.y + dy) }
          : element,
      )
      onElementsPreview(next)
      return
    }

    if (gesture.kind === 'resize') {
      const dx = (event.clientX - gesture.startClient.x) / camera.zoom
      const dy = (event.clientY - gesture.startClient.y) / camera.zoom
      gesture.moved = gesture.moved || Math.abs(dx) + Math.abs(dy) > 1
      const next = gesture.startElements.map((element) => {
        if (element.id !== gesture.id) return element
        const resized = { ...element }
        const minWidth = element.kind === 'text' ? 80 : 48
        const minHeight = element.kind === 'text' ? 36 : 48
        if (gesture.handle.includes('e')) resized.width = Math.max(minWidth, element.width + dx)
        if (gesture.handle.includes('s')) resized.height = Math.max(minHeight, element.height + dy)
        if (gesture.handle.includes('w')) {
          resized.width = Math.max(minWidth, element.width - dx)
          resized.x = element.x + element.width - resized.width
        }
        if (gesture.handle.includes('n')) {
          resized.height = Math.max(minHeight, element.height - dy)
          resized.y = element.y + element.height - resized.height
        }
        return {
          ...resized,
          x: Math.round(resized.x),
          y: Math.round(resized.y),
          width: Math.round(resized.width),
          height: Math.round(resized.height),
        }
      })
      onElementsPreview(next)
      return
    }

    const current = screenPoint(event.clientX, event.clientY)
    gesture.currentScreen = current
    setMarquee(screenMarqueeRect(gesture.startScreen, current))
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (!gesture || gesture.pointerId !== event.pointerId) return
    if ((gesture.kind === 'drag' || gesture.kind === 'resize') && gesture.moved) {
      onTransformCommit(gesture.startElements)
    }
    if (gesture.kind === 'marquee') {
      const bounds = screenMarqueeWorldBounds(
        gesture.startScreen,
        gesture.currentScreen,
        gesture.camera,
      )
      if (bounds.right - bounds.left > 3 || bounds.bottom - bounds.top > 3) {
        onSelect(selectElementIdsInWorldBounds(visibleElements, bounds))
      }
      setMarquee(null)
    }
    if (gesture.kind === 'pan') viewportRef.current?.classList.remove('is-panning')
    flushScheduledCamera()
    gestureRef.current = null
    if (viewportRef.current?.hasPointerCapture(event.pointerId)) {
      viewportRef.current.releasePointerCapture(event.pointerId)
    }
  }

  const zoomAt = (nextZoom: number, anchor?: Point) => {
    const baseCamera = pendingCameraRef.current ?? camera
    const zoom = clamp(nextZoom, 0.18, 2.4)
    const focus = anchor ?? { x: viewportSize.width / 2, y: viewportSize.height / 2 }
    const worldX = (focus.x - baseCamera.x) / baseCamera.zoom
    const worldY = (focus.y - baseCamera.y) / baseCamera.zoom
    scheduleCameraChange({
      x: focus.x - worldX * zoom,
      y: focus.y - worldY * zoom,
      zoom,
    })
  }

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault()
    if (gestureRef.current) return
    if (event.ctrlKey || event.metaKey) {
      const rect = viewportRef.current?.getBoundingClientRect()
      const anchor = { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
      const baseCamera = pendingCameraRef.current ?? camera
      const zoom = clamp(baseCamera.zoom * Math.exp(-event.deltaY * 0.006), 0.18, 2.4)
      const worldX = (anchor.x - baseCamera.x) / baseCamera.zoom
      const worldY = (anchor.y - baseCamera.y) / baseCamera.zoom
      scheduleCameraChange({
        x: anchor.x - worldX * zoom,
        y: anchor.y - worldY * zoom,
        zoom,
      })
      return
    }
    const baseCamera = pendingCameraRef.current ?? camera
    scheduleCameraChange({
      ...baseCamera,
      x: baseCamera.x - event.deltaX,
      y: baseCamera.y - event.deltaY,
    })
  }

  const fitToContent = () => {
    const nodes = miniMapElements
    if (!nodes.length) return
    const minX = Math.min(...nodes.map((node) => node.x))
    const minY = Math.min(...nodes.map((node) => node.y))
    const maxX = Math.max(...nodes.map((node) => node.x + node.width))
    const maxY = Math.max(...nodes.map((node) => node.y + node.height))
    const contentWidth = maxX - minX
    const contentHeight = maxY - minY
    const padding = 90
    const zoom = clamp(
      Math.min(
        (viewportSize.width - padding * 2) / contentWidth,
        (viewportSize.height - padding * 2) / contentHeight,
      ),
      0.18,
      1,
    )
    scheduleCameraChange({
      zoom,
      x: viewportSize.width / 2 - (minX + contentWidth / 2) * zoom,
      y: viewportSize.height / 2 - (minY + contentHeight / 2) * zoom,
    })
  }

  return (
    <div
      ref={viewportRef}
      className={`canvas-viewport tool-${activeTool} ${isDraggingOver ? 'is-dragging-over' : ''}`}
      style={{
        backgroundPosition: `${camera.x}px ${camera.y}px`,
        backgroundSize: `${24 * camera.zoom}px ${24 * camera.zoom}px`,
      }}
      onPointerDown={handleViewportPointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onWheel={handleWheel}
      onContextMenu={(event) => event.preventDefault()}
      onDragEnter={(event) => {
        event.preventDefault()
        setIsDraggingOver(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setIsDraggingOver(false)
      }}
      onDrop={(event) => {
        event.preventDefault()
        setIsDraggingOver(false)
        const file = [...event.dataTransfer.files].find((candidate) => candidate.type.startsWith('image/'))
        if (file) onImageDrop(file, screenToWorld(event.clientX, event.clientY))
      }}
    >
      <div
        className="canvas-world"
        data-total-elements={regularElements.length}
        data-rendered-elements={renderedRegularElements.length}
        style={{ transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.zoom})` }}
      >
        <svg className="connector-layer" width="2400" height="1600" aria-hidden="true">
          <defs>
            <marker id="connector-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
              <path d="M0,0 L8,4 L0,8 Z" fill="#34363a" />
            </marker>
          </defs>
          {renderedConnectors.map((connector) => {
            const from = elementsById.get(connector.fromId ?? '')
            const to = elementsById.get(connector.toId ?? '')
            if (!from || !to) return null
            const x1 = from.x + from.width
            const y1 = from.y + from.height / 2
            const x2 = to.x
            const y2 = to.y + to.height / 2
            const curve = Math.max(60, Math.abs(x2 - x1) * 0.42)
            return (
              <g key={connector.id} opacity={connector.opacity}>
                <path
                  d={`M${x1} ${y1} C${x1 + curve} ${y1}, ${x2 - curve} ${y2}, ${x2} ${y2}`}
                  fill="none"
                  stroke={connector.stroke}
                  strokeWidth="2"
                  markerEnd="url(#connector-arrow)"
                />
                <circle cx={x1} cy={y1} r="5" fill="#fff" stroke={connector.stroke} strokeWidth="2" />
              </g>
            )
          })}
        </svg>

        {renderedRegularElements.map((element) => {
          const isSelected = selectedIdSet.has(element.id)
          const isPrimarySelected = selectedIds[0] === element.id
          return (
            <div
              key={element.id}
              data-canvas-element
              data-element-id={element.id}
              data-element-kind={element.kind}
              className={`canvas-element kind-${element.kind} ${isSelected ? 'is-selected' : ''} ${element.locked ? 'is-locked' : ''}`}
              style={{
                left: element.x,
                top: element.y,
                width: element.width,
                height: element.height,
                opacity: element.opacity,
                transform: `rotate(${element.rotation}deg)`,
                zIndex: element.zIndex,
                '--element-fill': element.fill,
                '--element-stroke': element.stroke,
                '--element-stroke-width': `${element.strokeWidth ?? 1}px`,
                '--element-radius': `${element.radius}px`,
                pointerEvents: element.id === 'canvas-background' ? 'none' : undefined,
              } as React.CSSProperties}
              onPointerDown={(event) => handleNodePointerDown(event, element)}
            >
              <div className="element-content">
                <CanvasElementView
                  element={element}
                  imageResourceTier={
                    isSelected || Math.max(element.width, element.height) * camera.zoom > 640
                      ? 'preview'
                      : 'thumbnail'
                  }
                />
              </div>

              {isSelected ? (
                <div
                  className="selection-outline"
                  style={{ '--selection-stroke': `${1.7 / camera.zoom}px` } as React.CSSProperties}
                >
                  {selectedIds.length === 1 && !element.locked
                    ? resizeHandles.map((handle) => (
                        <button
                          type="button"
                          key={handle}
                          aria-label={`从 ${handle} 调整大小`}
                          className={`resize-handle handle-${handle}`}
                          style={{
                            '--handle-size': `${10 / camera.zoom}px`,
                            '--handle-border': `${1.6 / camera.zoom}px`,
                          } as React.CSSProperties}
                          onPointerDown={(event) => handleResizePointerDown(event, element, handle)}
                        />
                      ))
                    : null}
                </div>
              ) : null}

              {isPrimarySelected && selectedIds.length === 1 ? (
                <SelectionToolbar
                  element={element}
                  zoom={camera.zoom}
                  onDuplicate={onDuplicateSelection}
                  onToggleLock={() => onToggleLock(element.id)}
                  onBringToFront={() => onBringToFront(element.id)}
                  onDelete={onDeleteSelection}
                />
              ) : null}
            </div>
          )
        })}
      </div>

      {marquee ? <div className="selection-marquee" style={marquee} /> : null}

      <div className="canvas-navigator" data-ui-overlay>
        <MiniMap
          elements={miniMapElements}
          camera={camera}
          viewportSize={viewportSize}
        />
        <div className="navigator-controls">
          <IconButton label="抓手工具" active={activeTool === 'pan'} onClick={() => onToolChange(activeTool === 'pan' ? 'select' : 'pan')}>
            <Hand size={18} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="适应画布" onClick={fitToContent}>
            <Scan size={18} strokeWidth={1.75} />
          </IconButton>
          <span className="zoom-group">
            <IconButton label="缩小" onClick={() => zoomAt(camera.zoom / 1.12)}>
              <Minus size={17} />
            </IconButton>
            <button type="button" className="zoom-value" onClick={() => zoomAt(1)} title="恢复 100%">
              {Math.round(camera.zoom * 100)}%
            </button>
            <IconButton label="放大" onClick={() => zoomAt(camera.zoom * 1.12)}>
              <Plus size={17} />
            </IconButton>
          </span>
        </div>
      </div>

      <div className="drop-message" aria-hidden={!isDraggingOver}>
        <ImageDropGlyph />
        松开以添加图片
      </div>

      <div className="canvas-shortcuts" data-ui-overlay>
        <span><Hand size={13} /> 空格拖动画布</span>
        <span><Maximize size={13} /> Ctrl + 滚轮缩放</span>
        {selectedIds.length ? (
          <>
            <span><Copy size={13} /> Ctrl + D 复制</span>
            <span><Trash2 size={13} /> Delete 删除</span>
            {elementsById.get(selectedIds[0])?.locked ? <span><Lock size={13} /> 元件已锁定</span> : null}
          </>
        ) : null}
      </div>
    </div>
  )
}

type MiniMapGeometry = {
  minX: number
  minY: number
  scale: number
}

const MiniMapDrawing = memo(function MiniMapDrawing({
  elements,
  geometry,
}: {
  elements: CanvasElement[]
  geometry: MiniMapGeometry
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const density = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(154 * density)
    canvas.height = Math.round(132 * density)
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(density, 0, 0, density, 0, 0)
    context.clearRect(0, 0, 154, 132)
    for (const element of elements) {
      const left = (element.x - geometry.minX) * geometry.scale
      const top = (element.y - geometry.minY) * geometry.scale
      const width = Math.max(3, element.width * geometry.scale)
      const height = Math.max(3, element.height * geometry.scale)
      context.fillStyle = element.kind === 'note' ? '#cbb7ff' : element.kind === 'poster' ? '#ff6f61' : '#ffffff'
      context.strokeStyle = 'rgba(109, 112, 122, 0.36)'
      context.lineWidth = 1
      context.fillRect(left, top, width, height)
      context.strokeRect(left + 0.5, top + 0.5, Math.max(0, width - 1), Math.max(0, height - 1))
    }
  }, [elements, geometry])
  return <canvas ref={canvasRef} aria-hidden="true" />
})

function MiniMap({
  elements,
  camera,
  viewportSize,
}: {
  elements: CanvasElement[]
  camera: Camera
  viewportSize: { width: number; height: number }
}) {
  const geometry = useMemo(() => {
    if (!elements.length) return { minX: 0, minY: 0, scale: 1 }
    const minX = Math.min(...elements.map((node) => node.x)) - 80
    const minY = Math.min(...elements.map((node) => node.y)) - 80
    const maxX = Math.max(...elements.map((node) => node.x + node.width)) + 80
    const maxY = Math.max(...elements.map((node) => node.y + node.height)) + 80
    return { minX, minY, scale: Math.min(142 / (maxX - minX), 120 / (maxY - minY)) }
  }, [elements])
  if (!elements.length) return <div className="mini-map" />
  const worldViewport = {
    x: -camera.x / camera.zoom,
    y: -camera.y / camera.zoom,
    width: viewportSize.width / camera.zoom,
    height: viewportSize.height / camera.zoom,
  }
  return (
    <div className="mini-map" aria-label="画布导航预览">
      <MiniMapDrawing elements={elements} geometry={geometry} />
      <i
        style={{
          left: (worldViewport.x - geometry.minX) * geometry.scale,
          top: (worldViewport.y - geometry.minY) * geometry.scale,
          width: worldViewport.width * geometry.scale,
          height: worldViewport.height * geometry.scale,
        }}
      />
    </div>
  )
}

function ImageDropGlyph() {
  return (
    <svg width="34" height="34" viewBox="0 0 34 34" fill="none" aria-hidden="true">
      <rect x="4" y="6" width="26" height="22" rx="4" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="13" r="2.2" fill="currentColor" />
      <path d="M8 24L15 18L19 21L23 16L29 23" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
    </svg>
  )
}
