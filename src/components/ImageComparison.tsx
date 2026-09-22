import { useId, useState } from 'react'
import './image-comparison.css'

type Props = { before: string; after: string; beforeLabel?: string; afterLabel?: string; afterFilter?: string; pixelated?: boolean }

export function ImageComparison({ before, after, beforeLabel = '原图', afterLabel = '候选', afterFilter, pixelated = false }: Props) {
  const [position, setPosition] = useState(50)
  const sliderId = useId()
  return <figure className={`aq-image-comparison ${pixelated ? 'is-pixelated' : ''}`} aria-label="图像滑杆对比">
    <div className="aq-image-comparison__stage">
      <img src={before} alt={beforeLabel} draggable={false} />
      <img src={after} alt={afterLabel} draggable={false} style={{ clipPath: `inset(0 0 0 ${position}%)`, filter: afterFilter }} />
      <span className="aq-image-comparison__line" style={{ left: `${position}%` }} aria-hidden="true" />
      <span className="aq-image-comparison__label is-before">{beforeLabel}</span>
      <span className="aq-image-comparison__label is-after">{afterLabel}</span>
    </div>
    <figcaption><label htmlFor={sliderId}>拖动比较</label><input id={sliderId} aria-label="对比位置" type="range" min={0} max={100} value={position} onChange={(event) => setPosition(Number(event.target.value))} /><output>{position}%</output></figcaption>
  </figure>
}
