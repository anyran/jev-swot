import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

const output = new URL("../dist/third_party_licenses/", import.meta.url);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const upstreamOnnxLicense = new URL("../third_party_licenses/onnxruntime-LICENSE.txt", import.meta.url);
const guidLicense = new URL("../third_party_licenses/guid-typescript-ISC.txt", import.meta.url);
const seen = new Set();
const manifest = [];

export async function copyThirdPartyLicenses() {
  seen.clear();
  manifest.length = 0;
  await mkdir(output, { recursive: true });
  for (const name of Object.keys(packageJson.dependencies ?? {})) await copyPackageTree(name);
  await copyFile(new URL("../third_party_licenses/PaddleOCR-LICENSE.txt", import.meta.url), new URL("PaddleOCR-LICENSE.txt", output));
  await copyFile(new URL("../third_party_licenses/onnxruntime-ThirdPartyNotices.txt", import.meta.url), new URL("ONNXRuntime-ThirdPartyNotices.txt", output));
  manifest.push(
    { name: "PaddleOCR PP-OCRv5 model assets", version: "pinned revisions in models/model-manifest.json", license: "Apache-2.0", licenseFiles: ["PaddleOCR-LICENSE.txt"] },
    { name: "ONNX Runtime upstream third-party components", version: "1.30.0", license: "See upstream notices", licenseFiles: ["ONNXRuntime-ThirdPartyNotices.txt"] }
  );
  await writeFile(new URL("manifest.json", output), `${JSON.stringify(manifest, null, 2)}\n`);
}

async function copyPackageTree(name) {
  let packageUrl;
  try { packageUrl = new URL(`../node_modules/${name}/package.json`, import.meta.url); }
  catch { return; }
  const packageData = JSON.parse(await readFile(packageUrl, "utf8"));
  const identity = `${packageData.name}@${packageData.version}`;
  if (seen.has(identity)) return;
  seen.add(identity);

  const directory = new URL("./", packageUrl);
  const entries = await readdir(directory);
  const files = entries.filter((entry) => /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[._-].*)?$/i.test(entry));
  const licenseName = typeof packageData.license === "string" ? packageData.license : packageData.license?.type;
  if (!licenseName) throw new Error(`Missing SPDX license metadata for ${identity}`);
  const copiedFiles = [];
  if (files.length) {
    for (const file of files) {
      const targetName = `${identity.replaceAll("/", "-")}-${file.replace(/\.[^.]+$/, "")}.txt`;
      await copyFile(new URL(file, directory), new URL(targetName, output));
      copiedFiles.push(targetName);
    }
  } else {
    const fallback = name === "guid-typescript" ? guidLicense : ["onnxruntime-web", "onnxruntime-common"].includes(name) ? upstreamOnnxLicense : undefined;
    if (!fallback) throw new Error(`No license file or audited fallback for ${identity} (${licenseName})`);
    const targetName = `${identity.replaceAll("/", "-")}-LICENSE.txt`;
    await copyFile(fallback, new URL(targetName, output));
    copiedFiles.push(targetName);
  }
  manifest.push({ name: packageData.name, version: packageData.version, license: licenseName, licenseFiles: copiedFiles });

  for (const dependency of Object.keys({ ...packageData.dependencies, ...packageData.optionalDependencies })) {
    try { await readFile(new URL(`../node_modules/${dependency}/package.json`, import.meta.url)); }
    catch { continue; }
    await copyPackageTree(dependency);
  }
}
