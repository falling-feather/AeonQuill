import {
  PIXEL_TILE_NEIGHBORS,
  assertPixelDocument,
  createSpriteSheetLayout,
  renderPixelAnimationClipRgba,
  renderPixelFrameRgba,
  resolvePixelAnimationSequences,
} from './pixelCore.mjs'
import { createPixelExportBundle, safePixelFilename } from './pixelConversion.mjs'

export const PIXEL_DIRECTIONS = Object.freeze([
  Object.freeze({ id: 'south', label: '南' }),
  Object.freeze({ id: 'south-west', label: '西南' }),
  Object.freeze({ id: 'west', label: '西' }),
  Object.freeze({ id: 'north-west', label: '西北' }),
  Object.freeze({ id: 'north', label: '北' }),
  Object.freeze({ id: 'north-east', label: '东北' }),
  Object.freeze({ id: 'east', label: '东' }),
  Object.freeze({ id: 'south-east', label: '东南' }),
])

export const PIXEL_TERRAIN_GRID_SIZE = 3

export const PIXEL_TERRAIN_GRID_PRESETS = Object.freeze([
  Object.freeze({
    id: 'island',
    label: '孤岛',
    occupancy: Object.freeze([false, false, false, false, true, false, false, false, false]),
  }),
  Object.freeze({
    id: 'corridor',
    label: '横向',
    occupancy: Object.freeze([false, false, false, true, true, true, false, false, false]),
  }),
  Object.freeze({
    id: 'corner',
    label: '转角',
    occupancy: Object.freeze([false, true, true, false, true, true, false, false, false]),
  }),
  Object.freeze({
    id: 'solid',
    label: '全满',
    occupancy: Object.freeze([true, true, true, true, true, true, true, true, true]),
  }),
])

const TERRAIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/
const TERRAIN_GRID_CELLS = Object.freeze(Array.from({ length: PIXEL_TERRAIN_GRID_SIZE ** 2 }, (_, index) => Object.freeze({
  index,
  row: Math.floor(index / PIXEL_TERRAIN_GRID_SIZE),
  column: index % PIXEL_TERRAIN_GRID_SIZE,
})))
const TERRAIN_NEIGHBOR_OFFSETS = Object.freeze([
  Object.freeze({ id: 'north', row: -1, column: 0, gateIds: [] }),
  Object.freeze({ id: 'north-east', row: -1, column: 1, gateIds: ['north', 'east'] }),
  Object.freeze({ id: 'east', row: 0, column: 1, gateIds: [] }),
  Object.freeze({ id: 'south-east', row: 1, column: 1, gateIds: ['south', 'east'] }),
  Object.freeze({ id: 'south', row: 1, column: 0, gateIds: [] }),
  Object.freeze({ id: 'south-west', row: 1, column: -1, gateIds: ['south', 'west'] }),
  Object.freeze({ id: 'west', row: 0, column: -1, gateIds: [] }),
  Object.freeze({ id: 'north-west', row: -1, column: -1, gateIds: ['north', 'west'] }),
])
const TERRAIN_BIT_BY_ID = new Map(PIXEL_TILE_NEIGHBORS.map((neighbor) => [neighbor.id, neighbor.bit]))
const TERRAIN_OFFSET_BY_ID = new Map(TERRAIN_NEIGHBOR_OFFSETS.map((neighbor) => [neighbor.id, neighbor]))

export class PixelGamePipelineError extends Error {
  constructor(code, message, details) {
    super(message)
    this.name = 'PixelGamePipelineError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function fail(code, message, details) {
  throw new PixelGamePipelineError(code, message, details)
}

function assertRecord(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_OBJECT', `${path} must be an object`)
  return value
}

function assertKnownFields(value, allowed, path) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail('UNKNOWN_FIELD', `${path}.${key} is not allowed`)
  }
}

function assertInteger(value, path, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail('INVALID_INTEGER', `${path} must be an integer between ${min} and ${max}`, { path, value })
  }
  return value
}

function assertFrameId(frameIds, value, path) {
  if (typeof value !== 'string' || !frameIds.has(value)) fail('UNKNOWN_FRAME', `${path} must reference an existing frame`, { path, value })
  return value
}

function assertTerrainId(value, path) {
  if (typeof value !== 'string' || !TERRAIN_ID_PATTERN.test(value)) {
    fail('INVALID_TERRAIN_ID', `${path} must be a stable terrain id`, { path, value })
  }
  return value
}

function assertTerrainOccupancy(value, path) {
  if (!Array.isArray(value) || value.length !== TERRAIN_GRID_CELLS.length || value.some((entry) => typeof entry !== 'boolean')) {
    fail('INVALID_TERRAIN_OCCUPANCY', `${path} must contain exactly nine booleans`)
  }
  return [...value]
}

function terrainGridOccupied(occupancy, row, column) {
  if (row < 0 || column < 0 || row >= PIXEL_TERRAIN_GRID_SIZE || column >= PIXEL_TERRAIN_GRID_SIZE) return false
  return occupancy[row * PIXEL_TERRAIN_GRID_SIZE + column]
}

function inferTerrainCellBitmask(occupancy, row, column) {
  let bitmask = 0
  for (const neighbor of TERRAIN_NEIGHBOR_OFFSETS) {
    if (!terrainGridOccupied(occupancy, row + neighbor.row, column + neighbor.column)) continue
    const gatesOpen = neighbor.gateIds.every((gateId) => {
      const gate = TERRAIN_OFFSET_BY_ID.get(gateId)
      return terrainGridOccupied(occupancy, row + gate.row, column + gate.column)
    })
    if (gatesOpen) bitmask |= TERRAIN_BIT_BY_ID.get(neighbor.id)
  }
  return bitmask
}

function bitCount8(value) {
  let remaining = value & 0xff
  let count = 0
  while (remaining > 0) {
    remaining &= remaining - 1
    count += 1
  }
  return count
}

export function createPixelTerrainPreviewLayout(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['terrainId', 'occupancy']), 'options')
  const fallbackTerrainId = document.frames.find((frame) => frame.gameplay.tileRule)?.gameplay.tileRule?.terrainId
  const terrainId = assertTerrainId(options.terrainId ?? fallbackTerrainId, 'options.terrainId')
  const occupancy = assertTerrainOccupancy(
    options.occupancy ?? PIXEL_TERRAIN_GRID_PRESETS.at(-1).occupancy,
    'options.occupancy',
  )
  const candidates = document.frames
    .map((frame, frameIndex) => ({ frame, frameIndex }))
    .filter(({ frame }) => frame.gameplay.tileRule?.terrainId === terrainId)
  if (candidates.length === 0) {
    fail('UNKNOWN_TERRAIN', `No frames are registered for terrain ${terrainId}`, { terrainId })
  }
  const cells = TERRAIN_GRID_CELLS.map(({ index, row, column }) => {
    if (!occupancy[index]) {
      return {
        index,
        row,
        column,
        occupied: false,
        expectedBitmask: null,
        frameId: null,
        frameName: null,
        matchedBitmask: null,
        distance: null,
        exact: false,
      }
    }
    const expectedBitmask = inferTerrainCellBitmask(occupancy, row, column)
    const ranked = candidates
      .map(({ frame, frameIndex }) => ({
        frame,
        frameIndex,
        matchedBitmask: frame.gameplay.tileRule.bitmask,
        distance: bitCount8(expectedBitmask ^ frame.gameplay.tileRule.bitmask),
      }))
      .sort((left, right) => (
        left.distance - right.distance
        || left.frameIndex - right.frameIndex
        || left.frame.id.localeCompare(right.frame.id)
      ))
    const match = ranked[0]
    return {
      index,
      row,
      column,
      occupied: true,
      expectedBitmask,
      frameId: match.frame.id,
      frameName: match.frame.name,
      matchedBitmask: match.matchedBitmask,
      distance: match.distance,
      exact: match.distance === 0,
    }
  })
  return {
    schemaVersion: 1,
    kind: 'aeonquill.pixel-terrain-preview',
    sourceDocumentId: document.id,
    sourceRevision: document.revision,
    terrainId,
    grid: { width: PIXEL_TERRAIN_GRID_SIZE, height: PIXEL_TERRAIN_GRID_SIZE },
    tile: { width: document.width, height: document.height },
    occupancy,
    exactCount: cells.filter((cell) => cell.occupied && cell.exact).length,
    fallbackCount: cells.filter((cell) => cell.occupied && !cell.exact).length,
    cells,
  }
}

export function renderPixelTerrainPreviewRgba(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const layout = createPixelTerrainPreviewLayout(document, optionsInput)
  const width = document.width * PIXEL_TERRAIN_GRID_SIZE
  const height = document.height * PIXEL_TERRAIN_GRID_SIZE
  const pixels = new Uint8ClampedArray(width * height * 4)
  const framePixelsById = new Map()
  for (const cell of layout.cells) {
    if (!cell.occupied || cell.frameId === null) continue
    let framePixels = framePixelsById.get(cell.frameId)
    if (!framePixels) {
      framePixels = renderPixelFrameRgba(document, cell.frameId)
      framePixelsById.set(cell.frameId, framePixels)
    }
    for (let sourceRow = 0; sourceRow < document.height; sourceRow += 1) {
      const sourceStart = sourceRow * document.width * 4
      const targetStart = ((cell.row * document.height + sourceRow) * width + cell.column * document.width) * 4
      pixels.set(framePixels.subarray(sourceStart, sourceStart + document.width * 4), targetStart)
    }
  }
  return { pixels, width, height, layout }
}

function defaultMapSize(frameCount) {
  const width = Math.max(1, Math.ceil(Math.sqrt(frameCount)))
  return { width, height: Math.max(1, Math.ceil(frameCount / width)) }
}

export function normalizePixelGameOptions(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set([
    'columns', 'padding', 'spacing', 'baseName', 'directionFrameIds',
    'mapWidth', 'mapHeight', 'mapFrameIds', 'animationName', 'animationTagId',
  ]), 'options')
  const frameIds = new Set(document.frames.map((frame) => frame.id))
  const fallbackMap = defaultMapSize(document.frames.length)
  const columns = assertInteger(options.columns ?? Math.min(4, document.frames.length), 'options.columns', 1, document.frames.length)
  const padding = assertInteger(options.padding ?? 1, 'options.padding', 0, 64)
  const spacing = assertInteger(options.spacing ?? 1, 'options.spacing', 0, 64)
  const mapWidth = assertInteger(options.mapWidth ?? fallbackMap.width, 'options.mapWidth', 1, 256)
  const mapHeight = assertInteger(options.mapHeight ?? fallbackMap.height, 'options.mapHeight', 1, 256)
  const directionInput = options.directionFrameIds === undefined
    ? {}
    : assertRecord(options.directionFrameIds, 'options.directionFrameIds')
  assertKnownFields(directionInput, new Set(PIXEL_DIRECTIONS.map((direction) => direction.id)), 'options.directionFrameIds')
  const directionFrameIds = Object.fromEntries(PIXEL_DIRECTIONS.map((direction, index) => [
    direction.id,
    assertFrameId(frameIds, directionInput[direction.id] ?? document.frames[index % document.frames.length].id, `options.directionFrameIds.${direction.id}`),
  ]))
  let mapFrameIds
  if (options.mapFrameIds === undefined) {
    mapFrameIds = Array.from({ length: mapWidth * mapHeight }, (_, index) => document.frames[index]?.id ?? null)
  } else {
    if (!Array.isArray(options.mapFrameIds) || options.mapFrameIds.length !== mapWidth * mapHeight) {
      fail('INVALID_TILEMAP', 'options.mapFrameIds must match mapWidth × mapHeight')
    }
    mapFrameIds = options.mapFrameIds.map((frameId, index) => (
      frameId === null ? null : assertFrameId(frameIds, frameId, `options.mapFrameIds[${index}]`)
    ))
  }
  const animationName = typeof options.animationName === 'string' && options.animationName.trim()
    ? options.animationName.trim().slice(0, 64)
    : 'default'
  const animationTagId = options.animationTagId ?? document.animationTags[0]?.id ?? null
  if (animationTagId !== null && (
    typeof animationTagId !== 'string'
    || !document.animationTags.some((tag) => tag.id === animationTagId)
  )) {
    fail('UNKNOWN_ANIMATION_TAG', 'options.animationTagId must reference an existing animation tag')
  }
  return {
    columns,
    padding,
    spacing,
    baseName: safePixelFilename(options.baseName ?? document.name),
    directionFrameIds,
    mapWidth,
    mapHeight,
    mapFrameIds,
    animationName,
    animationTagId,
  }
}

export function createPixelGameManifest(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = normalizePixelGameOptions(document, optionsInput)
  const layout = createSpriteSheetLayout(document, {
    columns: options.columns,
    padding: options.padding,
    spacing: options.spacing,
  })
  const cellByFrame = new Map(layout.cells.map((cell) => [cell.frameId, cell]))
  const frames = document.frames.map((frame) => {
    const cell = cellByFrame.get(frame.id)
    return {
      id: frame.id,
      name: frame.name,
      durationMs: frame.durationMs,
      atlas: { x: cell.x, y: cell.y, width: cell.width, height: cell.height },
      anchor: { ...frame.gameplay.anchor },
      collisions: frame.gameplay.collisions.map((collision) => ({ ...collision })),
      tileRule: frame.gameplay.tileRule ? { ...frame.gameplay.tileRule } : null,
    }
  })
  const directions = PIXEL_DIRECTIONS.map((direction) => {
    const frameId = options.directionFrameIds[direction.id]
    return { ...direction, frameId, frameIndex: document.frames.findIndex((frame) => frame.id === frameId) }
  })
  const animationSequences = new Map(resolvePixelAnimationSequences(document).map((sequence) => [sequence.tagId, sequence.frameIds]))
  const animations = document.animationTags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    direction: tag.direction,
    loop: tag.loop,
    frames: animationSequences.get(tag.id).map((frameId) => ({
      id: frameId,
      durationMs: document.frames.find((frame) => frame.id === frameId).durationMs,
    })),
  }))
  const selectedAnimation = options.animationTagId
    ? animations.find((animation) => animation.id === options.animationTagId)
    : null
  const tileIds = new Map(layout.cells.map((cell) => [cell.frameId, cell.index + 1]))
  return {
    schemaVersion: 5,
    kind: 'aeonquill.pixel-game-bundle',
    sourceDocumentId: document.id,
    sourceRevision: document.revision,
    image: `${options.baseName}-sprite-sheet.png`,
    canvas: { width: document.width, height: document.height },
    atlas: {
      width: layout.width,
      height: layout.height,
      columns: layout.columns,
      rows: layout.rows,
      padding: layout.padding,
      spacing: layout.spacing,
    },
    animation: selectedAnimation ?? {
      id: 'default',
      name: options.animationName,
      direction: 'forward',
      loop: true,
      frames: frames.map((frame) => ({ id: frame.id, durationMs: frame.durationMs })),
    },
    animations,
    animationEvents: document.animationEvents.map((event) => ({ ...event })),
    frames,
    directions,
    tilemap: {
      width: options.mapWidth,
      height: options.mapHeight,
      tileWidth: document.width,
      tileHeight: document.height,
      data: options.mapFrameIds.map((frameId) => frameId === null ? 0 : tileIds.get(frameId)),
      frameIds: [...options.mapFrameIds],
    },
    layerGroups: document.layerGroups.map((group) => ({ ...group })),
    layers: document.layers.map((layer) => ({ ...layer })),
    palette: document.palette.map((color) => ({ ...color })),
    paletteCycles: document.paletteCycles.map((cycle) => ({ ...cycle, colorIds: [...cycle.colorIds] })),
  }
}

function createTiledTileset(manifest, baseName) {
  const terrainIds = [...new Set(manifest.frames
    .map((frame) => frame.tileRule?.terrainId)
    .filter(Boolean))]
  const wangBits = [1, 2, 4, 8, 16, 32, 64, 128]
  return {
    columns: manifest.atlas.columns,
    image: manifest.image,
    imageheight: manifest.atlas.height,
    imagewidth: manifest.atlas.width,
    margin: manifest.atlas.padding,
    name: baseName,
    spacing: manifest.atlas.spacing,
    tilecount: manifest.frames.length,
    tileheight: manifest.canvas.height,
    tilewidth: manifest.canvas.width,
    type: 'tileset',
    version: '1.10',
    tiledversion: '1.10.2',
    tiles: manifest.frames.map((frame, index) => ({
      id: index,
      properties: [
        { name: 'frameId', type: 'string', value: frame.id },
        { name: 'anchorX', type: 'int', value: frame.anchor.x },
        { name: 'anchorY', type: 'int', value: frame.anchor.y },
        { name: 'durationMs', type: 'int', value: frame.durationMs },
        ...(frame.tileRule ? [
          { name: 'terrainId', type: 'string', value: frame.tileRule.terrainId },
          { name: 'terrainBitmask', type: 'int', value: frame.tileRule.bitmask },
        ] : []),
      ],
      ...(frame.collisions.length > 0 ? {
        objectgroup: {
          draworder: 'index',
          id: index + 1,
          name: `${frame.name} Collisions`,
          objects: frame.collisions.map((collision, collisionIndex) => ({
            class: collision.type,
            height: collision.height,
            id: collisionIndex + 1,
            name: collision.name,
            rotation: 0,
            type: collision.type,
            visible: true,
            width: collision.width,
            x: collision.x,
            y: collision.y,
            properties: [{ name: 'aeonquillId', type: 'string', value: collision.id }],
          })),
          opacity: 1,
          type: 'objectgroup',
          visible: true,
          x: 0,
          y: 0,
        },
      } : {}),
    })),
    wangsets: terrainIds.map((terrainId) => ({
      name: terrainId,
      tile: -1,
      type: 'mixed',
      colors: [{
        color: '#8A71FF',
        name: terrainId,
        probability: 1,
        tile: -1,
      }],
      wangtiles: manifest.frames.flatMap((frame, tileid) => (
        frame.tileRule?.terrainId === terrainId
          ? [{
              tileid,
              wangid: wangBits.map((bit) => (frame.tileRule.bitmask & bit) === bit ? 1 : 0),
            }]
          : []
      )),
    })),
  }
}

function createTiledMap(manifest, tilesetFilename) {
  return {
    compressionlevel: -1,
    height: manifest.tilemap.height,
    infinite: false,
    layers: [{
      data: [...manifest.tilemap.data],
      height: manifest.tilemap.height,
      id: 1,
      name: 'AEONQUILL Tilemap',
      opacity: 1,
      type: 'tilelayer',
      visible: true,
      width: manifest.tilemap.width,
      x: 0,
      y: 0,
    }],
    nextlayerid: 2,
    nextobjectid: 1,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    tiledversion: '1.10.2',
    tileheight: manifest.tilemap.tileHeight,
    tilesets: [{ firstgid: 1, source: tilesetFilename }],
    tilewidth: manifest.tilemap.tileWidth,
    type: 'map',
    version: '1.10',
    width: manifest.tilemap.width,
  }
}

function safeEmbeddedJson(value) {
  return JSON.stringify(value).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
}

function createViewerHtml(manifest) {
  const data = safeEmbeddedJson(manifest)
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AEONQUILL Pixel Game Preview</title><style>
html{color-scheme:dark;font-family:system-ui,sans-serif;background:#101216;color:#f7f8fb}body{margin:0;padding:24px;display:grid;gap:20px}header{display:flex;justify-content:space-between;align-items:end}h1{font-size:22px;margin:0}small{color:#a1abff}main{display:grid;grid-template-columns:minmax(280px,1fr) minmax(240px,360px);gap:20px}.panel{background:#171a22;border:1px solid #333849;padding:16px}canvas{width:100%;image-rendering:pixelated;background:repeating-conic-gradient(#252936 0 25%,#1d202a 0 50%) 0/24px 24px}button{background:#6d7dff;color:#fff;border:0;padding:9px 12px;cursor:pointer}.directions{display:grid;grid-template-columns:repeat(2,1fr);gap:8px}.directions button{background:#2b3040}.meta{font:12px ui-monospace,monospace;color:#c8ccef;white-space:pre-wrap}@media(max-width:720px){main{grid-template-columns:1fr}}
</style></head><body><header><div><small>AEONQUILL / PIXEL</small><h1>游戏资产交付预览</h1></div><button id="play">暂停动画</button></header><main><section class="panel"><canvas id="view"></canvas></section><aside class="panel"><div class="directions" id="directions"></div><p class="meta" id="meta"></p></aside></main>
<script>
const manifest=${data};
const image=new Image();image.src=manifest.image;
const canvas=document.querySelector('#view');const ctx=canvas.getContext('2d');ctx.imageSmoothingEnabled=false;
canvas.width=manifest.canvas.width;canvas.height=manifest.canvas.height;
let playing=true,index=0,last=0,manual=null;
const frames=new Map(manifest.frames.map(f=>[f.id,f]));
const collisionColors={solid:'#FFB020',hitbox:'#FF4D6D',hurtbox:'#4CC9F0',interaction:'#6EE7B7'};
function draw(frame){
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.drawImage(image,frame.atlas.x,frame.atlas.y,frame.atlas.width,frame.atlas.height,0,0,canvas.width,canvas.height);
  frame.collisions.forEach(shape=>{ctx.strokeStyle=collisionColors[shape.type]||'#FFFFFF';ctx.lineWidth=.6;ctx.strokeRect(shape.x+.3,shape.y+.3,Math.max(.4,shape.width-.6),Math.max(.4,shape.height-.6));});
  const ax=Math.min(canvas.width-.25,Math.max(.25,frame.anchor.x));const ay=Math.min(canvas.height-.25,Math.max(.25,frame.anchor.y));
  ctx.strokeStyle='#B596FF';ctx.lineWidth=.5;ctx.beginPath();ctx.moveTo(Math.max(0,ax-1.5),ay);ctx.lineTo(Math.min(canvas.width,ax+1.5),ay);ctx.moveTo(ax,Math.max(0,ay-1.5));ctx.lineTo(ax,Math.min(canvas.height,ay+1.5));ctx.stroke();
  const tile=frame.tileRule?'\\nTerrain '+frame.tileRule.terrainId+' · mask '+frame.tileRule.bitmask:'\\nTerrain 未设置';
  const events=manifest.animationEvents.filter(event=>event.animationTagId===manifest.animation.id&&event.frameId===frame.id);
  const eventText=events.length?'\\n事件 '+events.map(event=>event.name+' ['+event.type+']'+(event.value?' = '+event.value:'')).join(' / '):'\\n事件 无';
  const activeCycles=manifest.paletteCycles.filter(cycle=>cycle.enabled);
  const cycleText='\\n调色板循环 '+(activeCycles.length?activeCycles.map(cycle=>cycle.name+' · '+cycle.direction+' · '+cycle.stepDurationMs+'ms').join(' / '):'无');
  document.querySelector('#meta').textContent=frame.name+' · '+frame.durationMs+'ms\\n锚点 '+frame.anchor.x+','+frame.anchor.y+'\\n碰撞区 '+frame.collisions.length+tile+eventText+cycleText+'\\n图块 '+manifest.tilemap.width+'×'+manifest.tilemap.height;
}
function loop(now){const seq=manifest.animation.frames;if(image.complete&&seq.length){const ref=manual?frames.get(manual):frames.get(seq[index].id);draw(ref);if(playing&&!manual&&now-last>=seq[index].durationMs){last=now;index=(index+1)%seq.length;}}requestAnimationFrame(loop)}
document.querySelector('#play').onclick=e=>{playing=!playing;manual=null;e.target.textContent=playing?'暂停动画':'播放动画'};
const list=document.querySelector('#directions');manifest.directions.forEach(d=>{const b=document.createElement('button');b.textContent=d.label;b.onclick=()=>{manual=d.frameId;playing=false;document.querySelector('#play').textContent='播放动画'};list.append(b)});
image.onload=()=>requestAnimationFrame(loop);
</script></body></html>`
}

export function createPixelGameExportBundle(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = normalizePixelGameOptions(document, optionsInput)
  const base = createPixelExportBundle(document, {
    columns: options.columns,
    padding: options.padding,
    spacing: options.spacing,
    baseName: options.baseName,
  })
  const manifest = createPixelGameManifest(document, options)
  const tilesetFilename = `${options.baseName}-tileset.tsj`
  const mapFilename = `${options.baseName}-tilemap.tmj`
  const manifestText = JSON.stringify(manifest, null, 2)
  return {
    project: base.project,
    sprite: base.sprite,
    manifest: {
      filename: `${options.baseName}-game-manifest.json`,
      mime: 'application/json',
      text: manifestText,
      value: manifest,
    },
    tiledTileset: {
      filename: tilesetFilename,
      mime: 'application/json',
      text: JSON.stringify(createTiledTileset(manifest, options.baseName), null, 2),
    },
    tiledMap: {
      filename: mapFilename,
      mime: 'application/json',
      text: JSON.stringify(createTiledMap(manifest, tilesetFilename), null, 2),
    },
    viewer: {
      filename: `${options.baseName}-preview.html`,
      mime: 'text/html',
      text: createViewerHtml(manifest),
    },
  }
}

export function createPixelAnimationClipExportBundle(documentInput, tagId, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['columns', 'padding', 'spacing', 'baseName']), 'options')
  const tag = document.animationTags.find((item) => item.id === tagId)
  if (!tag) fail('UNKNOWN_ANIMATION_TAG', `Unknown animation tag ${String(tagId)}`)
  const fromIndex = document.frames.findIndex((frame) => frame.id === tag.fromFrameId)
  const toIndex = document.frames.findIndex((frame) => frame.id === tag.toFrameId)
  const uniqueFrameCount = toIndex - fromIndex + 1
  const columns = assertInteger(options.columns ?? Math.min(4, uniqueFrameCount), 'options.columns', 1, uniqueFrameCount)
  const padding = assertInteger(options.padding ?? 1, 'options.padding', 0, 64)
  const spacing = assertInteger(options.spacing ?? 1, 'options.spacing', 0, 64)
  const baseName = safePixelFilename(options.baseName ?? document.name)
  const clipName = `${baseName}-${safePixelFilename(tag.name, tag.id)}-clip`
  const clip = renderPixelAnimationClipRgba(document, tag.id, { columns, padding, spacing })
  return {
    sprite: {
      filename: `${clipName}.png`,
      mime: 'image/png',
      width: clip.layout.width,
      height: clip.layout.height,
      pixels: clip.pixels,
    },
    manifest: {
      filename: `${clipName}.json`,
      mime: 'application/json',
      text: JSON.stringify(clip.metadata, null, 2),
      value: clip.metadata,
    },
  }
}

export function createPixelTerrainPreviewExportBundle(documentInput, optionsInput = {}) {
  const document = assertPixelDocument(documentInput)
  const options = assertRecord(optionsInput, 'options')
  assertKnownFields(options, new Set(['terrainId', 'occupancy', 'baseName']), 'options')
  const rendered = renderPixelTerrainPreviewRgba(document, {
    ...(options.terrainId === undefined ? {} : { terrainId: options.terrainId }),
    ...(options.occupancy === undefined ? {} : { occupancy: options.occupancy }),
  })
  const baseName = safePixelFilename(options.baseName ?? document.name)
  const terrainName = safePixelFilename(rendered.layout.terrainId, 'terrain')
  const previewName = `${baseName}-${terrainName}-terrain-preview`
  const image = `${previewName}.png`
  const metadata = { ...rendered.layout, image }
  return {
    sprite: {
      filename: image,
      mime: 'image/png',
      width: rendered.width,
      height: rendered.height,
      pixels: rendered.pixels,
    },
    manifest: {
      filename: `${previewName}.json`,
      mime: 'application/json',
      text: JSON.stringify(metadata, null, 2),
      value: metadata,
    },
  }
}
