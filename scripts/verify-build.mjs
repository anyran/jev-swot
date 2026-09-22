import { readdir, readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../dist/manifest.json", import.meta.url), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("dist manifest is not MV3");
const contentPath = new URL(`../dist/${manifest.content_scripts[0].js[0]}`, import.meta.url);
const content = await readFile(contentPath, "utf8");
if (/^\s*(?:import|export)(?:\s|[({"])/m.test(content)) throw new Error("Chrome content script contains ESM import/export and cannot execute as a classic manifest script");
for (const size of [16, 32, 48, 128]) await readFile(new URL(`../dist/icons/icon-${size}.png`, import.meta.url));
for (const document of ["LICENSE", "THIRD_PARTY_NOTICES.md", "PRIVACY.md"]) await readFile(new URL(`../dist/${document}`, import.meta.url));
for (const model of ["ppocrv5-mobile-det.onnx", "ppocrv5-mobile-rec.onnx", "ppocrv5-dict.txt", "model-manifest.json"]) await readFile(new URL(`../dist/models/${model}`, import.meta.url));
const assets = await readdir(new URL("../dist/assets/", import.meta.url));
if (!assets.some((asset) => asset.endsWith(".wasm"))) throw new Error("dist is missing the bundled ONNX Runtime WebAssembly asset");
for (const html of ["options.html", "offscreen.html"]) {
  const content = await readFile(new URL(`../dist/${html}`, import.meta.url), "utf8");
  if (/<script[^>]+src=["']https?:/i.test(content)) throw new Error(`${html} contains remotely hosted executable code`);
}
console.log("Verified MV3 manifest, self-contained content script, bundled models/WASM, icon assets, and release legal documents.");
