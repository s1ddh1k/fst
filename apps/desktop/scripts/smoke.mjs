import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { _electron as electron } from "playwright";

const desktopDir = process.cwd();
const mainFile = path.join(desktopDir, "dist", "main.js");
const artifactDir = path.join(desktopDir, "artifacts");
const screenshotFile = path.join(artifactDir, "smoke.png");

async function run() {
  await fs.mkdir(artifactDir, { recursive: true });

  const app = await electron.launch({
    args: [mainFile],
    env: {
      ...process.env,
      DESKTOP_API_BASE_URL: process.env.DESKTOP_API_BASE_URL ?? "http://127.0.0.1:8787"
    }
  });
  const electronProcess = app.process();

  try {
    const page = await app.firstWindow();
    page.setDefaultTimeout(10000);

    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector(".market-strip");
    await page.waitForSelector("#recommendation-count");

    await page.getByRole("button", { name: /전략|Strategies/i }).click();
    await page.waitForSelector("#recommendations-title");

    await page.getByRole("button", { name: /세션|Sessions/i }).click();
    await page.waitForSelector("#sessions-title");
    await page.waitForSelector("#session-focus-title");

    await page.getByRole("button", { name: /운영|Operations/i }).click();
    await page.waitForSelector("#ops-title");
    await page.waitForFunction(() => {
      const runbookCount = document.querySelectorAll("#runbook-list .runbook-item").length;
      return runbookCount > 0;
    });

    await page.screenshot({
      path: screenshotFile,
      fullPage: true
    });

    const title = await page.title();
    const activeStage = await page.locator(".stage-title").innerText();
    const apiText = await page.locator("#api-banner").innerText();
    const recommendationCount = await page.locator("#recommendations .recommendation-card").count();
    const sessionCount = await page.locator("#sessions .session-row").count();
    const runbookCount = await page.locator("#runbook-list .runbook-item").count();
    const detailText = await page.locator("#session-detail").innerText().catch(() => "");

    console.log(
      JSON.stringify(
        {
          ok: true,
          title,
          activeStage,
          apiText,
          recommendationCount,
          sessionCount,
          runbookCount,
          hasSessionDetail: detailText.trim().length > 0,
          screenshotFile
        },
        null,
        2
      )
    );
  } finally {
    await Promise.race([
      app.close().catch(() => {}),
      new Promise((resolve) => {
        setTimeout(resolve, 2000);
      })
    ]);

    if (electronProcess && !electronProcess.killed) {
      electronProcess.kill("SIGKILL");
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  setTimeout(() => {
    process.exit(process.exitCode ?? 0);
  }, 0);
});
