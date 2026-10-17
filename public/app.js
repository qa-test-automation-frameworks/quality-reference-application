const sessionForm = document.querySelector('#session-form');
const claimForm = document.querySelector('#claim-form');
const sessionStatus = document.querySelector('#session-status');
const identitySelect = document.querySelector('#identity');
const policySelect = document.querySelector('#policy');
const amountInput = document.querySelector('#amount');
const amountLimitHelp = document.querySelector('#amount-limit-help');
const policySection = document.querySelector('#policy-section');
const claimFormSection = document.querySelector('#claim-form-section');
const claimsSection = document.querySelector('#claims-section');
const claimRows = document.querySelector('#claims-body');
const notice = document.querySelector('#notice');
const errorBox = document.querySelector('#error');
const signOutButton = document.querySelector('#sign-out');
let session = null;

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  notice.textContent = '';
}

function clearMessages() {
  errorBox.textContent = '';
  errorBox.hidden = true;
  notice.textContent = '';
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (session?.token) headers.authorization = `Bearer ${session.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(payload?.error?.message || `Request failed with status ${response.status}.`);
  return payload;
}

function renderClaims(claims) {
  claimRows.replaceChildren();
  for (const claim of claims) {
    const row = document.createElement('tr');
    const values = [
      claim.id,
      claim.policyId,
      new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(claim.amountMinor / 100),
      claim.status.replace('_', ' '),
      String(claim.version),
    ];
    for (const value of values) {
      const cell = document.createElement('td');
      cell.textContent = value;
      row.append(cell);
    }
    const actionCell = document.createElement('td');
    if (session.user.role === 'reviewer' && claim.status !== 'approved' && claim.status !== 'rejected') {
      const nextStates = claim.status === 'submitted' ? ['under_review'] : ['approved', 'rejected'];
      for (const status of nextStates) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = `Set ${status.replace('_', ' ')}`;
        button.addEventListener('click', () => transition(claim, status));
        actionCell.append(button);
      }
    } else {
      actionCell.textContent = 'No action';
    }
    row.append(actionCell);
    claimRows.append(row);
  }
}

async function refreshWorkspace() {
  const policies = await api('/api/v2/policies');
  policySection.hidden = session.user.role !== 'member';
  claimFormSection.hidden = session.user.role !== 'member';
  policySelect.replaceChildren();
  const policyList = document.querySelector('#policy-list');
  policyList.replaceChildren();
  for (const policy of policies.items) {
    const option = document.createElement('option');
    option.value = policy.id;
    option.textContent = `${policy.policyNumber} · seed ${policy.seedVersion}`;
    policySelect.append(option);
    const item = document.createElement('li');
    item.textContent = `${policy.policyNumber} · fixture ${policy.seedVersion}`;
    policyList.append(item);
  }
  const claimLimitMinor = policies.items[0]?.claimAmountLimitMinor ?? 500_000;
  amountInput.max = (claimLimitMinor / 100).toFixed(2);
  amountLimitHelp.textContent = `API v2 accepts claims up to $${amountInput.max}.`;
  const claims = await api('/api/v2/claims');
  claimsSection.hidden = false;
  renderClaims(claims.items);
}

async function transition(claim, status) {
  clearMessages();
  try {
    await api(`/api/v2/claims/${encodeURIComponent(claim.id)}`, {
      method: 'PATCH', body: { status, expectedVersion: claim.version },
    });
    notice.textContent = `Claim ${claim.id} moved to ${status.replace('_', ' ')}.`;
    await refreshWorkspace();
  } catch (error) {
    showError(error.message);
  }
}

sessionForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessages();
  try {
    session = await api('/api/v1/sessions', { method: 'POST', body: { identityKey: identitySelect.value } });
    sessionStatus.textContent = `Active as ${session.user.displayName} (${session.user.role}).`;
    signOutButton.hidden = false;
    await refreshWorkspace();
    notice.textContent = 'Session started. Data is scoped to this application run.';
  } catch (error) {
    showError(error.message);
  }
});

claimForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessages();
  const form = new FormData(claimForm);
  const amount = Number(form.get('amount'));
  if (!Number.isFinite(amount) || Math.round(amount * 100) !== amount * 100) {
    showError('Enter an amount with no more than two decimal places.');
    return;
  }
  try {
    await api('/api/v2/claims', {
      method: 'POST',
      body: { policyId: form.get('policyId'), amountMinor: Math.round(amount * 100), currency: 'USD', category: form.get('category') },
    });
    claimForm.reset();
    notice.textContent = 'The claim was submitted and persisted.';
    await refreshWorkspace();
  } catch (error) {
    showError(error.message);
  }
});

signOutButton.addEventListener('click', () => {
  session = null;
  sessionStatus.textContent = 'No session is active.';
  signOutButton.hidden = true;
  policySection.hidden = true;
  claimFormSection.hidden = true;
  claimsSection.hidden = true;
  claimRows.replaceChildren();
  clearMessages();
});
