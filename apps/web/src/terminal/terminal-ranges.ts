import type { IMarker, Terminal } from "@xterm/xterm";

interface Position { offset: number; marker: IMarker; column: number; columns: number }
/** Ordered terminal writes own byte-to-buffer positions; React never infers them from text. */
export class TerminalRanges {
  private positions: Position[] = [];
  private queue = Promise.resolve();
  private disposed = false;
  constructor(private readonly terminal: Terminal, private readonly changed: () => void) {}

  write(data: string, start: number, done?: () => void): void {
    this.queue = this.queue.then(async () => {
      if (this.disposed) return;
      let offset = start;
      // Newlines and stream edges provide stable positions for block boundaries and deltas.
      for (const part of data.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        if (/\x1b\[(?:2|3)J/.test(part)) this.clear();
        this.record(offset);
        await new Promise<void>((resolve) => this.terminal.write(part, resolve));
        offset += new TextEncoder().encode(part).length;
        if (this.terminal.buffer.active.type === "alternate") this.clear();
        else this.record(offset);
      }
      this.positions = this.positions.filter((position) => !position.marker.isDisposed);
      while (this.positions.length > 24000) this.positions.shift()!.marker.dispose();
      this.changed();
      done?.();
    });
  }

  private record(offset: number) {
    if (this.disposed || this.terminal.buffer.active.type !== "normal") return;
    if (this.positions.at(-1)?.offset === offset) return;
    this.positions.push({ offset, marker: this.terminal.registerMarker(0), column: this.terminal.buffer.active.cursorX, columns: this.terminal.cols });
  }

  rows(start: number, end: number): { first: number; last: number; firstColumn: number; lastColumn: number } | undefined {
    if (this.terminal.buffer.active.type !== "normal") return;
    const valid = this.positions.filter((position) => !position.marker.isDisposed);
    const first = valid.find((position) => position.offset === start);
    const last = valid.find((position) => position.offset === end);
    // Never guess when replay/truncation has lost an exact boundary.
    if (!first || !last || last.marker.line < first.marker.line) return;
    // Row markers reflow with xterm; partial-line columns cannot be recovered after a width change.
    if ((first.column > 0 && first.columns !== this.terminal.cols) || (last.column > 0 && last.columns !== this.terminal.cols)) return;
    return { first: first.marker.line, last: Math.max(first.marker.line, last.marker.line - (last.column === 0 && end > start ? 1 : 0)),
      firstColumn: first.column, lastColumn: last.column || this.terminal.cols };
  }

  clear(): void {
    for (const position of this.positions) position.marker.dispose();
    this.positions = [];
  }
  dispose(): void { this.disposed = true; this.clear(); }
}
