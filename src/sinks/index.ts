import type { Sink } from "./types.js";
import { ConsoleSink } from "./console.js";
import { EmailSink } from "./email.js";
import type { EmailSinkOptions } from "./email.js";
import { FileSink } from "./file.js";

export { ConsoleSink } from "./console.js";
export { EmailSink } from "./email.js";
export type { EmailSinkOptions, EmailSmtpOptions } from "./email.js";
export { FileSink } from "./file.js";

/** Console and file always run; email only when a recipient is configured. */
export function createSinks(opts: { email?: EmailSinkOptions | null }): Sink[] {
  return [new ConsoleSink(), new FileSink(), ...(opts.email ? [new EmailSink(opts.email)] : [])];
}
