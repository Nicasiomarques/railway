import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

export async function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  } finally {
    rl.close();
  }
}

export type SelectItem<T> = { label: string; value: T };

// Simple numbered menu; avoids pulling in an extra dependency just for interactive prompts.
export async function select<T>(question: string, items: SelectItem<T>[]): Promise<T> {
  if (items.length === 0) throw new Error("No options available.");
  if (items.length === 1) {
    console.log(`${question}: ${items[0]!.label} (only option)`);
    return items[0]!.value;
  }

  console.log(question);
  items.forEach((item, index) => console.log(`  ${index + 1}) ${item.label}`));

  const rl = createInterface({ input: stdin, output: stdout });
  try {
    while (true) {
      const raw = (await rl.question("Choose a number: ")).trim();
      const n = Number(raw);
      if (Number.isInteger(n) && n >= 1 && n <= items.length) return items[n - 1]!.value;
      console.log("Invalid option, try again.");
    }
  } finally {
    rl.close();
  }
}
