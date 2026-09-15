import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

const GROUND = "#07090c";

/**
 * 네 겹의 껍질. 안쪽일수록 관리되고 있고, 바깥으로 갈수록 잊혀진 것들이다.
 * 중심과 이어진 실은 안쪽 두 겹까지만 있다 — 나머지는 연결을 기억하지 못한다.
 */
const SHELLS = [
  { count: 7, radius: 2.6, scale: 0.13, color: "#ffc247", tier: 0 },
  { count: 20, radius: 4.7, scale: 0.082, color: "#9a7328", tier: 1 },
  { count: 66, radius: 7.6, scale: 0.052, color: "#3f4859", tier: 2 },
  { count: 132, radius: 11.4, scale: 0.036, color: "#272e3a", tier: 3 },
] as const;

interface Node {
  pos: THREE.Vector3;
  scale: number;
  color: string;
  tier: number;
}

/** 결정적 의사난수 — 리렌더마다 별자리가 바뀌지 않도록 */
function rand(n: number) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

/** 피보나치 구면 분포: 뭉침 없이 고르게 흩뿌린다 */
function buildNodes(): Node[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const out: Node[] = [];
  let seed = 0;

  for (const shell of SHELLS) {
    for (let i = 0; i < shell.count; i++) {
      seed += 1;
      const y = 1 - (i / Math.max(shell.count - 1, 1)) * 2;
      const ring = Math.sqrt(Math.max(0, 1 - y * y));
      const theta = golden * i;

      // 완벽한 구는 인공적으로 보인다. 반지름과 각도에 흔들림을 준다.
      const jr = shell.radius * (0.82 + rand(seed) * 0.36);
      const jy = y + (rand(seed + 900) - 0.5) * 0.12;

      out.push({
        pos: new THREE.Vector3(
          Math.cos(theta) * ring * jr,
          jy * jr * 0.78,
          Math.sin(theta) * ring * jr,
        ),
        scale: shell.scale * (0.7 + rand(seed + 1800) * 0.7),
        color: shell.color,
        tier: shell.tier,
      });
    }
  }
  return out;
}

function NodeCloud({ nodes }: { nodes: Node[] }) {
  const ref = useRef<THREE.InstancedMesh>(null!);

  useLayoutEffect(() => {
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    nodes.forEach((n, i) => {
      dummy.position.copy(n.pos);
      dummy.scale.setScalar(n.scale);
      dummy.updateMatrix();
      ref.current.setMatrixAt(i, dummy.matrix);
      ref.current.setColorAt(i, color.set(n.color));
    });
    ref.current.instanceMatrix.needsUpdate = true;
    if (ref.current.instanceColor) ref.current.instanceColor.needsUpdate = true;
  }, [nodes]);

  return (
    <instancedMesh ref={ref} args={[undefined, undefined, nodes.length]} frustumCulled={false}>
      <sphereGeometry args={[1, 14, 14]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

/** 중심에서 뻗는 실. 중심 쪽은 어둡고 노드 쪽이 밝다 — 빛이 바깥에서 온다는 인상. */
function Threads({ nodes }: { nodes: Node[] }) {
  const geometry = useMemo(() => {
    const positions: number[] = [];
    const colors: number[] = [];
    const near = new THREE.Color("#241a06");
    const far = new THREE.Color();

    for (const n of nodes) {
      if (n.tier > 1) continue;
      positions.push(0, 0, 0, n.pos.x, n.pos.y, n.pos.z);
      far.set(n.tier === 0 ? "#f0b429" : "#5d4718");
      colors.push(near.r, near.g, near.b, far.r, far.g, far.b);
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    return g;
  }, [nodes]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={0.55} toneMapped={false} />
    </lineSegments>
  );
}

function Core() {
  const inner = useRef<THREE.Mesh>(null!);
  const halo = useRef<THREE.Mesh>(null!);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    inner.current.scale.setScalar(1 + Math.sin(t * 1.05) * 0.055);
    halo.current.scale.setScalar(1 + Math.sin(t * 0.7 + 1) * 0.09);
  });

  return (
    <group>
      <mesh ref={inner}>
        <sphereGeometry args={[0.34, 32, 32]} />
        <meshBasicMaterial color="#ffdb96" toneMapped={false} fog={false} />
      </mesh>
      <mesh ref={halo}>
        <sphereGeometry args={[0.66, 32, 32]} />
        <meshBasicMaterial color="#d59b23" transparent opacity={0.13} toneMapped={false} fog={false} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1.25, 0.004, 8, 128]} />
        <meshBasicMaterial color="#f0b429" transparent opacity={0.3} toneMapped={false} fog={false} />
      </mesh>
      <mesh rotation={[Math.PI / 2.35, 0.4, 0]}>
        <torusGeometry args={[1.85, 0.003, 8, 128]} />
        <meshBasicMaterial color="#f0b429" transparent opacity={0.16} toneMapped={false} fog={false} />
      </mesh>
    </group>
  );
}

/** 자동 회전 + 포인터 시차. 감쇠를 걸어 즉각 반응하지 않게 한다. */
function Rig({ children }: { children: ReactNode }) {
  const group = useRef<THREE.Group>(null!);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    group.current.rotation.y += d * 0.042;
    group.current.rotation.x = THREE.MathUtils.damp(
      group.current.rotation.x, state.pointer.y * 0.3, 2.4, d,
    );
    group.current.rotation.z = THREE.MathUtils.damp(
      group.current.rotation.z, -state.pointer.x * 0.07, 2.4, d,
    );
    state.camera.position.x = THREE.MathUtils.damp(state.camera.position.x, state.pointer.x * 1.4, 1.8, d);
    state.camera.position.y = THREE.MathUtils.damp(state.camera.position.y, state.pointer.y * 0.9, 1.8, d);
    state.camera.lookAt(0, 0, 0);
  });

  return <group ref={group}>{children}</group>;
}

export default function VaultField() {
  const nodes = useMemo(buildNodes, []);

  return (
    <Canvas
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0, 17], fov: 40 }}
      onCreated={({ gl, scene }) => {
        gl.setClearColor(GROUND);
        scene.fog = new THREE.FogExp2(GROUND, 0.052);
      }}
    >
      <Rig>
        <NodeCloud nodes={nodes} />
        <Threads nodes={nodes} />
        <Core />
      </Rig>
      <EffectComposer>
        <Bloom intensity={1.5} luminanceThreshold={0.22} luminanceSmoothing={0.4} mipmapBlur radius={0.72} />
        <Vignette offset={0.28} darkness={0.72} />
      </EffectComposer>
    </Canvas>
  );
}
