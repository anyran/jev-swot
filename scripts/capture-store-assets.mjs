import puppeteer from "puppeteer-core";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const candidates = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].filter(Boolean);
let executablePath;
for (const candidate of candidates) { try { await access(candidate); executablePath = candidate; break; } catch { /* next */ } }
if (!executablePath) throw new Error("Chrome/Chromium not found; set CHROME_PATH.");

const extensionPath = new URL("../dist/", import.meta.url).pathname;
const outputPath = new URL("../store-assets/", import.meta.url).pathname;
const userDataDir = await mkdtemp(join(tmpdir(), "jevanswer-store-"));
let browser, server;
try {
  await mkdir(outputPath, { recursive: true });
  browser = await puppeteer.launch({ executablePath, headless: true, userDataDir, enableExtensions: [extensionPath], args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crash-reporter"] });
  const workerTarget = await browser.waitForTarget((item) => item.type() === "service_worker" && item.url().includes("assets/background.js"), { timeout: 15_000 });
  const extensionId = new URL(workerTarget.url()).host;
  const workerSession = await workerTarget.createCDPSession();
  await workerSession.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.typesafe.ai/*", requestStage: "Request" }] });
  workerSession.on("Fetch.requestPaused", (event) => void workerSession.send("Fetch.fulfillRequest", {
    requestId: event.requestId,
    responseCode: 200,
    responseHeaders: [{ name: "content-type", value: "application/json" }],
    body: Buffer.from(JSON.stringify({ model: "jev-latest", answers: { answer: { type: "choice", choice: "option_2", confidence: 0.82, probabilities: { option_1: 0.06, option_2: 0.86, option_3: 0.08 } } } })).toString("base64")
  }));

  const options = await browser.newPage(); await options.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await options.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "networkidle0" });
  await options.screenshot({ path: join(outputPath, "settings.png") });
  await options.evaluate(() => chrome.storage.session.set({ secrets: { typeSafeApiKey: "store-preview-only" } }));

  server = createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>body{margin:0;background:linear-gradient(135deg,#eff6ff,#f8fafc);font:18px/1.7 system-ui;color:#172033}.page{width:680px;margin:72px 48px 72px 430px;background:#fff;padding:52px 48px;border-radius:24px;box-shadow:0 24px 70px #1e3a8a1c}.tag{color:#2563eb;font-weight:650}.question{font-size:25px;margin:18px 0 26px}.choice{display:block;margin:12px 0;padding:14px 18px;border:1px solid #dbeafe;border-radius:12px;background:#f8fbff}.choice input{margin-right:12px}</style></head><body><div class="page"><div class="tag">示例练习 · 地理</div><section id="question"><div class="question">世界上面积最大的海洋是？</div><label class="choice" id="choice-a"><input type="radio" name="answer">A. 大西洋</label><label class="choice"><input type="radio" name="answer">B. 太平洋</label><label class="choice"><input type="radio" name="answer">C. 印度洋</label></section></div></body></html>`); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Preview server failed");
  const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle0" });
  await page.$eval("#choice-a", (element) => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, altKey: true })));
  await page.waitForSelector('[data-jevanswer-root="true"]'); await new Promise((resolve) => setTimeout(resolve, 800));
  await page.screenshot({ path: join(outputPath, "probabilities.png") });
  console.log(`Created store screenshots in ${outputPath}`);
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(userDataDir, { recursive: true, force: true });
}
