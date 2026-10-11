import { physicalSnapshot } from "./fixtures/layout/snapshot";
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
declare global {
  interface Window {
    maskFrames: {
      kind: string;
      frame: number;
      width: number;
      height: number;
    }[];
  }
}
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
  const store = mkdtempSync(join(tmpdir(), "hdlview-browser-artifacts-"));
  const args = ["--store", store];
  if (process.env.HDLVIEW_TOOL_PROFILE)
    args.push("--profile", process.env.HDLVIEW_TOOL_PROFILE);
  const build = spawnSync(
    "target/debug/hdlview",
    [...args, "build", "tests/fixtures/counter/hdlview.project.json"],
    { encoding: "utf8" },
  );
  if (build.status !== 0) throw new Error(build.stderr);
  snapshot = JSON.parse(build.stdout);
  const data = mkdtempSync(join(resolve("target"), "hdlview test Trash "));
  backend = spawn("target/debug/hdlview", ["--store", store, "rpc"], {
    env: { ...process.env, XDG_DATA_HOME: data, GIO_USE_VFS: "local" },
  });
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
    resolve("tests/fixtures/counter/hdlview.project.json"),
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
  await expect(page.getByLabel("Schematic", { exact: true })).toBeVisible();
  await expect(page.locator(".nodebox").first()).toBeVisible({
    timeout: 20000,
  });
  await page.getByRole("button", { name: "Expand schematic buses" }).click();
  await expect(
    page.locator(".port-name").filter({ hasText: "fast[3]" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Collapse schematic buses" }).click();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.locator(".wave-panel")).toBeVisible({
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
  await expect(page.locator(".cursor-label")).not.toHaveText("A 0");
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
  await expect(page.locator(".layout-indicator")).toBeHidden();
  await page
    .getByLabel("Schematic", { exact: true })
    .screenshot({ path: test.info().outputPath("elaborated-counter.png") });

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
  const waveScroll = page.locator(".wave-scroll");
  await waveScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page
    .getByRole("button", {
      name: "Expand hdlview_sim.tb.dut.slow",
      exact: true,
    })
    .click();
  await waveScroll.hover();
  await page.mouse.wheel(0, -1000);
  await expect
    .poll(() => waveScroll.evaluate((element) => element.scrollTop))
    .toBe(0);
  const waveSplitter = page.getByRole("separator", {
    name: "Bottom panel height",
  });
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
  // Edges, the second cursor and the value at the cursor.
  const ruler = page.getByLabel("Time ruler");
  const clock = page.locator(".wave-name").filter({ hasText: "dut.clk" });
  const span = page.locator(".wave-toolbar > span").last();
  const whole = await span.textContent();
  await clock.click();
  await ruler.click({ position: { x: 265, y: 10 } });
  await page.getByRole("button", { name: "Next edge" }).click();
  await expect(page.locator(".cursor-label")).toHaveText("A 5 ns");
  await expect(clock.locator("output")).toHaveText("1");
  await page.getByRole("button", { name: "Next edge" }).click();
  await expect(page.locator(".cursor-label")).toHaveText("A 10 ns");
  await expect(clock.locator("output")).toHaveText("0");
  await ruler.click({ position: { x: 242, y: 10 }, modifiers: ["Shift"] });
  await expect(page.locator(".delta-label")).not.toHaveText("B 0");
  await page.locator(".cursor-label").click();
  await page.getByRole("button", { name: "Previous edge" }).click();
  await expect(page.locator(".cursor-label")).toHaveText("A 5 ns");
  await page.getByLabel("Time unit").selectOption("ps");
  await expect(page.locator(".cursor-label")).toHaveText("A 5000 ps");
  await page.getByLabel("Time unit").selectOption("auto");
  // The window follows the wheel and a dragged range, and asks for its rows again.
  const traces = page.getByLabel("Waveform traces");
  const zoomWindows = calls.filter((a) => a === "wave_window").length;
  await traces.hover({ position: { x: 500, y: 10 } });
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -300);
  await page.keyboard.up("Control");
  await expect(span).not.toHaveText(whole ?? "");
  await expect
    .poll(() => calls.filter((a) => a === "wave_window").length)
    .toBeGreaterThan(zoomWindows);
  await page.getByRole("button", { name: "Full trace" }).click();
  await expect(span).toHaveText(whole ?? "");
  const box = (await traces.boundingBox())!;
  await page.mouse.move(box.x + 400, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 600, box.y + 10, { steps: 4 });
  await page.mouse.up();
  await expect(span).not.toHaveText(whole ?? "");
  await expect(page.locator(".cursor-label")).toHaveText("A 5 ns");
  await page.getByRole("button", { name: "Full trace" }).click();
  // A radix and a divider belong to the saved trace list.
  await waveScroll.evaluate((element) => {
    element.scrollTop = 0;
  });
  const bus = await page
    .locator(".wave-name")
    .filter({ hasText: "[3:0]" })
    .first()
    .getAttribute("title");
  const row = page.locator(`.wave-name[title="${bus}"]`).first();
  await row.click({ button: "right" });
  await page.getByLabel("Radix of this trace").selectOption("bin");
  await page.getByRole("menuitem", { name: "Add divider above" }).click();
  await page.getByLabel("Divider name").fill("Counters");
  await page.getByLabel("Divider name").press("Enter");
  await expect(page.locator(".wave-name.divider")).toHaveText("×Counters");
  await expect(row.locator("output")).toHaveText(/^[01]{4}$/);
  // Keys act on the selected row; a row is also moved by dragging its name.
  const firstName = page.locator(".wave-name").first();
  await clock.click();
  await expect(firstName).toHaveAttribute("title", /dut\.clk$/);
  // Either cursor follows the pointer along the ruler; B is put on A to measure from it.
  const rulerBox = (await ruler.boundingBox())!;
  const at = (ns: number) =>
    rulerBox.x + 240 + ((rulerBox.width - 240) * ns) / 132;
  await page.getByRole("button", { name: "Set B" }).click();
  await expect(page.locator(".delta-label")).toHaveText("B 5 ns");
  await expect(page.locator(".wave-toolbar .delta")).toHaveText("Δ 0");
  await page.mouse.move(at(5) + 2, rulerBox.y + 6);
  await page.mouse.down();
  await page.mouse.move(at(66), rulerBox.y + 6, { steps: 4 });
  await expect(page.locator(".cursor-label")).not.toHaveText("A 5 ns");
  await page.mouse.move(at(7), rulerBox.y + 6, { steps: 4 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Previous edge" }).click();
  await expect(page.locator(".cursor-label")).toHaveText("A 5 ns");
  await page.getByRole("button", { name: "Next edge" }).click();
  await expect(page.locator(".wave-toolbar .delta")).toHaveText(
    "Δ 5 ns · 200 MHz",
  );
  await page.getByRole("button", { name: "Previous edge" }).click();
  // The edge buttons move whichever cursor was chosen last.
  await page.locator(".delta-label").click();
  await page.getByRole("button", { name: "Next edge" }).click();
  await expect(page.locator(".delta-label")).toHaveText("B 10 ns");
  await expect(page.locator(".cursor-label")).toHaveText("A 5 ns");
  await page.locator(".cursor-label").click();
  await clock.click();
  await page.keyboard.press("Alt+ArrowDown");
  await expect(firstName).not.toHaveAttribute("title", /dut\.clk$/);
  const from = (await clock.boundingBox())!;
  const to = (await firstName.boundingBox())!;
  await page.mouse.move(from.x + 120, from.y + 15);
  await page.mouse.down();
  await page.mouse.move(to.x + 120, to.y + 5, { steps: 5 });
  await page.mouse.up();
  await expect(firstName).toHaveAttribute("title", /dut\.clk$/);
  await waveSplitter.focus();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowUp");
  await expect(waveSplitter).toHaveAttribute("aria-valuenow", "65");
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
  expect(await waveSplitter.getAttribute("aria-valuenow")).toBe(
    await waveSplitter.getAttribute("aria-valuemin"),
  );
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.screenshot({
    path: resolve("test-results/workspace.png"),
    fullPage: true,
  });
  await page.reload();
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".project-title")).toContainText("counter");
  await expect(page.locator(".wave-panel")).toBeVisible({
    timeout: 15000,
  });
  // The list comes back as it was left, expanded rows included.
  await expect(row).toBeVisible();
  await expect(
    page.getByRole("separator", { name: "Bottom panel height" }),
  ).toHaveAttribute("aria-valuenow", "35");
  await expect(page.locator(".wave-name.divider")).toHaveText("×Counters");
  await expect(page.locator(".cursor-label")).toHaveText("A 5 ns");
  await expect(row.locator("output")).toHaveText(/^[01]{4}$/);
  await page.getByRole("button", { name: "Close waveform session" }).click();
  await expect(page.locator(".wave-panel")).toBeHidden();
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
  await page.getByLabel("Design top module", { exact: true }).fill("top");
  await page.getByRole("button", { name: "OK" }).click();
  await expect(
    page.getByRole("dialog", { name: "Project Settings" }),
  ).toBeHidden();
  await finishImport(page);
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Simulation", exact: true }).click();
  await page
    .getByRole("button", { name: "Add Simulation Configuration", exact: true })
    .click();
  await page.getByLabel("Testbench top module", { exact: true }).fill("tb");
  await page.getByLabel("DUT instance path", { exact: true }).fill("tb.dut");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Project Settings" }),
  ).toBeHidden();
  await page.getByRole("button", { name: "Build schematic" }).click();
  await page
    .getByRole("dialog", { name: "Unsaved changes" })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(page.getByLabel("Schematic", { exact: true })).toBeHidden();
  await page.getByRole("button", { name: "Build schematic" }).click();
  await page
    .getByRole("button", { name: "Save All and Build", exact: true })
    .click();
  await expect(page.locator(".nodebox").first()).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.locator(".wave-panel")).toBeVisible({
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
  chosen = [resolve("tests/fixtures/counter/hdlview.project.json")];
  await fileCommand(page, "Open Existing Project…");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(editor).toContainText("// dirty tab");
  await page.keyboard.press("Control+Shift+s");
  await expect
    .poll(() => readFileSync(join(rtl, "top.sv"), "utf8"))
    .toContain("// dirty tab");
  await page.getByRole("button", { name: "Design", exact: true }).click();
  await page.getByRole("button", { name: "child", exact: true }).click();
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await page.getByRole("button", { name: "View source", exact: true }).click();
  await expect(editor).toContainText("module top");
  await expect(editor).not.toContainText("// editor change");
  await expect(
    page.getByText("Captured source · read-only", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open Working File" }).click();
  await expect(editor).toContainText("// dirty tab");
  await expect(page.locator(".wave-panel")).toBeVisible();
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
    .locator('[data-source-path="@RTL_sources/."]')
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
  await page.getByLabel("Design top module", { exact: true }).fill("top");
  await page
    .getByRole("dialog", { name: "Project Settings" })
    .getByRole("button", { name: "Sources", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Move lists/types.sv down", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Move lists/types.sv up", exact: true })
    .click();
  await page.getByRole("button", { name: "OK" }).click();
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
  await expect(page.getByLabel("Schematic", { exact: true })).toBeVisible({
    timeout: 30000,
  });
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

test("open a project and preserve the workspace when opening fails or is cancelled", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "hdlview open "));
  const config = join(directory, "hdlview.project.json");
  writeFileSync(join(directory, "top.v"), "module top; endmodule\n");
  writeFileSync(
    config,
    JSON.stringify({
      schema_version: 3,
      name: "First project",
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
  await expect(page.locator(".project-title")).toContainText("First project");
  await page.locator('.source-file[title="top.v"]').click();
  await expect(page.locator(".cm-content")).toContainText("module top");
  const unsupported = join(directory, "older.json");
  const unsupportedText = JSON.stringify({
    schema_version: 2,
    name: "Unsupported",
    top: "",
    sources: [],
  });
  writeFileSync(unsupported, unsupportedText);
  chosen = [unsupported];
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".error-banner")).toContainText(
    "Unsupported project schema 2",
  );
  await expect(page.locator(".project-title")).toContainText("First project");
  expect(readFileSync(unsupported, "utf8")).toBe(unsupportedText);
  const invalid = join(directory, "invalid.json");
  writeFileSync(invalid, '{"name":"bad"}');
  chosen = [invalid];
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".error-banner")).toContainText("missing field");
  await expect(page.locator(".project-title")).toContainText("First project");
  await expect(page.locator(".cm-content")).toContainText("module top");
  await page.getByRole("button", { name: "Dismiss", exact: true }).click();
  chosen = null;
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".project-title")).toContainText("First project");
  const other = join(directory, "other");
  mkdirSync(other);
  writeFileSync(join(other, "top.v"), "module second; endmodule\n");
  writeFileSync(
    join(other, "hdlview.project.json"),
    JSON.stringify({
      schema_version: 3,
      name: "Other project",
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
  for (const [group, file] of [
    ["Design Sources", "design.sv"],
    ["Simulation Sources", "tb.sv"],
    ["Simulation Sources", "gate_tb.sv"],
  ]) {
    await expect(
      page.locator(
        `.source-row[data-source-group="${group === "Design Sources" ? "design" : "simulation"}"] .source-file[title="inputs/${file}"]`,
      ),
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
        schema_version: 3,
        name: `Project ${name}`,
        technology: name === "a" ? "sky130" : "ihp_sg13g2",
        top: "top",
        sources: [{ path: "top.sv", language: "system_verilog" }],
        simulation_sources: ["tb.sv"],
        simulations: {
          rtl: {
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
  const currentProfile = { ...profile, timeout_seconds: 1234 };
  await page.getByRole("button", { name: "Toolchain", exact: true }).click();
  await page.getByLabel("Toolchain input").fill(JSON.stringify(currentProfile));
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const expectCurrentToolchain = async () => {
    await page.getByRole("button", { name: "Toolchain", exact: true }).click();
    expect(
      JSON.parse(await page.getByLabel("Toolchain input").inputValue()),
    ).toEqual(currentProfile);
    await page
      .locator(".modal-heading")
      .getByRole("button", { name: "×" })
      .click();
  };
  chosen = [paths.a];
  await fileCommand(page, "Open Existing Project…");
  await expect(
    page.locator(".wave-name").filter({ hasText: "a_count" }),
  ).toBeVisible({ timeout: 30000 });
  await expect(
    page.locator(".wave-name").filter({ hasText: "b_count" }),
  ).toHaveCount(0);
  await expect(page.locator(".cursor-label")).toHaveText("A 0");
  await expect(page.locator(".editor-tabs button")).toHaveCount(0);
  await expectCurrentToolchain();
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
  await expectCurrentToolchain();
  await page.screenshot({
    path: resolve("test-results/file-menu-workspace.png"),
    fullPage: true,
  });
});

test("a testbench configuration runs on RTL unchanged and offers no timing run", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "hdlview shared testbench "));
  for (const file of ["counter.sv", "tb.sv"])
    writeFileSync(
      join(directory, file),
      readFileSync(resolve("tests/fixtures/counter", file)),
    );
  const config = join(directory, "hdlview.project.json");
  writeFileSync(
    config,
    JSON.stringify({
      schema_version: 3,
      name: "Shared testbench",
      top: "counter",
      sources: [{ path: "counter.sv", language: "system_verilog" }],
      simulation_sources: ["tb.sv"],
      simulations: {
        shared: {
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
  await page
    .getByRole("button", { name: "Elaborated RTL", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Build schematic", exact: true })
    .click();
  await expect(page.getByLabel("Schematic", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByRole("button", { name: "Run simulation" }),
  ).toBeEnabled({ timeout: 30000 });
  await expect(page.getByLabel("Simulation configuration")).toHaveValue(
    "shared",
  );
  await expect(
    page.getByRole("option", { name: "timing", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.locator(".wave-panel")).toBeVisible({
    timeout: 30000,
  });
  await expect(page.locator(".error-banner")).toBeHidden();
  await page
    .getByRole("button", { name: "Close waveform session", exact: true })
    .click();
  expect(readFileSync(join(directory, "tb.sv"))).toEqual(originalTestbench);
});

test("live lint checks unsaved buffers, navigation, contexts, and local settings", async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), "hdlview live lint "));
  const config = join(directory, "hdlview.project.json");
  const top =
    '`include "defs.svh"\nmodule top(input logic [`WIDTH-1:0] a, output logic [`WIDTH-1:0] y);\nassign y=a;\nendmodule\n';
  const tb =
    "module tb; reg [3:0] a=0; wire [3:0] y; top dut(.a(a), .y(y)); initial begin a=`MODE; #1 $finish; end endmodule\n";
  writeFileSync(join(directory, "top.sv"), top);
  writeFileSync(join(directory, "defs.svh"), "`define WIDTH 4\n");
  writeFileSync(join(directory, "tb.sv"), tb);
  writeFileSync(join(directory, "auxiliary.sv"), "not valid HDL  ");
  writeFileSync(
    config,
    JSON.stringify({
      schema_version: 3,
      name: "Live lint",
      standard: "1800-2017",
      top: "top",
      sources: [{ path: "top.sv", language: "system_verilog" }],
      headers: ["defs.svh"],
      simulation_sources: ["tb.sv"],
      assets: ["auxiliary.sv"],
      simulations: Object.fromEntries(
        ["good", "bad"].map((name) => [
          name,
          {
            simulator: "icarus",
            top: "tb",
            dut_scope: ["tb", "dut"],
            testbench: ["tb.sv"],
            defines: { MODE: name === "good" ? "1" : "missing_mode" },
          },
        ]),
      ),
    }),
  );
  const originalConfig = readFileSync(config);
  let lintCalls = 0;
  let holdLintResult = false;
  let heldLintResult: (() => void) | undefined;
  const calls: string[] = [];
  await page.exposeFunction(
    "__HDLVIEW_TEST_API__",
    (action: string, args: unknown) =>
      new Promise((resolve, reject) => {
        calls.push(action);
        if (action === "lint") lintCalls++;
        pending.push((value: unknown) => {
          const reply = value as {
            ok: boolean;
            result: unknown;
            error: string;
          };
          const job = reply.result as { kind?: string; status?: string } | null;
          if (
            reply.ok &&
            action === "job" &&
            job?.kind === "lint" &&
            job.status === "complete" &&
            holdLintResult
          )
            heldLintResult = () => resolve(reply.result);
          else
            reply.ok ? resolve(reply.result) : reject(new Error(reply.error));
        });
        backend.stdin.write(JSON.stringify({ action, args }) + "\n");
      }),
  );
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
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await fileCommand(page, "Open Existing Project…");
  await page.locator('.source-file[data-source-path="auxiliary.sv"]').click();
  await expect(page.locator(".cm-content")).toContainText("not valid HDL");
  await expect(page.getByLabel("Editor lint status")).toBeHidden();
  await page
    .getByRole("button", { name: "Build schematic", exact: true })
    .click();
  await expect(page.getByLabel("Schematic", { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.locator('.source-file[data-source-path="top.sv"]').click();
  const content = page.locator(".cm-content");
  const replace = async (text: string) => {
    await content.click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText(text);
  };
  await expect(page.getByLabel("Editor lint status")).toContainText("Checked", {
    timeout: 15000,
  });
  await page.getByRole("button", { name: "Toolchain", exact: true }).click();
  expect(
    JSON.parse(await page.getByLabel("Toolchain input").inputValue()),
  ).toEqual(profile);
  await page
    .locator(".modal-heading")
    .getByRole("button", { name: "×" })
    .click();
  const checks = lintCalls;
  const started = Date.now();
  await replace(
    top.replace("assign y=a;", "assign y=a; // é😀\nassign y=unknown;  "),
  );
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(1, {
    timeout: 15000,
  });
  const diagnosticMilliseconds = Date.now() - started;
  console.log(
    `live lint feedback (${profile.provider}): ${diagnosticMilliseconds} ms`,
  );
  expect(lintCalls - checks).toBeLessThanOrEqual(2);
  expect(readFileSync(join(directory, "top.sv"), "utf8")).toBe(top);
  expect(readFileSync(config)).toEqual(originalConfig);
  await expect(page.getByText("Sources changed · rebuild needed")).toHaveCount(
    0,
  );
  await page.getByRole("tab", { name: /^Problems / }).click();
  const problems = page.getByLabel("Editor problems");
  await expect(problems).toContainText("unknown");
  await expect(problems).toContainText("no-trailing-spaces");
  await problems
    .getByRole("button", { name: /use of undeclared identifier 'unknown'/ })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.getSelection()?.toString()))
    .toBe("unknown");
  await page.keyboard.press("F8");
  await page.keyboard.press("Shift+F8");
  await replace(top.replace("assign y=a;", "assign y=a"));
  await expect(problems).toContainText("expected ';'", { timeout: 15000 });
  await expect(page.getByLabel("Editor lint status")).toHaveText(
    "Style checks incomplete",
  );
  await expect(page.locator(".cm-lintPoint-error")).toHaveCount(1);
  await expect(page.locator(".cm-lint-marker-error").first()).toBeVisible();
  const unavailableProfile = {
    ...profile,
    executables: {
      ...profile.executables,
      python3: "/hdlview/missing/python3",
    },
  };
  await page.getByRole("button", { name: "Toolchain", exact: true }).click();
  await page
    .getByLabel("Toolchain input")
    .fill(JSON.stringify(unavailableProfile));
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByLabel("Editor lint status")).toContainText(
    "Correctness checks unavailable",
    { timeout: 15000 },
  );
  await expect(problems).toContainText("slang:");
  await page.getByRole("button", { name: "Toolchain", exact: true }).click();
  await page.getByLabel("Toolchain input").fill(JSON.stringify(profile));
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(problems).toContainText("expected ';'", { timeout: 15000 });
  await expect(page.getByLabel("Editor lint status")).toHaveText(
    "Style checks incomplete",
  );
  // Hold a completed real-tool response across an edit to exercise stale-result rejection.
  holdLintResult = true;
  await replace(top.replace("assign y=a;", "assign y=stale_identifier;"));
  await expect.poll(() => !!heldLintResult, { timeout: 15000 }).toBe(true);
  await replace(top);
  await expect(page.locator(".cm-lintRange-error")).toHaveCount(0);
  holdLintResult = false;
  if (!heldLintResult) throw new Error("Expected held editor lint result");
  heldLintResult();
  await expect(page.getByLabel("Editor lint status")).toContainText("Checked", {
    timeout: 15000,
  });
  await content.click();
  await page.keyboard.press("Control+z");
  await expect(content).toContainText("stale_identifier");
  await page.keyboard.press("Control+Shift+z");
  await expect(content).not.toContainText("stale_identifier");
  await page.locator('.source-file[data-source-path="defs.svh"]').click();
  await replace("`define WIDTH 8\n");
  await page.locator('.source-file[data-source-path="top.sv"]').click();
  await replace(
    top.replace("output logic [`WIDTH-1:0] y", "output logic [3:0] y"),
  );
  await expect(page.getByLabel("Editor lint status")).toContainText("Checked", {
    timeout: 15000,
  });
  await expect(problems).toContainText("trunc");
  await page.locator('.source-file[data-source-path="tb.sv"]').click();
  await page.getByLabel("Lint simulation configuration").selectOption("bad");
  await expect(problems).toContainText("missing_mode", { timeout: 15000 });
  await page.getByLabel("Lint simulation configuration").selectOption("good");
  await expect(page.getByLabel("Editor lint status")).toContainText(
    "Limited analysis",
    {
      timeout: 15000,
    },
  );
  await expect(problems).not.toContainText("missing_mode");
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await page.getByLabel("Live linting", { exact: true }).uncheck();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByLabel("Editor lint status")).toContainText(
    "Lint disabled",
  );
  expect(readFileSync(config)).toEqual(originalConfig);
  await fileCommand(page, "Close Project");
  await page
    .getByRole("dialog", { name: "Unsaved changes" })
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await expect(page.getByLabel("RTL editor")).toBeHidden();
  await fileCommand(page, "Open Existing Project…");
  await page.locator('.source-file[data-source-path="top.sv"]').click();
  await expect(page.getByLabel("Editor lint status")).toContainText(
    "Lint disabled",
  );
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  await page.getByLabel("Live linting", { exact: true }).check();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(page.getByLabel("Editor lint status")).toContainText("Checked", {
    timeout: 15000,
  });
  await expect(page.getByText("Sources changed · rebuild needed")).toHaveCount(
    0,
  );
  expect(calls.filter((action) => action === "build")).toHaveLength(1);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: "test-results/live-editor-lint.png",
    fullPage: true,
  });
});

async function connectProjectFiles(page: Page) {
  const directory = mkdtempSync(join(resolve("target"), "hdlview new files "));
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
  let holdRead: (() => Promise<void>) | undefined;
  await page.exposeFunction(
    "__HDLVIEW_TEST_API__",
    async (action: string, args: unknown) => {
      const result = await rpc(action, args);
      if (action === "read_document" && holdRead) await holdRead();
      return result;
    },
  );
  if (process.env.HDLVIEW_TOOL_PROFILE) {
    const profile = JSON.parse(
      readFileSync(process.env.HDLVIEW_TOOL_PROFILE, "utf8"),
    );
    await page.addInitScript(
      (profile) =>
        localStorage.setItem("hdlview-profile", JSON.stringify(profile)),
      profile,
    );
  }
  await page.goto("/");
  await fileCommand(page, "Create New Project…");
  await page
    .getByLabel("Project name", { exact: true })
    .fill("New working files");
  await page
    .getByRole("button", { name: "Choose Directory", exact: true })
    .click();
  await page.getByLabel("Technology", { exact: true }).selectOption("sky130");
  await page
    .getByRole("button", { name: "Next: Sources", exact: true })
    .click();
  await finishWizard(page);
  return {
    directory,
    config: join(directory, "hdlview.project.json"),
    choose: (paths: string[] | null) => {
      chosen = paths;
    },
    rpc,
    holdRead: (handler?: () => Promise<void>) => {
      holdRead = handler;
    },
  };
}
async function sourceCommand(page: Page, path: string, command: string) {
  await page
    .locator(`[role="treeitem"][data-source-path="${path}"]`)
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: command, exact: true }).click();
}
async function newSource(page: Page, name: string, group = "design") {
  await fileCommand(page, "New File…");
  await page
    .getByLabel("New entry source group", { exact: true })
    .selectOption(group);
  await page.getByLabel("File name", { exact: true }).fill(name);
  await page.getByRole("button", { name: "Create File", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "New File", exact: true }),
  ).toBeHidden();
}
test("import review keeps file paths readable and controls within each row", async ({
  page,
}) => {
  const { directory, config, choose } = await connectProjectFiles(page);
  const sourceDirectory = join(directory, "RTL files", "nested sources");
  mkdirSync(sourceDirectory, { recursive: true });
  const names = [
    "counter.sv",
    "counter_with_a_long_filename_for_import_review_and_nested_directory_paths.sv",
  ];
  for (const name of names)
    writeFileSync(join(sourceDirectory, name), "module counter; endmodule\n");
  choose(names.map((name) => join(sourceDirectory, name)));
  await fileCommand(page, "Add New Files…");
  await page.getByRole("button", { name: "Select Files", exact: true }).click();
  const review = page.getByRole("dialog", { name: "Import Review" });
  await expect(review).toBeVisible();
  const entries = review.locator(".import-entries");
  await expect(entries.getByRole("checkbox")).toHaveCount(2);
  for (const width of [1500, 900, 560]) {
    await page.setViewportSize({ width, height: 800 });
    const layout = await entries.evaluate((element) => ({
      overflow: element.scrollWidth > element.clientWidth,
      rows: Array.from(element.children, (row) => {
        const checkbox = row.querySelector("input");
        const path = row.querySelector("span");
        const role = row.querySelector("select");
        if (!checkbox || !path || !role)
          throw new Error("Missing import review controls");
        return {
          checkboxWidth: checkbox.getBoundingClientRect().width,
          pathWidth: path.getBoundingClientRect().width,
          roleWidth: role.getBoundingClientRect().width,
          height: row.getBoundingClientRect().height,
          roleHeight: role.getBoundingClientRect().height,
        };
      }),
    }));
    expect(layout.overflow).toBe(false);
    for (const row of layout.rows) {
      expect(row.pathWidth).toBeGreaterThan(row.checkboxWidth * 5);
      expect(row.height).toBeLessThan(row.roleHeight * 4);
      if (width >= 900) expect(row.pathWidth).toBeGreaterThan(row.roleWidth);
    }
    await review.screenshot({
      path: resolve(`test-results/import-review-${width}.png`),
    });
  }
  await entries.getByRole("checkbox").first().uncheck();
  await entries.getByRole("combobox").last().selectOption("simulation");
  await review
    .getByRole("button", { name: "Apply Import", exact: true })
    .click();
  await finishImport(page);
  await fileCommand(page, "Save Project");
  await expect
    .poll(
      () => JSON.parse(readFileSync(config, "utf8")).simulation_sources.length,
    )
    .toBe(1);
  expect(JSON.parse(readFileSync(config, "utf8")).sources).toEqual([]);
});
test("source explorer creates, renames and removes working entries without losing editor history", async ({
  page,
}) => {
  const { directory, config, choose, holdRead } =
    await connectProjectFiles(page);
  await page.keyboard.press("Control+n");
  await expect(
    page.getByRole("dialog", { name: "New File", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(existsSync(join(directory, "rtl"))).toBe(false);
  await newSource(page, "top.sv");
  expect(readFileSync(join(directory, "rtl/top.sv"), "utf8")).toBe("");
  expect(JSON.parse(readFileSync(config, "utf8")).sources).toEqual([]);
  const editor = page.locator(".source-editor .cm-content");
  await expect(editor).toBeFocused();
  const source =
    "module top(input logic a, output logic y); assign y = ~a; endmodule\n";
  await editor.fill(source);
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => readFileSync(join(directory, "rtl/top.sv"), "utf8"))
    .toBe(source);
  await editor.press("End");
  await editor.press("Control+End");
  await editor.press("x");
  const dirtyText = await editor.innerText();
  await page
    .locator('[role="treeitem"][data-source-path="rtl/top.sv"]')
    .focus();
  await page.keyboard.press("F2");
  await page.getByLabel("File name", { exact: true }).fill("renamed.sv");
  await page
    .getByRole("button", { name: "Review Rename", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Review Rename", exact: true })
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Review Rename", exact: true }),
  ).toBeHidden();
  expect(existsSync(join(directory, "rtl/top.sv"))).toBe(false);
  expect(readFileSync(join(directory, "rtl/renamed.sv"), "utf8")).toBe(source);
  await expect.poll(() => editor.innerText()).toBe(dirtyText);
  await page
    .locator('[role="treeitem"][data-source-path="rtl/renamed.sv"]')
    .click();
  await expect(page.locator(".editor-tabs > div")).toHaveCount(1);
  await newSource(page, "top.sv");
  await expect(editor).toHaveText("");
  await expect(page.locator(".editor-tabs > div")).toHaveCount(2);
  await page.locator('[data-source-path="rtl/renamed.sv"]').click();
  await expect.poll(() => editor.innerText()).toBe(dirtyText);
  await page
    .getByRole("button", { name: "Close rtl/top.sv", exact: true })
    .click();
  await editor.press("Control+z");
  await expect.poll(() => editor.innerText()).not.toBe(dirtyText);
  await newSource(page, "defs.svh", "simulation");
  await expect(
    page.locator(
      '.source-row[data-source-group="simulation"] [data-source-path="sim/defs.svh"]',
    ),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "New folder in Design Sources", exact: true })
    .click();
  await page.getByLabel("Folder name", { exact: true }).fill("empty folder");
  await page
    .getByRole("button", { name: "Create Folder", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "New Folder", exact: true }),
  ).toBeHidden();
  await sourceCommand(page, "rtl/empty folder", "Rename…");
  await page.getByLabel("File name", { exact: true }).fill("renamed folder");
  await page
    .getByRole("button", { name: "Review Rename", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Review Rename", exact: true })
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await expect(
    page.locator('[data-source-path="rtl/renamed folder"]'),
  ).toBeVisible();
  await page.keyboard.press("Control+Shift+s");
  await expect(page.locator(".project-title")).not.toContainText("*");
  const stored = JSON.parse(readFileSync(config, "utf8"));
  expect(stored.sources[0].path).toBe("rtl/renamed.sv");
  expect(stored.simulation_headers).toEqual(["sim/defs.svh"]);
  await fileCommand(page, "Close Project");
  choose([config]);
  await fileCommand(page, "Open Existing Project…");
  await expect(
    page.locator('[data-source-path="rtl/renamed folder"]'),
  ).toBeVisible();
  // A read completed before rename must not reopen an obsolete working-file reference.
  let releaseRead: (() => void) | undefined;
  holdRead(
    () =>
      new Promise<void>((resolve) => {
        releaseRead = resolve;
      }),
  );
  await page.locator('[data-source-path="rtl/renamed.sv"]').click();
  await expect.poll(() => Boolean(releaseRead)).toBe(true);
  await sourceCommand(page, "rtl/renamed.sv", "Rename…");
  await page.getByLabel("File name", { exact: true }).fill("late.sv");
  await page
    .getByRole("button", { name: "Review Rename", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Review Rename", exact: true })
    .getByRole("button", { name: "Rename", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Review Rename" }),
  ).toBeHidden();
  releaseRead?.();
  holdRead();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(page.locator(".editor-tabs > div")).toHaveCount(0);
  await sourceCommand(page, "rtl/late.sv", "Remove from Project…");
  await page
    .getByRole("dialog", { name: "Remove from Project", exact: true })
    .getByRole("button", { name: "Remove from Project", exact: true })
    .click();
  await expect(page.locator('[data-source-path="rtl/late.sv"]')).toHaveCount(0);
  expect(existsSync(join(directory, "rtl/late.sv"))).toBe(true);
});

test("source explorer builds new files, preserves captured sources and validates real Trash", async ({
  page,
}) => {
  const { directory, config, rpc } = await connectProjectFiles(page);
  await newSource(page, "top.sv");
  const editor = page.locator(".source-editor .cm-content");
  await editor.fill(
    "module top(input logic a, output logic y); assign y = ~a; endmodule\n",
  );
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await page.getByLabel("Design top module", { exact: true }).fill("top");
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Project Settings", exact: true }),
  ).toBeHidden();
  await page.keyboard.press("Control+Shift+s");
  await expect(page.locator(".project-title")).not.toContainText("*");
  await page
    .getByRole("button", { name: "Build schematic", exact: true })
    .click();
  await expect(page.getByLabel("Schematic", { exact: true })).toBeVisible({
    timeout: 40_000,
  });
  await expect
    .poll(async () =>
      Boolean(
        (
          (await rpc("restore_project_state", { path: config })) as {
            snapshot?: unknown;
          }
        ).snapshot,
      ),
    )
    .toBe(true);
  const state = (await rpc("restore_project_state", { path: config })) as {
    snapshot: { id: string; directory: string };
  };
  const captured = readFileSync(
    join(state.snapshot.directory, "inputs/rtl/top.sv"),
    "utf8",
  );
  await newSource(page, "dispose.sv");
  await editor.fill("module broken; assign x = missing endmodule\n");
  await expect
    .poll(() => page.locator(".cm-lint-marker-error").count())
    .toBeGreaterThan(0);
  await sourceCommand(page, "rtl/dispose.sv", "Move to Trash…");
  await page
    .getByRole("dialog", { name: "Move to Trash", exact: true })
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Unsaved changes", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Unsaved changes", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  expect(existsSync(join(directory, "rtl/dispose.sv"))).toBe(true);
  await page
    .getByRole("dialog", { name: "Move to Trash", exact: true })
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Unsaved changes", exact: true })
    .getByRole("button", { name: "Discard", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Move to Trash", exact: true }),
  ).toBeHidden();
  expect(existsSync(join(directory, "rtl/dispose.sv"))).toBe(false);
  expect(
    readFileSync(join(state.snapshot.directory, "inputs/rtl/top.sv"), "utf8"),
  ).toBe(captured);
  await expect(
    page.getByText("Sources changed · rebuild needed", { exact: true }),
  ).toBeVisible();
  await sourceCommand(page, "rtl", "Move to Trash…");
  await expect(
    page.getByRole("dialog", { name: "Move to Trash", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("dialog", { name: "Move to Trash", exact: true })
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Move to Trash", exact: true }),
  ).toBeHidden();
  writeFileSync(join(directory, "rtl", ".unregistered"), "keep");
  await sourceCommand(page, "rtl", "Move to Trash…");
  await expect(page.getByRole("alert")).toContainText(".unregistered");
  await expect(
    page
      .getByRole("dialog", { name: "Move to Trash", exact: true })
      .getByRole("button", { name: "Move to Trash", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "New folder in Design Sources", exact: true })
    .click();
  await page.getByLabel("Folder name", { exact: true }).fill("disposable");
  await page
    .getByRole("button", { name: "Create Folder", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "New Folder" })).toBeHidden();
  await sourceCommand(page, "rtl/disposable", "New File…");
  await expect(page.getByLabel("Destination directory")).toHaveValue(
    join(directory, "rtl/disposable"),
  );
  await page.getByLabel("File name", { exact: true }).fill("nested.sv");
  await page.getByRole("button", { name: "Create File", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "New File" })).toBeHidden();
  expect(
    readFileSync(join(directory, "rtl/disposable/nested.sv"), "utf8"),
  ).toBe("");
  await sourceCommand(page, "rtl/disposable", "Move to Trash…");
  const trash = page.getByRole("dialog", {
    name: "Move to Trash",
    exact: true,
  });
  await expect(trash).toContainText("rtl/disposable/nested.sv");
  await trash
    .getByRole("button", { name: "Move to Trash", exact: true })
    .click();
  await expect(trash).toBeHidden();
  expect(existsSync(join(directory, "rtl/disposable"))).toBe(false);
});

test("project settings configure simulations without JSON and preserve drafts through imports", async ({
  page,
}) => {
  const app = await connectProjectFiles(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const rtl = join(app.directory, "RTL with spaces");
  const external = mkdtempSync(join(tmpdir(), "hdlview settings inputs "));
  mkdirSync(rtl);
  writeFileSync(
    join(rtl, "counter.sv"),
    readFileSync("tests/fixtures/counter/counter.sv"),
  );
  writeFileSync(
    join(external, "tb.sv"),
    readFileSync("tests/fixtures/counter/tb.sv"),
  );
  writeFileSync(join(external, "model.v"), "module unused_model; endmodule\n");
  writeFileSync(
    join(external, "timing.sdc"),
    "create_clock -period 10 [get_ports clk]\n",
  );
  const savedInitially = readFileSync(app.config, "utf8");
  await expect(
    page.getByRole("button", { name: "Configure Simulation…", exact: true }),
  ).toBeVisible();
  app.choose([join(rtl, "counter.sv")]);
  await fileCommand(page, "Add New Files…");
  await page.getByRole("button", { name: "Select Files", exact: true }).click();
  await page.getByRole("button", { name: "Apply Import", exact: true }).click();
  await finishImport(page);
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: "Project Settings",
    exact: true,
  });
  const section = (name: string) =>
    settings
      .getByRole("navigation", { name: "Settings sections" })
      .getByRole("button", { name, exact: true })
      .click();
  await settings
    .getByLabel("Project name", { exact: true })
    .fill("Configured counter");
  await settings
    .getByLabel("Design top module", { exact: true })
    .fill("counter");
  await settings
    .getByLabel("Technology", { exact: true })
    .selectOption("ihp_sg13g2");
  await expect(settings).toContainText("Technology-specific models");
  await section("Simulation");
  await settings
    .getByRole("button", { name: "Add Simulation Configuration", exact: true })
    .click();
  await settings.getByLabel("Testbench top module", { exact: true }).fill("tb");
  await settings
    .getByLabel("DUT instance path", { exact: true })
    .fill("wrong.dut");
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(settings.getByRole("alert")).toContainText(
    "begin with the testbench top",
  );
  await expect(
    settings.getByLabel("DUT instance path", { exact: true }),
  ).toBeFocused();
  await settings
    .getByLabel("DUT instance path", { exact: true })
    .fill("tb.dut");
  app.choose([join(external, "tb.sv")]);
  await settings
    .getByRole("button", { name: "Add Simulation Sources…", exact: true })
    .click();
  await page.getByRole("button", { name: "Select Files", exact: true }).click();
  await page.getByRole("button", { name: "Apply Import", exact: true }).click();
  await finishImport(page);
  await expect(
    settings.getByLabel("Testbench top module", { exact: true }),
  ).toHaveValue("tb");
  await expect(
    settings.getByLabel("DUT instance path", { exact: true }),
  ).toHaveValue("tb.dut");
  await settings
    .getByRole("checkbox", { name: /Use testbench .*tb.sv/ })
    .check();
  await settings
    .getByText("Advanced simulation settings", { exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Add runtime argument", exact: true })
    .click();
  await settings
    .getByLabel("Runtime argument 1", { exact: true })
    .fill("+seed=1");
  app.choose([join(external, "model.v")]);
  await settings
    .getByRole("button", { name: "Browse Gate model files…", exact: true })
    .click();
  await expect(
    settings.getByLabel("Gate model files path 1", { exact: true }),
  ).toHaveValue(/model.v$/);
  await settings
    .getByRole("button", { name: "Duplicate Configuration", exact: true })
    .click();
  await settings
    .getByLabel("Configuration name", { exact: true })
    .fill("timing");
  await settings
    .getByRole("button", { name: "Rename Configuration", exact: true })
    .click();
  await settings
    .getByLabel("SDF source", { exact: true })
    .selectOption("external");
  await expect(settings.getByLabel("SDF file", { exact: true })).toBeVisible();
  writeFileSync(join(external, "delay.sdf"), "(DELAYFILE)\n");
  app.choose([join(external, "delay.sdf")]);
  await settings
    .getByRole("button", { name: "Browse SDF…", exact: true })
    .click();
  await expect(settings.getByLabel("SDF file", { exact: true })).toHaveValue(
    /delay.sdf$/,
  );
  await settings
    .getByLabel("SDF source", { exact: true })
    .selectOption("snapshot");
  await settings
    .getByLabel("Timing corner", { exact: true })
    .fill("qualified_corner");
  await settings
    .getByLabel("Delay selection", { exact: true })
    .selectOption("max");
  await settings
    .getByRole("button", { name: "Duplicate Configuration", exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Delete Configuration", exact: true })
    .click();
  await settings
    .getByLabel("Settings simulation configuration", { exact: true })
    .selectOption("default");
  await section("Physical Design");
  await expect(settings).toContainText("sg13g2_stdcell");
  await settings.getByLabel("Clock port", { exact: true }).fill("clk");
  await settings.getByLabel("Clock period (ns)", { exact: true }).fill("10");
  await settings.getByLabel("Core utilization (%)", { exact: true }).fill("25");
  await settings
    .getByLabel("Placement density (%)", { exact: true })
    .fill("35");
  app.choose([join(external, "timing.sdc")]);
  await settings
    .getByRole("button", { name: "Browse SDC…", exact: true })
    .click();
  await expect(settings.getByLabel("SDC file", { exact: true })).toHaveValue(
    /timing.sdc$/,
  );
  await settings
    .getByText("Advanced LibreLane overrides", { exact: true })
    .click();
  await settings
    .getByLabel("LibreLane overrides", { exact: true })
    .fill('{"CUSTOM": [1, 2]}');
  await section("General");
  await expect(
    settings.getByLabel("Design top module", { exact: true }),
  ).toHaveValue("counter");
  await expect(
    settings.getByLabel("Project name", { exact: true }),
  ).toHaveValue("Configured counter");
  await section("Sources");
  app.choose([external]);
  await settings
    .getByRole("button", { name: "Browse Include directories…", exact: true })
    .click();
  await expect(
    settings.getByLabel("Include directories path 1", { exact: true }),
  ).toHaveValue(/^@/);
  await settings
    .getByRole("button", { name: "Add Project defines", exact: true })
    .click();
  await settings
    .getByLabel("Project defines name 1", { exact: true })
    .fill("MODE");
  await settings
    .getByLabel("Project defines value 1", { exact: true })
    .fill("1");
  await settings
    .getByRole("button", { name: "Add Project defines", exact: true })
    .click();
  await settings
    .getByLabel("Project defines name 2", { exact: true })
    .fill("MODE");
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(settings.getByRole("alert")).toContainText("Duplicate name");
  await settings
    .getByRole("button", { name: "Remove Project defines row 2", exact: true })
    .click();
  await settings.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(settings.getByRole("alert")).toHaveCount(0);
  await expect(settings).toBeVisible();
  expect(readFileSync(app.config, "utf8")).toEqual(savedInitially);
  await section("General");
  await settings
    .getByLabel("Project name", { exact: true })
    .fill("Discarded name");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await expect(
    settings.getByLabel("Project name", { exact: true }),
  ).toHaveValue("Configured counter");
  await section("Editor");
  await settings.getByLabel("Live linting", { exact: true }).uncheck();
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await section("Editor");
  await expect(
    settings.getByLabel("Live linting", { exact: true }),
  ).toBeChecked();
  for (const width of [900, 560]) {
    await page.setViewportSize({ width, height: 800 });
    await expect(
      settings.getByRole("button", { name: "OK", exact: true }),
    ).toBeInViewport();
    expect(
      await settings.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: `test-results/settings-${width}.png` });
  }
  await page.setViewportSize({ width: 1500, height: 1000 });
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await fileCommand(page, "Save Project");
  await expect
    .poll(() => JSON.parse(readFileSync(app.config, "utf8")).name)
    .toBe("Configured counter");
  const saved = JSON.parse(readFileSync(app.config, "utf8"));
  expect(Object.keys(saved.simulations).sort()).toEqual(["default", "timing"]);
  expect(saved.simulations.default.dut_scope).toEqual(["tb", "dut"]);
  expect(saved.simulations.default.models).toHaveLength(1);
  expect(saved.physical.sdc).toBeDefined();
  expect(saved.physical.overrides).toEqual({
    FP_CORE_UTIL: 25,
    PL_TARGET_DENSITY_PCT: 35,
    CUSTOM: [1, 2],
  });
  await page.locator(".source-file").filter({ hasText: "tb.sv" }).click();
  await expect(page.getByLabel("Editor lint status")).toContainText(
    /Checked|Limited analysis/,
    { timeout: 15000 },
  );
  await page.getByRole("tab", { name: /^Problems/ }).click();
  await expect(page.getByLabel("Editor problems")).not.toContainText(
    "configure a top or select a simulation configuration",
  );
  await expect(
    page
      .getByLabel("Editor problems")
      .getByRole("button", { name: "Configure Simulation…", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Build schematic", exact: true })
    .click();
  await expect(page.locator(".nodebox").first()).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByRole("button", { name: "Run simulation" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.locator(".wave-panel")).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await section("Simulation");
  await settings.getByLabel("Simulation duration", { exact: true }).fill("2");
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(
    page.getByText("Rebuild required to use updated settings", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Run simulation" }),
  ).toBeDisabled();
  await expect(page.locator(".wave-panel")).toBeVisible();
  await fileCommand(page, "Save Project");
  await fileCommand(page, "Close Project");
  app.choose([app.config]);
  await fileCommand(page, "Open Existing Project…");
  await expect(page.locator(".wave-panel")).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.getByRole("button", { name: "Run simulation" }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  await section("Simulation");
  await expect(
    settings.getByLabel("Simulation duration", { exact: true }),
  ).toHaveValue("2");
  await settings
    .getByLabel("Settings simulation configuration", { exact: true })
    .selectOption("timing");
  await settings
    .getByText("Advanced simulation settings", { exact: true })
    .click();
  await expect(settings.getByLabel("SDF source", { exact: true })).toHaveValue(
    "snapshot",
  );
  await expect(
    settings.getByLabel("Timing corner", { exact: true }),
  ).toHaveValue("qualified_corner");
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(errors).toEqual([]);
});

test("professional symbols, group detail, themes and export preserve the bound workspace", async ({
  page,
}) => {
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
        pending.push((value: unknown) => {
          const r = value as { ok: boolean; result: unknown; error: string };
          r.ok ? resolve(r.result) : reject(new Error(r.error));
        });
        backend.stdin.write(JSON.stringify({ action, args }) + "\n");
      }),
  );
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => [
    resolve("tests/fixtures/schematic/hdlview.project.json"),
  ]);
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
  async function openStage(stage: string) {
    const label = { elaborated: "Elaborated RTL" }[stage];
    if (!label) throw new Error("Unknown test stage");
    await page.getByRole("button", { name: label, exact: true }).click();
    await page
      .getByRole("button", { name: "Build schematic", exact: true })
      .click();
    await expect(page.locator(".project-name small")).toContainText(label, {
      timeout: 40000,
    });
    await expect(page.locator(".nodebox").first()).toBeVisible();
    await expect(page.locator(".layout-indicator")).toBeHidden();
  }
  await page.goto("/");
  await fileCommand(page, "Open Existing Project…");
  await openStage("elaborated");
  await expect(page.locator('[data-symbol="register"]')).toHaveCount(2);
  await expect(page.locator('[data-symbol="memory"]')).toHaveCount(1);
  await expect(page.locator('[data-symbol="decoder"]')).toHaveCount(1);
  await expect(page.locator('[data-symbol="encoder"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  const workers = await page.evaluate(
    () => performance.getEntriesByName("hdlview-layout-worker").length,
  );
  await page.getByLabel("Canvas theme").selectOption("dark");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Display", exact: true }),
  ).toBeFocused();
  expect(
    await page.evaluate(
      () => performance.getEntriesByName("hdlview-layout-worker").length,
    ),
  ).toBe(workers);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export SVG" }).click();
  const exported = await download;
  const saved = await exported.path();
  expect(saved).not.toBeNull();
  const svg = readFileSync(saved!, "utf8");
  expect(svg).toContain("<style>");
  expect(svg).toContain("#172630");
  expect(svg).not.toContain('class="edge-hit"');
  expect(svg).not.toMatch(/<svg[^>]*class="[^"]*zoomed-out/);
  const parentCamera = await page
    .locator("[data-world]")
    .getAttribute("transform");
  await page.locator('[data-symbol="encoder"]').dblclick();
  await expect(
    page.getByRole("button", { name: "Back to parent schematic" }),
  ).toBeVisible();
  await expect(page.locator(".layout-indicator")).toBeHidden();
  await expect(page.locator('[data-symbol="encoder"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Back to parent schematic" }).click();
  await expect(page.locator('[data-symbol="encoder"]')).toHaveCount(1);
  await expect(page.locator("[data-world]")).toHaveAttribute(
    "transform",
    parentCamera!,
  );
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByLabel("Show compiler nodes").check();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-symbol="encoder"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByLabel("Show compiler nodes").uncheck();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-symbol="encoder"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.locator(".wave-panel")).toBeVisible({
    timeout: 30000,
  });
});

test("waveform selection reveals an original signal inside a collapsed mux tree", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "hdlview grouped mux "));
  writeFileSync(
    join(dir, "tree.sv"),
    `module tree(input wire [3:0] a,b,c,d, input wire [1:0] select, output wire [3:0] y);
wire [3:0] mid_low, mid_high;
assign mid_low = select[0] ? b : a;
assign mid_high = select[0] ? d : c;
assign y = select[1] ? mid_high : mid_low;
endmodule\n`,
  );
  writeFileSync(
    join(dir, "tb.sv"),
    "`timescale 1ns/1ps\nmodule tb; reg [3:0] a=1,b=2,c=3,d=4; reg [1:0] select=0; wire [3:0] y; tree dut(.*); initial begin #5 select=1; #5 select=2; #5 select=3; #5 $finish; end endmodule\n",
  );
  writeFileSync(
    join(dir, "hdlview.project.json"),
    JSON.stringify({
      schema_version: 3,
      name: "Grouped mux",
      top: "tree",
      sources: [{ path: "tree.sv", language: "system_verilog" }],
      simulation_sources: ["tb.sv"],
      standard: "1800-2017",
      simulations: {
        rtl: {
          simulator: "icarus",
          top: "tb",
          dut_scope: ["tb", "dut"],
          testbench: ["tb.sv"],
          stop_time: "1us",
        },
      },
    }),
  );
  const profile = JSON.parse(
    readFileSync(
      process.env.HDLVIEW_TOOL_PROFILE ?? "tools/profiles/docker.json",
      "utf8",
    ),
  );
  await page.addInitScript((profile) => {
    localStorage.setItem("hdlview-profile", JSON.stringify(profile));
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        performance.mark("hdlview-layout-worker");
      }
    };
  }, profile);
  await page.exposeFunction(
    "__HDLVIEW_TEST_API__",
    (action: string, args: unknown) =>
      new Promise((resolve, reject) => {
        pending.push((value: unknown) => {
          const r = value as { ok: boolean; result: unknown; error: string };
          r.ok ? resolve(r.result) : reject(new Error(r.error));
        });
        backend.stdin.write(JSON.stringify({ action, args }) + "\n");
      }),
  );
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => [
    join(dir, "hdlview.project.json"),
  ]);
  await page.goto("/");
  await fileCommand(page, "Open Existing Project…");
  await page
    .getByRole("button", { name: "Build schematic", exact: true })
    .click();
  await expect(page.locator('[data-symbol="mux"]')).toHaveCount(1, {
    timeout: 40000,
  });
  await expect(page.locator('[data-symbol="mux"]')).toHaveAttribute(
    "aria-label",
    "MUX 4:1",
  );
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(page.locator(".wave-panel")).toBeVisible({
    timeout: 30000,
  });
  const note = await page.locator(".snapshot-note").textContent();
  await page.locator(".wave-name").filter({ hasText: "mid_low" }).click();
  await expect(
    page.getByRole("button", { name: "Back to parent schematic" }),
  ).toBeVisible();
  await expect(page.locator('[data-symbol="mux"]')).toHaveCount(3);
  await expect(page.locator(".wave-name.active")).toContainText("mid_low");
  await expect(page.locator(".snapshot-note")).toHaveText(note!);
  await expect(page.locator(".layout-indicator")).toBeHidden();
  const workers = await page.evaluate(
    () => performance.getEntriesByName("hdlview-layout-worker").length,
  );
  const selected = page.locator(".symbol-pin.selected").first();
  const start = Date.now();
  await selected.locator(".pin-hit").click();
  await expect(page.locator(".wave-name.active")).toContainText("mid_low");
  console.log(
    `loaded grouped selection feedback: ${Date.now() - start} ms (includes Playwright click/assertion)`,
  );
  expect(
    await page.evaluate(
      () => performance.getEntriesByName("hdlview-layout-worker").length,
    ),
  ).toBe(workers);
  await page.getByRole("button", { name: "Back to parent schematic" }).click();
  await expect(page.locator('[data-symbol="mux"]')).toHaveCount(1);
});

test("aligned schematic, resizable workspace and panel tabs with testbench-named traces", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "hdlview clarity "));
  const source =
    readFileSync("tests/fixtures/counter/counter.sv", "utf8") +
    "// Scroll fixture\n".repeat(300);
  const tb = readFileSync("tests/fixtures/counter/tb.sv", "utf8").replace(
    "module tb;",
    'module tb; initial begin $dumpfile("counter-results.vcd"); $dumpvars(0, tb); for (integer i=0; i<100; i=i+1) $display("log row %d", i); end',
  );
  writeFileSync(join(dir, "counter.sv"), source);
  writeFileSync(join(dir, "tb.sv"), tb);
  const config = JSON.parse(
    readFileSync("tests/fixtures/counter/hdlview.project.json", "utf8"),
  );
  delete config.simulations.timing;
  writeFileSync(join(dir, "hdlview.project.json"), JSON.stringify(config));
  const profile = JSON.parse(
    readFileSync(
      process.env.HDLVIEW_TOOL_PROFILE ?? "tools/profiles/docker.json",
      "utf8",
    ),
  );
  await page.addInitScript((profile) => {
    localStorage.setItem("hdlview-profile", JSON.stringify(profile));
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        performance.mark("hdlview-layout-worker");
      }
    };
  }, profile);
  await page.exposeFunction(
    "__HDLVIEW_TEST_API__",
    (action: string, args: unknown) =>
      new Promise((resolve, reject) => {
        pending.push((value: unknown) => {
          const r = value as { ok: boolean; result: unknown; error: string };
          r.ok ? resolve(r.result) : reject(new Error(r.error));
        });
        backend.stdin.write(JSON.stringify({ action, args }) + "\n");
      }),
  );
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => [
    join(dir, "hdlview.project.json"),
  ]);
  await page.goto("/");
  await fileCommand(page, "Open Existing Project…");
  await page
    .getByRole("button", { name: "Build schematic", exact: true })
    .click();
  await expect(page.locator(".nodebox").first()).toBeVisible({
    timeout: 40000,
  });
  await expect(page.locator(".layout-indicator")).toBeHidden();
  const inputs = await page
    .locator('[data-boundary="input"] .pin-terminal')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().x),
    );
  const outputs = await page
    .locator('[data-boundary="output"] .pin-terminal')
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getBoundingClientRect().x),
    );
  expect(new Set(inputs.map((x) => Math.round(x)))).toHaveProperty("size", 1);
  expect(new Set(outputs.map((x) => Math.round(x)))).toHaveProperty("size", 1);
  expect(Math.max(...inputs)).toBeLessThan(Math.min(...outputs));
  const workers = await page.evaluate(
    () => performance.getEntriesByName("hdlview-layout-worker").length,
  );
  await page.getByRole("button", { name: "Display", exact: true }).click();
  await page.getByLabel("Show grid").check();
  await page.keyboard.press("Escape");
  const world = page.locator("[data-world]");
  const grid = page.locator("#schematic-grid");
  for (const theme of ["light", "dark"]) {
    await page.getByRole("button", { name: "Display", exact: true }).click();
    await page.getByLabel("Canvas theme").selectOption(theme);
    await page.keyboard.press("Escape");
    const before = await world.getAttribute("transform");
    await page.getByRole("button", { name: "Zoom schematic in" }).click();
    await expect(world).not.toHaveAttribute("transform", before!);
    await expect(grid).toHaveAttribute(
      "patternTransform",
      (await world.getAttribute("transform"))!,
    );
    const dot = await grid.locator("circle").getAttribute("fill");
    expect(dot).not.toBe(theme === "light" ? "#fcfdff" : "#172630");
    const pin = page.locator('[data-boundary="input"] .symbol-pin').first();
    const selectedView = await page
      .locator('.explorer-tabs button[aria-pressed="true"]')
      .textContent();
    await pin.locator(".pin-hit").click();
    await expect(pin).toHaveClass(/selected/);
    await expect(
      page.locator('.explorer-tabs button[aria-pressed="true"]'),
    ).toHaveText(selectedView!);
    await page.getByRole("button", { name: "Inspector", exact: true }).click();
    await expect(page.locator(".selection-kind")).toHaveText("Pin");
    await expect(page.locator(".pin-inspection")).toContainText("clk");
    await expect(page.locator(".symbol-pin.selected")).toHaveCount(1);
    await pin.focus();
    await page.keyboard.press("Enter");
    await expect(pin).toHaveClass(/selected/);
  }
  const point = await page.locator(".edge-hit").evaluateAll((paths) => {
    for (const element of paths) {
      const path = element as SVGPathElement;
      for (const fraction of [0.5, 0.25, 0.75]) {
        const local = path.getPointAtLength(path.getTotalLength() * fraction);
        const point = new DOMPoint(local.x, local.y).matrixTransform(
          path.getScreenCTM()!,
        );
        if (
          document
            .elementFromPoint(point.x, point.y)
            ?.closest("[data-wire]") === path.closest("[data-wire]")
        )
          return { x: point.x, y: point.y };
      }
    }
    return null;
  });
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y);
  await expect(page.locator(".wire.selected")).toHaveCount(1);
  await expect(page.locator(".selection-kind")).toHaveText("Signal / wire");
  await expect(page.locator(".symbol-pin.selected")).toHaveCount(0);
  for (let i = 0; i < 16; i++)
    await page.getByRole("button", { name: "Zoom schematic out" }).click();
  await expect(grid).toHaveAttribute(
    "patternTransform",
    (await world.getAttribute("transform"))!,
  );
  expect(Number(await grid.getAttribute("width"))).toBeGreaterThan(24);
  await page.getByRole("button", { name: "Fit", exact: true }).click();
  await expect(grid).toHaveAttribute(
    "patternTransform",
    (await world.getAttribute("transform"))!,
  );
  const fitted = await world.getAttribute("transform");
  const canvas = (await page
    .getByLabel("Schematic", { exact: true })
    .boundingBox())!;
  await page.mouse.move(
    canvas.x + canvas.width - 12,
    canvas.y + canvas.height - 12,
  );
  await page.mouse.down();
  await page.mouse.move(
    canvas.x + canvas.width - 44,
    canvas.y + canvas.height - 32,
  );
  await page.mouse.up();
  await expect(world).not.toHaveAttribute("transform", fitted!);
  await expect(grid).toHaveAttribute(
    "patternTransform",
    (await world.getAttribute("transform"))!,
  );
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export SVG" }).click();
  const svg = readFileSync((await (await download).path())!, "utf8");
  expect(svg).toContain("pin-terminal");
  expect(svg).not.toContain("data-grid");
  expect(svg).not.toContain("schematic-grid");
  expect(svg).not.toContain(":hover");
  expect(svg).not.toContain(":focus-visible");
  expect(svg).not.toContain('class="edge-hit"');
  expect(svg).not.toContain('class="pin-hit"');
  expect(
    await page.evaluate(
      () => performance.getEntriesByName("hdlview-layout-worker").length,
    ),
  ).toBe(workers);
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await page.getByRole("treeitem", { name: /counter.sv/ }).dblclick();
  await expect(page.locator(".cm-content")).toBeVisible();
  for (const simulator of ["rtl", "verilator"]) {
    const previousRun = await page.locator(".snapshot-note").textContent();
    await page
      .getByLabel("Simulation configuration", { exact: true })
      .selectOption(simulator);
    await page.getByRole("button", { name: "Run simulation" }).click();
    await expect(page.locator(".snapshot-note")).not.toHaveText(previousRun!, {
      timeout: 60000,
    });
    await expect(page.locator(".snapshot-note")).toContainText(
      "Bound to simulation",
      { timeout: 60000 },
    );
    await expect(page.locator(".wave-panel")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Run simulation" }),
    ).toBeEnabled();
    await expect(page.locator(".error-banner")).toBeHidden();
  }
  const camera = await world.getAttribute("transform");
  const panes = page.locator(".workbench");
  const panel = page.getByRole("region", { name: "Bottom panel", exact: true });
  const main = page.locator("main"),
    sidebar = page.locator(".sidebar");
  const panelBox = (await panel.boundingBox())!,
    mainBox = (await main.boundingBox())!;
  expect(Math.abs(panelBox.x - mainBox.x)).toBeLessThan(1);
  expect(Math.abs(panelBox.width - mainBox.width)).toBeLessThan(1);
  const sidebarBox = (await sidebar.boundingBox())!;
  expect(sidebarBox.y + sidebarBox.height).toBeLessThanOrEqual(panelBox.y);
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  const inspectorBox = (await page
    .getByRole("region", { name: "Project inspector" })
    .boundingBox())!;
  expect(inspectorBox.x).toBeGreaterThanOrEqual(sidebarBox.x);
  expect(inspectorBox.x + inspectorBox.width).toBeLessThanOrEqual(
    sidebarBox.x + sidebarBox.width,
  );
  await page.getByRole("button", { name: "Sources", exact: true }).click();
  await expect(
    page.getByRole("treeitem", { name: /counter.sv/ }),
  ).toBeVisible();
  const sidebarResize = page.getByRole("separator", { name: "Sidebar width" });
  await sidebarResize.focus();
  await page.keyboard.press("End");
  await expect(sidebarResize).toHaveAttribute("aria-valuenow", "420");
  await page.keyboard.press("Home");
  await expect(sidebarResize).toHaveAttribute("aria-valuenow", "224");
  const sideHandle = (await sidebarResize.boundingBox())!;
  await page.mouse.move(sideHandle.x + sideHandle.width / 2, sideHandle.y + 20);
  await page.mouse.down();
  await page.mouse.move(sideHandle.x + 100, sideHandle.y + 20);
  await page.mouse.up();
  await expect
    .poll(async () => Number(await sidebarResize.getAttribute("aria-valuenow")))
    .toBeGreaterThan(224);
  await expect
    .poll(async () => Number(await sidebarResize.getAttribute("aria-valuenow")))
    .toBeLessThan(420);
  const editorResize = page.getByRole("separator", { name: "Editor width" });
  await editorResize.focus();
  await page.keyboard.press("ArrowRight");
  await expect(editorResize).toHaveAttribute("aria-valuenow", "50");
  await page.keyboard.press("ArrowLeft");
  await expect(editorResize).toHaveAttribute("aria-valuenow", "45");
  await expect(world).toHaveAttribute("transform", camera!);
  const editor = page.locator(".cm-scroller");
  await editor.evaluate((element) => {
    element.scrollTop = 500;
  });
  const editorScroll = await editor.evaluate((element) => element.scrollTop);
  await page.getByLabel("Radix", { exact: true }).selectOption("bin");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  const waveState = await page.locator(".wave-toolbar").textContent();
  const fullHeight = (await panes.boundingBox())!.height;
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  const logs = page.getByRole("region", { name: "Tool logs" });
  await expect(logs).toBeVisible();
  expect(
    Math.abs((await panes.boundingBox())!.height - fullHeight),
  ).toBeLessThan(1);
  const paneBox = (await panes.boundingBox())!,
    logBox = (await logs.boundingBox())!;
  expect(paneBox.y + paneBox.height).toBeLessThanOrEqual(logBox.y);
  expect(logBox.width).toBe(mainBox.width);
  await logs.hover();
  await page.mouse.wheel(0, 600);
  await expect
    .poll(() => logs.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  expect(await editor.evaluate((element) => element.scrollTop)).toBe(
    editorScroll,
  );
  await page.getByRole("tab", { name: "Logs", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /^Problems / })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.getByRole("region", { name: "Problems panel" }),
  ).toBeVisible();
  await page.keyboard.press("Home");
  await expect(
    page.getByRole("tab", { name: "Waveforms", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".wave-toolbar")).toHaveText(waveState!);
  await expect(page.getByLabel("Radix", { exact: true })).toHaveValue("bin");
  await page.getByRole("tab", { name: "Logs", exact: true }).click();
  await expect
    .poll(() => logs.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await page
    .getByRole("button", { name: "Hide bottom panel", exact: true })
    .click();
  await expect(logs).toBeHidden();
  await expect
    .poll(async () => (await panes.boundingBox())!.height)
    .toBeGreaterThan(fullHeight);
  await expect(world).toHaveAttribute("transform", camera!);
  await page
    .getByRole("button", { name: "Show bottom panel", exact: true })
    .click();
  await expect(logs).toBeVisible();
  expect(
    Math.abs((await panes.boundingBox())!.height - fullHeight),
  ).toBeLessThan(1);
  await page.setViewportSize({ width: 1050, height: 620 });
  const panelResize = page.getByRole("separator", {
    name: "Bottom panel height",
  });
  await panelResize.focus();
  await page.keyboard.press("End");
  const narrowPanes = (await panes.boundingBox())!,
    narrowLogs = (await logs.boundingBox())!;
  const editorBox = (await editor.boundingBox())!;
  expect(editorBox.y + editorBox.height).toBeLessThanOrEqual(narrowLogs.y);
  expect(narrowPanes.y + narrowPanes.height).toBeLessThanOrEqual(narrowLogs.y);
  expect(
    (await page.locator(".workspace-top").boundingBox())!.height,
  ).toBeGreaterThanOrEqual(259);
  expect((await panel.boundingBox())!.height).toBeGreaterThanOrEqual(140);
  expect(
    await main.evaluate(
      (element) => element.scrollHeight <= element.clientHeight,
    ),
  ).toBe(true);
  await editorResize.focus();
  await page.keyboard.press("Home");
  expect(
    (await page.locator(".editor-pane").boundingBox())!.width,
  ).toBeGreaterThanOrEqual(199);
  await page.keyboard.press("End");
  expect(
    (await page.locator(".design-pane").boundingBox())!.width,
  ).toBeGreaterThanOrEqual(319);
  await page.getByRole("tab", { name: "Waveforms", exact: true }).click();
  await expect(page.locator(".wave-toolbar")).toHaveText(waveState!);
  await expect(world).toHaveAttribute("transform", camera!);
  await page
    .getByRole("button", { name: "Hide Schematic", exact: true })
    .click();
  await expect(world).toBeHidden();
  await page
    .getByRole("button", { name: "Show Schematic", exact: true })
    .click();
  await expect(world).toHaveAttribute("transform", camera!);
  expect(
    await page.evaluate(
      () => performance.getEntriesByName("hdlview-layout-worker").length,
    ),
  ).toBe(workers);
  await page.screenshot({
    path: test.info().outputPath("clarity-workspace.png"),
  });
  expect(readFileSync(join(dir, "counter.sv"), "utf8")).toBe(source);
  expect(readFileSync(join(dir, "tb.sv"), "utf8")).toBe(tb);
});
test("a floorplan is drawn, sized in settings, given pin sides and saved with the project", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "hdlview floorplan "));
  for (const name of ["counter.sv", "tb.sv", "hdlview.project.json"])
    writeFileSync(
      join(dir, name),
      readFileSync(join("tests/fixtures/counter", name)),
    );
  const file = join(dir, "hdlview.project.json");
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
  await page.exposeFunction(
    "__HDLVIEW_TEST_API__",
    (action: string, args: unknown) =>
      new Promise((resolve, reject) => {
        pending.push((value: unknown) => {
          const r = value as { ok: boolean; result: unknown; error: string };
          r.ok ? resolve(r.result) : reject(new Error(r.error));
        });
        backend.stdin.write(JSON.stringify({ action, args }) + "\n");
      }),
  );
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => [file]);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await fileCommand(page, "Open Existing Project…");
  await page
    .getByRole("button", { name: "Build schematic", exact: true })
    .click();
  await expect(page.locator(".nodebox").first()).toBeVisible({
    timeout: 30000,
  });
  const tools = page.locator(".workspace-tools");
  await tools
    .getByRole("button", { name: "Floorplan & Layout", exact: true })
    .click();
  await expect(page.getByLabel("Schematic", { exact: true })).toBeHidden();
  const pane = page.locator(".physical-pane");
  await expect(pane.getByText("Automatic size")).toBeVisible();
  // Pins need a fixed outline.
  await expect(pane.getByLabel("Side of clk")).toBeDisabled();
  const canvas = pane.getByLabel("Floorplan", { exact: true });
  const box = (await canvas.boundingBox())!;
  await pane.getByRole("button", { name: "Draw floorplan" }).click();
  await page.mouse.move(box.x + 100, box.y + box.height - 100);
  await page.mouse.down();
  await page.mouse.move(box.x + 300, box.y + 100, { steps: 4 });
  await page.mouse.up();
  const width = pane.getByLabel("Floorplan width");
  const height = pane.getByLabel("Floorplan height");
  await expect(width).toBeVisible();
  expect(Number(await width.inputValue())).toBeGreaterThan(0);
  await width.fill("80");
  await height.fill("60");
  await pane.getByLabel("Side of clk").selectOption("west");
  await pane.getByLabel("Side of fast").selectOption("east");
  await pane.getByLabel("Side of slow").selectOption("east");

  // The same outline in Project Settings; a size typed there is drawn here.
  await page
    .getByRole("button", { name: "Project Settings", exact: true })
    .click();
  const settings = page.getByRole("dialog", { name: "Project Settings" });
  await settings.getByRole("button", { name: "Physical Design" }).click();
  await expect(settings.getByLabel("Fixed floorplan size")).toBeChecked();
  await expect(settings.getByLabel("Floorplan width (µm)")).toHaveValue("80");
  await expect(settings.getByLabel("Side of fast")).toHaveValue("east");
  await settings.getByLabel("Floorplan width (µm)").fill("90");
  await settings.getByRole("button", { name: "OK", exact: true }).click();
  await expect(settings).toBeHidden();
  await expect(width).toHaveValue("90");

  // Dragging a pin along its side changes the order: fast is drawn below slow.
  await pane.getByRole("button", { name: "Fit" }).click();
  const scale = Math.min((box.width - 120) / 90, (box.height - 120) / 60);
  const east = box.x + box.width / 2 + 45 * scale;
  const y = (um: number) => box.y + box.height / 2 + (30 - um) * scale;
  await page.mouse.move(east, y(20));
  await page.mouse.down();
  await page.mouse.move(east, y(40), { steps: 4 });
  await page.mouse.move(east, y(55), { steps: 4 });
  await page.mouse.up();
  await fileCommand(page, "Save Project");
  await expect
    .poll(() => JSON.parse(readFileSync(file, "utf8")).physical.floorplan)
    .toEqual({
      width_um: 90,
      height_um: 60,
      pins: [
        { port: "clk", side: "west" },
        { port: "slow", side: "east" },
        { port: "fast", side: "east" },
      ],
    });

  await pane.getByRole("button", { name: "Automatic", exact: true }).click();
  await expect(pane.getByText("Automatic size")).toBeVisible();
  await tools
    .getByRole("button", { name: "Code & Schematic", exact: true })
    .click();
  await expect(page.getByLabel("Schematic", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("GDS masks and overlays share frames, stay loaded across panes, and ignore stale snapshots", async ({
  page,
}) => {
  const first = physicalSnapshot(snapshot.directory, "first");
  const second = physicalSnapshot(snapshot.directory, "second");
  const calls: string[] = [];
  let holdMasks = false;
  let releaseMasks: (() => void) | undefined;
  await page.exposeFunction(
    "__HDLVIEW_TEST_API__",
    (action: string, args: unknown) =>
      new Promise((resolve, reject) => {
        calls.push(action);
        pending.push((value: unknown) => {
          const r = value as { ok: boolean; result: unknown; error: string };
          if (!r.ok) {
            reject(new Error(r.error));
            return;
          }
          if (holdMasks && action === "layout_masks") {
            holdMasks = false;
            releaseMasks = () => resolve(r.result);
          } else resolve(r.result);
        });
        backend.stdin.write(JSON.stringify({ action, args }) + "\n");
      }),
  );
  await page.addInitScript(() => {
    const records: {
      kind: string;
      frame: number;
      width: number;
      height: number;
    }[] = [];
    let frame = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) =>
      raf((time) => {
        frame++;
        callback(time);
      });
    const draw = WebGL2RenderingContext.prototype.drawElementsInstanced;
    WebGL2RenderingContext.prototype.drawElementsInstanced = function (
      ...args
    ) {
      records.push({
        kind:
          this.canvas.getAttribute("aria-label") === "3D layout"
            ? "solid"
            : "mask",
        frame,
        width: this.canvas.width,
        height: this.canvas.height,
      });
      return draw.apply(this, args);
    };
    const clear = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      if (this.canvas.getAttribute("aria-label") === "Layout")
        records.push({
          kind: "overlay",
          frame,
          width: this.canvas.width,
          height: this.canvas.height,
        });
      return clear.apply(this, args);
    };
    const Worker = window.Worker;
    window.Worker = class extends Worker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        if (String(args[0]).includes("masks.worker"))
          performance.mark("mask-worker");
      }
    };
    Object.assign(window, { maskFrames: records });
  });
  let projectFile = "";
  await page.exposeFunction("__HDLVIEW_TEST_PICKER__", () => [projectFile]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  let opened = false;
  const open = async (path: string) => {
    if (opened) await fileCommand(page, "Close Project");
    // A fresh project path avoids restoring checkpoints left by other workflows.
    const directory = mkdtempSync(join(tmpdir(), "hdlview mask project "));
    for (const name of ["counter.sv", "tb.sv", "hdlview.project.json"])
      writeFileSync(
        join(directory, name),
        readFileSync(join("tests/fixtures/counter", name)),
      );
    projectFile = join(directory, "hdlview.project.json");
    await fileCommand(page, "Open Existing Project…");
    opened = true;
    await page
      .getByRole("button", { name: "Code & Schematic", exact: true })
      .click();
    await page.getByRole("button", { name: "Open saved snapshot" }).click();
    await page.getByLabel("Open snapshot input").fill(path);
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page
      .getByRole("button", { name: "Floorplan & Layout", exact: true })
      .click();
  };
  await open(first);
  const pane = page.locator(".physical-pane");
  await expect(pane.getByLabel("met1.first")).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.maskFrames.filter((r) => r.kind === "mask").length,
      ),
    )
    .toBeGreaterThan(0);
  await expect
    .poll(() => calls.filter((action) => action === "layout_shapes").length)
    .toBe(2);
  const originalCalls = calls.filter((a) => a.startsWith("layout")).length;
  const workers = await page.evaluate(
    () => performance.getEntriesByName("mask-worker").length,
  );
  const canvas = pane.getByLabel("Layout", { exact: true });
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + 37.25,
    box.y + box.height / 2 - 23.5,
    { steps: 20 },
  );
  await page.mouse.up();
  for (const deltaY of [-1, -1, -1, 1, 1, 1])
    await canvas.dispatchEvent("wheel", {
      deltaY,
      clientX: box.x + 100,
      clientY: box.y + 100,
    });
  await pane.getByRole("button", { name: "Fit", exact: true }).click();
  const scale = Math.min((box.width - 120) / 100, (box.height - 120) / 100);
  await canvas.click({
    position: { x: box.width / 2 - 20 * scale, y: box.height / 2 + 15 * scale },
  });
  await page.getByRole("button", { name: "Inspector", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Project inspector" }),
  ).toContainText("fast");
  await page
    .getByRole("button", { name: "Code & Schematic", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Floorplan & Layout", exact: true })
    .click();
  await page.setViewportSize({ width: 1301, height: 901 });
  const display = await page.context().newCDPSession(page);
  await display.send("Emulation.setDeviceMetricsOverride", {
    width: 1301,
    height: 901,
    deviceScaleFactor: 1.25,
    mobile: false,
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(calls.filter((a) => a.startsWith("layout"))).toHaveLength(
    originalCalls,
  );
  expect(
    await page.evaluate(
      () => performance.getEntriesByName("mask-worker").length,
    ),
  ).toBe(workers);
  const frames = await page.evaluate(() => window.maskFrames);
  for (const mask of frames.filter((r) => r.kind === "mask"))
    expect(
      frames.find((r) => r.kind === "overlay" && r.frame === mask.frame),
    ).toEqual({ ...mask, kind: "overlay" });
  await pane.getByRole("button", { name: "Hide all", exact: true }).click();
  await expect(pane.getByLabel("met1.first")).not.toBeChecked();
  await pane.getByRole("button", { name: "Show all", exact: true }).click();
  await expect(pane.getByLabel("met1.first")).toBeChecked();
  // The 3D tab extrudes the same GDS; a fitted Layout view means the whole design.
  await pane.getByRole("button", { name: "3D", exact: true }).click();
  await expect(pane.getByLabel("3D layout")).toBeVisible();
  await expect(
    pane.getByRole("button", { name: "Whole design", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(pane.getByLabel("met1.first")).toBeChecked();
  await expect(pane.getByLabel("met2.first")).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.maskFrames.filter((r) => r.kind === "solid").length,
      ),
    )
    .toBeGreaterThan(0);
  await expect(pane.locator(".physical-tools")).toContainText("triangles");
  await pane.getByLabel("met1.first").uncheck();
  await pane.getByRole("button", { name: "Top", exact: true }).click();
  await page.getByLabel("Z scale").fill("4");
  // Frames that come late halve the 3D resolution while the view moves; at
  // rest it is drawn sharp again.
  const solidWidths = () =>
    page.evaluate(() =>
      window.maskFrames.filter((r) => r.kind === "solid").map((r) => r.width),
    );
  const sharp = (await solidWidths()).at(-1)!;
  await page.evaluate(() => {
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (callback) => {
      setTimeout(() => raf(callback), 40);
      return 0;
    };
    window.addEventListener(
      "pointerup",
      () => (window.requestAnimationFrame = raf),
      { once: true },
    );
  });
  const solidBox = (await pane.getByLabel("3D layout").boundingBox())!;
  const drawnBefore = (await solidWidths()).length;
  await page.mouse.move(solidBox.x + 100, solidBox.y + 100);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) {
    await page.mouse.move(solidBox.x + 100 + step * 4, solidBox.y + 100);
    await page.waitForTimeout(70);
  }
  await page.mouse.up();
  expect((await solidWidths()).slice(drawnBefore)).toContain(
    Math.round(sharp / 2),
  );
  await expect.poll(async () => (await solidWidths()).at(-1)).toBe(sharp);
  await pane.getByRole("button", { name: "Layout", exact: true }).click();
  await expect(pane.getByLabel("Layout", { exact: true })).toBeVisible();
  await expect(pane.getByLabel("met1.first")).toBeChecked();
  // Delay a real CLI response across another snapshot activation.
  holdMasks = true;
  await open(second);
  await expect.poll(() => !!releaseMasks).toBe(true);
  await open(first);
  await expect(pane.getByLabel("met1.first")).toBeChecked();
  releaseMasks!();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(pane.getByLabel("met1.second")).toHaveCount(0);
  expect(errors).toEqual([]);
});
