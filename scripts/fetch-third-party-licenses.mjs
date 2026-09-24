import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";

const outputDirectory = new URL("../third_party_licenses/", import.meta.url);
const sources = {
  "onnxruntime-LICENSE.txt": {
    url: "https://raw.githubusercontent.com/microsoft/onnxruntime/f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7/LICENSE",
    sha256: "2f07c72751aed99790b8a4869cf2311df85a860b22ded05fa22803587a48922c"
  },
  "onnxruntime-ThirdPartyNotices.txt": {
    url: "https://raw.githubusercontent.com/microsoft/onnxruntime/f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7/ThirdPartyNotices.txt",
    sha256: "143764b952fdb1a7c69ce653bfba74a7744d6a8a573bfb73e235fba356c83de3"
  },
  "PaddleOCR-LICENSE.txt": {
    url: "https://raw.githubusercontent.com/PaddlePaddle/PaddleOCR/109a5eedf5a2996b932d737bf062a8149c7decd9/LICENSE",
    sha256: "3840c5c0c61c294264d2dd77b8777be6ddd90121ef4e0e64abcd22edea581d6e"
  }
};

await mkdir(outputDirectory, { recursive: true });
for (const [filename, source] of Object.entries(sources)) {
  const response = await fetch(source.url);
  if (!response.ok) throw new Error(`Unable to fetch ${filename}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!new TextDecoder().decode(bytes).trim()) throw new Error(`Downloaded license is empty: ${filename}`);
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== source.sha256) throw new Error(`License hash mismatch for ${filename}: ${actual}`);
  await writeFile(new URL(filename, outputDirectory), bytes);
  process.stdout.write(`${filename}\t${actual}\n`);
}
