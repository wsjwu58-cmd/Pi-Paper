import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type MutableRefObject } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import type { DirectorCamera, DirectorObject } from './types'
import { SceneObjectMesh } from './meshes'

export interface DirectorCaptureApi {
  capturePng: () => Promise<Blob>
}

function CameraRig({ camera }: { camera: DirectorCamera }) {
  const { camera: cam } = useThree()
  useFrame(() => {
    const yaw = (camera.yaw * Math.PI) / 180
    const pitch = (camera.pitch * Math.PI) / 180
    const d = camera.distance
    const x = Math.cos(pitch) * Math.sin(yaw) * d
    const y = Math.sin(pitch) * d
    const z = Math.cos(pitch) * Math.cos(yaw) * d
    cam.position.set(x, y, z)
    cam.lookAt(0, 0.6, 0)
    cam.updateProjectionMatrix()
  })
  return null
}

function GridFloor() {
  const grid = useMemo(() => {
    const g = new THREE.GridHelper(20, 40, '#d4d4d8', '#ebebef')
    g.position.y = 0
    const mats = Array.isArray(g.material) ? g.material : [g.material]
    mats.forEach((m) => {
      m.transparent = true
      m.opacity = 0.85
    })
    return g
  }, [])
  return <primitive object={grid} />
}

function CaptureBridge({ apiRef }: { apiRef: MutableRefObject<DirectorCaptureApi | null> }) {
  const { gl, scene, camera } = useThree()
  useEffect(() => {
    apiRef.current = {
      capturePng: () =>
        new Promise((resolve, reject) => {
          try {
            gl.render(scene, camera)
            gl.domElement.toBlob(
              (blob) => {
                if (blob) resolve(blob)
                else reject(new Error('截图失败'))
              },
              'image/png',
              1,
            )
          } catch (e) {
            reject(e)
          }
        }),
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef, camera, gl, scene])
  return null
}

function SceneContent({
  objects,
  selectedId,
  onSelect,
  camera,
  apiRef,
}: {
  objects: DirectorObject[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  camera: DirectorCamera
  apiRef: MutableRefObject<DirectorCaptureApi | null>
}) {
  return (
    <>
      <color attach="background" args={['#ffffff']} />
      <ambientLight intensity={0.72} />
      <directionalLight
        castShadow
        position={[6, 10, 4]}
        intensity={1.15}
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-far={40}
        shadow-camera-left={-12}
        shadow-camera-right={12}
        shadow-camera-top={12}
        shadow-camera-bottom={-12}
      />
      <hemisphereLight args={['#ffffff', '#e8e8ec', 0.35]} />
      <CameraRig camera={camera} />
      <CaptureBridge apiRef={apiRef} />
      <GridFloor />
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -0.001, 0]}
        receiveShadow
        onClick={() => onSelect(null)}
      >
        <planeGeometry args={[40, 40]} />
        <meshStandardMaterial color="#fafafa" roughness={1} />
      </mesh>
      {objects.map((obj) => (
        <SceneObjectMesh
          key={obj.id}
          obj={obj}
          selected={obj.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </>
  )
}

export const DirectorViewport = forwardRef<
  DirectorCaptureApi,
  {
    objects: DirectorObject[]
    camera: DirectorCamera
    selectedId: string | null
    onSelect: (id: string | null) => void
    className?: string
  }
>(function DirectorViewport({ objects, camera, selectedId, onSelect, className }, ref) {
  const apiRef = useRef<DirectorCaptureApi | null>(null)

  useImperativeHandle(ref, () => ({
    capturePng: async () => {
      if (!apiRef.current) throw new Error('场景未就绪')
      return apiRef.current.capturePng()
    },
  }))

  return (
    <div className={className ?? 'h-full w-full'}>
      <Canvas
        shadows
        dpr={[1, 2]}
        camera={{ fov: 42, near: 0.1, far: 80, position: [6, 4, 6] }}
        gl={{ antialias: true, preserveDrawingBuffer: true, alpha: false }}
        onPointerMissed={() => onSelect(null)}
      >
        <SceneContent
          objects={objects}
          selectedId={selectedId}
          onSelect={onSelect}
          camera={camera}
          apiRef={apiRef}
        />
      </Canvas>
    </div>
  )
})
