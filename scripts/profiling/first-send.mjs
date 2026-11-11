// Input-to-own-message paint, with controlled native startup and no provider.
import fs from "node:fs";
import path from "node:path";
import { launchApp, parseArguments, profilingDirectory, sourceRevision } from "./harness.mjs";

const options = parseArguments(process.argv.slice(2), { label: "", runs: 2 });
if (!options.label) throw new Error("Pass --label before or --label after.");
const workDirectory = profilingDirectory("first-send");
const revision = sourceRevision();
const app = await launchApp({ workDirectory });
try {
  for (let run = 1; run <= options.runs; run++) {
    const cases = {};
    for (const startupMs of [0, 1000]) {
      await app.window.evaluate(`(async () => {
        window.__firstSend?.dispose();
        const { mount } = await import('/src/test/profiling/first-send.tsx');
        window.__firstSend = mount(${startupMs});
      })()`);
      await app.window.waitFor(`document.querySelector('[role=textbox][aria-label=Message]') && !document.body.textContent.includes('Checking agents…')`, { what: "composer" });
      await app.window.evaluate(`document.querySelector('[role=textbox][aria-label=Message]').focus()`);
      await app.window.type("First send profiling marker", 0);
      cases[startupMs] = await app.window.evaluate(`(async () => {
        const start = performance.now();
        [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === 'Send').click();
        while (!document.querySelector('[role=log]')?.textContent.includes('First send profiling marker')) {
          if (performance.now() - start > 5000) throw new Error('Own message did not appear');
          await new Promise(requestAnimationFrame);
        }
        await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve)));
        window.__firstSend.startedAt = start;
        return { ownMessageMs: performance.now() - start };
      })()`);
      if (startupMs === 1000 && run === 1) {
        const screenshot = await app.window.send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(workDirectory, `${options.label}-own-message.png`), Buffer.from(screenshot.data, "base64"));
      }
      cases[startupMs].wireMs = await app.window.evaluate(`(async () => {
        const start = window.__firstSend.startedAt;
        while (!window.__firstSend.sent.length) {
          if (performance.now() - start > 5000) throw new Error('Prompt never reached transport');
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (window.__firstSend.sent.length !== 1) throw new Error('Duplicate first send');
        return window.__firstSend.sentAt - start;
      })()`);
    }
    const result = { scenario: "first-send", label: options.label, run, revision, cases };
    fs.appendFileSync(path.join(workDirectory, "results.jsonl"), JSON.stringify(result) + "\n");
    console.log(JSON.stringify(result));
  }
} finally {
  await app.stop();
}
