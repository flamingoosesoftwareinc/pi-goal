const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const indexSource = readFileSync(join(__dirname, "../.pi/extensions/pi-goal/index.ts"), "utf8");

test("persisting a non-active goal cancels any queued continuation", () => {
	assert.match(
		indexSource,
		/if \(next\?\.status !== "active"\) \{\s*cancelContinuation\(\);\s*\}/,
	);
});

test("continuation uses a configurable trailing-edge debounce after the agent settles", () => {
	assert.match(indexSource, /let continuationCadenceMs = 5_000/);
	assert.match(indexSource, /pi\.on\("agent_settled"/);
	assert.match(indexSource, /clearTimeout\(continuationTimer\)/);
	assert.match(indexSource, /setTimeout\([\s\S]*continuationCadenceMs\)/);
	assert.doesNotMatch(indexSource, /queueMicrotask/);
});
