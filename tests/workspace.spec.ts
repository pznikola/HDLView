import { test, expect } from "@playwright/test";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";
let backend: ChildProcessWithoutNullStreams;
let snapshot: { directory: string };
let pending: ((result: unknown) => void)[] = [];
test.beforeAll(() => {
  const args = ["--store", ".hdlview/browser-tests"];
  if (process.env.HDLVIEW_TOOL_PROFILE)
    args.push("--profile", process.env.HDLVIEW_TOOL_PROFILE);
  const build = spawnSync(
    "target/debug/hdlview",
    [...args, "build", "examples/counter/hdlview.project.json"],
    { encoding: "utf8" },
  );
  if (build.status !== 0) throw new Error(build.stderr);
  snapshot = JSON.parse(build.stdout);
  backend = spawn("target/debug/hdlview", [
    "--store",
    ".hdlview/browser-tests",
    "rpc",
  ]);
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
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
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
  await page.screenshot({
    path: resolve("test-results/workspace.png"),
    fullPage: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "Restore session" }).click();
  await expect(page.getByText("Waveforms", { exact: true })).toBeVisible({
    timeout: 15000,
  });
  await expect(
    page.locator(".wave-name").filter({ hasText: "first.count" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Close waveform session" }).click();
  await expect(
    page.getByRole("button", { name: "Mapped gates", exact: true }),
  ).toBeEnabled();
  expect(errors).toEqual([]);
});
