import { useLayoutEffect, useMemo, useRef, type MutableRefObject, type ReactNode, type RefObject } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Environment, Lightformer, MeshTransmissionMaterial, RoundedBox } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { landPoints } from "./land";
import { REGIONS } from "./regions";

const GROUND = "#070708";
const GOLD = "#d4b06a";
const GOLD_HI = "#f1d9a3";
const GOLD_LO = "#8a7440";
const STEEL = "#b9bcc2";
const STEEL_LO = "#63666c";
const WARM = "#e8e2d4";

const LOCK_Y = 0.7;
const LOCK_START_Y = 6.2;   // 세로 화면은 무대가 0.68배라, 4.6이면 첫 화면 위에 걸친다
const KEY_SCALE_OPEN = 0.88;
const KEY_SCALE_IN = 0.52;
const KEY_Y_IN = -0.3;

const GLOBE_R = 4.05;                                  // 뒤에 뜬 지구본
const GLOBE_AT = new THREE.Vector3(0, -0.35, -6.4);    // 자물쇠 뒤, 아래로 조금
const TILT = (23.4 * Math.PI) / 180;                   // 지구의 자전축 기울기
const AXIS_Y = new THREE.Vector3(0, 1, 0);
const SEG = 34;                                        // 연결선 분할
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

/* ---------------------------------------------------------------- 지구본 */

/** 위경도(도) → 구 위의 점. 경도 0이 +x, 북극이 +y. */
function onSphere(lat: number, lon: number, r: number, out: THREE.Vector3) {
  const a = (lat * Math.PI) / 180;
  const b = (lon * Math.PI) / 180;
  return out.set(Math.cos(a) * Math.cos(b) * r, Math.sin(a) * r, Math.cos(a) * Math.sin(b) * r);
}

/** 사각 픽셀 대신 동그란 점을 찍으려고 스프라이트를 즉석에서 굽는다. 외부 요청은 없다. */
function dotSprite() {
  const s = 32;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const g = cv.getContext("2d")!;
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.9)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const bez = (a: THREE.Vector3, m: THREE.Vector3, b: THREE.Vector3, u: number, out: THREE.Vector3) => {
  const v = 1 - u, k0 = v * v, k1 = 2 * v * u, k2 = u * u;
  return out.set(k0 * a.x + k1 * m.x + k2 * b.x, k0 * a.y + k1 * m.y + k2 * b.y, k0 * a.z + k1 * m.z + k2 * b.z);
};

function Network({ scroll }: { scroll: MutableRefObject<number> }) {
  const spin = useRef<THREE.Group>(null!);
  const body = useRef<THREE.Group>(null!);
  const marks = useRef<THREE.InstancedMesh>(null!);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const angle = useRef(0.9);

  const qTilt = useMemo(() => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), TILT), []);
  const qSpin = useMemo(() => new THREE.Quaternion(), []);
  const q = useMemo(() => new THREE.Quaternion(), []);
  const vA = useMemo(() => new THREE.Vector3(), []);
  const vM = useMemo(() => new THREE.Vector3(), []);
  const vP = useMemo(() => new THREE.Vector3(), []);
  const vN = useMemo(() => new THREE.Vector3(), []);
  const LOCK = useMemo(() => new THREE.Vector3(0, 0, 0), []);

  const landMat = useMemo(() => new THREE.PointsMaterial({
    size: 0.075, sizeAttenuation: true, vertexColors: true, map: dotSprite(),
    transparent: true, depthWrite: false, toneMapped: false,
  }), []);
  const seaMat = useMemo(() => new THREE.PointsMaterial({
    size: 0.05, sizeAttenuation: true, color: "#2a2f39", map: dotSprite(),
    transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false,
  }), []);
  const ringMat = useMemo(() => new THREE.LineBasicMaterial({
    color: GOLD_LO, transparent: true, opacity: 0.3, depthWrite: false,
  }), []);
  const linkMat = useMemo(() => new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false, blending: THREE.AdditiveBlending,
  }), []);

  /* 육지 — 빌드 때 구워둔 Natural Earth 격자를 구 위에 얹는다 */
  const landGeo = useMemo(() => {
    const ll = landPoints();
    const n = ll.length / 2;
    const pos = new Float32Array(n * 3);
    const t = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      onSphere(ll[i * 2 + 1] / 100, ll[i * 2] / 100, GLOBE_R, t);
      pos[i * 3] = t.x; pos[i * 3 + 1] = t.y; pos[i * 3 + 2] = t.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    return g;
  }, []);

  /* 바다 — 피보나치 구면 분포. 육지만으로는 구의 아래쪽이 비어 잘려 보인다 */
  const seaGeo = useMemo(() => {
    const n = 2600, golden = Math.PI * (3 - Math.sqrt(5));
    const pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2, ring = Math.sqrt(Math.max(0, 1 - y * y)), th = golden * i;
      pos[i * 3] = Math.cos(th) * ring * GLOBE_R;
      pos[i * 3 + 1] = y * GLOBE_R;
      pos[i * 3 + 2] = Math.sin(th) * ring * GLOBE_R;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    return g;
  }, []);

  /* 자전축과 어긋나게 걸친 금 테 하나 — 혼천의처럼, 칠이 아니라 테두리로 */
  const ringGeo = useMemo(() => {
    const p: number[] = [];
    const r = GLOBE_R * 1.045;
    for (let i = 0; i < 180; i++) {
      const a0 = (i / 180) * TAU, a1 = ((i + 1) / 180) * TAU;
      p.push(Math.cos(a0) * r, 0, Math.sin(a0) * r, Math.cos(a1) * r, 0, Math.sin(a1) * r);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(p, 3));
    return g;
  }, []);

  /* 거점 — 실제 리전 좌표. 구 표면에서 살짝 띄운다 */
  const sites = useMemo(() => {
    const r = rng(29);
    return REGIONS.map(([lat, lon, major]) => ({
      at: onSphere(lat, lon, GLOBE_R * 1.012, new THREE.Vector3()),
      size: major ? 0.052 : 0.032,
      major,
      delay: r(),
    }));
  }, []);

  /* 연결선은 자전하지 않는 공간에 있다 — 끝점이 자물쇠에 붙어 있어야 하므로
     매 프레임 시작점을 자전시킨 위치로 다시 굽는다 */
  const linkGeo = useMemo(() => {
    const n = sites.length * SEG * 2;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(new Float32Array(n * 3), 3));
    return g;
  }, [sites]);

  useLayoutEffect(() => {
    const col = new THREE.Color();
    sites.forEach((s, i) => marks.current.setColorAt(i, col.set(s.major ? WARM : "#8d949f")));
    if (marks.current.instanceColor) marks.current.instanceColor.needsUpdate = true;
  }, [sites]);

  useFrame((state, dt) => {
    const d = Math.min(dt, 0.1);
    const t = state.clock.elapsedTime;
    const { tWire, c, tLock } = beats(scroll.current);

    angle.current += d * 0.045;
    spin.current.rotation.y = angle.current;
    const sa = Math.sin(angle.current), ca = Math.cos(angle.current);

    // 모여드는 동안 지구본은 뒤로 물러나 자물쇠에 자리를 내준다
    const recede = THREE.MathUtils.lerp(1, 0.84, c);
    body.current.scale.setScalar(THREE.MathUtils.damp(body.current.scale.x, recede, 4, d));

    /* 육지: 앞면은 밝게, 뒷면은 비칠 만큼만. 이 명암차가 공을 공으로 읽히게 한다 */
    const lc = landGeo.attributes.color.array as Float32Array;
    const lp = landGeo.attributes.position.array as Float32Array;
    const dim = 1 - 0.8 * c;
    for (let i = 0, n = lc.length; i < n; i += 3) {
      const nz = (-lp[i] * sa + lp[i + 2] * ca) / GLOBE_R;
      const f = smooth(Math.min(1, Math.max(0, (nz + 0.6) / 1.45)));
      const b = (0.14 + 0.92 * f) * dim;
      lc[i] = b * 0.74; lc[i + 1] = b * 0.78; lc[i + 2] = b * 0.88;
    }
    landGeo.attributes.color.needsUpdate = true;
    seaMat.opacity = 0.85 * dim;
    ringMat.opacity = 0.3 * dim;

    /* 거점을 자전시켜 세계 좌표로 옮기고, 거기서 자물쇠까지 선을 굽는다 */
    qSpin.setFromAxisAngle(AXIS_Y, angle.current);
    q.copy(qTilt).multiply(qSpin);

    const lk = linkGeo.attributes.position.array as Float32Array;
    const kc = linkGeo.attributes.color.array as Float32Array;
    const fade = 1 - ph(scroll.current, 0.88, 0.97);
    let k = 0;

    for (let i = 0; i < sites.length; i++) {
      const s = sites[i];
      vA.copy(s.at).applyQuaternion(q).add(GLOBE_AT);

      // 지구 반대편의 거점은 선도 점도 희미하다 — 돌면서 이쪽으로 넘어올 때 켜진다
      const nz = (-s.at.x * sa + s.at.z * ca) / (GLOBE_R * 1.012);
      const face = THREE.MathUtils.lerp(smooth(Math.min(1, Math.max(0, (nz + 0.25) / 0.9))), 1, c);

      // 표면에서 한 번 부풀었다가 자물쇠로 빨려 들어간다
      vN.copy(vA).sub(GLOBE_AT).normalize();
      vM.copy(vA).lerp(LOCK, 0.44).addScaledVector(vN, 1.15);
      vM.y += 0.5;

      const stagger = (i / sites.length) * 0.5;
      const draw = Math.min(1, Math.max(0, (tWire - stagger) / (1 - stagger)));
      const head = (t * 0.55 + i * 0.19) % 1;

      for (let j = 0; j < SEG; j++) {
        for (const u of [j / SEG, (j + 1) / SEG]) {
          bez(vA, vM, LOCK, u, vP);
          lk[k] = vP.x; lk[k + 1] = vP.y; lk[k + 2] = vP.z;

          const on = u <= draw ? 1 : 0;
          const dd = u - head;
          const pulse = Math.exp(-(dd * dd) / 0.0022);
          const base = on * fade * face * 0.17;
          const beam = on * fade * face * 1.7 * pulse * (0.3 + 0.7 * c);
          // 선은 따뜻한 흰빛, 지나가는 빛줄기만 금기를 띤다
          kc[k] = base * 0.91 + beam * 0.83;
          kc[k + 1] = base * 0.89 + beam * 0.69;
          kc[k + 2] = base * 0.83 + beam * 0.42;
          k += 3;
        }
      }

      /* 거점: 선을 타고 자물쇠로 내려가 흡수된다 */
      const local = smooth(Math.min(1, Math.max(0, (c - s.delay * 0.45) / 0.55)));
      bez(vA, vM, LOCK, local, vP);
      dummy.position.copy(vP);
      const absorb = smooth(Math.max(0, (local - 0.86) / 0.14));
      const idle = 1 + (s.major ? Math.sin(t * 1.2 + i) * 0.12 : 0);
      dummy.scale.setScalar(s.size * idle * face * (1 - absorb) * (1 - tLock * 0.6));
      dummy.updateMatrix();
      marks.current.setMatrixAt(i, dummy.matrix);
    }

    linkGeo.attributes.position.needsUpdate = true;
    linkGeo.attributes.color.needsUpdate = true;
    marks.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <group ref={body} position={[0, LOCK_Y, 0]}>
      <group position={GLOBE_AT} rotation-z={TILT}>
        <group ref={spin}>
          <points geometry={seaGeo} material={seaMat} />
          <points geometry={landGeo} material={landMat} />
        </group>
        <lineSegments geometry={ringGeo} material={ringMat} rotation-x={0.3} />
      </group>
      <lineSegments geometry={linkGeo} material={linkMat} frustumCulled={false} />
      <instancedMesh ref={marks} args={[undefined, undefined, REGIONS.length]} frustumCulled={false}>
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
    // 카메라가 움직이면 멀리 있는 지구본이 가장 크게 흔들린다. 좁은 화면에서는
    // 그 폭만큼 지구본이 화면 밖으로 밀려나므로 흔들림을 줄인다.
    const amp = state.viewport.aspect < 0.8 ? 0.34 : 1;
    cam.position.x = THREE.MathUtils.damp(cam.position.x, (nx * 0.5 + state.pointer.x * 1.1) * amp, 1.6, d);
    cam.position.y = THREE.MathUtils.damp(cam.position.y, (ny * 0.4 + state.pointer.y * 0.7) * amp + 0.5 * tIn, 1.6, d);
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
