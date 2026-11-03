/**
 * Unit harness for the steer-background-tool plugin.
 *
 * Drives `apply()` with a stub Cordis context so the config branches and edge
 * cases that are hard to arrange live can be exercised deterministically.
 *
 * Run: node --test test/   (or: npm test)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN = join(HERE, '..', 'index.js');
const { apply } = await import(pathToFileURL(PLUGIN).href);

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** One isolated plugin instance with a stub context. */
function harness(config = {}, options = {}) {
	const handlers = new Map();
	const warnings = [];
	const sections = [];
	const started = [];
	let disposer;

	// A tool whose definition the plugin may wrap, mirroring defineTool's shape.
	const definition = {
		name: options.toolName ?? 'bash',
		description: 'stub',
		parameters: { type: 'object', properties: {} },
		output: {
			schema: options.schema ?? {
				type: 'object',
				properties: { cwd: { type: 'string' }, exitCode: { type: 'number' } },
				required: ['cwd'],
			},
			render: (_args, value) => [{ type: 'text', text: `rendered:${JSON.stringify(value)}` }],
		},
		execute: () =>
			new Promise((resolve) => {
				// Resolved by the test, so "still running after release" is provable.
				definition.__resolve = resolve;
				definition.__reject = (error) => {
					throw error;
				};
			}),
	};
	if (options.execute !== undefined) definition.execute = options.execute;

	const ctx = {
		on(event, handler) {
			handlers.set(event, handler);
			return () => handlers.delete(event);
		},
		effect(fn) {
			disposer = fn();
			return () => {};
		},
		logger: {
			info: () => {},
			warn: (message) => warnings.push(message),
		},
		systemPrompt: {
			getSectionOrder: () => 1600,
			section: (spec) => sections.push(spec),
		},
		tools: {
			get: (name) => (name === definition.name ? definition : undefined),
		},
		jobs: {
			start(spec) {
				if (options.startThrows === true) throw new Error('no job controller serves this agent');
				const id = `tool-stub-${started.length + 1}`;
				const handle = { id, append() {}, updateProgress() {} };
				const hooks = spec.run(handle);
				started.push({ id, spec, hooks });
				return id;
			},
		},
	};

	apply(ctx, config);

	return { handlers, warnings, sections, started, definition, options, dispose: () => disposer?.() };
}

/** A user-authored steer message already queued for the next step. */
function steerMessage(id = 'm1') {
	return {
		id,
		role: 'user',
		content: [{ type: 'text', text: 'user steer' }],
		source: { kind: 'user', rpcId: 'rpc-1' },
	};
}

function agentWith(message, queue = 'nextStep') {
	return {
		id: 'agent-1',
		inbox: { nextStep: queue === 'nextStep' ? [message] : [], nextTurn: queue === 'nextTurn' ? [message] : [] },
		steer() {},
	};
}

/** Start one dispatch through the plugin's waterfall listener. */
function dispatch(h, agent, execOverrides = {}) {
	const exec = {
		name: h.definition.name,
		callId: 'call-1',
		arguments: { command: 'x' },
		agent,
		signal: new AbortController().signal,
		...execOverrides,
	};
	const next = async () => {
		try {
			const value = await h.definition.execute(exec.arguments, exec);
			return { isError: false, value, content: [] };
		} finally {
			// The real registry restores exec.signal in a finally block; once
			// notifyResult has frozen the record that assignment throws, so the
			// released promise rejects even though the tool succeeded.
			if (h.options?.emulateFrozenExec === true) exec.signal = new AbortController().signal;
		}
	};
	const settled = h.handlers.get('tools/execute')(exec, next);
	return { exec, settled };
}

/** Deliver the steer event the way the inbox does while a call is in flight. */
function deliver(h, agent, message) {
	h.handlers.get('agent/inbox/inserted')({ agent, message });
}

// ---------------------------------------------------------------------------
// 1. Normal call: pass-through, no job, signal untouched.
// ---------------------------------------------------------------------------
test('pass-through when no steer is queued', async () => {
	const h = harness();
	const agent = agentWith(steerMessage(), 'nextStep');
	const { settled } = dispatch(h, agent);
	h.definition.__resolve({ cwd: '/tmp' });
	const result = await settled;
	assert.equal(result.isError, false);
	assert.deepEqual(result.value, { cwd: '/tmp' });
	assert.equal(h.started.length, 0, 'no job should be started');
});

// ---------------------------------------------------------------------------
// 2. Steer during a call: released immediately, body keeps running.
// ---------------------------------------------------------------------------
test('backgrounds on steer and releases the step while the body runs', async () => {
	const h = harness();
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	const { exec, settled } = dispatch(h, agent);
	deliver(h, agent, message);

	// The step must not wait for the body.
	const released = await Promise.race([
		settled.then((value) => value),
		new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 150)),
	]);
	assert.notEqual(released, 'TIMEOUT', 'the dispatch should be released immediately');
	assert.equal(released.isError, false, 'success path, not a failure card');
	assert.match(released.content[0].text, /moved to the background/);
	assert.match(released.content[0].text, /tool-stub-1/);
	assert.equal(h.started.length, 1);

	// The replacement content is applied to the recorded result.
	const post = h.handlers.get('tools/post-execute');
	assert.ok(post !== undefined, 'post-execute listener registered');
	const decided = await post(exec, released, () => Promise.resolve({ kind: 'accept' }));
	assert.equal(decided.kind, 'accept');
	assert.match(decided.content[0].text, /moved to the background/);

	// Body still running, so the job is not settled yet.
	h.definition.__resolve({ cwd: '/work' });
	const outcome = await h.started[0].hooks.done;
	assert.equal(outcome.status, 'completed');
	assert.match(outcome.result, /rendered:\{"cwd":"\/work"\}/, 'job carries the tool-rendered output');
});

// ---------------------------------------------------------------------------
// 2b. The frozen record: why the definition wrapper exists.
// ---------------------------------------------------------------------------
test('recovers the real output although the registry freezes the record', async () => {
	// Without the pass-through wrapper on tool.execute, a released dispatch can no
	// longer carry its value: the registry freezes exec once the call is reported,
	// so the abandoned chain rejects in its own cleanup and the job would have to
	// report "output is unavailable". This pins the wrapper as load-bearing.
	const h = harness({}, { emulateFrozenExec: true });
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	const { exec, settled } = dispatch(h, agent);

	deliver(h, agent, message);
	const synthetic = await settled;
	assert.equal(synthetic.isError, false, 'the step is released with a synthetic success');

	Object.freeze(exec); // what notifyResult does before the tool settles
	h.definition.__resolve({ cwd: '/after-freeze' });

	const outcome = await h.started[0].hooks.done;
	assert.equal(outcome.status, 'completed');
	assert.match(String(outcome.result), /after-freeze/, 'the real value must survive the freeze');
});

// ---------------------------------------------------------------------------
// 3. Steer queued for the next TURN is a follow-up, not a steer.
// ---------------------------------------------------------------------------
test('ignores a follow-up queued for the next turn', async () => {
	const h = harness();
	const agent = agentWith(steerMessage(), 'nextTurn');
	const { settled } = dispatch(h, agent);
	h.definition.__resolve({ cwd: '/x' });
	await settled;
	assert.equal(h.started.length, 0, 'a follow-up must not background the call');
});

// ---------------------------------------------------------------------------
// 4. `alsoFollowup` opts in.
// ---------------------------------------------------------------------------
test('alsoFollowup:true also backgrounds for a follow-up', async () => {
	const h = harness({ alsoFollowup: true });
	const message = steerMessage();
	const agent = agentWith(message, 'nextTurn');
	const { settled } = dispatch(h, agent);
	deliver(h, agent, message);
	const result = await Promise.race([settled, tick().then(() => 'PENDING')]);
	assert.notEqual(result, 'PENDING');
	assert.match(result.content[0].text, /moved to the background/);
});

// ---------------------------------------------------------------------------
// 5. Plugin notices are not user messages.
// ---------------------------------------------------------------------------
test('ignores non-user message sources', async () => {
	for (const source of [
		{ kind: 'user', form: 'notice' },
		{ kind: 'tool-jobs', form: 'notice' },
		{ kind: 'goal' },
		{ kind: 'runtime-context' },
	]) {
		const h = harness();
		const message = { id: 'm1', role: 'user', content: [{ type: 'text', text: 'notice' }], source };
		const agent = agentWith(message, 'nextStep');
		const { settled } = dispatch(h, agent);
		deliver(h, agent, message);
		h.definition.__resolve({ cwd: '/x' });
		await settled;
		assert.equal(h.started.length, 0, `source ${JSON.stringify(source)} must not background the call`);
	}
});

// ---------------------------------------------------------------------------
// 6. Scope: only shell commands are backgrounded.
// ---------------------------------------------------------------------------
test('a tool outside includeTools stays in the foreground', async () => {
	const h = harness({ includeTools: [] });
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	const { settled } = dispatch(h, agent);
	deliver(h, agent, message);
	h.definition.__resolve({ cwd: '/x' });
	const result = await settled;
	assert.equal(h.started.length, 0);
	assert.equal(result.isError, false);
	assert.equal(result.value.cwd, '/x', 'the real result must come through');
});

test('a non-shell tool is never backgrounded, even with a pending steer', async () => {
	// The default allowlist is bash/pwsh: releasing anything else would break the
	// step's assumptions (an edit not yet written, a result the prompt needs now).
	const h = harness({}, { toolName: 'edit' });
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	const { settled } = dispatch(h, agent);
	deliver(h, agent, message);
	h.definition.__resolve({ cwd: '/x' });
	const result = await settled;
	assert.equal(h.started.length, 0, 'no job may be opened for a non-shell tool');
	assert.equal(result.isError, false);
	assert.equal(result.value.cwd, '/x');
});

test('pwsh is in the default allowlist', async () => {
	const h = harness({}, { toolName: 'pwsh' });
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	const { settled } = dispatch(h, agent);
	deliver(h, agent, message);
	const result = await Promise.race([settled, tick().then(() => 'PENDING')]);
	assert.notEqual(result, 'PENDING', 'the step must be released for a shell command');
	assert.equal(h.started.length, 1);
	assert.equal(h.started[0].spec.kind, 'tool');
});

// ---------------------------------------------------------------------------
// 7. minInFlightMs gate.
// ---------------------------------------------------------------------------
test('minInFlightMs keeps a just-started call in the foreground', async () => {
	const h = harness({ minInFlightMs: 60_000 });
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	const { settled } = dispatch(h, agent);
	deliver(h, agent, message);
	h.definition.__resolve({ cwd: '/x' });
	const result = await settled;
	assert.equal(h.started.length, 0, 'a call younger than the threshold must not be backgrounded');
	assert.equal(result.value.cwd, '/x');
});

// ---------------------------------------------------------------------------
// 8. maxJobsPerSteer cap.
// ---------------------------------------------------------------------------
test('maxJobsPerSteer caps how many calls one steer backgrounds', async () => {
	const h = harness({ maxJobsPerSteer: 1 });
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	// Two calls in flight, both tracked before the steer is delivered.
	const first = dispatch(h, agent, { callId: 'call-a' });
	const second = dispatch(h, agent, { callId: 'call-b' });
	h.handlers.get('agent/inbox/inserted')({ agent, message });
	const a = await Promise.race([first.settled, tick().then(() => 'PENDING')]);
	const b = await Promise.race([second.settled, tick().then(() => 'PENDING')]);
	const released = [a, b].filter(
		(entry) => entry !== 'PENDING' && /moved to the background/.test(entry.content?.[0]?.text ?? ''),
	);
	assert.equal(h.started.length, 1, 'exactly one job');
	assert.equal(released.length, 1, 'exactly one call released');
});

// ---------------------------------------------------------------------------
// 9. jobs.start failure falls back to the foreground.
// ---------------------------------------------------------------------------
test('a failing jobs.start leaves the call in the foreground', async () => {
	const h = harness({}, { startThrows: true });
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	const { settled } = dispatch(h, agent);
	deliver(h, agent, message);
	h.definition.__resolve({ cwd: '/x' });
	const result = await settled;
	assert.equal(result.isError, false);
	assert.equal(result.value.cwd, '/x', 'the real result must survive');
	assert.equal(h.warnings.length, 1);
	assert.match(h.warnings[0], /could not background/);
});

// ---------------------------------------------------------------------------
// 10. Nested sub-dispatch is skipped.
// ---------------------------------------------------------------------------
test('skips nested sub-dispatches', async () => {
	const h = harness();
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	const { settled } = dispatch(h, agent, { parent: { callId: 'parent' } });
	deliver(h, agent, message);
	h.definition.__resolve({ cwd: '/x' });
	const result = await settled;
	assert.equal(h.started.length, 0);
	assert.equal(result.value.cwd, '/x');
});

// ---------------------------------------------------------------------------
// 11. Synthesized value honours const / enum / oneOf / nested objects.
// ---------------------------------------------------------------------------
test('synthesizes a schema-valid placeholder value', async () => {
	const schemas = [
		{ type: 'object', properties: { mode: { const: 'quiet' } }, required: ['mode'] },
		{ type: 'object', properties: { level: { enum: ['low', 'high'] } }, required: ['level'] },
		{ type: 'object', properties: { kind: { oneOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['kind'] },
		{
			type: 'object',
			properties: { inner: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } },
			required: ['inner'],
		},
		{ type: 'array' },
		{ type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
	];
	for (const schema of schemas) {
		const h = harness({}, { schema });
		const message = steerMessage();
		const agent = agentWith(message, 'nextStep');
		const { settled } = dispatch(h, agent);
		deliver(h, agent, message);
		const result = await Promise.race([settled, tick().then(() => 'PENDING')]);
		assert.notEqual(result, 'PENDING', `schema ${JSON.stringify(schema)} must still release the step`);
		assert.equal(result.isError, false, `schema ${JSON.stringify(schema)} should take the success path`);
		assert.equal(h.started.length, 1);
	}
});

// ---------------------------------------------------------------------------
// 12. An unmodellable schema falls back to the failure shape with my content.
// ---------------------------------------------------------------------------
test('falls back to the failure shape for an unsupported schema', async () => {
	const h = harness(
		{},
		{ schema: { type: 'object', properties: { x: { type: 'string', pattern: '^a' } }, required: ['x'] } },
	);
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	const { settled } = dispatch(h, agent);
	deliver(h, agent, message);
	const result = await Promise.race([settled, tick().then(() => 'PENDING')]);
	assert.equal(result.isError, true, 'must not risk an invalid success value');
	assert.match(result.content[0].text, /moved to the background/);
	assert.equal(result.error.info.code, 'BACKGROUNDED');
	const post = h.handlers.get('tools/post-execute');
	const decided = await post({ __fake: true }, result, () => Promise.resolve({ kind: 'accept' }));
	assert.equal(decided.kind, 'accept', 'a non-recorded call must not be touched');
});

// ---------------------------------------------------------------------------
// 13. Kill settles the job and aborts the body.
// ---------------------------------------------------------------------------
test('kill settles the job as killed and aborts the body', async () => {
	let seenSignal;
	const h = harness(
		{},
		{
			execute: (_args, exec) => {
				seenSignal = exec.signal;
				return new Promise((_resolve, reject) => {
					exec.signal.addEventListener('abort', () => reject(new Error('aborted by kill')), { once: true });
				});
			},
		},
	);
	const message = steerMessage();
	const agent = agentWith(message, 'nextStep');
	dispatch(h, agent);
	deliver(h, agent, message);
	await tick();
	assert.equal(h.started.length, 1);
	assert.equal(seenSignal.aborted, false, 'the composite signal must not start aborted');
	h.started[0].hooks.cancel('test reason');
	assert.equal(seenSignal.aborted, true, 'cancel must abort the body signal');
	const outcome = await h.started[0].hooks.done;
	assert.equal(outcome.status, 'killed');
	assert.equal(outcome.detail, undefined, 'detail comes from the registry killReason, not duplicated');
});

// ---------------------------------------------------------------------------
// 14. Caller cancellation is preserved through the composite signal.
// ---------------------------------------------------------------------------
test('preserves caller cancellation', async () => {
	let seenSignal;
	const h = harness(
		{},
		{
			execute: (_args, exec) => {
				seenSignal = exec.signal;
				return Promise.resolve({ cwd: '/x' });
			},
		},
	);
	const caller = new AbortController();
	const agent = agentWith(steerMessage(), 'nextStep');
	const { settled } = dispatch(h, agent, { signal: caller.signal });
	await settled;
	assert.ok(seenSignal !== undefined, 'the body saw a signal');
	caller.abort(new Error('caller cancelled'));
	assert.equal(seenSignal.aborted, true, 'caller abort must reach the body');
});

// ---------------------------------------------------------------------------
// 15. The execution record's signal is restored.
// ---------------------------------------------------------------------------
test('restores exec.signal after the dispatch settles', async () => {
	const h = harness();
	const original = new AbortController().signal;
	const agent = agentWith(steerMessage(), 'nextStep');
	const { exec, settled } = dispatch(h, agent, { signal: original });
	h.definition.__resolve({ cwd: '/x' });
	await settled;
	await tick();
	assert.equal(exec.signal, original, 'exec.signal must be restored');
});

// ---------------------------------------------------------------------------
// 16. Dispose restores the wrapped execute.
// ---------------------------------------------------------------------------
test('dispose restores the original tool execute', async () => {
	const h = harness({}, { execute: () => Promise.resolve({ cwd: '/x' }) });
	const original = h.definition.execute;
	const agent = agentWith(steerMessage(), 'nextStep');
	const { settled } = dispatch(h, agent);
	await settled;
	assert.notEqual(h.definition.execute, original, 'dispatch must install the capture wrapper');
	h.dispose();
	assert.equal(h.definition.execute, original, 'the original execute must be back');
});

// ---------------------------------------------------------------------------
// 17. disabled.
// ---------------------------------------------------------------------------
test('enabled:false registers nothing', async () => {
	const h = harness({ enabled: false });
	assert.equal(h.handlers.size, 0);
	assert.equal(h.sections.length, 0);
});

// ---------------------------------------------------------------------------
// 18. Guidance section placement.
// ---------------------------------------------------------------------------
test('adds the guidance section right after TOOL_JOBS', async () => {
	const h = harness();
	assert.equal(h.sections.length, 1);
	assert.equal(h.sections[0].order, 1610);
	assert.match(h.sections[0].text, /job_output/);
});

test('guidance:false omits the section', async () => {
	const h = harness({ guidance: false });
	assert.equal(h.sections.length, 0);
});

// ---------------------------------------------------------------------------
// 19. Degenerate inputs must not throw.
// ---------------------------------------------------------------------------
test('survives malformed invocations', async () => {
	const h = harness();
	const waterfall = h.handlers.get('tools/execute');
	const pass = () => Promise.resolve({ isError: false, value: {}, content: [] });
	await waterfall({ name: 'bash', agent: undefined, arguments: {} }, pass);
	await waterfall({ name: '', agent: { id: 'a' }, arguments: {} }, pass);
	await waterfall(null, pass);
	h.handlers.get('agent/inbox/inserted')(undefined);
	h.handlers.get('agent/inbox/inserted')({});
	h.handlers.get('agent/disposed')({});
	assert.equal(h.started.length, 0);
});
