import esbuild from "esbuild";
import { rmSync } from "node:fs";
import { spawnSync } from "node:child_process";

const outputDir = ".test-dist";
const outputFile = `${outputDir}/run.cjs`;

try {
  await esbuild.build({
    entryPoints: ["tests/run.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node18",
    outfile: outputFile,
    logLevel: "warning",
  });

  const result = spawnSync(process.execPath, [outputFile], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(outputDir, { recursive: true, force: true });
}
