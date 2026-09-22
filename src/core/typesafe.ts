import type { ExtractedQuestion, ProbabilityResult } from "../shared/types";

type TypeSafeAnswer = { type: "choice"; probabilities: Record<string, number>; confidence: number } | { type: "noul"; noul: number };

export async function askJev(question: ExtractedQuestion, apiKey: string, signal?: AbortSignal): Promise<ProbabilityResult> {
  if (signal?.aborted) throw new Error("JEV 请求已取消。");
  const state = {
    task: question.questionType === "multiple" ? "多项选择题" : "单项选择题",
    stem: question.stem,
    context: question.context ?? "",
    options: Object.fromEntries(question.options.map((x) => [x.id, `${x.label}. ${x.text}`]))
  };
  const questions = question.questionType === "multiple"
    ? Object.fromEntries(question.options.map((x) => [x.id, { type: "noul", instructions: `在允许多个正确答案时，选项“${x.label}. ${x.text}”是否应该被选择？` }]))
    : { answer: { type: "choice", instructions: "选择最正确的一个答案。若题目信息不足，也必须诚实地分配不确定概率。", criteria: state.options } };
  const init: RequestInit = {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions })
  };
  let response = await timedFetch("https://api.typesafe.ai/v1/systemone", init, signal);
  if (response.status === 429 || response.status >= 500) {
    const retryAfter = Math.min(2_000, Number(response.headers.get("retry-after") ?? 0) * 1_000 || 250);
    await delay(retryAfter, signal);
    response = await timedFetch("https://api.typesafe.ai/v1/systemone", init, signal);
  }
  if (!response.ok) throw await apiError("JEV", response);
  const data = await response.json() as { model?: string; answers?: Record<string, TypeSafeAnswer> };
  if (!data.answers) throw new Error("JEV 返回缺少答案结果。");
  if (question.questionType === "multiple") {
    const options = question.options.map((option) => {
      const answer = data.answers?.[option.id];
      if (!answer || answer.type !== "noul") throw new Error(`JEV 返回缺少选项 ${option.label} 的 Noul 结果。`);
      const value = finiteProbability(answer.noul);
      if (value == null) throw new Error(`JEV 返回的选项 ${option.label} 概率无效。`);
      return { id: option.id, label: option.label, probability: value };
    });
    return { mode: "independent-selection", model: data.model || "jev-latest", options };
  }
  const answer = data.answers.answer as Extract<TypeSafeAnswer, { type: "choice" }>;
  if (!answer?.probabilities) throw new Error("JEV 返回缺少 Choice 概率。");
  const raw = question.options.map((option) => finiteProbability(answer.probabilities[option.id]));
  if (raw.some((value) => value == null)) throw new Error("JEV 返回的 Choice 概率未覆盖全部选项。");
  const values = raw as number[], total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0) throw new Error("JEV 返回的 Choice 概率无效。");
  return { mode: "single-distribution", model: data.model || "jev-latest", confidence: probability(answer.confidence), options: question.options.map((option, index) => ({ id: option.id, label: option.label, probability: values[index] / total })) };
}
function probability(value: unknown): number { const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0; }
function finiteProbability(value: unknown): number | undefined { if (value == null || value === "") return undefined; const number = Number(value); return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : undefined; }
async function timedFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(new DOMException("JEV 请求超时", "TimeoutError")), 30_000);
  const abort = () => controller.abort(signal?.reason); signal?.addEventListener("abort", abort, { once: true });
  try { return await fetch(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeout); signal?.removeEventListener("abort", abort); }
}
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason ?? new Error("JEV 请求已取消。")); return; }
    const timer = setTimeout(resolve, ms); signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason ?? new Error("JEV 请求已取消。")); }, { once: true });
  });
}

async function apiError(name: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(`${name} 请求失败 (${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
}
