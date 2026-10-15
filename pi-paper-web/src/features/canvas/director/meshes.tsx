import { useMemo } from 'react'
import * as THREE from 'three'
import type { CharacterPose, DirectorObject, PrimitiveKind, PropKind } from './types'

/** 人物姿态的关节角度（弧度） */
function poseAngles(pose: CharacterPose) {
  const z: Record<string, number> = {
    leftArm: 0.15,
    rightArm: -0.15,
    leftLeg: 0.05,
    rightLeg: -0.05,
    torso: 0,
    head: 0,
    headYaw: 0,
    scale: 1,
  }
  switch (pose) {
    case '行走':
      return { ...z, leftArm: 0.55, rightArm: -0.55, leftLeg: -0.45, rightLeg: 0.45 }
    case '奔跑':
      return { ...z, leftArm: 0.95, rightArm: -0.95, leftLeg: -0.85, rightLeg: 0.75, torso: 0.2 }
    case '坐':
      return { ...z, leftLeg: 1.35, rightLeg: 1.35, leftArm: 0.35, rightArm: -0.35 }
    case '挥手':
      return { ...z, rightArm: -2.4, leftArm: 0.2 }
    case '跳跃':
      return { ...z, leftArm: 0.9, rightArm: -0.9, leftLeg: -0.35, rightLeg: 0.35, torso: -0.1 }
    case '点头':
      return { ...z, head: 0.45 }
    case '摇头':
      return { ...z, headYaw: 0.55 }
    case '沮丧':
      return { ...z, torso: 0.35, head: 0.55, leftArm: 0.5, rightArm: -0.5 }
    case '潜行':
      return { ...z, torso: 0.45, leftArm: 0.7, rightArm: -0.4, leftLeg: -0.55, rightLeg: 0.35 }
    case '儿童':
      return { ...z, scale: 0.72 }
    default:
      return z
  }
}

function Limb({
  args,
  position,
  rotation,
  color,
}: {
  args: [number, number, number]
  position: [number, number, number]
  rotation?: [number, number, number]
  color: string
}) {
  return (
    <mesh position={position} rotation={rotation} castShadow receiveShadow>
      <boxGeometry args={args} />
      <meshStandardMaterial color={color} roughness={0.55} metalness={0.05} />
    </mesh>
  )
}

export function CharacterMesh({
  pose,
  color,
  selected,
}: {
  pose: CharacterPose
  color: string
  selected?: boolean
}) {
  const a = poseAngles(pose)
  const s = a.scale
  const yLift = pose === '跳跃' ? 0.35 : pose === '坐' ? -0.15 : 0

  return (
    <group scale={s} position={[0, yLift, 0]}>
      {/* 躯干 */}
      <mesh position={[0, 1.05, 0]} rotation={[a.torso, 0, 0]} castShadow>
        <boxGeometry args={[0.42, 0.7, 0.24]} />
        <meshStandardMaterial color={color} roughness={0.5} />
      </mesh>
      {/* 头 */}
      <mesh position={[0, 1.55, Math.sin(a.head) * 0.08]} rotation={[a.head, a.headYaw, 0]} castShadow>
        <boxGeometry args={[0.32, 0.32, 0.32]} />
        <meshStandardMaterial color={color} roughness={0.45} />
      </mesh>
      {/* 左臂 */}
      <Limb args={[0.14, 0.55, 0.14]} position={[-0.32, 1.15, 0]} rotation={[a.leftArm, 0, 0.25]} color={color} />
      {/* 右臂 */}
      <Limb args={[0.14, 0.55, 0.14]} position={[0.32, 1.15, 0]} rotation={[a.rightArm, 0, -0.25]} color={color} />
      {/* 左腿 */}
      <Limb args={[0.16, 0.65, 0.16]} position={[-0.12, 0.4, 0]} rotation={[a.leftLeg, 0, 0]} color={color} />
      {/* 右腿 */}
      <Limb args={[0.16, 0.65, 0.16]} position={[0.12, 0.4, 0]} rotation={[a.rightLeg, 0, 0]} color={color} />
      {selected && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.45, 0.55, 32]} />
          <meshBasicMaterial color="#3b82f6" transparent opacity={0.7} />
        </mesh>
      )}
    </group>
  )
}

function Stairs({ color }: { color: string }) {
  return (
    <group>
      {[0, 1, 2, 3].map((i) => (
        <mesh key={i} position={[0, 0.12 + i * 0.22, -i * 0.35]} castShadow receiveShadow>
          <boxGeometry args={[1.4, 0.22, 0.4]} />
          <meshStandardMaterial color={color} roughness={0.7} />
        </mesh>
      ))}
    </group>
  )
}

function Chair({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.42, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.7, 0.08, 0.7]} />
        <meshStandardMaterial color={color} roughness={0.4} />
      </mesh>
      <mesh position={[0, 0.85, -0.31]} castShadow>
        <boxGeometry args={[0.7, 0.75, 0.08]} />
        <meshStandardMaterial color={color} roughness={0.4} />
      </mesh>
      {[
        [-0.28, 0.2, -0.28],
        [0.28, 0.2, -0.28],
        [-0.28, 0.2, 0.28],
        [0.28, 0.2, 0.28],
      ].map((p, i) => (
        <mesh key={i} position={p as [number, number, number]} castShadow>
          <boxGeometry args={[0.07, 0.4, 0.07]} />
          <meshStandardMaterial color={color} roughness={0.5} />
        </mesh>
      ))}
    </group>
  )
}

function Wall({ color }: { color: string }) {
  return (
    <mesh position={[0, 1.1, 0]} castShadow receiveShadow>
      <boxGeometry args={[2.2, 2.2, 0.12]} />
      <meshStandardMaterial color={color} roughness={0.85} />
    </mesh>
  )
}

function Lamp({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.7, 0]} castShadow>
        <cylinderGeometry args={[0.04, 0.04, 1.4, 12]} />
        <meshStandardMaterial color="#555" roughness={0.4} metalness={0.3} />
      </mesh>
      <mesh position={[0, 1.45, 0]} castShadow>
        <sphereGeometry args={[0.22, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.45} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0.04, 0]} receiveShadow>
        <cylinderGeometry args={[0.22, 0.25, 0.06, 16]} />
        <meshStandardMaterial color="#444" />
      </mesh>
    </group>
  )
}

function Arch({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[-0.7, 0.9, 0]} castShadow>
        <boxGeometry args={[0.25, 1.8, 0.25]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0.7, 0.9, 0]} castShadow>
        <boxGeometry args={[0.25, 1.8, 0.25]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0, 1.85, 0]} castShadow>
        <boxGeometry args={[1.65, 0.25, 0.25]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
      <mesh position={[0, 1.55, 0]} rotation={[0, 0, Math.PI / 2]}>
        <torusGeometry args={[0.55, 0.12, 8, 24, Math.PI]} />
        <meshStandardMaterial color={color} roughness={0.7} />
      </mesh>
    </group>
  )
}

function Tree({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.55, 0]} castShadow>
        <cylinderGeometry args={[0.1, 0.14, 1.1, 8]} />
        <meshStandardMaterial color="#6b4423" roughness={0.9} />
      </mesh>
      <mesh position={[0, 1.4, 0]} castShadow>
        <coneGeometry args={[0.65, 1.1, 8]} />
        <meshStandardMaterial color={color} roughness={0.8} />
      </mesh>
      <mesh position={[0, 1.95, 0]} castShadow>
        <coneGeometry args={[0.45, 0.8, 8]} />
        <meshStandardMaterial color={color} roughness={0.8} />
      </mesh>
    </group>
  )
}

function Table({ color }: { color: string }) {
  return (
    <group>
      <mesh position={[0, 0.72, 0]} castShadow receiveShadow>
        <boxGeometry args={[1.2, 0.08, 0.8]} />
        <meshStandardMaterial color={color} roughness={0.55} />
      </mesh>
      {[
        [-0.5, 0.35, -0.3],
        [0.5, 0.35, -0.3],
        [-0.5, 0.35, 0.3],
        [0.5, 0.35, 0.3],
      ].map((p, i) => (
        <mesh key={i} position={p as [number, number, number]} castShadow>
          <boxGeometry args={[0.08, 0.7, 0.08]} />
          <meshStandardMaterial color={color} roughness={0.6} />
        </mesh>
      ))}
    </group>
  )
}

function Fence({ color }: { color: string }) {
  return (
    <group>
      {[-0.9, -0.3, 0.3, 0.9].map((x) => (
        <mesh key={x} position={[x, 0.45, 0]} castShadow>
          <boxGeometry args={[0.08, 0.9, 0.08]} />
          <meshStandardMaterial color={color} roughness={0.75} />
        </mesh>
      ))}
      <mesh position={[0, 0.7, 0]} castShadow>
        <boxGeometry args={[2, 0.08, 0.06]} />
        <meshStandardMaterial color={color} roughness={0.75} />
      </mesh>
      <mesh position={[0, 0.3, 0]} castShadow>
        <boxGeometry args={[2, 0.08, 0.06]} />
        <meshStandardMaterial color={color} roughness={0.75} />
      </mesh>
    </group>
  )
}

function PropMesh({ kind, color }: { kind: PropKind; color: string }) {
  switch (kind) {
    case '台阶':
      return <Stairs color={color} />
    case '椅子':
      return <Chair color={color} />
    case '墙板':
      return <Wall color={color} />
    case '灯':
      return <Lamp color={color} />
    case '拱门':
      return <Arch color={color} />
    case '树':
      return <Tree color={color} />
    case '桌子':
      return <Table color={color} />
    case '栅栏':
      return <Fence color={color} />
    default:
      return null
  }
}

function PrimitiveMesh({ kind, color }: { kind: PrimitiveKind; color: string }) {
  switch (kind) {
    case '方块':
      return (
        <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
          <boxGeometry args={[1, 1, 1]} />
          <meshStandardMaterial color={color} roughness={0.45} metalness={0.08} />
        </mesh>
      )
    case '球体':
      return (
        <mesh position={[0, 0.5, 0]} castShadow receiveShadow>
          <sphereGeometry args={[0.5, 24, 24]} />
          <meshStandardMaterial color={color} roughness={0.45} metalness={0.08} />
        </mesh>
      )
    case '圆柱':
      return (
        <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.4, 0.4, 1.1, 24]} />
          <meshStandardMaterial color={color} roughness={0.45} metalness={0.08} />
        </mesh>
      )
    case '圆锥':
      return (
        <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
          <coneGeometry args={[0.5, 1.1, 24]} />
          <meshStandardMaterial color={color} roughness={0.45} metalness={0.08} />
        </mesh>
      )
    case '金字塔':
      return (
        <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
          <coneGeometry args={[0.55, 1.1, 4]} />
          <meshStandardMaterial color={color} roughness={0.45} metalness={0.08} />
        </mesh>
      )
    case '胶囊':
      return (
        <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
          <capsuleGeometry args={[0.28, 0.7, 8, 16]} />
          <meshStandardMaterial color={color} roughness={0.45} metalness={0.08} />
        </mesh>
      )
    case '圆环':
      return (
        <mesh position={[0, 0.45, 0]} rotation={[Math.PI / 2, 0, 0]} castShadow receiveShadow>
          <torusGeometry args={[0.45, 0.16, 16, 32]} />
          <meshStandardMaterial color={color} roughness={0.45} metalness={0.08} />
        </mesh>
      )
    default:
      return null
  }
}

export function SceneObjectMesh({
  obj,
  selected,
  onSelect,
}: {
  obj: DirectorObject
  selected: boolean
  onSelect: (id: string) => void
}) {
  const content = useMemo(() => {
    if (obj.category === 'character') {
      return <CharacterMesh pose={obj.kind as CharacterPose} color={obj.color} selected={selected} />
    }
    if (obj.category === 'prop') {
      return <PropMesh kind={obj.kind as PropKind} color={obj.color} />
    }
    return <PrimitiveMesh kind={obj.kind as PrimitiveKind} color={obj.color} />
  }, [obj.category, obj.kind, obj.color, selected])

  return (
    <group
      position={obj.position}
      rotation={[0, (obj.rotation * Math.PI) / 180, 0]}
      scale={obj.scale}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(obj.id)
      }}
      onPointerOver={(e) => {
        e.stopPropagation()
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'default'
      }}
    >
      {content}
      {selected && obj.category !== 'character' && (
        <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <ringGeometry args={[0.6, 0.72, 32]} />
          <meshBasicMaterial color="#3b82f6" transparent opacity={0.65} side={THREE.DoubleSide} />
        </mesh>
      )}
    </group>
  )
}
