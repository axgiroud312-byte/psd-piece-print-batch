import { describe, expect, it } from "vitest";

import { MemoryBatchAdapter } from "../src/adapters/memory-batch-adapter";
import { samplePreflightPayload } from "../src/domain/sample";
import type {
  ArtworkAssignment,
  InputGroupSnapshot,
} from "../src/domain/types";
import {
  runBatch,
  type BatchRunRecord,
  type BatchRunStore,
} from "../src/workflow/run-batch";
import { runSingleGroup } from "../src/workflow/run-group";
import type { CancellationToken, ExecutionScope } from "../src/workflow/types";

class StabilityRunStore implements BatchRunStore {
  record?: BatchRunRecord;

  async create(record: BatchRunRecord): Promise<void> {
    this.record = structuredClone(record);
  }

  async load(runId: string): Promise<BatchRunRecord | undefined> {
    return this.record?.runId === runId
      ? structuredClone(this.record)
      : undefined;
  }

  async save(record: BatchRunRecord): Promise<void> {
    this.record = structuredClone(record);
  }

  async listRecoverable() {
    return {
      records:
        this.record?.status === "completed"
          ? []
          : this.record
            ? [structuredClone(this.record)]
            : [],
      failures: [],
    };
  }
}

class GroupFailureAdapter extends MemoryBatchAdapter {
  override async replaceArtwork(
    scope: ExecutionScope,
    assignments: ArtworkAssignment[],
    cancellation: CancellationToken,
  ): Promise<void> {
    const shouldFail = assignments.some((assignment) =>
      assignment.sourceFingerprint.startsWith("B-"),
    );
    await super.replaceArtwork(
      scope,
      shouldFail ? assignments.slice(0, 1) : assignments,
      cancellation,
    );
    if (shouldFail) {
      throw new Error("故障注入：B 组替换阶段失败");
    }
  }
}

function variant(name: string, marker: string): InputGroupSnapshot {
  const group = structuredClone(samplePreflightPayload.groups[0]);
  group.name = name;
  group.files = group.files.map((file, index) => ({
    ...file,
    sourceRef: `${marker}/${file.name}`,
    fingerprint: `${marker}-${index}-${file.fingerprint}`,
  }));
  return group;
}

function artifactFingerprints(
  output: { artifacts: Array<{ fingerprint: string }> } | undefined,
): string[] {
  return output?.artifacts.map((artifact) => artifact.fingerprint) ?? [];
}

async function cleanBaseline(group: InputGroupSnapshot): Promise<string[]> {
  const result = await runSingleGroup(
    {
      runId: `clean-${group.name}`,
      pluginVersion: "0.1.0",
      template: structuredClone(samplePreflightPayload.template),
      group,
    },
    new MemoryBatchAdapter(samplePreflightPayload.template.masterFingerprint),
  );
  if (result.status !== "completed")
    throw new Error(`无法生成 ${group.name} 的干净基线`);
  return artifactFingerprints(result.output);
}

describe("diagnostic release stability evidence", () => {
  it("completes 20 groups serially without retained sessions or cross-group outputs", async () => {
    const groups = Array.from({ length: 20 }, (_, index) =>
      variant(`连续组-${index + 1}`, `G${index + 1}`),
    );
    const adapter = new MemoryBatchAdapter(
      samplePreflightPayload.template.masterFingerprint,
    );
    const masterBefore = adapter.masterStateDigest;

    const outcome = await runBatch(
      {
        runId: "stability-20-groups",
        pluginVersion: "0.1.0",
        template: structuredClone(samplePreflightPayload.template),
        groups,
        accessGrants: {
          master: "memory-master",
          input: "memory-input",
          output: "memory-output",
        },
      },
      { store: new StabilityRunStore(), adapter },
    );

    expect(outcome.record.status).toBe("completed");
    expect(outcome.record.groups).toHaveLength(20);
    expect(
      outcome.record.groups.every((group) => group.state === "completed"),
    ).toBe(true);
    expect(adapter.committed).toHaveLength(20);
    expect(
      new Set(adapter.committed.map((output) => output.location)).size,
    ).toBe(20);
    expect(
      new Set(
        adapter.committed.map((output) => output.artifacts[0].fingerprint),
      ).size,
    ).toBe(20);
    const cleanOutputs = await Promise.all(groups.map(cleanBaseline));
    expect(
      adapter.committed.map((output) => artifactFingerprints(output)),
    ).toEqual(cleanOutputs);
    expect(adapter.openSessionCount).toBe(0);
    expect(adapter.ownedTemporaryCount).toBe(0);
    expect(adapter.retainedScopeCount).toBe(0);
    expect(adapter.masterStateDigest).toBe(masterBefore);
  });

  it("reproduces A after A/B/C without retaining B or C artwork", async () => {
    const adapter = new MemoryBatchAdapter(
      samplePreflightPayload.template.masterFingerprint,
    );
    const [groupA, groupB, groupC] = [
      variant("A", "A"),
      variant("B", "B"),
      variant("C", "C"),
    ];
    const run = (runId: string, group: InputGroupSnapshot) =>
      runSingleGroup(
        {
          runId,
          pluginVersion: "0.1.0",
          template: structuredClone(samplePreflightPayload.template),
          group,
        },
        adapter,
      );

    const firstA = await run("sequence-A-1", groupA);
    const resultB = await run("sequence-B", groupB);
    const resultC = await run("sequence-C", groupC);
    const secondA = await run("sequence-A-2", groupA);

    expect([
      firstA.status,
      resultB.status,
      resultC.status,
      secondA.status,
    ]).toEqual(["completed", "completed", "completed", "completed"]);
    expect(artifactFingerprints(secondA.output)).toEqual(
      artifactFingerprints(firstA.output),
    );
    expect(artifactFingerprints(firstA.output)).toEqual(
      await cleanBaseline(groupA),
    );
    expect(artifactFingerprints(resultB.output)).toEqual(
      await cleanBaseline(groupB),
    );
    expect(artifactFingerprints(resultC.output)).toEqual(
      await cleanBaseline(groupC),
    );
    expect(adapter.openSessionCount).toBe(0);
    expect(adapter.ownedTemporaryCount).toBe(0);
  });

  it("contains an injected B failure and keeps later C and repeated A uncontaminated", async () => {
    const [groupA, groupB, groupC] = [
      variant("A", "A"),
      variant("B", "B"),
      variant("C", "C"),
    ];
    const adapter = new GroupFailureAdapter(
      samplePreflightPayload.template.masterFingerprint,
    );
    const masterBefore = adapter.masterStateDigest;
    const outcome = await runBatch(
      {
        runId: "fault-injection-abc",
        pluginVersion: "0.1.0",
        template: structuredClone(samplePreflightPayload.template),
        groups: [groupA, groupB, groupC],
        accessGrants: {
          master: "memory-master",
          input: "memory-input",
          output: "memory-output",
        },
      },
      { store: new StabilityRunStore(), adapter },
    );

    expect(outcome.record.groups.map((group) => group.state)).toEqual([
      "completed",
      "failed",
      "completed",
    ]);
    expect(adapter.committed.map((output) => output.location)).toEqual([
      "runs/fault-injection-abc/A",
      "runs/fault-injection-abc/C",
    ]);
    const firstA = adapter.committed[0];
    const completedC = adapter.committed[1];
    const repeatedA = await runSingleGroup(
      {
        runId: "fault-injection-A-again",
        pluginVersion: "0.1.0",
        template: structuredClone(samplePreflightPayload.template),
        group: groupA,
      },
      adapter,
    );

    expect(repeatedA.status).toBe("completed");
    const cleanA = await cleanBaseline(groupA);
    expect(artifactFingerprints(firstA)).toEqual(cleanA);
    expect(artifactFingerprints(completedC)).toEqual(
      await cleanBaseline(groupC),
    );
    expect(artifactFingerprints(repeatedA.output)).toEqual(cleanA);
    expect(adapter.openSessionCount).toBe(0);
    expect(adapter.ownedTemporaryCount).toBe(0);
    expect(adapter.retainedScopeCount).toBe(0);
    expect(adapter.masterStateDigest).toBe(masterBefore);
  });
});
