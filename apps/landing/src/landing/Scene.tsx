import { useLayoutEffect, useMemo, useRef, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Lightformer, MeshTransmissionMaterial, RoundedBox } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const GROUND = "#070708";
const GOLD = "#d4b06a";
const GOLD_HI = "#f1d9a3";
const GOLD_LO = "#a88c50";
const LOCK_Y = 0.7;          // 자물쇠 몸통 중심 (월드)
const LOCK_START_Y = 4.6;    // 내려오기 시작하는 높이 — 화면 바로 위, 첫 화면에선 안 보인다
const KEY_SCALE_OPEN = 0.88; // 첫 화면 열쇠 크기
const KEY_SCALE_IN = 0.62;   // 꽂힐 때 열쇠 크기
const KEY_Y_IN = -0.36;      // 꽂힐 때 열쇠 중심: 이 끝이 몸통 안 1.4까지 들어간다
const TAU = Math.PI * 2;

/* 스크롤 s(0~1)를 구간별 진행도로. smoothstep으로 시작과 끝을 부드럽게. */
const smooth = (t: number) => t * t * (3 - 2 * t);
const ph = (s: number, a: number, b: number) => smooth(Math.min(1, Math.max(0, (s - a) / (b - a))));
/* 걸쇠가 떨어질 때 살짝 튕기는 느낌 — easeOutBack */
const back = (t: number) => { const c = 1.7, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

interface Beats { tIn: number; tTurn: number; c: number; tLock: number; flash: number }
function beats(s: number): Beats {
  return {
    tIn: ph(s, 0.12, 0.40),
    tTurn: ph(s, 0.40, 0.55),
    c: ph(s, 0.50, 0.84),
    tLock: ph(s, 0.84, 0.95),
    flash: Math.exp(-(((s - 0.955) / 0.025) ** 2)),
  };
}

/** 결정적 의사난수 — 리렌더마다 흩뿌림이 바뀌지 않도록 */
function rng(seed: number) {
  let x = seed;
  return () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
}

function Glass({ soft = false }: { soft?: boolean }) {
  // soft: 자물쇠 몸통. 두꺼운 유리는 속 별자리를 과확대해 뭉개 보인다.
  return (
    <MeshTransmissionMaterial
      backside samples={6} resolution={512}
      thickness={soft ? 0.28 : 0.55} roughness={soft ? 0.12 : 0.06} ior={soft ? 1.38 : 1.46}
      chromaticAberration={soft ? 0.07 : 0.16} anisotropy={soft ? 0.1 : 0.25}
      distortion={soft ? 0.05 : 0.18} distortionScale={0.35} temporalDistortion={soft ? 0.03 : 0.08}
      color="#f4f0e8" attenuationColor="#d8c8a4" attenuationDistance={soft ? 3.5 : 2.2}
    />
  );
}

/** 열쇠. 유리 부품을 한 덩어리로 합쳐 굴절 계산을 한 번만 한다. 손잡이 안 그래프는 빛. */
function Key({ scroll }: { scroll: MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null!);
  const spin = useRef(0);
  const first = useRef(true);

  const geometry = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, x: number, y: number, z = 0) => { g.translate(x, y, z); parts.push(g); };
    add(new THREE.TorusGeometry(1.02, 0.2, 40, 96), 0, 1.13);
    add(new THREE.CylinderGeometry(0.17, 0.17, 2.7, 32), 0, -1.19);
    add(new THREE.BoxGeometry(0.5, 0.2, 0.3), 0.42, -1.42);
    add(new THREE.BoxGeometry(0.38, 0.2, 0.3), 0.36, -1.82);
    add(new THREE.BoxGeometry(0.56, 0.22, 0.3), 0.45, -2.24);
    const merged = mergeGeometries(parts, false)!;
    parts.forEach((p) => p.dispose());
    return merged;
  }, []);

  const nodes = useMemo(() => Array.from({ length: 6 }, (_, i) => {
    const a = (i / 6) * TAU + Math.PI / 6;
    return new THREE.Vector3(Math.cos(a) * 0.56, Math.sin(a) * 0.56, 0);
  }), []);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    const t = state.clock.elapsedTime;
    const { tIn, tTurn } = beats(scroll.current);
    const g = group.current;
    const px = state.pointer.x, py = state.pointer.y;

    // 자유 회전은 꽂히기 전까지만. 꽂힐 땐 가장 가까운 정면으로 정렬한 뒤 90° 돌린다.
    if (tIn === 0) spin.current += d * 0.28;
    const aligned = Math.round(spin.current / TAU) * TAU;
    const ry = THREE.MathUtils.lerp(spin.current, aligned, tIn) + (Math.PI / 2) * tTurn;
    const rx = THREE.MathUtils.lerp(0.18 + py * 0.22 + Math.sin(t * 0.4) * 0.05, 0, tIn);
    const rz = THREE.MathUtils.lerp(-0.22 - px * 0.16, Math.PI, tIn); // 뒤집혀 이가 위를 본다
    const y = THREE.MathUtils.lerp(0, KEY_Y_IN, tIn);
    const sc = THREE.MathUtils.lerp(KEY_SCALE_OPEN, KEY_SCALE_IN, tIn);

    if (first.current) {
      first.current = false;
      g.rotation.set(rx, ry, rz); g.position.set(0, y, 0); g.scale.setScalar(sc);
      return;
    }
    const k = 8;
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, rx, k, d);
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, ry, k, d);
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, rz, k, d);
    g.position.y = THREE.MathUtils.damp(g.position.y, y, k, d);
    g.scale.setScalar(THREE.MathUtils.damp(g.scale.x, sc, k, d));
  });

  return (
    <group ref={group}>
      <mesh geometry={geometry}><Glass /></mesh>
      <group position={[0, 1.13, 0]}>
        <mesh><sphereGeometry args={[0.13, 24, 24]} /><meshBasicMaterial color={GOLD_HI} toneMapped={false} /></mesh>
        {nodes.map((p, i) => (
          <group key={i}>
            <mesh position={p}><sphereGeometry args={[0.07, 18, 18]} /><meshBasicMaterial color={GOLD} toneMapped={false} /></mesh>
            <mesh position={p.clone().multiplyScalar(0.5)} rotation={[0, 0, Math.atan2(p.y, p.x) + Math.PI / 2]}>
              <cylinderGeometry args={[0.012, 0.012, 0.56, 6]} />
              <meshBasicMaterial color={GOLD_LO} transparent opacity={0.9} toneMapped={false} />
            </mesh>
          </group>
        ))}
      </group>
    </group>
  );
}

/** 자물쇠. 유리 몸통, 크롬 걸쇠, 몸통 안의 열쇠길과 별자리. */
function Lock({ scroll }: { scroll: MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null!);
  const shackle = useRef<THREE.Group>(null!);
  const starMat = useMemo(() => new THREE.MeshBasicMaterial({ color: "#4a4638", toneMapped: false }), []);
  const glowMat = useRef<THREE.MeshBasicMaterial>(null!);
  const first = useRef(true);
  const dim = useMemo(() => new THREE.Color("#4a4638"), []);
  const lit = useMemo(() => new THREE.Color("#f3e2b8"), []);
  const tmp = useMemo(() => new THREE.Color(), []);

  const shackleGeo = useMemo(() => {
    const arc = new THREE.TorusGeometry(0.62, 0.11, 24, 64, Math.PI); arc.translate(0, 0.7, 0);
    const l = new THREE.CylinderGeometry(0.11, 0.11, 0.7, 24); l.translate(-0.62, 0.35, 0);
    const r = new THREE.CylinderGeometry(0.11, 0.11, 0.7, 24); r.translate(0.62, 0.35, 0);
    const m = mergeGeometries([arc, l, r], false)!;
    [arc, l, r].forEach((g) => g.dispose());
    return m;
  }, []);

  const stars = useMemo(() => {
    const r = rng(7);
    return Array.from({ length: 16 }, () => [ (r() - 0.5) * 1.7, (r() - 0.5) * 1.3, (r() - 0.5) * 0.5, 0.022 + r() * 0.02 ] as const);
  }, []);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    const { tIn, c, tLock, flash } = beats(scroll.current);
    const g = group.current;
    const y = THREE.MathUtils.lerp(LOCK_START_Y, LOCK_Y, tIn);
    const ry = state.pointer.x * 0.12;
    // 걸쇠: 열려 있다가(올라가고 비틀림) 튕기듯 내려와 잠긴다
    const drop = back(tLock);
    const sy = 1.0 + 0.42 * (1 - drop);
    const sr = 0.5 * (1 - tLock);

    if (first.current) {
      first.current = false;
      g.position.y = y; g.rotation.y = ry; shackle.current.position.y = sy; shackle.current.rotation.y = sr;
    } else {
      g.position.y = THREE.MathUtils.damp(g.position.y, y, 8, d);
      g.rotation.y = THREE.MathUtils.damp(g.rotation.y, ry, 3, d);
      shackle.current.position.y = THREE.MathUtils.damp(shackle.current.position.y, sy, 10, d);
      shackle.current.rotation.y = THREE.MathUtils.damp(shackle.current.rotation.y, sr, 10, d);
    }
    // 모여든 만큼 속이 밝아지고, 잠기는 순간 번쩍인다
    starMat.color.copy(tmp.copy(dim).lerp(lit, c));
    glowMat.current.opacity = Math.min(0.42, 0.03 + 0.16 * c + 0.4 * flash);
  });

  return (
    <group ref={group} position={[0, LOCK_START_Y, 0]}>
      <RoundedBox args={[2.3, 2.0, 0.85]} radius={0.22} smoothness={6}><Glass soft /></RoundedBox>
      {/* 열쇠길: 바닥에서 위로 뚫린 어두운 구멍. 유리 너머로 보인다. */}
      <mesh position={[0, -0.3, 0]}>
        <cylinderGeometry args={[0.2, 0.2, 1.4, 20]} />
        <meshBasicMaterial color="#05060a" />
      </mesh>
      {/* 속 별자리: 모여든 정보 */}
      <group>
        {stars.map(([x, y, z, s], i) => (
          <mesh key={i} position={[x, y, z]} material={starMat}>
            <sphereGeometry args={[s, 12, 12]} />
          </mesh>
        ))}
      </group>
      <mesh><sphereGeometry args={[0.58, 24, 24]} /><meshBasicMaterial ref={glowMat} color="#e8cf93" transparent opacity={0.03} toneMapped={false} depthWrite={false} /></mesh>
      {/* 걸쇠 */}
      <group ref={shackle} position={[0, 1.42, 0]}>
        <mesh geometry={shackleGeo}><meshStandardMaterial color={GOLD} metalness={1} roughness={0.22} /></mesh>
      </group>
    </group>
  );
}

/** 흩어진 정보. 평소엔 배경의 점, 모이는 구간엔 자물쇠로 빨려 들어가 사라진다. */
function Scatter({ scroll }: { scroll: MutableRefObject<number> }) {
  const N = 260;
  const mesh = useRef<THREE.InstancedMesh>(null!);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const data = useMemo(() => {
    const r = rng(3);
    return Array.from({ length: N }, () => {
      const th = r() * TAU, phi = Math.acos(2 * r() - 1), rad = 7 + r() * 6;
      const start = new THREE.Vector3(Math.sin(phi) * Math.cos(th) * rad, Math.sin(phi) * Math.sin(th) * rad * 0.7, Math.cos(phi) * rad * 0.45 - 2.5);
      const end = new THREE.Vector3((r() - 0.5) * 0.8, LOCK_Y + (r() - 0.5) * 0.6, (r() - 0.5) * 0.3);
      return { start, end, delay: r() * 0.5, size: 0.028 + r() * 0.04, bright: r() < 0.35, wob: r() * TAU };
    });
  }, []);

  useLayoutEffect(() => {
    const col = new THREE.Color();
    data.forEach((p, i) => mesh.current.setColorAt(i, col.set(p.bright ? "#f0dfb5" : "#8c8a84")));
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
  }, [data]);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const { c } = beats(scroll.current);
    // 평소엔 배경의 먼지. 모여들 때만 빛난다.
    const k = 0.42 + 0.58 * c;
    (mesh.current.material as THREE.MeshBasicMaterial).color.setRGB(k, k, k);
    data.forEach((p, i) => {
      const local = smooth(Math.min(1, Math.max(0, (c - p.delay * 0.5) / 0.5)));
      dummy.position.lerpVectors(p.start, p.end, local);
      // 정지해 있으면 죽어 보인다. 아직 안 모인 점은 살짝 떠다닌다.
      dummy.position.y += Math.sin(t * 0.5 + p.wob) * 0.08 * (1 - local);
      // 도착 직전까지 크기를 유지해야 "모여든다"가 보인다. 마지막 15%에서만 흡수된다.
      const absorb = smooth(Math.max(0, (local - 0.85) / 0.15));
      dummy.scale.setScalar(p.size * (1 - absorb));
      dummy.updateMatrix();
      mesh.current.setMatrixAt(i, dummy.matrix);
    });
    mesh.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, N]} frustumCulled={false}>
      <sphereGeometry args={[1, 10, 10]} />
      <meshBasicMaterial toneMapped={false} />
    </instancedMesh>
  );
}

/** 얇은 금 눈금 다이얼. 계측기의 정밀함 — 네온 없이 "기술"을 말한다. */
function Dial({ scroll }: { scroll: MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null!);
  const ticks = useRef<THREE.InstancedMesh>(null!);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }), []);
  const N = 72;
  useLayoutEffect(() => {
    const d = new THREE.Object3D();
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      const long = i % 6 === 0;
      d.position.set(Math.cos(a) * 2.42, Math.sin(a) * 2.42, 0);
      d.rotation.set(0, 0, a);
      d.scale.set(long ? 0.11 : 0.05, 1, 1);
      d.updateMatrix();
      ticks.current.setMatrixAt(i, d.matrix);
    }
    ticks.current.instanceMatrix.needsUpdate = true;
  }, []);
  useFrame((state, dt) => {
    const { c, tLock } = beats(scroll.current);
    mat.opacity = 0.5 * Math.max(c, tLock);
    group.current.rotation.z -= Math.min(dt, 0.1) * 0.08;
  });
  return (
    <group ref={group} position={[0, LOCK_Y, -0.2]}>
      <mesh material={mat}><torusGeometry args={[2.35, 0.006, 6, 160]} /></mesh>
      <instancedMesh ref={ticks} args={[undefined, undefined, N]} material={mat}>
        <boxGeometry args={[1, 0.012, 0.01]} />
      </instancedMesh>
    </group>
  );
}

function Backdrop() {
  const texture = useMemo(() => {
    const cv = document.createElement("canvas"); cv.width = cv.height = 512;
    const ctx = cv.getContext("2d")!;
    const g = ctx.createRadialGradient(256, 236, 20, 256, 256, 300);
    g.addColorStop(0, "#24242a"); g.addColorStop(0.45, "#111114"); g.addColorStop(1, GROUND);
    ctx.fillStyle = g; ctx.fillRect(0, 0, 512, 512);
    // 도면 격자 — 있는 듯 없는 듯. 기술의 느낌은 이 정도면 충분하다.
    ctx.strokeStyle = "rgba(212,176,106,0.035)"; ctx.lineWidth = 1;
    for (let i = 0; i <= 512; i += 64) { ctx.beginPath(); ctx.moveTo(i + 0.5, 0); ctx.lineTo(i + 0.5, 512); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i + 0.5); ctx.lineTo(512, i + 0.5); ctx.stroke(); }
    const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.SRGBColorSpace; return tx;
  }, []);
  return (
    <mesh position={[0, 0, -8]}><planeGeometry args={[30, 30]} /><meshBasicMaterial map={texture} toneMapped={false} /></mesh>
  );
}

/** 카메라: 사인파를 겹친 유기적 흔들림 + 포인터. 이야기 진행에 따라 시선이 자물쇠로 올라간다. */
function Rig({ scroll }: { scroll: MutableRefObject<number> }) {
  const look = useMemo(() => new THREE.Vector3(0, 0.2, 0), []);
  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    const t = state.clock.elapsedTime;
    const { tIn, tLock } = beats(scroll.current);
    const nx = Math.sin(t * 0.21) * 0.6 + Math.sin(t * 0.53 + 1.3) * 0.3 + Math.sin(t * 1.1 + 2.1) * 0.1;
    const ny = Math.cos(t * 0.17 + 0.7) * 0.5 + Math.sin(t * 0.47 + 2.9) * 0.25 + Math.cos(t * 0.97) * 0.08;
    const cam = state.camera;
    cam.position.x = THREE.MathUtils.damp(cam.position.x, nx * 0.5 + state.pointer.x * 1.1, 1.6, d);
    cam.position.y = THREE.MathUtils.damp(cam.position.y, ny * 0.4 + state.pointer.y * 0.7 + 0.5 * tIn, 1.6, d);
    cam.position.z = THREE.MathUtils.damp(cam.position.z, THREE.MathUtils.lerp(9.5, 8.7, tLock), 3, d);
    look.y = THREE.MathUtils.damp(look.y, THREE.MathUtils.lerp(0.2, 0.7, tIn), 4, d);
    cam.lookAt(look);
  });
  return null;
}

/** 세로 화면에서는 무대 전체를 줄인다 — 숫자는 그대로 두고 배율만. */
function Stage({ children, scroll }: { children: ReactNode; scroll: MutableRefObject<number> }) {
  const g = useRef<THREE.Group>(null!);
  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    const portrait = state.viewport.aspect < 0.8;
    const { c } = beats(scroll.current);
    const tEnd = ph(scroll.current, 0.95, 1.0);
    const sc = portrait ? 0.68 : 1;
    // 돌린 열쇠는 정면에선 얇은 고리로만 보인다. 모이는 동안 무대를 돌려 3/4 시점을 만든다.
    const ry = THREE.MathUtils.lerp(0, -0.62, c);
    const x = portrait ? 0 : THREE.MathUtils.lerp(0, 2.3, tEnd);
    g.current.scale.setScalar(THREE.MathUtils.damp(g.current.scale.x, sc, 6, d));
    g.current.rotation.y = THREE.MathUtils.damp(g.current.rotation.y, ry, 5, d);
    g.current.position.x = THREE.MathUtils.damp(g.current.position.x, x, 5, d);
  });
  return <group ref={g}>{children}</group>;
}

export default function Scene({ scroll, eventSource }: { scroll: MutableRefObject<number>; eventSource: RefObject<HTMLElement | null> }) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
      camera={{ position: [0, 0.2, 9.5], fov: 34 }}
      eventSource={eventSource as RefObject<HTMLElement>}
      eventPrefix="client"
      onCreated={({ gl }) => gl.setClearColor(GROUND)}
    >
      <Rig scroll={scroll} />
      <Backdrop />
      <Stage scroll={scroll}>
        <Scatter scroll={scroll} />
        <Dial scroll={scroll} />
        <Lock scroll={scroll} />
        <Key scroll={scroll} />
      </Stage>
      <Environment resolution={256}>
        <Lightformer color="#fff4e2" intensity={5} rotation-x={Math.PI / 2} position={[0, 6, -9]} scale={[12, 12, 1]} />
        <Lightformer color="#f2ead8" intensity={2} rotation-y={Math.PI / 2} position={[-6, 1, -1]} scale={[12, 2.5, 1]} />
        <Lightformer color="#e9d7ae" intensity={2.4} rotation-y={-Math.PI / 2} position={[9, 1, 0]} scale={[18, 2.5, 1]} />
        <Lightformer color="#ffd9a0" intensity={1.8} form="ring" position={[-2.5, 3, 5]} scale={3.2} />
        <Lightformer color="#e6c98a" intensity={1.1} form="circle" position={[3, -2, 5]} scale={2} />
      </Environment>
      <EffectComposer>
        <Bloom intensity={0.85} luminanceThreshold={0.5} luminanceSmoothing={0.3} mipmapBlur radius={0.5} />
        <Vignette offset={0.3} darkness={0.65} />
      </EffectComposer>
    </Canvas>
  );
}
