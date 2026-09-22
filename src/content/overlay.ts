import type { DirectAnswerResult, ExtractedQuestion, ProbabilityResult, RecognitionPreview, WorkerResponse } from "../shared/types";

function fallbackOptionLabel(index: number): string { return index < 26 ? String.fromCharCode(65 + index) : String(index + 1); }
export interface AnswerSummary { label: string; uncertain: boolean; detail: string }
export function summarizeAnswer(probability: ProbabilityResult): AnswerSummary {
  const sorted = [...probability.options].sort((a, b) => b.probability - a.probability);
  if (probability.mode === "single-distribution") {
    const top = sorted[0];
    return { label: top?.label ?? "待确认", uncertain: !top || top.probability < 0.6 || (probability.confidence != null && probability.confidence < 0.6), detail: top ? `${(top.probability * 100).toFixed(0)}%` : "" };
  }
  const selected = sorted.filter((option) => option.probability >= 0.5);
  const visible = selected.length ? selected : sorted.slice(0, 2);
  const borderline = sorted.some((option) => Math.abs(option.probability - 0.5) <= 0.09);
  return { label: visible.length ? visible.map((option) => option.label).join("、") : "待确认", uncertain: selected.length === 0 || borderline, detail: selected.length ? "选择倾向" : "暂无过半概率" };
}

type RgbaColor = { r: number; g: number; b: number; a: number };
export type OverlayPalette = {
  text: string;
  muted: string;
  strong: string;
  shadow: string;
  bar: string;
};

/**
 * Keep the compact answer close to the page's visual weight. The expanded
 * panel remains fully readable, while the compact answer uses a low-alpha
 * foreground and becomes more visible on hover/focus.
 */
export function overlayPaletteForLuminance(luminance = 1): OverlayPalette {
  const lightBackground = luminance >= 0.52;
  if (lightBackground) {
    return {
      text: "rgba(17,24,39,.52)",
      muted: "rgba(17,24,39,.38)",
      strong: "rgba(0,0,0,.66)",
      shadow: "0 1px 2px rgba(255,255,255,.62),0 -1px 2px rgba(255,255,255,.62),1px 0 2px rgba(255,255,255,.62),-1px 0 2px rgba(255,255,255,.62)",
      bar: "rgba(17,24,39,.18)"
    };
  }
  return {
    text: "rgba(255,255,255,.58)",
    muted: "rgba(255,255,255,.44)",
    strong: "rgba(255,255,255,.78)",
    shadow: "0 1px 2px rgba(0,0,0,.58),0 -1px 2px rgba(0,0,0,.58),1px 0 2px rgba(0,0,0,.58),-1px 0 2px rgba(0,0,0,.58)",
    bar: "rgba(255,255,255,.28)"
  };
}

export class ResultOverlay {
  private host = document.createElement("div");
  private root: ShadowRoot;
  private question?: ExtractedQuestion;
  private probability?: ProbabilityResult;
  private directResult?: DirectAnswerResult;
  private preview?: RecognitionPreview;
  private detailToken?: string;
  private diagnostic?: string;
  private detailsLoaded = false;
  private position = { left: 16, top: 16 };
  private expanded = false;
  private captureAuthorized = false;
  constructor(private retry: (q: ExtractedQuestion, visionConsent?: "allow" | "deny", captureAuthorized?: boolean) => void, private explain: (q: ExtractedQuestion, p: ProbabilityResult) => void, private direct: (q: ExtractedQuestion) => void, private cancel: () => void, private loadDetails: (token: string) => void = () => undefined) {
    this.host.dataset.jevSwotRoot = "true";
    this.root = this.host.attachShadow({ mode: "closed" });
  }
  dismiss() {
    this.cancel();
    this.question = undefined;
    this.probability = undefined;
    this.directResult = undefined;
    this.preview = undefined;
    this.detailToken = undefined;
    this.diagnostic = undefined;
    this.detailsLoaded = false;
    this.captureAuthorized = false;
    this.host.remove();
  }
  loading(question: ExtractedQuestion, captureAuthorized = false) { this.question = question; this.probability = undefined; this.directResult = undefined; this.preview = undefined; this.detailToken = undefined; this.diagnostic = undefined; this.detailsLoaded = false; this.captureAuthorized = captureAuthorized; this.expanded = false; this.progress("正在准备识别…"); }
  directLoading(question: ExtractedQuestion) { this.question = question; this.probability = undefined; this.directResult = undefined; this.preview = undefined; this.detailToken = undefined; this.diagnostic = undefined; this.detailsLoaded = true; this.expanded = false; this.progress("正在请求普通模型答题…"); }
  progress(message: string) { this.render(`<div class="status"><span class="spinner"></span>${escapeHtml(message)} <button data-action="cancel">取消</button></div>`); }
  show(response: WorkerResponse) {
    if (response.question) this.question = response.question;
    if (response.preview) this.preview = response.preview;
    if (response.ok && response.detailToken) this.detailToken = response.detailToken;
    if (response.ok && response.diagnostic) this.diagnostic = response.diagnostic;
    if (response.question) this.detailsLoaded = true;
    if (!response.ok) {
      this.expanded = true;
      const consent = response.code === "VISION_CONSENT_REQUIRED" ? `<div class="actions"><button data-action="local-only">仅本地 OCR（不上传截图）</button><button class="primary" data-action="allow-vision">允许本次上传</button></div>` : "";
      const canRetryDirect = response.code === "JEV_KEY_MISSING" || response.code === "DIRECT_ANSWER_FAILED";
      const direct = canRetryDirect && this.question ? `<div class="actions"><button class="primary" data-action="direct-answer">普通模型直接答题</button></div><small>只发送已确认的题干和选项，不上传截图。</small>` : "";
      this.render(`<div class="error">${escapeHtml(response.message)}</div>${consent}${direct}${response.code === "VISION_CONSENT_REQUIRED" ? "" : this.editor()}`); return;
    }
    if (response.directAnswer) {
      this.directResult = response.directAnswer;
      this.probability = undefined;
      this.expanded = false;
      this.render(this.compact());
      return;
    }
    if (response.probability) this.probability = response.probability;
    const p = this.probability;
    if (!p) return;
    this.expanded = false;
    this.render(this.compact());
  }
  detailsLoading() { this.expanded = true; this.render(`<div class="status"><span class="spinner"></span>正在识别题干和候选项… <button data-action="cancel">取消</button></div>`); }
  showDetails(response: WorkerResponse) {
    if (!response.ok) { this.show(response); return; }
    if (response.question) { this.question = response.question; this.detailsLoaded = true; }
    if (response.preview) this.preview = response.preview;
    if (response.directAnswer) this.directResult = response.directAnswer;
    this.detailToken = undefined;
    this.diagnostic = response.diagnostic ?? this.diagnostic;
    this.expanded = true;
    this.render(this.details());
  }
  explanation(text: string) { const node = this.root.querySelector("#explanation"); if (node) node.textContent = text; }
  explanationChunk(text: string) { const node = this.root.querySelector("#explanation"); if (node) node.textContent += text; }
  private compact() {
    if (this.directResult) {
      const answer = escapeHtml(this.directResult.answerLabels.join("、"));
      return `<div class="answer-compact" aria-label="答案 ${answer}"><strong>${answer}</strong></div>`;
    }
    const probability = this.probability; if (!probability) return "";
    const summary = summarizeAnswer(probability);
    const answer = escapeHtml(summary.label);
    const accessibleLabel = summary.uncertain ? `不确定，倾向 ${answer}` : `答案 ${answer}`;
    const uncertainty = summary.uncertain ? ` data-uncertain="true" title="不确定，仅供参考"` : "";
    return `<div class="answer-compact" aria-label="${accessibleLabel}"${uncertainty}><strong>${answer}</strong></div>`;
  }
  private details() {
    if (this.directResult) return this.directDetails();
    const p = this.probability; if (!p) return "";
    const rows = [...p.options].sort((a, b) => b.probability - a.probability).map((x) => {
      const questionOption = this.question?.options.find((option) => option.id === x.id);
      return `<div class="row" data-option-id="${escapeHtml(x.id)}"><div class="option-copy"><b>${escapeHtml(x.label)}</b><span title="${escapeHtml(questionOption?.text ?? "")}">${escapeHtml(questionOption?.text ?? "")}</span></div><div class="bar"><i style="width:${Math.round(x.probability * 100)}%"></i></div><strong>${(x.probability * 100).toFixed(1)}%</strong></div>`;
    }).join("");
    const summary = summarizeAnswer(p);
    const confidence = p.confidence == null ? `多选项概率相互独立，不合计为 100%${summary.uncertain ? " · 不确定" : ""}` : `整体置信度 ${(p.confidence * 100).toFixed(0)}%${summary.uncertain ? " · 不确定" : ""}`;
    return `<div class="detail-view"><div class="rows">${rows}</div><small>${confidence} · ${escapeHtml(p.model)}</small>${this.warnings()}<div class="actions"><button data-action="edit">校正题目</button><button data-action="direct-answer">普通模型答题</button><button class="primary" data-action="explain">答案解析</button></div><small>普通模型答题只发送已确认的题干、上下文和选项，不上传截图。</small><div id="explanation"></div></div>`;
  }
  private directDetails() {
    const result = this.directResult; if (!result) return "";
    const points = result.knowledgePoints.length ? `<ul>${result.knowledgePoints.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>` : "";
    const recognized = this.detailsLoaded && this.question?.stem ? `<div class="recognized-question"><b>题干</b><p>${escapeHtml(this.question.stem)}</p><b>候选项</b><ol>${this.question.options.map((option) => `<li><strong>${escapeHtml(option.label)}</strong> ${escapeHtml(option.text)}</li>`).join("")}</ol></div>` : `<small>点击详情后识别题干和候选项；当前先显示模型给出的可能答案。</small>`;
    const diagnostic = this.diagnostic ? `<small>${escapeHtml(this.diagnostic)}</small>` : "";
    return `<div class="detail-view"><p><strong>可能答案：${escapeHtml(result.answerLabels.join("、"))}</strong> · ${escapeHtml(result.model)}</p>${recognized}${diagnostic}<p class="explanation-copy">${escapeHtml(result.explanation)}</p>${points}<small>不确定性：${escapeHtml(result.uncertainty)}</small>${this.warnings()}<div class="actions"><button data-action="edit">校正题目</button></div></div>`;
  }
  private warnings() { return this.question?.warnings.length ? `<div class="warning">${this.question.warnings.map(warningText).join("；")}</div>` : ""; }
  private editor() {
    const q = this.question; if (!q) return "";
    return `<div class="editor">${this.previewHtml()}<label>题型<select id="type"><option value="unknown" ${q.questionType === "unknown" ? "selected" : ""}>请选择题型</option><option value="single" ${q.questionType === "single" ? "selected" : ""}>单选</option><option value="multiple" ${q.questionType === "multiple" ? "selected" : ""}>多选</option></select></label><label>题干<textarea id="stem">${escapeHtml(q.stem)}</textarea></label><label>选项（每行一个）<textarea id="options">${escapeHtml(q.options.map((x) => `${x.label}. ${x.text}`).join("\n"))}</textarea></label><label>补充上下文/图形描述（可选）<textarea id="context">${escapeHtml(q.context ?? "")}</textarea></label><button class="primary" data-action="retry">重新判断</button></div>`;
  }
  private previewHtml() {
    const p = this.preview; if (!p) return "";
    const boxes = p.boxes.map((box) => `<button type="button" class="ocr-box" title="${escapeHtml(box.text)} · ${(box.confidence * 100).toFixed(0)}%" style="left:${box.x / p.width * 100}%;top:${box.y / p.height * 100}%;width:${box.width / p.width * 100}%;height:${box.height / p.height * 100}%"></button>`).join("");
    const rawText = p.boxes.map((box) => box.text).join("\n");
    const excluded = p.excludedText ? `<details class="excluded"><summary>模型排除的非题目文字</summary><pre class="ocr-text">${escapeHtml(p.excludedText)}</pre></details>` : "";
    const overallConfidence = this.question ? `整体识别置信度 ${(this.question.recognitionConfidence * 100).toFixed(0)}% · ` : "";
    return `<details class="preview" open><summary>识别原图、OCR 文本与文本框</summary><div class="preview-image"><img src="${escapeHtml(p.imageDataUrl)}" alt="本次识别的题目截图">${boxes}</div><pre class="ocr-text">${escapeHtml(rawText || "（未检测到文字）")}</pre>${excluded}<small>${overallConfidence}点击或悬停文本框可查看逐项 OCR 置信度；截图仅保留在本次覆盖层内。</small></details>`;
  }
  private render(content: string) {
    if (!this.host.isConnected) document.documentElement.append(this.host);
    const toggle = this.probability || this.directResult
      ? `<button type="button" class="details-toggle" data-action="toggle-details" aria-label="${this.expanded ? "收起详情" : "查看详情"}" title="${this.expanded ? "收起详情" : "查看详情"}"><span class="chevron" aria-hidden="true"></span></button>`
      : "";
    const palette = this.nearbyPalette();
    const paletteStyle = Object.entries(palette).map(([name, value]) => `--jev-${name}:${value}`).join(";");
    this.root.innerHTML = `<style>${CSS_TEXT}</style><section class="${this.expanded ? "expanded" : "compact"}" style="left:${this.position.left}px;top:${this.position.top}px;${paletteStyle}"><header><b>Jev</b><small>Jev SWOT</small><span>${toggle}<button data-action="close">×</button></span></header><main>${content}</main></section>`;
    this.root.querySelector('[data-action="close"]')?.addEventListener("click", () => this.dismiss());
    this.root.querySelector('[data-action="cancel"]')?.addEventListener("click", () => { this.cancel(); this.expanded = true; this.render(`<div class="warning">已取消当前请求。</div>${this.editor()}`); });
    this.root.querySelector('[data-action="toggle-details"]')?.addEventListener("click", () => {
      if (this.expanded) { this.expanded = false; this.render(this.compact()); return; }
      if (this.directResult && this.detailToken && !this.detailsLoaded) { this.detailsLoading(); this.loadDetails(this.detailToken); return; }
      this.expanded = true; this.render(this.details());
    });
    this.root.querySelector('[data-action="edit"]')?.addEventListener("click", () => { this.expanded = true; this.render(this.editor()); });
    this.root.querySelector('[data-action="explain"]')?.addEventListener("click", () => { if (this.question && this.probability) { this.explanation("正在生成解析…"); this.explain(this.question, this.probability); } });
    this.root.querySelector('[data-action="direct-answer"]')?.addEventListener("click", () => { if (this.question) this.direct(this.question); });
    this.root.querySelector('[data-action="retry"]')?.addEventListener("click", () => this.submitEdit());
    this.root.querySelector('[data-action="local-only"]')?.addEventListener("click", () => { if (this.question) this.retry(this.question, "deny", this.captureAuthorized); });
    this.root.querySelector('[data-action="allow-vision"]')?.addEventListener("click", () => { if (this.question) this.retry(this.question, "allow", this.captureAuthorized); });
    this.root.querySelectorAll<HTMLElement>("[data-option-id]").forEach((row) => row.addEventListener("click", () => this.highlightOption(row.dataset.optionId!)));
    this.root.querySelectorAll<HTMLElement>(".ocr-box").forEach((box) => box.addEventListener("click", () => { const summary = box.getAttribute("title"); if (summary) box.setAttribute("data-label", summary); }));
    this.bindDragging();
  }
  private nearbyPalette(): OverlayPalette {
    const fallback = overlayPaletteForLuminance();
    const doc = document as Document & {
      elementsFromPoint?: (x: number, y: number) => Element[];
    };
    const getElements = doc.elementsFromPoint?.bind(document);
    if (!getElements || typeof getComputedStyle !== "function") return fallback;

    const previousPointerEvents = this.host.style.pointerEvents;
    this.host.style.pointerEvents = "none";
    try {
      const viewportWidth = typeof innerWidth === "number" ? innerWidth : 1024;
      const viewportHeight = typeof innerHeight === "number" ? innerHeight : 768;
      const points = [
        { x: this.position.left - 8, y: this.position.top - 8 },
        { x: this.position.left + 4, y: this.position.top - 8 },
        { x: this.position.left - 8, y: this.position.top + 28 },
        { x: this.position.left + 92, y: this.position.top - 8 }
      ];
      for (const point of points) {
        const x = Math.max(0, Math.min(viewportWidth - 1, point.x));
        const y = Math.max(0, Math.min(viewportHeight - 1, point.y));
        for (const element of getElements(x, y)) {
          if (element === this.host || element.closest?.("[data-jev-swot-root]")) continue;
          const luminance = backgroundLuminance(element);
          if (luminance != null) return overlayPaletteForLuminance(luminance);
        }
      }
    } finally {
      this.host.style.pointerEvents = previousPointerEvents;
    }
    return fallback;
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
    const q: ExtractedQuestion = { ...this.question, source: "user-edited", stem, options, context, questionType: (this.root.querySelector("#type") as HTMLSelectElement).value as ExtractedQuestion["questionType"], recognitionConfidence: 1, warnings: [] };
    this.retry(q);
  }
}
function warningText(w: string) { return ({ LOW_OCR_CONFIDENCE: "OCR 置信度较低", POSSIBLE_FORMULA: "可能包含公式", POSSIBLE_DIAGRAM: "可能依赖图形", INCOMPLETE_OPTIONS: "选项可能不完整", VISION_MODEL_REQUIRED: "建议使用视觉模型", VISION_MODEL_UNSUPPORTED: "当前视觉模型不支持图片，已降级到本地 OCR", VISION_SERVICE_UNAVAILABLE: "视觉服务暂时不可用，已降级到本地 OCR", DOM_OCR_CONFLICT: "网页文字与 OCR 结果冲突", STRUCTURE_REVIEW_REQUIRED: "题目结构尚未确认，请校正" } as Record<string, string>)[w] ?? w; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
const CSS_TEXT = `
:host{all:initial}
section{position:fixed;z-index:2147483647;left:12px;top:12px;width:220px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;background:transparent;color:var(--jev-text,#111827);border:0;border-radius:0;box-shadow:none;font:13px/1.4 system-ui,sans-serif;text-shadow:var(--jev-shadow,0 1px 2px rgba(255,255,255,.98),0 -1px 2px rgba(255,255,255,.98),1px 0 2px rgba(255,255,255,.98),-1px 0 2px rgba(255,255,255,.98));transition:opacity .16s ease}
section.compact{width:max-content;min-width:0;border-radius:0;background:transparent;box-shadow:none;opacity:.62}
section.compact:hover,section.compact:focus-within{opacity:.96}
section.compact header{border-bottom:0;padding:4px 6px;gap:4px}
section.compact header>b,section.compact header small{display:none}
section.compact header button{font-size:11px;padding:1px 4px}
section.compact main{padding:3px 8px 5px}
section.expanded{width:360px;max-width:calc(100vw - 24px)}
header{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;border-bottom:0;cursor:move}
header span{display:flex;gap:4px}
header button{background:transparent;border:0;color:var(--jev-text,#111827);font-size:12px;padding:2px 5px;text-shadow:inherit}
.details-toggle{width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center}
.chevron{display:block;width:7px;height:7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);margin-top:-4px}
.details-toggle[aria-label="收起详情"] .chevron{transform:rotate(225deg);margin-top:4px}
main{padding:10px}
.answer-compact{display:flex;align-items:baseline;white-space:nowrap;overflow:hidden;color:var(--jev-text,#111827)}
.answer-compact strong{color:var(--jev-strong,#000);font-size:18px;line-height:1.1;overflow:hidden;text-overflow:ellipsis}
.answer-compact[data-uncertain="true"] strong{text-decoration:underline dotted;text-decoration-thickness:1px;text-underline-offset:3px}
.answer-compact small{color:var(--jev-muted,var(--jev-text,#111827))}
.row{display:grid;grid-template-columns:minmax(0,1.35fr) minmax(48px,1fr) 52px;gap:8px;align-items:center;margin:9px 0}
.row[data-option-id]{cursor:pointer}
.row[data-option-id]:hover{background:rgba(255,255,255,.38);border-radius:4px}
.option-copy{min-width:0;display:flex;gap:6px;align-items:baseline}
.option-copy>b{flex:0 0 auto}
.option-copy span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--jev-text,#111827)}
.bar{height:9px;background:var(--jev-bar,rgba(17,24,39,.2));border-radius:9px;overflow:hidden}
.bar i{display:block;height:100%;background:linear-gradient(90deg,#16a34a,#2563eb)}
small{color:var(--jev-muted,var(--jev-text,#111827))}
.warning,.error{margin:10px 0;padding:9px;border-radius:8px;background:rgba(255,255,255,.82);color:#111827;border:1px solid rgba(17,24,39,.25)}
.error{background:rgba(255,255,255,.9)}
.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
button{cursor:pointer;border:1px solid rgba(17,24,39,.38);background:rgba(255,255,255,.82);color:#111827;padding:6px 10px;border-radius:7px;text-shadow:inherit}
.primary{background:rgba(255,255,255,.95);border-color:#111827;color:#111827}
.editor label{display:block;margin:9px 0}
.editor textarea,.editor select{box-sizing:border-box;width:100%;margin-top:4px;background:rgba(255,255,255,.9);color:#111827;border:1px solid rgba(17,24,39,.45);border-radius:7px;padding:7px;text-shadow:none}
.editor textarea{min-height:64px;resize:vertical}
.preview{margin-bottom:12px}
.preview summary{cursor:pointer}
.preview-image{position:relative;margin:7px 0;line-height:0}
.preview-image img{display:block;width:100%;height:auto;background:#fff}
.ocr-text{max-height:140px;overflow:auto;white-space:pre-wrap;margin:7px 0;padding:7px;background:rgba(255,255,255,.86);color:#111827;border-radius:7px;font:12px/1.4 ui-monospace,monospace;text-shadow:none}
.ocr-box{position:absolute;padding:0;border:1px solid #0891b2;background:rgba(34,211,238,.18);border-radius:2px}
.ocr-box:hover,.ocr-box:focus{background:rgba(245,158,11,.25);border-color:#d97706}
.ocr-box[data-label]::after{content:attr(data-label);position:absolute;left:0;top:100%;z-index:2;min-width:120px;padding:4px;background:rgba(255,255,255,.94);color:#111827;font:11px/1.3 system-ui;white-space:normal;text-shadow:none;border:1px solid rgba(17,24,39,.25);border-radius:4px}
.spinner{display:inline-block;width:14px;height:14px;border:2px solid rgba(17,24,39,.35);border-top-color:#111827;border-radius:50%;animation:s .8s linear infinite;margin-right:8px}
@keyframes s{to{transform:rotate(360deg)}}
#explanation{white-space:pre-wrap;margin-top:12px;color:#111827}
`;

function parseCssColor(value: string): RgbaColor | undefined {
  const text = value.trim().toLowerCase();
  if (!text || text === "transparent") return undefined;
  if (text.startsWith("#")) {
    const hex = text.slice(1);
    if (![3, 4, 6, 8].includes(hex.length) || !/^[0-9a-f]+$/i.test(hex)) return undefined;
    const expanded = hex.length <= 4 ? [...hex].map((part) => part + part).join("") : hex;
    const hasAlpha = expanded.length === 8;
    return {
      r: Number.parseInt(expanded.slice(0, 2), 16),
      g: Number.parseInt(expanded.slice(2, 4), 16),
      b: Number.parseInt(expanded.slice(4, 6), 16),
      a: hasAlpha ? Number.parseInt(expanded.slice(6, 8), 16) / 255 : 1
    };
  }
  const match = text.match(/^rgba?\((.*)\)$/);
  if (!match) return undefined;
  const parts = match[1].replace("/", " ").split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return undefined;
  const channel = (part: string) => {
    const parsed = Number.parseFloat(part);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.max(0, Math.min(255, part.endsWith("%") ? parsed * 2.55 : parsed));
  };
  const r = channel(parts[0]);
  const g = channel(parts[1]);
  const b = channel(parts[2]);
  if (r == null || g == null || b == null) return undefined;
  const alphaValue = parts[3] == null ? 1 : Number.parseFloat(parts[3].replace("%", ""));
  if (!Number.isFinite(alphaValue)) return undefined;
  return { r, g, b, a: Math.max(0, Math.min(1, parts[3]?.endsWith("%") ? alphaValue / 100 : alphaValue)) };
}

function backgroundLuminance(element: Element): number | undefined {
  let current: Element | null = element;
  while (current) {
    const background = parseCssColor(getComputedStyle(current).backgroundColor);
    if (background && background.a > 0.04) {
      const r = background.r * background.a + 255 * (1 - background.a);
      const g = background.g * background.a + 255 * (1 - background.a);
      const b = background.b * background.a + 255 * (1 - background.a);
      return relativeLuminance(r, g, b);
    }
    current = current.parentElement;
  }
  return undefined;
}

function relativeLuminance(r: number, g: number, b: number) {
  const channel = (value: number) => {
    const normalized = value / 255;
    return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
