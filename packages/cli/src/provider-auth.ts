import { createInterface } from 'node:readline/promises';
import { Writable, type Readable } from 'node:stream';
import { isAbsolute } from 'node:path';
import { resolveConnectDataRoot, loginProductionProvider, logoutProductionProvider,
  providerAuthStatus, productionProviderModels } from 'shiploop-host';
import type { AuthPrompt, AuthEvent } from 'shiploop-host';

const HELP = `shiploop provider <login|auth-status|logout|models> openai-codex [--data-root <absolute-path>] [--json]
Login: [--method browser|device] (default browser)
Credentials stay in ShipLoop private storage; global Pi/Codex credentials are not imported.
auth-status is a local check, not an online connectivity/quota test.
Provider/model allowlists remain in pi/runtime.json; models lists built-in IDs and enabled flags.
`;
type Action = 'login' | 'auth-status' | 'logout' | 'models';
export function parseProviderArgs(args: readonly string[]) {
  if (args[0] !== 'provider' || !['login', 'auth-status', 'logout', 'models'].includes(args[1] ?? '')
    || args[2] !== 'openai-codex') throw new Error('provider_auth_invalid_input');
  const action = args[1] as Action;
  const flags = new Map<string, string | boolean>();
  for (let i = 3; i < args.length; i++) {
    const key = args[i]!;
    if (!['--data-root', '--json', '--method'].includes(key) || flags.has(key)) throw new Error('provider_auth_invalid_input');
    if (key === '--json') flags.set(key, true);
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('provider_auth_invalid_input');
      flags.set(key, value);
    }
  }
  const method = flags.get('--method') ?? 'browser', dataRoot = flags.get('--data-root') as string | undefined;
  if (!['browser', 'device'].includes(String(method)) || (flags.has('--method') && action !== 'login')
    || (dataRoot !== undefined && (!isAbsolute(dataRoot) || dataRoot === '/'))) throw new Error('provider_auth_invalid_input');
  return { action, provider: 'openai-codex', method: method as 'browser' | 'device', dataRoot, json: flags.has('--json') };
}

export async function runProviderCli(options: {
  args: readonly string[]; io: { stdout(text: string): void; stderr(text: string): void };
  userHomeDir?: string; input?: Readable & { isTTY?: boolean }; signal?: AbortSignal;
}): Promise<{ exitCode: number }> {
  const { io } = options;
  if (options.args.length === 1 || options.args.includes('--help')) { io.stdout(HELP); return { exitCode: 0 }; }
  let parsed: ReturnType<typeof parseProviderArgs>;
  try { parsed = parseProviderArgs(options.args); }
  catch { io.stderr('shiploop: provider_auth_invalid_input\n' + HELP); return { exitCode: 2 }; }
  const command = 'provider.' + parsed.action;
  const emit = (result: unknown) => {
    io.stdout(parsed.json ? JSON.stringify({ ok: true, command, result }) + '\n'
      : command + ': ' + JSON.stringify(result) + '\n');
  };
  try {
    const { canonicalRoot } = resolveConnectDataRoot(parsed.dataRoot
      ? { dataRoot: parsed.dataRoot } : options.userHomeDir ? { userHomeDir: options.userHomeDir } : {});
    if (parsed.action === 'auth-status') emit(await providerAuthStatus(canonicalRoot, parsed.provider));
    else if (parsed.action === 'models') emit(await productionProviderModels(canonicalRoot, parsed.provider));
    else if (parsed.action === 'logout') {
      await logoutProductionProvider(canonicalRoot, parsed.provider);
      emit({ provider: parsed.provider, status: 'logged_out' });
    } else {
      if (parsed.method === 'browser' && !options.input?.isTTY) throw new Error('provider_auth_interactive_terminal_required');
      const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(900000)]) : AbortSignal.timeout(900000);
      const notify = (event: AuthEvent) => {
        if (event.type === 'auth_url') io.stderr('Open this URL to sign in:\n' + event.url + '\n');
        else if (event.type === 'device_code') io.stderr('Open ' + event.verificationUri + '\nCode: ' + event.userCode + '\n');
        else if (event.type === 'info' || event.type === 'progress') io.stderr(event.message + '\n');
      };
      const prompt = async (request: AuthPrompt): Promise<string> => {
        if (request.type === 'select') {
          const method = parsed.method === 'device' ? 'device_code' : 'browser';
          const choice = request.options.find(option => option.id === method);
          if (!choice) throw new Error('provider_auth_login_method_unavailable');
          return choice.id;
        }
        if (!options.input?.isTTY) throw new Error('provider_auth_interactive_terminal_required');
        // Suppress terminal echo: pasted redirect URLs/auth codes must never enter output logs.
        const muted = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
        const reader = createInterface({ input: options.input, output: muted, terminal: true, historySize: 0 });
        const close = () => reader.close();
        io.stderr(request.message + '\n> ');
        options.input.once('end', close);
        try { return await reader.question('', { signal: request.signal ? AbortSignal.any([signal, request.signal]) : signal }); }
        finally { options.input.removeListener('end', close); reader.close(); muted.end(); io.stderr('\n'); }
      };
      const result = await loginProductionProvider(canonicalRoot, parsed.provider, { signal, prompt, notify });
      emit(result);
    }
    return { exitCode: 0 };
  } catch (error) {
    const reason = options.signal?.aborted ? 'provider_auth_cancelled'
      : error instanceof Error && ['provider_auth_interactive_terminal_required', 'provider_auth_login_method_unavailable',
        'production_pi_config_permissions', 'production_pi_config_directory', 'production_pi_auth_invalid'].includes(error.message)
        ? error.message : 'provider_auth_failed';
    if (parsed.json) io.stdout(JSON.stringify({ ok: false, command, error: { code: reason } }) + '\n');
    else io.stderr('shiploop: ' + reason + '\n');
    return { exitCode: options.signal?.aborted ? 4 : 1 };
  }
}
