# Keyboard navigation contract

The browser interface keeps native labels, form controls, buttons, and the existing skip link. Hidden member-only sections use the HTML `hidden` attribute, so their controls do not enter the tab sequence.

## Starting and ending a session

From a fresh page, Tab reaches **Skip to main content**, then **Sign in as**, then **Start session**. The identity selector uses its native arrow-key behavior. After a member signs in, focus moves to **Submit a fictional claim**; after a reviewer signs in, it moves to **Claims**. The visible session description is not a live region; `#notice` is the single polite success announcement. Ending a session clears the workspace and returns focus to **Sign in as**.

## Member claim journey

After the member heading receives focus, the next controls are **Policy**, **Requested amount (USD)**, **Category**, and **Submit claim**. The amount control describes its API limit text and retains native numeric validation. A successful submission focuses the exact newly created claim row. Members see their policy, form, and claims, but no reviewer actions.

## Reviewer journey

Reviewers see the claims table and its available row actions; the policy and claim form sections are hidden. After an action updates a claim, focus returns to the next available action in that same claim row. When the claim reaches a terminal state, focus moves to that row.

## Errors and focus visibility

An asynchronous request failure focuses the persistent alert and leaves entered values intact. Its triggering form or action remains enabled and reachable with Shift+Tab for a retry. The alert replaces any success notice. Headings, claim rows, and controls show the existing amber focus indicator when keyboard navigation moves focus. The interface does not add positive `tabindex` values.

The hosted Chromium journey and its controlled keyboard/focus fault checks live in the Playwright repository's `tests/shared-app/keyboard-focus.spec.ts` and `tests/shared-app/keyboard-focus.controls.spec.ts`. Automated accessibility scans cover member, reviewer, and error states. Spoken screen-reader output was not manually reviewed as part of this change and is not claimed by those automated scans.
