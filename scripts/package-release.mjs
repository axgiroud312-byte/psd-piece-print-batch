import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import AdmZip from "adm-zip";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(path.join(root, "dist", "manifest.json"), "utf8"),
);
const releaseName = `${packageJson.name}-v${packageJson.version}-diagnostic`;
const releaseRoot = path.join(root, "release");
const bundleRoot = path.join(releaseRoot, releaseName);
const archivePath = path.join(releaseRoot, `${releaseName}.zip`);
// ZIP stores local DOS timestamps, so construct this in local time to keep bytes stable across time zones.
const fixedZipDate = new Date(1980, 0, 1, 0, 0, 0);

if (manifest.version !== packageJson.version) {
  throw new Error(
    `版本不一致：package.json=${packageJson.version}，manifest.json=${manifest.version}`,
  );
}
if (manifest.manifestVersion !== 5 || manifest.host?.app !== "PS") {
  throw new Error("发布清单必须是 Photoshop UXP Manifest v5");
}
if (process.platform !== "win32" || process.version !== "v24.14.0") {
  throw new Error(
    "0.1.0 诊断归档只允许在已验证的 Windows + Node.js v24.14.0 组合生成",
  );
}

const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const sourceTreeDirty =
  execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], {
    cwd: root,
    encoding: "utf8",
  }).trim().length > 0;
if (sourceTreeDirty) {
  throw new Error("工作区包含未提交改动，无法生成可追溯发布归档");
}

const testReportPath = path.join(
  os.tmpdir(),
  `${packageJson.name}-vitest-report.json`,
);
let rawTestReport;
try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules", "vitest", "vitest.mjs"),
      "run",
      "--reporter=json",
      `--outputFile=${testReportPath}`,
    ],
    {
      cwd: root,
      env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: "true" },
      stdio: "inherit",
    },
  );
  rawTestReport = JSON.parse(await readFile(testReportPath, "utf8"));
} finally {
  await rm(testReportPath, { force: true });
}

const testResults = rawTestReport.testResults
  .flatMap((file) =>
    file.assertionResults.map((result) => ({
      file: path.relative(root, file.name).replaceAll("\\", "/"),
      name: result.fullName,
      status: result.status,
    })),
  )
  .sort((left, right) =>
    `${left.file}:${left.name}`.localeCompare(`${right.file}:${right.name}`),
  );
if (
  !rawTestReport.success ||
  testResults.some((result) => result.status !== "passed")
) {
  throw new Error("自动化测试报告包含未通过项目，拒绝打包");
}

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(bundleRoot, { recursive: true });
await cp(path.join(root, "dist"), bundleRoot, { recursive: true });

const includedFiles = [
  ["README.md", "README.md"],
  ["docs/OPERATOR_GUIDE.md", "docs/OPERATOR_GUIDE.md"],
  ["docs/COMPATIBILITY.md", "docs/COMPATIBILITY.md"],
  ["docs/RELEASE_STATUS.md", "docs/RELEASE_STATUS.md"],
  ["examples/README.md", "examples/README.md"],
  [
    "examples/template-config.example.json",
    "examples/template-config.example.json",
  ],
  ["package.json", "evidence/build/package.json"],
  ["package-lock.json", "evidence/build/package-lock.json"],
];
for (const [source, destination] of includedFiles) {
  const target = path.join(bundleRoot, destination);
  await mkdir(path.dirname(target), { recursive: true });
  await cp(path.join(root, source), target);
}

const evidence = {
  schemaVersion: 1,
  release: releaseName,
  status: "diagnostic-prerelease",
  productionReady: false,
  sourceRevision,
  sourceTreeDirty,
  verificationCommand: "npm run release:build",
  verificationSummary: {
    testFiles: rawTestReport.testResults.length,
    tests: testResults.length,
    passed: testResults.filter((result) => result.status === "passed").length,
  },
  automatedEvidence: [
    {
      claim: "20 组连续串行运行且无残留作用域",
      test: "tests/stability.test.ts",
    },
    {
      claim: "A/B/C 后单独 A 输出稳定且无串图",
      test: "tests/stability.test.ts",
    },
    {
      claim: "替换阶段故障注入后继续运行且无串图",
      test: "tests/stability.test.ts",
    },
    { claim: "五阶段操作、门禁、停止、恢复与重试", test: "tests/app.test.ts" },
  ],
  pendingExternalEvidence: [
    "GitHub Issue #2: M0 validation pack",
    "GitHub Issue #11: real Photoshop workflow acceptance",
    "GitHub Issue #12: factory file acceptance",
    "GitHub Issue #13: physical sample acceptance",
  ],
};
await mkdir(path.join(bundleRoot, "evidence"), { recursive: true });
await writeFile(
  path.join(bundleRoot, "evidence", "AUTOMATED_EVIDENCE.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
  "utf8",
);
await writeFile(
  path.join(bundleRoot, "evidence", "TEST_REPORT.json"),
  `${JSON.stringify({ schemaVersion: 1, sourceRevision, sourceTreeDirty, success: true, tests: testResults }, null, 2)}\n`,
  "utf8",
);

async function listFiles(directory, relative = "") {
  const entries = await readdir(path.join(directory, relative), {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(directory, child)));
    if (entry.isFile()) files.push(child);
  }
  return files;
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

const requiredPluginFiles = [
  "manifest.json",
  "index.html",
  "index.js",
  "styles.css",
];
const bundleFiles = await listFiles(bundleRoot);
for (const required of requiredPluginFiles) {
  if (!bundleFiles.includes(required))
    throw new Error(`发布包缺少 UXP 文件：${required}`);
}

const checksums = [];
for (const relative of bundleFiles) {
  const data = await readFile(path.join(bundleRoot, relative));
  checksums.push(`${sha256(data)}  ${relative.replaceAll("\\", "/")}`);
}
await writeFile(
  path.join(bundleRoot, "SHA256SUMS.txt"),
  `${checksums.join("\n")}\n`,
  "utf8",
);

async function createArchiveBuffer() {
  const zip = new AdmZip();
  for (const relative of await listFiles(bundleRoot)) {
    const archiveName = relative.replaceAll("\\", "/");
    zip.addFile(archiveName, await readFile(path.join(bundleRoot, relative)));
    const entry = zip.getEntry(archiveName);
    if (entry) entry.header.time = fixedZipDate;
  }
  return zip.toBuffer();
}

const firstArchive = await createArchiveBuffer();
const secondArchive = await createArchiveBuffer();
if (sha256(firstArchive) !== sha256(secondArchive)) {
  throw new Error("相同输入生成了不同 ZIP，拒绝发布");
}
await writeFile(archivePath, firstArchive);

const packagedZip = new AdmZip(firstArchive);
const expectedEntries = (await listFiles(bundleRoot))
  .map((relative) => relative.replaceAll("\\", "/"))
  .sort();
const actualEntries = packagedZip
  .getEntries()
  .filter((entry) => !entry.isDirectory)
  .map((entry) => entry.entryName)
  .sort();
if (JSON.stringify(actualEntries) !== JSON.stringify(expectedEntries)) {
  throw new Error("ZIP 内容与发布目录不一致");
}

const archiveHash = sha256(firstArchive);
console.log(
  `Tests ${testResults.length}/${testResults.length} passed across ${rawTestReport.testResults.length} files`,
);
console.log(`Created ${path.relative(root, archivePath)}`);
console.log(`SHA-256 ${archiveHash}`);
console.log(
  `UXP Developer Tool manifest: ${path.relative(root, path.join(bundleRoot, "manifest.json"))}`,
);
