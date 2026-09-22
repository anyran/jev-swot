import type { ExtractedQuestion, ProbabilityResult, WorkerResponse } from "../shared/types";

export class ResultOverlay {
  private host = document.createElement("div");
  private root: ShadowRoot;
  private question?: ExtractedQuestion;
  private probability?: ProbabilityResult;
  private position = { left: 16, top: 16 };
  constructor(private retry: (q: ExtractedQuestion, visionConsent?: "allow" | "deny") => void, private explain: (q: ExtractedQuestion, p: ProbabilityResult) => void, private cancel: () => void) {
    this.host.dataset.jevanswerRoot = "true";
    this.root = this.host.attachShadow({ mode: "closed" });
    document.documentElement.append(this.host);
  }
  loading(question: ExtractedQuestion) { this.question = question; this.render(`<div class="status"><span class="spinner"></span>正在识别并评估… <button data-action="cancel">取消</button></div>`); }
  show(response: WorkerResponse) {
    if (!response.ok) {
      const consent = response.code === "VISION_CONSENT_REQUIRED" ? `<div class="actions"><button data-action="local-only">仅本地 OCR</button><button class="primary" data-action="allow-vision">允许本次上传</button></div>` : "";
      this.render(`<div class="error">${escapeHtml(response.message)}</div>${consent}${response.code === "VISION_CONSENT_REQUIRED" ? "" : this.editor()}`); return;
    }
    if (response.question) this.question = response.question;
    if (response.probability) this.probability = response.probability;
    const p = this.probability;
    if (!p) return;
    const rows = [...p.options].sort((a, b) => b.probability - a.probability).map((x) => `<div class="row" data-option-id="${escapeHtml(x.id)}"><b>${escapeHtml(x.label)}</b><div class="bar"><i style="width:${Math.round(x.probability * 100)}%"></i></div><strong>${(x.probability * 100).toFixed(1)}%</strong></div>`).join("");
    const confidence = p.confidence == null ? "多选项概率相互独立，不合计为 100%" : `整体置信度 ${(p.confidence * 100).toFixed(0)}%`;
    this.render(`<div class="rows">${rows}</div><small>${confidence} · ${escapeHtml(p.model)}</small>${this.warnings()}<div class="actions"><button data-action="edit">校正题目</button><button class="primary" data-action="explain">答案解析</button></div><div id="explanation"></div>`);
  }
  explanation(text: string) { const node = this.root.querySelector("#explanation"); if (node) node.textContent = text; }
  explanationChunk(text: string) { const node = this.root.querySelector("#explanation"); if (node) node.textContent += text; }
  private warnings() { return this.question?.warnings.length ? `<div class="warning">${this.question.warnings.map(warningText).join("；")}</div>` : ""; }
  private editor() {
    const q = this.question; if (!q) return "";
    return `<div class="editor"><label>题型<select id="type"><option value="single" ${q.questionType === "single" ? "selected" : ""}>单选</option><option value="multiple" ${q.questionType === "multiple" ? "selected" : ""}>多选</option></select></label><label>题干<textarea id="stem">${escapeHtml(q.stem)}</textarea></label><label>选项（每行一个）<textarea id="options">${q.options.map((x) => `${x.label}. ${x.text}`).join("\n")}</textarea></label><label>补充上下文/图形描述（可选）<textarea id="context">${escapeHtml(q.context ?? "")}</textarea></label><button class="primary" data-action="retry">重新判断</button></div>`;
  }
  private render(content: string) {
    this.root.innerHTML = `<style>${CSS_TEXT}</style><section style="left:${this.position.left}px;top:${this.position.top}px"><header><b>JevAnswer</b><span><button data-action="collapse">—</button><button data-action="close">×</button></span></header><main>${content}</main></section>`;
    this.root.querySelector('[data-action="close"]')?.addEventListener("click", () => { this.cancel(); this.host.remove(); });
    this.root.querySelector('[data-action="cancel"]')?.addEventListener("click", () => { this.cancel(); this.render(`<div class="warning">已取消当前请求。</div>${this.editor()}`); });
    this.root.querySelector('[data-action="collapse"]')?.addEventListener("click", () => this.root.querySelector("main")?.classList.toggle("hidden"));
    this.root.querySelector('[data-action="edit"]')?.addEventListener("click", () => this.render(this.editor()));
    this.root.querySelector('[data-action="explain"]')?.addEventListener("click", () => { if (this.question && this.probability) { this.explanation("正在生成解析…"); this.explain(this.question, this.probability); } });
    this.root.querySelector('[data-action="retry"]')?.addEventListener("click", () => this.submitEdit());
    this.root.querySelector('[data-action="local-only"]')?.addEventListener("click", () => { if (this.question) this.retry(this.question, "deny"); });
    this.root.querySelector('[data-action="allow-vision"]')?.addEventListener("click", () => { if (this.question) this.retry(this.question, "allow"); });
    this.root.querySelectorAll<HTMLElement>("[data-option-id]").forEach((row) => row.addEventListener("click", () => this.highlightOption(row.dataset.optionId!)));
    this.bindDragging();
  }
  private highlightOption(id: string) {
    const rect = this.question?.options.find((option) => option.id === id)?.sourceRect;
    if (!rect) return;
    const marker = document.createElement("div"); marker.dataset.jevanswerRoot = "highlight";
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
    const options = lines.map((line, i) => { const m = /^([A-Ha-h0-9①-⑨])[.、)）:]?\s*(.*)$/.exec(line); return { id: `option_${i + 1}`, label: m?.[1]?.toUpperCase() ?? String.fromCharCode(65 + i), text: m?.[2] || line }; });
    const context = (this.root.querySelector("#context") as HTMLTextAreaElement).value.trim();
    const q: ExtractedQuestion = { ...this.question, source: "user-edited", stem, options, context, questionType: (this.root.querySelector("#type") as HTMLSelectElement).value as "single" | "multiple", recognitionConfidence: 1, warnings: [] };
    this.retry(q);
  }
}
function warningText(w: string) { return ({ LOW_OCR_CONFIDENCE: "OCR 置信度较低", POSSIBLE_FORMULA: "可能包含公式", POSSIBLE_DIAGRAM: "可能依赖图形", INCOMPLETE_OPTIONS: "选项可能不完整", VISION_MODEL_REQUIRED: "建议使用视觉模型" } as Record<string, string>)[w] ?? w; }
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!); }
const CSS_TEXT = `:host{all:initial}section{position:fixed;z-index:2147483647;left:16px;top:16px;width:360px;max-height:calc(100vh - 32px);overflow:auto;background:#111827;color:#f9fafb;border:1px solid #374151;border-radius:14px;box-shadow:0 18px 48px #0006;font:14px/1.45 system-ui,sans-serif}header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #374151;cursor:move}header button{background:none;border:0;color:#d1d5db;font-size:18px}main{padding:12px}.hidden{display:none}.row{display:grid;grid-template-columns:24px 1fr 52px;gap:8px;align-items:center;margin:9px 0}.row[data-option-id]{cursor:pointer}.row[data-option-id]:hover{background:#ffffff0d}.bar{height:9px;background:#374151;border-radius:9px;overflow:hidden}.bar i{display:block;height:100%;background:linear-gradient(90deg,#22c55e,#60a5fa)}small{color:#9ca3af}.warning,.error{margin:10px 0;padding:9px;border-radius:8px;background:#78350f;color:#fef3c7}.error{background:#7f1d1d}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}button{cursor:pointer;border:1px solid #4b5563;background:#1f2937;color:#fff;padding:6px 10px;border-radius:7px}.primary{background:#2563eb;border-color:#3b82f6}.editor label{display:block;margin:9px 0}.editor textarea,.editor select{box-sizing:border-box;width:100%;margin-top:4px;background:#0f172a;color:#fff;border:1px solid #475569;border-radius:7px;padding:7px}.editor textarea{min-height:64px}.spinner{display:inline-block;width:14px;height:14px;border:2px solid #64748b;border-top-color:#fff;border-radius:50%;animation:s .8s linear infinite;margin-right:8px}@keyframes s{to{transform:rotate(360deg)}}#explanation{white-space:pre-wrap;margin-top:12px;color:#e5e7eb}`;
