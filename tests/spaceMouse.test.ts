// SPDX-License-Identifier: AGPL-3.0-only
import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrthoNavigator } from '../src/viewer/orthoNav'
import {
  isSpaceMouse,
  spaceMouseAxis,
  spaceMouseReverseOf,
  spaceMouseSpeedOf,
  type SpaceMouseMotion,
} from '../src/viewer/spaceMouse'

describe('SpaceMouse device match', () => {
  it('takes the ids Chrome and Edge give 3Dconnexion pucks', () => {
    expect(isSpaceMouse('SpaceMouse Compact (Vendor: 256f Product: c635)')).toBe(true)
    expect(isSpaceMouse('3Dconnexion SpaceMouse Pro Wireless (Vendor: 256f Product: c632)')).toBe(true)
    expect(isSpaceMouse('SpaceNavigator (Vendor: 046d Product: c626)')).toBe(true)
    // Unnamed, known by its USB ids alone.
    expect(isSpaceMouse('Unknown Gamepad (Vendor: 256f Product: c652)')).toBe(true)
  })

  it('leaves gamepads alone, Logitech ones included', () => {
    expect(isSpaceMouse('Xbox 360 Controller (XInput STANDARD GAMEPAD)')).toBe(false)
    expect(isSpaceMouse('Logitech Gamepad F310 (Vendor: 046d Product: c216)')).toBe(false)
  })
})

describe('SpaceMouse axis', () => {
  it('is still inside the deadzone and starts from zero past it', () => {
    expect(spaceMouseAxis(0.05)).toBe(0)
    expect(spaceMouseAxis(-0.079)).toBe(0)
    expect(spaceMouseAxis(0.081)).toBeGreaterThan(0)
    expect(spaceMouseAxis(0.081)).toBeLessThan(0.01)
  })

  it('reaches full deflection at the stop, both ways, and no further', () => {
    expect(spaceMouseAxis(1)).toBe(1)
    expect(spaceMouseAxis(-1)).toBe(-1)
    expect(spaceMouseAxis(1.2)).toBe(1)
  })

  it('reads a missing axis as at rest', () => {
    expect(spaceMouseAxis(undefined)).toBe(0)
  })
})

describe('SpaceMouse tuning as stored', () => {
  it('reads a speed within its range, 1 for anything else', () => {
    expect(spaceMouseSpeedOf('0.5')).toBe(0.5)
    expect(spaceMouseSpeedOf('9')).toBe(2)
    expect(spaceMouseSpeedOf('0')).toBe(0.25)
    expect(spaceMouseSpeedOf(null)).toBe(1)
    expect(spaceMouseSpeedOf('fast')).toBe(1)
  })

  it('reads reversed axes, dropping what it does not know', () => {
    expect(spaceMouseReverseOf('rz,tx,nope,tx')).toEqual(['tx', 'rz'])
    expect(spaceMouseReverseOf('')).toEqual([])
    expect(spaceMouseReverseOf(null)).toEqual([])
  })
})

/** A browser with one puck in it, not yet shown to the page, and a clock that
 *  only moves when told to. The module is loaded fresh for each test: what
 *  device is attached and which viewport has it is module state. */
describe('SpaceMouse routing', () => {
  let now = 1000
  let listeners: Record<string, ((e: { gamepad: Gamepad }) => void)[]>
  let pads: (Gamepad | null)[]
  let puck: { id: string; index: number; connected: boolean; axes: number[] }
  let sm: typeof import('../src/viewer/spaceMouse')
  let focused: boolean
  let visibility: DocumentVisibilityState

  const fire = (type: string, gamepad: object) => {
    for (const l of listeners[type] ?? []) l({ gamepad: gamepad as Gamepad })
  }
  const plugIn = () => {
    pads[puck.index] = puck as unknown as Gamepad
    fire('gamepadconnected', puck)
  }
  const tick = (ms = 16) => {
    now += ms
  }

  beforeEach(async () => {
    now = 1000
    focused = true
    visibility = 'visible'
    listeners = {}
    pads = [null, null]
    puck = { id: 'SpaceMouse Compact (Vendor: 256f Product: c635)', index: 1, connected: true, axes: [0, 0, 0, 0, 0, 0] }
    vi.stubGlobal('window', {
      addEventListener: (type: string, l: (e: { gamepad: Gamepad }) => void) => {
        ;(listeners[type] ??= []).push(l)
      },
    })
    vi.stubGlobal('navigator', { getGamepads: () => pads })
    vi.stubGlobal('document', {
      hasFocus: () => focused,
      get visibilityState() { return visibility },
      addEventListener: (type: string, l: () => void) => {
        ;(listeners[type] ??= []).push(l)
      },
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.resetModules()
    sm = await import('../src/viewer/spaceMouse')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads nothing until the browser reports a puck', () => {
    sm.listenForSpaceMouse()
    expect(sm.spaceMouseAttached()).toBe(false)
    fire('gamepadconnected', { id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', index: 0, connected: true })
    expect(sm.spaceMouseAttached()).toBe(false)
    plugIn()
    expect(sm.spaceMouseAttached()).toBe(true)
    puck.connected = false
    fire('gamepaddisconnected', puck)
    expect(sm.spaceMouseAttached()).toBe(false)
  })

  it('finds a puck the page was shown before it started listening', () => {
    pads[puck.index] = puck as unknown as Gamepad
    sm.listenForSpaceMouse()
    expect(sm.spaceMouseAttached()).toBe(true)
  })

  it('gives motion, scaled by the frame time, only while the puck is moved', () => {
    sm.listenForSpaceMouse()
    plugIn()
    const view = {}
    tick()
    expect(sm.readSpaceMouse(view, true)).toBeNull()
    puck.axes = [0, 1, 0, 0, -1, 0.5]
    tick()
    const m = sm.readSpaceMouse(view, true)!
    expect(m.dt).toBeCloseTo(0.016)
    expect(m.ty).toBe(1)
    expect(m.rz).toBeGreaterThan(0)
    // Roll is read, and does not leak into the tilt.
    expect(m.ry).toBe(-1)
    expect(m.rx).toBe(0)
    expect(Object.keys(m).sort()).toEqual(['dt', 'rx', 'ry', 'rz', 'tx', 'ty', 'tz'])
    // A stalled tab does not fling the view.
    tick(5000)
    expect(sm.readSpaceMouse(view, true)!.dt).toBe(0.1)
  })

  it('drives one viewport at a time, the one last aimed at', () => {
    sm.listenForSpaceMouse()
    plugIn()
    puck.axes = [1, 0, 0, 0, 0, 0]
    const main = {}
    const other = {}
    sm.aimSpaceMouse(main)
    sm.aimSpaceMouse(other)
    tick()
    expect(sm.readSpaceMouse(main, true)).toBeNull()
    expect(sm.readSpaceMouse(other, true)).not.toBeNull()
    sm.aimSpaceMouse(main)
    tick()
    expect(sm.readSpaceMouse(other, true)).toBeNull()
    expect(sm.readSpaceMouse(main, true)).not.toBeNull()
  })

  it('ignores a deflected puck in an unfocused window without polling the device', () => {
    sm.listenForSpaceMouse()
    plugIn()
    const poll = vi.spyOn(navigator, 'getGamepads')
    puck.axes = [1, 0, 0, 0, 0, 0]
    const view = {}
    tick()
    expect(sm.readSpaceMouse(view, true)).not.toBeNull()
    focused = false
    fire('blur', {})
    poll.mockClear()
    tick()
    expect(sm.readSpaceMouse(view, true)).toBeNull()
    expect(sm.spaceMouseBusy()).toBe(false)
    expect(poll).not.toHaveBeenCalled()
    tick(5000)
    focused = true
    fire('focus', {})
    tick()
    expect(sm.readSpaceMouse(view, true)?.dt).toBeCloseTo(0.016)
  })

  it('ignores a hidden page even if it reports focus and resets elapsed time on return', () => {
    sm.listenForSpaceMouse()
    plugIn()
    puck.axes = [1, 0, 0, 0, 0, 0]
    const view = {}
    visibility = 'hidden'
    fire('visibilitychange', {})
    tick()
    expect(sm.readSpaceMouse(view, true)).toBeNull()
    tick(5000)
    visibility = 'visible'
    fire('visibilitychange', {})
    tick()
    expect(sm.readSpaceMouse(view, true)?.dt).toBeCloseTo(0.016)
  })

  it('passes from a hidden or closed viewport to the next one in view', () => {
    sm.listenForSpaceMouse()
    plugIn()
    puck.axes = [1, 0, 0, 0, 0, 0]
    const main = {}
    const sheet = {}
    sm.aimSpaceMouse(main)
    // The 3D view hidden behind another workspace lets go.
    tick()
    expect(sm.readSpaceMouse(main, false)).toBeNull()
    expect(sm.readSpaceMouse(sheet, true)).not.toBeNull()
    // And the workspace closing hands it back.
    sm.releaseSpaceMouse(sheet)
    tick()
    expect(sm.readSpaceMouse(main, true)).not.toBeNull()
    // Releasing a viewport that does not have it changes nothing.
    sm.releaseSpaceMouse(sheet)
    tick()
    expect(sm.readSpaceMouse(main, true)).not.toBeNull()
  })

  it('holds the wheel off only just after the puck has moved', () => {
    sm.listenForSpaceMouse()
    expect(sm.spaceMouseBusy()).toBe(false)
    plugIn()
    const view = {}
    tick()
    sm.readSpaceMouse(view, true)
    expect(sm.spaceMouseBusy()).toBe(false)
    puck.axes = [0, 0.5, 0, 0, 0, 0]
    tick()
    sm.readSpaceMouse(view, true)
    expect(sm.spaceMouseBusy()).toBe(true)
    tick(150)
    expect(sm.spaceMouseBusy()).toBe(false)
  })

  it('moves on to a second puck when the first is unplugged', () => {
    const first = { ...puck, id: 'SpaceNavigator (Vendor: 046d Product: c626)', index: 0, axes: [0, 0, 0, 0, 0, 0] }
    pads[0] = first as unknown as Gamepad
    pads[1] = puck as unknown as Gamepad
    sm.listenForSpaceMouse()
    const view = {}
    puck.axes = [1, 0, 0, 0, 0, 0]
    tick()
    expect(sm.readSpaceMouse(view, true)).toBeNull()
    first.connected = false
    fire('gamepaddisconnected', first)
    expect(sm.spaceMouseAttached()).toBe(true)
    tick()
    expect(sm.readSpaceMouse(view, true)?.tx).toBe(-1)
  })

  it('moves the part with the hand: a slide right or a tilt forward moves the camera the other way', () => {
    sm.listenForSpaceMouse()
    plugIn()
    const view = {}
    puck.axes = [1, 0, 1, 1, 0, 1]
    tick()
    const m = sm.readSpaceMouse(view, true)!
    expect(m.tx).toBe(-1)
    expect(m.rx).toBe(-1)
    // Down on the cap pans the camera up, so the part goes down with it.
    expect(m.tz).toBe(1)
    expect(m.rz).toBe(1)
  })

  it("reverses the axes the operator asks for, and scales all six by the speed", () => {
    sm.listenForSpaceMouse()
    plugIn()
    const view = {}
    sm.tuneSpaceMouse({ speed: 0.5, reversed: ['tx', 'ry'] })
    puck.axes = [1, 1, 1, 1, 1, 1]
    tick()
    const m = sm.readSpaceMouse(view, true)!
    expect([m.tx, m.ty, m.tz, m.rx, m.ry, m.rz]).toEqual([0.5, 0.5, 0.5, -0.5, -0.5, 0.5])
    sm.tuneSpaceMouse({ speed: 1, reversed: [] })
    tick()
    expect(sm.readSpaceMouse(view, true)!.tx).toBe(-1)
  })

  it('tells its watchers when a puck attaches and when it goes', () => {
    const seen: (string | null)[] = []
    sm.watchSpaceMouse(() => seen.push(sm.spaceMouseName()))
    sm.listenForSpaceMouse()
    plugIn()
    puck.connected = false
    fire('gamepaddisconnected', puck)
    expect(seen).toEqual([puck.id, null])
  })
})

describe('SpaceMouse through WebHID', () => {
  const COMPACT_ID = 'SpaceMouse Compact (Vendor: 256f Product: c635)'
  let now = 1000
  let focused: boolean
  let pads: (Gamepad | null)[]
  let listeners: Record<string, ((e: { gamepad: Gamepad }) => void)[]>
  let hidListeners: Record<string, ((e: { device: FakeDevice }) => void)[]>
  /** What getDevices() answers: the devices the page was already let use. */
  let granted: FakeDevice[]
  /** What the browser's chooser hands back: [] when the operator cancels. */
  let picked: FakeDevice[]
  let requestDevice: ReturnType<typeof vi.fn>
  let warn: ReturnType<typeof vi.spyOn>
  let sm: typeof import('../src/viewer/spaceMouse')

  /** A stand-in for the SpaceMouse Compact as Chrome's WebHID shows it: report
   *  1 the slides and report 2 the turns, three int16 each, ±`range`. */
  const compact = (range = 350) => {
    const onReport: ((e: HIDInputReportEvent) => void)[] = []
    const axis = { logicalMinimum: -range, logicalMaximum: range, reportCount: 3, reportSize: 16 }
    const d = {
      vendorId: 0x256f,
      productId: 0xc635,
      productName: 'SpaceMouse Compact',
      opened: false,
      openFails: false,
      collections: [
        {
          usagePage: 1,
          usage: 8,
          inputReports: [
            { reportId: 1, items: [axis] },
            { reportId: 2, items: [axis] },
            { reportId: 3, items: [{ logicalMinimum: 0, logicalMaximum: 1, reportCount: 2, reportSize: 1 }] },
          ],
        },
      ],
      open: vi.fn(async (): Promise<void> => {
        if (d.openFails) throw new Error('NotAllowedError: Failed to open the device.')
        d.opened = true
      }),
      close: async (): Promise<void> => {},
      addEventListener: (_type: string, l: (e: HIDInputReportEvent) => void): void => {
        onReport.push(l)
      },
      removeEventListener: (_type: string, l: (e: HIDInputReportEvent) => void): void => {
        onReport.splice(onReport.indexOf(l), 1)
      },
      /** Send one input report, the values as the device's own integers. */
      send(reportId: number, ...values: number[]): void {
        const data = new DataView(new ArrayBuffer(values.length * 2))
        values.forEach((v, i) => data.setInt16(2 * i, v, true))
        for (const l of [...onReport]) l({ reportId, data, device: d } as unknown as HIDInputReportEvent)
      },
      reportListeners: () => onReport.length,
    }
    return d
  }
  type FakeDevice = ReturnType<typeof compact>

  const fire = (type: string, gamepad: object) => {
    for (const l of listeners[type] ?? []) l({ gamepad: gamepad as Gamepad })
  }
  const fireHid = (type: string, device: FakeDevice) => {
    for (const l of hidListeners[type] ?? []) l({ device })
  }
  const tick = (ms = 16) => {
    now += ms
  }
  /** Let the device's open() and the other awaits run. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  beforeEach(async () => {
    now = 1000
    focused = true
    listeners = {}
    hidListeners = {}
    pads = [null, null]
    granted = []
    picked = []
    requestDevice = vi.fn(async () => picked)
    vi.stubGlobal('window', {
      addEventListener: (type: string, l: (e: { gamepad: Gamepad }) => void) => {
        ;(listeners[type] ??= []).push(l)
      },
    })
    vi.stubGlobal('navigator', {
      getGamepads: () => pads,
      hid: {
        getDevices: async () => granted,
        requestDevice,
        addEventListener: (type: string, l: (e: { device: FakeDevice }) => void) => {
          ;(hidListeners[type] ??= []).push(l)
        },
      },
    })
    vi.stubGlobal('document', {
      hasFocus: () => focused,
      visibilityState: 'visible',
      addEventListener: () => {},
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.resetModules()
    sm = await import('../src/viewer/spaceMouse')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads a puck the page was already let use, without asking', async () => {
    const dev = compact()
    granted = [dev]
    sm.listenForSpaceMouse()
    await settle()
    expect(sm.spaceMouseAttached()).toBe(true)
    expect(sm.spaceMouseName()).toBe(COMPACT_ID)
    expect(dev.open).toHaveBeenCalledOnce()
    expect(requestDevice).not.toHaveBeenCalled()
  })

  it('puts report 1 into the slides and report 2 into the turns, the same as a gamepad', async () => {
    const dev = compact()
    granted = [dev]
    sm.listenForSpaceMouse()
    await settle()
    const view = {}
    // The gamepad routing test's [0, 1, 0, 0, -1, 0.5], as the device sends it.
    dev.send(1, 0, 350, 0)
    dev.send(2, 0, -350, 175)
    // The buttons are not motion.
    dev.send(3, 1)
    tick()
    const m = sm.readSpaceMouse(view, true)!
    expect(m.ty).toBe(1)
    expect(m.ry).toBe(-1)
    expect(m.rz).toBeGreaterThan(0)
    expect([m.tx, m.tz, m.rx]).toEqual([0, 0, 0])
  })

  it('scales by the range the device declares, not a fixed one', async () => {
    const dev = compact(1000)
    granted = [dev]
    sm.listenForSpaceMouse()
    await settle()
    dev.send(1, 0, 500, 0)
    tick()
    expect(sm.readSpaceMouse({}, true)!.ty).toBeCloseTo(sm.spaceMouseAxis(0.5))
  })

  it('takes all six from one report on a puck that sends them together', async () => {
    const dev = compact()
    granted = [dev]
    sm.listenForSpaceMouse()
    await settle()
    dev.send(1, 350, 350, 350, 350, 350, 350)
    tick()
    const m = sm.readSpaceMouse({}, true)!
    expect([m.tx, m.ty, m.tz, m.rx, m.ry, m.rz]).toEqual([-1, 1, 1, -1, 1, 1])
  })

  it('takes a puck whose reports stop as at rest', async () => {
    const dev = compact()
    granted = [dev]
    sm.listenForSpaceMouse()
    await settle()
    const view = {}
    dev.send(1, 350, 0, 0)
    tick()
    expect(sm.readSpaceMouse(view, true)).not.toBeNull()
    // Held still, it keeps reporting, and keeps flying.
    tick(900)
    dev.send(1, 350, 0, 0)
    tick(900)
    expect(sm.readSpaceMouse(view, true)).not.toBeNull()
    // Silent past the limit — the zero reports lost — it stops.
    tick(200)
    expect(sm.readSpaceMouse(view, true)).toBeNull()
  })

  it('ignores a deflected puck in an unfocused window', async () => {
    const dev = compact()
    granted = [dev]
    sm.listenForSpaceMouse()
    await settle()
    dev.send(1, 350, 0, 0)
    focused = false
    tick()
    expect(sm.readSpaceMouse({}, true)).toBeNull()
  })

  it('reads the gamepad when the browser shows the puck as one too', async () => {
    const dev = compact()
    granted = [dev]
    sm.listenForSpaceMouse()
    await settle()
    const gp = { id: COMPACT_ID, index: 0, connected: true, axes: [1, 0, 0, 0, 0, 0] }
    pads[0] = gp as unknown as Gamepad
    fire('gamepadconnected', gp)
    const view = {}
    dev.send(1, 0, 350, 0)
    tick()
    const m = sm.readSpaceMouse(view, true)!
    expect([m.tx, m.ty]).toEqual([-1, 0])
    // Unplugged as a gamepad, WebHID carries on, without the gamepad's last axes.
    gp.connected = false
    fire('gamepaddisconnected', gp)
    expect(sm.spaceMouseName()).toBe(COMPACT_ID)
    tick()
    expect(sm.readSpaceMouse(view, true)).toBeNull()
    dev.send(1, 0, 350, 0)
    tick()
    expect(sm.readSpaceMouse(view, true)!.ty).toBe(1)
  })

  it('lets go when unplugged, telling its watchers, and takes it up again when it comes back', async () => {
    const dev = compact()
    granted = [dev]
    const seen: (string | null)[] = []
    sm.watchSpaceMouse(() => seen.push(sm.spaceMouseName()))
    sm.listenForSpaceMouse()
    await settle()
    dev.send(1, 350, 0, 0)
    granted = []
    fireHid('disconnect', dev)
    await settle()
    expect(sm.spaceMouseAttached()).toBe(false)
    expect(dev.reportListeners()).toBe(0)
    tick()
    expect(sm.readSpaceMouse({}, true)).toBeNull()
    // Plugged back in, where the browser kept the grant.
    const back = compact()
    granted = [back]
    fireHid('connect', back)
    await settle()
    expect(sm.spaceMouseAttached()).toBe(true)
    expect(seen).toEqual([COMPACT_ID, null, COMPACT_ID])
  })

  it('opens and announces a puck once, however often it is offered', async () => {
    const dev = compact()
    granted = [dev, dev]
    let told = 0
    sm.watchSpaceMouse(() => told++)
    sm.listenForSpaceMouse()
    // Offered again while the first open is still under way.
    fireHid('connect', dev)
    await settle()
    expect(dev.open).toHaveBeenCalledOnce()
    expect(told).toBe(1)
  })

  it('asks for a puck only when told to, and says how it went', async () => {
    sm.listenForSpaceMouse()
    await settle()
    expect(sm.spaceMouseAttached()).toBe(false)
    expect(sm.spaceMouseHidAvailable()).toBe(true)
    expect(await sm.connectSpaceMouseHid()).toBe('cancelled')
    expect(requestDevice).toHaveBeenCalledWith({
      filters: expect.arrayContaining([{ vendorId: 0x256f, usagePage: 1, usage: 8 }]),
    })
    picked = [compact()]
    expect(await sm.connectSpaceMouseHid()).toBe('connected')
    expect(sm.spaceMouseName()).toBe(COMPACT_ID)
  })

  it('says when the puck cannot be opened, as without the udev rule', async () => {
    const dev = compact()
    dev.openFails = true
    picked = [dev]
    expect(await sm.connectSpaceMouseHid()).toBe('failed')
    expect(sm.spaceMouseAttached()).toBe(false)
    expect(warn).toHaveBeenCalled()
    // Found unasked at start, the same failure goes only to the console.
    warn.mockClear()
    vi.resetModules()
    sm = await import('../src/viewer/spaceMouse')
    granted = [dev]
    sm.listenForSpaceMouse()
    await settle()
    expect(sm.spaceMouseAttached()).toBe(false)
    expect(warn).toHaveBeenCalledOnce()
  })
})

/** The navigator flying a camera from puck motion, on a stub canvas: an
 *  800 × 600 viewport looking down −Z at a unit cube, two millimetres of it
 *  tall on screen. */
describe('SpaceMouse flying the camera', () => {
  let now = 1000
  let camera: THREE.OrthographicCamera
  let controls: { target: THREE.Vector3; update: () => void }
  let nav: OrthoNavigator

  const motion = (m: Partial<SpaceMouseMotion>): SpaceMouseMotion => ({ dt: 0.1, tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0, ...m })

  beforeEach(() => {
    now = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal('document', { addEventListener: () => {}, removeEventListener: () => {} })
    const canvas = {
      addEventListener: () => {},
      removeEventListener: () => {},
      clientHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    } as unknown as HTMLCanvasElement
    camera = new THREE.OrthographicCamera(-4 / 3, 4 / 3, 1, -1, 0.01, 100)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()
    controls = { target: new THREE.Vector3(), update: () => {} }
    const cube = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1))
    cube.updateMatrixWorld()
    nav = new OrthoNavigator(
      camera,
      controls as unknown as OrbitControls,
      canvas,
      () => [cube],
      { center: new THREE.Vector3(), radius: 1 },
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('pans by view heights per second, camera and target together', () => {
    nav.stepSpaceMouse(motion({ tx: 1, tz: -0.5 }))
    // 2 mm tall × 1.2 view heights a second × 0.1 s.
    expect(camera.position.x).toBeCloseTo(0.24)
    expect(camera.position.y).toBeCloseTo(-0.12)
    expect(controls.target.x).toBeCloseTo(0.24)
    expect(controls.target.y).toBeCloseTo(-0.12)
  })

  it('zooms in when pushed forward, by the same speed at any zoom', () => {
    nav.stepSpaceMouse(motion({ ty: 1 }))
    expect(camera.zoom).toBeCloseTo(Math.exp(0.25))
    nav.stepSpaceMouse(motion({ ty: -1 }))
    expect(camera.zoom).toBeCloseTo(1)
  })

  it('turns the way BumpMesh does, about the surface at the screen centre', () => {
    nav.stepSpaceMouse(motion({ rz: 1 }))
    // Twist swings the camera round the screen vertical towards +X ...
    expect(camera.position.x).toBeGreaterThan(0)
    expect(camera.position.y).toBeCloseTo(0)
    // ... about the cube's face under the centre, which stays there.
    const pivot = new THREE.Vector3(0, 0, 0.5).project(camera)
    expect(pivot.x).toBeCloseTo(0)
    expect(pivot.y).toBeCloseTo(0)
    expect(camera.getWorldDirection(new THREE.Vector3()).angleTo(new THREE.Vector3(0, 0, -1))).toBeCloseTo(0.24)
    expect(nav.pivotMarker.visible).toBe(true)

    // Tilt swings it down round the screen horizontal.
    const before = camera.position.clone()
    nav.stepSpaceMouse(motion({ rx: 1 }))
    expect(camera.position.y).toBeLessThan(before.y)
    // The up vector turns with the camera: the free orbit has no world up.
    expect(camera.up.dot(camera.getWorldDirection(new THREE.Vector3()))).toBeCloseTo(0)
  })

  it('rolls about the line of sight, which stays put', () => {
    nav.stepSpaceMouse(motion({ ry: 1 }))
    expect(camera.getWorldDirection(new THREE.Vector3()).z).toBeCloseTo(-1)
    // The camera turns clockwise about its line of sight, so its up leans to +X.
    expect(camera.up.x).toBeGreaterThan(0.2)
    expect(camera.up.angleTo(new THREE.Vector3(0, 1, 0))).toBeCloseTo(0.24)
  })

  it('lets the pivot go once the puck has settled', () => {
    nav.stepSpaceMouse(motion({ rz: 1 }))
    now += 100
    nav.stepSpaceMouse(null)
    expect(nav.pivotMarker.visible).toBe(true)
    now += 200
    nav.stepSpaceMouse(null)
    expect(nav.pivotMarker.visible).toBe(false)
  })

  it('does not turn a flat sheet, and still pans and zooms it', () => {
    nav.setPlanar(true)
    nav.stepSpaceMouse(motion({ rx: 1, rz: 1, tx: 1, ty: 1 }))
    expect(camera.getWorldDirection(new THREE.Vector3()).z).toBeCloseTo(-1)
    expect(camera.position.x).toBeCloseTo(0.24)
    expect(camera.zoom).toBeGreaterThan(1)
    expect(nav.pivotMarker.visible).toBe(false)
  })
})
