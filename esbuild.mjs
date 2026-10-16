import { build } from "esbuild";

const common = { bundle: true, platform: "node", target: "node20", format: "cjs", sourcemap: true, logLevel: "info" };
await build({ ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] });
await build({ ...common, entryPoints: ["src/broker/index.ts"], outfile: "dist/broker.js" });
