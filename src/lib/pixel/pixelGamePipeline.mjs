import { assertPixelDocument, createSpriteSheetLayout, resolvePixelAnimationSequences } from './pixelCore.mjs'
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
    schemaVersion: 4,
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
  document.querySelector('#meta').textContent=frame.name+' · '+frame.durationMs+'ms\\n锚点 '+frame.anchor.x+','+frame.anchor.y+'\\n碰撞区 '+frame.collisions.length+tile+'\\n图块 '+manifest.tilemap.width+'×'+manifest.tilemap.height;
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
