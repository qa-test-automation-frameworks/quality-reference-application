import { amountToMinorUnits } from './amount.js';

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
  errorBox.focus();
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

function renderClaims(claims, focusTarget) {
  claimRows.replaceChildren();
  for (const claim of claims) {
    const row = document.createElement('tr');
    row.dataset.claimId = claim.id;
    row.tabIndex = -1;
    const formattedAmount = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
      .format(claim.amountMinor / 100);
    row.setAttribute(
      'aria-label',
      `Claim ${claim.id}, ${formattedAmount}, ${claim.status.replace('_', ' ')}, version ${claim.version}`,
    );
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
        button.dataset.claimAction = '';
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
  if (focusTarget) {
    const row = [...claimRows.querySelectorAll('tr')].find(
      (item) => item.dataset.claimId === focusTarget.claimId,
    );
    if (row) {
      const nextAction = focusTarget.mode === 'next-action'
        ? row.querySelector('button[data-claim-action]')
        : null;
      (nextAction || row).focus();
    }
  }
}

async function refreshWorkspace({ focusTarget } = {}) {
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
  renderClaims(claims.items, focusTarget);
}

async function transition(claim, status) {
  clearMessages();
  try {
    await api(`/api/v2/claims/${encodeURIComponent(claim.id)}`, {
      method: 'PATCH', body: { status, expectedVersion: claim.version },
    });
    await refreshWorkspace({ focusTarget: { claimId: claim.id, mode: 'next-action' } });
    notice.textContent = `Claim ${claim.id} moved to ${status.replace('_', ' ')}.`;
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
    const destinationHeading = document.querySelector(
      session.user.role === 'member' ? '#claim-form-heading' : '#claims-heading',
    );
    destinationHeading.focus();
    notice.textContent = 'Session started. Data is scoped to this application run.';
  } catch (error) {
    showError(error.message);
  }
});

claimForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearMessages();
  const form = new FormData(claimForm);
  const amountMinor = amountToMinorUnits(String(form.get('amount') ?? ''));
  if (amountMinor === null) {
    showError('Enter an amount with no more than two decimal places.');
    return;
  }
  try {
    const created = await api('/api/v2/claims', {
      method: 'POST',
      body: { policyId: form.get('policyId'), amountMinor, currency: 'USD', category: form.get('category') },
    });
    claimForm.reset();
    await refreshWorkspace({ focusTarget: { claimId: created.claim.id, mode: 'row' } });
    notice.textContent = 'The claim was submitted and persisted.';
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
  identitySelect.focus();
});
