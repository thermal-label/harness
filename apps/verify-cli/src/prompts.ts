/**
 * Thin wrappers around `@inquirer/prompts` for the wizard.
 *
 * Why a wrapper: `--no-prompt` is a hard mode — if execution would block
 * for input in that mode, fail loudly with a useful message rather than
 * hanging the terminal. Centralising in one helper keeps each prompt
 * site free of guard noise.
 *
 * Picked `@inquirer/prompts` (v7) because it's the lightest dep that
 * gives both `select` and free-form `input` with Ctrl-C handling that
 * matches expectations. There's no pre-existing TUI library in the
 * thermal-label workspace to align with.
 */
import { confirm, input, select } from '@inquirer/prompts';

export class NoPromptError extends Error {
  constructor(field: string) {
    super(`--no-prompt was set, but ${field} is missing. Pass it via the corresponding flag.`);
    this.name = 'NoPromptError';
  }
}

export interface PromptContext {
  /** When true, any prompt call throws `NoPromptError` instead of asking. */
  noPrompt: boolean;
}

export async function promptSelect<T extends string>(
  ctx: PromptContext,
  field: string,
  message: string,
  choices: readonly { value: T; name: string; description?: string }[],
): Promise<T> {
  if (ctx.noPrompt) throw new NoPromptError(field);
  return select<T>({ message, choices: [...choices] });
}

export async function promptInput(
  ctx: PromptContext,
  field: string,
  message: string,
  defaultValue?: string,
): Promise<string> {
  if (ctx.noPrompt) throw new NoPromptError(field);
  const result = await input(
    defaultValue === undefined ? { message } : { message, default: defaultValue },
  );
  return result;
}

export async function promptConfirm(
  ctx: PromptContext,
  field: string,
  message: string,
  defaultValue = true,
): Promise<boolean> {
  if (ctx.noPrompt) throw new NoPromptError(field);
  return confirm({ message, default: defaultValue });
}
