import { selectAndScanInputRoot, selectTemplateConfigJson } from "./adapters/uxp-input-scanner";
import { MemoryBatchAdapter } from "./adapters/memory-batch-adapter";
import { parseInputGroups, parseTemplateConfig, preflightGroups } from "./domain/preflight";
import { samplePreflightPayload } from "./domain/sample";
import type { PreflightReport } from "./domain/types";
import { runSingleGroup } from "./workflow/run-group";

export type StageId = "template" | "input" | "preview" | "run" | "results";

export interface WorkflowStage {
  id: StageId;
  number: string;
  label: string;
  title: string;
  description: string;
}

export const workflowStages: WorkflowStage[] = [
  {
    id: "template",
    number: "01",
    label: "模板",
    title: "登记生产母版",
    description: "读取并版本化已经认可的 PSD 结构。当前诊断构建不会修改任何 Photoshop 文档。",
  },
  {
    id: "input",
    number: "02",
    label: "输入",
    title: "检查素材分组",
    description: "按固定名称规则预检 PNG 与 JPEG 素材，不通过文件排序猜测用途。",
  },
  {
    id: "preview",
    number: "03",
    label: "预览",
    title: "先试套一组",
    description: "新模板和新规则必须先通过单组试套，才能进入正式批量。",
  },
  {
    id: "run",
    number: "04",
    label: "运行",
    title: "串行处理批次",
    description: "每组从干净母版开始，未完成结果不会被登记为成功。",
  },
  {
    id: "results",
    number: "05",
    label: "结果",
    title: "复核并处理失败组",
    description: "查看完成、失败、中断和待确认状态，并只重试符合条件的组。",
  },
];

const pluginVersion = "0.1.0";

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

function appendChildren(parent: Node, ...children: Node[]): void {
  for (const child of children) parent.appendChild(child);
}

function clearElement(element: HTMLElement): void {
  while (element.firstChild) element.removeChild(element.firstChild);
}

function renderPreflightReport(container: HTMLElement, report: PreflightReport): void {
  clearElement(container);
  const templateCard = createElement("section", "template-result");
  templateCard.appendChild(
    createElement(
      "p",
      "template-result__summary",
      `${report.templateSummary.garmentPieceCount} 个裁片 · ${report.templateSummary.artworkEntryCount} 个素材入口 · ${report.templateSummary.instanceCount} 个实例`,
    ),
  );
  for (const mapping of report.templateSummary.mappings) {
    templateCard.appendChild(createElement("p", "template-result__mapping", mapping));
  }
  for (const issue of report.templateIssues) {
    templateCard.appendChild(
      createElement("p", `group-result__issue group-result__issue--${issue.severity}`, issue.message),
    );
  }
  container.appendChild(templateCard);

  const summary = createElement(
    "p",
    "preflight-summary",
    `${report.groups.length} 组 · ${report.validGroupCount} 组可运行 · ${report.invalidGroupCount} 组需处理`,
  );
  container.appendChild(summary);

  for (const group of report.groups) {
    const card = createElement("section", `group-result group-result--${group.status}`);
    const header = createElement("div", "group-result__header");
    appendChildren(
      header,
      createElement("strong", "group-result__name", group.groupName),
      createElement("span", "group-result__status", group.status === "valid" ? "可运行" : "已阻止"),
    );
    card.appendChild(header);
    const assignment = createElement(
      "p",
      "group-result__assignment",
      group.assignments.length > 0
        ? group.assignments
            .map((item) => `${item.entryId} / ${item.contentSourceId} ← ${item.fileName}`)
            .join(" / ")
        : "没有可提交的素材映射",
    );
    card.appendChild(assignment);
    for (const issue of group.issues) {
      card.appendChild(
        createElement("p", `group-result__issue group-result__issue--${issue.severity}`, issue.message),
      );
    }
    container.appendChild(card);
  }
}

function renderPreflightTool(container: HTMLElement): void {
  const tool = createElement("section", "preflight-tool");
  const templateLabel = createElement(
    "p",
    "preflight-tool__label",
    "模板配置 JSON",
  );
  const templateTextarea = createElement("textarea", "preflight-tool__input preflight-tool__input--template");
  templateTextarea.value = JSON.stringify(samplePreflightPayload.template, null, 2);
  const templateAction = createElement("button", "secondary-action", "选择模板配置 JSON");
  templateAction.type = "button";
  const groupsLabel = createElement(
    "p",
    "preflight-tool__label preflight-tool__label--groups",
    "素材目录清单 JSON（可由下方文件夹扫描替换）",
  );
  const groupsTextarea = createElement("textarea", "preflight-tool__input");
  groupsTextarea.value = JSON.stringify(samplePreflightPayload.groups, null, 2);
  const scanAction = createElement("button", "secondary-action", "选择素材总文件夹并读取尺寸");
  scanAction.type = "button";
  const manifestAction = createElement("button", "primary-action", "预检当前清单");
  manifestAction.type = "button";
  const results = createElement("div", "preflight-results");

  templateAction.addEventListener("click", () => {
    void (async () => {
      try {
        const json = await selectTemplateConfigJson();
        if (!json) return;
        const template = parseTemplateConfig(json);
        templateTextarea.value = JSON.stringify(template, null, 2);
      } catch (error) {
        clearElement(results);
        results.appendChild(
          createElement("p", "preflight-error", error instanceof Error ? error.message : "无法读取模板配置"),
        );
      }
    })();
  });

  manifestAction.addEventListener("click", () => {
    try {
      renderPreflightReport(
        results,
        preflightGroups({
          template: parseTemplateConfig(templateTextarea.value),
          groups: parseInputGroups(groupsTextarea.value),
        }),
      );
    } catch (error) {
      clearElement(results);
      results.appendChild(
        createElement("p", "preflight-error", error instanceof Error ? error.message : "无法读取清单"),
      );
    }
  });

  scanAction.addEventListener("click", () => {
    void (async () => {
      try {
        scanAction.textContent = "正在读取文件头…";
        const template = parseTemplateConfig(templateTextarea.value);
        const groups = await selectAndScanInputRoot();
        if (!groups) return;
        const scanned = { template, groups };
        groupsTextarea.value = JSON.stringify(groups, null, 2);
        renderPreflightReport(results, preflightGroups(scanned));
      } catch (error) {
        clearElement(results);
        results.appendChild(
          createElement("p", "preflight-error", error instanceof Error ? error.message : "无法扫描素材目录"),
        );
      } finally {
        scanAction.textContent = "选择素材总文件夹并读取尺寸";
      }
    })();
  });

  appendChildren(
    tool,
    templateLabel,
    templateTextarea,
    templateAction,
    groupsLabel,
    groupsTextarea,
    scanAction,
    manifestAction,
    results,
  );
  container.appendChild(tool);
}

function renderDemoRunner(container: HTMLElement): void {
  const tool = createElement("section", "demo-runner");
  const explanation = createElement(
    "p",
    "demo-runner__body",
    "使用内存适配器演示完整事务顺序。不会打开 Photoshop，也不会生成生产文件。",
  );
  const action = createElement("button", "primary-action demo-runner__action", "运行单组安全演示");
  action.type = "button";
  const result = createElement("div", "demo-runner__result");

  action.addEventListener("click", () => {
    void (async () => {
      action.disabled = true;
      action.textContent = "正在运行…";
      clearElement(result);
      const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint);
      const masterBefore = adapter.masterStateDigest;
      const run = await runSingleGroup(
        {
          runId: "diagnostic-single-group",
          pluginVersion,
          template: samplePreflightPayload.template,
          group: samplePreflightPayload.groups[0],
        },
        adapter,
      );
      result.appendChild(
        createElement(
          "p",
          `demo-runner__status demo-runner__status--${run.status}`,
          run.status === "completed"
            ? "内存演示完成：模拟提交边界已通过"
            : `演示未完成：${run.error ?? run.status}`,
        ),
      );
      result.appendChild(
        createElement("p", "demo-runner__fingerprint", `任务指纹 ${run.taskFingerprint.slice(0, 16)}…`),
      );
      for (const event of run.events) {
        result.appendChild(
          createElement("p", "demo-runner__event", `${event.stage} / ${event.state} / ${event.message}`),
        );
      }
      result.appendChild(
        createElement(
          "p",
          "demo-runner__integrity",
          `内存模型母版状态${masterBefore === adapter.masterStateDigest ? "未变化" : "已变化"} · 打开临时会话 ${adapter.openSessionCount}`,
        ),
      );
      action.disabled = false;
      action.textContent = "重新运行安全演示";
    })();
  });

  appendChildren(tool, explanation, action, result);
  container.appendChild(tool);
}

function renderStage(container: HTMLElement, stage: WorkflowStage): void {
  clearElement(container);

  const eyebrow = createElement("p", "stage-detail__eyebrow", `${stage.number} / ${stage.label}`);
  const title = createElement("h2", "stage-detail__title", stage.title);
  const description = createElement("p", "stage-detail__description", stage.description);
  const notice = createElement("div", "stage-detail__notice");
  appendChildren(
    notice,
    createElement("span", "status-dot"),
    createElement("span", undefined, "诊断模式：所有生产操作已锁定"),
  );
  appendChildren(container, eyebrow, title, description, notice);
  if (stage.id === "input") renderPreflightTool(container);
  if (stage.id === "preview") renderDemoRunner(container);
}

export function mountApp(root: HTMLElement): void {
  clearElement(root);

  const shell = createElement("section", "app-shell");
  const header = createElement("header", "masthead");
  const brand = createElement("div", "brand-mark", "裁");
  const heading = createElement("div", "masthead__copy");
  appendChildren(
    heading,
    createElement("p", "kicker", "PHOTOSHOP UXP / DIAGNOSTIC"),
    createElement("h1", "masthead__title", "裁片印花批量套图"),
    createElement("p", "masthead__subtitle", "复用已认可的裁片母版，不重新排版。"),
  );
  appendChildren(header, brand, heading);

  const status = createElement("section", "capability-card");
  const statusHeader = createElement("div", "capability-card__header");
  appendChildren(
    statusHeader,
    createElement("span", "status-pill", "待 M0 验证"),
    createElement("span", "version", `v${pluginVersion}`),
  );
  appendChildren(
    status,
    statusHeader,
    createElement("h2", "capability-card__title", "构建通过，Photoshop 兼容性未验证"),
    createElement(
      "p",
      "capability-card__body",
      "尚未在真实 Photoshop 中加载，也未取得真实 PSD、三组印花和工厂规范。当前结果仅来自自动化构建与测试。",
    ),
  );

  const workflow = createElement("section", "workflow");
  workflow.appendChild(createElement("p", "section-label", "工作流"));
  const navigation = createElement("div", "stage-nav");
  const detail = createElement("article", "stage-detail");

  const buttons = workflowStages.map((stage, index) => {
    const button = createElement("button", "stage-nav__item");
    button.type = "button";
    button.dataset.stage = stage.id;
    button.dataset.selected = index === 0 ? "true" : "false";
    if (index === 0) button.classList.add("is-active");
    appendChildren(button, createElement("span", "stage-nav__number", stage.number));
    const label = createElement(
      "span",
      "stage-nav__label",
      index === 0 ? `${stage.label}（当前）` : stage.label,
    );
    button.appendChild(label);
    button.addEventListener("click", () => {
      buttons.forEach((candidate, candidateIndex) => {
        candidate.classList.toggle("is-active", candidate === button);
        candidate.dataset.selected = candidate === button ? "true" : "false";
        const candidateLabel = candidate.querySelector<HTMLElement>(".stage-nav__label");
        if (candidateLabel) {
          const text = workflowStages[candidateIndex].label;
          candidateLabel.textContent = candidate === button ? `${text}（当前）` : text;
        }
      });
      renderStage(detail, stage);
    });
    return button;
  });

  for (const button of buttons) navigation.appendChild(button);
  renderStage(detail, workflowStages[0]);
  appendChildren(workflow, navigation, detail);

  const footer = createElement("footer", "diagnostics");
  appendChildren(
    footer,
    createElement("span", "diagnostics__label", "DIAG"),
    createElement("span", "diagnostics__value", "Manifest v5 · API v2 · Windows first"),
  );

  appendChildren(shell, header, status, workflow, footer);
  root.appendChild(shell);
}
