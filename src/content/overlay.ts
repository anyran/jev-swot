import type { ExtractedQuestion, ProbabilityResult, RecognitionPreview, WorkerResponse } from "../shared/types";

function fallbackOptionLabel(index: number): string { return index < 26 ? String.fromCharCode(65 + index) : String(index + 1); }
export interface AnswerSummary { label: string; uncertain: boolean; detail: string }
export function summarizeAnswer(probability: ProbabilityResult): AnswerSummary {
  const sorted = [...probability.options].sort((a, b) => b.probability - a.probability);
  if (probability.mode === "single-distribution") {
    const top = sorted[0];
    return { label: top?.label ?? "待确认", uncertain: !top || (probability.confidence != null && probability.confidence < 0.6), detail: top ? `${(top.probability * 100).toFixed(0)}%` : "" };
  }
  const selected = sorted.filter((option) => option.probability >= 0.5);
  const visible = selected.length ? selected : sorted.slice(0, 2);
  const borderline = sorted.some((option) => Math.abs(option.probability - 0.5) <= 0.09);
  return { label: visible.length ? visible.map((option) => option.label).join("、") : "待确认", uncertain: selected.length === 0 || borderline, detail: selected.length ? "选择倾向" : "暂无过半概率" };
}

export class ResultOverlay {
  private host = document.createElement("div");
  private root: ShadowRoot;
  private question?: ExtractedQuestion;
  private probability?: ProbabilityResult;
  private preview?: RecognitionPreview;
  private position = { left: 16, top: 16 };
  private expanded = false;
  constructor(private retry: (q: ExtractedQuestion, visionConsent?: "allow" | "deny") => void, private explain: (q: ExtractedQuestion, p: ProbabilityResult) => void, private cancel: () => void) {
    this.host.dataset.jevSwotRoot = "true";
    this.root = this.host.attachShadow({ mode: "closed" });
  }
  loading(question: ExtractedQuestion) { this.question = question; this.probability = undefined; this.preview = undefined; this.expanded = false; this.progress("正在准备识别…"); }
  progress(message: string) { this.render(`<div class="status"><span class="spinner"></span>${escapeHtml(message)} <button data-action="cancel">取消</button></div>`); }
  show(response: WorkerResponse) {
    if (response.question) this.question = response.question;
    if (response.preview) this.preview = response.preview;
    if (!response.ok) {
      this.expanded = true;
      const consent = response.code === "VISION_CONSENT_REQUIRED" ? `<div class="actions"><button data-action="local-only">仅本地 OCR（不上传截图）</button><button class="primary" data-action="allow-vision">允许本次上传</button></div>` : "";
      this.render(`<div class="error">${escapeHtml(response.message)}</div>${consent}${response.code === "VISION_CONSENT_REQUIRED" ? "" : this.editor()}`); return;
    }
    if (response.probability) this.probability = response.probability;
    const p = this.probability;
    if (!p) return;
    this.expanded = false;
    this.render(this.compact());
  }
  explanation(text: string) { const node = this.root.querySelector("#explanation"); if (node) node.textContent = text; }
  explanationChunk(text: string) { const node = this.root.querySelector("#explanation"); if (node) node.textContent += text; }
  private compact() {
    const probability = this.probability; if (!probability) return "";
    const summary = summarizeAnswer(probability);
    return `<div class="answer-compact"><span>${summary.uncertain ? "倾向" : "答案"}</span><strong>${escapeHtml(summary.label)}</strong>${summary.detail ? `<small>${escapeHtml(summary.detail)}</small>` : ""}</div>`;
  }
  private details() {
    const p = this.probability; if (!p) return "";
    const rows = [...p.options].sort((a, b) => b.probability - a.probability).map((x) => {
      const questionOption = this.question?.options.find((option) => option.id === x.id);
      return `<div class="row" data-option-id="${escapeHtml(x.id)}"><div class="option-copy"><b>${escapeHtml(x.label)}</b><span title="${escapeHtml(questionOption?.text ?? "")}">${escapeHtml(questionOption?.text ?? "")}</span></div><div class="bar"><i style="width:${Math.round(x.probability * 100)}%"></i></div><strong>${(x.probability * 100).toFixed(1)}%</strong></div>`;
    }).join("");
    const summary = summarizeAnswer(p);
    const confidence = p.confidence == null ? `多选项概率相互独立，不合计为 100%${summary.uncertain ? " · 不确定" : ""}` : `整体置信度 ${(p.confidence * 100).toFixed(0)}%${summary.uncertain ? " · 不确定" : ""}`;
    return `<div class="detail-view"><div class="rows">${rows}</div><small>${confidence} · ${escapeHtml(p.model)}</small>${this.warnings()}<div class="actions"><button data-action="edit">校正题目</button><button class="primary" data-action="explain">答案解析</button></div><div id="explanation"></div></div>`;
  }
  private warnings() { return this.question?.warnings.length ? `<div class="warning">${this.question.warnings.map(warningText).join("；")}</div>` : ""; }
  private editor() {
    const q = this.question; if (!q) return "";
    return `<div class="editor">${this.previewHtml()}<label>题型<select id="type"><option value="single" ${q.questionType === "single" ? "selected" : ""}>单选</option><option value="multiple" ${q.questionType === "multiple" ? "selected" : ""}>多选</option></select></label><label>题干<textarea id="stem">${escapeHtml(q.stem)}</textarea></label><label>选项（每行一个）<textarea id="options">${escapeHtml(q.options.map((x) => `${x.label}. ${x.text}`).join("\n"))}</textarea></label><label>补充上下文/图形描述（可选）<textarea id="context">${escapeHtml(q.context ?? "")}</textarea></label><button class="primary" data-action="retry">重新判断</button></div>`;
  }
  private previewHtml() {
    const p = this.preview; if (!p) return "";
    const boxes = p.boxes.map((box) => `<button type="button" class="ocr-box" title="${escapeHtml(box.text)} · ${(box.confidence * 100).toFixed(0)}%" style="left:${box.x / p.width * 100}%;top:${box.y / p.height * 100}%;width:${box.width / p.width * 100}%;height:${box.height / p.height * 100}%"></button>`).join("");
    const rawText = p.boxes.map((box) => box.text).join("\n");
    const excluded = p.excludedText ? `<details class="excluded"><summary>模型排除的非题目文字</summary><pre class="ocr-text">${escapeHtml(p.excludedText)}</pre></details>` : "";
    return `<details class="preview" open><summary>识别原图、OCR 文本与文本框</summary><div class="preview-image"><img src="${escapeHtml(p.imageDataUrl)}" alt="本次识别的题目截图">${boxes}</div><pre class="ocr-text">${escapeHtml(rawText || "（未检测到文字）")}</pre>${excluded}<small>点击或悬停文本框可查看逐项 OCR 置信度；截图仅保留在本次覆盖层内。</small></details>`;
  }
  private render(content: string) {
    if (!this.host.isConnected) document.documentElement.append(this.host);
    const toggle = this.probability ? `<button data-action="toggle-details">${this.expanded ? "收起" : "详情"}</button>` : "";
    this.root.innerHTML = `<style>${CSS_TEXT}</style><section class="${this.expanded ? "expanded" : "compact"}" style="left:${this.position.left}px;top:${this.position.top}px"><header><b>Jev</b><small>Jev SWOT</small><span>${toggle}<button data-action="close">×</button></span></header><main>${content}</main></section>`;
    this.root.querySelector('[data-action="close"]')?.addEventListener("click", () => { this.cancel(); this.question = undefined; this.probability = undefined; this.preview = undefined; this.host.remove(); });
    this.root.querySelector('[data-action="cancel"]')?.addEventListener("click", () => { this.cancel(); this.expanded = true; this.render(`<div class="warning">已取消当前请求。</div>${this.editor()}`); });
    this.root.querySelector('[data-action="toggle-details"]')?.addEventListener("click", () => { this.expanded = !this.expanded; this.render(this.expanded ? this.details() : this.compact()); });
    this.root.querySelector('[data-action="edit"]')?.addEventListener("click", () => { this.expanded = true; this.render(this.editor()); });
    this.root.querySelector('[data-action="explain"]')?.addEventListener("click", () => { if (this.question && this.probability) { this.explanation("正在生成解析…"); this.explain(this.question, this.probability); } });
    this.root.querySelector('[data-action="retry"]')?.addEventListener("click", () => this.submitEdit());
    this.root.querySelector('[data-action="local-only"]')?.addEventListener("click", () => { if (this.question) this.retry(this.question, "deny"); });
    this.root.querySelector('[data-action="allow-vision"]')?.addEventListener("click", () => { if (this.question) this.retry(this.question, "allow"); });
    this.root.querySelectorAll<HTMLElement>("[data-option-id]").forEach((row) => row.addEventListener("click", () => this.highlightOption(row.dataset.optionId!)));
    this.root.querySelectorAll<HTMLElement>(".ocr-box").forEach((box) => box.addEventListener("click", () => { const summary = box.getAttribute("title"); if (summary) box.setAttribute("data-label", summary); }));
    this.bindDragging();
  }
  private highlightOption(id: string) {
    const rect = this.question?.options.find((option) => option.id === id)?.sourceRect;
    if (!rect) return;
    const marker = document.createElement("div"); marker.dataset.jevSwotRoot = "highlight";
    Object.assign(marker.style, { position: "fixed", zIndex: "2147483645", pointerEvents: "none", left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, border: "2px solid #f59e0b", background: "#f59e0b22", borderRadius: "4px" });
    document.documentElement.append(marker); setTimeout(() => marker.remove(), 1800);
  }
  private bindDragging() {
    const section = this.root.querySelector("section") as HTMLElement | null;
    const header = this.root.querySelector("header") as HTMLElement | null;
    if (!section || !header) return;
    header.addEventListener("pointerdown", (event) => {
      if ((event.target as Element).closest("button")) return;
      const bounds = section.getBoundingClientRect(), dx = event.clientX - bounds.left, dy = event.clientY - bounds.top;
      header.setPointerCapture(event.pointerId);
      const move = (next: PointerEvent) => {
        this.position.left = Math.max(0, Math.min(innerWidth - section.offsetWidth, next.clientX - dx));
        this.position.top = Math.max(0, Math.min(innerHeight - 40, next.clientY - dy));
        section.style.left = `${this.position.left}px`; section.style.top = `${this.position.top}px`;
      };
      header.addEventListener("pointermove", move);
      header.addEventListener("pointerup", () => header.removeEventListener("pointermove", move), { once: true });
    });
  }
  private submitEdit() {
    if (!this.question) return;
    const stem = (this.root.querySelector("#stem") as HTMLTextAreaElement).value.trim();
    const lines = (this.root.querySelector("#options") as HTMLTextAreaElement).value.split("\n").map((x) => x.trim()).filter(Boolean);
    const options = lines.map((line, i) => { const m = /^([A-Ha-h]|[1-9]\d{0,2}|[①-⑨])[.、)）:]?\s*(.*)$/.exec(line); return { id: `option_${i + 1}`, label: m?.[1]?.toUpperCase() ?? fallbackOptionLabel(i), text: m?.[2] || line }; });
    const context = (this.root.querySelector("#context") as HTMLTextAreaElement).value.trim();
    const q: ExtractedQuestion = { ...this.question, source: "user-edited", stem, options, context, questionType: (this.root.querySelector("#type") as HTMLSelectElement).value as "single" | "multiple", recognitionConfidence: 1, warnings: [] };
    this.retry(q);
  }
}
function warningText(w: string) { return ({ LOW_OCR_CONFIDENCE: "OCR 置信度较低", POSSIBLE_FORMULA: "可能包含公式", POSSIBLE_DIAGRAM: "可能依赖图形", INCOMPLETE_OPTIONS: "选项可能不完整", VISION_MODEL_REQUIRED: "建议使用视觉模型", VISION_MODEL_UNSUPPORTED: "当前视觉模型不支持图片，已降级到本地 OCR", VISION_SERVICE_UNAVAILABLE: "视觉服务暂时不可用，已降级到本地 OCR", DOM_OCR_CONFLICT: "网页文字与 OCR 结果冲突", STRUCTURE_REVIEW_REQUIRED: "题目结构尚未确认，请校正" } as Record<string, string>)[w] ?? w; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
const CSS_TEXT = `:host{all:initial}section{position:fixed;z-index:2147483647;left:12px;top:12px;width:220px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;background:#111827ee;color:#f9fafb;border:1px solid #374151;border-radius:10px;box-shadow:0 10px 28px #0005;font:13px/1.4 system-ui,sans-serif;backdrop-filter:blur(8px)}section.compact{width:200px}section.compact header{border-bottom:0;padding:6px 8px}section.compact header small{display:none}section.compact main{padding:4px 8px 8px}section.expanded{width:360px;max-width:calc(100vw - 24px)}header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid #374151;cursor:move}header span{display:flex;gap:4px}header button{background:none;border:0;color:#d1d5db;font-size:12px;padding:2px 5px}main{padding:10px}.answer-compact{display:flex;align-items:baseline;gap:7px;white-space:nowrap;overflow:hidden}.answer-compact span{color:#9ca3af;font-size:12px}.answer-compact strong{font-size:20px;line-height:1.1;overflow:hidden;text-overflow:ellipsis}.answer-compact small{color:#9ca3af}.row{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(48px,1fr) 52px;gap:8px;align-items:center;margin:9px 0}.row[data-option-id]{cursor:pointer}.row[data-option-id]:hover{background:#ffffff0d}.option-copy{min-width:0;display:flex;gap:6px;align-items:baseline}.option-copy>b{flex:0 0 auto}.option-copy span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#d1d5db}.bar{height:9px;background:#374151;border-radius:9px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,#22c55e,#60a5fa)}small{color:#9ca3af}.warning,.error{margin:10px 0;padding:9px;border-radius:8px;background:#78350f;color:#fef3c7}.error{background:#7f1d1d}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}button{cursor:pointer;border:1px solid #4b5563;background:#1f2937;color:#fff;padding:6px 10px;border-radius:7px}.primary{background:#2563eb;border-color:#3b82f6}.editor label{display:block;margin:9px 0}.editor textarea,.editor select{box-sizing:border-box;width:100%;margin-top:4px;background:#0f172a;color:#fff;border:1px solid #475569;border-radius:7px;padding:7px}.editor textarea{min-height:64px;resize:vertical}.preview{margin-bottom:12px}.preview summary{cursor:pointer}.preview-image{position:relative;margin:7px 0;line-height:0}.preview-image img{display:block;width:100%;height:auto;background:#fff}.ocr-text{max-height:140px;overflow:auto;white-space:pre-wrap;margin:7px 0;padding:7px;background:#0f172a;color:#cbd5e1;border-radius:7px;font:12px/1.4 ui-monospace,monospace}.ocr-box{position:absolute;padding:0;border:1px solid #22d3ee;background:#22d3ee18;border-radius:2px}.ocr-box:hover,.ocr-box:focus{background:#f59e0b33;border-color:#f59e0b}.ocr-box[data-label]::after{content:attr(data-label);position:absolute;left:0;top:100%;z-index:2;min-width:120px;padding:4px;background:#020617;color:white;font:11px/1.3 system-ui;white-space:normal}.spinner{display:inline-block;width:14px;height:14px;border:2px solid #64748b;border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite;margin-right:8px}@keyframes s{to{transform:rotate(360deg)}}#explanation{white-space:pre-wrap;margin-top:12px;color:#e5e7eb}`;
