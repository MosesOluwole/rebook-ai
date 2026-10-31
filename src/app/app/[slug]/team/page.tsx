import { can, listMembers, listOpenInvitations } from '@/modules/tenancy';

import { getTenancy } from '../../../_lib/tenancy';
import { loadWorkspace } from '../_lib/workspace';
import { revokeInvitationAction, revokeMemberAction } from './actions';
import { InviteForm } from './invite-form';

export const dynamic = 'force-dynamic';

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

export default async function TeamPage({
  params,
  searchParams,
}: {
  readonly params: Promise<{ readonly slug: string }>;
  readonly searchParams: Promise<{ readonly notice?: string | string[] }>;
}) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const { ctx } = await loadWorkspace(slug);
  const isOwner = ctx.role !== null && can(ctx.role, 'members.invite');
  const tenancy = getTenancy();
  const { members, invitations } = await tenancy.withTenant(ctx, async (tx) => ({
    members: await listMembers(tx),
    invitations: isOwner ? await listOpenInvitations(tx) : [],
  }));
  const notice = first(query.notice);

  return (
    <>
      <h1>Team</h1>
      {notice !== undefined && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <section className="card" aria-labelledby="members-heading">
        <h2 id="members-heading">Members</h2>
        <table>
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Since</th>
              {isOwner && <th />}
            </tr>
          </thead>
          <tbody>
            {members.map((member) => {
              const isYou = member.userId === ctx.actorId;
              return (
                <tr key={member.id}>
                  <td>
                    <code>{member.userId.slice(0, 8)}</code> {isYou && <strong>(you)</strong>}
                  </td>
                  <td>{member.role}</td>
                  <td>{dateFormat.format(member.createdAt)}</td>
                  {isOwner && (
                    <td>
                      {!isYou && (
                        <form action={revokeMemberAction}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="id" value={member.id} />
                          <button type="submit" className="danger">
                            Remove
                          </button>
                        </form>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {isOwner ? (
        <>
          <InviteForm slug={slug} />
          <section className="card" aria-labelledby="invitations-heading">
            <h2 id="invitations-heading">Open invitations</h2>
            {invitations.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Email</th>
                    <th>Role</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {invitations.map((invitation) => (
                    <tr key={invitation.id}>
                      <td>{invitation.email}</td>
                      <td>{invitation.role}</td>
                      <td>{dateFormat.format(invitation.expiresAt)}</td>
                      <td>
                        <form action={revokeInvitationAction}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="id" value={invitation.id} />
                          <button type="submit" className="danger">
                            Revoke
                          </button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      ) : (
        <p className="muted">Only an owner can invite or remove team members.</p>
      )}
    </>
  );
}
