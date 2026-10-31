'use client';

import {
  ActionForm,
  SelectInput,
  SubmitButton,
  TextInput,
  useFormResult,
} from '../../../_components/forms';
import { createInviteAction } from './actions';

/** The invite link, returned once to the owner's browser as form state (the token is not stored). */
function InviteLink() {
  const state = useFormResult();
  if (state.status !== 'ok' || state.data?.link === undefined) {
    return null;
  }
  return (
    <div className="notice">
      <p>
        Invite link for <strong>{state.data.email}</strong>:
      </p>
      <output className="link-box" data-testid="invite-link">
        {state.data.link}
      </output>
    </div>
  );
}

export function InviteForm({ slug }: { readonly slug: string }) {
  return (
    <section className="card" aria-labelledby="invite-heading">
      <h2 id="invite-heading">Invite a team member</h2>
      <p className="muted">
        No email is sent yet: copy the link and send it yourself. It expires in 7 days and can be
        used once, by someone signed in with this email address.
      </p>
      <ActionForm action={createInviteAction} label="Invite">
        <input type="hidden" name="slug" value={slug} />
        <TextInput type="email" name="email" label="Email" required autoComplete="off" />
        <SelectInput
          name="role"
          label="Role"
          defaultValue="staff"
          options={[
            { value: 'staff', label: 'Staff' },
            { value: 'owner', label: 'Owner' },
          ]}
        />
        <div>
          <SubmitButton>Create invite link</SubmitButton>
        </div>
        <InviteLink />
      </ActionForm>
    </section>
  );
}
