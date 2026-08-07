import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { execPath, argv as processArgv } from 'node:process'
import { describe, expect, it } from 'vitest'
import { BRAND, envVar } from '../src/brand'
import { buildServiceSpec } from '../src/commands/service'
import {
  buildLaunchdPlist,
  buildSystemdUnit,
  installService,
  isServiceUnitPresent,
  restartService,
  SERVICE_LABEL,
  
  serviceStatus,
  uninstallService,
  unitPath,
  windowsTaskName
} from '../src/service'
import type {ServiceSpec} from '../src/service';

/** The per-user task name every Windows case below asserts against ({@link fakeDeps} pins the username). */
const WIN_TASK = windowsTaskName('u')

/**
 * What `schtasks /Query /TN <folder-qualified-name>` actually prints for a task that EXISTS: the folder
 * on its own line, and only the LEAF name in the TaskName column. The full `\Brand\u` string appears
 * nowhere, which is why presence is read from the exit status instead.
 */
const SCHTASKS_QUERY_OUTPUT = [
  'Folder: \\AgentRunner',
  'TaskName                                 Next Run Time          Status',
  '======================================== ====================== ===============',
  'u                                        N/A                    Ready',
  ''
].join('\r\n')

const spec: ServiceSpec = {
  label: SERVICE_LABEL,
  program: ['/opt/node', '/app/cli.js', 'serve'],
  logDir: `/home/u/.local/share/${BRAND.appDirName}/logs`,
  env: { PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/home/u' }
}

describe('service unit builders', () => {
  it('launchd plist carries the program args, env, and RunAtLoad + KeepAlive', () => {
    const plist = buildLaunchdPlist(spec)
    expect(plist).toContain(`<string>${SERVICE_LABEL}</string>`)
    expect(plist).toContain('<string>/opt/node</string>')
    expect(plist).toContain('<string>/app/cli.js</string>')
    expect(plist).toContain('<string>serve</string>')
    expect(plist).toContain('<key>RunAtLoad</key>')
    expect(plist).toContain('<key>KeepAlive</key>')
    expect(plist).toContain('<string>/usr/bin:/opt/homebrew/bin</string>')
    // The daemon log file carries the brand's binary stem.
    expect(plist).toContain(join(spec.logDir, `${BRAND.binary}.log`))
    expect(plist).toContain(join(spec.logDir, `${BRAND.binary}.err.log`))
  })

  it('systemd unit carries ExecStart, Restart=always, and Environment', () => {
    const unit = buildSystemdUnit(spec)
    expect(unit).toContain('ExecStart=/opt/node /app/cli.js serve')
    expect(unit).toContain('Restart=always')
    expect(unit).toContain('Environment="PATH=/usr/bin:/opt/homebrew/bin"')
    expect(unit).toContain('WantedBy=default.target')
  })

  it('quotes systemd ExecStart args that contain spaces', () => {
    const unit = buildSystemdUnit({ ...spec, program: ['/opt/node', '/App Support/cli.js', 'serve'] })
    expect(unit).toContain('ExecStart=/opt/node "/App Support/cli.js" serve')
  })
})

describe('buildServiceSpec', () => {
  /** Pins the resolved entry to a sentinel argv[1] and clears the root-launcher marker (the dev-build path). */
  function withDevEntry<T>(entry: string, fn: () => T): T {
    const originalEntry = processArgv[1]
    const originalLauncher = process.env[envVar('ROOT_LAUNCHER')]
    processArgv[1] = entry
    delete process.env[envVar('ROOT_LAUNCHER')]
    try {
      return fn()
    } finally {
      processArgv[1] = originalEntry
      if (originalLauncher === undefined) delete process.env[envVar('ROOT_LAUNCHER')]
      else process.env[envVar('ROOT_LAUNCHER')] = originalLauncher
    }
  }

  it('the bare (paired) variant runs `<node> <cli.js> serve` - no --local, no --app-config', () => {
    const program = withDevEntry('/opt/oc/daemon/cli.js', () => buildServiceSpec('/data/root').program)
    expect(program).toEqual([execPath, '/opt/oc/daemon/cli.js', 'serve'])
  })

  it('the bare (paired) variant threads through the stable ROOT_LAUNCHER unchanged (byte-identical to today)', () => {
    // GUARD: the execPath/argv derivation must ONLY take over for the staged-out/bundle-spawned shape; when
    // the root-launcher marker is present (a dev/installed versioned build) the bare program stays exactly
    // `[<root launcher>, 'serve']`, byte-identical to the pre-local-variant behavior.
    const originalLauncher = process.env[envVar('ROOT_LAUNCHER')]
    process.env[envVar('ROOT_LAUNCHER')] = '/home/u/.oc/oc'
    try {
      expect(buildServiceSpec('/data/root').program).toEqual(['/home/u/.oc/oc', 'serve'])
    } finally {
      if (originalLauncher === undefined) delete process.env[envVar('ROOT_LAUNCHER')]
      else process.env[envVar('ROOT_LAUNCHER')] = originalLauncher
    }
  })

  it('never builds a `--local` variant: `serve --local` no longer exists, so a unit naming it would fail at launch', () => {
    // The app-managed local boot service died with the desktop supervisor - the app forks its own agent
    // runtime and installs no service for it. This pins the argv so the flag cannot creep back in.
    const program = withDevEntry('/opt/oc/daemon/cli.js', () => buildServiceSpec('/data/root').program)
    expect(program).not.toContain('--local')
    expect(program).not.toContain('--app-config')
  })
})

describe('service unit builders - a multi-element program on both OSes', () => {
  const nodeSpec: ServiceSpec = {
    label: SERVICE_LABEL,
    program: ['/opt/node', '/app/cli.js', 'serve'],
    logDir: `/home/u/.local/share/${BRAND.appDirName}/logs`,
    env: { PATH: '/usr/bin', HOME: '/home/u' }
  }

  it('macOS: the launchd plist carries EVERY argv element, not just the program', () => {
    const plist = buildLaunchdPlist(nodeSpec)
    expect(plist).toContain('<string>/opt/node</string>')
    expect(plist).toContain('<string>/app/cli.js</string>')
    expect(plist).toContain('<string>serve</string>')
  })

  it('linux: the systemd unit ExecStart carries the whole argv', () => {
    const unit = buildSystemdUnit(nodeSpec)
    expect(unit).toContain('ExecStart=/opt/node /app/cli.js serve')
  })
})

describe('unitPath', () => {
  it('resolves the launchd plist path on macOS', () => {
    expect(unitPath('darwin', '/home/u')).toBe(
      join('/home/u', 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`)
    )
  })
  it('resolves the systemd user unit path on Linux', () => {
    expect(unitPath('linux', '/home/u')).toBe(
      join('/home/u', '.config', 'systemd', 'user', `${BRAND.binary}.service`)
    )
  })
})

/** Captures the injected side effects for assertions. */
function fakeDeps(platform: NodeJS.Platform) {
  const writes: Array<{ path: string; content: string }> = []
  const removes: string[] = []
  const runs: Array<{ cmd: string; args: string[] }> = []
  return {
    deps: {
      platform,
      home: '/home/u',
      uid: 501,
      username: 'u',
      writeFile: (path: string, content: string) => void writes.push({ path, content }),
      removeFile: (path: string) => void removes.push(path),
      run: (cmd: string, args: string[]) => {
        runs.push({ cmd, args })
        return ''
      }
    },
    writes,
    removes,
    runs
  }
}

describe('installService', () => {
  it('macOS: writes the plist then bootout (best-effort) + bootstrap into the gui domain', () => {
    const f = fakeDeps('darwin')
    const { path } = installService(spec, f.deps)
    expect(path).toBe(unitPath('darwin', '/home/u'))
    expect(f.writes[0]?.path).toBe(path)
    expect(f.writes[0]?.content).toContain('<key>KeepAlive</key>')
    expect(f.runs.map((r) => `${r.cmd} ${r.args.join(' ')}`)).toEqual([
      `launchctl bootout gui/501/${SERVICE_LABEL}`,
      `launchctl bootstrap gui/501 ${path}`
    ])
  })

  it('linux: writes the systemd unit then daemon-reload + enable --now', () => {
    const f = fakeDeps('linux')
    installService(spec, f.deps)
    expect(f.writes[0]?.content).toContain('Restart=always')
    expect(f.runs).toEqual([
      { cmd: 'systemctl', args: ['--user', 'daemon-reload'] },
      { cmd: 'systemctl', args: ['--user', 'enable', '--now', `${BRAND.binary}.service`] }
    ])
  })

  // A container's restart policy IS the service. Writing a systemd unit inside the image would register
  // a second supervisor for a daemon the container already restarts, so the install refuses instead - and
  // says which one is in charge, since the user asked for an always-on daemon and already has one.
  it('refuses in container mode and names the restart policy as the service', () => {
    process.env[envVar('CONTAINED')] = '1'
    const f = fakeDeps('linux')
    try {
      expect(() => installService(spec, f.deps)).toThrow(/container/i)
      // Refused BEFORE any side effect: no unit written, no systemctl run.
      expect(f.writes).toEqual([])
      expect(f.runs).toEqual([])
    } finally {
      delete process.env[envVar('CONTAINED')]
    }
  })

  it('windows: registers a logon Scheduled Task and starts it immediately', () => {
    const f = fakeDeps('win32')
    const { message } = installService(spec, f.deps)
    expect(message).toContain('Scheduled Task')
    expect(f.runs[0]?.cmd).toBe('schtasks')
    expect(f.runs[0]?.args).toContain('/Create')
    expect(f.runs[0]?.args).toContain(WIN_TASK)
    // Without an immediate /Run the runner would stay offline until the next logon.
    expect(f.runs[1]?.cmd).toBe('schtasks')
    expect(f.runs[1]?.args).toContain('/Run')
    expect(f.runs[1]?.args).toContain(WIN_TASK)
  })
})

describe('windows scheduled task naming', () => {
  it('namespaces the task per OS user so two accounts do not collide', () => {
    // Without the folder prefix, `/Create /F` from the second user silently repoints the first
    // user's logon task at the second user's binary.
    expect(windowsTaskName('alice')).not.toBe(windowsTaskName('bob'))
  })

  it('puts the task in a brand folder rather than the machine-global root', () => {
    expect(windowsTaskName('alice')).toMatch(/^\\/)
    expect(windowsTaskName('alice')).toContain('alice')
  })

  it('sanitizes a username that would break the task path', () => {
    // schtasks treats a backslash as a folder separator, so a domain login must not create one.
    expect(windowsTaskName('CORP\\alice').split('\\')).toHaveLength(3)
  })

  it('falls back to a placeholder segment when the username sanitizes to nothing', () => {
    expect(windowsTaskName('')).toBe(`\\${BRAND.name}\\default`)
  })
})

describe('uninstallService', () => {
  it('macOS: bootout then removes the plist', () => {
    const f = fakeDeps('darwin')
    uninstallService(f.deps)
    expect(f.runs[0]).toEqual({ cmd: 'launchctl', args: ['bootout', `gui/501/${SERVICE_LABEL}`] })
    expect(f.removes).toEqual([unitPath('darwin', '/home/u')])
  })

  it('windows: deletes the per-user task AND the legacy bare one an upgraded install left behind', () => {
    // An install predating the per-user folder registered a bare machine-global task. Deleting only
    // the qualified name would strand it, leaving the user with two logon tasks and no way to remove one.
    const f = fakeDeps('win32')
    uninstallService(f.deps)
    expect(f.runs).toEqual([
      { cmd: 'schtasks', args: ['/Delete', '/F', '/TN', WIN_TASK] },
      { cmd: 'schtasks', args: ['/Delete', '/F', '/TN', BRAND.name] }
    ])
  })
})

describe('serviceStatus', () => {
  it('linux: reports the systemctl is-active state', () => {
    const f = fakeDeps('linux')
    f.deps.run = () => 'active'
    expect(serviceStatus(f.deps).message).toBe('systemd: active')
  })
})

describe('isServiceUnitPresent (cheap probe, no launchctl/systemctl spawn)', () => {
  it('macOS: reads the plist file existence and never shells out', () => {
    const home = mkdtempSync(join(tmpdir(), 'runner-svc-present-mac-'))
    const runs: string[] = []
    const run = (cmd: string): string => {
      runs.push(cmd)
      return ''
    }
    expect(isServiceUnitPresent({ platform: 'darwin', home, run })).toBe(false)
    const plist = unitPath('darwin', home)
    mkdirSync(dirname(plist), { recursive: true })
    writeFileSync(plist, '<plist/>')
    expect(isServiceUnitPresent({ platform: 'darwin', home, run })).toBe(true)
    // The whole point: no launchctl (or any) subprocess on the per-request path.
    expect(runs).toEqual([])
  })

  it('linux: reads the systemd unit existence and never shells out', () => {
    const home = mkdtempSync(join(tmpdir(), 'runner-svc-present-linux-'))
    const runs: string[] = []
    const run = (cmd: string): string => {
      runs.push(cmd)
      return ''
    }
    expect(isServiceUnitPresent({ platform: 'linux', home, run })).toBe(false)
    const unit = unitPath('linux', home)
    mkdirSync(dirname(unit), { recursive: true })
    writeFileSync(unit, '[Unit]')
    expect(isServiceUnitPresent({ platform: 'linux', home, run })).toBe(true)
    expect(runs).toEqual([])
  })

  it('windows: queries the Scheduled Task (which registers no unit file)', () => {
    const deps = { platform: 'win32', home: '/home/u', username: 'u' } as const
    // The query is BY NAME, so presence is its EXIT STATUS: a missing task exits non-zero, which the
    // tolerant `run` reports as empty output.
    expect(isServiceUnitPresent({ ...deps, run: () => WIN_TASK })).toBe(true)
    expect(isServiceUnitPresent({ ...deps, run: () => '' })).toBe(false)
    // THE regression: the task name is folder-qualified (`\Brand\u`), and schtasks prints the folder on
    // its own line with only the LEAF in the TaskName column - so the qualified string never appears
    // verbatim. Searching the output for it reported "not installed" right after a successful install,
    // and every caller gated on this re-offered the install forever.
    expect(WIN_TASK).toContain('\\')
    expect(SCHTASKS_QUERY_OUTPUT).not.toContain(WIN_TASK)
    expect(isServiceUnitPresent({ ...deps, run: () => SCHTASKS_QUERY_OUTPUT })).toBe(true)
  })

  it('windows: reports the same verdict through serviceStatus, with a matching message', () => {
    const deps = { platform: 'win32', home: '/home/u', username: 'u' } as const
    // A "not installed" verdict paired with a "task present" message was the tell that the two halves
    // of this answer were derived from different things.
    expect(serviceStatus({ ...deps, run: () => SCHTASKS_QUERY_OUTPUT })).toEqual({
      installed: true,
      message: 'task present'
    })
    expect(serviceStatus({ ...deps, run: () => '' })).toEqual({
      installed: false,
      message: 'not installed'
    })
  })
})

describe('restartService', () => {
  it('macOS: kickstarts the launchd agent in the gui domain', () => {
    const f = fakeDeps('darwin')
    const { message } = restartService(f.deps)
    expect(f.runs).toEqual([
      { cmd: 'launchctl', args: ['kickstart', '-k', `gui/501/${SERVICE_LABEL}`] }
    ])
    expect(message.length).toBeGreaterThan(0)
  })

  it('linux: restarts the systemd user unit', () => {
    const f = fakeDeps('linux')
    restartService(f.deps)
    expect(f.runs).toEqual([{ cmd: 'systemctl', args: ['--user', 'restart', `${BRAND.binary}.service`] }])
  })

  it('windows: ends then re-runs the logon Scheduled Task', () => {
    const f = fakeDeps('win32')
    restartService(f.deps)
    expect(f.runs[0]?.cmd).toBe('schtasks')
    expect(f.runs[0]?.args).toContain('/End')
    expect(f.runs[0]?.args).toContain(WIN_TASK)
    expect(f.runs[1]?.cmd).toBe('schtasks')
    expect(f.runs[1]?.args).toContain('/Run')
    expect(f.runs[1]?.args).toContain(WIN_TASK)
  })
})
