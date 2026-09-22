import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const releasePath = fileURLToPath(new URL("../release/", import.meta.url));
const distPath = fileURLToPath(new URL("../dist/", import.meta.url));
await mkdir(releasePath, { recursive: true });
const target = join(releasePath, `jev-swot-${pkg.version}.zip`);
const output = createWriteStream(target), archive = new ZipArchive({ zlib: { level: 9 } });
await new Promise((resolve, reject) => { output.on("close", resolve); output.on("error", reject); archive.on("error", reject); archive.pipe(output); archive.glob("**/*", { cwd: distPath, ignore: ["**/@eaDir/**"] }); archive.finalize(); });
console.log(`Created ${target} (${archive.pointer()} bytes)`);
