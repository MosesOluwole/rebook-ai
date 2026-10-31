'use client';

import { useActionState } from 'react';

import { createInviteAction, type InviteFormState } from './actions';

const initial: InviteFormState = { status: 'idle' };

/**
 * The one client component of Phase 2: the invite link must reach the owner's browser without a
 * redirect (a redirect would put the secret in a URL and in server logs), so the action's result
 * is rendered in place with useActionState.
 */
export function InviteForm({ slug }: { readonly slug: string }) {
  const [state, formAction, pending] = useActionState(createInviteAction, initial);

  return (
    <section className="card" aria-labelledby="invite-heading">
      <h2 id="invite-heading">Invite a team member</h2>
      <p className="muted">
        No email is sent yet: copy the link and send it yourself. It expires in 7 days and can be
        used once, by someone signed in with this email address.
      </p>
      <form className="stack" action={formAction}>
        <input type="hidden" name="slug" value={slug} />
        <label>
          Email
          <input type="email" name="email" required autoComplete="off" />
        </label>
        <label>
          Role
          <select name="role" defaultValue="staff">
            <option value="staff">Staff</option>
            <option value="owner">Owner</option>
          </select>
        </label>
        <button type="submit" disabled={pending}>
          {pending ? 'Creating…' : 'Create invite link'}
        </button>
      </form>
      {state.status === 'error' && (
        <p className="notice error" role="alert">
          {state.message}
        </p>
      )}
      {state.status === 'ok' && state.link !== undefined && (
        <div className="notice" role="status">
          <p>
            Invite link for <strong>{state.email}</strong>:
          </p>
          <output className="link-box" data-testid="invite-link">
            {state.link}
          </output>
        </div>
      )}
    </section>
  );
}
