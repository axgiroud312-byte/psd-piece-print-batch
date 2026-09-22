import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { PLUGIN_VERSION } from "../src/config";
import { parseTemplateConfig, validateTemplate } from "../src/domain/preflight";

const root = process.cwd();

describe("diagnostic release metadata", () => {
  it("keeps package and UXP manifest versions aligned", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(root, "package.json"), "utf8"),
    );
    const manifest = JSON.parse(
      await readFile(path.join(root, "src", "manifest.json"), "utf8"),
    );

    expect(manifest.version).toBe(packageJson.version);
    expect(PLUGIN_VERSION).toBe(packageJson.version);
    expect(manifest.manifestVersion).toBe(5);
    expect(manifest.host).toMatchObject({ app: "PS", minVersion: "23.3.0" });
  });

  it("ships a structurally valid template example marked as unverified", async () => {
    const json = await readFile(
      path.join(root, "examples", "template-config.example.json"),
      "utf8",
    );
    const template = parseTemplateConfig(json);

    expect(
      validateTemplate(template).filter((issue) => issue.severity === "error"),
    ).toEqual([]);
    expect(template.version).toContain("unverified");
    expect(template.output.capabilityProfileId).toContain("UNVERIFIED");
  });

  it("states that external Photoshop and factory acceptance are still pending", async () => {
    const status = await readFile(
      path.join(root, "docs", "RELEASE_STATUS.md"),
      "utf8",
    );
    const compatibility = await readFile(
      path.join(root, "docs", "COMPATIBILITY.md"),
      "utf8",
    );

    expect(status).toContain("不是生产就绪版本");
    for (const issue of ["#2", "#11", "#12", "#13"])
      expect(status).toContain(issue);
    expect(compatibility).toContain("尚无任何真实 Photoshop 版本被列为兼容");
  });
});
