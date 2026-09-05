import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Whether the drive server's listen address is a FILESYSTEM entry.
 *
 * A unix domain socket is a file: it has an inode, it survives the process that bound it, and a crash
 * leaves it behind for the next boot to reclaim. A Windows named pipe is a kernel object with no
 * filesystem entry at all - nothing to stat, nothing to unlink, and nothing left once the last handle
 * closes. `startLocalDriveServer` branches on exactly this (`isPosixSocket`), so the cases that assert
 * the inode half of its contract branch on it too, each platform keeping a real case.
 */
export const DRIVE_SOCKET_IS_FILE = process.platform !== "win32";

/**
 * A source of unique, per-case listen addresses in the shape the running platform accepts.
 *
 * On POSIX the path is kept SHORT - a unix socket path is capped at ~104 bytes on macOS, so it lives
 * directly under the temp root rather than inside a per-case `mkdtemp` directory. On Windows the
 * address is a pipe NAME under `\\.\pipe\`, which is the only thing `listen` binds there: a filesystem
 * path fails `EACCES`, which is what the desktop's own `daemon-identity` win32 arm mints too.
 *
 * @param prefix - Distinguishes one suite's addresses from another's.
 * @returns A function yielding the next unique address.
 */
export function driveSocketNamer(prefix: string): () => string {
	let bound = 0;
	return () => {
		const name = `${prefix}-${process.pid}-${++bound}`;
		return DRIVE_SOCKET_IS_FILE ? join(tmpdir(), `${name}.sock`) : `\\\\.\\pipe\\${name}`;
	};
}
