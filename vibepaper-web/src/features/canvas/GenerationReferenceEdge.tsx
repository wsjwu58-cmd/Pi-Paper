import { BaseEdge, getBezierPath, type EdgeProps } from '@xyflow/react'

/** Keep the original blue path visible underneath a travelling white highlight. */
export function GenerationReferenceEdge(props: EdgeProps) {
  const [path] = getBezierPath(props)
  const active = props.data?.generationReference === true
  return <>
    <BaseEdge id={props.id} path={path} style={props.style} markerEnd={props.markerEnd} markerStart={props.markerStart} interactionWidth={props.interactionWidth} />
    {active && <path d={path} className="vp-generation-reference-glow" fill="none" pointerEvents="none" />}
  </>
}
