import { createInterface } from 'readline';

export interface PromptOptions {
  /** Suppress echo of the typed characters (for secrets). */
  mask?: boolean;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
}

/**
 * Ask a question on stderr and resolve with the answer.
 *
 * Rejects with `cancelled` only when the input stream closes without an
 * answer (Ctrl+C or EOF).
 *
 * Note: `readline.Interface#close()` emits 'close' synchronously, so the
 * answer must be resolved before closing and the 'close' handler must ignore
 * the close that follows an answer. Otherwise every answered prompt rejects.
 */
export function prompt(query: string, options: PromptOptions = {}): Promise<string> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;
  const rl = createInterface({ input, output, terminal: true });

  let answered = false;
  let muted = false;

  if (options.mask) {
    // readline renders the line buffer itself; swallow those writes while muted
    // so the secret never reaches the terminal (or its scrollback).
    (rl as unknown as { _writeToOutput(str: string): void })._writeToOutput = (str: string) => {
      if (!muted) output.write(str);
      else if (str.includes('\n')) output.write('\n');
    };
  }

  return new Promise<string>((resolve, reject) => {
    rl.on('close', () => {
      if (!answered) reject(new Error('cancelled'));
    });

    rl.question(query, answer => {
      answered = true;
      resolve(answer);
      rl.close();
    });

    // question() writes the prompt synchronously, so mute only after it lands.
    muted = options.mask === true;
  });
}
