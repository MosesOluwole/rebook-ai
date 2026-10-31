import Link from 'next/link';

import { listTeamMembers } from '@/modules/booking';
import { can, listMembers, listOpenInvitations } from '@/modules/tenancy';

import { ActionForm, SelectInput, SubmitButton, TextInput } from '../../../_components/forms';
import { getTenancy } from '../../../_lib/tenancy';
import { loadWorkspace } from '../_lib/workspace';
import { createTeamMemberAction, revokeInvitationAction, revokeMemberAction } from './actions';
import { InviteForm } from './invite-form';

export const dynamic = 'force-dynamic';

const dateFormat = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' });

export default async function TeamPage({
  params,
}: {
  readonly params: Promise<{ readonly slug: string }>;
}) {
  const { slug } = await params;
  const { ctx } = await loadWorkspace(slug);
  const isOwner = ctx.role !== null && can(ctx.role, 'members.invite');
  const canManageTeam = ctx.role !== null && can(ctx.role, 'team.manage');
  const { members, invitations, teamMembers } = await getTenancy().withTenant(ctx, async (tx) => ({
    members: await listMembers(tx),
    invitations: isOwner ? await listOpenInvitations(tx) : [],
    teamMembers: await listTeamMembers(tx),
  }));
  const linked = new Set(teamMembers.map((member) => member.membershipId));
  const memberLabel = (userId: string, role: string) =>
    `${userId === ctx.actorId ? 'You' : `Member ${userId.slice(0, 8)}`} (${role})`;

  return (
    <>
      <h1>Team</h1>

      <section className="card" aria-labelledby="team-members-heading">
        <h2 id="team-members-heading">Team members</h2>
        <p className="muted">The people who deliver your services. They need not sign in.</p>
        {teamMembers.length === 0 ? (
          <p className="muted">No team members yet.</p>
        ) : (
          <ul className="plain">
            {teamMembers.map((member) => (
              <li key={member.id}>
                <Link href={`/app/${slug}/team/${member.id}`}>{member.displayName}</Link>
                {!member.active && <span className="muted"> · inactive</span>}
                {member.membershipId !== null && <span className="muted"> · signs in</span>}
              </li>
            ))}
          </ul>
        )}
        {canManageTeam && (
          <ActionForm action={createTeamMemberAction} label="Add team member">
            <input type="hidden" name="slug" value={slug} />
            <TextInput name="displayName" label="Display name" required maxLength={80} />
            <SelectInput
              name="membershipId"
              label="Signs in as (optional)"
              defaultValue=""
              options={[
                { value: '', label: 'Nobody: does not sign in' },
                ...members
                  .filter((member) => !linked.has(member.id))
                  .map((member) => ({
                    value: member.id,
                    label: memberLabel(member.userId, member.role),
                  })),
              ]}
            />
            <div>
              <SubmitButton>Add team member</SubmitButton>
            </div>
          </ActionForm>
        )}
      </section>

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
                        <ActionForm action={revokeMemberAction} className="inline-form">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="id" value={member.id} />
                          <SubmitButton className="danger">Remove</SubmitButton>
                        </ActionForm>
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
                        <ActionForm action={revokeInvitationAction} className="inline-form">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="id" value={invitation.id} />
                          <SubmitButton className="danger">Revoke</SubmitButton>
                        </ActionForm>
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
