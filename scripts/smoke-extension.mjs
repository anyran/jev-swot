import puppeteer from "puppeteer-core";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const candidates = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
let executablePath;
for (const candidate of candidates) { try { await access(candidate); executablePath = candidate; break; } catch { /* try next */ } }
if (!executablePath) throw new Error("Chrome/Chromium not found; set CHROME_PATH to run the extension smoke test.");
const extensionPath = new URL("../dist/", import.meta.url).pathname, userDataDir = await mkdtemp(join(tmpdir(), "jev-swot-smoke-"));
let browser, server;
try {
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir, enableExtensions: [extensionPath], args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crash-reporter"] });
  const target = await browser.waitForTarget((item) => item.type() === "service_worker" && item.url().includes("assets/background.js"), { timeout: 15_000 });
  const extensionId = new URL(target.url()).host;
  console.log("Smoke: service worker ready");
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
  const title = await page.$eval("h1", (element) => element.textContent);
  if (title !== "Jev 做题家设置 Jev SWOT") throw new Error(`Unexpected options title: ${title}`);
  const permissions = await page.evaluate(() => chrome.permissions.getAll());
  console.log(`Smoke: granted origins ${permissions.origins?.join(", ") ?? "none"}`);
  console.log("Smoke: options page ready; running packaged OCR");
  const ocr = await page.evaluate(async () => {
    if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.BLOBS], justification: "Release smoke test for packaged local OCR" });
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "OCR", imageDataUrl: canvas.toDataURL("image/png"), rect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, devicePixelRatio: 1, useWebGpu: true });
  });
  if (!ocr?.ok || typeof ocr.text !== "string" || ocr.text.trim().length < 3) throw new Error(`Packaged OCR smoke test failed: ${JSON.stringify(ocr)}`);
  console.log("Smoke: OCR ready; testing page interaction");
  server = createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(`<!doctype html><html><body><main><section id="question"><h2>2 + 2 等于多少？</h2><label id="choice-a"><input type="radio" name="answer">A. 3</label><label><input type="radio" name="answer">B. 4</label></section></main></body></html>`); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Failed to start smoke page");
  const questionPage = await browser.newPage(); await questionPage.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle0" });
  await questionPage.$eval("#choice-a", (element) => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, altKey: true })));
  await questionPage.waitForSelector('[data-jev-swot-root="true"]', { timeout: 5_000 });
  const answerChanged = await questionPage.$eval('input[type="radio"]', (input) => input.checked);
  if (answerChanged) throw new Error("Extension modified the page answer during smoke test");
  console.log(`Chrome loaded Jev 做题家（Jev SWOT） ${extensionId}; service worker, content interaction, options page, and packaged OCR are healthy (${Math.round(ocr.confidence * 100)}%, ${ocr.backend}).`);
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(userDataDir, { recursive: true, force: true });
}
