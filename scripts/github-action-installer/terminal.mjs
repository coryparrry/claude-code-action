import { createInterface, emitKeypressEvents } from "node:readline";

export class Terminal {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.output = output;
  }

  get interactive() {
    return !!this.input.isTTY && !!this.output.isTTY;
  }

  write(message) {
    this.output.write(`${message}\n`);
  }

  ask(question) {
    const reader = createInterface({ input: this.input, output: this.output });
    return new Promise((resolve, reject) => {
      let answered = false;
      reader.once("SIGINT", () => {
        answered = true;
        const error = new Error("Installation cancelled.");
        error.cancelled = true;
        reader.close();
        reject(error);
      });
      reader.once("close", () => {
        if (!answered)
          reject(new Error("Input closed; no installation was performed."));
      });
      reader.question(question, (answer) => {
        answered = true;
        reader.close();
        resolve(answer.trim());
      });
    });
  }

  async confirm(question, defaultYes = false) {
    const answer = await this.ask(
      `${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `,
    );
    return answer ? /^y(es)?$/i.test(answer) : defaultYes;
  }

  secret(question) {
    if (!this.interactive)
      throw new Error("Use --key-file or --use-env-key outside a terminal.");
    this.output.write(question);
    emitKeypressEvents(this.input);
    const wasRaw = !!this.input.isRaw;
    this.input.setRawMode(true);
    this.input.resume();
    return new Promise((resolve, reject) => {
      let value = "";
      const done = (error) => {
        this.input.removeListener("keypress", onKey);
        this.input.removeListener("end", onEnd);
        this.input.setRawMode(wasRaw);
        this.input.pause();
        this.output.write("\n");
        if (error) reject(error);
        else resolve(value);
      };
      const onEnd = () =>
        done(new Error("Input closed; no installation was performed."));
      const onKey = (text, key) => {
        if (key?.ctrl && ["c", "d"].includes(key.name)) {
          const error = new Error("Installation cancelled.");
          error.cancelled = true;
          done(error);
        } else if (["return", "enter"].includes(key?.name)) {
          done();
        } else if (key?.name === "backspace") {
          if (value.length) {
            value = value.slice(0, -1);
            this.output.write("\b \b");
          }
        } else if (
          text &&
          !key?.ctrl &&
          !key?.meta &&
          !/[\r\n\x00-\x1f]/.test(text)
        ) {
          value += text;
          this.output.write("*".repeat(text.length));
        }
      };
      this.input.on("keypress", onKey);
      this.input.once("end", onEnd);
    });
  }
}
