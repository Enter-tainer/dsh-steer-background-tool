/**
 * Steer → Background Tool.
 *
 * The agent loop runs a turn as a sequence of steps. A step is one model
 * request plus the tool calls it asked for, and the *next* step is where a
 * queued user message (a "steer") is admitted. So while a step is awaiting a
 * long tool call the steer cannot reach the model at all: the user's message
 * waits behind the tool.
 *
 * This plugin removes that coupling. When a human steer lands while a tool call
 * is still in flight it:
 *
 *   1. registers the already-running call as a background job (`ctx.jobs`),
 *   2. answers the tool call immediately with a short "moved to background"
 *      result, which lets the step finish so the loop admits the steer,
 *   3. keeps watching the real call, and settles the job with the tool's own
 *      output, so `job_output` returns it and the usual
 *      `@deepseek-ai/dsh-tool-jobs` completion notice reaches the model later.
 *
 * The work itself is never cancelled or restarted: the same call keeps running,
 * so no side effect is lost and none is repeated.
 *
 * Two harness details shape the implementation:
 *
 * - A tool call must be answered. The transcript is a strict tool_use /
 *   tool_result pairing, so the replacement is a synthetic result rather than
 *   "no result".
 * - `dispatchToolBody` restores `exec.signal` in a `finally`, and the registry
 *   freezes `exec` once the (already released) dispatch is reported. That
 *   abandoned promise therefore rejects even when the tool succeeded, and its
 *   value is unreachable. The real output is captured instead by passing the
 *   tool's own `execute` promise through a transparent wrapper, which the
 *   freeze never touches.
 *
 * @module @local/steer-background-tool
 */

/** Loader-row defaults; override through the row's `config` in cordis.patch.yml. */
const DEFAULTS = {
	/** Master switch. */
	enabled: true,
	/** Only background calls that have been running at least this long (ms). */
	minInFlightMs: 0,
	/** Upper bound on jobs opened by a single steer. */
	maxJobsPerSteer: 4,
	/** Advisory cap on each job's model-facing output; 0 disables the cap. */
	outputLimitBytes: 65536,
	/** Tool names that must never be backgrounded. */
	excludeTools: [],
	/** Add a system-prompt section describing the behaviour to the model. */
	guidance: true,
	/** Background for a queued follow-up (next turn) as well as a steer (next step). */
	alsoFollowup: false,
};

/**
 * JSON-Schema keywords this plugin is willing to synthesise a value for.
 * Anything else makes the value unverifiable, and the synthetic result falls
 * back to the failure shape, whose content the registry passes through as-is.
 */
const SAFE_SCHEMA_KEYWORDS = new Set([
	'type',
	'const',
	'enum',
	'oneOf',
	'properties',
	'required',
	'additionalProperties',
	'items',
	'description',
	'title',
	'default',
	'examples',
]);

/** Longest label kept for a background job (the client renders it as a command). */
const MAX_LABEL_DETAIL = 72;

export const name = 'steer-background-tool';

export const inject = ['jobs', 'tools', 'systemPrompt'];

/**
 * Register the steer-to-background behaviour.
 * @param ctx - the plugin's Cordis context.
 * @param rawConfig - the Loader row's `config` object, unvalidated.
 */
export function apply(ctx, rawConfig) {
	const config = normalizeConfig(rawConfig);
	if (!config.enabled) return;

	/** Agent session id -> (tool call id -> in-flight call). */
	const flights = new Map();
	/** Dispatched call -> the "moved to background" text that replaces its content. */
	const replacements = new WeakMap();
	/** Dispatched call -> the tool's own `execute` promise, immune to the exec freeze. */
	const bodies = new WeakMap();
	/** Tool definition -> the `execute` it had before the pass-through wrapper. */
	const patched = new Map();
	/** Messages already acted on, so a queue edit cannot background twice. */
	const handled = new WeakSet();

	if (config.guidance) {
		const base = ctx.systemPrompt.getSectionOrder('TOOL_JOBS');
		ctx.systemPrompt.section({
			name: 'tool:steer-background',
			order: typeof base === 'number' ? base + 10 : 1610,
			text: 'A tool call you started can be moved to the background while it is still running, when the user sends a new message first. Its result is then replaced by a short notice naming a background job id, and the user message arrives in the next step. That is not a failure and the work was not cancelled: do not run the same call again. The real output is kept by the job — read it with job_output and that id, exactly like any other background job, and expect a completion notice when it settles.',
		});
	}

	ctx.effect(
		() => () => {
			flights.clear();
			for (const [definition, execute] of patched) {
				try {
					definition.execute = execute;
				} catch {
					// A definition frozen by a future harness: nothing to restore.
				}
			}
			patched.clear();
		},
		'steer-background-tool: in-flight calls and dispatch wrappers',
	);

	// ---------------------------------------------------------------------
	// 1. Track every tool dispatch, and remember the tool's own promise.
	// ---------------------------------------------------------------------
	ctx.on('tools/execute', (exec, next) => {
		const agent = exec?.agent;
		if (agent === undefined || agent === null) return next();
		if (typeof exec.name !== 'string' || exec.name.length === 0) return next();
		// Nested sub-dispatches (run_code's SDK) answer their caller, not the
		// model, so replying with a backgrounded placeholder would be wrong.
		if (exec.parent !== undefined) return next();
		if (config.excludeTools.includes(exec.name)) return next();

		const tool = getTool(ctx, exec.name, agent);
		if (tool !== undefined) captureBody(tool);

		const flight = {
			exec,
			agent,
			tool,
			callId: exec.callId,
			rootCallId: exec.rootCallId ?? exec.callId,
			name: exec.name,
			args: exec.arguments,
			startedAt: Date.now(),
			controller: new AbortController(),
			jobId: undefined,
			convertedAt: 0,
			work: undefined,
			detach: undefined,
			resolveDetach: undefined,
		};
		flight.detach = new Promise((resolve) => {
			flight.resolveDetach = resolve;
		});

		// A `tools/execute` wrapper may replace `exec.signal`, and the registry
		// re-fuses the caller signal, so callers keep their cancellation. The
		// composite only adds our own abort channel, used when the job is killed.
		const originalSignal = exec.signal;
		if (originalSignal !== undefined) {
			try {
				exec.signal = AbortSignal.any([originalSignal, flight.controller.signal]);
			} catch {
				// AbortSignal.any unavailable: keep the caller signal.
			}
		}

		let work;
		try {
			work = Promise.resolve(next());
		} catch (error) {
			try {
				exec.signal = originalSignal;
			} catch {
				// Already frozen.
			}
			throw error;
		}
		flight.work = work;

		// Best effort only: after a release the registry has already frozen `exec`,
		// so the assignment is expected to fail and must not become a rejection.
		const restoreSignal = () => {
			try {
				exec.signal = originalSignal;
			} catch {
				// Frozen, or another wrapper owns it now.
			}
		};
		work.then(restoreSignal, restoreSignal);

		const perAgent = flightsFor(flights, agent.id);
		perAgent.set(flight.callId, flight);
		const forget = () => {
			perAgent.delete(flight.callId);
			if (perAgent.size === 0) flights.delete(agent.id);
		};
		work.then(forget, forget);

		// Normal case: `work` settles first and this is a pass-through. When the
		// call is backgrounded, `detach` wins so the step stops waiting for the
		// body, which keeps running.
		return Promise.race([work, flight.detach]);
	});

	// ---------------------------------------------------------------------
	// 2. Replace the recorded content of a backgrounded call.
	// ---------------------------------------------------------------------
	ctx.on('tools/post-execute', (exec, result, next) => {
		const text = replacements.get(exec);
		if (text === undefined) return next();
		replacements.delete(exec);
		return Promise.resolve(next()).then((decision) => {
			// Never fight another plugin's block: its feedback is corrective.
			if (decision !== null && typeof decision === 'object' && decision.kind === 'block') return decision;
			const { value: _value, content: _content, ...rest } = decision ?? {};
			return { ...rest, kind: 'accept', content: [{ type: 'text', text }] };
		});
	});

	// ---------------------------------------------------------------------
	// 3. React to a human steer.
	// ---------------------------------------------------------------------
	ctx.on('agent/inbox/inserted', (payload) => {
		try {
			const agent = payload?.agent;
			const message = payload?.message;
			if (agent === undefined || message === undefined) return;
			if (handled.has(message)) return;
			if (!isHumanMessage(agent, message, config.alsoFollowup)) return;
			handled.add(message);

			const perAgent = flights.get(agent.id);
			if (perAgent === undefined || perAgent.size === 0) return;

			const now = Date.now();
			let detached = 0;
			for (const flight of perAgent.values()) {
				if (detached >= config.maxJobsPerSteer) break;
				if (flight.convertedAt !== 0) continue;
				if (now - flight.startedAt < config.minInFlightMs) continue;
				if (detachFlight(flight)) detached++;
			}
			if (detached > 0) {
				ctx.logger?.info?.(
					`steer-background-tool: backgrounded ${detached} in-flight tool call(s) so the steer is not blocked`,
				);
			}
		} catch (error) {
			ctx.logger?.warn?.(`steer-background-tool: steering hook failed: ${messageOf(error)}`);
		}
	});

	ctx.on('agent/disposed', ({ agent }) => {
		if (agent !== undefined) flights.delete(agent.id);
	});

	// ---------------------------------------------------------------------
	// Implementation
	// ---------------------------------------------------------------------

	/**
	 * Wrap a tool definition so its own `execute` promise is observable.
	 *
	 * The registry freezes the execution record once a dispatch is reported, so
	 * the promise returned by the dispatch chain can no longer carry the value.
	 * This wrapper is a transparent pass-through: it returns the tool's promise
	 * untouched and only remembers it.
	 * @param tool - the resolved tool definition.
	 */
	function captureBody(tool) {
		if (patched.has(tool)) return;
		const execute = tool.execute;
		if (typeof execute !== 'function') return;
		try {
			tool.execute = function executeCaptured(args, exec) {
				const body = execute.call(this, args, exec);
				if (exec !== null && typeof exec === 'object') bodies.set(exec, body);
				return body;
			};
		} catch {
			return;
		}
		patched.set(tool, execute);
	}

	/**
	 * Move one in-flight call to a background job and release the step.
	 * @param flight - the tracked dispatch.
	 * @returns whether the call was backgrounded.
	 */
	function detachFlight(flight) {
		const registry = ctx.jobs;
		if (registry === undefined) return false;

		let jobId;
		try {
			jobId = registry.start({
				kind: 'tool',
				label: labelFor(flight),
				owner: flight.agent.id,
				toolCall: { callId: flight.callId, rootCallId: flight.rootCallId },
				...(config.outputLimitBytes > 0 ? { outputLimitBytes: config.outputLimitBytes } : {}),
				run: (handle) => runDetached(flight, handle),
			});
		} catch (error) {
			// No controller, owner gone, or the per-owner job cap is full: leave the
			// call in the foreground rather than losing its result.
			ctx.logger?.warn?.(`steer-background-tool: could not background tool call "${flight.name}": ${messageOf(error)}`);
			return false;
		}

		flight.jobId = jobId;
		flight.convertedAt = Date.now();

		const text = backgroundNotice(flight, jobId);
		replacements.set(flight.exec, text);
		flight.resolveDetach(backgroundedResult(flight, text));
		return true;
	}

	/**
	 * Expose the already-running call as a job.
	 * @param flight - the tracked dispatch.
	 * @param handle - the registry's job handle.
	 * @returns the producer hooks; `done` never rejects and `cancel` always settles it.
	 */
	function runDetached(flight, handle) {
		let settled = false;
		let cancelled = false;
		let finalize;
		const done = new Promise((resolve) => {
			finalize = resolve;
		});
		const settle = (outcome) => {
			if (settled) return;
			settled = true;
			finalize(outcome);
		};

		try {
			handle.updateProgress(`running: ${flight.name}`);
		} catch {
			// Progress is cosmetic.
		}

		void (async () => {
			try {
				const body = bodies.get(flight.exec);
				if (body === undefined) {
					// The wrapper was not in place before the body started, so the value
					// is unreachable; still wait for the released dispatch to settle so
					// the job reports a truthful completion time.
					try {
						const released = await flight.work;
						settle({ status: 'completed', result: contentToText(released?.content) });
					} catch (error) {
						settle(
							isReleasedRecordError(error)
								? {
										status: 'completed',
										result:
											'(the tool finished, but the harness released this call record, so its output is unavailable)',
									}
								: { status: 'failed', detail: messageOf(error), result: `Tool call failed: ${messageOf(error)}` },
						);
					}
					return;
				}

				const value = await body;
				if (cancelled) return;
				settle({ status: 'completed', result: renderOutput(flight, value) });
			} catch (error) {
				if (cancelled) return;
				const detail = messageOf(error);
				settle({ status: 'failed', detail, result: `Tool call failed: ${detail}` });
			}
		})();

		return {
			cancel: (reason) => {
				if (settled) return;
				cancelled = true;
				try {
					flight.controller.abort(new Error(reason ?? 'background tool call cancelled'));
				} catch {
					// The body may already have finished.
				}
				// No `detail`: the registry reports `killReason` itself, and supplying
				// both duplicates the reason in the job's detail.
				settle({ status: 'killed' });
			},
			done,
		};
	}

	/**
	 * Build the replacement result for a backgrounded call.
	 *
	 * A *successful* dispatch result is re-derived by the registry from its
	 * `value` through the tool's own output schema and renderer, so the value has
	 * to be schema-valid or the whole result is replaced by a schema error. When
	 * a value can be synthesised and verified the success shape is used, and the
	 * recorded content is replaced in `tools/post-execute`. Otherwise the failure
	 * shape is the only one whose content passes through verbatim.
	 * @param flight - the tracked dispatch.
	 * @param text - the model-facing explanation.
	 * @returns the synthetic dispatch result.
	 */
	function backgroundedResult(flight, text) {
		const synthesized = synthesizeValue(flight);
		if (synthesized !== undefined) {
			return { isError: false, value: synthesized, content: [{ type: 'text', text }] };
		}
		return {
			isError: true,
			error: {
				message: 'tool call moved to the background while it was still running',
				info: { name: 'ToolBackgrounded', code: 'BACKGROUNDED' },
			},
			content: [{ type: 'text', text }],
		};
	}

	/**
	 * Produce a value the tool's output contract accepts, or `undefined`.
	 * @param flight - the tracked dispatch, for its tool definition and arguments.
	 * @returns a verified JSON value.
	 */
	function synthesizeValue(flight) {
		const tool = flight.tool ?? getTool(ctx, flight.name, flight.agent);
		const schema = tool?.output?.schema;
		if (schema === undefined) return undefined;

		const generated = generateValue(schema, 0);
		if (generated === undefined) return undefined;
		if (!isValidValue(schema, generated, 0)) return undefined;

		// Mirror `createSuccessResult`, so a renderer or metadata projector that
		// disagrees cannot turn this into an opaque output error.
		try {
			const rendered = tool.output.render(flight.args, generated);
			if (rendered === undefined) return undefined;
		} catch {
			return undefined;
		}
		if (typeof tool.output.presentationMeta === 'function') {
			try {
				tool.output.presentationMeta(flight.args, generated);
			} catch {
				return undefined;
			}
		}
		return generated;
	}
}

// ---------------------------------------------------------------------------
// Tool registry access
// ---------------------------------------------------------------------------

/**
 * Resolve a tool definition without letting a registry lookup break dispatch.
 * @param ctx - the plugin context.
 * @param toolName - the tool name.
 * @param agent - the calling agent.
 * @returns the definition, or `undefined`.
 */
function getTool(ctx, toolName, agent) {
	try {
		return ctx.tools.get(toolName, agent);
	} catch {
		return undefined;
	}
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Output rendering
// ---------------------------------------------------------------------------

/**
 * Render the tool's own value into the text the job reports.
 * @param flight - the tracked dispatch.
 * @param value - the tool's returned value.
 * @returns the reported text.
 */
function renderOutput(flight, value) {
	const tool = flight.tool;
	if (tool?.output !== undefined && typeof tool.output.render === 'function') {
		try {
			return contentToText(tool.output.render(flight.args, value));
		} catch {
			// Fall through to the raw value.
		}
	}
	try {
		const text = JSON.stringify(value);
		return typeof text === 'string' ? text : '(no output)';
	} catch {
		return '(no output)';
	}
}

/**
 * The model-facing explanation that stands in for the tool's result.
 * @param flight - the tracked dispatch.
 * @param jobId - the registry-issued job id.
 * @returns the notice text.
 */
function backgroundNotice(flight, jobId) {
	return [
		`Tool call \`${flight.name}\` was still running when a new user message arrived, so it was moved to the background.`,
		`It did NOT fail and was not cancelled — do not call \`${flight.name}\` again for the same work.`,
		'',
		`Background job id: ${jobId}`,
		`- Read its output: job_output with job_id "${jobId}" (add wait: true only if you are blocked on it).`,
		`- List or stop your background jobs: job_list, job_kill.`,
		'',
		"The user's new message is delivered in the next step. Answer it now; a completion notice arrives when this job settles.",
	].join('\n');
}

/**
 * A short, single-line job label; the client renders it like a command.
 * @param flight - the tracked dispatch.
 * @returns the label.
 */
function labelFor(flight) {
	let detail = '';
	const args = flight.args;
	if (typeof args === 'string') {
		detail = args;
	} else if (args !== null && typeof args === 'object') {
		for (const key of ['command', 'cmd', 'script', 'prompt', 'description', 'path', 'file_path', 'query', 'url']) {
			if (typeof args[key] === 'string' && args[key].length > 0) {
				detail = args[key];
				break;
			}
		}
		if (detail.length === 0) detail = compactJson(args);
	}
	detail = String(detail).replace(/\s+/g, ' ').trim();
	if (detail.length > MAX_LABEL_DETAIL) detail = `${detail.slice(0, MAX_LABEL_DETAIL - 1)}…`;
	return detail.length === 0 ? `${flight.name} (backgrounded)` : `${flight.name}: ${detail}`;
}

// Message provenance
// ---------------------------------------------------------------------------

/**
 * Decide whether a message is the user speaking to the agent.
 *
 * The harness records provenance in `message.source.kind`; plugin notices use
 * their own kinds (`tool-jobs`, `goal`, `subagent-settled`, …) and carry a
 * `form`. A real prompt uses `kind: 'user'`. Steer and follow-up are otherwise
 * identical, so the queue the message landed in is what tells them apart.
 * @param agent - the agent that received the message.
 * @param message - the inserted user message.
 * @param alsoFollowup - accept a message queued for the next turn too.
 * @returns whether the message should unblock a running tool call.
 */
function isHumanMessage(agent, message, alsoFollowup) {
	if (message === null || typeof message !== 'object') return false;
	if (message.role !== 'user') return false;
	const source = message.source;
	if (source === null || typeof source !== 'object') return false;
	if (source.kind !== 'user') return false;
	if (source.form !== undefined) return false;

	const inbox = agent?.inbox;
	const nextStep = inbox?.nextStep;
	if (Array.isArray(nextStep) && nextStep.some((queued) => queued?.id === message.id)) return true;
	if (!alsoFollowup) return false;
	const nextTurn = inbox?.nextTurn;
	return Array.isArray(nextTurn) && nextTurn.some((queued) => queued?.id === message.id);
}

// ---------------------------------------------------------------------------
// JSON-Schema helpers (the enforced subset only)
// ---------------------------------------------------------------------------

/**
 * Build the smallest value that satisfies a schema node.
 * @param schema - schema node.
 * @param depth - recursion guard.
 * @returns the value, or `undefined` when the node is outside the safe subset.
 */
function generateValue(schema, depth) {
	if (depth > 6) return undefined;
	if (!isRecord(schema)) return undefined;
	for (const key of Object.keys(schema)) if (!SAFE_SCHEMA_KEYWORDS.has(key)) return undefined;

	if (Object.hasOwn(schema, 'const')) return schema.const;
	if (Array.isArray(schema.enum)) return schema.enum.length === 0 ? undefined : schema.enum[0];
	if (Array.isArray(schema.oneOf)) {
		for (const branch of schema.oneOf) {
			const candidate = generateValue(branch, depth + 1);
			if (candidate !== undefined && isValidValue(branch, candidate, depth + 1)) return candidate;
		}
		return undefined;
	}

	switch (resolveType(schema)) {
		case 'object': {
			if (schema.required !== undefined && !Array.isArray(schema.required)) return undefined;
			const properties = isRecord(schema.properties) ? schema.properties : {};
			const value = {};
			for (const key of schema.required ?? []) {
				if (typeof key !== 'string' || !Object.hasOwn(properties, key)) return undefined;
				const child = generateValue(properties[key], depth + 1);
				if (child === undefined) return undefined;
				value[key] = child;
			}
			return value;
		}
		case 'array':
			return [];
		case 'string':
			return '';
		case 'number':
		case 'integer':
			return 0;
		case 'boolean':
			return false;
		case 'null':
			return null;
		default:
			return undefined;
	}
}

/**
 * Validate a value against the same subset, so a synthesized value is known to
 * satisfy the real registry validator before it is returned.
 * @param schema - schema node.
 * @param value - candidate value.
 * @param depth - recursion guard.
 * @returns whether the value conforms.
 */
function isValidValue(schema, value, depth) {
	if (depth > 6) return false;
	if (!isRecord(schema)) return false;
	for (const key of Object.keys(schema)) if (!SAFE_SCHEMA_KEYWORDS.has(key)) return false;

	if (Object.hasOwn(schema, 'const') && value !== schema.const) return false;
	if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
	if (Array.isArray(schema.oneOf)) return schema.oneOf.some((branch) => isValidValue(branch, value, depth + 1));

	const type = resolveType(schema);
	// A node carrying only `const`/`enum` (which matched above) is satisfied
	// without a declared type; anything else needs one.
	if (type === undefined) return Object.hasOwn(schema, 'const') || Array.isArray(schema.enum);

	switch (type) {
		case 'object': {
			if (!isRecord(value)) return false;
			const properties = isRecord(schema.properties) ? schema.properties : {};
			for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) return false;
			for (const [key, child] of Object.entries(value)) {
				const childSchema = properties[key];
				if (childSchema === undefined) {
					if (schema.additionalProperties !== true) return false;
					continue;
				}
				if (!isValidValue(childSchema, child, depth + 1)) return false;
			}
			return true;
		}
		case 'array':
			return Array.isArray(value);
		case 'string':
			return typeof value === 'string';
		case 'number':
			return typeof value === 'number' && Number.isFinite(value);
		case 'integer':
			return Number.isInteger(value);
		case 'boolean':
			return typeof value === 'boolean';
		case 'null':
			return value === null;
		default:
			return false;
	}
}

/**
 * Resolve a schema node's effective type.
 * @param schema - schema node.
 * @returns the JSON type, or `undefined` when it cannot be inferred.
 */
function resolveType(schema) {
	if (typeof schema.type === 'string') return schema.type;
	if (Array.isArray(schema.type)) {
		const concrete = schema.type.find((entry) => typeof entry === 'string' && entry !== 'null');
		return concrete ?? (schema.type.includes('null') ? 'null' : undefined);
	}
	if (isRecord(schema.properties) || Array.isArray(schema.required)) return 'object';
	if (schema.items !== undefined) return 'array';
	return undefined;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * Render content blocks as plain text.
 * @param content - the content blocks.
 * @returns the text a job reports.
 */
function contentToText(content) {
	if (!Array.isArray(content)) return '(no output)';
	const parts = [];
	for (const block of content) {
		if (block === null || typeof block !== 'object') continue;
		if (block.type === 'text' && typeof block.text === 'string') {
			parts.push(block.text);
			continue;
		}
		if (block.type === 'reasoning') continue;
		if (block.type === 'image') parts.push('[image output]');
		else if (block.type === 'file') parts.push('[file output]');
		else parts.push(`[${String(block.type)} output]`);
	}
	const text = parts.join('\n').trim();
	return text.length === 0 ? '(no output)' : text;
}

/**
 * Recognise the rejection a released dispatch produces when it restores the
 * signal on its frozen execution record.
 * @param error - the thrown value.
 * @returns whether it is the frozen-record error.
 */
function isReleasedRecordError(error) {
	if (!(error instanceof TypeError)) return false;
	return /read only|not extensible|cannot assign/i.test(error.message);
}

/**
 * Coerce a Loader row's config into the effective settings.
 * @param raw - the unvalidated row config.
 * @returns effective settings.
 */
function normalizeConfig(raw) {
	const input = isRecord(raw) ? raw : {};
	const config = { ...DEFAULTS };
	if (typeof input.enabled === 'boolean') config.enabled = input.enabled;
	if (typeof input.guidance === 'boolean') config.guidance = input.guidance;
	if (typeof input.alsoFollowup === 'boolean') config.alsoFollowup = input.alsoFollowup;
	if (Number.isSafeInteger(input.minInFlightMs) && input.minInFlightMs >= 0) config.minInFlightMs = input.minInFlightMs;
	if (Number.isSafeInteger(input.maxJobsPerSteer) && input.maxJobsPerSteer > 0)
		config.maxJobsPerSteer = input.maxJobsPerSteer;
	if (Number.isSafeInteger(input.outputLimitBytes) && input.outputLimitBytes >= 0)
		config.outputLimitBytes = input.outputLimitBytes;
	if (Array.isArray(input.excludeTools))
		config.excludeTools = input.excludeTools.filter((entry) => typeof entry === 'string');
	return config;
}

/**
 * Read (or open) the per-agent in-flight map.
 * @param flights - the plugin's map.
 * @param agentId - the agent's session id.
 * @returns the agent's map.
 */
function flightsFor(flights, agentId) {
	let perAgent = flights.get(agentId);
	if (perAgent === undefined) {
		perAgent = new Map();
		flights.set(agentId, perAgent);
	}
	return perAgent;
}

/**
 * Compact one argument object into a single line.
 * @param value - the arguments.
 * @returns a short JSON rendering.
 */
function compactJson(value) {
	try {
		return JSON.stringify(value);
	} catch {
		return '';
	}
}

/**
 * Test for a plain object.
 * @param value - any value.
 * @returns whether it is a non-array object.
 */
function isRecord(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read a message out of an unknown error.
 * @param error - the thrown value.
 * @returns a readable message.
 */
function messageOf(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	try {
		return String(error);
	} catch {
		return 'unknown error';
	}
}
