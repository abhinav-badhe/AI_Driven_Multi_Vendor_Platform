# 11. Merchant Onboarding and Verification Lifecycle State Machine

## Status
Accepted

## Context
Merchants must undergo an explicit onboarding and compliance verification process before their store listings or inventory can become active on the marketplace platform. State transitions must be auditable, tamper-resistant, and governed by administrative privilege.

## Decision
1. **Explicit Verification States:**
   - `DRAFT`: Initial profile created during onboarding. Merchants can edit their legal, business, and contact details.
   - `SUBMITTED`: Profile locked and submitted for administrative compliance review.
   - `VERIFIED`: Merchant approved by an `ADMINISTRATOR`. Verified timestamp and administrator ID recorded.
   - `REJECTED`: Merchant application rejected by an `ADMINISTRATOR` with documented reason. Merchant may modify and resubmit (`REJECTED` -> `SUBMITTED`).
   - `SUSPENDED`: Operational hold placed on a verified merchant by an `ADMINISTRATOR`.
2. **Governed State Transitions:** Direct state manipulation is blocked. Transitions must follow the strict transition matrix:
   - `DRAFT` -> `SUBMITTED`
   - `SUBMITTED` -> `VERIFIED` | `REJECTED`
   - `VERIFIED` -> `SUSPENDED`
   - `REJECTED` -> `SUBMITTED`
   - `SUSPENDED` -> `VERIFIED`
3. **Immutability of Verified Profiles:** Merchants cannot unilaterally alter business identity once verified. Modifications require review or administrative action.
4. **Audit Trail:** Verification approvals, rejections, and suspensions generate persistent `security_audit_events` rows with actor ID, target tenant ID, and transition metadata.

## Consequences
### Positive
- Strict governance over who can participate as an active merchant on the platform.
- Clear separation between merchant self-service (`DRAFT`, `SUBMITTED`) and platform oversight (`VERIFIED`, `REJECTED`, `SUSPENDED`).
- Complete forensic and compliance auditability.

### Negative
- Requires platform administrator interaction for merchant activation.
