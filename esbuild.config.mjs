import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "fs";
import path from "path";

const prod = process.argv[2] === "production";

/**
 * After each build, copy the plugin into your vault so Obsidian loads the new
 * version. Put the vault's plugin folder in a file called .vault-plugin-dir
 * (one line, not committed), for example:
 *   /Users/you/MyVault/.obsidian/plugins/canvasflow
 * Without that file, nothing is copied.
 */
const copyToVault = {
  name: "copy-to-vault",
  setup(build) {
    build.onEnd(result => {
      if (result.errors.length) return;
      let dir = "";
      try { dir = fs.readFileSync(".vault-plugin-dir", "utf8").trim(); } catch { return; }
      if (!dir) return;
      if (!fs.existsSync(dir)) {
        console.warn(`Not copied: ${dir} doesn't exist (from .vault-plugin-dir)`);
        return;
      }
      for (const file of ["main.js", "manifest.json", "styles.css"]) {
        fs.copyFileSync(file, path.join(dir, file));
      }
      console.log(`Copied to ${dir}`);
    });
  },
};

const context = await esbuild.context({
  banner: { js: "/* CanvasFlow */" },
  entryPoints: ["main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtins
  ],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [copyToVault],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}