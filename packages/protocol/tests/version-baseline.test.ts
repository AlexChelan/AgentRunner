import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNNER_PROTOCOL_VERSION } from "../src/messages";
import baseline from "./version-baseline.json";

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));

/**
 * A stable content hash of every protocol source file: each file's `src`-relative path and its
 * line-ending-normalized bytes, in sorted path order. Sorted so a filesystem's directory order can
 * never move the hash, and path-prefixed so renaming a file is a change even when its contents are
 * identical. Every file counts, not just `.ts` - a data file added beside the schemas is wire surface
 * too. CRLF collapses to LF before hashing because git on Windows checks sources out with CRLF by
 * default (`core.autocrlf`), and a hash of raw bytes then differs per PLATFORM rather than per wire
 * change - the recorded baseline is captured on LF, for which the normalization is the identity.
 *
 * @returns The hex sha256 digest of the whole `src/` tree.
 */
function hashProtocolSource(): string {
	const hash = createHash("sha256");
	const files = readdirSync(srcDir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(srcDir, join(entry.parentPath, entry.name)).replaceAll("\\", "/"))
		.sort();
	for (const file of files) {
		hash.update(file);
		hash.update("\0");
		hash.update(readFileSync(join(srcDir, file), "utf8").replaceAll("\r\n", "\n"));
		hash.update("\0");
	}
	return hash.digest("hex");
}

/**
 * The protocol-bump guard. ONE wire contract is spoken by three things on independent release cadences:
 * a buyer's backend (shipped by their `generatesaas update`), an end user's AgentRunner daemon (its own
 * auto-update), and the web client between them. Those updates are unordered, so all four old/new
 * combinations occur in the field - which is why every change has to be additive-only under a version the
 * peers read as a capability signal, never as a gate (see the rules on {@link RUNNER_PROTOCOL_VERSION}).
 *
 * This is what makes that a failing test rather than discipline: touching `src/**` without recording a new
 * baseline fails, and recording one requires editing a committed file - so a wire change can never ride in
 * as a refactor side effect. It says nothing about WHETHER to bump; it forces the author to decide and
 * leaves the decision in the diff.
 *
 * NOT a git diff against the last tag, which is the obvious form: `ci.yml` checks out at the default
 * `fetch-depth: 1`, so the job that runs this suite has no base to diff against and the guard would pass
 * vacuously - worse than no guard. A committed baseline needs no git at all and runs identically everywhere.
 *
 * When this fails, exactly one of two things is true:
 *  - the wire shape changed: bump `RUNNER_PROTOCOL_VERSION`, freeze a `tests/fixtures/v<n>/` directory
 *    (permanent - every version's fixtures must keep parsing forever, see `wire-fixtures.test.ts`), and
 *    record both new values in `tests/version-baseline.json`;
 *  - nothing on the wire changed (a comment, a JSDoc, a pure refactor): record the new hash alone, and
 *    leave the version untouched so the review sees an unbumped version deliberately.
 */
describe("protocol version baseline", () => {
	it("records the version the frozen fixtures were captured at", () => {
		expect(RUNNER_PROTOCOL_VERSION).toBe(baseline.version);
	});

	it("freezes fixtures only for versions that have actually shipped", () => {
		// The fixture layout is SPARSE (see `wire-fixtures.test.ts`): `v<N>/` holds only what version N
		// CHANGED, and a version that changed no shape has no directory at all - v5 narrowed a constant,
		// not a schema. So "a directory per version" is no longer the invariant; what still is, is that
		// every directory names a version that exists, and that v1 (the base every walk-back ends at) is
		// present. The per-version COMPLETENESS guard - a bump that forgot to freeze what it changed -
		// lives in `wire-fixtures.test.ts`, which resolves every case for every version and fails by name.
		const frozen = readdirSync(fixturesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => Number(entry.name.replace(/^v/, "")));
		expect(frozen).toContain(1);
		const outOfRange = frozen.filter(
			(version) => !Number.isInteger(version) || version < 1 || version > baseline.version
		);
		expect(outOfRange, `fixture directories above v${baseline.version}`).toEqual([]);
	});

	it("fails when src/** changed without a recorded baseline", () => {
		expect(hashProtocolSource()).toBe(baseline.sourceHash);
	});
});
