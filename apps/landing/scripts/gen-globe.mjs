/**
 * 지구본 점 데이터를 빌드 시점에 한 번 굽는다.
 *
 * 런타임에 topojson/d3-geo를 들고 다니지 않으려고 여기서 육지 판정을 끝내고
 * 위경도만 Int16(1/100도)로 눌러 담는다. 결과는 src/landing/land.ts 한 장이다.
 *
 * 데이터: Natural Earth 1:110m 육지 (world-atlas), 퍼블릭 도메인.
 */
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { feature } from "topojson-client";
import { geoContains } from "d3-geo";

const require = createRequire(import.meta.url);
const topo = require("world-atlas/land-110m.json");
const land = feature(topo, topo.objects.land);

/* 위도가 높아질수록 경도 간격을 벌려 구 위에서 점 간격이 일정하게 보이게 한다 */
const STEP = 1.45;
const pts = [];
for (let lat = -85; lat <= 84; lat += STEP) {
  const cos = Math.cos((lat * Math.PI) / 180);
  const n = Math.max(1, Math.round((360 / STEP) * cos));
  for (let i = 0; i < n; i++) {
    const lon = -180 + (i / n) * 360;
    if (geoContains(land, [lon, lat])) pts.push(lon, lat);
  }
}

const buf = new Int16Array(pts.length);
for (let i = 0; i < pts.length; i++) buf[i] = Math.round(pts[i] * 100);
const b64 = Buffer.from(buf.buffer).toString("base64");

const out = `/* 생성된 파일 — \`npm run gen:globe\`로 다시 만든다. 손으로 고치지 않는다.
 * Natural Earth 1:110m 육지(퍼블릭 도메인)를 ${STEP}° 격자로 훑어 육지에 떨어진
 * 점만 남긴 것. Int16 1/100도 쌍(lon, lat)을 base64로 담았다. ${pts.length / 2}점. */

const PACKED =
  "${b64}";

/** 육지 점의 위경도(도). [lon, lat, lon, lat, ...] */
export function landPoints(): Int16Array {
  const bin = atob(PACKED);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export const LAND_COUNT = ${pts.length / 2};
`;

writeFileSync(new URL("../src/landing/land.ts", import.meta.url), out);
console.log(`land.ts: ${pts.length / 2} points, ${(b64.length / 1024).toFixed(1)}KB base64`);
