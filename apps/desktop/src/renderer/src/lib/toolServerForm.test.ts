import { describe, expect, it } from 'vitest';
import { ipcInvoke } from '@comitiva/contract';
import { toolServer } from '../store/testBackend';
import {
  describeServer,
  emptyForm,
  formFromServer,
  formProblems,
  formToDraft,
  formToPatch,
} from './toolServerForm';

describe('toolServerForm', () => {
  it('builds a stdio draft with args per line, plain values and new secrets', () => {
    const draft = formToDraft({
      ...emptyForm(),
      name: ' Search ',
      command: ' npx ',
      args: '-y\n\n search-mcp \n',
      env: [
        { key: 'API_KEY', value: 'sk-1', secret: true, stored: false },
        { key: 'REGION', value: 'eu', secret: false, stored: false },
        { key: '', value: '', secret: false, stored: false },
      ],
    });
    expect(draft).toEqual({
      name: 'Search',
      enabled: true,
      spec: {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'search-mcp'],
        env: { API_KEY: { secret: 'sk-1' }, REGION: { value: 'eu' } },
      },
    });
    expect(ipcInvoke['toolServers.create'].input.safeParse(draft).success).toBe(true);
  });

  it('keeps a stored secret when its field stays empty, and never shows its value', () => {
    const server = toolServer('s', {
      transport: 'http',
      command: null,
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: { secretRef: 'toolServer:s:header:Authorization' } },
    });
    const form = formFromServer(server);
    expect(form.headers).toEqual([{ key: 'Authorization', value: '', secret: true, stored: true }]);
    expect(formToPatch(form).spec).toEqual({
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: { keepSecret: true } },
    });
    form.headers[0]!.value = 'Bearer new';
    expect(formToPatch(form).spec).toMatchObject({
      headers: { Authorization: { secret: 'Bearer new' } },
    });
  });

  it('reports problems', () => {
    expect(formProblems(emptyForm())).toEqual(['nameRequired', 'commandRequired']);
    const http = { ...emptyForm(), name: 'x', transport: 'http' as const, url: 'ftp://x' };
    expect(formProblems(http)).toEqual(['urlInvalid']);
    const rows = {
      ...emptyForm(),
      name: 'x',
      command: 'y',
      env: [
        { key: 'BAD NAME', value: '1', secret: false, stored: false },
        { key: 'A', value: '1', secret: false, stored: false },
        { key: 'A', value: '', secret: true, stored: false },
      ],
    };
    expect(formProblems(rows).sort()).toEqual(['keyInvalid', 'keyRepeated', 'secretRequired']);
  });

  it('describes a server by its command line or URL', () => {
    expect(describeServer(toolServer('s', { command: 'npx', args: ['-y', 'x'] }))).toBe('npx -y x');
    expect(
      describeServer(
        toolServer('h', { transport: 'http', command: null, url: 'https://x.dev/mcp' }),
      ),
    ).toBe('https://x.dev/mcp');
  });
});
