import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const releasePath = fileURLToPath(new URL("../release/", import.meta.url));
const distPath = fileURLToPath(new URL("../dist/", import.meta.url));
await mkdir(releasePath, { recursive: true });
const filename = process.env.JEV_RELEASE_FILENAME || `jev-swot-${pkg.version}.zip`;
if (basename(filename) !== filename || !/^jev-swot-[\w.-]+\.zip$/i.test(filename)) throw new Error("JEV_RELEASE_FILENAME must be a ZIP filename beginning with jev-swot- and cannot include a directory path.");
const target = join(releasePath, filename);
// A repeat build must never silently replace an existing release artifact.
const output = createWriteStream(target, { flags: "wx" }), archive = new ZipArchive({ zlib: { level: 9 } });
try {
  await new Promise((resolve, reject) => {
    output.on("close", resolve); output.on("error", reject); archive.on("error", reject); archive.pipe(output);
    archive.directory(distPath, false, (entry) => entry.name.split(/[\\/]/).includes("@eaDir") ? false : entry);
    archive.finalize();
  });
} catch (error) {
  if (error?.code === "EEXIST") throw new Error(`Refusing to overwrite existing release archive: ${target}. Choose a new JEV_RELEASE_FILENAME.`, { cause: error });
  throw error;
}
console.log(`Created ${target} (${archive.pointer()} bytes)`);
