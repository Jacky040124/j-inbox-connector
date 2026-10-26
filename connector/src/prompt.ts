// Terminal prompts for the setup wizard. Secret input is not echoed.
import { createInterface } from "node:readline";

export type Prompt = {
  line(question: string): Promise<string | null>;
  secret(question: string): Promise<string | null>;
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
};

function ask(question: string, hidden: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WritableStream };
      let asked = false;
      out._writeToOutput = (s: string) => {
        if (!asked) {
          asked = true;
          process.stdout.write(s);
        } else if (s.includes("\n") || s.includes("\r")) process.stdout.write("\n");
      };
    }
    let answered = false;
    rl.question(question, (a) => {
      answered = true;
      rl.close();
      resolve(a);
    });
    rl.on("close", () => {
      if (!answered) resolve(null);
    });
  });
}

export const terminalPrompt: Prompt = {
  line: (q) => ask(q, false),
  secret: (q) => ask(q, true),
  async confirm(q, defaultYes = true) {
    const a = (await ask(`${q} ${defaultYes ? "[Y/n]" : "[y/N]"} `, false))?.trim().toLowerCase();
    if (!a) return defaultYes;
    return a === "y" || a === "yes";
  },
};
