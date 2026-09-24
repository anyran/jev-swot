import type { ExtractedQuestion, WorkerResponse } from "../shared/types";

export type PageResultState = "queued" | "running" | "done" | "failed";
export interface PageResultItem {
  question: ExtractedQuestion;
  sourceLabel?: string;
  state: PageResultState;
  message?: string;
  response?: WorkerResponse;
}

export class PageResultsOverlay {
  private host = document.createElement("div");
  private root: ShadowRoot;
  private items: PageResultItem[];
  private started = false;
  private cancelled = false;
  private scanning = false;
  private scanFinished = false;
  private scanWarning?: string;
  private notice?: string;

  constructor(
    questions: ExtractedQuestion[],
    private onStart: () => void,
    private onRetry: (index: number, consent: "allow" | "deny" | "retry") => void,
    private onCancel: () => void,
    private onReview: (index: number) => void,
    private onClose: () => void,
    private emptyMessage = "当前网页中没有识别到完整的题目。"
  ) {
    this.host.dataset.jevSwotRoot = "page-results";
    this.root = this.host.attachShadow({ mode: "closed" });
    this.items = questions.map((question) => ({ question, state: "queued" }));
    this.render();
  }

  itemAt(index: number) { return this.items[index]; }

  addQuestion(question: ExtractedQuestion, sourceLabel?: string) {
    this.items.push({ question, sourceLabel, state: "queued" });
    this.render();
    return this.items.length - 1;
  }

  beginScan() {
    this.scanning = true;
    this.render();
  }

  finishScan(warning?: string) {
    this.scanning = false;
    this.scanFinished = true;
    this.scanWarning = warning;
    this.render();
  }

  setNotice(message: string) {
    this.notice = message;
    this.render();
  }

  suspend() {
    const previousDisplay = this.host.style.display;
    this.host.style.display = "none";
    return () => { this.host.style.display = previousDisplay; };
  }

  setProgress(index: number, message: string) {
    const item = this.items[index];
    if (!item || this.cancelled) return;
    item.state = "running";
    item.message = message;
    this.render();
  }

  setResult(index: number, response: WorkerResponse) {
    const item = this.items[index];
    if (!item || this.cancelled) return;
    item.response = response;
    item.question = response.question ?? item.question;
    item.state = response.ok ? "done" : "failed";
    item.message = response.ok ? undefined : response.message;
    this.render();
  }

  cancel() {
    if (this.cancelled) return;
    this.cancelled = true;
    this.onCancel();
    this.items.forEach((item) => {
      if (item.state === "queued" || item.state === "running") {
        item.state = "failed";
        item.message = "已取消。";
      }
    });
    this.render();
  }

  dismiss() {
    this.cancelled = true;
    this.host.remove();
    this.onClose();
  }

  private render() {
    if (!this.host.isConnected) document.documentElement.append(this.host);
    const rows = this.items.length
      ? this.items.map((item, index) => this.renderItem(item, index)).join("")
      : this.scanning
        ? `<article><p class="running">正在逐屏扫描网页，并逐题处理已识别内容…</p><small>页面位置会在扫描完成后恢复。</small></article>`
        : `<article><p class="error">${escapeHtml(this.emptyMessage)}</p><small>可使用框选快捷键对单道图片题或特殊布局题进行识别。</small></article>`;
    const summary = this.scanning
      ? `扫描中 · 已发现 ${this.items.length} 道题；只有点击“开始整页分析”后才会发送题目内容。`
      : this.started
        ? `已处理 ${this.items.filter((item) => item.state === "done" || item.state === "failed").length} / ${this.items.length} 题`
        : "确认后会扫描整个网页及浏览器可读取的嵌入框架（包括滚动后才加载的内容），并逐题分析。题目文本会发送给你配置的 JEV 或普通模型；含图形的题目仅在你逐题允许后才会上传截图。";
    const permissionNote = !this.started
      ? `<p class="permission-note"><b>视觉题截图：</b>如果 Chrome 尚未授予当前标签页临时截图权限，先点击扩展图标或触发浏览器快捷键，再单独重试该题。只有你逐题允许后才会上传截图。</p>`
      : "";
    const warning = this.scanWarning ? `<p class="error">${escapeHtml(this.scanWarning)}</p>` : "";
    const notice = this.notice ? `<p class="notice">${escapeHtml(this.notice)}</p>` : "";
    const action = !this.started
      ? `<button data-action="close">取消</button><button class="primary" data-action="start">开始整页分析</button>`
      : this.scanFinished
        ? `<button data-action="close">关闭</button>`
        : `<button data-action="cancel" ${this.cancelled ? "disabled" : ""}>取消整页分析</button>`;
    this.root.innerHTML = `<style>${CSS}</style><section><header><b>整页逐题识别</b><button data-action="close" aria-label="关闭">×</button></header><main><p class="summary">${escapeHtml(summary)}</p>${permissionNote}${notice}${warning}<div class="items">${rows}</div><footer>${action}</footer></main></section>`;
    this.root.querySelector('[data-action="start"]')?.addEventListener("click", () => {
      if (this.started || this.cancelled) return;
      this.started = true;
      this.scanning = true;
      this.render();
      this.onStart();
    });
    this.root.querySelector('[data-action="cancel"]')?.addEventListener("click", () => this.cancel());
    this.root.querySelector('[data-action="close"]')?.addEventListener("click", () => this.dismiss());
    this.root.querySelectorAll<HTMLElement>("[data-retry]").forEach((button) => button.addEventListener("click", () => {
      const index = Number(button.dataset.retry);
      const consent = button.dataset.consent;
      if (Number.isInteger(index) && (consent === "allow" || consent === "deny" || consent === "retry")) this.onRetry(index, consent);
    }));
    this.root.querySelectorAll<HTMLElement>("[data-review]").forEach((button) => button.addEventListener("click", () => {
      const index = Number(button.dataset.review);
      if (Number.isInteger(index)) this.onReview(index);
    }));
  }

  private renderItem(item: PageResultItem, index: number) {
    const question = escapeHtml(compact(item.question.stem, 120));
    let result = "";
    if (item.state === "queued") result = `<small>等待开始</small>`;
    else if (item.state === "running") result = `<small class="running">${escapeHtml(item.message ?? "正在分析…")}</small>`;
    else if (!item.response?.ok) {
      const response = item.response;
      const consent = response?.code === "VISION_CONSENT_REQUIRED"
        ? `<div class="actions"><button data-retry="${index}" data-consent="deny">仅本地 OCR</button><button class="primary" data-retry="${index}" data-consent="allow">允许本次上传</button></div>`
        : "";
      const captureRetry = response?.code === "PAGE_CAPTURE_FAILED" || response?.code === "PAGE_CAPTURE_UNAVAILABLE"
        ? `<div class="actions"><button data-retry="${index}" data-consent="retry">重新尝试这道题</button></div><small>浏览器截图需要先由扩展图标或浏览器快捷键授予当前页临时权限。</small>`
        : "";
      result = `<p class="error">${escapeHtml(response?.message ?? item.message ?? "分析失败")}</p>${consent}${captureRetry}`;
    } else if (item.response.probability) {
      const probability = item.response.probability;
      const sorted = [...probability.options].sort((a, b) => b.probability - a.probability);
      const answer = probability.mode === "single-distribution"
        ? sorted[0]?.label ?? "待确认"
        : sorted.filter((option) => option.probability >= 0.5).map((option) => option.label).join("、") || "待确认";
      const options = sorted.map((option) => `<li><b>${escapeHtml(option.label)}</b><span>${(option.probability * 100).toFixed(1)}%</span></li>`).join("");
      result = `<p class="answer">倾向：${escapeHtml(answer)}</p><details><summary>选项概率（${escapeHtml(probability.mode === "single-distribution" ? "单选分布" : "多选独立") }）</summary><ul>${options}</ul><small>${escapeHtml(probability.model)}</small></details><button class="review" data-review="${index}">详情 / 校正</button>`;
    } else if (item.response.directAnswer) {
      const answer = item.response.directAnswer;
      const points = answer.knowledgePoints.length ? `<ul>${answer.knowledgePoints.map((point) => `<li>${escapeHtml(point)}</li>`).join("")}</ul>` : "";
      result = `<p class="answer">可能答案：${escapeHtml(answer.answerLabels.join("、"))}</p><p>${escapeHtml(answer.explanation)}</p>${points}<small>不确定性：${escapeHtml(answer.uncertainty)}</small><button class="review" data-review="${index}">详情 / 校正</button>`;
    } else result = `<p class="error">没有收到可显示的分析结果。</p>`;
    const source = item.sourceLabel ? `<small class="source">${escapeHtml(item.sourceLabel)}</small>` : "";
    return `<article><header><b>第 ${index + 1} 题</b><span>${escapeHtml(item.state === "done" ? "完成" : item.state === "failed" ? "需处理" : "")}</span></header>${source}<p class="question">${question}</p>${result}</article>`;
  }
}

function compact(value: string, max: number) {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

const CSS = `
:host{all:initial}section{position:fixed;z-index:2147483647;right:12px;top:12px;width:390px;max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);display:flex;flex-direction:column;background:rgba(255,255,255,.97);color:#111827;border:1px solid #cbd5e1;border-radius:12px;box-shadow:0 8px 32px #0f172a33;font:13px/1.45 system-ui,sans-serif;text-shadow:none}header{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-bottom:1px solid #e2e8f0}header button{font-size:18px;background:transparent;border:0;color:inherit;cursor:pointer}main{min-height:0;overflow:auto;padding:10px 12px}.summary{margin:0 0 10px;color:#475569}.permission-note{margin:0 0 8px;padding:7px;background:#fff7ed;color:#9a3412;border-radius:6px}.notice{margin:0 0 8px;padding:7px;background:#eff6ff;color:#1e40af;border-radius:6px}.items{display:grid;gap:8px}article{padding:9px;border:1px solid #e2e8f0;border-radius:9px}article header{padding:0 0 5px;border:0;color:#475569}.source{display:block;margin:0 0 4px}.question{margin:4px 0 8px;font-weight:600;overflow-wrap:anywhere}.answer{margin:5px 0;color:#166534;font-weight:700}.error{margin:4px 0;color:#b91c1c}.running{color:#1d4ed8}details{margin:6px 0}details summary{cursor:pointer;color:#334155}ul{list-style:none;padding:0;margin:5px 0}li{display:flex;justify-content:space-between;padding:2px 0}small{color:#64748b;overflow-wrap:anywhere}.actions,footer{display:flex;justify-content:flex-end;gap:7px;margin-top:9px}footer{position:sticky;bottom:0;padding-top:8px;background:rgba(255,255,255,.97);border-top:1px solid #e2e8f0}button{padding:5px 8px;border:1px solid #94a3b8;border-radius:7px;background:#fff;color:#111827;cursor:pointer}.primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}.review{margin-top:5px;font-size:12px}
`;
