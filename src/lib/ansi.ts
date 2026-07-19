/** Lightweight ANSI / control-sequence stripper for chat bubbles (not a full terminal). */

const CSI_OR_OSC =
  // eslint-disable-next-line no-control-regex
  /(?:\u001b\[[0-?]*[ -/]*[@-~])|(?:\u001b\][^\u0007]*(?:\u0007|\u001b\\))|(?:\u001b[()][0-9A-Za-z])|(?:\u001b[=>])|(?:\r)/g;

const OTHER_CONTROLS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function stripAnsi(input: string): string {
  return input.replace(CSI_OR_OSC, "").replace(OTHER_CONTROLS, "");
}
