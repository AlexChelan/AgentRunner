import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AdapterCapabilities, AuthStatus } from "@agentrunner/core-types";
import type { LoginEventFrame } from "@agentrunner/protocol";
import type { InstallDeps } from "../../src/cli-install";
import type { AgentRuntimeRegistry } from "../../src/registry";
import type { RuntimeToolAdapter } from "../../src/runtime-types";
import { startLoginSession } from "../../src/runtime/login-session";
import type {
	LoginSessionDeps,
	PipedLoginChild,
	PipedLoginOptions,
	PipedSpawn
} from "../../src/runtime/login-session";
import type { PtyOptions, PtySpawn } from "../../src/runtime/pty";

/** The verbatim codex device-auth capture (codex 0.146.1), reused as fake child output. */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "login");

/** One relayed frame as the session emits it (the runner adds `requestId`). */
type Frame = Omit<LoginEventFrame, "requestId">;

/** ESC, spelled as an escape so the control byte never sits raw in this source. */
const ESC = "\u001B";

/** Capabilities the fake adapters advertise; irrelevant to login, but the type requires them. */
const CAPS: AdapterCapabilities = {
	supportedAuthModes: ["subscription"],
	kind: "agentic",
	interactiveApproval: true,
	subscriptionRequiresDisclosure: true
};

/** A signed-in probe result. */
const AUTHED: AuthStatus = { authenticated: true, mode: "subscription" };

/** Awaits one macrotask boundary so queued stream/microtask chains have settled. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Builds a one-adapter registry whose `detect`/`authStatus` the test controls. */
function registryFor(
	toolId: string,
	auth: AuthStatus | (() => AuthStatus),
	installed = true
): AgentRuntimeRegistry {
	const adapter: RuntimeToolAdapter = {
		id: toolId,
		displayName: toolId,
		capabilities: CAPS,
		detect: () => Promise.resolve({ installed }),
		authStatus: () => Promise.resolve(typeof auth === "function" ? auth() : auth),
		listModels: () => Promise.resolve([]),
		run: () => ({ cancel: () => undefined, respondToPermission: () => undefined })
	};
	return {
		getAdapters: () => [adapter],
		getAdapter: (id: string) => (id === toolId ? adapter : undefined),
		requireAdapter: (id: string) => {
			if (id !== toolId) throw new Error("no adapter");
			return adapter;
		}
	};
}

/** A fake PTY session the test feeds output into and observes writes/kills on. */
interface PtyHarness {
	/** The injectable spawn. */
	spawn: PtySpawn;
	/** Every spawn call, in order. */
	calls: { command: string; args: string[]; opts: PtyOptions }[];
	/** Delivers one raw chunk to the session, exactly as a PTY read would. */
	push(text: string): void;
	/** Ends the session with an exit code. */
	end(code: number): void;
	/** Everything the session wrote to the child's stdin. */
	writes: string[];
	/** Whether the session killed the child. */
	killed(): boolean;
}

/** Builds a {@link PtyHarness}; the child is created on the first spawn call. */
function ptyHarness(): PtyHarness {
	const calls: PtyHarness["calls"] = [];
	const listeners: ((chunk: string) => void)[] = [];
	const writes: string[] = [];
	let killed = false;
	let resolveExit!: (code: number) => void;
	const exit = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});
	const spawn: PtySpawn = (command, args, opts) => {
		calls.push({ command, args, opts });
		return {
			onData: (cb) => void listeners.push(cb),
			write: (data) => void writes.push(data),
			kill: () => {
				killed = true;
				resolveExit(137);
			},
			exit
		};
	};
	return {
		spawn,
		calls,
		writes,
		push: (text) => {
			for (const listener of listeners) listener(text);
		},
		end: (code) => resolveExit(code),
		killed: () => killed
	};
}

/** A fake piped child: real streams + a real emitter, so no cast is needed anywhere. */
class FakePipedChild extends EventEmitter implements PipedLoginChild {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly signals: (NodeJS.Signals | undefined)[] = [];

	/** Records the signal (a real `kill` only signals; `close` arrives later). */
	kill(signal?: NodeJS.Signals): boolean {
		this.signals.push(signal);
		return true;
	}
}

/** A fake piped spawn the test drives with real stream writes. */
interface PipedHarness {
	/** The injectable spawn. */
	spawn: PipedSpawn;
	/** Every spawn call, in order. */
	calls: { command: string; args: string[]; opts: PipedLoginOptions }[];
	/** Writes one chunk to the child's stdout and waits for it to be delivered. */
	push(text: string): Promise<void>;
	/** Writes one chunk to the child's stderr and waits for it to be delivered. */
	pushErr(text: string): Promise<void>;
	/** Closes both streams and emits `close` with the exit code, as a real child does. */
	end(code: number): Promise<void>;
	/** Emits a spawn failure, as a child that never started does. */
	failSpawn(message: string): void;
	/** Every signal the session sent the child, in order. */
	signals(): (NodeJS.Signals | undefined)[];
}

/** Builds a {@link PipedHarness}; the child is created on the first spawn call. */
function pipedHarness(): PipedHarness {
	const calls: PipedHarness["calls"] = [];
	let child: FakePipedChild | undefined;
	const spawn: PipedSpawn = (command, args, opts) => {
		calls.push({ command, args, opts });
		child = new FakePipedChild();
		return child;
	};
	const write = async (stream: PassThrough | undefined, text: string): Promise<void> => {
		stream?.write(text);
		await flush();
	};
	return {
		spawn,
		calls,
		push: (text) => write(child?.stdout, text),
		pushErr: (text) => write(child?.stderr, text),
		end: async (code) => {
			const live = child;
			if (!live) return;
			live.stdout.end();
			live.stderr.end();
			await flush();
			live.emit("close", code, null);
			await flush();
		},
		failSpawn: (message) => void child?.emit("error", new Error(message)),
		signals: () => child?.signals ?? []
	};
}

/** Builds session deps whose disk/network seams are all faked. */
function makeDeps(frames: Frame[], over: Partial<LoginSessionDeps> = {}): LoginSessionDeps {
	return {
		baseDir: join(tmpdir(), "login-session-tests"),
		registry: registryFor("codex", AUTHED),
		emit: (frame) => void frames.push(frame),
		resolveLogin: (_baseDir, toolId) => ({
			command: `/fake/bin/${toolId}`,
			args: toolId === "codex" ? ["login"] : ["auth", "login"]
		}),
		install: () => Promise.resolve(),
		ttlMs: 60_000,
		...over
	};
}

/** The `value`s of every relayed `line` frame, newline-joined. */
function lineText(frames: Frame[]): string {
	return frames
		.filter((frame) => frame.kind === "line")
		.map((frame) => frame.value ?? "")
		.join("\n");
}

describe("startLoginSession (codex)", () => {
	it("relays url + code from the real device-auth output and completes connected", async () => {
		const frames: Frame[] = [];
		const piped = pipedHarness();
		const session = startLoginSession(
			"codex",
			makeDeps(frames, { spawnPiped: piped.spawn, registry: registryFor("codex", AUTHED) })
		);
		await flush();
		await piped.push(readFileSync(join(FIXTURES, "codex-device-auth.txt"), "utf8"));
		await piped.end(0);

		const result = await session.done;

		expect(piped.calls[0]?.args).toEqual(["login", "--device-auth"]);
		expect(frames.find((f) => f.kind === "url")?.value).toContain("auth.openai.com/codex/device");
		expect(frames.find((f) => f.kind === "code")?.value).toBe("BRA8-Z3UEZ");
		expect(result).toEqual({ toolId: "codex", status: "connected", authHealth: "healthy" });
		expect(frames.at(-1)).toEqual({ kind: "done", authHealth: "healthy" });
	});

	it("fails when the CLI is still signed out after a CLEAN exit", async () => {
		const frames: Frame[] = [];
		const piped = pipedHarness();
		const session = startLoginSession(
			"codex",
			makeDeps(frames, {
				spawnPiped: piped.spawn,
				registry: registryFor("codex", {
					authenticated: false,
					mode: "subscription",
					detail: "not signed in"
				})
			})
		);
		await flush();
		// Exit 0: codex ends a device flow that merely timed out this way, so only the probe can tell.
		await piped.end(0);

		const result = await session.done;

		expect(result.status).toBe("failed");
		expect(result.reason).toBe("not signed in");
		expect(frames.at(-1)).toEqual({ kind: "failed", value: "not signed in" });
	});

	it("kills the child and escalates to SIGKILL when cancelled", async () => {
		const frames: Frame[] = [];
		const piped = pipedHarness();
		const session = startLoginSession(
			"codex",
			makeDeps(frames, { spawnPiped: piped.spawn, killGraceMs: 1 })
		);
		await flush();

		session.cancel();
		const result = await session.done;
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(result.status).toBe("cancelled");
		expect(piped.signals()).toEqual([undefined, "SIGKILL"]);
	});

	it("relays stderr as well as stdout, and threads HOME - as the DAEMON - when contained", async () => {
		const frames: Frame[] = [];
		const piped = pipedHarness();
		const home = join(tmpdir(), "login-session-home");
		const session = startLoginSession(
			"codex",
			makeDeps(frames, {
				spawnPiped: piped.spawn,
				contained: true,
				agentUid: 1101,
				agentGid: 1102,
				homeDir: home
			})
		);
		await flush();
		await piped.pushErr("codex says something on stderr\n");
		await piped.end(0);
		await session.done;

		const opts = piped.calls[0]?.opts;
		// NO uid/gid drop, container or not. The daemon is the credential manager: it re-probes auth and
		// seeds a run's isolated Codex home from this login, and without CAP_DAC_OVERRIDE it cannot read
		// back a 0600 file another uid wrote - every contained run would report signed out.
		expect(opts).not.toHaveProperty("uid");
		expect(opts).not.toHaveProperty("gid");
		expect(opts?.env.HOME).toBe(home);
		expect(opts?.stdio).toEqual(["ignore", "pipe", "pipe"]);
		expect(lineText(frames)).toContain("codex says something on stderr");
	});

	it("fails without waiting for the TTL when the child cannot be spawned", async () => {
		const frames: Frame[] = [];
		const piped = pipedHarness();
		const session = startLoginSession(
			"codex",
			makeDeps(frames, { spawnPiped: piped.spawn, ttlMs: 60_000 })
		);
		await flush();
		piped.failSpawn("spawn codex ENOENT");

		const result = await session.done;

		expect(result.status).toBe("failed");
		expect(result.reason).toContain("ENOENT");
	});

	it("ignores write() - codex has no stdin - and keeps relaying", async () => {
		const frames: Frame[] = [];
		const piped = pipedHarness();
		const session = startLoginSession("codex", makeDeps(frames, { spawnPiped: piped.spawn }));
		await flush();
		session.write("ABCD-1234");
		await piped.push("still talking to you\n");
		await piped.end(0);
		await session.done;

		expect(lineText(frames)).toContain("still talking to you");
	});
});

describe("startLoginSession (claude-code)", () => {
	/** Starts a claude session over a fake PTY with a signed-in probe. */
	function claudeSession(
		frames: Frame[],
		over: Partial<LoginSessionDeps> = {}
	): {
		session: ReturnType<typeof startLoginSession>;
		pty: PtyHarness;
	} {
		const pty = ptyHarness();
		const session = startLoginSession(
			"claude-code",
			makeDeps(frames, {
				spawnPty: pty.spawn,
				registry: registryFor("claude-code", AUTHED),
				...over
			})
		);
		return { session, pty };
	}

	it("stops relaying after paste-back and never leaks a token", async () => {
		const frames: Frame[] = [];
		const { session, pty } = claudeSession(frames);
		await flush();

		pty.push("Use the url below https://claude.com/oauth?x=1\r\nsk-ant-BEFOREINPUTSECRET\r\n");
		session.write("ABCD-1234");
		pty.push("sk-ant-SECRETSECRETSECRET\r\nLogin successful\r\n");
		pty.end(0);
		const result = await session.done;

		const text = lineText(frames);
		expect(frames.find((f) => f.kind === "url")?.value).toBe("https://claude.com/oauth?x=1");
		expect(pty.writes).toEqual(["ABCD-1234\n"]);
		// Pre-input output is relayed, but every secret in it is masked.
		expect(text).toContain("Use the url below");
		expect(text).not.toContain("sk-ant-BEFOREINPUTSECRET");
		expect(text).toContain("«redacted»");
		// Post-input output is not relayed at all.
		expect(text).not.toContain("sk-ant-SECRETSECRETSECRET");
		expect(text).not.toContain("Login successful");
		expect(result.status).toBe("connected");
	});

	it("buffers to line boundaries so a secret split across two reads is still masked", async () => {
		const frames: Frame[] = [];
		const { session, pty } = claudeSession(frames);
		await flush();
		// Each half is BELOW the threshold of the rule that catches the whole: "ant-abc" is 7 chars
		// (the key rule wants 8+), and 25 characters is short of the token-shape rule's 40. Relaying
		// either half verbatim would hand the reader the credential in two pieces.
		const keyHead = "sk-ant-abc";
		const keyTail = "defghijklmnopqrstuvwxyz";
		const tokenHead = "A".repeat(25);
		const tokenTail = "B".repeat(25);

		pty.push(`key: ${keyHead}`);
		pty.push(`${keyTail}\r\ntoken: ${tokenHead}`);
		pty.push(`${tokenTail}\r\n`);
		pty.end(0);
		await session.done;

		const text = lineText(frames);
		expect(text).not.toContain(keyHead);
		expect(text).not.toContain(tokenHead);
		expect(text).toContain("key: «redacted»");
		expect(text).toContain("token: «redacted»");
	});

	it("cancel() kills the child and resolves cancelled without a terminal frame", async () => {
		const frames: Frame[] = [];
		const { session, pty } = claudeSession(frames);
		await flush();
		pty.push("waiting for you\r\n");

		session.cancel();
		const result = await session.done;

		expect(pty.killed()).toBe(true);
		expect(result).toEqual({ toolId: "claude-code", status: "cancelled" });
		expect(frames.some((f) => f.kind === "done" || f.kind === "failed")).toBe(false);
	});

	it("fails immediately when the host has no PTY, without spawning anything", async () => {
		const frames: Frame[] = [];
		const { session, pty } = claudeSession(frames, { ptyAvailable: () => false });

		const result = await session.done;

		expect(pty.calls).toEqual([]);
		expect(result.status).toBe("failed");
		expect(result.reason).toContain("terminal");
		expect(frames.at(-1)?.kind).toBe("failed");
	});

	it("kills the child and fails when the session TTL expires", async () => {
		const frames: Frame[] = [];
		const { session, pty } = claudeSession(frames, { ttlMs: 5 });
		await flush();

		const result = await session.done;

		expect(pty.killed()).toBe(true);
		expect(result.status).toBe("failed");
		expect(result.reason).toContain("timed out");
	});

	it("spawns the login under a wide PTY with the session HOME and NO uid drop", async () => {
		const frames: Frame[] = [];
		const home = join(tmpdir(), "login-session-home");
		const { session, pty } = claudeSession(frames, {
			homeDir: home,
			contained: true,
			agentUid: 1101,
			agentGid: 1102
		});
		await flush();
		pty.end(0);
		await session.done;

		const call = pty.calls[0];
		expect(call?.command).toBe("/fake/bin/claude-code");
		expect(call?.args).toEqual(["auth", "login"]);
		expect(call?.opts.cols).toBe(1000);
		expect(call?.opts.env?.HOME).toBe(home);
		// The claude RUN child is the Agent SDK's own spawn, which stays the daemon ROOT. A login dropped
		// to uid 1000 would write `$HOME/.claude` 0600 agent-owned, and that root run child - with no
		// CAP_DAC_OVERRIDE in the container - could not read it. Every contained run: signed out.
		expect(call?.opts.uid).toBeUndefined();
		expect(call?.opts.gid).toBeUndefined();
	});

	it("fails on a non-zero exit even when the adapter reports authenticated", async () => {
		const frames: Frame[] = [];
		// claude-code's authStatus is binary-presence-only: it says "authenticated" for any installed
		// binary, so the exit code is the only signal that the login itself failed.
		const { session, pty } = claudeSession(frames);
		await flush();
		pty.push("Login failed: the code you pasted has expired\r\n");
		pty.end(1);

		const result = await session.done;

		expect(result.status).toBe("failed");
		expect(result.authHealth).toBeUndefined();
		expect(result.reason).toContain("exited with code 1");
	});

	it("relays a carriage-return-terminated line before the stream ends", async () => {
		const frames: Frame[] = [];
		const { session, pty } = claudeSession(frames);
		await flush();

		pty.push("Enter the code shown at https://claude.com/oauth\r");

		// Asserted BEFORE the child exits: a CLI that redraws with \r must not go dark for the
		// whole session (and must not buffer without bound until its TTL).
		expect(lineText(frames)).toContain("Enter the code shown at");
		expect(frames.find((f) => f.kind === "url")?.value).toBe("https://claude.com/oauth");

		pty.end(0);
		await session.done;
	});

	it("survives a relay sink that throws, and still settles", async () => {
		const frames: Frame[] = [];
		const logs: string[] = [];
		const pty = ptyHarness();
		const session = startLoginSession(
			"claude-code",
			makeDeps(frames, {
				spawnPty: pty.spawn,
				registry: registryFor("claude-code", AUTHED),
				log: (line) => void logs.push(line),
				emit: (frame) => {
					frames.push(frame);
					throw new Error("sink is gone");
				}
			})
		);
		await flush();
		pty.push("a line the sink will choke on\r\n");
		pty.end(0);

		const result = await session.done;

		expect(result.status).toBe("connected");
		expect(logs.join("")).toContain("relay sink threw");
	});

	it("installs first when the CLI is missing, relaying install progress as lines", async () => {
		const frames: Frame[] = [];
		const installs: string[] = [];
		const pty = ptyHarness();
		const session = startLoginSession(
			"claude-code",
			makeDeps(frames, {
				spawnPty: pty.spawn,
				registry: registryFor("claude-code", AUTHED, false),
				installIfMissing: true,
				install: (_baseDir, toolId, onProgress) => {
					installs.push(toolId);
					// An installer line never passes through the parser, so the relay's own escape
					// sweep + redaction are the ONLY things between it and the browser. The escape sits
					// INSIDE the key and splits it into two runs that neither rule matches on its own,
					// so a relay that redacts without stripping first would emit the key in two pieces.
					onProgress(`Downloading claude... auth=sk-ant-ab${ESC}[0mcdefghijk`);
					return Promise.resolve();
				}
			})
		);
		await flush();
		await flush();
		pty.end(0);
		const result = await session.done;

		expect(installs).toEqual(["claude-code"]);
		expect(lineText(frames)).toContain("Downloading claude... auth=«redacted»");
		expect(lineText(frames)).not.toContain("sk-ant-ab");
		expect(lineText(frames)).not.toContain("cdefghijk");
		expect(pty.calls).toHaveLength(1);
		expect(result.status).toBe("connected");
	});

	it("group-shares a CONTAINED install with the agent identity the login child runs as", async () => {
		// The daemon installs as root but the login child - and every later run - is the agent uid. A
		// 0700 managed tree makes the binary un-exec'able for them (EACCES before the CLI even starts),
		// so the install must be shared with the same uid/gid the child gets.
		const frames: Frame[] = [];
		const seen: (InstallDeps | undefined)[] = [];
		const pty = ptyHarness();
		const session = startLoginSession(
			"claude-code",
			makeDeps(frames, {
				spawnPty: pty.spawn,
				registry: registryFor("claude-code", AUTHED, false),
				installIfMissing: true,
				contained: true,
				agentUid: 1000,
				agentGid: 1000,
				install: (_baseDir, _toolId, _onProgress, _signal, _version, installDeps) => {
					seen.push(installDeps);
					return Promise.resolve();
				}
			})
		);
		await flush();
		await flush();
		pty.end(0);
		await session.done;

		expect(seen).toHaveLength(1);
		expect(seen[0]?.agent).toEqual({ uid: 1000, gid: 1000 });
	});

	it("passes no install agent off a contained host", async () => {
		const frames: Frame[] = [];
		const seen: (InstallDeps | undefined)[] = [];
		const pty = ptyHarness();
		const session = startLoginSession(
			"claude-code",
			makeDeps(frames, {
				spawnPty: pty.spawn,
				registry: registryFor("claude-code", AUTHED, false),
				installIfMissing: true,
				install: (_baseDir, _toolId, _onProgress, _signal, _version, installDeps) => {
					seen.push(installDeps);
					return Promise.resolve();
				}
			})
		);
		await flush();
		await flush();
		pty.end(0);
		await session.done;

		expect(seen).toHaveLength(1);
		expect(seen[0]?.agent).toBeUndefined();
	});

	it("fails when the login command cannot be resolved", async () => {
		const frames: Frame[] = [];
		const pty = ptyHarness();
		const session = startLoginSession(
			"claude-code",
			makeDeps(frames, {
				spawnPty: pty.spawn,
				registry: registryFor("claude-code", AUTHED),
				resolveLogin: () => null
			})
		);

		const result = await session.done;

		expect(pty.calls).toEqual([]);
		expect(result.status).toBe("failed");
		expect(result.reason).toContain("login command");
	});
});
