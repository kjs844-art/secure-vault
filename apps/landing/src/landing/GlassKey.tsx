import { useMemo, useRef, type MutableRefObject } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { Environment, Lightformer, MeshTransmissionMaterial } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";

const GROUND = "#08090b";

/**
 * 열쇠 한 자루. 손잡이(bow) 안에 노드 그래프가 들어 있다 — Key + Atlas.
 * 유리로 만든 이유: 속이 다 보이는데도 열쇠다. 제로지식을 형태로 말한다.
 */
function KeyMesh({ scroll }: { scroll: MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null!);
  const first = useRef(true);

  // 손잡이 안 그래프: 원 위의 노드 6개 + 중심 허브
  const nodes = useMemo(() => {
    const out: THREE.Vector3[] = [];
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      out.push(new THREE.Vector3(Math.cos(a) * 0.56, Math.sin(a) * 0.56, 0));
    }
    return out;
  }, []);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    const t = state.clock.elapsedTime;
    const s = scroll.current;
    const g = group.current;

    // 제자리 회전 + 포인터에 살짝 기울기
    g.rotation.y += d * 0.28;
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, 0.18 + state.pointer.y * 0.22 + Math.sin(t * 0.4) * 0.05, 2.2, d);
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, -0.22 - state.pointer.x * 0.16, 2.2, d);

    // 화면 비율에 맞춰 크기와 자리를 정한다. 세로 화면은 위로 물러나고,
    // 가로 화면은 오른쪽으로 비켜서 글과 나란히 선다 — 글에 자리를 내준다.
    const portrait = state.viewport.aspect < 0.8;
    const base = portrait ? 0.58 : 0.88;
    const tx = portrait ? 0 : THREE.MathUtils.lerp(0, 2.45, s);
    const ty = portrait ? THREE.MathUtils.lerp(0.1, 2.05, s) : THREE.MathUtils.lerp(0, 1.15, s);
    const ts = THREE.MathUtils.lerp(base, portrait ? 0.4 : 0.55, s);

    if (first.current) {
      // 첫 프레임은 감쇠 없이 바로 놓는다. 그래야 모바일에서 큰 열쇠가 줄어드는 게 보이지 않는다.
      first.current = false;
      g.position.set(tx, ty, 0);
      g.scale.setScalar(ts);
      return;
    }
    g.position.x = THREE.MathUtils.damp(g.position.x, tx, 4, d);
    g.position.y = THREE.MathUtils.damp(g.position.y, ty, 4, d);
    g.scale.setScalar(THREE.MathUtils.damp(g.scale.x, ts, 4, d));
  });

  const glass = (
    <MeshTransmissionMaterial
      backside
      samples={6}
      resolution={512}
      thickness={0.55}
      roughness={0.06}
      ior={1.46}
      chromaticAberration={0.16}
      anisotropy={0.25}
      distortion={0.18}
      distortionScale={0.35}
      temporalDistortion={0.08}
      color="#e6eef7"
      attenuationColor="#bcd4ee"
      attenuationDistance={2.2}
    />
  );

  return (
    <group ref={group} position={[0, 0, 0]} scale={0.88}>
    <group position={[0, 1.13, 0]}>
      {/* 손잡이 */}
      <mesh>
        <torusGeometry args={[1.02, 0.2, 40, 96]} />
        {glass}
      </mesh>
      {/* 손잡이 안 그래프 — 허브와 노드는 유리가 아니라 빛 */}
      <mesh>
        <sphereGeometry args={[0.13, 24, 24]} />
        <meshBasicMaterial color="#f4f7fb" toneMapped={false} />
      </mesh>
      {nodes.map((p, i) => (
        <group key={i}>
          <mesh position={p}>
            <sphereGeometry args={[0.07, 18, 18]} />
            <meshBasicMaterial color="#dfe9f5" toneMapped={false} />
          </mesh>
          <mesh position={p.clone().multiplyScalar(0.5)} rotation={[0, 0, Math.atan2(p.y, p.x) + Math.PI / 2]}>
            <cylinderGeometry args={[0.012, 0.012, 0.56, 6]} />
            <meshBasicMaterial color="#9fb3c8" transparent opacity={0.85} toneMapped={false} />
          </mesh>
        </group>
      ))}
      {/* 몸통 */}
      <mesh position={[0, -2.32, 0]}>
        <cylinderGeometry args={[0.17, 0.17, 2.7, 32]} />
        {glass}
      </mesh>
      {/* 이(teeth) */}
      <mesh position={[0.42, -2.55, 0]}>
        <boxGeometry args={[0.5, 0.2, 0.3]} />
        {glass}
      </mesh>
      <mesh position={[0.36, -2.95, 0]}>
        <boxGeometry args={[0.38, 0.2, 0.3]} />
        {glass}
      </mesh>
      <mesh position={[0.45, -3.37, 0]}>
        <boxGeometry args={[0.56, 0.22, 0.3]} />
        {glass}
      </mesh>
    </group>
    </group>
  );
}

/** 유리는 뒤에 뭔가 있어야 굴절이 보인다. 어두운 그라디언트 판과 흩어진 점들. */
function Backdrop() {
  const texture = useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 512;
    const ctx = c.getContext("2d")!;
    const g = ctx.createRadialGradient(256, 236, 20, 256, 256, 300);
    g.addColorStop(0, "#2a2f38");
    g.addColorStop(0.45, "#14171c");
    g.addColorStop(1, GROUND);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }, []);

  const dots = useMemo(() => {
    const out: [number, number, number, number][] = [];
    let seed = 1;
    const r = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 46; i++) out.push([(r() - 0.5) * 16, (r() - 0.5) * 11, -2.5 - r() * 5, 0.025 + r() * 0.03]);
    return out;
  }, []);

  return (
    <group>
      <mesh position={[0, 0, -8]}>
        <planeGeometry args={[30, 30]} />
        <meshBasicMaterial map={texture} toneMapped={false} />
      </mesh>
      {dots.map(([x, y, z, s], i) => (
        <mesh key={i} position={[x, y, z]}>
          <sphereGeometry args={[s, 10, 10]} />
          <meshBasicMaterial color="#6f7a8a" toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}

/** 카메라를 완벽한 정지 대신 유기적으로 흔든다 — 층층이 겹친 사인파 (FBM 근사). */
function CameraDrift() {
  const { camera } = useThree();
  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    const t = state.clock.elapsedTime;
    const nx = Math.sin(t * 0.21) * 0.6 + Math.sin(t * 0.53 + 1.3) * 0.3 + Math.sin(t * 1.1 + 2.1) * 0.1;
    const ny = Math.cos(t * 0.17 + 0.7) * 0.5 + Math.sin(t * 0.47 + 2.9) * 0.25 + Math.cos(t * 0.97) * 0.08;
    camera.position.x = THREE.MathUtils.damp(camera.position.x, nx * 0.5 + state.pointer.x * 1.1, 1.6, d);
    camera.position.y = THREE.MathUtils.damp(camera.position.y, ny * 0.4 + state.pointer.y * 0.7, 1.6, d);
    camera.lookAt(0, 0.2, 0);
  });
  return null;
}

export default function GlassKey({ scroll }: { scroll: MutableRefObject<number> }) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.2, 9.5], fov: 34 }}
      onCreated={({ gl }) => gl.setClearColor(GROUND)}
    >
      <CameraDrift />
      <Backdrop />
      <KeyMesh scroll={scroll} />
      {/* 외부 HDR 없이 조명판만으로 환경을 만든다 — 네트워크 요청 0 */}
      <Environment resolution={256}>
        <Lightformer intensity={5} rotation-x={Math.PI / 2} position={[0, 6, -9]} scale={[12, 12, 1]} />
        <Lightformer intensity={2.2} rotation-y={Math.PI / 2} position={[-6, 1, -1]} scale={[12, 2.5, 1]} />
        <Lightformer intensity={2.2} rotation-y={-Math.PI / 2} position={[9, 1, 0]} scale={[18, 2.5, 1]} />
        <Lightformer color="#cfe0ff" intensity={1.6} form="ring" position={[-2.5, 3, 5]} scale={3.2} />
        <Lightformer color="#ffe9d0" intensity={0.9} form="circle" position={[3, -2, 5]} scale={2} />
      </Environment>
      <EffectComposer>
        <Bloom intensity={0.75} luminanceThreshold={0.6} luminanceSmoothing={0.3} mipmapBlur radius={0.5} />
        <Vignette offset={0.3} darkness={0.65} />
      </EffectComposer>
    </Canvas>
  );
}
