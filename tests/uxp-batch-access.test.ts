import { describe, expect, it } from "vitest";

import {
  UxpBatchAccess,
  type UxpPersistentEntry,
  type UxpPersistentFileSystem,
} from "../src/adapters/uxp-batch-access";

class FakePersistentFileSystem implements UxpPersistentFileSystem {
  readonly entries = new Map<string, UxpPersistentEntry>();
  selectedFile: UxpPersistentEntry | null = null;
  selectedFolders: UxpPersistentEntry[] = [];
  private sequence = 0;

  async createPersistentToken(entry: UxpPersistentEntry): Promise<string> {
    this.sequence += 1;
    const token = `replacement-${this.sequence}`;
    this.entries.set(token, entry);
    return token;
  }

  async getEntryForPersistentToken(token: string): Promise<UxpPersistentEntry> {
    const entry = this.entries.get(token);
    if (!entry) throw new Error("token expired");
    return entry;
  }

  async getFileForOpening(): Promise<UxpPersistentEntry | null> {
    return this.selectedFile;
  }

  async getFolder(): Promise<UxpPersistentEntry | null> {
    return this.selectedFolders.shift() ?? null;
  }
}

const file = { isFile: true, isFolder: false };
const folder = { isFile: false, isFolder: true };

describe("UXP persistent batch access", () => {
  it("reports expired or wrong-kind grants and creates replacement tokens", async () => {
    const fileSystem = new FakePersistentFileSystem();
    fileSystem.entries.set("master", file);
    fileSystem.entries.set("input", folder);
    fileSystem.entries.set("output", file);
    const access = new UxpBatchAccess(fileSystem);

    await expect(
      access.validate({ master: "master", input: "input", output: "output" }),
    ).resolves.toEqual({
      valid: false,
      invalid: ["output"],
    });

    fileSystem.selectedFolders.push(folder);
    const replaced = await access.reselect(
      { master: "master", input: "input", output: "output" },
      ["output"],
    );
    expect(replaced?.output).toBe("replacement-1");
    await expect(access.validate(replaced!)).resolves.toEqual({ valid: true });
  });

  it("leaves the existing grants unchanged when the user cancels reselection", async () => {
    const fileSystem = new FakePersistentFileSystem();
    const access = new UxpBatchAccess(fileSystem);
    await expect(
      access.reselect({ master: "m", input: "i", output: "o" }, ["input"]),
    ).resolves.toBeUndefined();
  });
});
