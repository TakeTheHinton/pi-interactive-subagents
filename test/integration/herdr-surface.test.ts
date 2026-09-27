/**
 * Integration tests for the herdr surface layer.
 *
 * These tests exercise real herdr operations: creating panes,
 * sending commands, reading screen output, and closing panes.
 * No LLM calls — fast and free.
 *
 * Commands sent with sendCommand are typed into the pane's own shell
 * (PowerShell on Windows), so they stick to syntax that works there too.
 * Anything that needs bash goes through sendLongCommand.
 *
 * Run from a pi-less herdr pane:
 *   npm run test:integration
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { pollForExit } from "../../pi-extension/subagents/herdr.ts";
import {
  getAvailableBackends,
  createTestEnv,
  cleanupTestEnv,
  createTrackedSurface,
  getFocusedSurface,
  untrackSurface,
  sendCommand,
  sendLongCommand,
  readScreen,
  readScreenAsync,
  closeSurface,
  uniqueId,
  tempPath,
  waitForFile,
  waitForScreen,
  type TestEnv,
} from "./harness.ts";

const backends = getAvailableBackends();

if (backends.length === 0) {
  console.log("⚠️  herdr is not available — skipping herdr-surface integration tests");
  console.log("   Run inside a herdr pane to enable these tests.");
}

/** Wait until the pane's shell has printed a prompt (bash `$`, PowerShell `>`). */
async function waitForShell(surface: string): Promise<void> {
  await waitForScreen(surface, /[>$#%]\s*$/m, 20_000, 20);
}

for (const backend of backends) {
  describe(`herdr-surface [${backend}]`, { timeout: 120_000 }, () => {
    let env: TestEnv;

    before(() => {
      env = createTestEnv();
    });

    after(() => {
      cleanupTestEnv(env);
    });

    it("creates surfaces without stealing focus and targets each one", async () => {
      const focusedBefore = getFocusedSurface();

      const childA = createTrackedSurface(env, "focus-child-a");
      const childB = createTrackedSurface(env, "focus-child-b");
      await Promise.all([waitForShell(childA), waitForShell(childB)]);
      assert.equal(getFocusedSurface(), focusedBefore);

      const markerA = uniqueId();
      const markerB = uniqueId();
      sendCommand(childA, `echo "FOCUS_A_${markerA}"`);
      sendCommand(childB, `echo "FOCUS_B_${markerB}"`);

      await Promise.all([
        waitForScreen(childA, new RegExp(`FOCUS_A_${markerA}`), 20_000, 50),
        waitForScreen(childB, new RegExp(`FOCUS_B_${markerB}`), 20_000, 50),
      ]);
      assert.equal(getFocusedSurface(), focusedBefore);
    });

    it("creates a surface, sends a command, reads output, and closes it", async () => {
      const surface = createTrackedSurface(env, "echo-test");
      await waitForShell(surface);

      const marker = uniqueId();
      sendCommand(surface, `echo "MARKER_${marker}"`);
      const screen = await waitForScreen(surface, new RegExp(`MARKER_${marker}`), 20_000, 50);
      assert.ok(screen.includes(`MARKER_${marker}`));

      closeSurface(surface);
      untrackSurface(env, surface);
    });

    it("preserves shell special characters in echo output", async () => {
      const surface = createTrackedSurface(env, "escape-test");
      await waitForShell(surface);

      const marker = uniqueId();
      // Single-quoted string — $ and " are literal inside single quotes (bash and PowerShell)
      sendCommand(surface, `echo 'SPEC_${marker}_$HOME_"quotes"_done'`);
      const screen = await waitForScreen(surface, new RegExp(`SPEC_${marker}.*_done`), 20_000, 50);
      assert.ok(screen.includes("$HOME"), `Expected literal $HOME in output. Got:\n${screen}`);
    });

    it("sends a long command via script file without truncation", async () => {
      const surface = createTrackedSurface(env, "long-cmd-test");
      await waitForShell(surface);

      const marker = uniqueId();
      const longValue = "X".repeat(500);
      sendLongCommand(surface, `echo "LONG_${marker}_${longValue}_END"`);

      const screen = await waitForScreen(surface, new RegExp(`LONG_${marker}_X+_END`), 20_000, 50);
      assert.ok(screen.includes(`${longValue}_END`), `Expected full output. Got:\n${screen.slice(-300)}`);
    });

    it("runs launch scripts in bash and detects the exit sentinel", async () => {
      const surface = createTrackedSurface(env, "sentinel-test");
      await waitForShell(surface);

      // $BASH_VERSION is only set in bash, so this proves the script did not
      // run in the pane's own shell.
      sendLongCommand(surface, `echo "IN_BASH_\${BASH_VERSION:+yes}"; (exit 3); echo '__SUBAGENT_DONE_'$?'__'`);

      const result = await pollForExit(surface, new AbortController().signal, { interval: 300 });
      assert.deepEqual(result, { reason: "sentinel", exitCode: 3 });
      assert.ok(readScreen(surface, 20).includes("IN_BASH_yes"));
    });

    it("reads screen asynchronously", async () => {
      const surface = createTrackedSurface(env, "async-read-test");
      await waitForShell(surface);

      const marker = uniqueId();
      sendCommand(surface, `echo "ASYNC_${marker}"`);
      await waitForScreen(surface, new RegExp(`ASYNC_${marker}`), 20_000, 50);

      const screen = await readScreenAsync(surface, 50);
      assert.ok(screen.includes(`ASYNC_${marker}`), `Async read should find marker. Got:\n${screen}`);
    });

    it("manages multiple surfaces concurrently", async () => {
      const s1 = createTrackedSurface(env, "multi-1");
      const s2 = createTrackedSurface(env, "multi-2");
      await Promise.all([waitForShell(s1), waitForShell(s2)]);

      const m1 = uniqueId();
      const m2 = uniqueId();
      sendCommand(s1, `echo "S1_${m1}"`);
      sendCommand(s2, `echo "S2_${m2}"`);

      await Promise.all([
        waitForScreen(s1, new RegExp(`S1_${m1}`), 20_000, 50),
        waitForScreen(s2, new RegExp(`S2_${m2}`), 20_000, 50),
      ]);
      assert.ok(!readScreen(s1, 50).includes(`S2_${m2}`), "Surface 1 should not see surface 2 output");
    });

    it("writes output to a file from a launch script", async () => {
      const surface = createTrackedSurface(env, "file-test");
      await waitForShell(surface);

      const marker = uniqueId();
      const filePath = tempPath(`pi-herdr-test-${marker}.txt`);

      sendLongCommand(surface, `echo "FILE_${marker}" > '${filePath}' && echo "WRITTEN_${marker}"`);

      await waitForScreen(surface, new RegExp(`WRITTEN_${marker}`), 20_000, 50);
      const content = await waitForFile(filePath, 10_000, new RegExp(`FILE_${marker}`));
      assert.ok(content.includes(`FILE_${marker}`), `File content wrong. Got: ${content}`);

      try {
        unlinkSync(filePath);
      } catch {}
    });
  });
}
