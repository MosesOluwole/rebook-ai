import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { getEnv } from '@/shared/config/env';

/**
 * Test-engineer addition (Phase 3, Phase 2 follow-up 2): "`db:roles` succeeds with a
 * `rebook_authenticator.<ref>` username". The unit test proves the parser accepts the form and
 * that other roles are refused; this runs the real script end to end with that username.
 *
 * The local stack has no pooler (supabase/config.toml, [db.pooler] enabled = false), so a tiny
 * TCP relay stands in for Supavisor's one relevant behaviour: it reads the Postgres startup
 * message, records the username the client sent, strips the `.<project-ref>` suffix and forwards
 * everything else byte for byte to the real local Postgres. The script must set the password,
 * log in through the relay with the pooler-form username and see the bare role as current_user.
 * The password is the one already in APP_DATABASE_URL, so the role's password is unchanged.
 */

const PROJECT_REF = 'abcdefghij0123456789';
const SSL_REQUEST = 80877103;
const GSSENC_REQUEST = 80877104;
const PROTOCOL_3 = 196608;

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsxCli = path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

let relay: net.Server;
let relayPort: number;
const usernamesSeen: string[] = [];

function rewriteStartup(message: Buffer): Buffer {
  const parts = message
    .subarray(8, message.length - 1)
    .toString('utf8')
    .split('\0');
  const out: string[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const key = parts[i] ?? '';
    let value = parts[i + 1] ?? '';
    if (key === 'user') {
      usernamesSeen.push(value);
      value = value.replace(/\.[a-z0-9]+$/, '');
    }
    out.push(key, value);
  }
  const body = Buffer.from(`${out.join('\0')}\0\0`, 'utf8');
  const header = Buffer.alloc(8);
  header.writeInt32BE(body.length + 8, 0);
  header.writeInt32BE(PROTOCOL_3, 4);
  return Buffer.concat([header, body]);
}

beforeAll(async () => {
  const upstream = new URL(getEnv().APP_DATABASE_URL);
  relay = net.createServer((client) => {
    let pending = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 8) {
        const length = pending.readInt32BE(0);
        if (pending.length < length) {
          return;
        }
        const code = pending.readInt32BE(4);
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) {
          client.write('N');
          continue;
        }
        client.off('data', onData);
        const server = net.connect(Number(upstream.port), upstream.hostname, () => {
          server.write(rewriteStartup(message));
          if (pending.length > 0) {
            server.write(pending);
          }
          client.pipe(server);
          server.pipe(client);
        });
        server.on('error', () => client.destroy());
        client.on('error', () => server.destroy());
        return;
      }
    };
    client.on('data', onData);
  });
  await new Promise<void>((resolve) => relay.listen(0, '127.0.0.1', resolve));
  const address = relay.address();
  if (address === null || typeof address === 'string') {
    throw new Error('relay has no port');
  }
  relayPort = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) =>
    relay.close(() => {
      resolve();
    }),
  );
});

function runDbRoles(appDatabaseUrl: string): Promise<{ status: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, 'scripts/db-roles.ts'], {
      cwd: projectRoot,
      env: { ...process.env, APP_DATABASE_URL: appDatabaseUrl },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (status) => {
      resolve({ status, out });
    });
  });
}

describe('pnpm db:roles behind a pooler-style username', () => {
  it(`succeeds with rebook_authenticator.<project-ref> and logs in as the bare role`, async () => {
    const url = new URL(getEnv().APP_DATABASE_URL);
    url.username = `rebook_authenticator.${PROJECT_REF}`;
    url.hostname = '127.0.0.1';
    url.port = String(relayPort);
    const result = await runDbRoles(url.toString());
    expect(result.out).toContain(
      'db:roles: password set for rebook_authenticator and login verified',
    );
    expect(result.status).toBe(0);
    // The relay really carried the pooler-form username (the script did not strip it itself).
    expect(usernamesSeen).toContain(`rebook_authenticator.${PROJECT_REF}`);
  }, 60_000);

  it('still refuses another role in the pooler form, before connecting', async () => {
    const url = new URL(getEnv().APP_DATABASE_URL);
    url.username = `rebook_app.${PROJECT_REF}`;
    url.port = String(relayPort);
    const before = usernamesSeen.length;
    const result = await runDbRoles(url.toString());
    expect(result.status).toBe(1);
    expect(result.out).toContain(
      'must connect as rebook_authenticator or rebook_authenticator.<project-ref>',
    );
    expect(usernamesSeen.length).toBe(before);
  }, 60_000);
});
