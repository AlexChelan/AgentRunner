import { codexReasoningEffort } from "./mapping";
import { optionValue } from "./argv";

/** Inputs {@link buildOpencodeRunArgs} needs to compose one headless `opencode run` turn. */
export interface OpencodeRunArgsInput {
	/** The working directory the turn runs in (already defaulted by the caller). */
	cwd: string;
	/** Model id in opencode's `provider/model` form, when the run pinned one. */
	model?: string;
	/** Reasoning effort, when the run picked one; passed through unnarrowed as opencode's variant. */
	effort?: string;
	/** A prior opencode session to continue, so the turn keeps the conversation. */
	resume?: string;
	/**
	 * Absolute paths of the turn's staged image attachments, passed as opencode's `-f`. Staged files,
	 * never user-supplied names - see `stageRunImages`.
	 */
	imagePaths?: readonly string[];
	/**
	 * Absolute paths of the turn's staged DOCUMENT attachments, passed as the same `-f`. Kept a separate
	 * field from {@link OpencodeRunArgsInput.imagePaths} rather than merged by the caller, because the two
	 * are staged into different directories with different cleanups and the driver keeps them apart until
	 * the last possible moment. Staged files, never user-supplied names - see `stageRunDocuments`.
	 */
	documentPaths?: readonly string[];
}

/**
 * Builds the argument vector for one headless `opencode run` turn, driving the user's own installed
 * binary.
 *
 * The invocation is `opencode run --format json --pure --thinking --dir <cwd>` (verified against
 * opencode 1.18.17): a single-turn headless run that prints one JSON event per line and exits when
 * the session goes idle. `opencode acp` is deliberately NOT used - that transport was removed from
 * this repo on 2026-08-02 precisely because it exposes no tool-restriction control.
 *
 * THE PROMPT IS NOT HERE, AND THAT IS THE POINT. `opencode run` takes its message as a POSITIONAL,
 * and this driver sends it on the child's STDIN instead (opencode reads stdin whenever it is not a
 * TTY). Two reasons, both measured: a process argv is readable by any local user on Linux
 * (`/proc/<pid>/cmdline`) and the prompt carries the composed system prompt, and opencode's own
 * positional handling re-quotes any message token containing a space before sending it to the model.
 * Nothing on this vector is derived from the prompt.
 *
 * CREDENTIALS AND CONFIG NEVER RIDE ARGV EITHER. opencode owns its provider logins (`opencode auth`)
 * so there is no key to pass, and the run's MCP servers + permission posture ride the environment -
 * see `opencodeIsolationEnv`.
 *
 * `--pure` is the plugin lever: it makes opencode run without external plugins, which is what keeps
 * the user's own global plugins out of a driven run (verified - opencode reports "external plugins
 * disabled"). `--thinking` is what makes opencode emit `reasoning` events at all in JSON format; the
 * flag gates them, so without it a reasoning model streams its answer with no visible thinking.
 * `--auto` is deliberately NEVER passed: it auto-approves every permission opencode would ask about,
 * and this driver's posture is expressed as explicit `allow`/`deny` config instead, so anything that
 * still asks is something the posture did not name and must fail closed.
 *
 * CONTINUITY: a resuming turn passes `--session <id>`; a NEW turn passes nothing and takes the id
 * opencode reports on its own frames (opencode has no flag to pre-claim a session id, unlike grok).
 *
 * ATTACHMENTS are opencode's own `-f`, which attaches files to the message (verified against the
 * installed binary: it answers about the image). `-f` takes a PATH and does not care what is behind it,
 * so a staged PDF rides the identical flag. They are appended LAST because `-f` is a yargs ARRAY option
 * and keeps swallowing following tokens - see the note at the push itself.
 *
 * @param input - The turn's cwd, model, effort, session continuity and staged attachment paths.
 * @returns The `opencode` argv (without the binary itself, and without the prompt).
 */
export function buildOpencodeRunArgs(input: OpencodeRunArgsInput): string[] {
	const args = ["run", "--format", "json", "--pure", "--thinking", "--dir", input.cwd];
	const model = optionValue(input.model);
	// `default` and `off` mean "send no variant": omitting the flag applies the model's own default
	// effort, which is the honest rendering of both - opencode's `none` variant exists on only a
	// minority of models, so claiming a reasoning-off run by name would be wrong for most of them.
	// Shared with the Codex mapping so a wire level is interpreted identically wherever it lands.
	const variant = optionValue(codexReasoningEffort(input.effort));
	const resume = optionValue(input.resume);
	if (model) args.push("-m", model);
	if (variant) args.push("--variant", variant);
	if (resume) args.push("--session", resume);
	// ATTACHMENTS GO LAST, AND THAT IS LOAD-BEARING. `-f` is a yargs ARRAY option, so it keeps
	// swallowing following tokens - probed against opencode 1.18.18, `-f shot.png "the prompt"` ate the
	// prompt as a second filename and the run died with "File not found: the prompt". Nothing follows
	// them here, and this driver sends its prompt on stdin rather than as a positional, so there is
	// nothing left for the greedy flag to take. Each path gets its own `-f` (yargs accumulates them).
	for (const path of input.imagePaths ?? []) args.push("-f", path);
	for (const path of input.documentPaths ?? []) args.push("-f", path);
	return args;
}
