/**
 * RFC 4180 CSV. Values are quoted whenever they could otherwise be misread,
 * and the file opens with a BOM so Excel reads it as UTF-8 instead of the
 * local codepage (accented agent names come back mangled without it).
 */

const needsQuotes = /[",\r\n]/;

/**
 * UTF-8 byte order mark, built rather than written, so formatting tools do not
 * turn the escape into an invisible character in the source.
 */
const BOM = String.fromCharCode(0xfeff);

function cell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return needsQuotes.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | boolean | null | undefined>>,
): string {
  const lines = [header.map(cell).join(','), ...rows.map((r) => r.map(cell).join(','))];
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
