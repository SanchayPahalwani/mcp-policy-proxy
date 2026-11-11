import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { PendingApproval } from '../../src/approval/types.js';
import { SIGNATURE_HEADER, sign, webhookApprover } from '../../src/approval/webhook.js';

const SECRET = 'webhook-test-secret';

const PENDING: PendingApproval = {
  call_id: 'call-1',
  identity: 'release-manager',
  session: 's1',
  server: 'docs',
  tool: 'publish',
  args: { id: 7, token: '[REDACTED]' },
  rule: 'release-publish',
  reason: 'rule "release-publish" requires approval',
  requested_at: '1970-01-01T00:00:01.000Z',
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Received {
  method: string | undefined;
  contentType: string | undefined;
  signatureValid: boolean;
  body: unknown;
}

type Reply = (res: ServerResponse) => void;

/** A webhook that checks each request's signature and answers with `reply`. */
async function webhook(reply: Reply): Promise<{ url: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: req.method,
        contentType: req.headers['content-type'],
        signatureValid: req.headers[SIGNATURE_HEADER] === sign(SECRET, raw),
        body: JSON.parse(raw),
      });
      reply(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/approve`, received };
}

const json =
  (status: number, body: unknown): Reply =>
  (res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

const signal = () => new AbortController().signal;

describe('webhook approver', () => {
  it('signs the hex HMAC-SHA256 of the body', () => {
    // Known answer from `printf 'hello' | openssl dgst -sha256 -hmac key`.
    expect(sign('key', 'hello')).toBe(
      'sha256=9307b3b915efb5171ff14d8cb55fbcc798c6c0ef1456d66ded1a6aa723a58b7b',
    );
  });

  it('posts the signed pending call and returns an approval', async () => {
    const { url, received } = await webhook(json(200, { approved: true, approver: 'ana' }));
    const approver = webhookApprover({ url, secret: SECRET });

    expect(await approver.request(PENDING, signal())).toEqual({ approved: true, approver: 'ana' });
    expect(received).toEqual([
      {
        method: 'POST',
        contentType: 'application/json',
        signatureValid: true,
        body: PENDING,
      },
    ]);
  });

  it('returns a refusal with its note', async () => {
    const { url } = await webhook(json(200, { approved: false, note: 'no' }));
    const approver = webhookApprover({ url, secret: SECRET });

    expect(await approver.request(PENDING, signal())).toEqual({ approved: false, note: 'no' });
  });

  it('drops fields that are not strings', async () => {
    const { url } = await webhook(json(200, { approved: false, approver: 7, note: ['x'] }));
    const approver = webhookApprover({ url, secret: SECRET });

    expect(await approver.request(PENDING, signal())).toEqual({ approved: false });
  });

  it('rejects a non-2xx status', async () => {
    const { url } = await webhook(json(500, { approved: true }));
    const approver = webhookApprover({ url, secret: SECRET });

    await expect(approver.request(PENDING, signal())).rejects.toThrow(
      'approval webhook failed: HTTP 500',
    );
  });

  it('rejects an answer without a boolean approved', async () => {
    const { url } = await webhook(json(200, {}));
    const approver = webhookApprover({ url, secret: SECRET });

    await expect(approver.request(PENDING, signal())).rejects.toThrow(
      'approval webhook failed: invalid response',
    );
  });

  it('rejects a body that is not JSON', async () => {
    const { url } = await webhook((res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('yes');
    });
    const approver = webhookApprover({ url, secret: SECRET });

    await expect(approver.request(PENDING, signal())).rejects.toThrow(
      'approval webhook failed: invalid response',
    );
  });

  it('never puts the secret in an error', async () => {
    const { url } = await webhook(json(403, { error: SECRET }));
    const approver = webhookApprover({ url, secret: SECRET });

    const error = await approver.request(PENDING, signal()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it('never puts the URL in an error', async () => {
    const urlToken = 'tok-in-the-url';
    const statusUrl = `${(await webhook(json(500, {}))).url}?key=${urlToken}`;
    const refused = webhookApprover({ url: statusUrl, secret: SECRET });
    // Port 1 on loopback has no listener, so the request itself fails.
    const unreachable = webhookApprover({
      url: `http://127.0.0.1:1/approve?key=${urlToken}`,
      secret: SECRET,
    });

    for (const approver of [refused, unreachable]) {
      const error = await approver.request(PENDING, signal()).then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toMatch(/^approval webhook failed: /);
      expect(
        JSON.stringify({ message: error?.message, cause: String(error?.cause) }),
      ).not.toContain(urlToken);
    }
  });

  it('rejects when the signal aborts', async () => {
    let answer: (() => void) | undefined;
    // Holds the response until the test ends, so only the abort can settle the request.
    const { url, received } = await webhook((res) => {
      answer = () => json(200, { approved: true })(res);
    });
    cleanups.push(async () => answer?.());
    const approver = webhookApprover({ url, secret: SECRET });
    const controller = new AbortController();

    const pending = approver.request(PENDING, controller.signal);
    await expect.poll(() => received.length).toBe(1);
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it('uses an injected fetch', async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ approved: true }), { status: 200 });
    }) as typeof fetch;
    const approver = webhookApprover({
      url: 'http://127.0.0.1:1/approve',
      secret: SECRET,
      fetch: fakeFetch,
    });

    expect(await approver.request(PENDING, signal())).toEqual({ approved: true });
    const body = seen[0]?.init?.body as string;
    expect(JSON.parse(body)).toEqual(PENDING);
    expect((seen[0]?.init?.headers as Record<string, string>)[SIGNATURE_HEADER]).toBe(
      sign(SECRET, body),
    );
  });
});
