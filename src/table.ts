// Snapshot table rendering for /vault list (and /vault restore with no
// machine argument). Plain-text, monospace-safe: CJK strings are padded by
// display width (2 cells per fullwidth rune), so the table stays aligned in
// the TUI, in feishu passthrough, and in GitHub-flavored text alike.

import type { MachineSnapshotSummary } from './gh.ts'

/** East-Asian width heuristic: anything above the Hangul jamo block renders 2 cells. */
function displayWidth(s: string): number {
  let width = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    width += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6)) ? 2 : 1
  }
  return width
}

function padEnd(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)))
}

function padStart(s: string, width: number): string {
  return ' '.repeat(Math.max(0, width - displayWidth(s))) + s
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

/** ISO timestamp → local "YYYY-MM-DD HH:mm" (raw input when unparseable). */
export function formatLocalTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const two = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`
}

interface Column {
  header: string
  align?: 'left' | 'right'
  cell(m: MachineSnapshotSummary): string
}

/**
 * Render one aligned line per machine. The current machine is marked with
 * “← 本机”; machines whose manifest is missing/corrupt still get a row
 * (dashes) so a hand-mangled vault directory is visible instead of hidden.
 */
export function renderSnapshotTable(summaries: MachineSnapshotSummary[], currentMachine: string): string {
  const columns: Column[] = [
    { header: '机器', cell: (m) => m.machine + (m.machine === currentMachine ? ' ← 本机' : '') },
    { header: '描述', cell: (m) => m.manifest?.description || '—' },
    { header: '快照时间', cell: (m) => (m.manifest !== undefined ? formatLocalTime(m.manifest.createdAt) : '—') },
    { header: '文件', align: 'right', cell: (m) => (m.manifest !== undefined ? String(m.manifest.files.length) : '—') },
    { header: '大小', align: 'right', cell: (m) => (m.manifest !== undefined ? formatBytes(m.manifest.blobSize) : '—') },
    { header: '插件', cell: (m) => m.manifest?.pluginVersion ?? '—' },
  ]

  const rows = summaries.map((m) => columns.map((col) => col.cell(m)))
  const widths = columns.map((col, i) => {
    const body = rows.map((row) => displayWidth(row[i]))
    return Math.max(displayWidth(col.header), ...body)
  })

  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => (columns[i].align === 'right' ? padStart(cell, widths[i]) : padEnd(cell, widths[i])))
      .join('  ')

  const rule = widths.map((w) => '-'.repeat(w)).join('  ')
  return [line(columns.map((col) => col.header)), rule, ...rows.map(line)].join('\n')
}
