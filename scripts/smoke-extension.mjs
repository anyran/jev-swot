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
  const workerSession = await target.createCDPSession(); let jevRequests = 0, llmRequests = 0, visionRequests = 0, forceVisionUnsupported = false, forceStructuredMissingIgnored = false, jevInputWasClean = false;
  await workerSession.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.typesafe.ai/*", requestStage: "Request" }, { urlPattern: "https://api.openai.com/*", requestStage: "Request" }] });
  workerSession.on("Fetch.requestPaused", (event) => {
    if (event.request.url.startsWith("https://api.typesafe.ai/")) {
      jevRequests++;
      const requestBody = event.request.postData ?? "";
      if (requestBody.includes("Correct answer:") || requestBody.includes("Explanation:")) jevInputWasClean = false;
      else if (requestBody.includes("Which number is even?")) jevInputWasClean = true;
      void workerSession.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify({ model: "jev-smoke", answers: { answer: { type: "choice", choice: "option_2", confidence: 0.92, probabilities: { option_1: 0.08, option_2: 0.92 } } } })).toString("base64")
      });
      return;
    }
    if (event.request.url.startsWith("https://api.openai.com/")) {
      llmRequests++;
      if (event.request.postData?.includes("image_url")) visionRequests++;
      if (forceVisionUnsupported && event.request.postData?.includes("image_url")) {
        void workerSession.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 400, responseHeaders: [{ name: "content-type", value: "text/plain" }], body: Buffer.from("image_url is not supported").toString("base64") });
        return;
      }
      if (event.request.postData?.includes('"stream":true')) {
        const stream = 'data: {"choices":[{"delta":{"content":"答案是 B"}}]}\n\ndata: [DONE]\n\n';
        void workerSession.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/event-stream" }], body: Buffer.from(stream).toString("base64") });
        return;
      }
      const structured = { questionType: "single", stem: "Which number is even?", context: "", visualDependency: false, visualDependencyReason: "", ...(forceStructuredMissingIgnored ? {} : { ignoredText: "Correct answer: B\nExplanation: even numbers are divisible by two" }), options: [{ label: "A", text: "3" }, { label: "B", text: "4 Correct answer: B" }] };
      void workerSession.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(structured) } }] })).toString("base64") });
    }
  });
  console.log("Smoke: service worker ready");
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
  const title = await page.$eval("h1", (element) => element.textContent);
  if (title !== "Jev 做题家设置 Jev SWOT") throw new Error(`Unexpected options title: ${title}`);
  const permissions = await page.evaluate(() => chrome.permissions.getAll());
  console.log(`Smoke: granted origins ${permissions.origins?.join(", ") ?? "none"}`);
  await page.evaluate(() => chrome.storage.session.set({ secrets: { typeSafeApiKey: "smoke-only", llmApiKey: "smoke-llm" } }));
  await page.evaluate(() => chrome.storage.local.set({ settings: { llm: { baseUrl: "https://api.openai.com/v1", model: "smoke-model", vision: "unsupported", structuredOutput: "unsupported" }, ocrThreshold: 0.5, useWebGpu: false, confirmVisionUpload: true, disabledHosts: [] } }));
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
  server = createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(`<!doctype html><html><body><main><section id="question"><h2>2 + 2 等于多少？</h2><label id="choice-a"><input type="radio" name="answer">A. 3</label><label><input type="radio" name="answer">B. 4</label></section><section id="other"><h2>1 + 1 等于多少？</h2><label><input type="radio" name="other-answer">A. 1</label><label><input type="radio" name="other-answer">B. 2</label></section></main></body></html>`); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("Failed to start smoke page");
  const questionPage = await browser.newPage(); await questionPage.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle0" });
  await questionPage.$eval("#choice-a", (element) => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, altKey: true })));
  await questionPage.waitForSelector('[data-jev-swot-root="true"]', { timeout: 5_000 });
  await new Promise((resolve, reject) => { const deadline = Date.now() + 5_000; const poll = () => jevRequests ? resolve() : Date.now() > deadline ? reject(new Error("Mock JEV request was not observed")) : setTimeout(poll, 50); poll(); });
  const answerChanged = await questionPage.$eval('input[type="radio"]', (input) => input.checked);
  if (answerChanged) throw new Error("Extension modified the page answer during smoke test");
  const fallback = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, captureAuthorized: true });
  });
  if (!fallback?.ok || !fallback.probability) throw new Error(`OCR fallback smoke returned an invalid response: ${JSON.stringify(fallback)}`);
  if (!jevInputWasClean) throw new Error("OCR structure model's excluded answer/explanation text reached the JEV request");
  if (llmRequests === 0 || jevRequests < 2) throw new Error(`OCR fallback smoke request chain was not observed (llm=${llmRequests}, vision=${visionRequests}, jev=${jevRequests})`);
  if (visionRequests !== 0) throw new Error("Canvas OCR smoke unexpectedly uploaded an image to the vision model");
  await page.evaluate(() => chrome.storage.session.set({ secrets: { typeSafeApiKey: "smoke-only" } }));
  const reviewRequired = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, captureAuthorized: true });
  });
  if (reviewRequired?.ok || reviewRequired?.code !== "STRUCTURE_REVIEW_REQUIRED") throw new Error(`OCR without a text model bypassed structure review: ${JSON.stringify(reviewRequired)}`);
  await page.evaluate(() => chrome.storage.session.set({ secrets: { typeSafeApiKey: "smoke-only", llmApiKey: "smoke-llm" } }));
  await page.evaluate(() => chrome.storage.local.set({ settings: { llm: { baseUrl: "https://api.openai.com/v1", model: "smoke-model", vision: "auto", structuredOutput: "unsupported" }, ocrThreshold: 0.5, useWebGpu: false, confirmVisionUpload: true, disabledHosts: [] } }));
  const consent = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, captureAuthorized: true });
  });
  if (consent?.ok || consent?.code !== "VISION_CONSENT_REQUIRED") throw new Error(`Vision consent was not enforced: ${JSON.stringify(consent)}`);
  const localOnly = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, visionConsent: "deny", captureAuthorized: true });
  });
  if (!localOnly?.ok || !localOnly.probability) throw new Error(`Local-only OCR fallback returned an invalid response: ${JSON.stringify(localOnly)}`);
  if (visionRequests !== 0) throw new Error(`Local-only OCR unexpectedly uploaded an image to the vision model (vision=${visionRequests})`);
  const visionRequestsBeforeSuccess = visionRequests;
  const visionSuccess = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, visionConsent: "allow", captureAuthorized: true });
  });
  if (!visionSuccess?.ok || !visionSuccess.probability) throw new Error(`Vision recognition smoke returned an invalid response: ${JSON.stringify(visionSuccess)}`);
  if (visionRequests !== visionRequestsBeforeSuccess + 1) throw new Error(`Successful vision recognition did not upload exactly one image (vision=${visionRequests})`);
  forceStructuredMissingIgnored = true;
  const requestsBeforeMissingLedger = jevRequests;
  const missingLedger = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, visionConsent: "deny", captureAuthorized: true });
  });
  if (missingLedger?.ok || missingLedger?.code !== "STRUCTURE_REVIEW_REQUIRED") throw new Error(`Missing OCR exclusion ledger bypassed structure review: ${JSON.stringify(missingLedger)}`);
  if (jevRequests !== requestsBeforeMissingLedger) throw new Error("Missing OCR exclusion ledger reached JEV");
  forceStructuredMissingIgnored = false;
  forceVisionUnsupported = true;
  const visionRequestsBeforeFallback = visionRequests;
  const visionFallback = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, visionConsent: "allow", captureAuthorized: true });
  });
  if (!visionFallback?.ok || !visionFallback.probability) throw new Error(`Vision 400 fallback smoke returned an invalid response: ${JSON.stringify(visionFallback)}`);
  if (visionRequests !== visionRequestsBeforeFallback + 1) throw new Error(`Vision capability fallback was not exercised exactly once (vision=${visionRequests})`);
  const explanation = await page.evaluate(() => new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: "jev-swot-explanation" }); let text = "";
    const timeout = setTimeout(() => { port.disconnect(); reject(new Error("streaming explanation timed out")); }, 10_000);
    port.onMessage.addListener((message) => {
      if (message.type === "chunk") text += message.chunk ?? "";
      if (message.type === "error") { clearTimeout(timeout); port.disconnect(); reject(new Error(message.message ?? "streaming explanation failed")); }
      if (message.type === "done") { clearTimeout(timeout); port.disconnect(); resolve(text); }
    });
    port.postMessage({ question: { source: "user-edited", questionType: "single", stem: "Which number is even?", options: [{ id: "option_1", label: "A", text: "3" }, { id: "option_2", label: "B", text: "4" }], sourceRect: { x: 0, y: 0, width: 1, height: 1 }, recognitionConfidence: 1, warnings: [] }, probability: { mode: "single-distribution", options: [{ id: "option_1", label: "A", probability: 0.08 }, { id: "option_2", label: "B", probability: 0.92 }], confidence: 0.92, model: "jev-smoke" } });
  }));
  if (explanation !== "答案是 B") throw new Error(`Streaming explanation smoke returned ${JSON.stringify(explanation)}`);
  console.log(`Chrome loaded Jev 做题家（Jev SWOT） ${extensionId}; DOM→JEV, Canvas→local OCR→text model→JEV, and streaming explanation flows are healthy (${Math.round(ocr.confidence * 100)}%, ${ocr.backend}).`);
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await rm(userDataDir, { recursive: true, force: true });
}
