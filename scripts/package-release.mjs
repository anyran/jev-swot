import { ZipArchive } from "archiver";
import { createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
await mkdir(new URL("../release/", import.meta.url), { recursive: true });
const target = new URL(`../release/jevanswer-${pkg.version}.zip`, import.meta.url);
const output = createWriteStream(target), archive = new ZipArchive({ zlib: { level: 9 } });
await new Promise((resolve, reject) => { output.on("close", resolve); output.on("error", reject); archive.on("error", reject); archive.pipe(output); archive.glob("**/*", { cwd: new URL("../dist/", import.meta.url).pathname, ignore: ["**/@eaDir/**"] }); archive.finalize(); });
console.log(`Created ${target.pathname} (${archive.pointer()} bytes)`);
