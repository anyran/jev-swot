import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const root = new URL("../public/models/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("model-manifest.json", root), "utf8"));
let failed = false;
for (const [name, metadata] of Object.entries(manifest.files)) {
  try {
    const bytes = await readFile(new URL(name, root));
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (metadata.sha256.startsWith("REPLACE_") || hash !== metadata.sha256) {
      console.error(`${name}: expected ${metadata.sha256}, got ${hash}`);
      failed = true;
    } else console.log(`${name}: ok`);
  } catch { console.error(`${name}: missing`); failed = true; }
}
try {
  const dictionary = (await readFile(new URL("ppocrv5-dict.txt", root), "utf8")).split(/\r?\n/).filter(Boolean);
  if (dictionary.length !== 18_383) { console.error(`ppocrv5-dict.txt: expected 18383 entries, got ${dictionary.length}`); failed = true; }
} catch { /* missing file is already reported above */ }
if (failed) process.exitCode = 1;
