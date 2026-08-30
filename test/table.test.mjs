// /vault list table: CJK display-width alignment, current-machine marker,
// missing-manifest rows visible as dashes, right-aligned numeric columns.

import test from 'node:test'
import assert from 'node:assert/strict'
import { renderSnapshotTable, formatBytes, formatLocalTime } from '../lib/table.js'

function widthOf(s) {
  let w = 0
  for (const ch of s) w += ch.codePointAt(0) > 0x2e7f ? 2 : 1
  return w
}

const summaries = [
  {
    machine: 'mac-studio',
    manifest: {
      kind: 'dsh-vault-manifest', version: 1, machine: 'mac-studio',
      description: '工作室主力机', createdAt: '2026-08-30T06:05:00.000Z',
      pluginVersion: '0.1.0', nodeVersion: 'v22', files: ['a', 'b', 'c'],
      profileNames: ['tui'], blobSize: 957, blobSha256: 'x',
    },
  },
  {
    machine: 'old-laptop',
    manifest: {
      kind: 'dsh-vault-manifest', version: 1, machine: 'old-laptop',
      description: '', createdAt: 'not-a-date',
      pluginVersion: '0.1.0', nodeVersion: 'v22', files: [], profileNames: [],
      blobSize: 1048576, blobSha256: 'x',
    },
  },
  { machine: 'broken-dir', manifest: undefined },
]

test('every line has equal display width (CJK-aware alignment)', () => {
  const table = renderSnapshotTable(summaries, 'mac-studio')
  const lines = table.split('\n')
  const widths = lines.map(widthOf)
  assert.ok(lines.length >= 5, `header + rule + ${summaries.length} rows`)
  assert.equal(new Set(widths).size, 1, `all lines align (${widths.join(',')})`)
})

test('current machine is marked, others are not', () => {
  const table = renderSnapshotTable(summaries, 'mac-studio')
  const rows = table.split('\n').filter((l) => l.includes('mac-studio') || l.includes('old-laptop'))
  assert.ok(rows[0].includes('← 本机'))
  assert.ok(!rows[1].includes('← 本机'))
})

test('missing manifest renders dashes, not a hidden row', () => {
  const table = renderSnapshotTable([{ machine: 'broken-dir', manifest: undefined }], 'elsewhere')
  assert.ok(table.includes('broken-dir'))
  assert.equal((table.match(/—/g) ?? []).length >= 4, true)
})

test('headers are present', () => {
  const table = renderSnapshotTable([], 'x')
  for (const header of ['机器', '描述', '快照时间', '文件', '大小', '插件']) {
    assert.ok(table.includes(header), `missing header ${header}`)
  }
})

test('formatBytes picks the right unit', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(957), '957 B')
  assert.equal(formatBytes(2048), '2.0 KB')
  assert.equal(formatBytes(1048576), '1.0 MB')
})

test('formatLocalTime renders local YYYY-MM-DD HH:mm, keeps garbage as-is', () => {
  assert.match(formatLocalTime('2026-08-30T06:05:00.000Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatLocalTime('not-a-date'), 'not-a-date')
})
