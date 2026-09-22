import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const assets = new URL("../public/models/", import.meta.url);
const repositories = {
  "ppocrv5-mobile-det.onnx": "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.onnx",
  "ppocrv5-mobile-rec.onnx": "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/ed152b8b495f84de93cda5709d768548a9127622/inference.onnx"
};
const recConfigUrl = "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec_onnx/resolve/ed152b8b495f84de93cda5709d768548a9127622/inference.yml";
await mkdir(assets, { recursive: true });
for (const [filename, url] of Object.entries(repositories)) {
  process.stdout.write(`Downloading ${filename}... `);
  const response = await fetch(url); if (!response.ok) throw new Error(`${response.status} ${url}`);
  await writeFile(new URL(filename, assets), new Uint8Array(await response.arrayBuffer())); console.log("done");
}
const configResponse = await fetch(recConfigUrl); if (!configResponse.ok) throw new Error(`${configResponse.status} ${recConfigUrl}`);
const yaml = await configResponse.text();
const marker = "  character_dict:\n"; const offset = yaml.indexOf(marker);
if (offset < 0) throw new Error("character_dict missing from pinned inference.yml");
const dictionary = yaml.slice(offset + marker.length).split(/\r?\n/).filter((line) => line.startsWith("  - ")).map((line) => parseYamlScalar(line.slice(4))).join("\n") + "\n";
await writeFile(new URL("ppocrv5-dict.txt", assets), dictionary);
const manifestUrl = new URL("model-manifest.json", assets), manifest = JSON.parse(await readFile(manifestUrl, "utf8"));
for (const filename of Object.keys(manifest.files)) {
  const bytes = await readFile(new URL(filename, assets)); manifest.files[filename].sha256 = createHash("sha256").update(bytes).digest("hex");
}
manifest.repositories = { detection: repositories["ppocrv5-mobile-det.onnx"], recognition: repositories["ppocrv5-mobile-rec.onnx"], recognitionConfig: recConfigUrl };
await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + "\n");
console.log("Models downloaded and model-manifest.json updated.");

function parseYamlScalar(value) {
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  return value;
}
