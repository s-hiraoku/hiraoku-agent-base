# First Auth0 account step (not executed)

Checked against official pages on 2026-10-08. This step is limited to the owner
creating a free Auth0 administrator account in their own browser. It does not
register Hub OAuth clients, generate runtime credentials, connect ChatGPT, deploy
a server, select a paid plan, or grant another agent access.

The signup page offers an email field and separate social-sign-in choices. Prefer
the email route for this first step so a second OAuth connection is not bundled
into account creation. The owner enters their email and any account credentials
and completes the verification shown by Auth0. Do not send passwords, verification
codes or browser session information to an assistant. The later signup screens
have not been traversed; if additional mandatory fields or payment requirements
appear, inspect them before agreeing.

## Cost and terms

Official pricing lists Free at USD 0/month, no card required, one tenant, up to
25,000 monthly active users and Auth for MCP. The pricing FAQ describes a 22-day
trial followed by Free automatically. Do not depend on trial-only features or
select an upgrade. Free log retention is one day; extra MFA, role management,
log streaming and production support have plan limits. Custom domains require
card verification and are outside this account-only step.

The signup page links Self Service PSS and Privacy Policy. The PSS also incorporates
the Master Subscription Agreement and Service Specific Terms available in Okta's
legal index. It includes excess-use/upgrade fee provisions, so "free signup"
is not a promise that future unlimited usage is free. Keep usage below the free
limits and stop/review before any paid feature, upgrade or overage.

## Data sent and owner consent

The email signup submits the email address to Auth0/Okta. Account credentials and
any later required profile fields are entered directly by the owner. The privacy
policy covers administrator/account information, IP-derived location, browser and
device data, cookies and website usage. No mailbox content, calendars, memories,
Hub task data or existing agent tokens are needed for this step. The signup page
also presents a marketing-consent control; leave optional marketing unchecked.

Approval draft for the owner:

> I will create a free Auth0 administrator account myself at auth0.com/signup using
> my email, review the linked Self Service PSS and Privacy Policy, and complete
> Auth0's verification in my browser. Auth0/Okta will receive the account information
> I enter and ordinary browser/network information. I will not enter payment
> details, buy a plan or add a custom domain. I will stop after account creation;
> Hub client registration, credentials and agent connections are separate steps.

After creation, only confirmation that the account exists is needed. Do not copy
any token or password into chat or the repository. Account-creation consent is
still pending; the architecture/implementation approval did not perform it.

Official sources:

- [Signup](https://auth0.com/signup)
- [Pricing and free-plan conditions](https://auth0.com/pricing)
- [Self Service PSS](https://www.okta.com/legal/auth0-pss-self-service/)
- [Current linked PSS PDF](https://www.okta.com/content/dam/okta---digital/en_us/legal/okta-auth0-self-service-PSS.pdf)
- [Legal agreements index](https://www.okta.com/legal/)
- [Privacy Policy](https://www.okta.com/legal/privacy-policy/)
