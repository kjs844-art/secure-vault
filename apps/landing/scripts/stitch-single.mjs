/** dist-single/의 JS·CSS·파비콘을 index.html 안에 넣어 파일 하나로 만든다. */
import fs from "node:fs";
import path from "node:path";

const dir = "dist-single";
let html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const esc = (s) => s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");

html = html.replace(/<script type="module"[^>]*src="\.\/(assets\/[^"]+\.js)"><\/script>/, (_, f) =>
  `<script type="module">${esc(fs.readFileSync(path.join(dir, f), "utf8"))}</script>`);
html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/(assets\/[^"]+\.css)">/, (_, f) =>
  `<style>${fs.readFileSync(path.join(dir, f), "utf8")}</style>`);
const fav = fs.readFileSync("public/favicon.svg", "utf8");
html = html.replace(/<link rel="icon"[^>]*>/, `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;utf8,${encodeURIComponent(fav)}">`);
if (/(src|href)="\.\/assets/.test(html)) throw new Error("외부 참조가 남아 있음");

const out = path.join(dir, "keyatlas-landing.html");
fs.writeFileSync(out, html);
console.log(`${out}: ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
