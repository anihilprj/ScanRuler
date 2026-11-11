// SPDX-License-Identifier: AGPL-3.0-only
// A 3Dconnexion SpaceMouse, read through the Gamepad API: no driver bridge and
// no permission prompt, only the device's own driver. Ported from BumpMesh
// (github.com/CNCKitchen/stlTexturizer), same axes, deadzone and device
// match, so the puck flies both tools alike. What the motion does to a camera
// is the navigator's business (OrthoNavigator.stepSpaceMouse); this file finds
// the device, reads it, and decides which viewport it is driving.
//
// One puck and several viewports: the main view, the reference half of the
// split view, the two halves of the point picker, the 2D sheet and the sheet
// laid over the 3D view. Each runs its own frame loop, and if each read the
// puck they would all move at once, and a linked pair would be pushed twice.
// So the puck drives one at a time. That is the viewport the mouse was last
// over, the way a hand on the mouse would pick it. Until the mouse has been
// over one, it is the viewport that opened last, which is the one about to be
// worked in. A viewport that is paused, hidden or closed lets go, and the next
// one in view that asks takes it.
// Only the focused, visible page reads motion; other app windows and CAD
// applications must not move this page's camera in the background.
//
// Nothing is read until the browser reports a matching device, which it only
// does once the puck or a button has been touched on this page. For everyone
// without one the frame loop costs a single comparison.
//
// The browser hands over the device's raw axes, in the puck's own frame: x to
// the right, y towards the operator, z down; the turns about those three by
// the right hand. The 3Dconnexion driver's own settings (speed, reversed axes)
// never reach it, so the settings dialog has its own — see SpaceMouseTuning.
// Read as they come, the axes fly the camera; the puck moves the part, so a
// turn or slide of the cap is the camera's going the other way, and the
// operator's hand the part's. That is the 3Dconnexion default, and the one
// the reports from real pucks (issue #10) asked for.
//
// On Linux Chrome often never shows a puck as a gamepad: the kernel gives it
// only relative axes, so no joystick device is made for it. There the puck is
// read through WebHID instead, from its raw reports, once the operator has let
// this page use it (the browser remembers that). The axes come in the same
// order and the same sense as through the Gamepad API, so everything past the
// shared buffer is one path. A puck seen as a gamepad is read as one.

/** One frame of puck motion, as the camera is to move. Each axis is in
 *  [-speed, speed] (see SpaceMouseTuning), 0 inside the deadzone. */
export interface SpaceMouseMotion {
  /** Seconds since the previous frame, capped so a stalled tab cannot fling the view. */
  dt: number
  /** Pan the camera along the screen's horizontal, positive to the right. */
  tx: number
  /** Zoom, positive in: the cap pulled towards the operator, the part with it. */
  ty: number
  /** Pan the camera along the screen's vertical, positive up. */
  tz: number
  /** Tilt: turn about the screen's horizontal. */
  rx: number
  /** Roll: turn about the line of sight. */
  ry: number
  /** Twist: turn about the screen's vertical. */
  rz: number
}

/** The six axes, in the order the browser reports them. */
export const SPACE_MOUSE_AXES = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'] as const
export type SpaceMouseAxisId = (typeof SPACE_MOUSE_AXES)[number]

/** What the operator has set: the driver's settings, which the browser never
 *  sees. */
export interface SpaceMouseTuning {
  /** Times the default speed, on every axis. */
  speed: number
  /** Axes that move the other way from the default. */
  reversed: readonly SpaceMouseAxisId[]
}

export const SPACE_MOUSE_SPEED_MIN = 0.25
export const SPACE_MOUSE_SPEED_MAX = 2
export const SPACE_MOUSE_SPEED_STEP = 0.05

/** A speed as typed or stored, or 1 when it is not one. */
export function spaceMouseSpeedOf(value: unknown): number {
  const n = Number(value)
  if (value === null || value === '' || !Number.isFinite(n)) return 1
  return Math.min(SPACE_MOUSE_SPEED_MAX, Math.max(SPACE_MOUSE_SPEED_MIN, n))
}

/** Reversed axes as stored, a comma-separated list; anything else dropped. */
export function spaceMouseReverseOf(value: string | null): SpaceMouseAxisId[] {
  const named = new Set((value ?? '').split(','))
  return SPACE_MOUSE_AXES.filter((a) => named.has(a))
}

/** How each raw axis reaches the camera: which slot, and which way. */
const RAW: Record<SpaceMouseAxisId, { at: number; sign: number }> = {
  tx: { at: 0, sign: -1 },
  ty: { at: 1, sign: 1 },
  tz: { at: 2, sign: 1 },
  rx: { at: 3, sign: -1 },
  ry: { at: 4, sign: 1 },
  rz: { at: 5, sign: 1 },
}

const DEADZONE = 0.08

/** Chrome and Edge name the device in the id, or give its USB ids:
 *  3Dconnexion's own vendor id, and Logitech's for the older pucks sold
 *  under that name. */
const SPACE_MOUSE_ID =
  /3dconnexion|spacemouse|space ?navigator|space ?pilot|space ?explorer|vendor: (256f|046d) product: c6/i

export function isSpaceMouse(id: string): boolean {
  return SPACE_MOUSE_ID.test(id)
}

/** Remap |v| in [deadzone, 1] to [0, 1], so motion starts smoothly instead of
 *  jumping in at the deadzone's edge. */
export function spaceMouseAxis(v = 0): number {
  const a = Math.abs(v)
  return a < DEADZONE ? 0 : Math.sign(v) * Math.min(1, (a - DEADZONE) / (1 - DEADZONE))
}

/** The getGamepads() slot of the attached puck, -1 for none. */
let index = -1
let listening = false
/** performance.now() of the last frame with puck motion. */
let lastActive = -Infinity
/** performance.now() of the previous read, whichever viewport made it. */
let lastRead = 0
/** The viewport the puck is driving, null until one claims it. */
let driver: object | null = null
/** Each axis's factor, speed and direction together. */
let gain: Record<SpaceMouseAxisId, number> = { tx: -1, ty: 1, tz: 1, rx: -1, ry: 1, rz: 1 }
/** The puck's six raw axes, each in [-1, 1], in SPACE_MOUSE_AXES order. The
 *  one place motion is read from, whichever way the device delivers it: the
 *  Gamepad API is polled into it on each read, while a source that pushes its
 *  reports as events can write into it as they come. */
const axes: number[] = [0, 0, 0, 0, 0, 0]
/** The puck read through WebHID, from the moment it is claimed, null for none. */
let hid: HIDDevice | null = null
/** Its name, set once it is open and reporting; null until then. */
let hidId: string | null = null
/** Each input report's full scale, by report id, from the device's descriptor. */
let hidScale = new Map<number, number>()
/** performance.now() of the last WebHID motion report. */
let lastReport = 0
/** A puck sends reports while it is deflected and a few zero ones when let go.
 *  Should those be lost, the buffer would hold the last deflection and the view
 *  would keep flying; past this long without a report, it is taken as at rest. */
const HID_STALE_MS = 1000
/** Told when a puck attaches or goes. */
const watchers = new Set<() => void>()

/** Apply the operator's speed and reversed axes. */
export function tuneSpaceMouse(t: SpaceMouseTuning): void {
  const g = { ...gain }
  for (const a of SPACE_MOUSE_AXES) g[a] = RAW[a].sign * t.speed * (t.reversed.includes(a) ? -1 : 1)
  gain = g
}

/** Be told whenever a puck attaches or goes; returns the unsubscribe. */
export function watchSpaceMouse(fn: () => void): () => void {
  watchers.add(fn)
  return () => watchers.delete(fn)
}

/** The gamepad puck's name as the browser gives it, null for none. */
let attachedId: string | null = null
/** The attached puck's name, the one being read; null for none. */
export function spaceMouseName(): string | null {
  return attachedId ?? hidId
}

const changed = (): void => {
  for (const fn of watchers) fn()
}

/** Copy the attached gamepad's axes into the buffer; false when there is
 *  none to read. Only called once the page and the viewport are known to want
 *  motion, so a background window never polls the device. */
const pullGamepad = (): boolean => {
  const gp = navigator.getGamepads()[index]
  if (!gp?.connected) return false
  for (let i = 0; i < axes.length; i++) axes[i] = gp.axes[i] ?? 0
  return true
}

/** Whether the WebHID puck has anything to read; its reports are already in
 *  the buffer. */
const hidReady = (now: number): boolean => {
  if (hidId === null) return false
  if (now - lastReport > HID_STALE_MS) axes.fill(0)
  return true
}

const hex4 = (n: number): string => n.toString(16).padStart(4, '0')

/** The device named as Chrome names a gamepad, so one pattern matches both. */
const hidIdOf = (d: HIDDevice): string =>
  `${d.productName} (Vendor: ${hex4(d.vendorId)} Product: ${hex4(d.productId)})`

/** A puck offers more than one interface (on some, a keyboard for the
 *  buttons); the axes are on the multi-axis controller: usage page 1, usage 8. */
const isMultiAxis = (d: HIDDevice): boolean =>
  d.collections.some((c) => c.usagePage === 1 && c.usage === 8)

/** Each input report's full scale: the largest logical extent among its items.
 *  Read from the device rather than fixed, as pucks differ (±350 on the
 *  Compact, other ranges on others). */
function reportScales(collections: readonly HIDCollectionInfo[], into = new Map<number, number>()): Map<number, number> {
  for (const c of collections) {
    for (const r of c.inputReports ?? []) {
      let scale = 0
      for (const it of r.items ?? []) {
        scale = Math.max(scale, Math.abs(it.logicalMaximum ?? 0), Math.abs(it.logicalMinimum ?? 0))
      }
      if (scale > 0) into.set(r.reportId ?? 0, scale)
    }
    reportScales(c.children ?? [], into)
  }
  return into
}

/** Report 1 carries the slides and report 2 the turns, three little-endian
 *  int16 each. A puck that sends all six in one report puts them in report 1,
 *  which the byte count then covers. Others (the buttons) are not motion. */
const onHidReport = (e: HIDInputReportEvent): void => {
  const first = e.reportId === 1 ? 0 : e.reportId === 2 ? 3 : -1
  const scale = hidScale.get(e.reportId)
  if (first === -1 || !scale) return
  const n = Math.min(axes.length - first, Math.floor(e.data.byteLength / 2))
  for (let i = 0; i < n; i++) {
    axes[first + i] = Math.max(-1, Math.min(1, e.data.getInt16(2 * i, true) / scale))
  }
  lastReport = performance.now()
}

/** Open a device the page may use and read it, if it is a puck and none is
 *  read through WebHID yet. */
async function attachHid(d: HIDDevice): Promise<boolean> {
  if (hid) return hid === d
  if (!isMultiAxis(d) || !isSpaceMouse(hidIdOf(d))) return false
  // Claimed before the await, so a second call while this one opens skips it.
  hid = d
  try {
    if (!d.opened) await d.open()
  } catch (err) {
    hid = null
    throw err
  }
  hidScale = reportScales(d.collections)
  axes.fill(0)
  lastReport = performance.now()
  d.addEventListener('inputreport', onHidReport)
  hidId = hidIdOf(d)
  // Debug, not info: the settings dialog already says so, and the console stays
  // quiet at its default levels.
  console.debug(`SpaceMouse connected via WebHID: ${hidId}`)
  changed()
  return true
}

const UDEV_HINT = 'SpaceMouse found but could not be opened; on Linux it needs a udev rule (see the docs).'

/** Unasked, nobody is waiting on the outcome, so a failure only goes to the
 *  console. */
const attachQuietly = (d: HIDDevice): Promise<boolean> =>
  attachHid(d).catch((err: unknown) => {
    console.warn(UDEV_HINT, err)
    return false
  })

/** Read the first puck among the devices the page was already let use. */
async function findHid(api: HID): Promise<void> {
  for (const d of await api.getDevices()) await attachQuietly(d)
}

/** Whether this browser can be asked for a puck through WebHID. */
export function spaceMouseHidAvailable(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.hid
}

/** How asking for a puck ended. */
export type SpaceMouseHidResult = 'connected' | 'cancelled' | 'failed'

/** The browser's device chooser, narrowed to multi-axis controllers from the
 *  two vendors SPACE_MOUSE_ID knows. */
const HID_FILTERS: HIDDeviceFilter[] = [0x256f, 0x046d].map((vendorId) => ({ vendorId, usagePage: 1, usage: 8 }))

/** Ask the operator for a puck and read it. Must be called from a click or a
 *  key press: the browser shows its chooser only for one. The grant may not
 *  outlast the plug (a puck without a serial number cannot be recognised when
 *  it comes back), so this is how a replugged puck is taken up again. */
export async function connectSpaceMouseHid(): Promise<SpaceMouseHidResult> {
  const api = navigator.hid
  if (!api) return 'failed'
  // The disconnect handling must be in place even if no viewport has started
  // listening yet.
  listenForSpaceMouse()
  try {
    // Before any other await, while the click still counts as the gesture.
    const picked = await api.requestDevice({ filters: HID_FILTERS })
    for (const d of picked) if (await attachHid(d)) return 'connected'
    return 'cancelled'
  } catch (err) {
    console.warn(UDEV_HINT, err)
    return 'failed'
  }
}

function listenForHid(api: HID): void {
  // A device the page was let use before, plugged in again.
  api.addEventListener('connect', (e) => void attachQuietly(e.device))
  api.addEventListener('disconnect', (e) => {
    if (e.device !== hid) return
    hid.removeEventListener('inputreport', onHidReport)
    hid = null
    hidId = null
    axes.fill(0)
    changed()
    void findHid(api)
  })
  void findHid(api)
}

const resetMotionClock = (): void => {
  lastRead = performance.now()
  lastActive = -Infinity
}

const pageActive = (): boolean => document.visibilityState === 'visible' && document.hasFocus()

/** Start watching for a puck. Called by every viewport; only the first call
 *  does anything. */
export function listenForSpaceMouse(): void {
  if (listening || typeof window === 'undefined') return
  const hidApi = navigator.hid
  if (!('getGamepads' in navigator) && !hidApi) return
  listening = true
  window.addEventListener('blur', resetMotionClock)
  window.addEventListener('focus', resetMotionClock)
  document.addEventListener('visibilitychange', resetMotionClock)
  if (hidApi) listenForHid(hidApi)
  if (!('getGamepads' in navigator)) return
  const attach = (gp: Gamepad | null): void => {
    if (index !== -1 || !gp?.connected || !isSpaceMouse(gp.id)) return
    index = gp.index
    attachedId = gp.id
    lastRead = performance.now()
    console.info(`SpaceMouse connected: ${gp.id}`)
    changed()
  }
  window.addEventListener('gamepadconnected', (e) => attach(e.gamepad))
  // One that this page has already been shown, from before this ran.
  for (const gp of navigator.getGamepads()) attach(gp)
  window.addEventListener('gamepaddisconnected', (e) => {
    if (e.gamepad.index !== index) return
    index = -1
    attachedId = null
    // The buffer holds the gamepad's last axes; a WebHID puck taking over must
    // not fly on them until its own next report.
    axes.fill(0)
    // A second puck already on this page takes over.
    for (const gp of navigator.getGamepads()) attach(gp)
    if (index === -1) changed()
  })
}

/** Whether a puck is attached: the frame loop's one check. */
export function spaceMouseAttached(): boolean {
  return index !== -1 || hidId !== null
}

/** Point the puck at this viewport: the mouse is over it, or it has just
 *  opened. */
export function aimSpaceMouse(owner: object): void {
  driver = owner
}

/** This viewport is closing or pausing: if it has the puck, it lets go. */
export function releaseSpaceMouse(owner: object): void {
  if (driver === owner) driver = null
}

/**
 * This frame's puck motion for `owner`, or null when the puck is at rest or is
 * driving another viewport. `showing` is whether the owner is in view. One that
 * is not lets go of the puck, so that a view hidden behind another workspace
 * cannot keep it.
 */
export function readSpaceMouse(owner: object, showing: boolean): SpaceMouseMotion | null {
  if (!pageActive()) {
    resetMotionClock()
    return null
  }
  if (!showing) {
    releaseSpaceMouse(owner)
    return null
  }
  driver ??= owner
  if (driver !== owner) return null
  const now = performance.now()
  const dt = Math.min((now - lastRead) / 1000, 0.1)
  lastRead = now
  const ready = index !== -1 ? pullGamepad() : hidReady(now)
  if (!ready || dt <= 0) return null
  const read = (a: SpaceMouseAxisId): number => spaceMouseAxis(axes[RAW[a].at]) * gain[a] || 0
  const m: SpaceMouseMotion = {
    dt,
    tx: read('tx'),
    ty: read('ty'),
    tz: read('tz'),
    rx: read('rx'),
    ry: read('ry'),
    rz: read('rz'),
  }
  if (!m.tx && !m.ty && !m.tz && !m.rx && !m.ry && !m.rz) return null
  lastActive = now
  return m
}

/** Whether the puck moved in the last 100 ms. The 3Dconnexion driver can
 *  emulate wheel events while the puck is pushed, and a zoom towards the idle
 *  cursor on top of the puck's own makes the view jump, so the wheel is
 *  ignored meanwhile. Never true without a puck. */
export function spaceMouseBusy(): boolean {
  return pageActive() && performance.now() - lastActive < 100
}
