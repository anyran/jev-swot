import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../dist/manifest.json", import.meta.url), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("dist manifest is not MV3");
const contentPath = new URL(`../dist/${manifest.content_scripts[0].js[0]}`, import.meta.url);
const content = await readFile(contentPath, "utf8");
if (/^\s*(?:import|export)\s/m.test(content)) throw new Error("Chrome content script contains ESM import/export and cannot execute as a classic manifest script");
for (const size of [16, 32, 48, 128]) await readFile(new URL(`../dist/icons/icon-${size}.png`, import.meta.url));
console.log("Verified MV3 manifest, self-contained content script, and icon assets.");
