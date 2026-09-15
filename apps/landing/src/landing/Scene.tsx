import { useLayoutEffect, useMemo, useRef, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Lightformer, MeshTransmissionMaterial, RoundedBox } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

const GROUND = "#070708";
const GOLD = "#d4b06a";
const GOLD_HI = "#f1d9a3";
const GOLD_LO = "#8a7440";
const STEEL = "#b9bcc2";
const STEEL_LO = "#63666c";
const WARM = "#e8e2d4";

const LOCK_Y = 0.7;
const LOCK_START_Y = 4.6;
const KEY_SCALE_OPEN = 0.88;
const KEY_SCALE_IN = 0.52;
const KEY_Y_IN = -0.3;

const GLOBE_R = 2.95;
const NODES = 150;   // 구 표면에 흩어진 서비스·개인정보
const LINKED = 46;  // 그중 자물쇠로 이어지는 것
const SEG = 34;     // 연결선 분할
const TAU = Math.PI * 2;

const smooth = (t: number) => t * t * (3 - 2 * t);
const ph = (s: number, a: number, b: number) => smooth(Math.min(1, Math.max(0, (s - a) / (b - a))));
/* 걸쇠가 닫힐 때 살짝 튕기는 느낌 */
const back = (t: number) => { const c = 1.7, u = t - 1; return 1 + (c + 1) * u * u * u + c * u * u; };

function beats(s: number) {
  return {
    tIn: ph(s, 0.10, 0.34),    // 자물쇠 하강 + 열쇠 삽입
    tTurn: ph(s, 0.34, 0.48),  // 열쇠 회전
    tWire: ph(s, 0.36, 0.64),  // 연결선이 그려진다
    c: ph(s, 0.48, 0.82),      // 정보가 모여든다
    tLock: ph(s, 0.82, 0.93),  // 잠긴다
    tEnd: ph(s, 0.95, 1.0),    // 비켜선다
    flash: Math.exp(-(((s - 0.935) / 0.022) ** 2)),
  };
}

function rng(seed: number) {
  let x = seed;
  return () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
}

function Glass({ soft = false }: { soft?: boolean }) {
  return (
    <MeshTransmissionMaterial
      backside samples={6} resolution={512}
      thickness={soft ? 0.26 : 0.55} roughness={soft ? 0.1 : 0.06} ior={soft ? 1.36 : 1.46}
      chromaticAberration={soft ? 0.06 : 0.16} anisotropy={soft ? 0.1 : 0.25}
      distortion={soft ? 0.04 : 0.18} distortionScale={0.35} temporalDistortion={soft ? 0.02 : 0.08}
      color="#f4f2ec" attenuationColor="#d9d2c0" attenuationDistance={soft ? 3.8 : 2.2}
    />
  );
}

/* ---------------------------------------------------------------- 네트워크 */

/**
 * 뒤에 도는 격자 구, 그 표면에 흩어진 정보, 그리고 자물쇠로 이어지는 연결선.
 * 전부 한 그룹 안에서 함께 돈다 — 중심(0,0,0)은 회전해도 제자리라 선이 어긋나지 않는다.
 */
function Network({ scroll }: { scroll: MutableRefObject<number> }) {
  const spin = useRef<THREE.Group>(null!);
  const dots = useRef<THREE.InstancedMesh>(null!);
  const lines = useRef<THREE.LineSegments>(null!);
  const dummy = useMemo(() => new THREE.Object3D(), []);

  const wireMat = useMemo(
    () => new THREE.LineBasicMaterial({ color: "#9aa3b2", transparent: true, opacity: 0.1, depthWrite: false }), []);
  const linkMat = useMemo(
    () => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending }), []);

  /* 경위선 격자 — 삼각형 대각선 없이 지구본처럼 */
  const globeGeo = useMemo(() => {
    const p: number[] = [];
    for (let i = 1; i < 8; i++) {
      const phi = (i / 8) * Math.PI, r = Math.sin(phi) * GLOBE_R, y = Math.cos(phi) * GLOBE_R;
      for (let j = 0; j < 72; j++) {
        const a0 = (j / 72) * TAU, a1 = ((j + 1) / 72) * TAU;
        p.push(Math.cos(a0) * r, y, Math.sin(a0) * r, Math.cos(a1) * r, y, Math.sin(a1) * r);
      }
    }
    for (let k = 0; k < 12; k++) {
      const th = (k / 12) * TAU;
      for (let j = 0; j < 36; j++) {
        const b0 = (j / 36) * Math.PI, b1 = ((j + 1) / 36) * Math.PI;
        p.push(Math.sin(b0) * Math.cos(th) * GLOBE_R, Math.cos(b0) * GLOBE_R, Math.sin(b0) * Math.sin(th) * GLOBE_R,
               Math.sin(b1) * Math.cos(th) * GLOBE_R, Math.cos(b1) * GLOBE_R, Math.sin(b1) * Math.sin(th) * GLOBE_R);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    return g;
  }, []);

  /* 피보나치 구면 분포 — 뭉침 없이 고르게 */
  const nodes = useMemo(() => {
    const r = rng(11), golden = Math.PI * (3 - Math.sqrt(5));
    return Array.from({ length: NODES }, (_, i) => {
      const y = 1 - (i / (NODES - 1)) * 2, ring = Math.sqrt(Math.max(0, 1 - y * y)), th = golden * i;
      const rad = GLOBE_R * (0.97 + r() * 0.06);
      return {
        pos: new THREE.Vector3(Math.cos(th) * ring * rad, y * rad, Math.sin(th) * ring * rad),
        size: 0.028 + r() * 0.038,
        bright: r() < 0.3,
        delay: r(),
      };
    });
  }, []);

  /* 연결선: 표면의 점에서 중심으로 휘어 들어가는 곡선 */
  const { linkGeo, curves } = useMemo(() => {
    const pos: number[] = [];
    const curves: THREE.Vector3[][] = [];
    const end = new THREE.Vector3(0, 0, 0);
    for (let i = 0; i < LINKED; i++) {
      const a = nodes[i].pos;
      const mid = a.clone().multiplyScalar(0.92);
      mid.x += a.z * 0.42; mid.z -= a.x * 0.42; mid.y += 0.35; // 구 바깥으로 휘감았다 들어온다
      const pts = new THREE.QuadraticBezierCurve3(a, mid, end).getPoints(SEG);
      curves.push(pts);
      for (let j = 0; j < SEG; j++) {
        pos.push(pts[j].x, pts[j].y, pts[j].z, pts[j + 1].x, pts[j + 1].y, pts[j + 1].z);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(pos.length), 3));
    return { linkGeo: g, curves };
  }, [nodes]);

  useLayoutEffect(() => {
    const col = new THREE.Color();
    nodes.forEach((n, i) => dots.current.setColorAt(i, col.set(n.bright ? WARM : "#6f6c66")));
    if (dots.current.instanceColor) dots.current.instanceColor.needsUpdate = true;
  }, [nodes]);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    const t = state.clock.elapsedTime;
    const { tWire, c, tLock } = beats(scroll.current);

    spin.current.rotation.y += d * 0.03;
    // 모여드는 동안 구가 안으로 조여든다 — "한 곳으로"를 형태로 말한다
    const shrink = THREE.MathUtils.lerp(1, 0.45, c);
    spin.current.scale.setScalar(THREE.MathUtils.damp(spin.current.scale.x, shrink, 4, d));
    wireMat.opacity = 0.085 + 0.13 * tWire;

    /* 선: 표면에서 중심 쪽으로 그어지고, 그 위를 빛이 흘러 내려간다 */
    const col = linkGeo.attributes.color.array as Float32Array;
    const fade = 1 - ph(scroll.current, 0.88, 0.97);
    let k = 0;
    for (let i = 0; i < LINKED; i++) {
      const stagger = (i / LINKED) * 0.5;
      const draw = Math.min(1, Math.max(0, (tWire - stagger) / (1 - stagger)));
      const head = (t * 0.55 + i * 0.19) % 1;
      for (let j = 0; j < SEG; j++) {
        for (const u of [j / SEG, (j + 1) / SEG]) {
          const on = u <= draw ? 1 : 0;
          const dd = u - head;
          const pulse = Math.exp(-(dd * dd) / 0.0022);
          const base = on * fade * 0.2;
          const beam = on * fade * 1.7 * pulse * (0.3 + 0.7 * c);
          // 선은 따뜻한 흰빛, 지나가는 빛줄기만 금기를 띤다
          col[k++] = base * 0.91 + beam * 0.83;
          col[k++] = base * 0.89 + beam * 0.69;
          col[k++] = base * 0.83 + beam * 0.42;
        }
      }
    }
    linkGeo.attributes.color.needsUpdate = true;

    /* 점: 연결된 것은 선을 타고 중심으로 빨려들고, 나머지는 자리를 지키다 사그라든다 */
    nodes.forEach((n, i) => {
      if (i < LINKED) {
        const local = smooth(Math.min(1, Math.max(0, (c - n.delay * 0.45) / 0.55)));
        const idx = Math.min(SEG, Math.round(local * SEG));
        dummy.position.copy(curves[i][idx]);
        const absorb = smooth(Math.max(0, (local - 0.86) / 0.14));
        dummy.scale.setScalar(n.size * (1 - absorb));
      } else {
        dummy.position.copy(n.pos);
        dummy.position.y += Math.sin(t * 0.4 + i) * 0.06;
        dummy.scale.setScalar(n.size * (1 - 0.75 * c) * (1 - tLock * 0.8));
      }
      dummy.updateMatrix();
      dots.current.setMatrixAt(i, dummy.matrix);
    });
    dots.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group ref={spin} position={[0, LOCK_Y, 0]}>
      <lineSegments geometry={globeGeo} material={wireMat} />
      <lineSegments ref={lines} geometry={linkGeo} material={linkMat} />
      <instancedMesh ref={dots} args={[undefined, undefined, NODES]} frustumCulled={false}>
        <sphereGeometry args={[1, 10, 10]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
}

/* ---------------------------------------------------------------- 열쇠 */

function Key({ scroll }: { scroll: MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null!);
  const spin = useRef(0);
  const first = useRef(true);

  const geometry = useMemo(() => {
    const parts: THREE.BufferGeometry[] = [];
    const add = (g: THREE.BufferGeometry, x: number, y: number) => { g.translate(x, y, 0); parts.push(g); };
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

    if (tIn === 0) spin.current += d * 0.28;
    const aligned = Math.round(spin.current / TAU) * TAU;
    const ry = THREE.MathUtils.lerp(spin.current, aligned, tIn) + (Math.PI / 2) * tTurn;
    const rx = THREE.MathUtils.lerp(0.18 + state.pointer.y * 0.22 + Math.sin(t * 0.4) * 0.05, 0, tIn);
    const rz = THREE.MathUtils.lerp(-0.22 - state.pointer.x * 0.16, Math.PI, tIn);
    const y = THREE.MathUtils.lerp(0, KEY_Y_IN, tIn);
    const sc = THREE.MathUtils.lerp(KEY_SCALE_OPEN, KEY_SCALE_IN, tIn);

    if (first.current) {
      first.current = false;
      g.rotation.set(rx, ry, rz); g.position.y = y; g.scale.setScalar(sc);
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

/* ---------------------------------------------------------------- 자물쇠 */

/** 금속 장식은 유리 표면 바로 앞에 둔다 — 유리 안에 넣으면 굴절에 뭉개진다. */
function Face({ z }: { z: number }) {
  const rivets: [number, number][] = [[-0.79, 0.69], [0.79, 0.69], [-0.79, -0.69], [0.79, -0.69]];
  return (
    <group position={[0, 0, z]} scale={[1, 1, Math.sign(z)]}>
      <mesh><torusGeometry args={[0.78, 0.007, 8, 80]} /><meshStandardMaterial color={STEEL_LO} metalness={1} roughness={0.4} /></mesh>
      <mesh><torusGeometry args={[0.53, 0.03, 14, 72]} /><meshStandardMaterial color={GOLD} metalness={1} roughness={0.2} /></mesh>
      <mesh><torusGeometry args={[0.47, 0.006, 8, 64]} /><meshStandardMaterial color={STEEL} metalness={1} roughness={0.3} /></mesh>
      {rivets.map(([x, y], i) => (
        <mesh key={i} position={[x, y, 0.012]} rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[0.052, 0.052, 0.024, 14]} />
          <meshStandardMaterial color={STEEL} metalness={1} roughness={0.28} />
        </mesh>
      ))}
      <mesh position={[0, -0.73, 0.01]}><boxGeometry args={[1.26, 0.005, 0.005]} /><meshStandardMaterial color={STEEL_LO} metalness={1} roughness={0.45} /></mesh>
    </group>
  );
}

function Lock({ scroll }: { scroll: MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null!);
  const hinge = useRef<THREE.Group>(null!);
  const glowMat = useRef<THREE.MeshBasicMaterial>(null!);
  const first = useRef(true);
  const starMat = useMemo(() => new THREE.MeshBasicMaterial({ color: "#4a4638", toneMapped: false }), []);
  const dim = useMemo(() => new THREE.Color("#4a4638"), []);
  const lit = useMemo(() => new THREE.Color("#ece4d2"), []);
  const tmp = useMemo(() => new THREE.Color(), []);

  /* 걸쇠: 오른쪽 다리를 축으로 돌아 열린다. 실제 자물쇠처럼 몸통에서 떨어지지 않는다. */
  const shackleGeo = useMemo(() => {
    const arc = new THREE.TorusGeometry(0.56, 0.092, 22, 56, Math.PI); arc.translate(0, 0.76, 0);
    const l = new THREE.CylinderGeometry(0.092, 0.092, 0.8, 22); l.translate(-0.56, 0.36, 0);
    const r = new THREE.CylinderGeometry(0.092, 0.092, 0.8, 22); r.translate(0.56, 0.36, 0);
    const m = mergeGeometries([arc, l, r], false)!;
    [arc, l, r].forEach((g) => g.dispose());
    m.translate(-0.56, 0, 0); // 축을 오른쪽 다리로
    return m;
  }, []);

  const stars = useMemo(() => {
    const r = rng(7);
    return Array.from({ length: 18 }, () => [(r() - 0.5) * 1.35, (r() - 0.5) * 1.1, (r() - 0.5) * 0.4, 0.018 + r() * 0.018] as const);
  }, []);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    const { tIn, c, tLock, flash } = beats(scroll.current);
    const g = group.current;
    const y = THREE.MathUtils.lerp(LOCK_START_Y, LOCK_Y, tIn);
    const ry = state.pointer.x * 0.12;
    const drop = back(tLock);
    const swing = 0.62 * (1 - drop);   // 열렸을 때 벌어진 각
    const lift = 0.16 * (1 - drop);    // 살짝 들림

    if (first.current) {
      first.current = false;
      g.position.y = y; g.rotation.y = ry;
      hinge.current.rotation.y = swing; hinge.current.position.y = lift;
    } else {
      g.position.y = THREE.MathUtils.damp(g.position.y, y, 8, d);
      g.rotation.y = THREE.MathUtils.damp(g.rotation.y, ry, 3, d);
      hinge.current.rotation.y = THREE.MathUtils.damp(hinge.current.rotation.y, swing, 10, d);
      hinge.current.position.y = THREE.MathUtils.damp(hinge.current.position.y, lift, 10, d);
    }
    starMat.color.copy(tmp.copy(dim).lerp(lit, c));
    glowMat.current.opacity = Math.min(0.4, 0.03 + 0.15 * c + 0.38 * flash);
  });

  return (
    <group ref={group} position={[0, LOCK_START_Y, 0]}>
      <RoundedBox args={[2.0, 1.78, 0.78]} radius={0.14} smoothness={5}><Glass soft /></RoundedBox>
      <Face z={0.395} />
      <Face z={-0.395} />

      {/* 열쇠길과 그 둘레의 금 테 */}
      <mesh position={[0, -0.3, 0]}><cylinderGeometry args={[0.17, 0.17, 1.25, 20]} /><meshBasicMaterial color="#05060a" /></mesh>
      <mesh position={[0, -0.88, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.22, 0.024, 12, 40]} />
        <meshStandardMaterial color={STEEL} metalness={1} roughness={0.24} />
      </mesh>

      {/* 모여든 정보 */}
      {stars.map(([x, y, z, s], i) => (
        <mesh key={i} position={[x, y, z]} material={starMat}><sphereGeometry args={[s, 12, 12]} /></mesh>
      ))}
      <mesh><sphereGeometry args={[0.47, 24, 24]} /><meshBasicMaterial ref={glowMat} color="#ddd3bb" transparent opacity={0.03} toneMapped={false} depthWrite={false} /></mesh>

      {/* 걸쇠 */}
      <group position={[0.56, 0.87, 0]}>
        <group ref={hinge}>
          <mesh geometry={shackleGeo}><meshStandardMaterial color={STEEL} metalness={1} roughness={0.16} envMapIntensity={0.8} /></mesh>
        </group>
      </group>
    </group>
  );
}

/* ---------------------------------------------------------------- 다이얼·배경·리그 */

function Dial({ scroll }: { scroll: MutableRefObject<number> }) {
  const group = useRef<THREE.Group>(null!);
  const ticks = useRef<THREE.InstancedMesh>(null!);
  const mat = useMemo(() => new THREE.MeshBasicMaterial({ color: GOLD, transparent: true, opacity: 0, toneMapped: false, depthWrite: false }), []);
  const N = 72;
  useLayoutEffect(() => {
    const d = new THREE.Object3D();
    for (let i = 0; i < N; i++) {
      const a = (i / N) * TAU;
      d.position.set(Math.cos(a) * 1.98, Math.sin(a) * 1.98, 0);
      d.rotation.set(0, 0, a);
      d.scale.set(i % 6 === 0 ? 0.11 : 0.05, 1, 1);
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
      <mesh material={mat}><torusGeometry args={[1.92, 0.005, 6, 160]} /></mesh>
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
    ctx.strokeStyle = "rgba(212,176,106,0.035)"; ctx.lineWidth = 1;
    for (let i = 0; i <= 512; i += 64) {
      ctx.beginPath(); ctx.moveTo(i + 0.5, 0); ctx.lineTo(i + 0.5, 512); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i + 0.5); ctx.lineTo(512, i + 0.5); ctx.stroke();
    }
    const tx = new THREE.CanvasTexture(cv); tx.colorSpace = THREE.SRGBColorSpace; return tx;
  }, []);
  return <mesh position={[0, 0, -12]}><planeGeometry args={[42, 42]} /><meshBasicMaterial map={texture} toneMapped={false} /></mesh>;
}

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

function Stage({ children, scroll }: { children: ReactNode; scroll: MutableRefObject<number> }) {
  const g = useRef<THREE.Group>(null!);
  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    const portrait = state.viewport.aspect < 0.8;
    const { c, tEnd } = beats(scroll.current);
    g.current.scale.setScalar(THREE.MathUtils.damp(g.current.scale.x, portrait ? 0.68 : 1, 6, d));
    g.current.rotation.y = THREE.MathUtils.damp(g.current.rotation.y, THREE.MathUtils.lerp(0, -0.55, c), 5, d);
    g.current.position.x = THREE.MathUtils.damp(g.current.position.x, portrait ? 0 : THREE.MathUtils.lerp(0, 2.3, tEnd), 5, d);
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
        <Network scroll={scroll} />
        <Dial scroll={scroll} />
        <Lock scroll={scroll} />
        <Key scroll={scroll} />
      </Stage>
      <Environment resolution={256}>
        <Lightformer color="#fff4e2" intensity={5} rotation-x={Math.PI / 2} position={[0, 6, -9]} scale={[12, 12, 1]} />
        <Lightformer color="#eef0f4" intensity={2} rotation-y={Math.PI / 2} position={[-6, 1, -1]} scale={[12, 2.5, 1]} />
        <Lightformer color="#e8ecf2" intensity={2.3} rotation-y={-Math.PI / 2} position={[9, 1, 0]} scale={[18, 2.5, 1]} />
        <Lightformer color="#ffe3bb" intensity={1.7} form="ring" position={[-2.5, 3, 5]} scale={3.2} />
        <Lightformer color="#e6c98a" intensity={1.1} form="circle" position={[3, -2, 5]} scale={2} />
      </Environment>
      <EffectComposer>
        <Bloom intensity={0.85} luminanceThreshold={0.5} luminanceSmoothing={0.3} mipmapBlur radius={0.5} />
        <Vignette offset={0.3} darkness={0.65} />
      </EffectComposer>
    </Canvas>
  );
}
