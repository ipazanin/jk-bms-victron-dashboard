import { googleRequest } from './googleRequest'

export const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets'
export const ARCHIVE_HEADER = ['id', 'sourceId', 'sourceLabel', 'exportedAt', 'manifestFileId', 'manifestHash', 'contentHash', 'sessions', 'samples', 'bytes']
export const SETTINGS_HEADER = ['id', 'sourceId', 'parents', 'createdAt', 'theme', 'sidebar', 'statsPreferences', 'victronAdvertisementKey']

export async function readSheetRanges(spreadsheetId: string, ranges: readonly string[], signal: AbortSignal): Promise<unknown[][][]> {
  const parameters = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'SERIAL_NUMBER', majorDimension: 'ROWS' })
  for (const range of ranges) parameters.append('ranges', range)
  const response = await googleRequest(`${SHEETS}/${encodeURIComponent(spreadsheetId)}/values:batchGet?${parameters}`, signal)
  const body = await response.json() as { valueRanges?: { values?: unknown[][] }[] }
  if (!Array.isArray(body.valueRanges) || body.valueRanges.length !== ranges.length) throw new Error('Google returned an incomplete archive catalogue.')
  return body.valueRanges.map((range) => {
    const rows = range.values ?? []
    if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row))) throw new Error('Google returned an invalid archive table.')
    return rows
  })
}

export function tableBody(rows: unknown[][], header: readonly string[]): unknown[][] {
  if (JSON.stringify(rows[0]) !== JSON.stringify(header)) throw new Error('The Google archive table has changed. Its column headers must remain unchanged.')
  return rows.slice(1).map((row) => {
    if (row.length > header.length) throw new Error('The Google archive contains unexpected columns.')
    return row
  })
}
