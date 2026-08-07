import * as p from '@clack/prompts'
import pc from 'picocolors'
import { BRAND } from './brand'

/**
 * The runner CLI's terminal UI, built on `@clack/prompts` + `picocolors` so it matches the look
 * of the main GenerateSaaS CLI (boxed intro/outro, a gutter for status lines, arrow-key selects,
 * spinners). Presentation lives here and in `cli.ts`; the core flows (`pair`/`connect`/`serve`) stay
 * UI-agnostic and just take a `write(line)` sink, so `line` below is what routes their output into
 * this style.
 */

/** The AgentRunner intro banner label (padded for the yellow background; matches the main CLI's accent). */
const BRAND_LABEL = ` ${BRAND.name} `

/** Opens a command with the branded intro banner. */
export function intro(): void {
  p.intro(pc.bgYellow(pc.black(BRAND_LABEL)))
}

/** Closes a command with a branded outro line. */
export function outro(message: string): void {
  p.outro(pc.yellow(message))
}

/** Routes one status line (a trailing newline is trimmed) into a clack gutter line. */
export function line(text: string): void {
  p.log.message(text.replace(/\n+$/, ''))
}

export { p, pc }
