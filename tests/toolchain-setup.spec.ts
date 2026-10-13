import { expect, test } from "@playwright/test";

const pull = "docker pull hpretl/iic-osic-tools:2026.09";
const states = {
  docker_missing: {
    message: "Docker is not installed.",
    commands: [],
    link: "https://docs.docker.com/engine/install/",
    current: "Install Docker",
    footer: "Docker toolchain: Docker not installed",
  },
  docker_stopped: {
    message: "The Docker service is not running.",
    commands: ["sudo systemctl start docker"],
    link: null,
    current: "Start Docker",
    footer: "Docker toolchain: Docker not running",
  },
  image_missing: {
    message: "The tools image is not downloaded.",
    commands: [pull],
    link: null,
    current: "Download the tools image",
    footer: "Docker toolchain: tools image missing",
  },
  image_old: {
    message: "The image is too old for HDLView.",
    commands: [pull],
    link: null,
    current: "Download the tools image",
    footer: "Docker toolchain: tools image too old",
  },
};

for (const [state, expected] of Object.entries(states)) {
  test(`setup panel explains ${state} until the toolchain is ready`, async ({
    page,
  }) => {
    let ready = false;
    await page.exposeFunction("__HDLVIEW_TEST_API__", (action: string) =>
      action === "toolchain_status"
        ? ready
          ? { state: "ready", message: "", commands: [], link: null }
          : { state, ...expected }
        : null,
    );
    await page.goto("/");
    const setup = page.getByRole("region", { name: "Toolchain setup" });
    await expect(setup.locator("li.current strong")).toHaveText(
      expected.current,
    );
    await expect(setup).toContainText(expected.message);
    for (const text of [expected.link, ...expected.commands])
      if (text)
        await expect(setup.getByText(text, { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: expected.footer, exact: true }),
    ).toBeVisible();
    ready = true;
    await setup.getByRole("button", { name: "Check again" }).click();
    await expect(setup).toHaveCount(0);
    await expect(
      page.getByText("Docker toolchain", { exact: true }),
    ).toBeVisible();
  });
}
