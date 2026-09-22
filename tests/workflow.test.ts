import { describe, expect, it } from "vitest";

import { MemoryBatchAdapter } from "../src/adapters/memory-batch-adapter";
import { samplePreflightPayload } from "../src/domain/sample";
import type { InputGroupSnapshot } from "../src/domain/types";
import { createTaskFingerprint, fingerprintBytes } from "../src/workflow/fingerprint";
import { RunCancellation, runSingleGroup } from "../src/workflow/run-group";
import type { RunStage } from "../src/workflow/types";

function request(group: InputGroupSnapshot = samplePreflightPayload.groups[0]) {
  return {
    runId: `run-${group.name}`,
    pluginVersion: "0.1.0",
    template: samplePreflightPayload.template,
    group,
  };
}

describe("single-group workflow", () => {
  it("runs the complete transaction in order and cleans owned resources", async () => {
    const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint);
    const masterBefore = adapter.masterStateDigest;

    const result = await runSingleGroup(request(), adapter);

    expect(result.status).toBe("completed");
    expect(result.output?.artifacts).toHaveLength(1);
    expect(adapter.calls).toEqual([
      "copy-master",
      "resolve-template",
      "replace-artwork",
      "validate-structure",
      "export-preview",
      "verify-output",
      "commit-result",
      "cleanup",
    ]);
    expect(adapter.openSessionCount).toBe(0);
    expect(adapter.retainedScopeCount).toBe(0);
    expect(adapter.ownedTemporaryCount).toBe(0);
    expect(adapter.masterStateDigest).toBe(masterBefore);
  });

  it.each([
    "copy-master",
    "resolve-template",
    "replace-artwork",
    "validate-structure",
    "export-preview",
    "verify-output",
    "commit-result",
  ] satisfies Array<Exclude<RunStage, "preflight" | "cleanup">>)(
    "fails safely and cleans resources when %s fails",
    async (failAt) => {
      const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint, { failAt });

      const result = await runSingleGroup(request(), adapter);

      expect(result.status).toBe("failed");
      expect(result.lastStage).toBe(failAt);
      expect(result.error).toContain(failAt);
      expect(adapter.committed).toHaveLength(0);
      expect(adapter.openSessionCount).toBe(0);
      expect(adapter.ownedTemporaryCount).toBe(0);
    },
  );

  it("stops at a safe boundary and distinguishes cancellation from failure", async () => {
    const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint);
    const cancellation = new RunCancellation();

    const result = await runSingleGroup(request(), adapter, {
      cancellation,
      onEvent: (event) => {
        if (event.stage === "replace-artwork" && event.state === "completed") cancellation.cancel();
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.error).toContain("安全边界");
    expect(adapter.committed).toHaveLength(0);
    expect(adapter.openSessionCount).toBe(0);
  });

  it("classifies adapter-originated host cancellation separately from failure", async () => {
    const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint, {
      cancelAt: "replace-artwork",
    });

    const result = await runSingleGroup(request(), adapter);

    expect(result.status).toBe("cancelled");
    expect(result.error).toContain("宿主取消");
    expect(adapter.openSessionCount).toBe(0);
  });

  it("does not publish when cancellation arrives before commit", async () => {
    const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint);
    const cancellation = new RunCancellation();

    const result = await runSingleGroup(request(), adapter, {
      cancellation,
      onEvent: (event) => {
        if (event.stage === "commit-result" && event.state === "started") cancellation.cancel();
      },
    });

    expect(result.status).toBe("cancelled");
    expect(adapter.committed).toHaveLength(0);
  });

  it("treats a completed atomic commit as success even if cancellation arrives afterward", async () => {
    const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint);
    const cancellation = new RunCancellation();

    const result = await runSingleGroup(request(), adapter, {
      cancellation,
      onEvent: (event) => {
        if (event.stage === "commit-result" && event.state === "completed") cancellation.cancel();
      },
    });

    expect(result.status).toBe("completed");
    expect(result.output).toBeDefined();
    expect(adapter.committed).toHaveLength(1);
  });

  it("reports cleanup problems without turning an already committed result into failure", async () => {
    const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint, {
      failAt: "cleanup",
    });

    const result = await runSingleGroup(request(), adapter);

    expect(result.status).toBe("completed");
    expect(result.cleanupWarning).toContain("cleanup");
    expect(adapter.retainedScopeCount).toBe(0);
  });

  it("does not let a throwing progress observer prevent mandatory cleanup", async () => {
    const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint);

    const result = await runSingleGroup(request(), adapter, {
      onEvent: (event) => {
        if (event.stage === "cleanup" && event.state === "started") throw new Error("observer failed");
      },
    });

    expect(result.status).toBe("completed");
    expect(adapter.retainedScopeCount).toBe(0);
    expect(result.events).toContainEqual(expect.objectContaining({ stage: "cleanup", state: "completed" }));
  });

  it("blocks an invalid group before creating a work copy", async () => {
    const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint);

    const result = await runSingleGroup(request(samplePreflightPayload.groups[1]), adapter);

    expect(result.status).toBe("failed");
    expect(result.lastStage).toBe("preflight");
    expect(adapter.calls).toHaveLength(0);
  });

  it("uses template, source, configuration, and plugin data in task identity", () => {
    const original = structuredClone(samplePreflightPayload.groups[0]);
    const changed = structuredClone(original);
    changed.files[0].fingerprint = "different-source-content";

    const first = createTaskFingerprint(samplePreflightPayload.template, original, "0.1.0");
    const second = createTaskFingerprint(samplePreflightPayload.template, changed, "0.1.0");
    const third = createTaskFingerprint(samplePreflightPayload.template, original, "0.2.0");

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
  });

  it("keeps task identity stable when unchanged files receive new scan-scoped references", () => {
    const original = structuredClone(samplePreflightPayload.groups[0]);
    const rescanned = structuredClone(original);
    rescanned.files = rescanned.files.map((file) => ({
      ...file,
      sourceRef: `new-scan:${file.sourceRef}`,
    }));

    expect(createTaskFingerprint(samplePreflightPayload.template, rescanned, "0.1.0")).toBe(
      createTaskFingerprint(samplePreflightPayload.template, original, "0.1.0"),
    );
  });

  it("uses standard SHA-256 and canonicalizes unordered configuration arrays", () => {
    expect(fingerprintBytes(Uint8Array.from([97, 98, 99]))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const template = structuredClone(samplePreflightPayload.template);
    const group = structuredClone(samplePreflightPayload.groups[0]);
    const original = createTaskFingerprint(template, group, "0.1.0");
    template.garmentPieces.reverse();
    template.artworkEntries.reverse();
    template.instances.reverse();
    group.files.reverse();
    expect(createTaskFingerprint(template, group, "0.1.0")).toBe(original);

    template.garmentPieces[0].name = "已修改裁片";
    expect(createTaskFingerprint(template, group, "0.1.0")).not.toBe(original);
  });

  it("has a stable non-ASCII task fingerprint vector", () => {
    const template = structuredClone(samplePreflightPayload.template);
    const group = structuredClone(samplePreflightPayload.groups[0]);
    template.templateId = "衬衫-Á";
    group.name = "蓝花-样组";

    expect(createTaskFingerprint(template, group, "0.1.0")).toBe(
      "85e1cb227357518fe5d1064fdf1edcf65e2d98e4e005eda58839f4b3c1bcbc1a",
    );
  });

  it("does not leak artwork when groups run through the same adapter", async () => {
    const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint);
    const groupA = structuredClone(samplePreflightPayload.groups[0]);
    const groupB = structuredClone(groupA);
    groupB.files = groupB.files.map((file) => ({
      ...file,
      sourceRef: `另一组/${file.name}`,
      fingerprint: `B-${file.fingerprint}`,
    }));

    const firstA = await runSingleGroup(request(groupA), adapter);
    const resultB = await runSingleGroup(request(groupB), adapter);
    const secondA = await runSingleGroup({ ...request(groupA), runId: "run-A-again" }, adapter);

    expect([firstA.status, resultB.status, secondA.status]).toEqual(["completed", "completed", "completed"]);
    expect(firstA.output?.artifacts[0].fingerprint).toBe(secondA.output?.artifacts[0].fingerprint);
    expect(resultB.output?.artifacts[0].fingerprint).not.toBe(firstA.output?.artifacts[0].fingerprint);
    expect(resultB.taskFingerprint).not.toBe(firstA.taskFingerprint);
    expect(adapter.openSessionCount).toBe(0);
  });

  it("does not retain execution scopes across repeated runs", async () => {
    const adapter = new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint);

    for (let index = 0; index < 20; index += 1) {
      const result = await runSingleGroup({ ...request(), runId: `stability-${index}` }, adapter);
      expect(result.status).toBe("completed");
      expect(adapter.retainedScopeCount).toBe(0);
      expect(adapter.ownedTemporaryCount).toBe(0);
    }
  });
});
