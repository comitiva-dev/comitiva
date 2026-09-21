import {
  AppError,
  ipcInvoke,
  type IpcParsedInput,
  type IpcInvokeChannel,
  type IpcOutput,
  type IpcResult,
} from '@comitiva/contract';

export type InvokeHandlers = {
  [C in IpcInvokeChannel]: (input: IpcParsedInput<C>) => Promise<IpcOutput<C>> | IpcOutput<C>;
};

/**
 * Validates input, runs the handler, and validates (and strips) the output,
 * so nothing outside the declared shape — secrets included — reaches the
 * renderer. Errors cross as AppError shapes so codes survive IPC.
 */
export async function runInvoke<C extends IpcInvokeChannel>(
  channel: C,
  rawInput: unknown,
  handler: InvokeHandlers[C],
): Promise<IpcResult<IpcOutput<C>>> {
  const schema = ipcInvoke[channel];
  const input = schema.input.safeParse(rawInput);
  if (!input.success) {
    return {
      ok: false,
      error: new AppError('invalid_request', `Invalid input for ${channel}`).toJSON(),
    };
  }
  try {
    const value = await handler(input.data as IpcParsedInput<C>);
    return { ok: true, value: schema.output.parse(value) as IpcOutput<C> };
  } catch (err) {
    return { ok: false, error: AppError.from(err).toJSON() };
  }
}
