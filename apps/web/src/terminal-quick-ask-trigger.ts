export type TerminalInputAction =
  | { type: "send"; data: string }
  | { type: "quickAsk" };

export class TerminalQuickAskTrigger {
  private line = "";
  private pendingQuestionMarks = "";

  consume(data: string): TerminalInputAction[] {
    const actions: TerminalInputAction[] = [];
    let outgoing = "";
    const flushOutgoing = () => {
      if (outgoing === "") return;
      actions.push({ type: "send", data: outgoing });
      outgoing = "";
    };
    const append = (value: string) => {
      outgoing += value;
      this.line = `${this.line}${value}`.slice(-4_096);
    };

    for (const character of data) {
      if (this.pendingQuestionMarks !== "") {
        if (isQuestionMark(character) && this.pendingQuestionMarks.length === 1) {
          this.pendingQuestionMarks += character;
          continue;
        }
        if (isEnter(character) && [...this.pendingQuestionMarks].length === 2) {
          flushOutgoing();
          this.pendingQuestionMarks = "";
          this.line = "";
          actions.push({ type: "quickAsk" });
          continue;
        }
        if (isBackspace(character)) {
          this.pendingQuestionMarks = [...this.pendingQuestionMarks].slice(0, -1).join("");
          continue;
        }
        append(this.pendingQuestionMarks);
        this.pendingQuestionMarks = "";
      }

      if (this.line === "" && isQuestionMark(character)) {
        this.pendingQuestionMarks = character;
      } else if (isEnter(character)) {
        outgoing += character;
        this.line = "";
      } else if (isBackspace(character)) {
        outgoing += character;
        this.line = [...this.line].slice(0, -1).join("");
      } else {
        append(character);
        if (character === "\x03" || character === "\x15") this.line = "";
      }
    }

    flushOutgoing();
    return actions;
  }
}

function isQuestionMark(value: string): boolean {
  return value === "?" || value === "？";
}

function isEnter(value: string): boolean {
  return value === "\r" || value === "\n";
}

function isBackspace(value: string): boolean {
  return value === "\x7f" || value === "\b";
}
