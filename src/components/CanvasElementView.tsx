import { memo, type CSSProperties } from 'react'
import { AlertTriangle, Film, LoaderCircle, Play, Volume2 } from 'lucide-react'
import { resolveImageResource, type ImageResourceTier } from '../lib/assetVariants'
import { imageAdjustmentFilter } from '../lib/imageProcessing'
import type { CanvasElement } from '../types'

type PixelSpriteProps = {
  pixels: string[]
  palette: string[]
  width?: number
  height?: number
  className?: string
}

export const PixelSprite = memo(function PixelSprite({
  pixels,
  palette,
  width = 12,
  height = 12,
  className = '',
}: PixelSpriteProps) {
  return (
    <div
      className={`pixel-sprite ${className}`}
      aria-hidden="true"
      style={{
        '--pixel-columns': width,
        '--pixel-rows': height,
      } as CSSProperties}
    >
      {pixels.map((colorIndex, index) => (
        <span
          key={index}
          style={{
            background:
              colorIndex === '.' || colorIndex === '0'
                ? 'transparent'
                : palette[Number(colorIndex)] || '#2d2d2f',
          }}
        />
      ))}
    </div>
  )
})

function PosterArt() {
  return (
    <div className="poster-art">
      <div className="poster-copy">
        <h2>像素夏日</h2>
        <p>用像素记录夏天的微小瞬间</p>
        <span className="poster-rule" />
        <div className="poster-meta">
          <strong>VOL.01</strong>
          <span>2024 夏日特辑</span>
        </div>
        <div className="poster-en">PIXEL<br />SUMMER<br />DIARIES</div>
      </div>
      <svg
        className="poster-scene"
        viewBox="0 0 342 455"
        role="img"
        aria-label="像素风夏日海边插画"
        shapeRendering="crispEdges"
      >
        <rect x="86" y="300" width="256" height="155" fill="#fff0d4" />
        <rect x="86" y="312" width="256" height="74" fill="#55bfd3" />
        <rect x="86" y="327" width="256" height="12" fill="#2f9dbd" />
        <rect x="86" y="350" width="256" height="8" fill="#eefcf7" />
        <path d="M86 392L154 365L220 393L276 370L342 392V455H86Z" fill="#ffd479" />
        <path d="M86 411L170 381L238 407L301 383L342 402V455H86Z" fill="#f5b85c" />
        <g fill="#fff5df">
          <rect x="111" y="337" width="35" height="6" />
          <rect x="122" y="331" width="42" height="6" />
          <rect x="197" y="345" width="35" height="6" />
          <rect x="257" y="320" width="54" height="7" />
        </g>
        <g className="palm">
          <path d="M291 151L311 156L289 352L273 350Z" fill="#8c4c37" />
          <path d="M282 151C241 133 222 146 201 170C232 165 258 168 281 180Z" fill="#345d3f" />
          <path d="M284 154C249 116 213 111 188 118C221 132 247 148 277 178Z" fill="#477a4e" />
          <path d="M286 155C278 112 296 88 322 74C311 107 306 132 297 166Z" fill="#355e40" />
          <path d="M289 158C320 121 334 122 342 124V165C324 163 310 168 295 178Z" fill="#477a4e" />
          <path d="M288 159C333 159 339 173 342 181V208C326 191 309 181 287 179Z" fill="#2f563c" />
        </g>
        <g className="pixel-person">
          <rect x="195" y="311" width="54" height="12" fill="#f7c84e" />
          <rect x="185" y="323" width="74" height="10" fill="#e6aa2e" />
          <rect x="195" y="333" width="54" height="10" fill="#2d2d2f" />
          <rect x="199" y="343" width="46" height="40" fill="#ffd0aa" />
          <rect x="205" y="351" width="8" height="8" fill="#2d2d2f" />
          <rect x="232" y="351" width="8" height="8" fill="#2d2d2f" />
          <rect x="190" y="383" width="64" height="50" fill="#f7f4ed" />
          <rect x="181" y="388" width="12" height="41" fill="#ffd0aa" />
          <rect x="252" y="388" width="12" height="41" fill="#ffd0aa" />
          <rect x="198" y="433" width="18" height="22" fill="#ffd0aa" />
          <rect x="229" y="433" width="18" height="22" fill="#ffd0aa" />
          <rect x="191" y="449" width="27" height="6" fill="#2d2d2f" />
          <rect x="227" y="449" width="27" height="6" fill="#2d2d2f" />
        </g>
        <g className="watermelon">
          <path d="M154 366A27 27 0 0 0 208 366Z" fill="#337b4c" />
          <path d="M159 366A22 22 0 0 0 203 366Z" fill="#ff5964" />
          <rect x="174" y="374" width="4" height="7" fill="#422d2c" />
          <rect x="188" y="369" width="4" height="7" fill="#422d2c" />
        </g>
        <g className="sun-icon" fill="#ffe368">
          <rect x="24" y="356" width="20" height="20" />
          <rect x="29" y="344" width="10" height="8" />
          <rect x="29" y="380" width="10" height="8" />
          <rect x="12" y="361" width="8" height="10" />
          <rect x="48" y="361" width="8" height="10" />
        </g>
      </svg>
    </div>
  )
}

function PixelCollection({ element }: { element: CanvasElement }) {
  const pixels = element.pixels ?? []
  const palette = element.palette ?? []
  const width = element.pixelWidth ?? 12
  const height = element.pixelHeight ?? 12
  const variants = [
    palette,
    palette.map((color, index) => (index === 5 ? '#74a857' : color)),
    palette.map((color, index) => (index === 5 ? '#ef5b5f' : color)),
    palette.map((color, index) => (index === 5 ? '#9678d3' : color)),
  ]

  return (
    <div className="pixel-collection">
      {variants.map((variant, index) => (
        <div className="pixel-tile" key={index}>
          <PixelSprite pixels={pixels} palette={variant} width={width} height={height} />
        </div>
      ))}
      <span className="pixel-node-hint">{width} × {height} · 双击编辑</span>
    </div>
  )
}

type CanvasElementViewProps = {
  element: CanvasElement
  imageResourceTier?: ImageResourceTier
}

export const CanvasElementView = memo(function CanvasElementView({
  element,
  imageResourceTier = 'thumbnail',
}: CanvasElementViewProps) {
  switch (element.kind) {
    case 'poster':
      return <PosterArt />
    case 'pixel':
      return <PixelCollection element={element} />
    case 'note':
      return (
        <div className="note-element">
          <p>{element.content}</p>
          <span className="note-fold" aria-hidden="true" />
        </div>
      )
    case 'palette':
      return (
        <div className="palette-element">
          {(element.palette ?? []).map((color) => (
            <span key={color} style={{ background: color }} title={color} />
          ))}
        </div>
      )
    case 'text':
      return <div className="text-element">{element.content || '双击输入文字'}</div>
    case 'shape':
      return <div className="shape-element" />
    case 'frame':
      return (
        <div className="frame-element">
          <span>{element.name}</span>
        </div>
      )
    case 'image':
      if (!element.src) return null
      {
        const enabledSteps = (element.processingStack ?? []).filter((step) => step.enabled)
        const derivedSource = [...enabledSteps]
          .reverse()
          .find((step) => step.outputSrc)?.outputSrc
        const hasAdjustmentStep = enabledSteps.some((step) => step.type === 'adjust')
        const resource = resolveImageResource(
          derivedSource ?? element.sourceSrc ?? element.src,
          imageResourceTier,
        )
        return (
          <img
            className="image-element"
            src={resource.src}
            alt={element.name}
            draggable={false}
            loading="lazy"
            decoding="async"
            data-resource-tier={resource.tier}
            style={{
              filter: hasAdjustmentStep
                ? imageAdjustmentFilter(element.adjustments)
                : undefined,
            }}
          />
        )
      }
    case 'video': {
      const status = element.jobStatus ?? (element.videoSrc ? 'completed' : 'queued')
      if (status === 'completed' && element.videoSrc) {
        return (
          <div className="video-node is-completed">
            <video
              className="video-element"
              src={element.videoSrc}
              poster={element.posterSrc}
              controls
              preload="metadata"
              playsInline
            />
            <span className="video-result-badge"><Play size={11} fill="currentColor" />生成结果</span>
          </div>
        )
      }
      if (status === 'failed') {
        return (
          <div className="video-node is-failed">
            {element.posterSrc ? <img src={element.posterSrc} alt="视频首帧" /> : null}
            <div className="video-node-shade" />
            <div className="video-node-state">
              <span className="video-state-icon"><AlertTriangle size={20} /></span>
              <strong>生成失败</strong>
              <p>{element.jobError?.title || element.jobDetail || '视频任务未完成'}</p>
              {element.jobError?.code ? <code>{element.jobError.code}</code> : null}
            </div>
          </div>
        )
      }
      if (status === 'cancelled') {
        return (
          <div className="video-node is-cancelled">
            {element.posterSrc ? <img src={element.posterSrc} alt="视频首帧" /> : null}
            <div className="video-node-shade" />
            <div className="video-node-state">
              <span className="video-state-icon"><Film size={20} /></span>
              <strong>任务已取消</strong>
              <p>可以在任务面板使用快速预设重新生成。</p>
            </div>
          </div>
        )
      }
      return (
        <div className="video-node is-running">
          {element.posterSrc ? <img src={element.posterSrc} alt="视频首帧" /> : <div className="video-node-placeholder"><Film size={34} /></div>}
          <div className="video-node-shade" />
          <div className="video-node-statusbar">
            <span><LoaderCircle className="is-spinning" size={14} />{element.jobDetail || '等待本地执行器'}</span>
            <b>{Math.round(element.jobProgress ?? 0)}%</b>
          </div>
          <div className="video-node-progress"><span style={{ width: `${element.jobProgress ?? 0}%` }} /></div>
          <span className="video-audio-badge"><Volume2 size={11} />H3 视频任务</span>
        </div>
      )
    }
    default:
      return null
  }
})
