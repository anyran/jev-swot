import sharp from "sharp";
import { mkdir } from "node:fs/promises";

const source = new URL("../assets/icon.svg", import.meta.url), output = new URL("../public/icons/", import.meta.url);
await mkdir(output, { recursive: true });
for (const size of [16, 32, 48, 128]) await sharp(source.pathname).resize(size, size).png().toFile(new URL(`icon-${size}.png`, output).pathname);
console.log("Generated Chrome icons: 16, 32, 48, 128px");
