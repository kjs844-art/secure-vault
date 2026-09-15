import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.env.OUT ?? "./screenshots";
const URL = process.env.TARGET ?? "http://localhost:4173/";

mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  // 컨테이너에 미리 설치된 Chromium을 쓴다. CHROME_PATH로 덮어쓸 수 있다.
  executablePath: process.env.CHROME_PATH || undefined,
  args: [
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
  ],
});

const shots = [
  { name: "desktop", width: 1440, height: 900, pointer: { x: 1000, y: 380 } },
  { name: "desktop-wide", width: 1728, height: 1000, pointer: { x: 1200, y: 300 } },
  { name: "phone", width: 390, height: 844, pointer: null },
];

for (const s of shots) {
  const page = await browser.newPage({ viewport: { width: s.width, height: s.height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));

  await page.goto(URL, { waitUntil: "networkidle" });
  if (s.pointer) await page.mouse.move(s.pointer.x, s.pointer.y);
  // WebGL 첫 프레임과 폰트 로드를 기다린다
  await page.waitForTimeout(4000);

  const gl = await page.evaluate(() => {
    const c = document.querySelector("canvas");
    if (!c) return "NO CANVAS";
    const ctx = c.getContext("webgl2") || c.getContext("webgl");
    return ctx ? `canvas ${c.width}x${c.height} · ${ctx.getParameter(ctx.VERSION)}` : "NO GL CONTEXT";
  });

  await page.screenshot({ path: `${OUT}/${s.name}.png` });
  console.log(`${s.name.padEnd(13)} ${gl}`);
  if (errors.length) console.log(`  !! ${errors.slice(0, 4).join(" | ")}`);
  await page.close();
}

await browser.close();
