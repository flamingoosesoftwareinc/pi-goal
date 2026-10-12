const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createJiti } = require("jiti");

const piGoal = createJiti(__filename)("../.pi/extensions/pi-goal/index.ts").default;

function session(entries = []) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const messages = [];
	let branch = entries;
	let activeTools = [];
	let status = "";
	const pi = {
		on(name, handler) { handlers.set(name, handler); },
		registerTool(tool) { tools.set(tool.name, tool); },
		registerCommand(name, command) { commands.set(name, command); },
		registerMessageRenderer() {},
		getActiveTools() { return activeTools; },
		setActiveTools(names) { activeTools = names; },
		appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
		sendMessage(message) { messages.push(message); },
	};
	const ctx = {
		sessionManager: { getBranch: () => branch },
		ui: { setStatus(_key, text) { status = text; }, notify() {}, confirm: async () => true },
		isIdle: () => false,
		hasPendingMessages: () => false,
	};
	piGoal(pi);
	return {
		ctx, handlers, tools, commands, messages,
		get activeTools() { return activeTools; },
		get status() { return status; },
		switchBranch(entries) { branch = entries; },
		start() { handlers.get("session_start")({ reason: "startup" }, ctx); },
		async create(objective, cadence) {
			return tools.get("create_goal").execute("call", { objective, cadence }, undefined, undefined, ctx);
		},
		async get() { return (await tools.get("get_goal").execute()).details.goal; },
	};
}

test("extension instances keep goals, tools, and lifecycle changes within their own session", async () => {
	const a = session();
	const b = session();
	a.start();
	await a.create("goal A", "1ms");
	b.start();
	assert.equal(await b.get(), null);
	assert.equal(b.activeTools.includes("update_goal"), false);
	assert.equal((await a.get()).objective, "goal A");
	assert.equal(a.activeTools.includes("update_goal"), true);
	await b.create("goal B", "2ms");
	a.handlers.get("turn_start")({}, a.ctx);
	b.handlers.get("turn_start")({}, b.ctx);
	a.handlers.get("turn_end")({ message: { usage: { totalTokens: 37 } } }, a.ctx);
	b.handlers.get("turn_end")({ message: { usage: { totalTokens: 12 } } }, b.ctx);
	assert.equal((await a.get()).objective, "goal A");
	assert.equal((await b.get()).objective, "goal B");
	assert.equal((await a.get()).tokensUsed, 37);
	assert.equal((await b.get()).tokensUsed, 12);
	await b.commands.get("goal").handler("pause", b.ctx);
	await b.commands.get("goal").handler("statusbar off", b.ctx);
	assert.equal((await a.get()).status, "active");
	assert.equal((await b.get()).status, "paused");
	assert.equal(a.status, "Pursuing goal (0s)");
	assert.equal(b.status, "");
});

test("tree navigation restores the goal and cancels a queued continuation from the abandoned branch", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = session();
	s.start();
	await s.create("goal A", "1ms");
	s.handlers.get("agent_settled")({}, s.ctx);
	s.switchBranch([]);
	s.handlers.get("session_tree")({ newLeafId: null, oldLeafId: "a" }, s.ctx);
	assert.equal(await s.get(), null);
	assert.equal(s.activeTools.includes("update_goal"), false);
	assert.equal(s.status, "");
	t.mock.timers.tick(2);
	assert.deepEqual(s.messages.map((message) => message.details.kind), ["active"]);
});

test("session replacement restores only the selected session's persisted entries", async () => {
	const s = session();
	s.start();
	await s.create("first session", "1ms");
	const firstEntries = s.ctx.sessionManager.getBranch();
	s.switchBranch([]);
	s.handlers.get("session_start")({ reason: "new" }, s.ctx);
	assert.equal(await s.get(), null);
	assert.equal(s.activeTools.includes("update_goal"), false);
	await s.create("second session", "2ms");
	s.switchBranch(firstEntries);
	s.handlers.get("session_start")({ reason: "resume" }, s.ctx);
	assert.equal((await s.get()).objective, "first session");
	assert.equal(s.activeTools.includes("update_goal"), true);
	const status = [];
	s.ctx.ui.notify = (message) => status.push(message);
	await s.commands.get("goal").handler("cadence", s.ctx);
	assert.deepEqual(status, ["Goal cadence is 1ms."]);
});

test("one instance's continuation cannot use another instance's goal", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const a = session();
	const b = session();
	a.start();
	b.start();
	await a.create("goal A", "1ms");
	await b.create("goal B", "2ms");
	a.ctx.isIdle = () => true;
	b.ctx.isIdle = () => true;
	a.handlers.get("agent_settled")({}, a.ctx);
	b.handlers.get("agent_settled")({}, b.ctx);
	await b.commands.get("goal").handler("pause", b.ctx);
	t.mock.timers.tick(3);
	assert.deepEqual(a.messages.map((message) => [message.details.kind, message.details.goal.objective]), [
		["active", "goal A"], ["continuation", "goal A"],
	]);
	assert.deepEqual(b.messages.map((message) => message.details.kind), ["active", "paused"]);
});

test("/goal cadence resets the delay of an already scheduled continuation", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const s = session();
	s.start();
	await s.create("finish the task", "30m");
	s.ctx.isIdle = () => true;
	s.handlers.get("agent_settled")({}, s.ctx);
	await s.commands.get("goal").handler("cadence 60m", s.ctx);

	t.mock.timers.tick(30 * 60_000);
	assert.deepEqual(s.messages.map((message) => message.details.kind), ["active"]);
	t.mock.timers.tick(30 * 60_000);
	assert.deepEqual(s.messages.map((message) => message.details.kind), ["active", "continuation"]);
});
