import sharp from "sharp";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const source = fileURLToPath(new URL("../assets/icon.svg", import.meta.url)), output = fileURLToPath(new URL("../public/icons/", import.meta.url));
await mkdir(output, { recursive: true });
for (const size of [16, 32, 48, 128]) await sharp(source).resize(size, size).png().toFile(join(output, `icon-${size}.png`));
console.log("Generated Chrome icons: 16, 32, 48, 128px");
