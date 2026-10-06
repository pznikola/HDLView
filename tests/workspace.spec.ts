import { test, expect, type Page } from "@playwright/test";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import {
  mkdtempSync,
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
let backend: ChildProcessWithoutNullStreams;
let snapshot: { directory: string };
let pending: ((result: unknown) => void)[] = [];
async function fileCommand(page: Page, command: string) {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: command, exact: true }).click();
}
async function finishWizard(page: Page) {
  await page.getByRole("button", { name: "Next: Review", exact: true }).click();
  await page
    .getByRole("button", { name: "Create New Project", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Create New Project", exact: true }),
  ).toBeHidden();
}
async function finishImport(page: Page) {
  await expect(
    page.getByRole("dialog", { name: "Import Review" }),
  ).toBeHidden();
  const done = page
    .getByRole("dialog", { name: "Add New Files", exact: true })
    .getByRole("button", { name: "Done", exact: true });
  if (await done.isVisible()) await done.click();
}
test.beforeAll(() => {
  const store = mkdtempSync(join(tmpdir(), "hdlview browser artifacts "));
  const args = ["--store", store];
  if (process.env.HDLVIEW_TOOL_PROFILE)
    args.push("--profile", process.env.HDLVIEW_TOOL_PROFILE);
  const build = spawnSync(
    "target/debug/hdlview",
    [...args, "build", "examples/counter/hdlview.project.json"],
    { encoding: "utf8" },
  );
  if (build.status !== 0) throw new Error(build.stderr);
  snapshot = JSON.parse(build.stdout);
  backend = spawn("target/debug/hdlview", ["--store", store, "rpc"]);
  createInterface({ input: backend.stdout }).on("line", (line) =>
    pending.shift()?.(JSON.parse(line)),
  );
});
test.afterAll(() => backend?.kill());
test("schematic and waveform selections preserve instance identity and stage binding", async ({
  page,
}) => {
  const calls: string[] = [];
  await page.addInitScript(() => {
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        performance.mark("hdlview-layout-worker");
      }
    };
  });
  await page.exposeFunction(
    "__HDLVIEW_TEST_API__",
    (action: string, args: unknown) =>
      new Promise((resolve, reject) => {
        calls.push(action);
        pending.push((value: unknown) => {
          const r = value as { ok: boolean; result: unknown; error: string };
          r.ok ? resolve(r.result) : reject(new Error(r.error));
        });
        backend.stdin.write(JSON.stringify({ action, args }) + "\n");
      }),
  );
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => [
    resolve("examples/counter/hdlview.project.json"),
  ]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await fileCommand(page, "Open Existing Project…");
  await expect(
    page.getByRole("dialog", { name: "Classify Simulation Sources" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open saved snapshot" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Open saved snapshot" }).click();
  await page
    .getByLabel("Open snapshot input")
    .fill(snapshot.directory + "/snapshot.json");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByLabel("Schematic")).toBeVisible();
  await expect(page.locator(".nodebox").first()).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Expand schematic buses" }).click();
  await expect(
    page.locator(".port-name").filter({ hasText: "fast[3]" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse schematic buses" }).click();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.getByText("Waveforms", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByRole("button", { name: "Mapped gates", exact: true }),
  ).toBeDisabled();
  await page
    .locator(".signal-list button")
    .filter({ hasText: "fast" })
    .first()
    .click();
  await expect(page.locator(".wave-name.active")).toContainText("fast");
  await page.locator(".wave-name").filter({ hasText: "slow" }).first().click();
  await expect(page.locator(".signal-list button.active")).toContainText(
    "slow",
  );
  await expect(page.locator(".layout-indicator")).toBeHidden();
  const layoutWorkers = await page.evaluate(
    () => performance.getEntriesByName("hdlview-layout-worker").length,
  );
  const windows = calls.filter((action) => action === "wave_window").length;
  const views = calls.filter((action) => action === "view").length;
  await page
    .getByLabel("Waveform traces")
    .click({ position: { x: 320, y: 15 } });
  await expect(page.locator(".cursor-label")).not.toHaveText("Cursor 0");
  await expect
    .poll(() => calls.filter((action) => action === "wave_values").length)
    .toBeGreaterThan(0);
  // Allow the cursor render and its passive effects to finish before checking for extra work.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  expect(calls.filter((action) => action === "wave_window")).toHaveLength(
    windows,
  );
  expect(calls.filter((action) => action === "view")).toHaveLength(views);
  expect(
    await page.evaluate(
      () => performance.getEntriesByName("hdlview-layout-worker").length,
    ),
  ).toBe(layoutWorkers);
  await page.locator(".hierarchy button").filter({ hasText: "first" }).click();
  await expect(page.locator(".hierarchy button.active")).toContainText("first");

  await page
    .locator(".signal-list button")
    .filter({ hasText: /^count/ })
    .first()
    .click();
  await expect(page.locator(".wave-name.active")).toContainText("first.count");
  await page.locator(".hierarchy button").filter({ hasText: "second" }).click();
  await page
    .locator(".signal-list button")
    .filter({ hasText: /^count/ })
    .first()
    .click();
  await expect(page.locator(".wave-name.active")).toContainText("second.count");
  await expect(page.getByRole("button", { name: "Next scope" })).toBeDisabled();
  await page.getByRole("button", { name: "Previous scope" }).click();
  await expect(page.locator(".hierarchy button.active")).toContainText("first");
  await page.getByRole("button", { name: "Next scope" }).click();
  await expect(page.locator(".hierarchy button.active")).toContainText(
    "second",
  );
  await expect(page.getByRole("button", { name: "Next scope" })).toBeDisabled();
  await page.locator(".wave-name").filter({ hasText: "first.count" }).click();
  await expect(page.locator(".hierarchy button.active")).toContainText("first");
  await page
    .getByRole("button", {
      name: "Expand hdlview_sim.tb.dut.fast",
      exact: true,
    })
    .click();
  await expect(
    page.locator(".wave-name").filter({ hasText: "fast[3]" }),
  ).toBeVisible();
  await expect(page.locator(".layout-indicator")).toBeHidden({
    timeout: 20000,
  });
  await expect(page.locator(".nodebox").first()).toBeVisible();
  await page
    .getByRole("button", {
      name: "Expand hdlview_sim.tb.dut.slow",
      exact: true,
    })
    .click();
  const waveScroll = page.locator(".wave-scroll");
  await waveScroll.hover();
  await page.mouse.wheel(0, -1000);
  await expect
    .poll(() => waveScroll.evaluate((element) => element.scrollTop))
    .toBe(0);
  const waveSplitter = page.getByRole("separator", { name: "Waveform height" });
  const paneHeight = () =>
    page.locator(".wave-panel").evaluate((element) => element.clientHeight);
  const schematicHeight = () =>
    page.locator(".workbench").evaluate((element) => element.clientHeight);
  const initialHeight = await paneHeight();
  const initialSchematicHeight = await schematicHeight();
  const initialRows = await page.locator(".wave-name").count();
  const selectedSignal = await page
    .locator(".signal-list button.active")
    .textContent();
  const cursorLabel = await page.locator(".cursor-label").textContent();
  const resizeWorkers = await page.evaluate(
    () => performance.getEntriesByName("hdlview-layout-worker").length,
  );
  const resizeViews = calls.filter((action) => action === "view").length;
  await waveSplitter.focus();
  await page.keyboard.press("ArrowUp");
  await expect(waveSplitter).toHaveAttribute("aria-valuenow", "40");
  await expect.poll(paneHeight).toBeGreaterThan(initialHeight);
  await page.keyboard.press("ArrowDown");
  await expect(waveSplitter).toHaveAttribute("aria-valuenow", "35");
  const bounds = await waveSplitter.boundingBox();
  if (!bounds) throw new Error("Waveform divider is not visible");
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width + 20, bounds.y - 150, {
    steps: 8,
  });
  await page.mouse.up();
  await expect.poll(paneHeight).toBeGreaterThan(initialHeight);
  await expect.poll(schematicHeight).toBeLessThan(initialSchematicHeight);
  await expect
    .poll(() => page.locator(".wave-name").count())
    .toBeGreaterThan(initialRows);
  const expandedHeight = await paneHeight();
  const expandedBounds = await waveSplitter.boundingBox();
  if (!expandedBounds) throw new Error("Waveform divider is not visible");
  await page.mouse.move(
    expandedBounds.x + expandedBounds.width / 2,
    expandedBounds.y + expandedBounds.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    expandedBounds.x + expandedBounds.width + 20,
    expandedBounds.y + 150,
    { steps: 8 },
  );
  await page.mouse.up();
  await expect.poll(paneHeight).toBeLessThan(expandedHeight);
  await expect(page.locator(".cursor-label")).toHaveText(cursorLabel ?? "");
  await expect(page.locator(".signal-list button.active")).toHaveText(
    selectedSignal ?? "",
  );
  expect(calls.filter((action) => action === "view")).toHaveLength(resizeViews);
  expect(
    await page.evaluate(
      () => performance.getEntriesByName("hdlview-layout-worker").length,
    ),
  ).toBe(resizeWorkers);
  await waveSplitter.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await expect(waveSplitter).toHaveAttribute("aria-valuenow", "70");
  await page.setViewportSize({ width: 1100, height: 650 });
  await expect
    .poll(() =>
      page
        .locator(".workspace")
        .evaluate((element) => element.scrollHeight <= element.clientHeight),
    )
    .toBe(true);
  await expect.poll(schematicHeight).toBeGreaterThanOrEqual(120);
  await expect.poll(paneHeight).toBeGreaterThanOrEqual(120);
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  await expect(waveSplitter).toHaveAttribute("aria-valuenow", "20");
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.screenshot({
    path: resolve("test-results/workspace.png"),
    fullPage: true,
  });
  await page.reload();
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".project-title")).toContainText("counter");
  await expect(page.getByText("Waveforms", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.locator(".wave-name").filter({ hasText: "fast" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("separator", { name: "Waveform height" }),
  ).toHaveAttribute("aria-valuenow", "35");
  await page.getByRole("button", { name: "Close waveform session" }).click();
  await expect(
    page.getByRole("separator", { name: "Waveform height" }),
  ).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Mapped gates", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});

test("create, import, edit, resolve conflicts, and rebuild external RTL without changing captured sources", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "hdlview UI project "));
  const configDirectory = join(directory, "configuration");
  const rtl = join(directory, "RTL sources");
  mkdirSync(configDirectory);
  mkdirSync(join(rtl, "sub"), { recursive: true });
  mkdirSync(join(rtl, "node_modules"));
  const original =
    '`include "defs.svh"\nmodule top(input clk, output wire [3:0] count);\nleaf child(clk,count);\nendmodule\n';
  writeFileSync(join(rtl, "top.sv"), original);
  writeFileSync(
    join(rtl, "sub", "top.sv"),
    "module leaf(input clk, output reg [3:0] count=0); always @(posedge clk) count<=count+1; endmodule\n",
  );
  writeFileSync(join(rtl, "defs.svh"), "`define WIDTH 4\n");
  writeFileSync(
    join(rtl, "tb.sv"),
    "module tb; reg clk=0; wire [3:0] count; top dut(clk,count); always #5 clk=~clk; initial #45 $finish; endmodule\n",
  );
  writeFileSync(join(rtl, "node_modules", "ignore.sv"), "invalid");
  let chosen: string[] | null = [configDirectory];
  const built: {
    id: string;
    directory: string;
    project: { sources: { path: string }[] };
  }[] = [];
  let trace: string | undefined;
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => chosen);
  const rpc = (action: string, args: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      pending.push((value) => {
        const r = value as { ok: boolean; result: unknown; error: string };
        if (r.ok && action === "job") {
          const job = r.result as {
            status: string;
            kind: string;
            result: unknown;
          };
          if (job.status === "complete" && job.kind === "build") {
            const snapshot = job.result as (typeof built)[number];
            if (!built.some((s) => s.id === snapshot.id)) built.push(snapshot);
          }
          if (job.status === "complete" && job.kind === "simulate")
            trace = (job.result as { trace: string }).trace;
        }
        r.ok ? resolve(r.result) : reject(new Error(r.error));
      });
      backend.stdin.write(JSON.stringify({ action, args }) + "\n");
    });
  await page.exposeFunction("__HDLVIEW_TEST_API__", rpc);
  const profile = JSON.parse(
    readFileSync(
      process.env.HDLVIEW_TOOL_PROFILE ?? "tools/profiles/docker.json",
      "utf8",
    ),
  );
  await page.addInitScript(
    (profile) =>
      localStorage.setItem("hdlview-profile", JSON.stringify(profile)),
    profile,
  );
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await fileCommand(page, "Create New Project…");
  await page.getByLabel("Project name", { exact: true }).fill("External RTL");
  await page.getByRole("button", { name: "Choose Directory" }).click();
  await page.getByLabel("Technology", { exact: true }).selectOption("sky130");
  await page
    .getByRole("button", { name: "Next: Sources", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Build schematic" }),
  ).toBeDisabled();
  chosen = [rtl];
  await page
    .getByRole("dialog", { name: "Create New Project", exact: true })
    .getByRole("button", { name: "Add Folder" })
    .click();
  const review = page.getByRole("dialog", { name: "Import Review" });
  await expect(review).toBeVisible();
  await expect(review).toContainText("node_modules");
  await review
    .getByRole("combobox", { name: /Role for .*tb.sv/ })
    .selectOption("simulation");
  await review.getByRole("button", { name: "Apply Import" }).click();
  await finishWizard(page);
  await expect(
    page.getByRole("dialog", { name: "Create New Project", exact: true }),
  ).toBeHidden();
  const configPath = join(configDirectory, "hdlview.project.json");
  const project = JSON.parse(readFileSync(configPath, "utf8"));
  expect(project.schema_version).toBe(3);
  expect(project.sources).toHaveLength(2);
  expect(project.headers).toHaveLength(1);
  expect(project.simulation_sources).toHaveLength(1);
  expect(Object.values(project.source_roots)).toEqual(["../RTL sources"]);
  await finishImport(page);
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await page.getByLabel("Top module", { exact: true }).fill("top");
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expect(
    page.getByRole("dialog", { name: "Project Settings" }),
  ).toBeHidden();
  await finishImport(page);
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await page
    .getByText("Advanced JSON: simulation and physical flow", { exact: true })
    .click();
  const configured = JSON.parse(
    await page.getByLabel("Advanced project JSON").inputValue(),
  );
  configured.simulations = {
    rtl: {
      simulator: "icarus",
      top: "tb",
      dut_scope: ["tb", "dut"],
      testbench: project.simulation_sources,
    },
  };
  await page
    .getByLabel("Advanced project JSON")
    .fill(JSON.stringify(configured));
  await page.getByRole("button", { name: "Apply Advanced JSON" }).click();
  await expect(
    page.getByRole("dialog", { name: "Project Settings" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Build schematic" }).click();
  await page
    .getByRole("dialog", { name: "Unsaved changes" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(page.getByLabel("Schematic")).toBeHidden();
  await page.getByRole("button", { name: "Build schematic" }).click();
  await page
    .getByRole("button", { name: "Save All and Build", exact: true })
    .click();
  await expect(page.locator(".nodebox").first()).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.getByText("Waveforms", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  if (!trace) throw new Error("Simulation did not publish a trace");
  const originalTrace = readFileSync(trace, "utf8");
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  const sourceRoot = `@${Object.keys(project.source_roots)[0]}`;
  const sourceButton = page.locator(
    `.source-file[title="${sourceRoot}/top.sv"]`,
  );
  await sourceButton.click();
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("module top");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// editor change\n");
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => readFileSync(join(rtl, "top.sv"), "utf8"))
    .toContain("// editor change");
  await expect(
    page.getByText("Sources changed · rebuild needed", { exact: true }),
  ).toBeVisible();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// buffer retained\n");
  writeFileSync(join(rtl, "top.sv"), original + "// external change\n");
  await page.keyboard.press("Control+s");
  await expect(
    page.getByRole("button", { name: "Overwrite", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toContainText("// buffer retained");
  await page.keyboard.press("Control+s");
  await page.getByRole("button", { name: "Reload", exact: true }).click();
  await expect(editor).toContainText("// external change");
  await expect(editor).not.toContainText("// buffer retained");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// overwrite chosen\n");
  writeFileSync(join(rtl, "top.sv"), original + "// another external edit\n");
  await page.keyboard.press("Control+s");
  await page.getByRole("button", { name: "Overwrite", exact: true }).click();
  await expect
    .poll(() => readFileSync(join(rtl, "top.sv"), "utf8"))
    .toContain("// overwrite chosen");
  chmodSync(join(rtl, "top.sv"), 0o444);
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// unsaved after failed write\n");
  await page.keyboard.press("Control+s");
  await expect(page.locator(".error-banner")).toContainText("read-only");
  await page
    .getByRole("button", { name: `Close ${sourceRoot}/top.sv`, exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Unsaved changes" })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(editor).toContainText("// unsaved after failed write");
  await page
    .getByRole("button", { name: `Close ${sourceRoot}/top.sv`, exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Unsaved changes" })
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  chmodSync(join(rtl, "top.sv"), 0o644);
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  await sourceButton.click();
  await expect(editor).not.toContainText("// unsaved after failed write");
  await page.getByRole("button", { name: "Hide Editor", exact: true }).click();
  await expect(editor).toBeHidden();
  await sourceButton.click();
  await expect(editor).toBeVisible();
  const splitter = page.getByRole("separator", { name: "Editor width" });
  await splitter.focus();
  await page.keyboard.press("ArrowRight");
  await expect(splitter).toHaveAttribute("aria-valuenow", "50");
  chosen = null;
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".project-title")).toContainText("External RTL");
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// dirty tab\n");
  chosen = [resolve("examples/counter/hdlview.project.json")];
  await fileCommand(page, "Open Existing Project…");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toContainText("// dirty tab");
  await page.keyboard.press("Control+Shift+s");
  await expect
    .poll(() => readFileSync(join(rtl, "top.sv"), "utf8"))
    .toContain("// dirty tab");
  await page.getByRole("button", { name: "Design", exact: true }).click();
  await page.getByRole("button", { name: "child", exact: true }).click();
  await page.getByRole("button", { name: "View source", exact: true }).click();
  await expect(editor).toContainText("module top");
  await expect(editor).not.toContainText("// editor change");
  await expect(
    page.getByText("Captured source · read-only", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open Working File" }).click();
  await expect(editor).toContainText("// dirty tab");
  await expect(page.getByText("Waveforms", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close waveform session" }).click();
  await page.getByRole("button", { name: "Build schematic" }).click();
  await expect(
    page.getByText("Sources changed · rebuild needed", { exact: true }),
  ).toBeHidden({ timeout: 30000 });
  expect(built).toHaveLength(2);
  const [before, after] = built;
  if (!before || !after) throw new Error("Expected two successful builds");
  expect(after.id).not.toBe(before.id);
  const capturedTop = before.project.sources.find(
    (s) => !s.path.includes("/sub/"),
  );
  if (!capturedTop) throw new Error("Missing captured top source");
  expect(
    readFileSync(join(before.directory, "inputs", capturedTop.path), "utf8"),
  ).toBe(original);
  expect(readFileSync(trace, "utf8")).toBe(originalTrace);
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  writeFileSync(join(rtl, "added.sv"), "module added; endmodule\n");
  await page
    .locator('[data-source-path="@RTL_sources"]')
    .first()
    .click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Rescan Folder", exact: true })
    .click();
  await expect(review).toBeVisible();
  await expect(
    review.getByRole("combobox", { name: /Role for .*tb.sv/ }),
  ).toHaveValue("simulation");
  await review.getByRole("button", { name: "Apply Import" }).click();
  await finishImport(page);
  await fileCommand(page, "Save Project");
  await expect
    .poll(() => JSON.parse(readFileSync(configPath, "utf8")).sources.length)
    .toBe(3);
  const extra = join(directory, "extra files");
  mkdirSync(extra);
  writeFileSync(join(extra, "extra.sv"), "module extra; endmodule\n");
  writeFileSync(join(extra, "extra.svh"), "// header\n");
  chosen = [join(extra, "extra.sv"), join(extra, "extra.svh")];
  await fileCommand(page, "Add New Files…");
  await page.getByRole("button", { name: "Select Files", exact: true }).click();
  await review
    .getByRole("button", { name: "Apply Import", exact: true })
    .click();
  await finishImport(page);
  await fileCommand(page, "Save Project");
  await expect
    .poll(() => JSON.parse(readFileSync(configPath, "utf8")).sources.length)
    .toBe(4);
  await page.screenshot({
    path: resolve("test-results/project-editor.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("empty project creation and ordered SystemVerilog filelist import", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "hdlview SystemVerilog "));
  mkdirSync(join(directory, "lists"));
  writeFileSync(
    join(directory, "lists", "types.sv"),
    "package types; parameter int width = 4; endpackage\n",
  );
  writeFileSync(
    join(directory, "top.sv"),
    "module top(input [types::width-1:0] a, output [types::width-1:0] y); assign y=~a; endmodule\n",
  );
  writeFileSync(join(directory, "lists", "nested.f"), "types.sv\n");
  writeFileSync(join(directory, "rtl.f"), '-F lists/nested.f\n"top.sv"\n');
  let chosen: string[] | null = [directory];
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => chosen);
  await page.exposeFunction(
    "__HDLVIEW_TEST_API__",
    (action: string, args: unknown) =>
      new Promise((resolve, reject) => {
        pending.push((value) => {
          const r = value as { ok: boolean; result: unknown; error: string };
          r.ok ? resolve(r.result) : reject(new Error(r.error));
        });
        backend.stdin.write(JSON.stringify({ action, args }) + "\n");
      }),
  );
  const profile = JSON.parse(
    readFileSync(
      process.env.HDLVIEW_TOOL_PROFILE ?? "tools/profiles/docker.json",
      "utf8",
    ),
  );
  await page.addInitScript(
    (profile) =>
      localStorage.setItem("hdlview-profile", JSON.stringify(profile)),
    profile,
  );
  await page.goto("/");
  await fileCommand(page, "Create New Project…");
  await page.getByLabel("Project name", { exact: true }).fill("SV files");
  await page.getByRole("button", { name: "Choose Directory" }).click();
  await page.getByLabel("Technology", { exact: true }).selectOption("sky130");
  await page
    .getByRole("button", { name: "Next: Sources", exact: true })
    .click();
  await finishWizard(page);
  await expect(
    page.getByRole("button", { name: "Build schematic" }),
  ).toBeDisabled();
  chosen = [join(directory, "rtl.f")];
  await fileCommand(page, "Add New Files…");
  await page
    .getByRole("button", { name: "Import Filelist", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview Filelist", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Import Review" })
    .getByRole("button", { name: "Apply Import" })
    .click();
  await finishImport(page);
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await page.getByLabel("Top module", { exact: true }).fill("top");
  await page
    .getByRole("button", { name: "Move lists/types.sv down", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Move lists/types.sv up", exact: true })
    .click();
  await page.getByRole("button", { name: "Apply Settings" }).click();
  await expect(
    page.getByRole("dialog", { name: "Project Settings" }),
  ).toBeHidden();
  await page.keyboard.press("Control+Shift+s");
  const configPath = join(directory, "hdlview.project.json");
  await expect
    .poll(() => JSON.parse(readFileSync(configPath, "utf8")).top)
    .toBe("top");
  const project = JSON.parse(readFileSync(configPath, "utf8"));
  expect(project.sources.map((s: { path: string }) => s.path)).toEqual([
    "lists/types.sv",
    "top.sv",
  ]);
  await page.getByRole("button", { name: "Build schematic" }).click();
  await expect(page.getByLabel("Schematic")).toBeVisible({ timeout: 30000 });
  await expect(page.locator(".error-banner")).toBeHidden();
  writeFileSync(join(directory, "rtl.f"), "top.sv\n-F lists/nested.f\n");
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.locator('[data-source-path="rtl.f"]').click({ button: "right" });
  await page
    .getByRole("menuitem", { name: "Reimport Filelist", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview Filelist", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Import Review" })
    .getByRole("button", { name: "Apply Import", exact: true })
    .click();
  await finishImport(page);
  await fileCommand(page, "Save Project");
  await expect
    .poll(() => JSON.parse(readFileSync(configPath, "utf8")).sources[0].path)
    .toBe("top.sv");
  expect(JSON.parse(readFileSync(configPath, "utf8")).sources[1].language).toBe(
    "system_verilog",
  );
});

test("open legacy JSON, migrate on explicit save, and preserve the workspace when opening fails or is cancelled", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "hdlview legacy "));
  const config = join(directory, "hdlview.project.json");
  writeFileSync(join(directory, "top.v"), "module top; endmodule\n");
  writeFileSync(
    config,
    JSON.stringify({
      schema_version: 1,
      name: "Legacy project",
      top: "top",
      sources: [{ path: "top.v", language: "verilog" }],
    }),
  );
  let chosen: string[] | null = [config];
  let holdSave = false;
  let savedResponse: (() => void) | undefined;
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => chosen);
  await page.exposeFunction(
    "__HDLVIEW_TEST_API__",
    (action: string, args: unknown) =>
      new Promise((resolve, reject) => {
        pending.push((value) => {
          const r = value as { ok: boolean; result: unknown; error: string };
          if (r.ok && action === "save_document" && holdSave)
            savedResponse = () => resolve(r.result);
          else r.ok ? resolve(r.result) : reject(new Error(r.error));
        });
        backend.stdin.write(JSON.stringify({ action, args }) + "\n");
      }),
  );
  await page.goto("/");
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".project-title")).toContainText("Legacy project");
  expect(JSON.parse(readFileSync(config, "utf8")).schema_version).toBe(1);
  await page.locator('.source-file[title="top.v"]').click();
  await expect(page.locator(".cm-content")).toContainText("module top");
  await finishImport(page);
  await fileCommand(page, "Save Project");
  await expect
    .poll(() => JSON.parse(readFileSync(config, "utf8")).schema_version)
    .toBe(3);
  const unsupported = join(directory, "vhdl.json");
  const unsupportedText = JSON.stringify({
    schema_version: 2,
    name: "Unsupported",
    top: "",
    project_language: "vhdl",
    sources: [],
  });
  writeFileSync(unsupported, unsupportedText);
  chosen = [unsupported];
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".error-banner")).toContainText(
    "VHDL projects are no longer supported",
  );
  await expect(page.locator(".project-title")).toContainText("Legacy project");
  expect(readFileSync(unsupported, "utf8")).toBe(unsupportedText);
  const invalid = join(directory, "invalid.json");
  writeFileSync(invalid, '{"name":"bad"}');
  chosen = [invalid];
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".error-banner")).toContainText("missing field");
  await expect(page.locator(".project-title")).toContainText("Legacy project");
  await expect(page.locator(".cm-content")).toContainText("module top");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  chosen = null;
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".project-title")).toContainText("Legacy project");
  const other = join(directory, "other");
  mkdirSync(other);
  writeFileSync(join(other, "top.v"), "module second; endmodule\n");
  writeFileSync(
    join(other, "hdlview.project.json"),
    JSON.stringify({
      schema_version: 2,
      name: "Other project",
      project_language: "system_verilog",
      top: "second",
      sources: [{ path: "top.v", language: "verilog" }],
    }),
  );
  holdSave = true;
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// saving previous project\n");
  await page.keyboard.press("Control+s");
  await expect.poll(() => !!savedResponse).toBe(true);
  chosen = [join(other, "hdlview.project.json")];
  await fileCommand(page, "Open Existing Project…");
  await page.getByRole("button", { name: "Discard", exact: true }).click();
  await expect(page.locator(".project-title")).toContainText("Other project");
  await page.locator('.source-file[title="top.v"]').click();
  await expect(page.locator(".cm-content")).toContainText("module second");
  if (!savedResponse)
    throw new Error("Expected pending real-file save response");
  holdSave = false;
  savedResponse();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator(".editor-tabs")).not.toContainText("*");
  await expect(page.locator(".project-title")).toContainText("Other project");
  expect(readFileSync(join(other, "top.v"), "utf8")).toBe(
    "module second; endmodule\n",
  );
});

test("File menu, cancellable creation, independent source groups, and project closing", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "hdlview lifecycle "));
  const inputs = join(directory, "inputs");
  mkdirSync(inputs);
  writeFileSync(join(inputs, "design.sv"), "module design; endmodule\n");
  writeFileSync(join(inputs, "tb.sv"), "module tb; endmodule\n");
  writeFileSync(join(inputs, "gate_tb.sv"), "module gate_tb; endmodule\n");
  writeFileSync(join(inputs, "defs.svh"), "// gate header\n");
  writeFileSync(join(inputs, "gate.f"), "gate_tb.sv\ndefs.svh\n");
  const config = join(directory, "hdlview.project.json");
  let chosen: string[] | null = [directory];
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => chosen);
  const rpc = (action: string, args: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      pending.push((value) => {
        const response = value as {
          ok: boolean;
          result: unknown;
          error: string;
        };
        response.ok
          ? resolve(response.result)
          : reject(new Error(response.error));
      });
      backend.stdin.write(JSON.stringify({ action, args }) + "\n");
    });
  await page.exposeFunction("__HDLVIEW_TEST_API__", rpc);
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "Restore session", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "File", exact: true }).click();
  await expect(
    page.getByRole("menuitem", { name: "Save Project", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("menuitem", { name: "Add New Files…", exact: true }),
  ).toBeDisabled();
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("menuitem", { name: "Open Existing Project…", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "File", exact: true }),
  ).toBeFocused();
  await expect(
    page.getByRole("menu", { name: "File", exact: true }),
  ).toBeHidden();
  await fileCommand(page, "Create New Project…");
  await page
    .getByLabel("Project name", { exact: true })
    .fill("Cancelled draft");
  await page.getByRole("button", { name: "Choose Directory" }).click();
  await expect(
    page.getByRole("button", { name: "Next: Sources", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Technology", { exact: true })
    .selectOption("ihp_sg13g2");
  await page
    .getByRole("button", { name: "Next: Sources", exact: true })
    .click();
  expect(existsSync(config)).toBe(false);
  await page.getByRole("button", { name: "Close project dialog" }).click();
  expect(existsSync(config)).toBe(false);
  await expect(page.locator(".project-title")).toHaveText("No project open");
  await fileCommand(page, "Create New Project…");
  await page.getByLabel("Project name", { exact: true }).fill("Grouped SV");
  await page.getByRole("button", { name: "Choose Directory" }).click();
  await page
    .getByLabel("Technology", { exact: true })
    .selectOption("ihp_sg13g2");
  await page
    .getByRole("button", { name: "Next: Sources", exact: true })
    .click();
  for (const [group, file] of [
    ["design", "design.sv"],
    ["simulation", "tb.sv"],
  ]) {
    await page.getByLabel("Source group", { exact: true }).selectOption(group);
    chosen = [join(inputs, file)];
    await page
      .getByRole("button", { name: "Select Files", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Apply Import", exact: true })
      .click();
    expect(existsSync(config)).toBe(false);
  }
  await page
    .getByLabel("Source group", { exact: true })
    .selectOption("simulation");
  chosen = [join(inputs, "gate.f")];
  await page
    .getByRole("button", { name: "Import Filelist", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Preview Filelist", exact: true })
    .click();
  await expect(page.getByLabel("Role for inputs/gate_tb.sv")).toHaveValue(
    "simulation",
  );
  await expect(page.getByLabel("Role for inputs/defs.svh")).toHaveValue(
    "simulation_header",
  );
  await page.getByRole("button", { name: "Apply Import", exact: true }).click();
  await finishWizard(page);
  const stored = JSON.parse(readFileSync(config, "utf8"));
  expect(stored.technology).toBe("ihp_sg13g2");
  expect(stored.physical).toBeNull();
  expect(stored.sources.map((s: { path: string }) => s.path)).toEqual([
    "inputs/design.sv",
  ]);
  expect(stored.simulation_sources).toEqual([
    "inputs/tb.sv",
    "inputs/gate_tb.sv",
  ]);
  expect(stored.simulation_headers).toEqual(["inputs/defs.svh"]);
  expect(stored.schema_version).toBe(3);
  expect(stored.project_language).toBeUndefined();
  for (const [group, file] of [
    ["Design Sources", "design.sv"],
    ["Simulation Sources", "tb.sv"],
    ["Simulation Sources", "gate_tb.sv"],
  ]) {
    await expect(
      page
        .locator(".source-group")
        .filter({
          has: page.locator("summary", { hasText: new RegExp(`^${group}$`) }),
        })
        .locator(`.source-file[title="inputs/${file}"]`),
    ).toBeVisible();
  }
  await expect(page.locator("aside .source-actions")).toHaveCount(0);
  await expect(page.locator("header > :last-child")).toHaveClass("brand");
  writeFileSync(join(inputs, "unsupported.vhd"), "entity bad is end;\n");
  const before = readFileSync(config, "utf8");
  await expect(
    rpc("preview_import", {
      path: config,
      request: {
        group: "design",
        kind: "files",
        paths: [join(inputs, "unsupported.vhd")],
      },
    }).then(async (job) => {
      const id = (job as { id: string }).id;
      let result: { status: string; error?: string };
      do {
        result = (await rpc("job", { id })) as typeof result;
      } while (result.status === "running");
      if (result.status !== "failed")
        throw new Error("Wrong-language import unexpectedly succeeded");
      return result.error;
    }),
  ).resolves.toContain("unsupported.vhd");
  expect(readFileSync(config, "utf8")).toBe(before);
  await page.locator('.source-file[title="inputs/tb.sv"]').click();
  await page.locator(".cm-content").click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("// unsaved\n");
  await fileCommand(page, "Close Project");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("// unsaved");
  await fileCommand(page, "Save Project");
  await expect
    .poll(() => readFileSync(join(inputs, "tb.sv"), "utf8"))
    .toContain("// unsaved");
  await fileCommand(page, "Close Project");
  await expect(page.locator(".project-title")).toHaveText("No project open");
  expect(existsSync(join(inputs, "tb.sv"))).toBe(true);
  chosen = [config];
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".project-title")).toContainText("Grouped SV");
});

test("opening each project restores only its own schematic and matching waveform", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "hdlview restore "));
  const paths: Record<string, string> = {};
  for (const name of ["a", "b"]) {
    const root = join(directory, name);
    mkdirSync(root);
    writeFileSync(
      join(root, "top.sv"),
      `\`timescale 1ns/1ps\nmodule top(input clk, output reg [3:0] ${name}_count=0); always @(posedge clk) ${name}_count<=${name}_count+1; endmodule\n`,
    );
    writeFileSync(
      join(root, "tb.sv"),
      "`timescale 1ns/1ps\nmodule tb; reg clk=0; wire [3:0] count; top dut(clk,count); always #5 clk=~clk; initial #45 $finish; endmodule\n",
    );
    paths[name] = join(root, "hdlview.project.json");
    writeFileSync(
      paths[name],
      JSON.stringify({
        schema_version: 2,
        name: `Project ${name}`,
        project_language: "system_verilog",
        technology: name === "a" ? "sky130" : "ihp_sg13g2",
        top: "top",
        sources: [{ path: "top.sv", language: "system_verilog" }],
        simulation_sources: ["tb.sv"],
        simulations: {
          rtl: {
            stage: "rtl",
            simulator: "icarus",
            top: "tb",
            dut_scope: ["tb", "dut"],
            testbench: ["tb.sv"],
            stop_time: "100ns",
          },
        },
      }),
    );
  }
  let chosen: string[] | null = [paths.a];
  const rpc = (action: string, args: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      pending.push((value) => {
        const r = value as { ok: boolean; result: unknown; error: string };
        r.ok ? resolve(r.result) : reject(new Error(r.error));
      });
      backend.stdin.write(JSON.stringify({ action, args }) + "\n");
    });
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => chosen);
  await page.exposeFunction("__HDLVIEW_TEST_API__", rpc);
  const profile = JSON.parse(
    readFileSync(
      process.env.HDLVIEW_TOOL_PROFILE ?? "tools/profiles/docker.json",
      "utf8",
    ),
  );
  await page.addInitScript(
    (profile) =>
      localStorage.setItem("hdlview-profile", JSON.stringify(profile)),
    profile,
  );
  await page.goto("/");
  for (const name of ["a", "b"]) {
    chosen = [paths[name]];
    await fileCommand(page, "Open Existing Project…");
    await expect(page.locator(".project-title")).toHaveText(`Project ${name}`);
    await expect(page.getByLabel("Schematic", { exact: true })).toBeHidden();
    await page
      .getByRole("button", { name: "Build schematic", exact: true })
      .click();
    await expect(page.getByLabel("Schematic", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await page.getByRole("button", { name: "Run simulation" }).click();
    await expect(
      page.locator(".wave-name").filter({ hasText: `${name}_count` }),
    ).toBeVisible({ timeout: 30000 });
    await expect
      .poll(async () => {
        const state = (await rpc("restore_project_state", {
          path: paths[name],
        })) as { snapshot?: unknown; run_path?: string };
        return !!state.snapshot && !!state.run_path;
      })
      .toBe(true);
  }
  chosen = [paths.a];
  await fileCommand(page, "Open Existing Project…");
  await expect(
    page.locator(".wave-name").filter({ hasText: "a_count" }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.locator(".wave-name").filter({ hasText: "b_count" }),
  ).toHaveCount(0);
  await expect(page.locator(".cursor-label")).toHaveText("Cursor 0");
  await expect(page.locator(".editor-tabs button")).toHaveCount(0);
  await fileCommand(page, "Close Project");
  await expect(page.getByLabel("Schematic", { exact: true })).toBeHidden();
  chosen = [paths.b];
  await fileCommand(page, "Open Existing Project…");
  await expect(
    page.locator(".wave-name").filter({ hasText: "b_count" }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.locator(".wave-name").filter({ hasText: "a_count" }),
  ).toHaveCount(0);
  await expect(page.locator(".error-banner")).toBeHidden();
  await page.screenshot({
    path: resolve("test-results/file-menu-workspace.png"),
    fullPage: true,
  });
});

test("one unchanged testbench configuration runs RTL and generic gates", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "hdlview shared testbench "));
  for (const file of ["counter.sv", "tb.sv"])
    writeFileSync(
      join(directory, file),
      readFileSync(resolve("examples/counter", file)),
    );
  const config = join(directory, "hdlview.project.json");
  writeFileSync(
    config,
    JSON.stringify({
      schema_version: 2,
      name: "Shared testbench",
      top: "counter",
      sources: [{ path: "counter.sv", language: "system_verilog" }],
      simulation_sources: ["tb.sv"],
      gate_simulation_sources: ["tb.sv"],
      simulations: {
        shared: {
          stage: "rtl",
          simulator: "icarus",
          top: "tb",
          dut_scope: ["tb", "dut"],
          testbench: ["tb.sv"],
        },
        timing: {
          simulator: "icarus",
          top: "tb",
          dut_scope: ["tb", "dut"],
          testbench: ["tb.sv"],
          use_snapshot_sdf: true,
        },
      },
    }),
  );
  const originalTestbench = readFileSync(join(directory, "tb.sv"));
  const rpc = (action: string, args: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      pending.push((value) => {
        const r = value as { ok: boolean; result: unknown; error: string };
        r.ok ? resolve(r.result) : reject(new Error(r.error));
      });
      backend.stdin.write(JSON.stringify({ action, args }) + "\n");
    });
  await page.exposeFunction("__HDLVIEW_TEST_API__", rpc);
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => [config]);
  const profile = JSON.parse(
    readFileSync(
      process.env.HDLVIEW_TOOL_PROFILE ?? "tools/profiles/docker.json",
      "utf8",
    ),
  );
  await page.addInitScript(
    (profile) =>
      localStorage.setItem("hdlview-profile", JSON.stringify(profile)),
    profile,
  );
  await page.goto("/");
  await fileCommand(page, "Open Existing Project…");
  await expect(
    page.getByRole("dialog", { name: "Classify Simulation Sources" }),
  ).toHaveCount(0);
  await fileCommand(page, "Save Project");
  await expect
    .poll(() => JSON.parse(readFileSync(config, "utf8")).schema_version)
    .toBe(3);
  const saved = JSON.parse(readFileSync(config, "utf8"));
  expect(saved.simulation_sources).toEqual(["tb.sv"]);
  expect(saved.gate_simulation_sources).toBeUndefined();
  expect(saved.simulations.shared.stage).toBeUndefined();
  for (const stage of ["Elaborated RTL", "Generic gates"]) {
    await page.getByRole("button", { name: stage, exact: true }).click();
    await page
      .getByRole("button", { name: "Build schematic", exact: true })
      .click();
    await expect(page.getByLabel("Schematic")).toBeVisible({ timeout: 30000 });
    await expect(
      page.getByRole("button", { name: "Run simulation" }),
    ).toBeEnabled();
    await expect(page.getByLabel("Simulation configuration")).toHaveValue(
      "shared",
    );
    await expect(
      page.getByRole("option", { name: "timing", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Run simulation" }).click();
    await expect(page.getByText("Waveforms", { exact: true })).toBeVisible({
      timeout: 30000,
    });
    await expect(page.locator(".error-banner")).toBeHidden();
    await page
      .getByRole("button", { name: "Close waveform session", exact: true })
      .click();
  }
  expect(readFileSync(join(directory, "tb.sv"))).toEqual(originalTestbench);
});
