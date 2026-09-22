import puppeteer from "puppeteer-core";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const candidates = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
let executablePath;
for (const candidate of candidates) { try { await access(candidate); executablePath = candidate; break; } catch { /* try next */ } }
if (!executablePath) throw new Error("Chrome/Chromium not found; set CHROME_PATH to run the extension smoke test.");
const extensionPath = new URL("../dist/", import.meta.url).pathname, userDataDir = await mkdtemp(join(tmpdir(), "jevanswer-smoke-"));
let browser;
try {
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir, enableExtensions: [extensionPath], args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crash-reporter"] });
  const target = await browser.waitForTarget((item) => item.type() === "service_worker" && item.url().includes("assets/background.js"), { timeout: 15_000 });
  const extensionId = new URL(target.url()).host;
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
  const title = await page.$eval("h1", (element) => element.textContent);
  if (title !== "JevAnswer 设置") throw new Error(`Unexpected options title: ${title}`);
  const ocr = await page.evaluate(async () => {
    if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.BLOBS], justification: "Release smoke test for packaged local OCR" });
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "OCR", imageDataUrl: canvas.toDataURL("image/png"), rect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, devicePixelRatio: 1, useWebGpu: false });
  });
  if (!ocr?.ok || typeof ocr.text !== "string" || ocr.text.trim().length < 3) throw new Error(`Packaged OCR smoke test failed: ${JSON.stringify(ocr)}`);
  console.log(`Chrome loaded JevAnswer ${extensionId}; service worker, options page, and packaged OCR are healthy (${Math.round(ocr.confidence * 100)}%).`);
} finally {
  await browser?.close();
  await rm(userDataDir, { recursive: true, force: true });
}
