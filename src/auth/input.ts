import { CliError } from "../errors.js";

export async function readSignInCode(): Promise<string> {
  if (!process.stdin.isTTY) {
    let value = "";
    for await (const chunk of process.stdin) {
      value += chunk.toString();
      if (value.length > 128) throw new CliError("Sign-in code input is too long.");
    }
    const code = value.trim();
    if (!code) {
      throw new CliError(
        "No sign-in code was received on stdin. Complete sign-in with `understudy login --code <code>` in this coding-agent shell or terminal. For hidden input, run `understudy login --code` in an interactive terminal with the same machine, user home and CLI service. Automated callers can also supply stdin and close the stream. Alternatively, run `understudy login` for browser sign-in.",
      );
    }
    return code;
  }
  const input = process.stdin;
  const wasRaw = input.isRaw;
  process.stderr.write("One-time code (hidden): ");
  input.setRawMode(true);
  input.resume();
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const finish = (error?: Error) => {
        input.removeListener("data", onData);
        input.removeListener("end", onEnd);
        input.removeListener("error", onError);
        if (error) reject(error); else resolve(value.trim());
      };
      const onEnd = () => finish(new CliError("Sign-in input ended before a code was submitted."));
      const onError = () => finish(new CliError("Could not read the sign-in code."));
      const onData = (chunk: Buffer) => {
        for (const character of chunk.toString("utf8")) {
          if (character === "\u0003" || character === "\u0004") { finish(new CliError("Sign-in cancelled.")); return; }
          if (character === "\r" || character === "\n") { finish(); return; }
          if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
          else if (/^[0-9]$/.test(character)) value += character;
          else { finish(new CliError("The sign-in code must contain only digits.")); return; }
          if (value.length > 6) { finish(new CliError("The sign-in code must contain six digits.")); return; }
        }
      };
      input.on("data", onData);
      input.once("end", onEnd);
      input.once("error", onError);
    });
  } finally {
    input.setRawMode(wasRaw);
    input.pause();
    process.stderr.write("\n");
  }
}
