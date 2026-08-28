import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { vi } from "vitest";
import type { AgenticCliDriverParams, AgenticDriverMessage } from "../../src/adapters/types";
import type { SpawnFn } from "../../src/drivers";

/** The fakes every NDJSON driver suite drives its CLI with: the child, the spawn recorder, the drain. */

/**
 * Drains an async-iterable driver into an array of normalized messages.
 *
 * @param driver - The driver's message stream.
 * @returns Every message it yielded, in order.
 */
export async function drain(
	driver: AsyncIterable<AgenticDriverMessage>
): Promise<AgenticDriverMessage[]> {
	const out: AgenticDriverMessage[] = [];
	for await (const m of driver) out.push(m);
	return out;
}

/**
 * One turn's driver params for a given CLI binary, overridable per case.
 *
 * @param binaryPath - The CLI binary the driver spawns.
 * @param over - Fields this case exercises.
 * @returns The driver params.
 */
export function driverParams(
	binaryPath: string,
	over: Partial<AgenticCliDriverParams> = {}
): AgenticCliDriverParams {
	return {
		prompt: "hi",
		cwd: over.cwd ?? "",
		binaryPath,
		permissionMode: "read-only",
		signal: new AbortController().signal,
		...over
	};
}

/** Records what a fake child's stdin received, so a prompt-on-stdin path can be asserted. */
export interface FakeStdin {
	/** Everything written or ended with, concatenated. */
	written: string;
	/** Ends the stream, appending an optional final chunk. */
	end: (chunk?: string) => void;
	/** Registers a listener; the fake never emits, so this is inert. */
	on: () => void;
	/** Appends a chunk. */
	write: (chunk: string) => void;
}

/** A fake CLI child: stdout, stderr, a recording stdin, and an inert `kill`. */
export type FakeCliChild = EventEmitter & {
	/** The replayed NDJSON stream. */
	stdout: Readable;
	/** The replayed stderr, empty unless the case supplied text. */
	stderr: Readable;
	/** The recording stdin. */
	stdin: FakeStdin;
	/** Inert - the driver calls it on stall and teardown. */
	kill: () => void;
};

/**
 * A fake headless CLI child: it replays the supplied lines on stdout and ends the stream, the lifecycle
 * of a single-turn headless spawn. An object line is JSON-encoded, a string line replayed verbatim.
 *
 * @param lines - The stdout lines to replay, as objects or raw strings.
 * @param stderrText - What the child prints on stderr, if anything.
 * @returns The fake child.
 */
export function fakeCliChild(lines: readonly unknown[], stderrText = ""): FakeCliChild {
	const child = new EventEmitter() as FakeCliChild;
	child.stdout = Readable.from(
		lines.map((line) => (typeof line === "string" ? `${line}\n` : `${JSON.stringify(line)}\n`))
	);
	child.stderr = Readable.from(stderrText ? [stderrText] : []);
	child.stdin = {
		written: "",
		end(chunk?: string) {
			if (chunk) this.written += chunk;
		},
		on: () => {},
		write(chunk: string) {
			this.written += chunk;
		}
	};
	child.kill = () => {};
	return child;
}

/** An injected spawn plus the recorder of what it was called with. */
export interface FakeSpawn {
	/** The injectable spawn seam. */
	spawnFn: SpawnFn;
	/** The first spawn call's binary, argv and options. */
	callArgs: () => {
		bin: string;
		args: string[];
		opts: { env?: Record<string, string>; cwd?: string };
	};
}

/**
 * Builds an injected spawnFn returning `child`, plus a recorder of the spawn call.
 *
 * @param child - The child every spawn returns.
 * @returns The spawn seam and its call recorder.
 */
export function fakeSpawn(child: EventEmitter): FakeSpawn {
	const fn = vi.fn(() => child);
	return {
		spawnFn: fn as unknown as SpawnFn,
		callArgs: () => {
			const call = vi.mocked(fn).mock.calls[0] as unknown as [
				string,
				string[],
				{ env?: Record<string, string>; cwd?: string }
			];
			return { bin: call[0], args: call[1], opts: call[2] };
		}
	};
}
