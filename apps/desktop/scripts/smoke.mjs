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

  try {
    const page = await app.firstWindow();

    await page.waitForLoadState("domcontentloaded");
    await page.waitForSelector("#ops-title");
    await page.waitForSelector("#recommendations-title");
    await page.waitForSelector("#sessions-title");
    await page.waitForSelector("#session-focus-title");
    await page.waitForFunction(() => {
      const tmuxText = document.querySelector("#tmux-status-text")?.textContent?.trim();
      const runbookCount = document.querySelectorAll("#runbook-list .runbook-item").length;
      return tmuxText && tmuxText !== "확인 중" && runbookCount > 0;
    });

    await page.screenshot({
      path: screenshotFile,
      fullPage: true
    });

    const title = await page.title();
    const tmuxText = await page.locator("#tmux-status-text").innerText();
    const apiText = await page.locator("#api-status-text").innerText();
    const recommendationCount = await page.locator("#recommendations .recommendation-card").count();
    const sessionCount = await page.locator("#sessions .session-row").count();
    const runbookCount = await page.locator("#runbook-list .runbook-item").count();
    const detailText = await page.locator("#session-detail").innerText();

    console.log(
      JSON.stringify(
        {
          ok: true,
          title,
          tmuxText,
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
    await app.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
