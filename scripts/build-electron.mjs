import { build, context } from "esbuild";

async function main() {
  const isWatch = process.argv.includes("--watch");

  const opts = {
    entryPoints: ["./electron/main.ts", "./electron/preload.ts"],
    outdir: "./dist-electron",
    bundle: true,
    platform: "node",
    target: "node22",
    format: "cjs",
    outExtension: { ".js": ".cjs" },
    external: ["electron", "koffi"],
    sourcemap: true,
    logLevel: "info"
  };

  if (isWatch) {
    const ctx = await context(opts);
    await ctx.watch();
    console.log("[electron] watching...");
  } else {
    await build(opts);
    console.log("[electron] built dist-electron/main.cjs + preload.cjs");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});