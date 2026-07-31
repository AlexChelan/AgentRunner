import { describe, expect, it } from 'vitest'
import { claudeAllowedToolsForFloor } from '../../src/runtime/web-floor'

/** The loopback web-tools MCP server name a dispatched run's tools are served under. */
const SERVER = 'opencompanion'

describe('claudeAllowedToolsForFloor', () => {
  it('allows only the backend manifest tools, MCP-qualified, when the network is off', () => {
    expect(claudeAllowedToolsForFloor(['search'], SERVER, false)).toEqual([`mcp__${SERVER}__search`])
  })

  it('adds the CLI web tools when the network is on', () => {
    const allowed = claudeAllowedToolsForFloor(['search'], SERVER, true)
    expect(allowed).toContain('WebSearch')
    expect(allowed).toContain('WebFetch')
  })

  it('never allows a file or shell tool, whatever the manifest says', () => {
    const denied = ['Read', 'Bash', 'Write', 'Edit', 'Glob', 'Grep']
    const allowed = claudeAllowedToolsForFloor(denied, SERVER, true)
    for (const name of denied) {
      expect(allowed).not.toContain(name)
    }
  })

  it('drops a manifest name that could smuggle a second permission rule', () => {
    expect(claudeAllowedToolsForFloor(['lookup,Bash', 'Bash(rm:*)', 'ok'], SERVER, false)).toEqual([
      `mcp__${SERVER}__ok`
    ])
  })
})
