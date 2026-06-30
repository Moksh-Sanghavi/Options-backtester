/**
 * Tiny dependency-free CSV export helper.
 *
 * Converts an array of row objects into a CSV string and triggers a browser
 * download via a temporary object URL — no `xlsx`/`papaparse` needed. The
 * generated file opens cleanly in Excel, Google Sheets and LibreOffice.
 */

/** A single CSV column: a header label and how to pull its value from a row. */
export interface CsvColumn<T> {
  header: string;
  value: (row: T) => string | number | null | undefined;
}

/** Escape one field per RFC 4180 — quote it when it contains `," \r \n`. */
function escapeField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Build a CSV document (header row + data rows) from `rows` and `columns`. */
export function rowsToCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const lines = [columns.map((c) => escapeField(c.header)).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeField(c.value(row))).join(","));
  }
  return lines.join("\r\n");
}

/**
 * Trigger a client-side download of `content` as `filename`.
 * Prepends a UTF-8 BOM so Excel reads non-ASCII (₹, –) correctly.
 */
export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob(["﻿", content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
