import { beforeEach, describe, expect, it, vi } from "vitest";

import { mountApp, workflowStages } from "../src/app";

describe("diagnostic panel", () => {
  beforeEach(() => {
    document.body.innerHTML = '<main id="app"></main>';
    mountApp(document.querySelector<HTMLElement>("#app")!);
  });

  it("renders the five workflow stages and an explicit validation gate", () => {
    const buttons = document.querySelectorAll<HTMLButtonElement>("[data-stage]");

    expect(buttons).toHaveLength(5);
    expect([...buttons].map((button) => button.dataset.stage)).toEqual(
      workflowStages.map((stage) => stage.id),
    );
    expect(buttons[0].textContent).toContain("模板（当前）");
    expect(document.body.textContent).toContain("待 M0 验证");
    expect(document.body.textContent).toContain("Photoshop 兼容性未验证");
    expect(document.body.textContent).toContain("尚未在真实 Photoshop 中加载");
  });

  it("starts through the plugin entrypoint and navigates all five stages", async () => {
    document.body.innerHTML = '<main id="app"></main>';
    vi.resetModules();
    await import("../src/index");

    for (const stage of workflowStages) {
      const button = document.querySelector<HTMLButtonElement>(`[data-stage="${stage.id}"]`)!;
      button.click();
      expect(button.dataset.selected).toBe("true");
      expect(button.textContent).toContain(`${stage.label}（当前）`);
      expect(document.querySelector(".stage-detail__title")?.textContent).toBe(stage.title);
    }

    expect(document.querySelector(".stage-detail__notice")?.textContent).toContain("所有生产操作已锁定");
  });
});
