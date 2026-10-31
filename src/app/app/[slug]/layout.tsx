import Link from 'next/link';
import type { ReactNode } from 'react';

import { signOut } from '../../(auth)/actions';
import { loadWorkspace } from './_lib/workspace';

export const dynamic = 'force-dynamic';

export default async function WorkspaceLayout({
  children,
  params,
}: {
  readonly children: ReactNode;
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  const { tenant, myTenants } = await loadWorkspace(slug);
  const base = `/app/${slug}`;

  return (
    <>
      <header className="topbar">
        <div className="switcher">
          <strong>{tenant.name}</strong>
          <nav aria-label="Switch business">
            <ul>
              {myTenants.map((item) => (
                <li key={item.tenantId} aria-current={item.slug === slug ? 'true' : undefined}>
                  <Link href={`/app/${item.slug}`}>{item.name}</Link>
                </li>
              ))}
              <li>
                <Link href="/onboarding">+ New business</Link>
              </li>
            </ul>
          </nav>
        </div>
        <nav aria-label="Workspace">
          <Link href={base}>Dashboard</Link>
          <Link href={`${base}/services`}>Services</Link>
          <Link href={`${base}/team`}>Team</Link>
          <Link href={`${base}/custom-fields`}>Custom fields</Link>
          <Link href={`${base}/time-off`}>Time off</Link>
          <Link href={`${base}/settings`}>Settings</Link>
          <form action={signOut}>
            <button type="submit" className="quiet">
              Sign out
            </button>
          </form>
        </nav>
      </header>
      <main>{children}</main>
    </>
  );
}
