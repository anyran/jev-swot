import type { ExtractedQuestion, ProbabilityResult } from "../shared/types";

type TypeSafeAnswer = { type: "choice"; probabilities: Record<string, number>; confidence: number } | { type: "noul"; noul: number };

export async function askJev(question: ExtractedQuestion, apiKey: string, signal?: AbortSignal): Promise<ProbabilityResult> {
  const state = {
    task: question.questionType === "multiple" ? "多项选择题" : "单项选择题",
    stem: question.stem,
    context: question.context ?? "",
    options: Object.fromEntries(question.options.map((x) => [x.id, `${x.label}. ${x.text}`]))
  };
  const questions = question.questionType === "multiple"
    ? Object.fromEntries(question.options.map((x) => [x.id, { type: "noul", instructions: `在允许多个正确答案时，选项“${x.label}. ${x.text}”是否应该被选择？` }]))
    : { answer: { type: "choice", instructions: "选择最正确的一个答案。若题目信息不足，也必须诚实地分配不确定概率。", criteria: state.options } };
  const response = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST", signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state, model: "jev-latest", questions })
  });
  if (!response.ok) throw await apiError("JEV", response);
  const data = await response.json() as { model: string; answers: Record<string, TypeSafeAnswer> };
  if (question.questionType === "multiple") {
    return { mode: "independent-selection", model: data.model, options: question.options.map((option) => ({ id: option.id, label: option.label, probability: (data.answers[option.id] as { noul: number })?.noul ?? 0 })) };
  }
  const answer = data.answers.answer as Extract<TypeSafeAnswer, { type: "choice" }>;
  return { mode: "single-distribution", model: data.model, confidence: answer.confidence, options: question.options.map((option) => ({ id: option.id, label: option.label, probability: answer.probabilities[option.id] ?? 0 })) };
}

async function apiError(name: string, response: Response): Promise<Error> {
  const body = await response.text().catch(() => "");
  return new Error(`${name} 请求失败 (${response.status})${body ? `: ${body.slice(0, 200)}` : ""}`);
}
