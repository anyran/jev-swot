const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const timeoutMs = 30_000;

const typeSafeApiKey = process.env.JEV_TYPESAFE_API_KEY?.trim();
if (!typeSafeApiKey) {
  console.error("Missing JEV_TYPESAFE_API_KEY; live validation was not run.");
  process.exit(2);
}

const single = await requestJev(typeSafeApiKey, {
  questionType: "single",
  stem: "2 + 2 等于多少？",
  options: [
    { id: "option_1", label: "A", text: "3" },
    { id: "option_2", label: "B", text: "4" }
  ]
});
const singleProbabilities = [single.answers?.answer?.probabilities?.option_1, single.answers?.answer?.probabilities?.option_2].map(numberValue);
if (singleProbabilities.some((value) => value == null)) fail("TypeSafe Choice response did not include both option probabilities.");
const singleTotal = singleProbabilities.reduce((sum, value) => sum + value, 0);
if (singleTotal <= 0 || Math.abs(singleTotal - 1) > 0.05) fail(`TypeSafe Choice probabilities do not sum to approximately 1 (received ${singleTotal}).`);
console.log(`JEV single Choice: ok (sum=${singleTotal.toFixed(4)})`);

const multiple = await requestJev(typeSafeApiKey, {
  questionType: "multiple",
  stem: "哪些数字是偶数？",
  options: [
    { id: "option_1", label: "A", text: "2" },
    { id: "option_2", label: "B", text: "3" },
    { id: "option_3", label: "C", text: "4" }
  ]
});
const multipleAnswers = [multiple.answers?.option_1, multiple.answers?.option_2, multiple.answers?.option_3];
if (multipleAnswers.some((answer) => answer?.type !== "noul" || numberValue(answer.noul) == null)) fail("TypeSafe multiple-choice response did not include an independent Noul for every option.");
console.log("JEV multiple Noul: ok (independent probabilities present for all options)");

const llmValues = [process.env.JEV_LLM_BASE_URL, process.env.JEV_LLM_MODEL, process.env.JEV_LLM_API_KEY].map((value) => value?.trim());
if (llmValues.every((value) => !value)) {
  console.log("OpenAI-compatible checks: skipped (set JEV_LLM_BASE_URL, JEV_LLM_MODEL and JEV_LLM_API_KEY to run them).");
} else if (llmValues.some((value) => !value)) {
  fail("Set all three OpenAI-compatible variables together: JEV_LLM_BASE_URL, JEV_LLM_MODEL and JEV_LLM_API_KEY.");
} else {
  const [baseUrl, model, apiKey] = llmValues;
  const text = await requestLlm(baseUrl, model, apiKey, {
    temperature: 0,
    messages: [
      { role: "system", content: "只输出 JSON。" },
      { role: "user", content: '返回 {"ok":true}。' }
    ],
    response_format: { type: "json_object" }
  });
  const textContent = readContent(text);
  if (!textContent.includes("ok")) fail("OpenAI-compatible text response did not contain the expected JSON marker.");
  console.log("OpenAI-compatible text model: ok");

  const visionResponse = await requestLlm(baseUrl, model, apiKey, {
    temperature: 0,
    messages: [{ role: "user", content: [{ type: "text", text: "描述这张图片，只输出一句话。" }, { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" } }] }]
  }, true);
  if (visionResponse.kind === "supported") console.log("OpenAI-compatible vision model: supported");
  else if (visionResponse.kind === "unsupported") console.log("OpenAI-compatible vision model: unsupported (extension will use local OCR)");
  else fail(`OpenAI-compatible vision check failed: ${visionResponse.message}`);
}

async function requestJev(apiKey, question) {
  const questions = question.questionType === "multiple"
    ? Object.fromEntries(question.options.map((option) => [option.id, { type: "noul", instructions: `选项“${option.label}. ${option.text}”是否应该被选择？` }]))
    : { answer: { type: "choice", instructions: "选择最正确的一个答案。", criteria: Object.fromEntries(question.options.map((option) => [option.id, `${option.label}. ${option.text}`])) } };
  const response = await fetchWithTimeout(TYPESAFE_URL, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: "jev-latest", state: { task: question.questionType === "multiple" ? "多项选择题" : "单项选择题", stem: question.stem, options: Object.fromEntries(question.options.map((option) => [option.id, `${option.label}. ${option.text}`])) }, questions }) });
  return readJsonResponse("TypeSafe", response);
}

async function requestLlm(baseUrl, model, apiKey, body, isVision = false) {
  let response;
  try {
    response = await fetchWithTimeout(`${baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model, ...body }) });
  } catch (error) {
    return isVision ? { kind: "error", message: error instanceof Error ? error.message : "network error" } : fail("OpenAI-compatible text request failed.");
  }
  if (response.ok) return isVision ? { kind: "supported" } : readJsonResponse("OpenAI-compatible model", response);
  const message = await response.text().catch(() => "");
  if (isVision && [400, 415, 422].includes(response.status) && (/image|vision|multimodal|image_url|only.*text|unsupported/i.test(message) || response.status === 415)) return { kind: "unsupported" };
  return isVision ? { kind: "error", message: `HTTP ${response.status}${message ? `: ${message.slice(0, 160)}` : ""}` } : fail(`OpenAI-compatible text request failed with HTTP ${response.status}.`);
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timer); }
}

async function readJsonResponse(name, response) {
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    fail(`${name} request failed with HTTP ${response.status}${message ? `: ${message.slice(0, 160)}` : ""}.`);
  }
  try { return await response.json(); }
  catch { fail(`${name} response was not valid JSON.`); }
}

function readContent(response) { return String(response.choices?.[0]?.message?.content ?? ""); }
function numberValue(value) { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : undefined; }
function fail(message) { console.error(message); process.exit(1); }
