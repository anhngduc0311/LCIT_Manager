import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

type TracedRequest = IncomingMessage & { requestId?: string; route?: { path?: string } };

/** An allowlist of fields: never record body, query, raw URL, headers, cookies or credentials. */
export function httpLogging(write: (line: string) => void = (line) => process.stdout.write(`${line}\n`)) {
  return (request: TracedRequest, response: ServerResponse, next: () => void) => {
    request.requestId = randomUUID(); // Ignore caller-supplied IDs to prevent spoofing/log injection.
    response.setHeader('X-Request-Id', request.requestId);
    const started = process.hrtime.bigint();
    let logged = false;
    const log = () => {
      if (logged) return;
      logged = true;
      write(JSON.stringify({ timestamp: new Date().toISOString(), event: 'http.request', requestId: request.requestId,
        method: request.method, route: request.route?.path ?? '<unmatched>', status: response.statusCode,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6, completed: response.writableFinished }));
    };
    response.once('finish', log);
    response.once('close', log);
    next();
  };
}
