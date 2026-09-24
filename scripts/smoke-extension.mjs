import puppeteer from "puppeteer-core";
import { access, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";

const normalizeSmokeText = (value) => String(value ?? "").normalize("NFKC").replace(/[\p{P}\p{S}\s]+/gu, " ").trim().toLowerCase();
const smokeHeadless = process.platform !== "darwin";
const platformCandidates = process.platform === "darwin"
  ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium"]
  : process.platform === "win32"
    ? [
        process.env.ProgramFiles ? join(process.env.ProgramFiles, "Google/Chrome/Application/chrome.exe") : undefined,
        process.env["ProgramFiles(x86)"] ? join(process.env["ProgramFiles(x86)"], "Google/Chrome/Application/chrome.exe") : undefined,
        process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : undefined
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const candidates = [process.env.CHROME_PATH, ...platformCandidates].filter(Boolean);
let executablePath;
for (const candidate of candidates) { try { await access(candidate); executablePath = candidate; break; } catch { /* try next */ } }
if (!executablePath) throw new Error("Chrome/Chromium not found; set CHROME_PATH to run the extension smoke test.");
const extensionPath = fileURLToPath(new URL("../dist/", import.meta.url)), userDataDir = await mkdtemp(join(tmpdir(), "jev-swot-smoke-profile-"));
const smokeExtensionRoot = await mkdtemp(join(tmpdir(), "jev-swot-smoke-extension-"));
const smokeExtensionPath = join(smokeExtensionRoot, "extension");
await cp(extensionPath, smokeExtensionPath, { recursive: true });
const smokeChromeArgs = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-crash-reporter"];
const smokeManifestPath = join(smokeExtensionPath, "manifest.json");
const smokeManifest = JSON.parse(await readFile(smokeManifestPath, "utf8"));
// Promote the optional HTTP/HTTPS page origins in this isolated test copy to
// granted host permissions. This exercises the same per-site access path as
// whole-page scanning without broadening the test copy to <all_urls> or relying
// on browser UI gestures, which Puppeteer cannot faithfully grant.
smokeManifest.host_permissions = [...new Set([...(smokeManifest.host_permissions ?? []), ...(smokeManifest.optional_host_permissions ?? [])])];
await writeFile(smokeManifestPath, `${JSON.stringify(smokeManifest, null, 2)}\n`);
let browser, server, frameServer;
try {
  browser = await puppeteer.launch({ executablePath, headless: smokeHeadless, userDataDir, enableExtensions: true, args: smokeChromeArgs });
  await browser.installExtension(smokeExtensionPath);
  let target;
  try {
    // macOS runners can take considerably longer to expose an MV3 worker after
    // Chrome has unpacked a large extension containing OCR models. Keep this
    // startup wait independent from the per-flow assertions below.
    target = await browser.waitForTarget((item) => item.type() === "service_worker" && item.url().includes("assets/background.js"), { timeout: 60_000 });
  } catch (error) {
    const targets = browser.targets().map((item) => ({ type: item.type(), url: item.url() }));
    throw new Error(`Extension service worker did not start; observed targets: ${JSON.stringify(targets)}`, { cause: error });
  }
  const extensionId = new URL(target.url()).host;
  const workerSession = await target.createCDPSession(); let jevRequests = 0, llmRequests = 0, visionRequests = 0, directAnswerRequests = 0, rawAnswerRequests = 0, forceVisionUnsupported = false, forceVisionMissingContext = false, forceStructuredMissingIgnored = false, multipleJevTargetsExplicit = false; const jevQuestionStems = [], jevRequestBodies = [];
  await workerSession.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.typesafe.ai/*", requestStage: "Request" }, { urlPattern: "https://api.openai.com/*", requestStage: "Request" }] });
  workerSession.on("Fetch.requestPaused", (event) => {
    if (event.request.url.startsWith("https://api.typesafe.ai/") && event.request.url.endsWith("/v1/systemone")) {
      jevRequests++;
      const requestBody = event.request.postData ?? "";
      jevRequestBodies.push(requestBody);
      let payload;
      try { payload = JSON.parse(requestBody); } catch { payload = undefined; }
      if (typeof payload?.state?.stem === "string") jevQuestionStems.push(payload.state.stem);
      const questionEntries = Object.entries(payload?.questions ?? {});
      const multiple = questionEntries.length > 0 && questionEntries.every(([, value]) => value?.type === "noul");
      if (multiple) {
        multipleJevTargetsExplicit = questionEntries.every(([id, value]) => value?.instructions?.optionId === id && !String(JSON.stringify(value?.instructions)).includes("Correct"));
      }
      const answers = multiple
        ? Object.fromEntries(questionEntries.map(([id], index) => [id, { type: "noul", noul: index === 0 ? 0.8 : 0.35 }]))
        : { answer: { type: "choice", choice: "option_2", confidence: 0.92, probabilities: { option_1: 0.08, option_2: 0.92 } } };
      void workerSession.send("Fetch.fulfillRequest", {
        requestId: event.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify({ model: "jev-smoke", answers })).toString("base64")
      });
      return;
    }
    if (event.request.url.startsWith("https://api.openai.com/") || event.request.url.startsWith("https://api.typesafe.ai/")) {
      llmRequests++;
      const isVisionRequest = event.request.postData?.includes("image_url") === true;
      if (isVisionRequest) visionRequests++;
      if (forceVisionUnsupported && isVisionRequest) {
        void workerSession.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 400, responseHeaders: [{ name: "content-type", value: "text/plain" }], body: Buffer.from("image_url is not supported").toString("base64") });
        return;
      }
      if (event.request.postData?.includes('"stream":true')) {
        const stream = 'data: {"choices":[{"delta":{"content":"答案是 B"}}]}\n\ndata: [DONE]\n\n';
        void workerSession.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "text/event-stream" }], body: Buffer.from(stream).toString("base64") });
        return;
      }
      if (event.request.postData?.includes("answerOptionIds")) {
        directAnswerRequests++;
        const direct = { answerOptionIds: ["option_2"], explanation: "4 是偶数。", knowledgePoints: ["偶数可被 2 整除"], uncertainty: "题干信息充分。" };
        void workerSession.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(direct) } }] })).toString("base64") });
        return;
      }
      if (event.request.postData?.includes("rawText")) {
        rawAnswerRequests++;
        const direct = { answerOptionLabels: ["B"], explanation: "4 是偶数。", knowledgePoints: ["偶数可被 2 整除"], uncertainty: "题干信息充分。" };
        void workerSession.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(direct) } }] })).toString("base64") });
        return;
      }
      let ocrLineIds = ["line_1", "line_2", "line_3"];
      if (!isVisionRequest && event.request.postData?.includes('"orderedText"')) {
        try {
          const outer = JSON.parse(event.request.postData);
          const content = outer.messages?.[1]?.content;
          const ocrPayload = typeof content === "string" ? JSON.parse(content) : undefined;
          const ids = Array.isArray(ocrPayload?.lines) ? ocrPayload.lines.map((line) => line?.id).filter((id) => typeof id === "string") : [];
          if (ids.length >= 3) ocrLineIds = ids.slice(0, 3);
        } catch { /* keep deterministic smoke IDs when a provider reshapes the request */ }
      }
      const structured = { questionType: "single", stem: "Which number is even?", context: "", visualDependency: forceVisionMissingContext && isVisionRequest, visualDependencyReason: "", ...(forceStructuredMissingIgnored ? {} : { ignoredText: "Correct answer: B\nExplanation: even numbers are divisible by two", stemLineIds: [ocrLineIds[0]], optionLineIds: [ocrLineIds[1], ocrLineIds[2]], ignoredLineIds: [] }), options: [{ label: "A", text: "3" }, { label: "B", text: "4 Correct answer: B" }] };
      if (isVisionRequest) Object.assign(structured, { answerOptionLabels: ["B"], explanation: "4 是偶数。", knowledgePoints: ["偶数可被 2 整除"], uncertainty: "题干信息充分。" });
      void workerSession.send("Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }], body: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(structured) } }] })).toString("base64") });
    }
  });
  console.log("Smoke: service worker ready");
  const page = await browser.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
  const title = await page.$eval("h1", (element) => element.textContent);
  if (title !== "做题 Jev 设置") throw new Error(`Unexpected options title: ${title}`);
  const commands = await page.evaluate(() => chrome.commands.getAll());
  if (!commands.some((command) => command.name === "select-question") || !commands.some((command) => command.name === "select-question-alt")) throw new Error(`Manifest commands are not registered: ${JSON.stringify(commands)}`);
  console.log(`Smoke: commands registered ${commands.map((command) => `${command.name}=${command.shortcut || "unassigned"}`).join(", ")}`);
  const permissions = await page.evaluate(() => chrome.permissions.getAll());
  console.log(`Smoke: granted origins ${permissions.origins?.join(", ") ?? "none"}`);
  const setSmokeSecrets = async (secrets) => page.evaluate(async (value) => {
    await Promise.all([
      chrome.storage.session.set({ secrets: value }),
      chrome.storage.local.set({ savedSecrets: value })
    ]);
  }, secrets);
  await setSmokeSecrets({ typeSafeApiKey: "smoke-only", llmApiKey: "smoke-llm" });
  await page.evaluate(() => chrome.storage.local.set({ settings: { llm: { baseUrl: "https://api.typesafe.ai/v1", model: "smoke-model", vision: "unsupported", structuredOutput: "unsupported" }, ocrThreshold: 0.5, useWebGpu: false, confirmVisionUpload: true, disabledHosts: [] } }));
  await page.reload({ waitUntil: "domcontentloaded" });
  const persisted = await page.evaluate(() => chrome.storage.local.get(["settings", "savedSecrets"]));
  if (persisted.settings?.llm?.model !== "smoke-model" || persisted.savedSecrets?.typeSafeApiKey !== "smoke-only" || persisted.savedSecrets?.llmApiKey !== "smoke-llm") throw new Error(`Local configuration did not survive an options-page restart: ${JSON.stringify(persisted)}`);
  let pageAccessGranted = await page.evaluate(() => chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] }));
  if (!pageAccessGranted) {
    if (!await page.$('[data-action="enable-page-access"]')) throw new Error("Optional page-access button is missing before permission request");
    await page.click('[data-action="enable-page-access"]');
    await new Promise((resolve) => setTimeout(resolve, 500));
    pageAccessGranted = await page.evaluate(() => chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] }));
  }
  if (pageAccessGranted) {
    await page.waitForFunction(async () => {
      const [script] = await chrome.scripting.getRegisteredContentScripts({ ids: ["jev-swot-content"] });
      return script?.allFrames === true;
    }, { timeout: 5_000 });
    console.log("Smoke: optional page access granted and persistent content script registered");
  } else {
    console.log("Smoke: optional page access was not granted by headless Chrome; page gesture checks remain in the manual release checklist");
  }
  console.log("Smoke: options page ready; running packaged OCR");
  const ocr = await page.evaluate(async () => {
    if (!await chrome.offscreen.hasDocument()) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: [chrome.offscreen.Reason.BLOBS], justification: "Release smoke test for packaged local OCR" });
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "OCR", imageDataUrl: canvas.toDataURL("image/png"), rect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, devicePixelRatio: 1, useWebGpu: true });
  });
  if (!ocr?.ok || typeof ocr.text !== "string" || ocr.text.trim().length < 3) throw new Error(`Packaged OCR smoke test failed: ${JSON.stringify(ocr)}`);
  const ocrText = ocr.text.toLowerCase();
  if (!ocrText.includes("even") || !ocrText.includes("3") || !ocrText.includes("4")) throw new Error(`Packaged OCR did not recover the expected test question text: ${JSON.stringify({ text: ocr.text, confidence: ocr.confidence, backend: ocr.backend })}`);
  if (pageAccessGranted) {
    console.log("Smoke: OCR ready; testing page interaction");
    frameServer = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html><html><body><div style="height:7200px"></div><section class="question"><h2>Which question is inside a cross-origin frame?</h2><label><input type="radio">A. No</label><label><input type="radio">B. Yes</label></section><section class="question"><h2>如图，which option matches the diagram?</h2><canvas width="200" height="90"></canvas><label><input type="radio">A. No</label><label><input type="radio">B. Yes</label></section><script>window.__maxYSeen=0;addEventListener('scroll',()=>{window.__maxYSeen=Math.max(window.__maxYSeen,scrollY);parent.postMessage({type:'frame-scroll',y:scrollY},'*')},{passive:true});scrollTo(0,80)</script></body></html>`);
    });
    await new Promise((resolve) => frameServer.listen(0, "127.0.0.1", resolve));
    const frameAddress = frameServer.address(); if (!frameAddress || typeof frameAddress === "string") throw new Error("Failed to start cross-origin frame page");
    server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(`<!doctype html>
<html><body><main>
  <section id="question"><h2>2 + 2 等于多少？</h2><label id="choice-a"><input type="radio" name="answer">A. 3</label><label><input type="radio" name="answer">B. 4</label></section>
  <div style="height:12000px"></div>
  <section id="far-question"><h2>What is the final question on this long page?</h2><label><input type="radio" name="far-answer">A. Begin</label><label><input type="radio" name="far-answer">B. End</label></section>
  <div id="nested-list" style="height:240px;overflow-y:auto"><div style="height:2200px"></div><div id="nested-question-host"></div></div>
  <quiz-question id="shadow-question-host"></quiz-question>
</main><script>
window.__maxYSeen=0;
window.__crossFrameMaxY=0;window.__crossFrameY=-1;
window.addEventListener('message',event=>{if(event.data?.type==='frame-scroll'){window.__crossFrameY=event.data.y;window.__crossFrameMaxY=Math.max(window.__crossFrameMaxY,event.data.y)}});
window.addEventListener('scroll',()=>{
  window.__maxYSeen=Math.max(window.__maxYSeen,window.scrollY);
  if(window.scrollY>700&&!document.querySelector('#other')&&!window.otherQuestionPending){
    window.otherQuestionPending=true;
    setTimeout(()=>{if(document.querySelector('#other'))return;const section=document.createElement('section');section.id='other';section.innerHTML='<h2>Which number is even?</h2><label><input type="radio" name="other-answer">A. 3</label><label><input type="radio" name="other-answer">B. 4</label><canvas width="200" height="90"></canvas>';document.body.append(section)},1500)
  }
},{passive:true});
const nested=document.querySelector('#nested-list');
nested.addEventListener('scroll',()=>{
  if(nested.scrollTop>1200&&!window.nestedQuestionPending){
    window.nestedQuestionPending=true;
    setTimeout(()=>{if(document.querySelector('#nested-question'))return;const section=document.createElement('section');section.id='nested-question';section.innerHTML='<h2>Which option is at the end of a nested scroll panel?</h2><label><input type="radio" name="nested-answer">A. Start</label><label><input type="radio" name="nested-answer">B. End</label>';document.querySelector('#nested-question-host').append(section)},1500)
  }
});
const shadowHost=document.querySelector('#shadow-question-host');
const shadow=shadowHost.attachShadow({mode:'open'});
shadow.innerHTML='<section class="question"><h2>Which question is inside an open shadow root?</h2><label><input type="radio" name="shadow-answer">A. No</label><label><input type="radio" name="shadow-answer">B. Yes</label></section>';
const embeddedFrame=document.createElement('iframe');
embeddedFrame.id='embedded-question';embeddedFrame.style.width='300px';embeddedFrame.style.height='180px';
embeddedFrame.srcdoc='<section class="question"><h2>Which question is inside an embedded frame?</h2><label><input type="radio">A. No</label><label><input type="radio">B. Yes</label></section>';
const crossOriginFrame=document.createElement('iframe');
crossOriginFrame.id='cross-origin-question';crossOriginFrame.style.width='300px';crossOriginFrame.style.height='180px';
crossOriginFrame.src='http://127.0.0.1:${frameAddress.port}/frame.html';
document.querySelector('main').append(embeddedFrame,crossOriginFrame);
</script></body></html>`);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Failed to start smoke page");
    const questionPage = await browser.newPage(); await questionPage.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: "networkidle0" });
    await page.evaluate(async () => {
      const stored = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...(stored.settings ?? {}), disabledHosts: ["127.0.0.1"] } });
    });
    await questionPage.reload({ waitUntil: "networkidle0" });
    const requestsBeforeDisabledSite = jevRequests;
    await questionPage.$eval("#choice-a", (element) => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, altKey: true })));
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (await questionPage.$('[data-jev-swot-root="true"]')) throw new Error("Disabled site still displayed an analysis overlay");
    if (jevRequests !== requestsBeforeDisabledSite) throw new Error("Disabled site still sent a JEV request");
    await page.evaluate(async () => {
      const stored = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...(stored.settings ?? {}), llm: { ...(stored.settings?.llm ?? {}), vision: "auto" }, disabledHosts: [] } });
    });
    const visionRequestsBeforeBatch = visionRequests;
    await questionPage.reload({ waitUntil: "networkidle0" });
    await questionPage.evaluate(() => {
      const nested = document.querySelector("#nested-list");
      nested.__maxScrollTopSeen = 0;
      nested.addEventListener("scroll", () => { nested.__maxScrollTopSeen = Math.max(nested.__maxScrollTopSeen, nested.scrollTop); }, { passive: true });
      window.scrollTo(0, 100);
      nested.scrollTop = 160;
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stemsBeforeBatch = jevQuestionStems.length;
    const requestsBeforeBatch = jevRequests;
    await questionPage.$eval("#choice-a", (element) => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, altKey: true })));
    await questionPage.waitForSelector('[data-jev-swot-root="page-results"]', { timeout: 5_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (jevRequests !== requestsBeforeBatch) throw new Error("Whole-page question text was sent before the user confirmed the batch");
    const pageSession = await questionPage.createCDPSession();
    await pageSession.send("Accessibility.enable");
    const { nodes } = await pageSession.send("Accessibility.getFullAXTree");
    const startButton = nodes.find((node) => node.role?.value === "button" && node.name?.value === "开始整页分析");
    if (!startButton?.backendDOMNodeId) throw new Error("Whole-page confirmation button is missing from the accessibility tree");
    const confirmationText = nodes.map((node) => node.name?.value).filter(Boolean).join(" ");
    if (!confirmationText.includes("视觉题截图") || !confirmationText.includes("浏览器快捷键") || !confirmationText.includes("单独重试该题")) throw new Error(`Whole-page confirmation did not disclose the visual-screenshot permission/retry requirement: ${confirmationText.slice(-800)}`);
    const { object } = await pageSession.send("DOM.resolveNode", { backendNodeId: startButton.backendDOMNodeId });
    await pageSession.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: "function(){this.click();document.querySelector('#choice-a').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true,altKey:true}));}", returnByValue: true });
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (jevRequests !== requestsBeforeBatch) throw new Error("A superseded whole-page scan sent questions after a rapid Alt+doubleclick restart");
    const { nodes: restartedNodes } = await pageSession.send("Accessibility.getFullAXTree");
    const restartedStartButton = restartedNodes.find((node) => node.role?.value === "button" && node.name?.value === "开始整页分析");
    if (!restartedStartButton?.backendDOMNodeId) throw new Error("Rapidly restarted whole-page scan did not show a fresh confirmation step");
    const { object: restartedObject } = await pageSession.send("DOM.resolveNode", { backendNodeId: restartedStartButton.backendDOMNodeId });
    await pageSession.send("Runtime.callFunctionOn", { objectId: restartedObject.objectId, functionDeclaration: "function(){this.click();}", returnByValue: true });
    await new Promise((resolve, reject) => { const deadline = Date.now() + 60_000; const poll = async () => {
      const { nodes: currentNodes } = await pageSession.send("Accessibility.getFullAXTree");
      const visibleText = currentNodes.map((node) => node.name?.value).filter(Boolean).join(" ");
      const retryButton = currentNodes.find((node) => node.role?.value === "button" && node.name?.value === "重新尝试这道题");
      if (jevRequests >= requestsBeforeBatch + 6 && visionRequests === visionRequestsBeforeBatch && visibleText.includes("已处理 8 / 8 题") && visibleText.includes("第 1 题") && visibleText.includes("第 8 题") && visibleText.includes("What is the final question on this long page?") && visibleText.includes("Which option is at the end of a nested scroll panel?") && visibleText.includes("Which question is inside an open shadow root?") && visibleText.includes("Which question is inside an embedded frame?") && visibleText.includes("Which question is inside a cross-origin frame?") && visibleText.includes("为避免截取错位内容") && visibleText.includes("浏览器截图还需要当前页的临时扩展权限") && retryButton?.backendDOMNodeId) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`Expected eight independent page results and a recoverable screenshot-permission error before activeTab is granted; JEV=${jevRequests - requestsBeforeBatch}, vision=${visionRequests - visionRequestsBeforeBatch}, overlay=${visibleText.slice(-1200)}`)); return; }
      setTimeout(() => { void poll(); }, 50);
    }; void poll(); });
    if (visionRequests !== visionRequestsBeforeBatch) throw new Error("Alt+doubleclick unexpectedly captured a visual question without a browser-level activeTab gesture");
    // Headless page input cannot stand in for a real browser-toolbar invocation
    // of the activeTab-granting command. Keep the per-question retry visible;
    // the exact browser UI grant/retry remains a manual release check.
    await new Promise((resolve, reject) => { const deadline = Date.now() + 10_000; const poll = async () => { if (Math.abs(await questionPage.evaluate(() => window.scrollY) - 100) < 2) resolve(); else if (Date.now() > deadline) reject(new Error("Whole-page scan did not restore the original scroll position")); else setTimeout(poll, 50); }; void poll(); });
    if (Math.abs(await questionPage.$eval("#nested-list", (element) => element.scrollTop) - 160) > 2) throw new Error("Whole-page scan did not restore the original nested scroll position");
    const batchStems = jevQuestionStems.slice(stemsBeforeBatch);
    if (!batchStems.includes("2 + 2 等于多少？") || !batchStems.includes("What is the final question on this long page?") || !batchStems.includes("Which option is at the end of a nested scroll panel?") || !batchStems.includes("Which question is inside an open shadow root?") || !batchStems.includes("Which question is inside an embedded frame?") || !batchStems.includes("Which question is inside a cross-origin frame?") || batchStems.length !== 6) throw new Error(`Whole-page scan did not send all six safe DOM questions independently through JEV: ${JSON.stringify(batchStems)}`);
    const pageExtent = await questionPage.evaluate(() => ({ maxYSeen: window.__maxYSeen, pageEnd: document.documentElement.scrollHeight - window.innerHeight }));
    if (pageExtent.maxYSeen < pageExtent.pageEnd - 4) throw new Error(`Whole-page scan did not reach the document end: ${JSON.stringify(pageExtent)}`);
    const nestedExtent = await questionPage.$eval("#nested-list", (element) => ({ maxScrollTopSeen: element.__maxScrollTopSeen, scrollEnd: element.scrollHeight - element.clientHeight }));
    if (nestedExtent.maxScrollTopSeen < nestedExtent.scrollEnd - 4) throw new Error(`Whole-page scan did not reach the nested scroll end: ${JSON.stringify(nestedExtent)}`);
    const frameExtent = await questionPage.evaluate(() => ({ maxYSeen: window.__crossFrameMaxY, currentY: window.__crossFrameY }));
    if (frameExtent.maxYSeen < 6_000 || Math.abs(frameExtent.currentY - 80) > 2) throw new Error(`Cross-origin frame was not fully scanned and restored to its original scroll offset: ${JSON.stringify(frameExtent)}`);

    // Re-run and cancel while the long cross-origin frame itself is scrolling.
    // The new confirmation panel must wait for the old frame to restore before
    // a replacement scan can begin.
    await questionPage.evaluate(() => { window.__crossFrameMaxY = 0; window.__crossFrameY = -1; });
    await questionPage.$eval("#choice-a", (element) => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, altKey: true })));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { nodes: secondNodes } = await pageSession.send("Accessibility.getFullAXTree");
    const secondStart = secondNodes.find((node) => node.role?.value === "button" && node.name?.value === "开始整页分析");
    if (!secondStart?.backendDOMNodeId) throw new Error("A fresh confirmation panel was not shown for frame cancellation coverage");
    const { object: secondStartObject } = await pageSession.send("DOM.resolveNode", { backendNodeId: secondStart.backendDOMNodeId });
    await pageSession.send("Runtime.callFunctionOn", { objectId: secondStartObject.objectId, functionDeclaration: "function(){this.click();}", returnByValue: true });
    await questionPage.waitForFunction(() => window.__crossFrameY > 500 && window.__crossFrameY < 5_000, { timeout: 30_000 });
    const requestsBeforeFrameCancel = jevRequests;
    await questionPage.$eval("#choice-a", (element) => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, altKey: true })));
    await new Promise((resolve, reject) => { const deadline = Date.now() + 10_000; const poll = async () => {
      const state = await questionPage.evaluate(() => ({ frameY: window.__crossFrameY, pageY: window.scrollY }));
      if (Math.abs(state.frameY - 80) <= 2 && Math.abs(state.pageY - 100) <= 2) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`Cancelled frame scan did not restore scroll positions: ${JSON.stringify(state)}`)); return; }
      setTimeout(() => { void poll(); }, 50);
    }; void poll(); });
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (jevRequests !== requestsBeforeFrameCancel) throw new Error("A cancelled frame scan sent further question requests after replacement");
    if (!await questionPage.$('[data-jev-swot-root="page-results"]')) throw new Error("Cancelling an embedded-frame scan did not leave the replacement confirmation panel visible");
    await questionPage.keyboard.down("Control");
    await questionPage.keyboard.down("Shift");
    await questionPage.keyboard.press("Y");
    await questionPage.keyboard.up("Shift");
    await questionPage.keyboard.up("Control");
    if (!await questionPage.$('[data-jev-swot-root="page-results"]') || await questionPage.$('[data-jev-swot-root="selection"]')) throw new Error("A selection shortcut closed the whole-page results panel instead of preserving the per-question results");
    await pageSession.detach();
    await page.evaluate(async () => {
      const stored = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...(stored.settings ?? {}), llm: { ...(stored.settings?.llm ?? {}), vision: "unsupported" } } });
    });
    // Subsequent assertions cover isolated model-routing scenarios.
    visionRequests = 0;
    const answerChanged = await questionPage.$eval('input[type="radio"]', (input) => input.checked);
    if (answerChanged) throw new Error("Extension modified the page answer during smoke test");
  }
  const directAnswer = await page.evaluate(async () => {
    await Promise.all([chrome.storage.session.set({ secrets: { llmApiKey: "smoke-llm" } }), chrome.storage.local.set({ savedSecrets: { llmApiKey: "smoke-llm" } })]);
    const question = { source: "dom", questionType: "single", stem: "Which number is even?", options: [{ id: "option_1", label: "A", text: "3" }, { id: "option_2", label: "B", text: "4" }], sourceRect: { x: 0, y: 0, width: 1, height: 1 }, recognitionConfidence: 1, warnings: [] };
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question, captureAuthorized: true });
  });
  if (!directAnswer?.ok || directAnswer.directAnswer?.answerLabels?.join(",") !== "B" || !String(directAnswer.diagnostic).includes("未配置 JEV")) throw new Error(`Ordinary-model direct answer smoke failed: ${JSON.stringify(directAnswer)}`);
  if (directAnswerRequests !== 1) throw new Error(`Ordinary-model direct answer request was not observed exactly once (direct=${directAnswerRequests})`);
  const rawOcrFallback = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, captureAuthorized: true });
  });
  if (!rawOcrFallback?.ok || rawOcrFallback.directAnswer?.answerLabels?.join(",") !== "B" || !rawOcrFallback.detailToken) throw new Error(`Raw OCR ordinary-model fallback failed: ${JSON.stringify(rawOcrFallback)}`);
  if (rawAnswerRequests !== 1 || visionRequests !== 0) throw new Error(`Raw OCR fallback used an unexpected model path (raw=${rawAnswerRequests}, vision=${visionRequests})`);
  const rawOcrDetails = await page.evaluate(async (detailToken) => chrome.runtime.sendMessage({ type: "LOAD_DETAILS", requestId: crypto.randomUUID(), detailToken }), rawOcrFallback.detailToken);
  const normalizedRawOcrStem = rawOcrDetails?.question?.stem?.normalize("NFKC").replace(/[\p{P}\p{S}\s]+/gu, " ").trim().toLowerCase();
  if (!rawOcrDetails?.ok || normalizedRawOcrStem !== "which number is even" || rawOcrDetails.directAnswer?.answerLabels?.join(",") !== "B") throw new Error(`Raw OCR details did not return the separated question: ${JSON.stringify(rawOcrDetails)}`);
  const screenshotWithoutGesture = await page.evaluate(() => chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: 320, height: 120 }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, captureAuthorized: false }));
  if (screenshotWithoutGesture?.code !== "CAPTURE_REQUIRES_SHORTCUT") throw new Error(`Screenshot fallback bypassed the explicit gesture gate: ${JSON.stringify(screenshotWithoutGesture)}`);
  await setSmokeSecrets({ typeSafeApiKey: "smoke-only", llmApiKey: "smoke-llm" });
  const jevRequestsBeforeFallback = jevRequests;
  const fallback = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, captureAuthorized: true });
  });
  if (!fallback?.ok || !fallback.probability) throw new Error(`OCR fallback smoke returned an invalid response: ${JSON.stringify(fallback)}`);
  if (!fallback.question?.warnings?.includes("VISION_MODEL_UNSUPPORTED")) throw new Error(`Configured non-vision model did not expose the local OCR fallback warning: ${JSON.stringify(fallback.question?.warnings)}`);
  const fallbackJevInputs = jevRequestBodies.slice(jevRequestsBeforeFallback).map(normalizeSmokeText);
  if (fallbackJevInputs.some((body) => body.includes("correct answer") || body.includes("explanation"))) throw new Error("OCR structure model's excluded answer/explanation text reached the JEV request");
  if (!fallbackJevInputs.some((body) => body.includes("which number is even"))) throw new Error("OCR question stem was not preserved in the JEV request");
  if (llmRequests === 0 || jevRequests <= jevRequestsBeforeFallback) throw new Error(`OCR fallback smoke request chain was not observed (llm=${llmRequests}, vision=${visionRequests}, jev=${jevRequests}, before=${jevRequestsBeforeFallback})`);
  if (visionRequests !== 0) throw new Error("Canvas OCR smoke unexpectedly uploaded an image to the vision model");
  await setSmokeSecrets({ typeSafeApiKey: "smoke-only" });
  const reviewRequired = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, captureAuthorized: true });
  });
  if (reviewRequired?.ok || reviewRequired?.code !== "STRUCTURE_REVIEW_REQUIRED") throw new Error(`OCR without a text model bypassed structure review: ${JSON.stringify(reviewRequired)}`);
  await setSmokeSecrets({ typeSafeApiKey: "smoke-only", llmApiKey: "smoke-llm" });
  await page.evaluate(() => chrome.storage.local.set({ settings: { llm: { baseUrl: "https://api.typesafe.ai/v1", model: "smoke-model", vision: "auto", structuredOutput: "unsupported" }, ocrThreshold: 0.5, useWebGpu: false, confirmVisionUpload: true, disabledHosts: [] } }));
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
  if (!visionSuccess?.ok || visionSuccess.directAnswer?.answerLabels?.join(",") !== "B" || !visionSuccess.detailToken) throw new Error(`Vision direct-answer smoke returned an invalid response: ${JSON.stringify(visionSuccess)}`);
  if (visionRequests !== visionRequestsBeforeSuccess + 1) throw new Error(`Successful vision recognition did not upload exactly one image (vision=${visionRequests})`);
  const visionDetails = await page.evaluate(async (detailToken) => chrome.runtime.sendMessage({ type: "LOAD_DETAILS", requestId: crypto.randomUUID(), detailToken }), visionSuccess.detailToken);
  if (!visionDetails?.ok || visionDetails.question?.stem !== "Which number is even?" || visionDetails.directAnswer?.answerLabels?.join(",") !== "B") throw new Error(`Vision details did not lazily return the separated question: ${JSON.stringify(visionDetails)}`);
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
  forceVisionMissingContext = true;
  const requestsBeforeMissingVisionContext = jevRequests;
  const missingVisionContext = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, visionConsent: "allow", captureAuthorized: true });
  });
  if (!missingVisionContext?.ok || missingVisionContext.directAnswer?.answerLabels?.join(",") !== "B") throw new Error(`Vision answer-first path failed when detailed context was incomplete: ${JSON.stringify(missingVisionContext)}`);
  if (jevRequests !== requestsBeforeMissingVisionContext) throw new Error("Vision answer-first path unexpectedly reached JEV");
  forceVisionMissingContext = false;
  forceVisionUnsupported = true;
  const visionRequestsBeforeFallback = visionRequests;
  const visionFallback = await page.evaluate(async () => {
    const canvas = document.createElement("canvas"); canvas.width = 900; canvas.height = 340;
    const context = canvas.getContext("2d"); context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height); context.fillStyle = "black"; context.font = "42px Arial";
    ["Which number is even?", "A. 3", "B. 4"].forEach((line, index) => context.fillText(line, 40, 75 + index * 90));
    return chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "dom", questionType: "unknown", stem: "", options: [], sourceRect: { x: 0, y: 0, width: canvas.width, height: canvas.height }, recognitionConfidence: 0.2, warnings: ["INCOMPLETE_OPTIONS"] }, screenshot: canvas.toDataURL("image/png"), devicePixelRatio: 1, visionConsent: "allow", captureAuthorized: true });
  });
  if (!visionFallback?.ok || !visionFallback.probability) throw new Error(`Vision 400 fallback smoke returned an invalid response: ${JSON.stringify(visionFallback)}`);
  if (!visionFallback.question?.warnings?.includes("VISION_MODEL_UNSUPPORTED")) throw new Error(`Vision capability fallback did not expose the unsupported-model warning: ${JSON.stringify(visionFallback.question?.warnings)}`);
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
  const multiple = await page.evaluate(() => chrome.runtime.sendMessage({ type: "ANALYZE", requestId: crypto.randomUUID(), question: { source: "user-edited", questionType: "multiple", stem: "请选择所有偶数。", options: [{ id: "option_1", label: "A", text: "2" }, { id: "option_2", label: "B", text: "3" }], sourceRect: { x: 0, y: 0, width: 1, height: 1 }, recognitionConfidence: 1, warnings: [] }, captureAuthorized: false }));
  if (!multiple?.ok || multiple.probability?.mode !== "independent-selection" || multiple.probability.options.length !== 2) throw new Error(`Multiple-choice Noul smoke returned an invalid response: ${JSON.stringify(multiple)}`);
  if (!multipleJevTargetsExplicit) throw new Error("Multiple-choice Noul request did not identify each target option without embedding option text");
  await browser.close();
  browser = await puppeteer.launch({ executablePath, headless: smokeHeadless, userDataDir, enableExtensions: true, args: smokeChromeArgs });
  await browser.installExtension(smokeExtensionPath);
  await browser.waitForTarget((item) => item.type() === "service_worker" && item.url().includes("assets/background.js"), { timeout: 15_000 });
  const restartedPage = await browser.newPage();
  await restartedPage.goto(`chrome-extension://${extensionId}/options.html`, { waitUntil: "domcontentloaded" });
  const persistedAfterRestart = await restartedPage.evaluate(() => chrome.storage.local.get(["settings", "savedSecrets"]));
  if (persistedAfterRestart.settings?.llm?.model !== "smoke-model" || persistedAfterRestart.savedSecrets?.typeSafeApiKey !== "smoke-only" || persistedAfterRestart.savedSecrets?.llmApiKey !== "smoke-llm") throw new Error(`Local configuration did not survive a browser restart: ${JSON.stringify(persistedAfterRestart)}`);
  if (persistedAfterRestart.savedSecrets?.visionDetected || persistedAfterRestart.savedSecrets?.structuredOutputDetected || persistedAfterRestart.savedSecrets?.capabilityKey) throw new Error("Capability probes unexpectedly persisted outside the browser session");
  await restartedPage.evaluate(() => chrome.runtime.sendMessage({ type: "CLEAR_SESSION" }));
  const remainingSession = await restartedPage.evaluate(() => chrome.storage.session.get(null));
  if (Object.keys(remainingSession).length !== 0) throw new Error(`Session secrets were not cleared: ${Object.keys(remainingSession).join(", ")}`);
  const persistedAfterSessionClear = await restartedPage.evaluate(() => chrome.storage.local.get("savedSecrets"));
  if (persistedAfterSessionClear.savedSecrets?.typeSafeApiKey !== "smoke-only" || persistedAfterSessionClear.savedSecrets?.llmApiKey !== "smoke-llm") throw new Error("Clearing the session unexpectedly removed persisted API keys");
  await restartedPage.evaluate(() => chrome.runtime.sendMessage({ type: "CLEAR_API_KEYS" }));
  const remainingLocal = await restartedPage.evaluate(() => chrome.storage.local.get("savedSecrets"));
  if (Object.keys(remainingLocal.savedSecrets ?? {}).length !== 0) throw new Error(`Persisted secrets were not cleared: ${Object.keys(remainingLocal.savedSecrets ?? {}).join(", ")}`);
  console.log(`Chrome loaded Jev SWOT ${extensionId}; vision→direct answer/details, OCR→JEV or raw-model fallback, and streaming explanation flows are healthy (${Math.round(ocr.confidence * 100)}%, ${ocr.backend}).`);
} finally {
  await browser?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (frameServer) { frameServer.closeAllConnections(); await new Promise((resolve) => frameServer.close(resolve)); }
  await rm(userDataDir, { recursive: true, force: true });
  await rm(smokeExtensionRoot, { recursive: true, force: true });
}
