// SPDX-License-Identifier: AGPL-3.0-only
// The part of WebHID (wicg.github.io/webhid) that the SpaceMouse reader uses.
// TypeScript's DOM library does not include it yet, and a typings package
// would be a dependency for a handful of lines.

interface HIDReportItem {
  readonly reportCount?: number
  readonly reportSize?: number
  readonly logicalMinimum?: number
  readonly logicalMaximum?: number
}

interface HIDReportInfo {
  readonly reportId?: number
  readonly items?: readonly HIDReportItem[]
}

interface HIDCollectionInfo {
  readonly usagePage?: number
  readonly usage?: number
  readonly inputReports?: readonly HIDReportInfo[]
  readonly children?: readonly HIDCollectionInfo[]
}

interface HIDInputReportEvent extends Event {
  readonly device: HIDDevice
  readonly reportId: number
  readonly data: DataView
}

interface HIDDevice extends EventTarget {
  readonly opened: boolean
  readonly vendorId: number
  readonly productId: number
  readonly productName: string
  readonly collections: readonly HIDCollectionInfo[]
  open(): Promise<void>
  close(): Promise<void>
  addEventListener(type: 'inputreport', listener: (e: HIDInputReportEvent) => void): void
  removeEventListener(type: 'inputreport', listener: (e: HIDInputReportEvent) => void): void
}

interface HIDConnectionEvent extends Event {
  readonly device: HIDDevice
}

interface HIDDeviceFilter {
  vendorId?: number
  productId?: number
  usagePage?: number
  usage?: number
}

interface HID extends EventTarget {
  getDevices(): Promise<HIDDevice[]>
  requestDevice(options: { filters: HIDDeviceFilter[] }): Promise<HIDDevice[]>
  addEventListener(type: 'connect' | 'disconnect', listener: (e: HIDConnectionEvent) => void): void
}

interface Navigator {
  /** Absent outside Chromium, and on pages not served securely. */
  readonly hid?: HID
}
